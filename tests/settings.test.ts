// The settings menu's API, the pages, and the demo server's routes that touch policy. Requests go
// straight to the handler. The stack's saved store is in memory. Flows run in sandboxes of their own.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { startStack, type Stack } from "../src/stack";
import { registerClients } from "../src/flows";
import { PAGES } from "../ui/sitemap";
import { createDemoServer, uiRoutes } from "../src/demo-server";
import { scriptedLaunch } from "../src/flows/oauth";
import { now, resetClock } from "../src/clock";
import { CONFIG, PORTS } from "../src/config";
import { SCHEMA_VERSION } from "@smart-imaging-proxy/core";
import { RULE_SETS } from "../src/rule-presets";
import { adminFor } from "./admin-token";
import { APPROVALS_ON_FILE } from "../src/stores";

const root = join(import.meta.dir, "..");
let stack: Stack; let demo: ReturnType<typeof createDemoServer>;
beforeAll(async () => { stack = await startStack(root); demo = createDemoServer(stack, registerClients(stack), root); });
afterAll(() => stack.stop());
beforeEach(async () => { await stack.resetSaved(); resetClock(); stack.setBackend("static-files"); });

const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  demo.fetch(new Request(`${CONFIG.demoUrl}${path}`, { method, headers: { "content-type": "application/json", host: new URL(CONFIG.demoUrl).host, ...(await adminFor(demo, path)), ...headers }, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) }));
const ok = async (method: string, path: string, body?: unknown) => { const r = await call(method, path, body); expect(r.status).toBe(200); return r.json() as Promise<any>; };
const refused = async (method: string, path: string, body: unknown, message: string) => {
  const r = await call(method, path, body);
  expect(r.status).toBe(400);
  const b: any = await r.json();
  expect(b.error).toContain(message);
  return b;
};
const RULE = { id: "r1", type: "service-access" as const, service: "service:c", patients: "any" as const, allow: { all: true } };
/** A fresh sandbox's base path. */
const mint = async () => { const r = await call("POST", "/api/sandboxes"); expect(r.status).toBe(201); return ((await r.json()) as any).base as string; };
const SHARE = { from: "user:josh", with: "user:sam-caregiver", patient: "patient:josh-example", sites: ["Lakeside Imaging"], label: "caregiver" };
const APPROVAL = { by: "user:josh", app: "app:portal-app", patient: "patient:josh-example" };
/** The service-access policies in a document. */
const services = (d: any) => d.policies.filter((p: any) => p.type === "service-access");
/** Puts service-access policies and choices in saved policy, leaving what's on file. */
const setSaved = (x: { rules?: any[]; shares?: any[]; approvals?: any[] }) => {
  if (x.rules) stack.store.replacePolicies("service-access", x.rules);
  stack.store.setDocument({ ...(x.shares ? { shares: x.shares } : {}), ...(x.approvals ? { approvals: x.approvals } : {}) });
};

describe("pages", () => {
  test("the React app is served at every page's address on the site map, the site's at the root and a sandbox's under /s/{id}, and the old pages are gone", async () => {
    const routes = Object.keys(uiRoutes());
    for (const p of Object.values(PAGES)) {
      if (p.level === "site") { expect(routes).toContain(p.path); continue; }
      expect(routes).toContain(p.path === "/" ? "/s/:sandbox/" : `/s/:sandbox${p.path}`);
    }
    // The site's own pages are the site's alone: no sandbox has a copy.
    for (const p of Object.values(PAGES).filter(p => p.level === "site")) expect(routes.some(r => r.startsWith("/s/:sandbox") && r.endsWith(p.path) && p.path !== "/")).toBe(false);
    const base = await mint();
    for (const path of ["/servers", "/build-an-app", "/build-a-server", "/about", "/sandboxes", "/check"]) expect([path, (await call("GET", `${base}${path}`)).status]).toEqual([path, 404]);
    for (const path of ["/browse", "/admin", "/app.js", "/admin.js", "/browse.js", "/cards.js", "/api/explore/events", "/api/browse/options", "/api/admin/status"]) expect([path, (await call("GET", path)).status]).toEqual([path, 404]);
  });
});

describe("status", () => {
  test("reports the catalog in use: its source, path, counts and bytes", async () => {
    const s = await ok("GET", "/api/sandbox");
    expect(s.catalog).toMatchObject({ source: "archive", path: ":memory:", studies: 10 });
    expect(s.catalog.series).toBeGreaterThan(6);
    expect(s.catalog.hierarchyBytes).toBeGreaterThan(0);
    expect(s.catalog.hierarchyRawBytes).toBeGreaterThan(s.catalog.hierarchyBytes);
    await ok("PATCH", "/api/sandbox", { storage: "orthanc" });
    expect((await ok("GET", "/api/sandbox")).catalog.source).toBe("orthanc");
  });
  test("reports the saved store: mode, path, durability, schema version, and row counts, and how many sandboxes are live", async () => {
    setSaved({ rules: [RULE], shares: [SHARE], approvals: [APPROVAL] });
    const s = await ok("GET", "/api/sandbox");
    expect(s.store).toMatchObject({ mode: "memory", path: ":memory:", schemaVersion: SCHEMA_VERSION, counts: { relationships: 1, policies: 4, shares: 1, approvals: 1 } });
    expect(s.sandboxes.live).toBe(stack.sandboxes.size);
    expect(s.sandbox).toBeNull();
    expect(s.storage.current).toBe("static-files");
  });
  test("holds no token, hash, or key material", async () => {
    const t = await scriptedLaunch("josh");
    const text = await (await call("GET", "/api/sandbox")).text();
    expect(text).not.toContain(t.access_token);
    expect(text).not.toContain(t.refresh_token);
    expect(text).not.toContain("PRIVATE KEY");
  });
});

describe("resetting saved policy", () => {
  test("there's no store to choose, and nothing else the old admin screen did: those routes are gone", async () => {
    for (const path of ["/api/sandbox/store/activate", "/api/sandbox/store/reset-scratch", "/api/sandbox/rule-set", "/api/sandbox/outage"]) expect((await call("POST", path, { store: "saved" })).status).toBe(404);
    expect((await call("PUT", "/api/sandbox/settings", { contextLifetimeSeconds: 60 })).status).toBe(404);
    expect((await call("DELETE", "/api/sandbox/shares?patient=x&with=y")).status).toBe(404);
    expect((await call("GET", "/api/store")).status).toBe(404);
  });
  test("reset saved needs confirmation, and leaves tokens and the signing key", async () => {
    setSaved({ rules: [RULE], shares: [SHARE] });
    const t = await scriptedLaunch("josh");
    await refused("POST", "/api/sandbox/reset", {}, "confirm");
    await refused("POST", "/api/sandbox/reset", { confirm: "yes" }, "confirm");
    expect(services(stack.store.snapshot())).toEqual([RULE]);
    const s = await ok("POST", "/api/sandbox/reset", { confirm: true });
    expect(s.store.counts).toMatchObject({ relationships: 1, policies: 3, shares: 0, approvals: APPROVALS_ON_FILE.length, signingKeys: 1 });
    expect(services(stack.store.snapshot())).toEqual([]);
    expect(stack.auth.grantOf(t.access_token)).toBeDefined();
  });
});

describe("rule sets", () => {
  const ids = (rules: any[] | undefined) => rules?.map(r => r.id);
  test("each named set resolves against the catalog, for the service it names", () => {
    expect(RULE_SETS.map(s => [s.id, ids(s.rules(stack.catalog))])).toEqual([["no-extra-rules", []], ["hand-wrist-referral", ["hand-referral"]], ["outside-release", ["outside-release"]], ["research-donation", ["research-consent"]], ["all-three-services", ["hand-referral", "outside-release", "research-consent"]]]);
    for (const set of RULE_SETS) { expect(set.label).toBeTruthy(); expect(set.description).toBeTruthy(); }
  });
  test("the outside release set finds its series in the catalog, the way flow 4 does", () => {
    const [rule] = RULE_SETS.find(s => s.id === "outside-release")!.rules(stack.catalog)!;
    const ct = stack.catalog.allStudies().find(s => s.id === "ct-abdomen-pelvis-2012")!;
    const series = stack.catalog.hierarchies([ct.pk]).get(ct.pk)!.series;
    expect([...rule!.withholdSeries!].sort()).toEqual(series.filter(x => /Clinical Documents|Dose (Report|Record)/.test(x.description ?? "")).map(x => x.uid).sort());
    expect(rule!.withholdSeries!.length).toBe(3);
  });
  test("the referral set releases the hand and wrist X-rays and nothing else, to that client alone", async () => {
    await stack.policy.replacePolicies("service-access", RULE_SETS.find(s => s.id === "hand-wrist-referral")!.rules(stack.catalog)!);
    const e = await stack.explain({ client: "hand-referral-service", patient: "josh-example" });
    expect(e.studies.filter((x: any) => x.release !== "none").map((x: any) => x.id).sort()).toEqual(["xr-hand-right-2012", "xr-hand-wrist-right-2012", "xr-wrist-left-2012"]);
    expect((await stack.explain({ client: "research-donation", patient: "josh-example" })).searchAllowed).toBe(false);
  });
  test("a set the catalog can't resolve resolves to nothing", () => {
    const empty = { ...stack.catalogs.orthanc, allStudies: () => [] } as any;
    expect(RULE_SETS.find(s => s.id === "outside-release")!.rules(empty)).toBeUndefined();
  });
});

describe("clock", () => {
  test("advances and resets", async () => {
    const s = await ok("POST", "/api/sandbox/clock", { advanceSeconds: 300 });
    expect(s.clock.offsetSeconds).toBe(300);
    expect(now() - Math.floor(Date.now() / 1000)).toBeGreaterThanOrEqual(299);
    expect(s.clockChoices.map((c: any) => c.value)).toEqual([60, 300, 3600, 86400]);
    expect((await ok("POST", "/api/sandbox/clock", { reset: true })).clock.offsetSeconds).toBe(0);
  });
  test("rejects anything else", async () => {
    for (const body of [{}, { advanceSeconds: -5 }, { advanceSeconds: 1.5 }, { advanceSeconds: "60" }, { advanceSeconds: 1e12 }, { advanceSeconds: 600 }, { reset: false }, { advanceSeconds: 60, reset: false }]) await refused("POST", "/api/sandbox/clock", body, "advanceSeconds");
  });
});

describe("backend", () => {
  test("selects a known backend, and reports self-tests", async () => {
    expect((await ok("PATCH", "/api/sandbox", { storage: "s3" })).storage.current).toBe("s3");
    await refused("PATCH", "/api/sandbox", { storage: "floppy" }, "storage must be");
    stack.setBackend("static-files");
    const r = await ok("GET", "/api/sandbox/storage");
    expect(r.stores.map((b: any) => b.name)).toEqual(["static-files", "s3", "orthanc"]);
    expect(r.stores[0].ok).toBe(true);
  });
  test("the flow player's selector rejects bad input", async () => {
    expect((await call("PATCH", "/api/sandbox", "{nope")).status).toBe(400);
    expect((await call("PATCH", "/api/sandbox", { storage: "floppy" })).status).toBe(400);
    expect((await call("PATCH", "/api/sandbox", { storage: "s3", path: "/etc/passwd" })).status).toBe(400);
    expect(stack.backend).toBe("static-files");
  });
});

describe("a sandbox's settings", () => {
  test("move its own clock and backend, reset its own policy, and leave the root's alone", async () => {
    const base = await mint();
    const sandbox = (stack.sandboxes.resolve(base.slice(3)) as any).sandbox;
    await sandbox.policy.putPolicy(RULE);
    const s = await ok("POST", `${base}/api/sandbox/clock`, { advanceSeconds: 3600 });
    expect(s.sandbox.base).toBe(base);
    expect(s.store).toBeUndefined();
    expect(sandbox.clock.offset()).toBe(3600);
    expect((await ok("GET", "/api/sandbox")).clock.offsetSeconds).toBe(0);
    await ok("PATCH", `${base}/api/sandbox`, { storage: "s3" });
    expect(sandbox.backend).toBe("s3");
    expect(stack.backend).toBe("static-files");
    setSaved({ rules: [RULE] });
    await ok("POST", `${base}/api/sandbox/reset`, { confirm: true });
    expect(services(await ok("GET", `${base}/api/sandbox/policy`))).toEqual([]);
    expect(services(stack.store.snapshot())).toEqual([RULE]);
  });
  test("end access in that sandbox only", async () => {
    const base = await mint();
    const sandbox = (stack.sandboxes.resolve(base.slice(3)) as any).sandbox;
    const inSandbox = await scriptedLaunch("josh", "portal-app", { at: sandbox.urls });
    const atRoot = await scriptedLaunch("josh");
    const kid = sandbox.imaging.signingKid, rootKid = stack.imaging.signingKid;
    await ok("POST", `${base}/api/sandbox/tokens/revoke-all`);
    expect(sandbox.store.getToken(inSandbox.access_token, "access")!.revoked).toBe(true);
    expect(stack.store.getToken(atRoot.access_token, "access")!.revoked).toBe(false);
    const r = await ok("POST", `${base}/api/sandbox/signing-key/rotate`);
    expect(r.rotation.proxyTold).toBe(true);
    expect(sandbox.imaging.signingKid).not.toBe(kid);
    expect(stack.imaging.signingKid).toBe(rootKid);
    expect((await call("POST", `${base}/api/sandbox/proxy/flush`, { anything: 1 })).status).toBe(400);
  });
});

describe("tokens", () => {
  test("revoke all ends access and refresh tokens in saved policy only", async () => {
    await stack.resetAll();
    const sandbox = stack.sandboxes.mint();
    const inSandbox = await scriptedLaunch("josh", "portal-app", { at: sandbox.urls });

    const t = await scriptedLaunch("josh");
    const search = () => fetch(`${CONFIG.imagingUrl}/fhir/ImagingStudy?patient=josh-example`, { headers: { Authorization: `Bearer ${t.access_token}` } });
    expect((await search()).status).toBe(200);
    const s = await ok("POST", "/api/sandbox/tokens/revoke-all");
    expect(s.store.counts.liveAccessTokens).toBe(0);
    expect((await search()).status).toBe(401);
    const refreshed = await fetch(stack.auth.tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: "portal-app" }).toString() });
    expect(refreshed.status).toBe(400);
    expect(sandbox.store.getToken(inSandbox.access_token, "access")!.revoked).toBe(false);
  });
});

describe("/api/sandbox/policy", () => {
  test("reads a sandbox's policy, and takes no writes: policy changes go through the policy API and the settings menu", async () => {
    setSaved({ rules: [RULE] });
    const base = await mint(), other = await mint();
    for (const path of ["/api/sandbox/policy", `${base}/api/sandbox/policy`]) for (const method of ["PUT", "POST", "PATCH", "DELETE"]) expect([path, method, (await call(method, path, { policies: [] })).status]).toEqual([path, method, 404]);
    expect(services(stack.store.snapshot())).toEqual([RULE]);
    // A sandbox's own policy changes through its policy API, and leaves saved policy and other sandboxes alone.
    const sandbox = (stack.sandboxes.resolve(base.slice(3)) as any).sandbox;
    const changed = { ...RULE, id: "sandbox-rule" };
    await sandbox.policy.putPolicy(changed);
    expect(services(await ok("GET", `${base}/api/sandbox/policy`))).toEqual([changed]);
    expect(services(await ok("GET", `${other}/api/sandbox/policy`))).toEqual([]);
    expect(services(await ok("GET", "/api/sandbox/policy"))).toEqual([RULE]);
  });
});

describe("writes from another web origin", () => {
  test("are refused, and same-origin writes are not", async () => {
    const evil = { origin: "https://evil.example" };
    expect((await call("POST", "/api/sandbox/reset", { confirm: true }, evil)).status).toBe(403);
    expect((await call("POST", "/api/sandboxes", undefined, evil)).status).toBe(403);
    expect((await call("POST", "/api/sandbox/reset", { confirm: true }, { origin: CONFIG.demoUrl })).status).toBe(200);
  });
});

describe("writes naming another Host, over real HTTP", () => {
  let server: ReturnType<typeof Bun.serve>;
  beforeAll(() => { server = Bun.serve({ port: PORTS.demo, hostname: "127.0.0.1", routes: demo.routes, fetch: demo.fetch }); });
  afterAll(() => server.stop(true));
  const send = async (path: string, host: string | undefined, init: RequestInit = { method: "POST", body: "{}" }) => fetch(`http://127.0.0.1:${PORTS.demo}${path}`, { ...init, headers: { "content-type": "application/json", ...(await adminFor(demo, path)), ...(host ? { host } : {}) } });

  test("are refused with a 403 and change nothing", async () => {
    setSaved({ rules: [RULE] });
    for (const host of ["evil.example", `evil.example:${PORTS.demo}`, "127.0.0.1", `127.0.0.1:${PORTS.demo + 1}`, `127.0.0.1.evil.example:${PORTS.demo}`, `10.0.0.5:${PORTS.demo}`]) {
      expect((await send("/api/sandbox/reset", host, { method: "POST", body: JSON.stringify({ confirm: true }) })).status).toBe(403);
      expect((await send("/api/sandboxes", host)).status).toBe(403);
      expect((await send("/api/sandbox/signing-key/rotate", host)).status).toBe(403);
      expect((await send("/api/sandbox/clock", host, { method: "POST", body: JSON.stringify({ advanceSeconds: 60 }) })).status).toBe(403);
    }
    expect(services(stack.store.snapshot())).toEqual([RULE]);
  });
  test("this server's own address and port are accepted, with or without naming it", async () => {
    const base = await mint();
    const sandbox = (stack.sandboxes.resolve(base.slice(3)) as any).sandbox;
    expect((await send(`${base}/api/sandbox/clock`, undefined, { method: "POST", body: JSON.stringify({ advanceSeconds: 60 }) })).status).toBe(200);
    expect((await send(`${base}/api/sandbox/clock`, `localhost:${PORTS.demo}`, { method: "POST", body: JSON.stringify({ advanceSeconds: 300 }) })).status).toBe(200);
    expect(sandbox.clock.offset()).toBe(360);
    expect((await ok("GET", "/api/sandbox")).clock.offsetSeconds).toBe(0);
  });
  test("the admin status is refused under another Host too, and answers with no Host named", async () => {
    expect((await send("/api/sandbox", "evil.example", { method: "GET" })).status).toBe(403);
    expect((await send("/api/sandbox/storage", "evil.example", { method: "GET" })).status).toBe(403);
    expect((await send("/api/sandbox", `localhost:${PORTS.demo}`, { method: "GET" })).status).toBe(200);
    expect((await demo.fetch(new Request(`${CONFIG.demoUrl}/api/sandbox`, { headers: await adminFor(demo, "/api/sandbox") }))).status).toBe(200);
  });
});

describe("loading pages", () => {
  test("nothing a page loads changes policy, at the root or in a sandbox", async () => {
    const base = await mint(), sandbox = (stack.sandboxes.resolve(base.slice(3)) as any).sandbox;
    const policyOf = (store: any) => JSON.stringify([store.snapshot(), store.getSettings()]);
    const saved = policyOf(stack.store), its = policyOf(sandbox.store);
    for (const path of ["/api/sandbox", "/api/sandbox/policy", "/api/sandbox/explore/cast", "/api/sandbox/explore/referrals", "/api/activity"]) {
      expect([path, (await call("GET", path)).status]).toEqual([path, 200]);
      expect([path, (await call("GET", `${base}${path}`)).status]).toEqual([path, 200]);
    }
    expect([policyOf(stack.store), policyOf(sandbox.store)]).toEqual([saved, its]);
  });
  test("the log only reads, on load or after: every call it and its parts make is a GET", async () => {
    for (const file of ["ui/pages/Activity.tsx", "ui/activity/Exchange.tsx"]) {
      const calls = [...(await Bun.file(join(root, file)).text()).matchAll(/\bapi(?:<[^>]*>)?\("([A-Z]+)"/g)].map(m => m[1]);
      expect([file, calls.length > 0 && calls.every(m => m === "GET")]).toEqual([file, true]);
    }
  });
});
