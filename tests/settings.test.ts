// The settings menu's API, the pages, and the demo server's routes that touch policy. Requests go
// straight to the handler. The stack's saved store is in memory. Flows run in scopes of their own.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { startStack, type Stack } from "../src/stack";
import { registerClients } from "../src/flows";
import { createDemoServer } from "../src/demo-server";
import { scriptedLaunch } from "../src/flows/oauth";
import { now, resetClock } from "../src/clock";
import { CONFIG, PORTS } from "../src/config";
import { SCHEMA_VERSION } from "@smart-imaging-proxy/core";
import { RULE_SETS } from "../src/rule-presets";

const root = join(import.meta.dir, "..");
let stack: Stack; let demo: ReturnType<typeof createDemoServer>;
beforeAll(async () => { stack = await startStack(root); demo = createDemoServer(stack, registerClients(stack), root); });
afterAll(() => stack.stop());
beforeEach(async () => { await stack.resetSaved(); resetClock(); stack.setBackend("static-files"); });

const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  demo.fetch(new Request(`${CONFIG.demoUrl}${path}`, { method, headers: { "content-type": "application/json", host: new URL(CONFIG.demoUrl).host, ...headers }, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) }));
const ok = async (method: string, path: string, body?: unknown) => { const r = await call(method, path, body); expect(r.status).toBe(200); return r.json() as Promise<any>; };
const refused = async (method: string, path: string, body: unknown, message: string) => {
  const r = await call(method, path, body);
  expect(r.status).toBe(400);
  const b: any = await r.json();
  expect(b.error).toContain(message);
  return b;
};
const RULE = { id: "r1", type: "service-access" as const, service: "service:c", patients: "any" as const, allow: { all: true } };
/** A fresh scope's base path. */
const mint = async () => { const r = await call("POST", "/api/scopes"); expect(r.status).toBe(201); return ((await r.json()) as any).base as string; };
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
  test("Explore, Tours and the activity view are served, with the header's two links, and the old pages are gone", async () => {
    for (const [path, title] of [["/", "Explore"], ["/tours", "Tours"], ["/activity", "Activity"]]) {
      const html = await (await call("GET", path)).text();
      expect(html).toContain(`<title>${title}`);
      expect(html).toMatch(/<nav class="pages" aria-label="Pages"><a href="\/"[^>]*>Explore<\/a><a href="\/tours"[^>]*>Tours<\/a><\/nav>/);
      expect(html).toContain('id="settings-button"');
      expect(html).not.toContain("store-badge");
    }
    for (const path of ["/explore.js", "/tours.js", "/activity.js", "/cards.js", "/page.js", "/thumbs.js", "/styles.css"]) expect((await call("GET", path)).status).toBe(200);
    for (const path of ["/browse", "/admin", "/app.js", "/admin.js", "/browse.js", "/api/browse/options", "/api/admin/status"]) expect([path, (await call("GET", path)).status]).toEqual([path, 404]);
  });
});

describe("status", () => {
  test("reports the catalog in use: its source, path, counts and bytes", async () => {
    const s = await ok("GET", "/api/settings/status");
    expect(s.catalog).toMatchObject({ source: "archive", path: ":memory:", studies: 10 });
    expect(s.catalog.series).toBeGreaterThan(6);
    expect(s.catalog.hierarchyBytes).toBeGreaterThan(0);
    expect(s.catalog.hierarchyRawBytes).toBeGreaterThan(s.catalog.hierarchyBytes);
    await ok("POST", "/api/settings/backend", { backend: "orthanc" });
    expect((await ok("GET", "/api/settings/status")).catalog.source).toBe("orthanc");
  });
  test("reports the saved store: mode, path, durability, schema version, and row counts, and how many scopes are live", async () => {
    setSaved({ rules: [RULE], shares: [SHARE], approvals: [APPROVAL] });
    const s = await ok("GET", "/api/settings/status");
    expect(s.store).toMatchObject({ mode: "memory", path: ":memory:", schemaVersion: SCHEMA_VERSION, counts: { relationships: 1, policies: 4, shares: 1, approvals: 1 } });
    expect(s.scopes.live).toBe(stack.scopes.size);
    expect(s.scope).toBeNull();
    expect(s.backend.current).toBe("static-files");
  });
  test("holds no token, hash, or key material", async () => {
    const t = await scriptedLaunch("josh");
    const text = await (await call("GET", "/api/settings/status")).text();
    expect(text).not.toContain(t.access_token);
    expect(text).not.toContain(t.refresh_token);
    expect(text).not.toContain("PRIVATE KEY");
  });
});

describe("resetting saved policy", () => {
  test("there's no store to choose, and nothing else the old admin screen did: those routes are gone", async () => {
    for (const path of ["/api/settings/store/activate", "/api/settings/store/reset-scratch", "/api/settings/rule-set", "/api/settings/outage"]) expect((await call("POST", path, { store: "saved" })).status).toBe(404);
    expect((await call("PUT", "/api/settings/settings", { contextLifetimeSeconds: 60 })).status).toBe(404);
    expect((await call("DELETE", "/api/settings/shares?patient=x&with=y")).status).toBe(404);
    expect((await call("GET", "/api/store")).status).toBe(404);
  });
  test("reset saved needs confirmation, and leaves tokens and the signing key", async () => {
    setSaved({ rules: [RULE], shares: [SHARE] });
    const t = await scriptedLaunch("josh");
    await refused("POST", "/api/settings/reset", {}, "confirm");
    await refused("POST", "/api/settings/reset", { confirm: "yes" }, "confirm");
    expect(services(stack.store.snapshot())).toEqual([RULE]);
    const s = await ok("POST", "/api/settings/reset", { confirm: true });
    expect(s.store.counts).toMatchObject({ relationships: 1, policies: 3, shares: 0, approvals: 0, signingKeys: 1 });
    expect(services(stack.store.snapshot())).toEqual([]);
    expect(stack.auth.grantOf(t.access_token)).toBeDefined();
  });
});

describe("flows and saved policy, over HTTP", () => {
  test("starting a flow mints a scope that starts from the guardians on file, and saved policy is untouched", async () => {
    setSaved({ rules: [RULE], shares: [SHARE] });
    const started = await ok("POST", "/api/flows/patient-sites/start");
    expect(started.scope.base).toBe(`/s/${started.scope.id}`);
    expect(services(started.policy)).toEqual([]);
    expect(started.policy.shares).toEqual([]);
    // The same facts on file; each world gives its rows its own ids.
    const fact = ({ id: _, recordedAt: __, ...r }: any) => r;
    expect(started.policy.relationships.map(fact)).toEqual(stack.store.relationships().map(fact));
    expect(started.policy.policies).toEqual(stack.store.policiesOf("guardian-access").concat(stack.store.policiesOf("sharing") as any));
    expect(services(await ok("GET", "/api/policy"))).toEqual([RULE]);
    expect(services(await ok("GET", `${started.scope.base}/api/policy`))).toEqual([]);
    const again = await ok("POST", "/api/flows/patient-sites/start");
    expect(again.scope.id).not.toBe(started.scope.id);
  });
  test("a flow's steps run in its scope, and a step at the root is refused", async () => {
    setSaved({ rules: [RULE] });
    const { scope } = await ok("POST", "/api/flows/patient-sites/start");
    expect((await call("POST", "/api/flows/patient-sites/steps/consent", { inputs: { mode: "scripted" } })).status).toBe(409);
    const r = await ok("POST", `${scope.base}/api/flows/patient-sites/steps/consent`, { inputs: { mode: "scripted", sites: ["Lakeside Imaging"] } });
    expect(r.scope).toEqual(scope);
    expect(r.policy.approvals.length).toBe(1);
    expect(stack.scopes.resolve(scope.id)).toMatchObject({ world: { scope: scope.id } });
    expect(stack.store.approvals()).toEqual([]);
    expect(services(stack.store.snapshot())).toEqual([RULE]);
    // Another flow's steps don't run in this scope.
    expect((await call("POST", `${scope.base}/api/flows/caregiver/steps/delegate`, {})).status).toBe(409);
  });
  test("the flow state is the scope's, so a reload there comes back to the run", async () => {
    const { scope } = await ok("POST", "/api/flows/patient-sites/start");
    await ok("POST", `${scope.base}/api/flows/patient-sites/steps/consent`, { inputs: { mode: "scripted" } });
    const state = await ok("GET", `${scope.base}/api/flow-state`);
    expect(state.flow).toBe("patient-sites");
    expect(Object.keys(state.completed)).toEqual(["consent"]);
    expect((await ok("GET", "/api/flow-state")).flow).toBeNull();
    expect(await (await call("GET", `${scope.base}/`)).text()).toContain('src="/explore.js"');
  });
  test("a minted scope, and an unknown one", async () => {
    const r = await call("POST", "/api/scopes", {});
    expect(r.status).toBe(201);
    const made: any = await r.json();
    expect(made.scope).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(made.urls.auth).toBe(`${new URL(CONFIG.authUrl).origin}/s/${made.scope}${new URL(CONFIG.authUrl).pathname.replace(/\/$/, "")}`);
    expect((await ok("GET", `/s/${made.scope}/api/flow-state`)).scope.id).toBe(made.scope);
    const gone = await call("GET", "/s/AAAAAAAAAAAAAAAAAAAAAA/api/flow-state");
    expect(gone.status).toBe(404);
    expect(((await gone.json()) as any).error).toContain("doesn't exist");
    expect((await call("POST", "/api/scopes", { anything: 1 })).status).toBe(400);
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
    const s = await ok("POST", "/api/settings/clock", { advanceSeconds: 300 });
    expect(s.clock.offsetSeconds).toBe(300);
    expect(now() - Math.floor(Date.now() / 1000)).toBeGreaterThanOrEqual(299);
    expect(s.clockChoices.map((c: any) => c.value)).toEqual([60, 300, 3600, 86400]);
    expect((await ok("POST", "/api/settings/clock", { reset: true })).clock.offsetSeconds).toBe(0);
  });
  test("rejects anything else", async () => {
    for (const body of [{}, { advanceSeconds: -5 }, { advanceSeconds: 1.5 }, { advanceSeconds: "60" }, { advanceSeconds: 1e12 }, { advanceSeconds: 600 }, { reset: false }, { advanceSeconds: 60, reset: false }]) await refused("POST", "/api/settings/clock", body, "advanceSeconds");
  });
});

describe("backend", () => {
  test("selects a known backend, and reports self-tests", async () => {
    expect((await ok("POST", "/api/settings/backend", { backend: "s3" })).backend.current).toBe("s3");
    await refused("POST", "/api/settings/backend", { backend: "floppy" }, "backend must be");
    stack.setBackend("static-files");
    const r = await ok("GET", "/api/settings/backends");
    expect(r.backends.map((b: any) => b.name)).toEqual(["static-files", "s3", "orthanc"]);
    expect(r.backends[0].ok).toBe(true);
  });
  test("the flow player's selector rejects bad input", async () => {
    expect((await call("POST", "/api/backend", "{nope")).status).toBe(400);
    expect((await call("POST", "/api/backend", { backend: "floppy" })).status).toBe(400);
    expect((await call("POST", "/api/backend", { backend: "s3", path: "/etc/passwd" })).status).toBe(400);
    expect(stack.backend).toBe("static-files");
  });
});

describe("a scope's settings", () => {
  test("move its own clock and backend, reset its own policy, and leave the root's alone", async () => {
    const base = await mint();
    const world = (stack.scopes.resolve(base.slice(3)) as any).world;
    await ok("PUT", `${base}/api/policy`, { policies: [RULE] });
    const s = await ok("POST", `${base}/api/settings/clock`, { advanceSeconds: 3600 });
    expect(s.scope.base).toBe(base);
    expect(s.store).toBeUndefined();
    expect(world.clock.offset()).toBe(3600);
    expect((await ok("GET", "/api/settings/status")).clock.offsetSeconds).toBe(0);
    await ok("POST", `${base}/api/settings/backend`, { backend: "s3" });
    expect(world.backend).toBe("s3");
    expect(stack.backend).toBe("static-files");
    setSaved({ rules: [RULE] });
    await ok("POST", `${base}/api/settings/reset`, { confirm: true });
    expect(services(await ok("GET", `${base}/api/policy`))).toEqual([]);
    expect(services(stack.store.snapshot())).toEqual([RULE]);
  });
  test("end access in that scope only", async () => {
    const base = await mint();
    const world = (stack.scopes.resolve(base.slice(3)) as any).world;
    const inScope = await scriptedLaunch("josh", "portal-app", { at: world.urls });
    const atRoot = await scriptedLaunch("josh");
    const kid = world.imaging.signingKid, rootKid = stack.imaging.signingKid;
    await ok("POST", `${base}/api/settings/tokens/revoke-all`);
    expect(world.store.getToken(inScope.access_token, "access")!.revoked).toBe(true);
    expect(stack.store.getToken(atRoot.access_token, "access")!.revoked).toBe(false);
    const r = await ok("POST", `${base}/api/settings/signing-key/rotate`);
    expect(r.rotation.proxyTold).toBe(true);
    expect(world.imaging.signingKid).not.toBe(kid);
    expect(stack.imaging.signingKid).toBe(rootKid);
    expect((await call("POST", `${base}/api/settings/proxy/flush`, { anything: 1 })).status).toBe(400);
  });
});

describe("tokens", () => {
  test("revoke all ends access and refresh tokens in saved policy only", async () => {
    await stack.resetAll();
    const scope = stack.scopes.mint();
    const inScope = await scriptedLaunch("josh", "portal-app", { at: scope.urls });

    const t = await scriptedLaunch("josh");
    const search = () => fetch(`${CONFIG.imagingUrl}/fhir/ImagingStudy?patient=josh-example`, { headers: { Authorization: `Bearer ${t.access_token}` } });
    expect((await search()).status).toBe(200);
    const s = await ok("POST", "/api/settings/tokens/revoke-all");
    expect(s.store.counts.liveAccessTokens).toBe(0);
    expect((await search()).status).toBe(401);
    const refreshed = await fetch(stack.auth.tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: "portal-app" }).toString() });
    expect(refreshed.status).toBe(400);
    expect(scope.store.getToken(inScope.access_token, "access")!.revoked).toBe(false);
  });
});

describe("/api/policy", () => {
  test("a PUT at the root is refused with a 409, and changes nothing", async () => {
    setSaved({ rules: [RULE] });
    const r = await call("PUT", "/api/policy", { policies: [] });
    expect(r.status).toBe(409);
    expect((await r.json() as any).error).toContain("only a flow's own scope");
    expect((await call("PUT", "/api/policy", "{not json")).status).toBe(409);
    expect(services(stack.store.snapshot())).toEqual([RULE]);
    expect(services(await ok("GET", "/api/policy"))).toEqual([RULE]);
  });
  test("a PUT changes its scope, and leaves saved policy and other scopes alone", async () => {
    setSaved({ rules: [RULE] });
    const base = await mint(), other = await mint();
    const changed = { ...RULE, id: "scope-rule" };
    expect((await ok("PUT", `${base}/api/policy`, { policies: [changed] })).policies).toEqual([changed]);
    expect((await ok("GET", `${base}/api/policy`)).policies).toEqual([changed]);
    expect(services(await ok("GET", `${other}/api/policy`))).toEqual([]);
    expect(services(stack.store.snapshot())).toEqual([RULE]);
  });
  test("a bad PUT gets a 400, and doesn't corrupt the policy", async () => {
    const base = await mint();
    await ok("PUT", `${base}/api/policy`, { policies: [RULE] });
    const cases: [unknown, string][] = [
      ["{not json", "valid JSON"],
      [[RULE], "JSON object"],
      [{ policies: "x" }, "policies must be an array"],
      [{ policies: [{ id: "a" }] }, "policies[0]"],
      [{ policies: [], contextLifetimeSeconds: "soon" }, "contextLifetimeSeconds"],
      [{ policies: [], shares: [{ patient: "p" }] }, "shares[0]"],
      [{ policies: [], whatever: 1 }, 'unknown field "whatever"'],
    ];
    for (const [body, message] of cases) await refused("PUT", `${base}/api/policy`, body, message);
    expect((await ok("GET", `${base}/api/policy`)).policies).toEqual([RULE]);
    // Search in that scope keeps working on what's there.
    const world = (stack.scopes.resolve(base.slice(3)) as any).world;
    const t = await scriptedLaunch("josh", "portal-app", { at: world.urls });
    expect((await fetch(`${world.urls.imaging}/fhir/ImagingStudy?patient=josh-example`, { headers: { Authorization: `Bearer ${t.access_token}` } })).status).toBe(200);
  });
  test("what GET returns can be sent back by PUT", async () => {
    const base = await mint();
    await ok("PUT", `${base}/api/policy`, { policies: [RULE], shares: [SHARE], approvals: [APPROVAL], maxSeriesInContext: 100 });
    const p = await ok("GET", `${base}/api/policy`);
    expect(await ok("PUT", `${base}/api/policy`, p)).toEqual(p);
  });
});

describe("writes from another web origin", () => {
  test("are refused, and same-origin writes are not", async () => {
    const evil = { origin: "https://evil.example" };
    expect((await call("POST", "/api/settings/reset", { confirm: true }, evil)).status).toBe(403);
    expect((await call("PUT", "/api/policy", { policies: [] }, evil)).status).toBe(403);
    expect((await call("POST", "/api/settings/reset", { confirm: true }, { origin: CONFIG.demoUrl })).status).toBe(200);
  });
});

describe("writes naming another Host, over real HTTP", () => {
  let server: ReturnType<typeof Bun.serve>;
  beforeAll(() => { server = Bun.serve({ port: PORTS.demo, hostname: "127.0.0.1", fetch: demo.fetch }); });
  afterAll(() => server.stop(true));
  const send = (path: string, host: string | undefined, init: RequestInit = { method: "POST", body: "{}" }) => fetch(`http://127.0.0.1:${PORTS.demo}${path}`, { ...init, headers: { "content-type": "application/json", ...(host ? { host } : {}) } });

  test("are refused with a 403 and change nothing", async () => {
    setSaved({ rules: [RULE] });
    for (const host of ["evil.example", `evil.example:${PORTS.demo}`, "127.0.0.1", `127.0.0.1:${PORTS.demo + 1}`, `127.0.0.1.evil.example:${PORTS.demo}`, `10.0.0.5:${PORTS.demo}`]) {
      expect((await send("/api/settings/reset", host, { method: "POST", body: JSON.stringify({ confirm: true }) })).status).toBe(403);
      expect((await send("/api/scopes", host)).status).toBe(403);
      expect((await send("/api/settings/signing-key/rotate", host)).status).toBe(403);
      expect((await send("/api/policy", host, { method: "PUT", body: JSON.stringify({ policies: [] }) })).status).toBe(403);
    }
    expect(services(stack.store.snapshot())).toEqual([RULE]);
  });
  test("this server's own address and port are accepted, with or without naming it", async () => {
    const base = await mint();
    expect((await send(`${base}/api/policy`, undefined, { method: "PUT", body: JSON.stringify({ maxSeriesInContext: 7 }) })).status).toBe(200);
    expect((await send(`${base}/api/policy`, `localhost:${PORTS.demo}`, { method: "PUT", body: JSON.stringify({ maxSeriesInContext: 8 }) })).status).toBe(200);
    expect((await ok("GET", `${base}/api/policy`)).maxSeriesInContext).toBe(8);
    expect(stack.store.getSettings().maxSeriesInContext).toBe(12);
  });
  test("the admin status is refused under another Host too, and answers with no Host named", async () => {
    expect((await send("/api/settings/status", "evil.example", { method: "GET" })).status).toBe(403);
    expect((await send("/api/settings/backends", "evil.example", { method: "GET" })).status).toBe(403);
    expect((await send("/api/settings/status", `localhost:${PORTS.demo}`, { method: "GET" })).status).toBe(200);
    expect((await demo.fetch(new Request(`${CONFIG.demoUrl}/api/settings/status`))).status).toBe(200);
  });
});

describe("loading pages", () => {
  test("nothing a page loads changes saved policy or the flow", async () => {
    const { scope } = await ok("POST", "/api/flows/patient-sites/start");
    await ok("POST", `${scope.base}/api/flows/patient-sites/steps/consent`, { inputs: { mode: "scripted", sites: ["Lakeside Imaging"] } });
    const saved = JSON.stringify([stack.store.snapshot(), stack.store.getSettings()]);
    for (const path of ["/", "/tours", "/activity", "/explore.js", "/styles.css", "/api/flows", "/api/flow-state", "/api/session", "/api/settings/status", "/api/policy", "/api/explore/options", "/api/explore/session", "/api/tours", "/api/activity"]) {
      expect((await call("GET", path)).status).toBe(200);
    }
    for (const path of ["/", "/tours", "/api/flows", "/api/flow-state", "/api/session", "/api/policy", "/api/settings/status", "/api/tours/state"]) expect((await call("GET", `${scope.base}${path}`)).status).toBe(200);
    expect(JSON.stringify([stack.store.snapshot(), stack.store.getSettings()])).toBe(saved);
    const state = await ok("GET", `${scope.base}/api/flow-state`);
    expect(state.flow).toBe("patient-sites");
    expect(Object.keys(state.completed)).toEqual(["consent"]);
    expect(state.completed.consent.result.checks.every((c: any) => c.ok)).toBe(true);
    expect(state.completed.consent.inputs.sites).toEqual(["Lakeside Imaging"]);
    expect(state.policy.approvals.length).toBe(1);
    expect(state.scope).toEqual(scope);
  });
  test("each page's script sends nothing on load except reads", async () => {
    for (const file of ["/explore.js", "/tours.js", "/activity.js"]) {
      const js = await (await call("GET", file)).text();
      // What runs on load is the last block, and it only reads.
      const onLoad = js.slice(js.lastIndexOf("(async () => {"));
      expect([file, /"POST"|method: "POST"/.test(onLoad)]).toEqual([file, false]);
    }
  });
  test("a flow carries on from its scope after the root was used", async () => {
    const { scope } = await ok("POST", "/api/flows/patient-sites/start");
    await ok("POST", `${scope.base}/api/flows/patient-sites/steps/consent`, { inputs: { mode: "scripted", sites: ["Lakeside Imaging"] } });
    await scriptedLaunch("josh");
    await stack.policy.putPolicy(RULE_SETS.find(s => s.id === "research-donation")!.rules(stack.catalog)![0]!);
    const search = await ok("POST", `${scope.base}/api/flows/patient-sites/steps/search`, {});
    expect(search.scope).toEqual(scope);
    expect(search.result.checks.every((c: any) => c.ok)).toBe(true);
  });
});

describe("a second tab", () => {
  test("can't rerun a finished step, or disturb a flow by running a step of another", async () => {
    const { scope } = await ok("POST", "/api/flows/patient-sites/start");
    await ok("POST", `${scope.base}/api/flows/patient-sites/steps/consent`, { inputs: { mode: "scripted", sites: ["Lakeside Imaging"] } });
    expect((await call("POST", `${scope.base}/api/flows/patient-sites/steps/consent`, { inputs: {} })).status).toBe(409);
    expect((await call("POST", `${scope.base}/api/flows/caregiver/steps/delegate`, { inputs: {} })).status).toBe(409);
    const state = await ok("GET", `${scope.base}/api/flow-state`);
    expect(state.flow).toBe("patient-sites");
    expect(state.policy.approvals[0].sites).toEqual(["Lakeside Imaging"]);
  });
  test("can't start a step while another is running", async () => {
    const { scope } = await ok("POST", "/api/flows/patient-sites/start");
    const first = call("POST", `${scope.base}/api/flows/patient-sites/steps/consent`, { inputs: { mode: "scripted", sites: ["Lakeside Imaging"] } });
    const second = await call("POST", `${scope.base}/api/flows/patient-sites/steps/search`, {});
    expect(second.status).toBe(409);
    expect((await first).status).toBe(200);
  });
  test("starting the same flow again gets a new scope, and the first run keeps its own", async () => {
    const a = (await ok("POST", "/api/flows/patient-sites/start")).scope;
    await ok("POST", `${a.base}/api/flows/patient-sites/steps/consent`, { inputs: { mode: "scripted", sites: ["Lakeside Imaging"] } });
    const b = (await ok("POST", "/api/flows/patient-sites/start")).scope;
    expect(b.id).not.toBe(a.id);
    expect(Object.keys((await ok("GET", `${a.base}/api/flow-state`)).completed)).toEqual(["consent"]);
    expect((await ok("GET", `${b.base}/api/flow-state`)).completed).toEqual({});
  });
});
