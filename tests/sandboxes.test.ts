// Policy sandboxes: `/s/{sandbox}/` in front of any path is a sandbox of its own. Nothing one sandbox issues
// works in another, and every URL a sandbox issues stays in it. These run in either layout: the one
// origin, or DEMO_ONE_ORIGIN=0 with each service on its own port.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { createCatalog } from "@smart-imaging-proxy/core";
import { startStack, type Stack } from "../src/stack";
import { defaultsFor, FLOWS, registerClients, runStep, startFlow } from "../src/flows";
import { createDemoServer } from "../src/demo-server";
import { buildAuthorization, scriptedLaunch, submitConsent, tokenRequestBody } from "../src/flows/oauth";
import { CONFIG, localUrl, ONE_ORIGIN, PORTS, urlsFor } from "../src/config";
import { createSandboxes, splitSandbox } from "../src/sandboxes";
import { traceSettled } from "../src/trace";
import { TraceStore } from "../src/trace-store";
import { resetClock } from "../src/clock";
import type { Sandbox } from "../src/sandbox";
import { adminFor } from "./admin-token";

const root = join(import.meta.dir, "..");
const ACCEPT = "multipart/related; type=application/dicom; transfer-syntax=*";
/** A relationship as a fact, without the ids and times its sandbox gave it. */
const fact = ({ id: _, recordedAt: __, ...r }: any) => r;
const RULE = { id: "r1", type: "service-access" as const, service: "service:c", patients: "any" as const, allow: { all: true } };
const services = (store: { policiesOf(type: "service-access"): unknown[] }) => store.policiesOf("service-access");
let stack: Stack; let demo: Bun.Server;
beforeAll(async () => {
  stack = await startStack(root);
  demo = Bun.serve({ port: PORTS.demo, hostname: "127.0.0.1", ...createDemoServer(stack, registerClients(stack), root) });
});
afterAll(() => { demo.stop(true); stack.stop(); });
beforeEach(async () => { await stack.resetAll(); resetClock(); stack.setBackend("static-files"); });

const get = (url: string, init: RequestInit = {}) => fetch(localUrl(url), { redirect: "manual", ...init });
/** A management call, with the admin token of the sandbox it's in. */
const managed = async (url: string, init: RequestInit = {}) => get(url, { ...init, headers: { ...(init.headers as Record<string, string>), ...(await adminFor({ fetch: r => fetch(localUrl(r.url)) }, url)) } });
const searchIn = async (w: { urls: Sandbox["urls"] }, token: string) => get(`${w.urls.imaging}/fhir/ImagingStudy?patient=josh-example&_include=ImagingStudy:endpoint&_count=2`, { headers: { Authorization: `Bearer ${token}` } });
const rootSandbox = () => stack.root;

describe("isolation", () => {
  test("a token from one sandbox works in no other sandbox, and not at the root", async () => {
    const a = stack.sandboxes.mint(), b = stack.sandboxes.mint();
    const t = await scriptedLaunch("josh", "portal-app", { at: a.urls });
    expect((await searchIn(a, t.access_token)).status).toBe(200);
    expect((await searchIn(b, t.access_token)).status).toBe(401);
    expect((await searchIn(rootSandbox(), t.access_token)).status).toBe(401);
    // And the root's works only at the root.
    const r = await scriptedLaunch("josh");
    expect((await searchIn(rootSandbox(), r.access_token)).status).toBe(200);
    expect((await searchIn(a, r.access_token)).status).toBe(401);
  });
  test("an authorization code from one sandbox can't be redeemed in another", async () => {
    const a = stack.sandboxes.mint(), b = stack.sandboxes.mint();
    const conf: any = await (await get(`${a.urls.clinicalFhir}/.well-known/smart-configuration`)).json();
    const auth = buildAuthorization(conf.authorization_endpoint, "portal-app", undefined, undefined, "josh", undefined, a.urls);
    const back = await submitConsent(auth.url, { user: "josh" });
    const code = back.searchParams.get("code")!;
    expect(code).toBeTruthy();
    for (const w of [b, rootSandbox()]) {
      const r = await get(w.auth.tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: tokenRequestBody(auth, code) });
      expect(r.status).toBe(400);
      expect(((await r.json()) as any).error).toBe("invalid_grant");
    }
    const ok = await get(a.auth.tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: tokenRequestBody(auth, code) });
    expect(ok.status).toBe(200);
  });
  test("a signed URL from one sandbox is instant there, and nothing elsewhere, even moved to another sandbox's prefix", async () => {
    const a = stack.sandboxes.mint(), b = stack.sandboxes.mint();
    const t = await scriptedLaunch("josh", "portal-app", { at: a.urls });
    const bundle: any = await (await searchIn(a, t.access_token)).json();
    const study = bundle.entry.find((e: any) => e.resource.resourceType === "ImagingStudy").resource;
    const address: string = bundle.entry.find((e: any) => e.fullUrl === study.endpoint[0].reference).resource.address;
    const uid = study.identifier[0].value.replace("urn:oid:", "");
    expect(address.startsWith(`${a.urls.proxy}/wado/`)).toBe(true);
    const retrieve = (url: string) => get(`${url}/studies/${uid}`, { headers: { Authorization: `Bearer ${t.access_token}`, Accept: ACCEPT } });
    const ok = await retrieve(address);
    expect(ok.status).toBe(200);
    await ok.body?.cancel();
    expect(a.proxy.events.at(-1)!.authz).toBe("instant");
    const ctx = address.split("/wado/")[1];
    for (const w of [b, rootSandbox()]) {
      const r = await retrieve(`${w.urls.proxy}/wado/${ctx}`);
      expect(r.status).toBe(401);
      await r.body?.cancel();
      expect(w.proxy.events.at(-1)!.authz).toBe("asked");
    }
  });
  test("a policy change in one sandbox is invisible in another and at the root, and the root's in every sandbox", async () => {
    const a = stack.sandboxes.mint(), b = stack.sandboxes.mint();
    await a.policy.replacePolicies("service-access", [RULE]);
    await a.policy.setSettings({ maxSeriesInContext: 3 });
    expect(services(a.store)).toEqual([RULE]);
    expect(services(b.store)).toEqual([]);
    expect(services(stack.store)).toEqual([]);
    await stack.policy.replacePolicies("service-access", [{ ...RULE, id: "root-rule" }]);
    expect(services(a.store)).toEqual([RULE]);
    expect(services(b.store)).toEqual([]);
    expect(services(stack.sandboxes.mint().store)).toEqual([]);
    expect(b.store.getSettings().maxSeriesInContext).toBe(12);
    // Sharing on one sandbox's account page reaches only that sandbox's policy.
    const t = await scriptedLaunch("josh", "portal-app", { at: a.urls, sites: ["Lakeside Imaging"] });
    expect(t.access_token).toBeTruthy();
    const joshs = (w: { store: { approvals(): any[] } }) => w.store.approvals().find(x => x.by === "user:josh")?.sites;
    expect(joshs(a)).toEqual(["Lakeside Imaging"]);
    expect([joshs(b), joshs(stack)]).toEqual([undefined, undefined]);
  });
  test("each sandbox signs with a key of its own, and serves only its own JWKS", async () => {
    const a = stack.sandboxes.mint(), b = stack.sandboxes.mint();
    const jwks = async (w: Sandbox) => ((await (await get(`${w.urls.imaging}/.well-known/jwks.json`)).json()) as any).keys.map((k: any) => k.kid);
    expect(await jwks(a)).toEqual([a.imaging.signingKid]);
    expect(await jwks(b)).toEqual([b.imaging.signingKid]);
    expect(await jwks(rootSandbox())).toEqual([stack.imaging.signingKid]);
    expect(new Set([a.imaging.signingKid, b.imaging.signingKid, stack.imaging.signingKid]).size).toBe(3);
  });
  test("a sandbox can't hold another, and the internal APIs stay off the one origin in a sandbox too", async () => {
    const a = stack.sandboxes.mint(), b = stack.sandboxes.mint();
    expect((await get(`${a.urls.auth}/s/${b.id}/fhir/.well-known/smart-configuration`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${PORTS.auth}/s/${a.id}/s/${b.id}/fhir/.well-known/smart-configuration`)).status).toBe(404);
    if (ONE_ORIGIN) {
      expect((await get(`${a.urls.imaging}/policy/v2/document`, { headers: { Authorization: "Bearer x" } })).status).toBe(404);
      expect((await get(`${a.urls.proxy}/internal/keys/refresh`, { method: "POST" })).status).toBe(404);
    }
    // On its loopback port, a sandbox's policy API takes only that sandbox's credential.
    expect((await fetch(`http://127.0.0.1:${PORTS.imaging}/s/${a.id}/policy/v2/document`, { headers: { Authorization: "Bearer x" } })).status).toBe(401);
    expect((await a.policy.policies("service-access"))).toEqual([]);
  });
});

describe("the backend", () => {
  test("a sandbox picks its own, the root's stays as it was, and a new sandbox starts on the root's", async () => {
    const w = stack.sandboxes.mint();
    const pick = (base: string, backend: string) => managed(`${base}/api/sandbox`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ storage: backend }) });
    expect((await pick(w.urls.demo, "orthanc")).status).toBe(200);
    expect([w.backend, w.catalogSource]).toEqual(["orthanc", "orthanc"]);
    expect([stack.backend, stack.catalogSource, stack.root.backend]).toEqual(["static-files", "archive", "static-files"]);
    expect(((await (await managed(`${w.urls.demo}/api/sandbox/storage`)).json()) as any).current).toBe("orthanc");
    expect(((await (await managed(`${CONFIG.demoUrl}/api/sandbox/storage`)).json()) as any).current).toBe("static-files");
    expect(((await (await managed(`${w.urls.demo}/api/sandbox`)).json()) as any).storage.current).toBe("orthanc");
    stack.setBackend("s3");
    expect(stack.sandboxes.mint().backend).toBe("s3");
    expect(w.backend).toBe("orthanc");
  });
});

describe("a sandbox's rest of path", () => {
  test("is never read as another origin, so the write guard and the internal-path block still hold", async () => {
    const a = stack.sandboxes.mint();
    const evil = { method: "POST", headers: { origin: "http://evil.example", "content-type": "application/json" }, body: "{}" };
    expect((await get(`${CONFIG.demoUrl}/api/sandboxes`, evil)).status).toBe(403);
    const before = stack.sandboxes.size;
    const sneaky = await get(`${urlsFor(`/s/${a.id}`).demo}//evil.example/api/sandboxes`, evil);
    expect([403, 404]).toContain(sneaky.status);
    expect(stack.sandboxes.size).toBe(before);
    for (const path of ["//h/policy/v2/document", "//127.0.0.1/policy/v2/document"]) {
      expect([path, (await get(`${a.urls.imaging}${path}`, { headers: { Authorization: "Bearer x" } })).status]).toEqual([path, 404]);
      expect([path, (await get(`${CONFIG.imagingUrl}${path}`, { headers: { Authorization: "Bearer x" } })).status]).toEqual([path, 404]);
    }
    // On a service's own port, too.
    expect((await fetch(`http://127.0.0.1:${PORTS.imaging}/s/${a.id}//h/policy/v2/document`, { headers: { Authorization: "Bearer x" } })).status).toBe(404);
  });
});

describe("every URL a sandbox issues carries its prefix", () => {
  test("discovery, the authorize redirects, a search Bundle and its Endpoint.address, and a next link", async () => {
    const w = stack.sandboxes.mint();
    const prefix = `/s/${w.id}`;
    const conf: any = await (await get(`${w.urls.clinicalFhir}/.well-known/smart-configuration`)).json();
    for (const k of ["issuer", "authorization_endpoint", "token_endpoint", "revocation_endpoint"]) expect([k, new URL(conf[k]).pathname.startsWith(prefix)]).toEqual([k, true]);
    expect(conf.associated_endpoints[0].url).toBe(`${w.urls.imaging}/fhir`);
    const meta: any = await (await get(`${w.urls.imaging}/fhir/metadata`)).json();
    expect(meta.implementation.url).toBe(`${w.urls.imaging}/fhir`);
    const authz: any = await (await get(`${w.urls.imaging}/.well-known/authzen-configuration`)).json();
    expect(authz.access_evaluation_endpoint).toBe(`${w.urls.imaging}/access/v1/evaluation`);

    // Each redirect and form on the way, through the sign-in and consent pages.
    const a = buildAuthorization(conf.authorization_endpoint, "portal-app", undefined, undefined, "josh", undefined, w.urls);
    const signIn = await get(a.url);
    const html = await signIn.text();
    const actions = [...html.matchAll(/action="([^"]+)"/g)].map(m => m[1]!);
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) expect(action.startsWith(`${prefix}/`)).toBe(true);
    const back = await submitConsent(a.url, { user: "josh" });
    expect(back.toString().startsWith(`${w.urls.callback}?`)).toBe(true);
    const signed = await get(new URL(actions[0]!.replaceAll("&amp;", "&"), a.url).toString(), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "username=josh" });
    expect(signed.status).toBe(303);
    expect(signed.headers.get("location")!.startsWith(`${prefix}/authorize/consent`)).toBe(true);
    const account = await get(`${w.urls.auth}/account/signin`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "username=josh" });
    expect(account.headers.get("location")!.startsWith(`${prefix}/account`)).toBe(true);
    expect(account.headers.get("set-cookie")).toContain(`Path=${prefix}`);

    const t = await scriptedLaunch("josh", "portal-app", { at: w.urls });
    const bundle: any = await (await searchIn(w, t.access_token)).json();
    for (const l of bundle.link) expect([l.relation, l.url.startsWith(`${w.urls.imaging}/fhir/ImagingStudy?`)]).toEqual([l.relation, true]);
    expect(bundle.link.some((l: any) => l.relation === "next")).toBe(true);
    for (const e of bundle.entry) {
      if (e.resource.resourceType === "ImagingStudy") {
        expect(e.fullUrl.startsWith(`${w.urls.imaging}/fhir/ImagingStudy/`)).toBe(true);
        expect(e.resource.subject.reference).toBe(`${w.urls.clinicalFhir}/Patient/josh-example`);
      } else expect(e.resource.address.startsWith(`${w.urls.proxy}/wado/`)).toBe(true);
    }
    const next: any = await (await get(bundle.link.find((l: any) => l.relation === "next").url, { headers: { Authorization: `Bearer ${t.access_token}` } })).json();
    expect(next.entry.length).toBeGreaterThan(0);
    expect(JSON.stringify([conf, bundle, next])).not.toMatch(new RegExp(`${CONFIG.authUrl.replace(/[.:/]/g, "\\$&")}/(fhir|authorize|token)`));
  });
  test("metadata's bulk links go through the sandbox's proxy", async () => {
    const w = stack.sandboxes.mint();
    const t = await scriptedLaunch("josh", "portal-app", { at: w.urls });
    const bundle: any = await (await get(`${w.urls.imaging}/fhir/ImagingStudy?patient=josh-example&_include=ImagingStudy:endpoint`, { headers: { Authorization: `Bearer ${t.access_token}` } })).json();
    const study = bundle.entry.find((e: any) => e.resource.id === "xr-wrist-left-2012").resource;
    const address = bundle.entry.find((e: any) => e.fullUrl === study.endpoint[0].reference).resource.address;
    const uid = study.identifier[0].value.replace("urn:oid:", "");
    const meta: any[] = await (await get(`${address}/studies/${uid}/metadata`, { headers: { Authorization: `Bearer ${t.access_token}` } })).json();
    const uris = JSON.stringify(meta).match(/"BulkDataURI":"([^"]+)"/g) ?? [];
    expect(uris.length).toBeGreaterThan(0);
    for (const u of uris) expect(u).toContain(`${w.urls.proxy}/wado/`);
  });
});

describe("one way to make a sandbox", () => {
  test("a ~ address, which once built a sandbox from a policy in the URL, isn't a sandbox", async () => {
    const r = await get(`${urlsFor("/s/~abc").clinicalFhir}/.well-known/smart-configuration`);
    expect(r.status).toBe(404);
    expect(((await r.json()) as any).error).toContain("that isn't a sandbox");
  });
});

describe("sandbox lifetimes", () => {
  const catalog = createCatalog();
  const shared = { catalogs: { archive: catalog, orthanc: catalog }, backends: {} as any, clientKeys: new Map(), initialBackend: () => "static-files" as const };
  test("past the cap, the least recently used go first, and an evicted id is gone", () => {
    const sandboxes = createSandboxes(shared, { max: 2 });
    const a = sandboxes.mint(), b = sandboxes.mint();
    expect(sandboxes.resolve(a.id!)).toMatchObject({ sandbox: a });
    const c = sandboxes.mint();
    expect(sandboxes.size).toBe(2);
    expect(sandboxes.resolve(b.id!)).toMatchObject({ status: 404 });
    expect(sandboxes.resolve(a.id!)).toMatchObject({ sandbox: a });
    expect(sandboxes.resolve(c.id!)).toMatchObject({ sandbox: c });
    sandboxes.close();
  });
  test("an idle sandbox is dropped", async () => {
    const sandboxes = createSandboxes(shared, { idleMs: 40 });
    const a = sandboxes.mint(), b = sandboxes.mint();
    await Bun.sleep(25);
    sandboxes.resolve(b.id!);
    await Bun.sleep(25);
    expect(sandboxes.resolve(a.id!)).toMatchObject({ status: 404 });
    expect(sandboxes.resolve(b.id!)).toMatchObject({ sandbox: b });
    sandboxes.close();
  });
  test("an unknown sandbox gets a clear 404 at every service", async () => {
    const id = "B".repeat(22);
    const w = urlsFor(`/s/${id}`);
    for (const u of [`${w.clinicalFhir}/.well-known/smart-configuration`, `${w.demo}/api/flow-state`, `${w.imaging}/fhir/metadata`, `${w.proxy}/wado/-/studies/1.2`, `${w.trace}/api/sessions`, `http://127.0.0.1:${PORTS.imaging}/s/${id}/fhir/metadata`]) {
      const r = await get(u);
      expect([u, r.status]).toEqual([u, 404]);
      expect(((await r.json()) as any).error).toContain("no sandbox has this address");
    }
    expect(splitSandbox("/s/x/a")).toEqual({ sandbox: "x", rest: "/a" });
    expect(splitSandbox("/s/x")).toEqual({ sandbox: "x", rest: "/" });
    expect(splitSandbox("/a/s/x")).toEqual({ rest: "/a/s/x" });
  });
});

describe("trace sessions belong to the sandbox that recorded them", () => {
  test("each sandbox has its own unattributed bucket, and the root's stays the root's", async () => {
    const w = stack.sandboxes.mint();
    await get(`${CONFIG.imagingUrl}/fhir/metadata`);
    await get(`${w.urls.imaging}/fhir/metadata`);
    await traceSettled();
    expect(stack.collector.sandboxOf("unattributed")).toBeUndefined();
    const listed = ((await (await get(`${urlsFor(`/s/${w.id}`).trace}/api/sessions`)).json()) as any[]).map(x => x.id);
    expect(listed).not.toContain("unattributed");
    expect(listed.length).toBe(1);
    expect(stack.collector.sandboxOf(listed[0])).toBe(w.id);
    expect([...stack.collector.sessions.get(listed[0])!.spans.values()].every(x => x.sandbox === w.id)).toBe(true);
  });
  test("baggage naming a root session, sent to a sandbox, can't move that session into the sandbox", async () => {
    const w = stack.sandboxes.mint();
    const victim = `victim-${Date.now()}`;
    const baggage = { baggage: `demo.session=${victim}` };
    await get(`${CONFIG.imagingUrl}/fhir/metadata`, { headers: baggage });
    await get(`${w.urls.imaging}/fhir/metadata`, { headers: baggage });
    await traceSettled();
    expect(stack.collector.sandboxOf(victim)).toBeUndefined();
    expect([...stack.collector.sessions.get(victim)!.spans.values()].every(x => !x.id)).toBe(true);
    const listed = ((await (await get(`${urlsFor(`/s/${w.id}`).trace}/api/sessions`)).json()) as any[]).map(x => x.id);
    expect(listed).not.toContain(victim);
  });
  test("spans are taken only from the services, and never through the one origin", async () => {
    const forged = JSON.stringify([{ session: "unattributed", sandbox: "x", trace: "t".repeat(32), span: "f".repeat(16), service: "demo", kind: "check", name: "forged", start: 1, end: 2, attrs: {} }]);
    expect((await fetch(`http://127.0.0.1:${PORTS.trace}/v1/spans`, { method: "POST", headers: { "content-type": "application/json" }, body: forged })).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${PORTS.trace}/v1/spans`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer guess" }, body: forged })).status).toBe(401);
    if (ONE_ORIGIN) expect((await get(`${CONFIG.traceUrl}/v1/spans`, { method: "POST", headers: { "content-type": "application/json" }, body: forged })).status).toBe(404);
    await traceSettled();
    expect([...(stack.collector.sessions.get("unattributed")?.spans.values() ?? [])].some(x => x.name === "forged")).toBe(false);
  });
  test("one busy sandbox can't push out another's app traffic: its own oldest sessions go first", () => {
    const store = new TraceStore({ mode: "memory", maxSessions: 8, flushMs: 1 });
    const span = (session: string, start: number, sandbox: string) => { const r = { session, trace: "t".repeat(32), span: `s${start}`, service: "demo" as const, kind: "check" as const, name: "n", start, end: start, attrs: {}, sandbox }; store.put(r, JSON.stringify(r)); store.flush(); };
    span("unattributed@Q", 1, "Q"); span("explore-a@Q", 2, "Q");
    for (let i = 0; i < 20; i++) span(`check-${i}@B`, 10 + i, "B");
    const ids = store.sessions().map(x => x.id);
    expect(ids).toContain("unattributed@Q");
    expect(ids).toContain("explore-a@Q");
    expect(ids.filter(id => id.endsWith("@B")).length).toBe(6);
    store.close();
  });
  test("the root keeps its own budget of sessions, whatever the sandboxes do", () => {
    const store = new TraceStore({ mode: "memory", maxSessions: 2, flushMs: 1 });
    const span = (session: string, start: number, sandbox?: string) => { const r = { session, trace: "t".repeat(32), span: `s${start}`, service: "demo" as const, kind: "check" as const, name: "n", start, end: start, attrs: {}, ...(sandbox ? { sandbox } : {}) }; store.put(r, JSON.stringify(r)); store.flush(); };
    span("root-1", 1); span("root-2", 2);
    for (let i = 0; i < 5; i++) span(`busy-${i}@S`, 10 + i, "S");
    const ids = store.sessions().map(x => x.id);
    expect(ids).toContain("root-1");
    expect(ids).toContain("root-2");
    expect(ids.filter(id => id.endsWith("@S")).length).toBe(2);
    span("root-3", 30);
    expect(store.sessions().map(x => x.id).filter(id => !id.includes("@")).sort()).toEqual(["root-2", "root-3"]);
    store.close();
  });
});

describe("the trace, filtered to a sandbox", () => {
  test("a sandbox's live trace lists only its sessions, and won't show another's", async () => {
    // A flow's session, in a sandbox of its own.
    const flow = FLOWS.find(f => f.id === "patient-sites")!, c = await startFlow(stack, registerClients(stack), flow);
    await runStep(c, flow, "consent", defaultsFor(c, flow, "consent"));
    const sandbox = { id: c.sandbox.id, base: c.sandbox.prefix }, session = c.session;
    const other = stack.sandboxes.mint();
    await scriptedLaunch("josh", "portal-app", { at: other.urls });
    await scriptedLaunch("josh");
    await traceSettled();
    const traceOf = (prefix: string) => urlsFor(prefix).trace;
    const listed = async (prefix: string) => ((await (await get(`${traceOf(prefix)}/api/sessions`)).json()) as any[]).map(s => s.id);
    const mine = await listed(sandbox.base);
    expect(mine).toContain(session);
    for (const id of mine) expect(stack.collector.sandboxOf(id)).toBe(sandbox.id);
    expect(await listed(`/s/${other.id}`)).not.toContain(session);
    expect((await listed("")).length).toBeGreaterThan(mine.length);
    expect((await get(`${traceOf(`/s/${other.id}`)}/api/sessions/${encodeURIComponent(session)}/spans`)).status).toBe(404);
    expect((await get(`${traceOf(sandbox.base)}/api/sessions/${encodeURIComponent(session)}/spans`)).status).toBe(200);
    expect((await get(`${traceOf(sandbox.base)}/v1/spans`, { method: "POST", body: "[]" })).status).toBe(404);
    // Its page is the demo's, in the sandbox.
    expect((await get(`${urlsFor(sandbox.base).demo}/trace/`)).status).toBe(200);
  });
});
