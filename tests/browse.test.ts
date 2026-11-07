// The Browse page's API, through the real services. Each test goes through the demo server's own
// handler, with a cookie as a browser would hold it.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { startStack, type BackendName, type Stack } from "../src/stack";
import { registerClients } from "../src/flows";
import { createDemoServer } from "../src/demo-server";
import { submitConsent } from "../src/flows/oauth";
import { resetClock } from "../src/clock";
import { CONFIG } from "../src/config";
import { flushTraces } from "../src/trace";

const root = join(import.meta.dir, "..");
const BACKENDS: BackendName[] = (process.env.BACKENDS?.split(",") as BackendName[]) ?? ["static-files", "minio", "orthanc"];
const ALL = ["ct-abdomen-pelvis-2012", "mri-brain-2020", "slide-lung-2023", "xr-hand-right-2012", "xr-hand-wrist-right-2012", "xr-wrist-left-2012"];
const LAKESIDE_RIVERSIDE = ALL.filter(s => s !== "slide-lung-2023");
const SMALL = "xr-wrist-left-2012";

let stack: Stack; let demo: ReturnType<typeof createDemoServer>;
const realFetch = globalThis.fetch;
const issued = new Set<string>();
beforeAll(async () => {
  // Watches every token response, so the last test can look for them in what the page received.
  globalThis.fetch = (async (input: any, init: any) => {
    const r = await realFetch(input, init);
    if (String(input).endsWith("/token") && r.ok) { const t: any = await r.clone().json(); if (t.access_token) issued.add(t.access_token); if (t.refresh_token) issued.add(t.refresh_token); }
    return r;
  }) as typeof fetch;
  stack = await startStack(root);
  demo = createDemoServer(stack, registerClients(stack), root);
});
afterAll(() => { stack.stop(); globalThis.fetch = realFetch; });
beforeEach(() => { stack.useStore("saved"); stack.resetSaved(); resetClock(); stack.setBackend("static-files"); });

/** One browser: its cookie, and everything it has been sent. */
function browser() {
  let cookie = "";
  const seen: string[] = [];
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await demo.fetch(new Request(`${CONFIG.demoUrl}${path}`, { method, headers: { host: new URL(CONFIG.demoUrl).host, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    const set = r.headers.get("set-cookie");
    if (set) { cookie = set.split(";")[0]!; seen.push(set); }
    const text = await r.text();
    seen.push(text);
    return { status: r.status, text, json: () => JSON.parse(text), headers: r.headers, set };
  };
  const session = async () => (await call("GET", "/api/browse/session")).json().session;
  const settled = async (done = (s: any) => !s.running) => {
    for (let i = 0; i < 2400; i++) { const s = await session(); if (done(s)) return s; await Bun.sleep(25); }
    throw new Error("never settled");
  };
  const start = async (body: any) => { const r = await call("POST", "/api/browse/start", body); expect(r.status).toBe(202); return settled(); };
  const page = async (body: any) => { const r = await call("POST", "/api/browse/page", body); expect(r.status).toBe(200); return r.json().session; };
  const pick = (user: string, extra: any = {}) => start({ user, client: "portal-app", mode: "scripted", count: 20, ...extra });
  const ids = (s: any) => s.page.studies.map((x: any) => x.id).sort();
  const retrieve = async (study: string, zstd: boolean) => {
    const r = await call("POST", "/api/browse/retrieve", { study, zstd });
    expect(r.status).toBe(202);
    const s = await settled(x => !x.retrieving);
    return s.retrievals.find((x: any) => x.study === study && x.mode === (zstd ? "zstd" : "identity"));
  };
  return { call, session, settled, start, page, pick, ids, retrieve, seen, get cookie() { return cookie; } };
}
const SHARE = ["Lakeside Imaging", "Riverside Hospital"];
const rule = (client: string, allow: any = { all: true }, extra: any = {}) => ({ id: `${client}-rule`, when: { client, patient: "josh-example" }, allow, ...extra });

/** Search says yes exactly when the same evaluation says it's released, walking every page. */
async function expectExplainMatchesSearch(b: ReturnType<typeof browser>, s: any) {
  const seen = new Set<string>(s.page.studies.map((x: any) => x.id));
  while (s.page.hasNext) { s = await b.page({ to: "next" }); for (const x of s.page.studies) seen.add(x.id); }
  expect(s.explain.studies.length).toBeGreaterThan(0);
  for (const row of s.explain.studies) expect([row.id, seen.has(row.id)]).toEqual([row.id, row.released]);
  return s;
}

for (const backend of BACKENDS) {
  describe(`each person, on ${backend}`, () => {
    beforeEach(() => stack.setBackend(backend));
    test("Josh sees every study, through a real launch and search", async () => {
      const b = browser();
      const s = await b.pick("josh");
      expect(s.status).toBe("results");
      expect(s.page.total).toBe(6);
      expect(b.ids(s)).toEqual(ALL);
      expect(s.explain.chain).toBe("Josh is the patient; Josh gave the Health Records App everything Josh can see");
      expect(s.steps.map((x: any) => x.title)).toEqual(expect.arrayContaining(["Discover the authorization endpoints", "Exchange the code, with the PKCE verifier", "Search ImagingStudy"]));
      const mri = s.page.studies.find((x: any) => x.id === "mri-brain-2020");
      expect(mri).toMatchObject({ site: "Lakeside Imaging", modalities: ["MR"], series: 18, instances: 267, date: "2020-07-29", retrievable: true });
      expect(mri.context.form).toBe("whole study");
      expect(mri.withheld).toEqual([]);
    }, 60000);
    test("Robin signs in and finds no studies", async () => {
      const b = browser();
      const s = await b.pick("robin");
      expect(s.status).toBe("results");
      expect(s.page.total).toBe(0);
      expect(s.headline).toBe("Robin has no studies");
      expect(s.explain.studies).toEqual([]);
    }, 60000);
    test("Alex's launch ends in access_denied, with no token and no search", async () => {
      const b = browser();
      const s = await b.pick("alex-neighbor");
      expect(s.status).toBe("denied");
      expect(s.headline).toContain("access_denied");
      expect(s.detail).toContain("No patient has shared records with Alex");
      expect(s.steps.map((x: any) => x.title)).not.toContain("Search ImagingStudy");
      expect(s.explain.chain).toBe("Josh hasn't shared anything with Alex");
      expect(s.explain.studies.map((r: any) => r.released)).toEqual(ALL.map(() => false));
      expect(s.explain.studies[0].reason).toBe("Alex has no delegation from the patient");
      expect(s.share.offers.map((o: any) => o.label)).toEqual(["Have Josh share with Alex", "Have Josh share with Sam"]);
    }, 60000);
    test("Sam sees nothing of Josh's, then what Josh shared, then what Sam gave the app", async () => {
      const b = browser();
      const before = await b.pick("sam-caregiver", { patient: "josh-example" });
      expect(before.status).toBe("denied");
      expect(before.share.offers.map((o: any) => o.label)).toEqual(["Have Josh share with Sam"]);
      expect(before.share.sites.filter((x: any) => x.ticked).map((x: any) => x.name)).toEqual(SHARE);

      const shared = await b.pick("sam-caregiver", { share: { delegate: "sam-caregiver", sites: SHARE } });
      expect(shared.status).toBe("results");
      expect(b.ids(shared)).toEqual(LAKESIDE_RIVERSIDE);
      expect(shared.explain.chain).toBe("Josh shared Lakeside Imaging and Riverside Hospital with Sam; Sam gave the Health Records App everything Sam can see");
      const slide = shared.explain.studies.find((r: any) => r.id === "slide-lung-2023");
      expect(slide.released).toBe(false);
      expect(slide.reason).toBe("the delegation to Sam doesn't include Northside Pathology");
      await expectExplainMatchesSearch(b, shared);

      const narrowed = await b.pick("sam-caregiver", { patient: "josh-example", sites: ["Lakeside Imaging"] });
      expect(b.ids(narrowed)).toEqual(["mri-brain-2020"]);
      expect(narrowed.explain.chain).toBe("Josh shared Lakeside Imaging and Riverside Hospital with Sam; Sam gave the Health Records App Lakeside Imaging");
      const riverside = narrowed.explain.studies.find((r: any) => r.id === "xr-wrist-left-2012");
      expect(riverside.reason).toBe("Sam's authorization of the Health Records App doesn't include Riverside Hospital");
      await expectExplainMatchesSearch(b, narrowed);
    }, 120000);
    test("retrieval reports the same numbers in both modes", async () => {
      const b = browser();
      const s = await b.pick("josh");
      const instances = s.page.studies.find((x: any) => x.id === SMALL).instances;
      const zstd = await b.retrieve(SMALL, true), plain = await b.retrieve(SMALL, false);
      for (const r of [zstd, plain]) {
        expect(r).toMatchObject({ status: 200, complete: true, parts: instances, authz: "instant", running: false });
        expect(r.authzPlain).toContain("Instant");
        expect(r.syntaxes.length).toBeGreaterThan(0);
        expect(r.dicomBytes).toBeGreaterThan(0);
        expect(r.traceUrl).toContain(`${CONFIG.traceUrl}/log.html?session=${s.name}&trace=`);
      }
      // The multipart body is the same whichever way it travels, and it's more than its parts.
      expect(zstd.decodedBytes).toBeGreaterThan(zstd.dicomBytes);
      expect(zstd.dicomBytes).toBe(plain.dicomBytes);
      expect(plain.encoding).toBe("identity");
      expect(plain.wireBytes).toBe(plain.decodedBytes);
      const events = stack.proxy.events;
      expect(events.at(-1)!.bytes).toBe(plain.wireBytes);
      expect(events.at(-2)!.bytes).toBe(zstd.wireBytes);
      if (backend === "orthanc") {
        // Orthanc's bytes have no stored frames, so they stay as they are.
        expect(zstd.encoding).toBe("identity");
        expect(zstd.wireBytes).toBe(zstd.decodedBytes);
      } else {
        expect(zstd.encoding).toBe("zstd");
        expect(zstd.decodedBytes).toBe(plain.decodedBytes);
        expect(zstd.contentLength).toBe(zstd.wireBytes);
        expect(plain.contentLength).toBe(plain.wireBytes);
      }
    }, 120000);
  });
}

describe("paging", () => {
  test("follows the real next links, and back", async () => {
    const b = browser();
    let s = await b.pick("josh", { count: 2 });
    expect(s.page).toMatchObject({ total: 6, number: 1, first: 1, last: 2, count: 2, hasNext: true, hasPrevious: false });
    const seen = [...s.page.studies.map((x: any) => x.id)];
    const firstPage = b.ids(s);
    expect(JSON.parse((await b.call("GET", "/api/browse/bundle")).text).link.some((l: any) => l.relation === "next" && l.url.includes("_cursor="))).toBe(true);
    s = await b.page({ to: "next" });
    expect(s.page).toMatchObject({ number: 2, first: 3, last: 4, hasNext: true, hasPrevious: true });
    seen.push(...s.page.studies.map((x: any) => x.id));
    s = await b.page({ to: "next" });
    expect(s.page).toMatchObject({ number: 3, first: 5, last: 6, hasNext: false, hasPrevious: true });
    seen.push(...s.page.studies.map((x: any) => x.id));
    expect([...seen].sort()).toEqual(ALL);
    s = await b.page({ to: "previous" });
    expect(s.page.number).toBe(2);
    s = await b.page({ to: "first" });
    expect(s.page.number).toBe(1);
    expect(b.ids(s)).toEqual(firstPage);
  }, 60000);
  test("a page size starts again from the first page, and only offered sizes work", async () => {
    const b = browser();
    let s = await b.pick("josh", { count: 2 });
    await b.page({ to: "next" });
    s = await b.page({ count: 5 });
    expect(s.page).toMatchObject({ number: 1, count: 5, first: 1, last: 5, hasNext: true });
    expect((await b.call("POST", "/api/browse/page", { count: 3 })).status).toBe(400);
    expect((await b.call("POST", "/api/browse/start", { user: "josh", client: "portal-app", count: 3 })).status).toBe(400);
  }, 60000);
});

describe("explain", () => {
  test("is service-authenticated", async () => {
    const r = await realFetch(`${CONFIG.imagingUrl}/internal/explain?client=portal-app&patient=josh-example`);
    expect(r.status).toBe(401);
  });
  test("matches search for every person and client, for every study", async () => {
    stack.imaging.setPolicy({
      delegations: [{ patient: "josh-example", grantedBy: "josh", delegate: "sam-caregiver", relationship: "caregiver", sites: SHARE }],
      rules: [rule("hand-referral-service", { modalities: ["CR"] }), rule("outside-release-service", { studies: ["ct-abdomen-pelvis-2012"] }), rule("research-donation", { since: "2020-01-01" })],
    });
    const b = browser();
    for (const user of ["josh", "sam-caregiver"]) await expectExplainMatchesSearch(b, await b.pick(user, { count: 2, patient: "josh-example" }));
    for (const client of ["hand-referral-service", "outside-release-service", "research-donation"]) await expectExplainMatchesSearch(b, await b.start({ client, patient: "josh-example", count: 2 }));
  }, 120000);
});

describe("backend clients", () => {
  test("with no pre-authorization, the real 403, and explain agrees", async () => {
    const b = browser();
    const s = await b.start({ client: "hand-referral-service", patient: "josh-example", count: 5 });
    expect(s.status).toBe("forbidden");
    expect(s.headline).toContain("403");
    expect(s.detail).toContain("This patient is outside the client's authorized access");
    expect(s.page.studies).toEqual([]);
    expect(s.explain.chain).toContain("No rule in saved policy pre-authorizes hand-referral-service");
    expect(s.explain.studies.every((r: any) => !r.released)).toBe(true);
    expect(s.steps.map((x: any) => x.title)).toContain("SMART Backend Services token request");
    expect(s.ruleHelp.url).toBe("/admin?rule-set=hand-wrist-referral#h-rules");
    expect(s.ruleHelp.text).toContain('choose "Referral service: hand and wrist X-rays"');
    expect(s.detail).not.toContain("add a rule");
    expect(await Bun.file(join(root, "web/browse.js")).text()).not.toContain("JSON.stringify([{");
  }, 60000);
  test("with a rule, what it allows, withheld series included", async () => {
    const ct = stack.catalog.allStudies().find(x => x.id === "ct-abdomen-pelvis-2012")!;
    const withhold = [ct.series[0]!.uid];
    stack.imaging.setPolicy({ rules: [rule("outside-release-service", { studies: [ct.id] }, { withholdSeries: withhold })] });
    const b = browser();
    const s = await b.start({ client: "outside-release-service", patient: "josh-example", count: 5 });
    expect(s.status).toBe("results");
    expect(b.ids(s)).toEqual([ct.id]);
    const row = s.page.studies[0];
    expect(row.series).toBe(ct.series.length - 1);
    expect(row.instances).toBe(ct.instanceCount - ct.series[0]!.instanceCount);
    expect(row.withheld.map((x: any) => x.uid)).toEqual(withhold);
    expect(row.context.form).toBe("series list");
    expect(s.explain.chain).toContain("outside-release-service is pre-authorized");
    expect((await b.retrieve(ct.id, false)).parts).toBe(row.instances);
    await expectExplainMatchesSearch(b, s);
  }, 120000);
  test("a rule's restricted form shows, and the proxy asks and then uses its cache", async () => {
    stack.imaging.setPolicy({ rules: [rule("research-donation", { studies: [SMALL] }, { contextForm: "restricted" })] });
    const b = browser();
    const s = await b.start({ client: "research-donation", patient: "josh-example", count: 5 });
    expect(s.page.studies[0].context.form).toBe("restricted");
    expect((await b.retrieve(SMALL, false)).authz).toBe("asked");
    expect((await b.retrieve(SMALL, true)).authz).toBe("cached");
  }, 60000);
  test("a person's or client's patient must be one the catalog links", async () => {
    const b = browser();
    expect((await b.call("POST", "/api/browse/start", { client: "research-donation", patient: "nobody", count: 5 })).status).toBe(400);
    expect((await b.call("POST", "/api/browse/start", { client: "research-donation", count: 5 })).status).toBe(400);
    expect((await b.call("POST", "/api/browse/start", { user: "mallory", client: "portal-app", count: 5 })).status).toBe(400);
    const o = (await b.call("GET", "/api/browse/options")).json();
    expect(o.patients.map((p: any) => p.id)).toEqual(["josh-example", "riley-example", "robin-example", "sam-example"]);
    expect(o.people.map((p: any) => p.id)).toEqual(["josh", "robin", "sam-caregiver", "alex-neighbor"]);
    expect(o.people.find((p: any) => p.id === "sam-caregiver").role).toBe("Patient, and guardian for Riley Example");
    expect(o.people.find((p: any) => p.id === "alex-neighbor").role).toBe("Related person, nothing shared yet");
    expect(o.clients.map((c: any) => c.id)).toEqual(["hand-referral-service", "outside-release-service", "research-donation"]);
  });
});

describe("a real window", () => {
  test("the page gets the sign-in URL, and the redirect back finishes the launch", async () => {
    const b = browser();
    await b.call("POST", "/api/browse/start", { user: "josh", client: "separate-viewer", mode: "window", count: 5 });
    const waiting = await b.settled(s => s.status === "waiting-for-you");
    expect(waiting.running).toBe(true);
    expect(waiting.authUrl).toContain("/authorize?");
    const back = await submitConsent(waiting.authUrl, { user: "josh" });
    const done = await demo.fetch(new Request(back.toString()));
    expect(await done.text()).toContain("Back in the app");
    const s = await b.settled();
    expect(s.status).toBe("results");
    expect(s.who).toMatchObject({ id: "josh", app: "Separate Image Viewer" });
    expect(s.page.total).toBe(6);
  }, 60000);
  test("someone else signing in shows as that person", async () => {
    const b = browser();
    stack.imaging.setPolicy({ delegations: [{ patient: "josh-example", grantedBy: "josh", delegate: "sam-caregiver", relationship: "caregiver", sites: ["Lakeside Imaging"] }] });
    await b.call("POST", "/api/browse/start", { user: "josh", client: "portal-app", mode: "window", count: 5 });
    const waiting = await b.settled(s => s.status === "waiting-for-you");
    const back = await submitConsent(waiting.authUrl, { user: "sam-caregiver", patient: "josh-example" });
    await demo.fetch(new Request(back.toString()));
    const s = await b.settled();
    expect(s.who).toMatchObject({ id: "sam-caregiver", asked: "josh" });
    expect(b.ids(s)).toEqual(["mri-brain-2020"]);
    await expectExplainMatchesSearch(b, s);
  }, 60000);
  test("closing the window stops the wait", async () => {
    const b = browser();
    await b.call("POST", "/api/browse/start", { user: "josh", client: "portal-app", mode: "window", count: 5 });
    await b.settled(s => s.status === "waiting-for-you");
    await b.call("POST", "/api/browse/cancel", {});
    const s = await b.settled();
    expect(s.status).toBe("failed");
    expect(s.detail).toContain("window closed");
  }, 60000);
  test("asking for a patient the account doesn't hold says that, rather than that they declined", async () => {
    const b = browser();
    const s = await b.pick("josh", { patient: "robin-example" });
    expect(s.status).toBe("denied");
    expect(s.detail).toContain("Josh doesn't hold Robin Example's records");
    expect(s.detail).not.toContain("chose not to approve");
    const alex = await browser().pick("alex-neighbor", { patient: "josh-example" });
    expect(alex.status).toBe("denied");
    expect(alex.detail).toContain("Alex doesn't hold Josh Example's records");
  }, 60000);
  test("declining in a window still says the person declined", async () => {
    const b = browser();
    await b.call("POST", "/api/browse/start", { user: "josh", client: "portal-app", mode: "window", count: 5 });
    const waiting = await b.settled(s => s.status === "waiting-for-you");
    const back = await submitConsent(waiting.authUrl, { user: "josh", approve: false });
    expect((await demo.fetch(new Request(back))).status).toBe(200);
    const s = await b.settled();
    expect(s.status).toBe("denied");
    expect(s.detail).toContain("Josh chose not to approve the app.");
  }, 60000);
  test("a redirect with an unknown state goes nowhere", async () => {
    const b = browser();
    await b.call("POST", "/api/browse/start", { user: "josh", client: "portal-app", mode: "window", count: 5 });
    await b.settled(s => s.status === "waiting-for-you");
    expect((await demo.fetch(new Request(`${CONFIG.demoUrl}/oauth/callback?code=x&state=wrong`))).status).toBe(400);
    expect((await b.session()).status).toBe("waiting-for-you");
    await b.call("POST", "/api/browse/cancel", {});
    await b.settled();
  }, 60000);
});

describe("the saved store", () => {
  const flow = (path: string, body: unknown = {}) => demo.fetch(new Request(`${CONFIG.demoUrl}${path}`, { method: "POST", headers: { host: new URL(CONFIG.demoUrl).host, "content-type": "application/json" }, body: JSON.stringify(body) }));
  test("a session activates saved policy, and says so when it had to", async () => {
    stack.useStore("scratch");
    const b = browser();
    expect((await b.call("GET", "/api/browse/session")).json().store.active).toBe("scratch"); // Loading changes nothing.
    const s = await b.pick("josh");
    expect(s.switchedStore).toBe(true);
    expect(stack.stores.activeName).toBe("saved");
    expect(stack.stores.saved.appGrants().some(g => g.user === "josh")).toBe(true);
    expect(stack.stores.scratch.appGrants()).toEqual([]);
    expect((await browser().pick("josh")).switchedStore).toBe(false);
  }, 60000);
  test("a flow switching to scratch makes the token stop working, and signing in again recovers", async () => {
    const b = browser();
    await b.pick("josh", { count: 2 });
    expect((await flow("/api/flows/patient-sites/start")).status).toBe(200);
    expect(stack.stores.activeName).toBe("scratch");
    const s = await b.page({ to: "next" });
    expect(s.status).toBe("token-rejected");
    expect(s.headline).toContain("401");
    expect(s.detail).toContain("flow scratch");
    expect(s.page.studies).toEqual([]);
    const again = await b.pick("josh", { count: 2 });
    expect(again.status).toBe("results");
    expect(again.switchedStore).toBe(true);
    expect(stack.stores.activeName).toBe("saved");
  }, 60000);
  test("a revoked token says so", async () => {
    const b = browser();
    await b.pick("josh");
    stack.stores.saved.revokeAllTokens();
    const s = await b.page({ to: "again" });
    expect(s.status).toBe("token-rejected");
    expect(s.detail).toContain("expired or was revoked");
  }, 60000);
  test("sharing writes saved policy, and a flow can't start in the middle of a scripted sign-in", async () => {
    const b = browser();
    await b.call("POST", "/api/browse/start", { user: "sam-caregiver", client: "portal-app", mode: "scripted", count: 5, share: { delegate: "sam-caregiver", sites: SHARE } });
    expect((await flow("/api/flows/patient-sites/start")).status).toBe(409);
    expect((await flow("/api/admin/store/activate", { store: "scratch" })).status).toBe(409);
    const s = await b.settled();
    expect(s.status).toBe("results");
    expect(stack.stores.saved.delegations().map(d => d.delegate)).toEqual(["sam-caregiver"]);
  }, 60000);
  test("a flow starting ends a sign-in waiting on a window", async () => {
    const b = browser();
    await b.call("POST", "/api/browse/start", { user: "josh", client: "portal-app", mode: "window", count: 5 });
    await b.settled(s => s.status === "waiting-for-you");
    expect((await flow("/api/flows/patient-sites/start")).status).toBe(200);
    const s = await b.settled();
    expect(s.status).toBe("failed");
    expect(s.detail).toContain("moved the demo off saved policy");
  }, 60000);
  test("a flow step running holds a Browse session back with a 409", async () => {
    const b = browser();
    await flow("/api/flows/patient-sites/start");
    const running = flow("/api/flows/patient-sites/steps/consent", { inputs: { mode: "window", sites: SHARE } });
    let pending: string | null = null;
    for (let i = 0; i < 400 && !pending; i++) { pending = (await b.call("GET", "/api/pending-authorization")).json().url; if (!pending) await Bun.sleep(25); }
    const r = await b.call("POST", "/api/browse/start", { user: "josh", client: "portal-app", mode: "scripted", count: 5 });
    expect(r.status).toBe(409);
    expect(r.json().error).toContain("still running");
    expect(stack.stores.activeName).toBe("scratch");
    // Finishing the flow's window: its redirect goes to the flow, and not to any Browse session.
    await demo.fetch(new Request((await submitConsent(pending!, { user: "josh", sites: SHARE })).toString()));
    expect((await running).status).toBe(200);
  }, 60000);
  test("writes from another origin or host are refused", async () => {
    const send = (headers: Record<string, string>) => demo.fetch(new Request(`${CONFIG.demoUrl}/api/browse/start`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ user: "josh", client: "portal-app", count: 5 }) }));
    expect((await send({ host: "evil.example" })).status).toBe(403);
    expect((await send({ host: new URL(CONFIG.demoUrl).host, origin: "http://evil.example" })).status).toBe(403);
  });
});

describe("the token stays on the server", () => {
  test("no token in any response, in the page, or in the trace", async () => {
    issued.clear();
    const b = browser();
    const josh = await b.pick("josh", { count: 2 });
    await b.call("GET", "/api/browse/bundle");
    await b.page({ to: "next" });
    await b.retrieve(josh.page.studies.length ? (await b.session()).page.studies[0].id : SMALL, true);
    const meta = await b.call("GET", `/api/browse/metadata?study=${(await b.session()).page.studies[0].id}`);
    expect(meta.status).toBe(200);
    expect(Array.isArray(meta.json())).toBe(true);
    await b.call("GET", "/api/browse/options");
    await b.call("GET", "/api/browse/session");
    await b.pick("alex-neighbor");
    stack.imaging.setPolicy({ rules: [rule("research-donation")] });
    await b.start({ client: "research-donation", patient: "josh-example", count: 5 });
    await b.start({ client: "hand-referral-service", patient: "josh-example", count: 5 });
    for (const path of ["/browse", "/browse.js", "/styles.css", "/"]) await b.call("GET", path);
    expect(issued.size).toBeGreaterThanOrEqual(3);
    const sent = b.seen.join("\n");
    for (const token of issued) expect(sent.includes(token)).toBe(false);
    expect(sent).not.toContain("access_token");
    expect(sent).not.toContain("Bearer ");

    flushTraces();
    await Bun.sleep(200);
    const http = await (await realFetch(`${CONFIG.traceUrl}/api/sessions/${encodeURIComponent(josh.name)}/http`)).text();
    expect(http.length).toBeGreaterThan(1000);
    for (const token of issued) expect(http.includes(token)).toBe(false);
  }, 120000);
  test("the cookie is HttpOnly, and holds the session's secret rather than its trace name", async () => {
    const b = browser();
    const r = await b.call("POST", "/api/browse/start", { user: "robin", client: "portal-app", mode: "scripted", count: 5 });
    expect(r.set).toContain("HttpOnly");
    expect(r.set).toContain("SameSite=Strict");
    expect(r.set).toContain("Path=/api/browse");
    const s = await b.settled();
    expect(s.name).toMatch(/^browse-robin-[0-9a-f]{6}$/);
    expect(b.cookie).not.toContain(s.name);
    expect(s.liveUrl).toBe(`${CONFIG.traceUrl}/?session=${s.name}`);
    expect((await browser().call("GET", "/api/browse/session")).json().session).toBeNull();
  }, 60000);
  test("no one else's session can be read, and the Bundle needs one", async () => {
    expect((await browser().call("GET", "/api/browse/bundle")).status).toBe(404);
    expect((await browser().call("POST", "/api/browse/retrieve", { study: SMALL })).status).toBe(404);
  });
});

describe("the account page", () => {
  test("a Browse link for an account asks for that account, whoever is signed in", async () => {
    const b = browser();
    const s = await b.pick("sam-caregiver", { patient: "josh-example" });
    const links = s.accounts.map((a: any) => a.label);
    expect(links).toEqual(["Sam's account page", "Josh's account page"]);
    const url = s.accounts[1].url;
    expect(url).toContain(`demo_session=${s.name}`);
    expect(url).not.toContain("return=");
    const page = await (await realFetch(url)).text();
    expect(page).toContain("Choose an account");
    const signedIn = await realFetch(`${CONFIG.authUrl}/account/signin`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "username=josh", redirect: "manual" });
    const cookie = signedIn.headers.get("set-cookie")!.split(";")[0]!;
    expect(await (await realFetch(url, { headers: { cookie } })).text()).toContain("Josh Example");
    expect(await (await realFetch(s.accounts[0].url, { headers: { cookie } })).text()).toContain("Choose an account");
  }, 60000);
});

describe("pages", () => {
  test("the page and its script are served, and the home page and admin link to it", async () => {
    const b = browser();
    const html = (await b.call("GET", "/browse")).text;
    expect(html).toContain('src="/browse.js"');
    expect(html).toContain('href="/styles.css"');
    expect((await b.call("GET", "/browse.js")).status).toBe(200);
    expect((await b.call("GET", "/")).text).toContain('href="/browse"');
    expect((await b.call("GET", "/admin")).text).toContain('href="/browse"');
    expect((await b.call("GET", "/app.js")).text).toContain('href="/browse"');
  });
});
