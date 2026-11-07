// The admin API, and the demo server's routes that touch policy. Requests go straight to the
// handler. The stack's saved store is in memory. Flows run in scopes of their own.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { startStack, type Stack } from "../src/stack";
import { registerClients } from "../src/flows";
import { createDemoServer } from "../src/demo-server";
import { scriptedLaunch } from "../src/flows/oauth";
import { now, resetClock } from "../src/clock";
import { CONFIG, PORTS } from "../src/config";
import { SCHEMA_VERSION } from "@smart-imaging-proxy/core";

const root = join(import.meta.dir, "..");
let stack: Stack; let demo: ReturnType<typeof createDemoServer>;
beforeAll(async () => { stack = await startStack(root); demo = createDemoServer(stack, registerClients(stack), root); });
afterAll(() => stack.stop());
beforeEach(async () => { await stack.resetSaved(); stack.imaging.setOutage(false); resetClock(); stack.setBackend("static-files"); });

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
const RULE = { id: "r1", when: { client: "c" }, allow: { all: true } };
/** A fresh scope's base path. */
const mint = async () => { const r = await call("POST", "/api/scopes"); expect(r.status).toBe(201); return ((await r.json()) as any).base as string; };
const DELEGATION = { patient: "josh-example", grantedBy: "josh", delegate: "sam-caregiver", relationship: "caregiver", sites: ["Lakeside Imaging"] };
const GRANT = { client: "portal-app", user: "josh", patient: "josh-example" };

describe("pages", () => {
  test("the admin screen and its script are served, and the demo header links to it", async () => {
    const html = await (await call("GET", "/admin")).text();
    expect(html).toContain("There's no login");
    expect(html).toContain("Nothing on this page can reach the file system or run a command");
    expect(html).toContain("127.0.0.1");
    expect(html).toContain('href="/styles.css"');
    expect((await call("GET", "/admin.js")).status).toBe(200);
    expect(await (await call("GET", "/")).text()).toContain('href="/admin"');
  });
});

describe("status", () => {
  test("reports the catalog in use: its source, path, counts and bytes", async () => {
    const s = await ok("GET", "/api/admin/status");
    expect(s.catalog).toMatchObject({ source: "archive", path: ":memory:", studies: 10 });
    expect(s.catalog.series).toBeGreaterThan(6);
    expect(s.catalog.hierarchyBytes).toBeGreaterThan(0);
    expect(s.catalog.hierarchyRawBytes).toBeGreaterThan(s.catalog.hierarchyBytes);
    await ok("POST", "/api/admin/backend", { backend: "orthanc" });
    expect((await ok("GET", "/api/admin/status")).catalog.source).toBe("orthanc");
    expect(await (await call("GET", "/admin")).text()).toContain('id="catalog-stats"');
  });
  test("reports the saved store: mode, path, durability, schema version, and row counts, and how many scopes are live", async () => {
    stack.store.setPolicy({ rules: [RULE], delegations: [DELEGATION], appGrants: [GRANT] });
    const s = await ok("GET", "/api/admin/status");
    expect(s.store).toMatchObject({ mode: "memory", path: ":memory:", schemaVersion: SCHEMA_VERSION, counts: { delegations: 1, appGrants: 1, rules: 1 } });
    expect(s.scopes.live).toBe(stack.scopes.size);
    expect(s.policy.rules).toEqual([RULE]);
    expect(s.settings).toEqual({ contextLifetimeSeconds: 300, maxSeriesInContext: 12, tokenLifetimeSeconds: 3600, refreshTokenLifetimeSeconds: 2592000 });
    expect(s.backend.current).toBe("static-files");
    expect(s.outage).toBe(false);
  });
  test("holds no token, hash, or key material", async () => {
    const t = await scriptedLaunch("josh");
    const text = await (await call("GET", "/api/admin/status")).text();
    expect(text).not.toContain(t.access_token);
    expect(text).not.toContain(t.refresh_token);
    expect(text).not.toContain("PRIVATE KEY");
  });
});

describe("resetting saved policy", () => {
  test("there's no store to choose: the controls for one are gone", async () => {
    for (const path of ["/api/admin/store/activate", "/api/admin/store/reset-scratch"]) expect((await call("POST", path, { store: "saved" })).status).toBe(404);
    expect((await call("GET", "/api/store")).status).toBe(404);
  });
  test("reset saved needs confirmation, and leaves tokens and the signing key", async () => {
    stack.store.setPolicy({ rules: [RULE], delegations: [DELEGATION] });
    const t = await scriptedLaunch("josh");
    await refused("POST", "/api/admin/store/reset-saved", {}, "confirm");
    await refused("POST", "/api/admin/store/reset-saved", { confirm: "yes" }, "confirm");
    expect(stack.store.getPolicy().rules).toEqual([RULE]);
    const s = await ok("POST", "/api/admin/store/reset-saved", { confirm: true });
    expect(s.store.counts).toMatchObject({ rules: 0, delegations: 0, appGrants: 0, signingKeys: 1 });
    expect(stack.auth.grantOf(t.access_token)).toBeDefined();
  });
});

describe("flows and saved policy, over HTTP", () => {
  test("starting a flow mints a scope that starts from the guardians on file, and saved policy is untouched", async () => {
    stack.store.setPolicy({ rules: [RULE], delegations: [DELEGATION] });
    const started = await ok("POST", "/api/flows/patient-sites/start");
    expect(started.scope.base).toBe(`/s/${started.scope.id}`);
    expect(started.policy.rules).toEqual([]);
    expect(started.policy.delegations).toEqual([]);
    expect(started.policy.guardians).toEqual(stack.store.guardians());
    expect((await ok("GET", "/api/policy")).rules).toEqual([RULE]);
    expect((await ok("GET", `${started.scope.base}/api/policy`)).rules).toEqual([]);
    const again = await ok("POST", "/api/flows/patient-sites/start");
    expect(again.scope.id).not.toBe(started.scope.id);
  });
  test("a flow's steps run in its scope, and a step at the root is refused", async () => {
    stack.store.setPolicy({ rules: [RULE] });
    const { scope } = await ok("POST", "/api/flows/patient-sites/start");
    expect((await call("POST", "/api/flows/patient-sites/steps/consent", { inputs: { mode: "scripted" } })).status).toBe(409);
    const r = await ok("POST", `${scope.base}/api/flows/patient-sites/steps/consent`, { inputs: { mode: "scripted", sites: ["Lakeside Imaging"] } });
    expect(r.scope).toEqual(scope);
    expect(r.policy.appGrants.length).toBe(1);
    expect(stack.scopes.resolve(scope.id)).toMatchObject({ world: { scope: scope.id } });
    expect(stack.store.getPolicy().appGrants).toEqual([]);
    expect(stack.store.getPolicy().rules).toEqual([RULE]);
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
    expect(await (await call("GET", `${scope.base}/`)).text()).toContain('src="/app.js"');
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

describe("delegations and app grants", () => {
  test("delete removes a row from the active store, and 404s when there's none", async () => {
    stack.store.setPolicy({ delegations: [DELEGATION, { ...DELEGATION, delegate: "alex-neighbor" }], appGrants: [GRANT] });
    const q = new URLSearchParams({ patient: "josh-example", delegate: "sam-caregiver" });
    expect((await ok("DELETE", `/api/admin/delegations?${q}`)).policy.delegations.map((d: any) => d.delegate)).toEqual(["alex-neighbor"]);
    expect((await call("DELETE", `/api/admin/delegations?${q}`)).status).toBe(404);
    const g = new URLSearchParams(GRANT);
    expect((await ok("DELETE", `/api/admin/app-grants?${g}`)).policy.appGrants).toEqual([]);
    expect((await call("DELETE", `/api/admin/app-grants?${g}`)).status).toBe(404);
  });
  test("delete without its identifying fields gets a 400", async () => {
    expect((await call("DELETE", "/api/admin/delegations?patient=x")).status).toBe(400);
    expect((await call("DELETE", "/api/admin/app-grants?client=x&user=y")).status).toBe(400);
  });
});

describe("rule sets", () => {
  const applied = (s: any) => s.policy.rules.map((r: any) => r.id);
  test("the status offers every named set, and names the one in effect", async () => {
    const s = await ok("GET", "/api/admin/status");
    expect(s.ruleSets.current).toBe("no-extra-rules");
    expect(s.ruleSets.choices.map((c: any) => c.id)).toEqual(["no-extra-rules", "hand-wrist-referral", "outside-release", "research-donation", "all-three-services"]);
    for (const c of s.ruleSets.choices) { expect(c.label).toBeTruthy(); expect(c.description).toBeTruthy(); expect(Array.isArray(c.rules)).toBe(true); }
  });
  test("each set applies to saved policy, and is then the one in effect", async () => {
    for (const [id, rules] of [["hand-wrist-referral", ["hand-referral"]], ["outside-release", ["outside-release"]], ["research-donation", ["research-consent"]], ["all-three-services", ["hand-referral", "outside-release", "research-consent"]], ["no-extra-rules", []]] as const) {
      const s = await ok("POST", "/api/admin/rule-set", { id });
      expect(applied(s)).toEqual(rules as any);
      expect(s.ruleSets.current).toBe(id);
      expect(stack.store.rules().map(r => r.id)).toEqual(rules as any);
    }
  });
  test("the outside release set finds its series in the catalog, the way flow 4 does", async () => {
    const { policy } = await ok("POST", "/api/admin/rule-set", { id: "outside-release" });
    const ct = stack.catalog.allStudies().find(s => s.id === "ct-abdomen-pelvis-2012")!;
    const series = stack.catalog.hierarchies([ct.pk]).get(ct.pk)!.series;
    expect(policy.rules[0].withholdSeries.sort()).toEqual(series.filter(x => /Clinical Documents|Dose (Report|Record)/.test(x.description ?? "")).map(x => x.uid).sort());
    expect(policy.rules[0].withholdSeries.length).toBe(3);
  });
  test("the referral set releases the hand and wrist X-rays and nothing else, to that client alone", async () => {
    await ok("POST", "/api/admin/rule-set", { id: "hand-wrist-referral" });
    const e = await stack.explain({ client: "hand-referral-service", patient: "josh-example" });
    expect(e.studies.filter((x: any) => x.release !== "none").map((x: any) => x.id).sort()).toEqual(["xr-hand-right-2012", "xr-hand-wrist-right-2012", "xr-wrist-left-2012"]);
    const other = await stack.explain({ client: "research-donation", patient: "josh-example" });
    expect(other.searchAllowed).toBe(false);
  });
  test("a set the catalog can't resolve gets a 409, and changes nothing", async () => {
    await ok("POST", "/api/admin/rule-set", { id: "research-donation" });
    const real = stack.catalogs.orthanc.allStudies;
    stack.catalogs.orthanc.allStudies = () => [];
    try {
      await ok("POST", "/api/admin/backend", { backend: "orthanc" });
      const r = await call("POST", "/api/admin/rule-set", { id: "outside-release" });
      expect(r.status).toBe(409);
      const s = await ok("GET", "/api/admin/status");
      expect(s.ruleSets.choices.find((c: any) => c.id === "outside-release").rules).toBeNull();
      expect(s.ruleSets.current).toBe("research-donation");
    } finally { stack.catalogs.orthanc.allStudies = real; }
    expect(stack.store.rules().map(r => r.id)).toEqual(["research-consent"]);
  });
  test("rules from elsewhere show as no named set, and a named set can replace them", async () => {
    stack.store.setPolicy({ rules: [RULE] });
    const s = await ok("GET", "/api/admin/status");
    expect(s.ruleSets.current).toBeNull();
    expect(s.policy.rules).toEqual([RULE]);
    expect(applied(await ok("POST", "/api/admin/rule-set", { id: "no-extra-rules" }))).toEqual([]);
  });
  test("a matching rule is the named set, whatever order its fields are in", async () => {
    stack.store.setPolicy({ rules: [{ allow: { all: true }, when: { patient: "josh-example", client: "research-donation" }, description: "Josh's research donation consent", id: "research-consent" }] });
    expect((await ok("GET", "/api/admin/status")).ruleSets.current).toBe("research-donation");
  });
  test("flow 4's own rule, with other series withheld, isn't the named set", async () => {
    const { policy } = await ok("POST", "/api/admin/rule-set", { id: "outside-release" });
    stack.store.setPolicy({ rules: [{ ...policy.rules[0], withholdSeries: policy.rules[0].withholdSeries.slice(0, 1) }] });
    expect((await ok("GET", "/api/admin/status")).ruleSets.current).toBeNull();
  });
  test("the page has no rules editor", async () => {
    const html = await (await call("GET", "/admin")).text();
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain('type="number"');
    expect(html).not.toContain("<input");
    expect(html).not.toContain("JSON");
    expect(await (await call("GET", "/admin.js")).text()).toContain("Custom rules from a flow or older version");
  });
});

describe("settings", () => {
  test("a named value applies, and the token lifetime reaches new tokens", async () => {
    const s = await ok("PUT", "/api/admin/settings", { contextLifetimeSeconds: 60, maxSeriesInContext: 100, tokenLifetimeSeconds: 300, refreshTokenLifetimeSeconds: 86400 });
    expect(s.settings).toEqual({ contextLifetimeSeconds: 60, maxSeriesInContext: 100, tokenLifetimeSeconds: 300, refreshTokenLifetimeSeconds: 86400 });
    expect(stack.store.getPolicy().contextLifetimeSeconds).toBe(60);
    const t = await scriptedLaunch("josh");
    expect(t.expires_in).toBe(300);
    expect(stack.auth.grantOf(t.access_token)).toBeDefined();
  });
  test("every named value is accepted, and the status lists them", async () => {
    const { settingChoices } = await ok("GET", "/api/admin/status");
    expect(Object.fromEntries(Object.entries(settingChoices).map(([k, v]: any) => [k, v.map((c: any) => c.value)]))).toEqual({ contextLifetimeSeconds: [60, 300, 1800], maxSeriesInContext: [0, 12, 100], tokenLifetimeSeconds: [300, 3600, 86400], refreshTokenLifetimeSeconds: [86400, 604800, 2592000] });
    for (const [k, v] of Object.entries(settingChoices) as any) for (const c of v) expect((await ok("PUT", "/api/admin/settings", { [k]: c.value })).settings[k]).toBe(c.value);
  });
  for (const [name, body, message] of [
    ["a whole number that isn't a choice", { contextLifetimeSeconds: 61 }, "contextLifetimeSeconds must be one of 60, 300, 1800"],
    ["text", { tokenLifetimeSeconds: "3600" }, "tokenLifetimeSeconds must be one of"],
    ["null", { maxSeriesInContext: null }, "maxSeriesInContext must be one of"],
    ["an unknown name", { color: 1 }, "accepts only"],
  ] as const) {
    test(`${name} gets a 400, and changes nothing`, async () => {
      await refused("PUT", "/api/admin/settings", { maxSeriesInContext: 100, ...body }, message);
      expect(stack.store.getSettings().maxSeriesInContext).toBe(12);
    });
  }
  test("an empty request gets a 400", async () => { await refused("PUT", "/api/admin/settings", {}, "at least one"); });
  test("flows keep their own values through the store: the admin route alone is restricted", async () => {
    stack.store.setPolicy({ contextLifetimeSeconds: 7, maxSeriesInContext: 3 });
    const s = await ok("GET", "/api/admin/status");
    expect(s.settings).toMatchObject({ contextLifetimeSeconds: 7, maxSeriesInContext: 3 });
    expect((await ok("PUT", "/api/admin/settings", { contextLifetimeSeconds: 300 })).settings).toMatchObject({ contextLifetimeSeconds: 300, maxSeriesInContext: 3 });
  });
});

describe("clock", () => {
  test("advances and resets", async () => {
    const s = await ok("POST", "/api/admin/clock", { advanceSeconds: 300 });
    expect(s.clock.offsetSeconds).toBe(300);
    expect(now() - Math.floor(Date.now() / 1000)).toBeGreaterThanOrEqual(299);
    expect(s.clockChoices.map((c: any) => c.value)).toEqual([60, 300, 3600, 86400]);
    expect((await ok("POST", "/api/admin/clock", { reset: true })).clock.offsetSeconds).toBe(0);
  });
  test("rejects anything else", async () => {
    for (const body of [{}, { advanceSeconds: -5 }, { advanceSeconds: 1.5 }, { advanceSeconds: "60" }, { advanceSeconds: 1e12 }, { advanceSeconds: 600 }, { reset: false }, { advanceSeconds: 60, reset: false }]) await refused("POST", "/api/admin/clock", body, "advanceSeconds");
  });
});

describe("backend", () => {
  test("selects a known backend, and reports self-tests", async () => {
    expect((await ok("POST", "/api/admin/backend", { backend: "s3" })).backend.current).toBe("s3");
    await refused("POST", "/api/admin/backend", { backend: "floppy" }, "backend must be");
    stack.setBackend("static-files");
    const r = await ok("GET", "/api/admin/backends");
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

describe("outage", () => {
  test("injecting an outage fails decisions, and clearing it restores them", async () => {
    expect((await ok("POST", "/api/admin/outage", { on: true })).outage).toBe(true);
    await refused("POST", "/api/admin/outage", { on: "yes" }, "on must be");
    const t = await scriptedLaunch("josh");
    const uid = stack.catalog.allStudies()[0]!.uid;
    const get = () => fetch(`${CONFIG.proxyUrl}/wado/-/studies/${uid}`, { headers: { Authorization: `Bearer ${t.access_token}`, Accept: "multipart/related; type=application/dicom; transfer-syntax=*" } });
    const during = await get();
    await during.body?.cancel();
    expect(during.status).toBe(503);
    expect((await ok("POST", "/api/admin/outage", { on: false })).outage).toBe(false);
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
    const s = await ok("POST", "/api/admin/tokens/revoke-all");
    expect(s.store.counts.liveAccessTokens).toBe(0);
    expect((await search()).status).toBe(401);
    const refreshed = await fetch(stack.auth.tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: "portal-app" }).toString() });
    expect(refreshed.status).toBe(400);
    expect(scope.store.getToken(inScope.access_token, "access")!.revoked).toBe(false);
  });
});

describe("/api/policy", () => {
  test("a PUT at the root is refused with a 409, and changes nothing", async () => {
    stack.store.setPolicy({ rules: [RULE] });
    const r = await call("PUT", "/api/policy", { rules: [] });
    expect(r.status).toBe(409);
    expect((await r.json() as any).error).toContain("only a flow's own scope");
    expect((await call("PUT", "/api/policy", "{not json")).status).toBe(409);
    expect(stack.store.rules()).toEqual([RULE]);
    expect(await ok("GET", "/api/policy")).toMatchObject({ rules: [RULE] });
  });
  test("a PUT changes its scope, and leaves saved policy and other scopes alone", async () => {
    stack.store.setPolicy({ rules: [RULE] });
    const base = await mint(), other = await mint();
    const changed = { ...RULE, id: "scope-rule" };
    expect((await ok("PUT", `${base}/api/policy`, { rules: [changed] })).rules).toEqual([changed]);
    expect((await ok("GET", `${base}/api/policy`)).rules).toEqual([changed]);
    expect((await ok("GET", `${other}/api/policy`)).rules).toEqual([]);
    expect(stack.store.rules()).toEqual([RULE]);
  });
  test("a bad PUT gets a 400, and doesn't corrupt the policy", async () => {
    const base = await mint();
    await ok("PUT", `${base}/api/policy`, { rules: [RULE] });
    const cases: [unknown, string][] = [
      ["{not json", "valid JSON"],
      [[RULE], "JSON object"],
      [{ rules: "x" }, "rules must be an array"],
      [{ rules: [{ id: "a" }] }, "rules[0].when"],
      [{ rules: [], contextLifetimeSeconds: "soon" }, "contextLifetimeSeconds"],
      [{ rules: [], delegations: [{ patient: "p" }] }, "delegations[0]"],
      [{ rules: [], whatever: 1 }, 'unknown field "whatever"'],
    ];
    for (const [body, message] of cases) await refused("PUT", `${base}/api/policy`, body, message);
    expect((await ok("GET", `${base}/api/policy`)).rules).toEqual([RULE]);
    // Search in that scope keeps working on what's there.
    const world = (stack.scopes.resolve(base.slice(3)) as any).world;
    const t = await scriptedLaunch("josh", "portal-app", { at: world.urls });
    expect((await fetch(`${world.urls.imaging}/fhir/ImagingStudy?patient=josh-example`, { headers: { Authorization: `Bearer ${t.access_token}` } })).status).toBe(200);
  });
  test("what GET returns can be sent back by PUT", async () => {
    const base = await mint();
    await ok("PUT", `${base}/api/policy`, { rules: [RULE], delegations: [DELEGATION], appGrants: [GRANT] });
    const p = await ok("GET", `${base}/api/policy`);
    expect(await ok("PUT", `${base}/api/policy`, p)).toEqual(p);
  });
});

describe("writes from another web origin", () => {
  test("are refused, and same-origin writes are not", async () => {
    const evil = { origin: "https://evil.example" };
    expect((await call("POST", "/api/admin/store/reset-saved", { confirm: true }, evil)).status).toBe(403);
    expect((await call("PUT", "/api/policy", { rules: [] }, evil)).status).toBe(403);
    expect((await call("POST", "/api/admin/store/reset-saved", { confirm: true }, { origin: CONFIG.demoUrl })).status).toBe(200);
  });
});

describe("writes naming another Host, over real HTTP", () => {
  let server: ReturnType<typeof Bun.serve>;
  beforeAll(() => { server = Bun.serve({ port: PORTS.demo, hostname: "127.0.0.1", fetch: demo.fetch }); });
  afterAll(() => server.stop(true));
  const send = (path: string, host: string | undefined, init: RequestInit = { method: "POST", body: "{}" }) => fetch(`http://127.0.0.1:${PORTS.demo}${path}`, { ...init, headers: { "content-type": "application/json", ...(host ? { host } : {}) } });

  test("are refused with a 403 and change nothing", async () => {
    stack.store.setPolicy({ rules: [RULE] });
    for (const host of ["evil.example", `evil.example:${PORTS.demo}`, "127.0.0.1", `127.0.0.1:${PORTS.demo + 1}`, `127.0.0.1.evil.example:${PORTS.demo}`, `10.0.0.5:${PORTS.demo}`]) {
      expect((await send("/api/admin/store/reset-saved", host, { method: "POST", body: JSON.stringify({ confirm: true }) })).status).toBe(403);
      expect((await send("/api/scopes", host)).status).toBe(403);
      expect((await send("/api/admin/signing-key/rotate", host)).status).toBe(403);
      expect((await send("/api/policy", host, { method: "PUT", body: JSON.stringify({ rules: [] }) })).status).toBe(403);
    }
    expect(stack.store.rules()).toEqual([RULE]);
  });
  test("this server's own address and port are accepted, with or without naming it", async () => {
    const base = await mint();
    expect((await send(`${base}/api/policy`, undefined, { method: "PUT", body: JSON.stringify({ maxSeriesInContext: 7 }) })).status).toBe(200);
    expect((await send(`${base}/api/policy`, `localhost:${PORTS.demo}`, { method: "PUT", body: JSON.stringify({ maxSeriesInContext: 8 }) })).status).toBe(200);
    expect((await ok("GET", `${base}/api/policy`)).maxSeriesInContext).toBe(8);
    expect(stack.store.getPolicy().maxSeriesInContext).toBe(12);
  });
  test("the admin status is refused under another Host too, and answers with no Host named", async () => {
    expect((await send("/api/admin/status", "evil.example", { method: "GET" })).status).toBe(403);
    expect((await send("/api/admin/backends", "evil.example", { method: "GET" })).status).toBe(403);
    expect((await send("/api/admin/status", `localhost:${PORTS.demo}`, { method: "GET" })).status).toBe(200);
    expect((await demo.fetch(new Request(`${CONFIG.demoUrl}/api/admin/status`))).status).toBe(200);
  });
});

describe("loading pages", () => {
  test("nothing a page loads changes saved policy or the flow", async () => {
    const { scope } = await ok("POST", "/api/flows/patient-sites/start");
    await ok("POST", `${scope.base}/api/flows/patient-sites/steps/consent`, { inputs: { mode: "scripted", sites: ["Lakeside Imaging"] } });
    const saved = JSON.stringify(stack.store.getPolicy());
    for (const path of ["/", "/app.js", "/styles.css", "/admin", "/admin.js", "/api/flows", "/api/flow-state", "/api/session", "/api/admin/status", "/api/policy"]) {
      expect((await call("GET", path)).status).toBe(200);
    }
    for (const path of ["/", "/api/flows", "/api/flow-state", "/api/session", "/api/policy"]) expect((await call("GET", `${scope.base}${path}`)).status).toBe(200);
    expect(JSON.stringify(stack.store.getPolicy())).toBe(saved);
    const state = await ok("GET", `${scope.base}/api/flow-state`);
    expect(state.flow).toBe("patient-sites");
    expect(Object.keys(state.completed)).toEqual(["consent"]);
    expect(state.completed.consent.result.checks.every((c: any) => c.ok)).toBe(true);
    expect(state.completed.consent.inputs.sites).toEqual(["Lakeside Imaging"]);
    expect(state.policy.appGrants.length).toBe(1);
    expect(state.scope).toEqual(scope);
  });
  test("the home page script sends nothing on load except reads", async () => {
    const js = await (await call("GET", "/app.js")).text();
    const init = js.slice(js.indexOf("async function init()"), js.indexOf("function showBackend"));
    expect(init.slice(0, init.indexOf("sel.onchange"))).not.toContain("post(");
    expect(js).not.toContain("store/activate");
    expect(await (await call("GET", "/")).text()).not.toContain("Back to saved policy");
  });
  test("a flow carries on from its scope after the root was used", async () => {
    const { scope } = await ok("POST", "/api/flows/patient-sites/start");
    await ok("POST", `${scope.base}/api/flows/patient-sites/steps/consent`, { inputs: { mode: "scripted", sites: ["Lakeside Imaging"] } });
    await scriptedLaunch("josh");
    await ok("POST", "/api/admin/rule-set", { id: "research-donation" });
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
    expect(state.policy.appGrants[0].sites).toEqual(["Lakeside Imaging"]);
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
