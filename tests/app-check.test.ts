// The app check: grading from a log, each requirement failing with its source, notes for what the spec doesn't
// promise, and the staged mode, which a run turns on in a person's sandbox and puts back exactly as it was.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { CONDITIONS, grade, scriptById, SOURCES, type Evidence } from "../src/app-check";
import { APP_WINDOW_MS, createCheckRuns } from "../src/check-runs";
import { addClient } from "../src/clients";
import { createDemoServer } from "../src/demo-server";
import { registerClients } from "../src/flows";
import { CONFIG } from "../src/config";
import { settingsStatus } from "../src/settings-api";
import { startStack, type Stack } from "../src/stack";
import { traceSettled, type EventRecord } from "../src/trace";
import type { Sandbox } from "../src/sandbox";
import { fetchApp } from "./app-check-client";
import { adminHeaders } from "./admin-token";

setDefaultTimeout(60000);

// A log, as the sandbox records an app's run: its token, a delayed first search, two pages, and three retrievals.
let seq = 0;
const ev = (kind: string, data: Record<string, unknown>, at = seq * 1000): EventRecord => ({ seq: ++seq, at, kind, data, session: "s", trace: "t", service: "demo", outcome: "ok", links: [] });
const QUERY = "patient=josh-example&_include=ImagingStudy%3Aendpoint";
function compliant() {
  seq = 0;
  const token = ev("token.issued", { client: "app-1", grant: "authorization_code", user: "josh", patient: "josh-example", tokenHash: "T1", scope: "launch/patient patient/*.rs" });
  const ctx = (study: string, uid: string, hash: string) => ev("context.signed", { study, studyUid: uid, tokenHash: "T1", contextHash: hash });
  const contexts = [ctx("s1", "1.1", "C1"), ctx("s2", "1.2", "C2"), ctx("s3", "1.3", "C3")];
  const search = (status: number, more: Record<string, unknown>, at?: number) => ev("search.returned", { status, client: "app-1", user: "josh", patient: "josh-example", tokenHash: "T1", query: QUERY, ...more }, at);
  const image = (uid: string, ctxHash: string, more: Record<string, unknown> = {}) => ev("stream.done", { studyUid: uid, resource: "instance", status: 200, complete: true, parts: 1, tokenHash: "T1", contextHash: ctxHash, ...more });
  const events = [
    token,
    search(503, { reason: "staged: this token's first search answers 503 with Retry-After: 2" }, 1000),
    search(200, { found: ["s1", "s2"], total: 3, withheld: [], endpointForms: { s1: "response-local", s2: "contained" } }, 4000),
    search(200, { found: ["s3"], total: 3, withheld: [], endpointForms: { s3: "separate" } }, 5000),
    ev("retrieval.answered", { studyUid: "1.1", resource: "instance", status: 503, tokenHash: "T1", contextHash: "C1", note: "staged: each study's first retrieval answers 503 with Retry-After: 2" }, 10000),
    image("1.1", "C1", {}), image("1.2", "C2"), image("1.3", "C3"),
  ];
  events[5]!.at = 13000;
  return { tokens: [token], contexts, events } satisfies Evidence;
}
const ALL = CONDITIONS.map(c => c.id);
const graded = (evidence: Evidence, script = "josh") => grade({ client: "app-1", script: scriptById(script)!, conditions: ALL, evidence, imaging: "https://x/imaging/fhir", proxy: "https://x", log: (t, s) => `https://x/activity?link=token:${t}&event=${s}` });
const req = (g: ReturnType<typeof graded>, title: string) => g.steps.find(s => s.title.startsWith(title))!;

describe("grading an app from the log", () => {
  test("a compliant log passes every script step and every requirement, with no notes", () => {
    const g = graded(compliant());
    expect(g.steps.map(s => [s.group, s.state])).toEqual([...Array(5).fill(["script", "pass"]), ...Array(4).fill(["requirement", "pass"])]);
    expect(g.notes).toEqual([]);
    expect(g.summary).toBe("All 4 requirements checked were met. The app did what the script asked.");
    for (const s of g.steps.filter(s => s.group === "requirement")) expect(s.sources!.length).toBeGreaterThan(0);
  });

  test("a retrieval with no token, or another token, fails the same-token requirement, citing it", () => {
    const e = compliant();
    e.events.push(ev("retrieval.answered", { studyUid: "1.1", resource: "instance", status: 401, authz: "no token", contextHash: "C1" }));
    const g = graded(e), r = req(g, "Each retrieval sends the token");
    expect(r.state).toBe("fail");
    expect(r.sources).toEqual([SOURCES.sameToken]);
    expect(r.requests[0]!.request).toContain("no token");
    expect(r.requests[0]!.log).toContain("link=token:T1");
    const other = compliant();
    other.tokens.push(ev("token.issued", { client: "app-1", grant: "refresh_token", user: "josh", patient: "josh-example", tokenHash: "T2" }));
    other.events.push(ev("stream.done", { studyUid: "1.1", resource: "instance", status: 200, complete: true, tokenHash: "T2", contextHash: "C1" }));
    expect(req(graded(other), "Each retrieval sends the token").result).toContain("a token other than the one its address was issued to");
  });

  test("an address the app built, or another study's, fails the Endpoint.address requirement", () => {
    const e = compliant();
    e.events.push(ev("stream.done", { studyUid: "1.1", resource: "instance", status: 200, complete: true, tokenHash: "T1" }));
    const r = req(graded(e), "Each retrieval uses its study's Endpoint.address");
    expect([r.state, r.sources]).toEqual(["fail", [SOURCES.opaque, SOURCES.designated]]);
    expect(r.result).toContain("built by the app itself");
    const swapped = compliant();
    swapped.events.push(ev("stream.done", { studyUid: "1.2", resource: "instance", status: 200, complete: true, tokenHash: "T1", contextHash: "C1" }));
    expect(req(graded(swapped), "Each retrieval uses its study's Endpoint.address").result).toContain("another study's address");
  });

  test("never using a contained Endpoint fails the Endpoint forms requirement, and the script", () => {
    const e = compliant();
    e.events = e.events.filter(x => x.data.studyUid !== "1.2");
    const g = graded(e), r = req(g, "Endpoints in every form");
    expect([r.state, r.sources]).toEqual(["fail", [SOURCES.forms]]);
    expect(r.result).toContain("never through a contained one (s2)");
    expect(req(g, "Opened every study").state).toBe("fail");
  });

  test("a retrieval with no Accept header fails, citing DICOMweb", () => {
    const e = compliant();
    e.events.push(ev("retrieval.answered", { studyUid: "1.1", resource: "instance", status: 406, tokenHash: "T1", contextHash: "C1", noAccept: true }));
    const r = req(graded(e), "Each retrieval sends an Accept header");
    expect([r.state, r.sources]).toEqual(["fail", [SOURCES.accept]]);
  });

  test("stopping after one page fails the script, not a requirement, and says why in a note", () => {
    const e = compliant();
    e.events = e.events.filter(x => !(x.kind === "search.returned" && (x.data.found as string[] | undefined)?.includes("s3")) && x.data.studyUid !== "1.3");
    const g = graded(e);
    expect(req(g, "Found every study").state).toBe("fail");
    expect(req(g, "Found every study").result).toBe("Found 2 of the 3 studies the server released. A new sandbox releases 6, so this sandbox's policy has been changed.");
    expect(req(g, "Opened every study").state).toBe("unreached");
    expect(g.steps.filter(s => s.group === "requirement").every(s => s.state !== "fail")).toBe(true);
    expect(g.notes.map(n => n.title)).toEqual(["Relied on one page of results"]);
    expect(g.notes[0]!.sources).toEqual([SOURCES.paging, SOURCES.count]);
    expect(g.summary).toContain("The app stopped short of the script: found 2 of the 3 studies");
  });

  test("notes for what the spec doesn't promise: giving up on a 503, /rendered, no _include, another patient", () => {
    const e = compliant();
    e.events = e.events.filter(x => !(x.kind === "stream.done" && x.data.studyUid === "1.1"));
    e.events.push(ev("retrieval.answered", { studyUid: "1.2", resource: "rendered", status: 501, tokenHash: "T1", contextHash: "C2" }));
    e.events.push(ev("search.returned", { status: 200, client: "app-1", patient: "josh-example", tokenHash: "T1", query: "patient=josh-example", found: [], total: 3 }));
    e.events.push(ev("search.returned", { status: 403, client: "app-1", patient: "sam-example", tokenHash: "T1", query: "patient=sam-example", reason: "patient does not match the token's patient context" }));
    const g = graded(e);
    expect(g.notes.map(n => n.title)).toEqual(["Gave up on a retrieval answered 503 with Retry-After", "Asked for /rendered", "Searched without _include=ImagingStudy:endpoint", "Searched for a patient the token isn't for"]);
    // None of them is graded as a failure on its own.
    expect(g.steps.filter(s => s.group === "requirement").map(s => s.state)).toEqual(["pass", "pass", "pass", "pass"]);
  });

  test("a repeat before Retry-After is the identical request: the study's other requests meanwhile aren't one, and the note quotes both", () => {
    const INSTANCE = "/studies/1.1/series/9/instances/8";
    const timed = (repeatAt: number) => {
      const e = compliant();
      const i503 = e.events.findIndex(x => x.kind === "retrieval.answered" && x.data.status === 503);
      e.events[i503]!.data.target = INSTANCE;
      // Its metadata a second after the 503, then the instance again: at `repeatAt`.
      e.events.splice(i503 + 1, 1, ev("stream.done", { studyUid: "1.1", resource: "metadata", target: "/studies/1.1/metadata", status: 200, complete: true, parts: 1, tokenHash: "T1", contextHash: "C1" }, 11000),
        ev("stream.done", { studyUid: "1.1", resource: "instance", target: INSTANCE, status: 200, complete: true, parts: 1, tokenHash: "T1", contextHash: "C1" }, repeatAt));
      return graded(e).notes.find(n => n.title === "Repeated a retrieval before Retry-After had passed");
    };
    expect(timed(12100)).toBeUndefined();
    const early = timed(10600)!;
    expect(early.detail).toContain("0.6 s after a 503 that asked for 2 s");
    expect(early.requests.map(r => r.request.includes(INSTANCE))).toEqual([true, true]);
    expect(early.requests.map(r => r.response.split(":")[0])).toEqual(["503", "200"]);
  });
  test("a correct small answer passes: Riley's 1 of 2, and Robin's none", () => {
    seq = 0;
    const token = ev("token.issued", { client: "app-1", grant: "authorization_code", user: "sam-caregiver", patient: "riley-example", tokenHash: "T1" });
    const riley: Evidence = { tokens: [token], contexts: [ev("context.signed", { study: "knee", studyUid: "2.1", tokenHash: "T1", contextHash: "C1" })], events: [
      token, ev("search.returned", { status: 200, client: "app-1", patient: "riley-example", tokenHash: "T1", query: QUERY, found: ["knee"], total: 1, withheld: [], unreached: [{ study: "slide" }], endpointForms: { knee: "response-local" } }),
      ev("stream.done", { studyUid: "2.1", resource: "instance", status: 200, complete: true, tokenHash: "T1", contextHash: "C1" }),
    ] };
    const g = graded(riley, "riley");
    expect(g.steps.every(s => s.state === "pass")).toBe(true);
    expect(req(g, "Found the 1 study").result).toBe("All 1 study, of the patient's 2.");
    seq = 0;
    const t2 = ev("token.issued", { client: "app-1", grant: "authorization_code", user: "robin", patient: "robin-example", tokenHash: "T1" });
    const robin = graded({ tokens: [t2], contexts: [], events: [t2, ev("search.returned", { status: 200, client: "app-1", patient: "robin-example", tokenHash: "T1", query: QUERY, found: [], total: 0, withheld: [] })] }, "robin");
    expect(robin.steps.filter(s => s.group === "script").every(s => s.state === "pass")).toBe(true);
    expect(robin.steps.filter(s => s.group === "requirement").every(s => s.state === "note")).toBe(true);
    expect(robin.summary).toBe("No requirement could be checked: the app made no requests that they cover. The app did what the script asked.");
  });

  test("another client's requests don't count", () => {
    const e = compliant();
    e.events = e.events.map(x => ({ ...x, data: { ...x.data, ...(x.data.client ? { client: "someone-else" } : {}) } }));
    e.tokens = e.tokens.map(x => ({ ...x, data: { ...x.data, client: "someone-else" } }));
    const g = graded(e);
    expect(g.steps[0]!.state).toBe("fail");
    expect(g.steps[0]!.result).toBe("No token was issued to app-1 during the run");
  });
});

describe("app check runs in a sandbox", () => {
  let stack: Stack, demo: ReturnType<typeof createDemoServer>;
  beforeAll(async () => { const root = join(import.meta.dir, ".."); stack = await startStack(root); demo = createDemoServer(stack, registerClients(stack), root); });
  afterAll(() => stack.stop());
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await demo.fetch(new Request(`${CONFIG.demoUrl}${path}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) }));
    return { status: r.status, body: await r.json().catch(() => undefined) as any };
  };
  const appIn = (w: Sandbox) => { const c = addClient(w.store, { name: "My app", redirectUris: [w.urls.callback] }); if ("error" in c) throw new Error(c.error); return c; };
  // What a sandbox is, as its status and faults show it, without the clock, which moves.
  const state = (w: Sandbox) => { const { clock: _c, ...rest } = settingsStatus(stack, w) as any; return JSON.stringify(rest); };

  test("an app is named by its sandbox and client ID, and a run's link opens in that sandbox", async () => {
    const w = stack.sandboxes.mint(), c = appIn(w);
    const bad = async (app: unknown) => (await call("POST", "/api/checks", { app })).body.error as string;
    expect(await bad({ sandbox: "/s/nope", clientId: c.id })).toContain("app.sandbox is a sandbox's base");
    expect(await bad({ sandbox: w.prefix, clientId: "not-an-app" })).toContain("app.clientId");
    expect(await bad({ sandbox: w.prefix, clientId: c.id, script: "service" })).toContain("for a backend service");
    expect(await bad({ sandbox: w.prefix, clientId: c.id, conditions: ["fast"] })).toContain("app.conditions");
    const made = await call("POST", "/api/checks", { app: { sandbox: `${CONFIG.demoUrl}${w.prefix}/fhir`, clientId: c.id } });
    expect(made.status).toBe(201);
    expect(made.body.url).toBe(`${new URL(CONFIG.demoUrl).origin}${w.prefix}/app-check?run=${made.body.id}`);
    const read = await call("GET", `/api/checks/${made.body.id}`);
    expect(read.body).toMatchObject({ status: "waiting", app: { sandbox: w.prefix, clientId: c.id, script: "josh", conditions: CONDITIONS.map(x => x.id), name: "My app", type: "public" }, steps: [], notes: [] });
    expect(read.body.script.steps[0]).toBe("Sign in as josh, and approve everything offered.");
  });

  test("starting stages the conditions, one run at a time, and ending puts the sandbox back exactly", async () => {
    const w = stack.sandboxes.mint(), c = appIn(w);
    w.setFaults({ pageSize: 5, truncateAfter: 9 });
    const before = state(w);
    const run = (await call("POST", "/api/checks", { app: { sandbox: w.prefix, clientId: c.id } })).body.id;
    const started = await call("POST", `/api/checks/${run}/start`);
    expect(started.status).toBe(200);
    expect(w.faults()).toEqual({ decisionOutage: false, truncateAfter: 9, pageSize: 2, searchRetryAfter: 1, retrievalRetryAfter: 1, endpointForms: true });
    expect(w.appCheck).toMatchObject({ run, client: c.id, script: "josh" });
    expect((settingsStatus(stack, w) as any).appCheck.staged).toEqual(CONDITIONS.map(x => x.text));
    // While it's on, faults stay as staged, and a second run waits its turn.
    const faults = await demo.fetch(new Request(`${CONFIG.demoUrl}${w.prefix}/api/sandbox/faults`, { method: "POST", headers: { "content-type": "application/json", ...await adminHeaders(demo, w.prefix) }, body: JSON.stringify({ pageSize: null }) }));
    expect(faults.status).toBe(409);
    const second = (await call("POST", "/api/checks", { app: { sandbox: w.prefix, clientId: c.id } })).body.id;
    expect((await call("POST", `/api/checks/${second}/start`)).status).toBe(409);
    const ended = await call("POST", `/api/checks/${run}/end`);
    expect(ended.body.status).toBe("done");
    expect(ended.body.ended).toBe("graded");
    expect(state(w)).toBe(before);
    expect(w.appCheck).toBeUndefined();
    // Abandoning grades nothing, and puts it back too.
    expect((await call("POST", `/api/checks/${second}/start`)).status).toBe(200);
    const abandoned = await call("POST", `/api/checks/${second}/abandon`);
    expect([abandoned.body.ended, abandoned.body.steps]).toEqual(["abandoned", []]);
    expect(state(w)).toBe(before);
    expect((await call("POST", `/api/checks/${second}/end`)).status).toBe(409);
  });

  test("a run past its window ends, is graded, and puts the sandbox back", async () => {
    let t = Date.now();
    const runs = createCheckRuns({ now: () => t, site: { sandbox: id => stack.sandboxes.has(id) ? (stack.sandboxes.resolve(id) as any).sandbox : undefined, mark: async () => { await traceSettled(); return 0; }, events: () => [] } });
    const w = stack.sandboxes.mint(), c = appIn(w), before = state(w);
    const at = async (method: string, path: string, body?: unknown) => (await runs.fetch(new Request(`${CONFIG.demoUrl}${path}`, { method, ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) }), new URL(`${CONFIG.demoUrl}${path}`), "https://site.example")).json() as Promise<any>;
    const { id } = await at("POST", "/api/checks", { app: { sandbox: w.prefix, clientId: c.id, conditions: ["small-pages"] } });
    await at("POST", `/api/checks/${id}/start`);
    expect(w.faults().pageSize).toBe(2);
    expect(w.faults().searchRetryAfter).toBeNull();
    t += APP_WINDOW_MS + 1;
    const read = await at("GET", `/api/checks/${id}`);
    expect([read.status, read.ended]).toEqual(["done", "expired"]);
    expect(read.summary).toStartWith("Ended when its 2 hours were up.");
    expect(state(w)).toBe(before);
  });

  test("a compliant app, driven by fetch, meets every requirement under every staged condition", async () => {
    const w = stack.sandboxes.mint(), c = appIn(w);
    const run = (await call("POST", "/api/checks", { app: { sandbox: w.prefix, clientId: c.id } })).body.id;
    await call("POST", `/api/checks/${run}/start`);
    const app = await fetchApp(w.urls, c.id, "josh", undefined);
    expect([app.studies, app.retrieved]).toEqual([6, 6]);
    const live = await call("GET", `/api/checks/${run}`);
    // Six studies, and the one staged 503, retried: every retrieval the run staged was answered and repeated.
    expect(live.body.progress.retrievals).toBe(7);
    const done = (await call("POST", `/api/checks/${run}/end`)).body;
    expect(done.steps.map((s: any) => `${s.title}: ${s.state}`)).toEqual([
      "Signed in as josh for josh-example: pass", "Approved everything offered: pass", "Searched for josh-example's studies: pass", "Found every study the server released: pass", "Opened every study it found: pass",
      "Each retrieval sends the token of the search that gave its address: pass", "Each retrieval uses its study's Endpoint.address as given: pass", "Endpoints in every form are resolved: pass", "Each retrieval sends an Accept header: pass",
    ]);
    expect(done.notes).toEqual([]);
  });

  test("an app that ignores next and builds its own addresses is graded so", async () => {
    const w = stack.sandboxes.mint(), c = appIn(w);
    const run = (await call("POST", "/api/checks", { app: { sandbox: w.prefix, clientId: c.id } })).body.id;
    await call("POST", `/api/checks/${run}/start`);
    await fetchApp(w.urls, c.id, "josh", undefined, { followNext: false, buildUrl: true });
    const done = (await call("POST", `/api/checks/${run}/end`)).body;
    const by = (t: string) => done.steps.find((s: any) => s.title.startsWith(t));
    expect(by("Found every study").result).toBe("Found 2 of the 6 studies the server released.");
    expect(by("Each retrieval uses its study's Endpoint.address").state).toBe("fail");
    expect(done.notes.map((n: any) => n.title)).toContain("Relied on one page of results");
  });
});

