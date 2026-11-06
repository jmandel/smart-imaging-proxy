// The admin API, and the demo server's routes that touch policy. Requests go straight to the
// handler. The stack's saved store is in memory.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { startStack, type Stack } from "../src/stack";
import { registerClients } from "../src/flows";
import { createDemoServer } from "../src/demo-server";
import { scriptedLaunch } from "../src/flows/oauth";
import { now, resetClock } from "../src/clock";
import { CONFIG, PORTS } from "../src/config";
import { SCHEMA_VERSION } from "../src/policy-store";

const root = join(import.meta.dir, "..");
let stack: Stack; let demo: ReturnType<typeof createDemoServer>;
beforeAll(async () => { stack = await startStack(root); demo = createDemoServer(stack, registerClients(stack), root); });
afterAll(() => stack.stop());
beforeEach(() => { stack.useStore("saved"); stack.resetSaved(); stack.imaging.setOutage(false); resetClock(); stack.setBackend("static-files"); });

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
const DELEGATION = { patient: "josh-example", grantedBy: "josh", delegate: "sam-caregiver", relationship: "caregiver", sites: ["Lakeside Imaging"] };
const GRANT = { client: "portal-app", user: "josh", patient: "josh-example" };

describe("pages", () => {
  test("the admin screen and its script are served, and the demo header links to it", async () => {
    const html = await (await call("GET", "/admin")).text();
    expect(html).toContain("no admin authentication");
    expect(html).toContain("127.0.0.1");
    expect(html).toContain('href="/styles.css"');
    expect((await call("GET", "/admin.js")).status).toBe(200);
    expect(await (await call("GET", "/")).text()).toContain('href="/admin"');
  });
});

describe("status", () => {
  test("reports both stores: mode, path, durability, schema version, and row counts", async () => {
    stack.imaging.setPolicy({ rules: [RULE], delegations: [DELEGATION], appGrants: [GRANT] });
    const s = await ok("GET", "/api/admin/status");
    expect(s.store.active).toBe("saved");
    expect(s.store.label).toBe("Saved policy");
    expect(s.store.saved).toMatchObject({ mode: "memory", path: ":memory:", schemaVersion: SCHEMA_VERSION, counts: { delegations: 1, appGrants: 1, rules: 1 } });
    expect(s.store.scratch.mode).toBe("memory");
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

describe("choosing and resetting a store", () => {
  test("activate moves between stores, and rejects anything else", async () => {
    expect((await ok("POST", "/api/admin/store/activate", { store: "scratch" })).store.label).toBe("Flow scratch: reset when a flow starts");
    expect((await ok("GET", "/api/store")).active).toBe("scratch");
    expect((await ok("POST", "/api/admin/store/activate", { store: "saved" })).store.label).toBe("Saved policy");
    await refused("POST", "/api/admin/store/activate", { store: "other" }, "store must be");
  });
  test("reset scratch leaves saved alone", async () => {
    stack.stores.saved.setPolicy({ rules: [RULE] });
    stack.stores.scratch.setPolicy({ rules: [{ ...RULE, id: "scratch-rule" }] });
    const s = await ok("POST", "/api/admin/store/reset-scratch");
    expect(s.store.scratch.counts.rules).toBe(0);
    expect(s.store.saved.counts.rules).toBe(1);
  });
  test("reset saved needs confirmation, and leaves tokens and the signing key", async () => {
    stack.stores.saved.setPolicy({ rules: [RULE], delegations: [DELEGATION] });
    const t = await scriptedLaunch("josh");
    await refused("POST", "/api/admin/store/reset-saved", {}, "confirm");
    await refused("POST", "/api/admin/store/reset-saved", { confirm: "yes" }, "confirm");
    expect(stack.stores.saved.getPolicy().rules).toEqual([RULE]);
    const s = await ok("POST", "/api/admin/store/reset-saved", { confirm: true });
    expect(s.store.saved.counts).toMatchObject({ rules: 0, delegations: 0, appGrants: 0, signingKeys: 1 });
    expect(stack.auth.grantOf(t.access_token)).toBeDefined();
  });
});

describe("flows and the saved store, over HTTP", () => {
  test("starting a flow activates scratch, saved is untouched, and the explicit control brings it back", async () => {
    stack.stores.saved.setPolicy({ rules: [RULE], delegations: [DELEGATION] });
    const started = await ok("POST", "/api/flows/patient-sites/start");
    expect(started.store).toEqual({ active: "scratch", label: "Flow scratch: reset when a flow starts" });
    expect(started.policy.rules).toEqual([]);
    const back = await ok("POST", "/api/admin/store/activate", { store: "saved" });
    expect(back.policy.rules).toEqual([RULE]);
    expect(back.policy.delegations).toEqual([DELEGATION]);
  });
  test("a flow step always runs on scratch, even after the saved store was reactivated", async () => {
    stack.stores.saved.setPolicy({ rules: [RULE] });
    await ok("POST", "/api/flows/patient-sites/start");
    await ok("POST", "/api/admin/store/activate", { store: "saved" });
    const r = await ok("POST", "/api/flows/patient-sites/steps/consent", { inputs: { mode: "scripted", sites: ["Lakeside Imaging"] } });
    expect(r.store.active).toBe("scratch");
    expect(r.policy.appGrants.length).toBe(1);
    expect(stack.stores.saved.getPolicy().appGrants).toEqual([]);
    expect(stack.stores.saved.getPolicy().rules).toEqual([RULE]);
  });
});

describe("delegations and app grants", () => {
  test("delete removes a row from the active store, and 404s when there's none", async () => {
    stack.imaging.setPolicy({ delegations: [DELEGATION, { ...DELEGATION, delegate: "alex-neighbor" }], appGrants: [GRANT] });
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

describe("rules", () => {
  test("a valid list is saved", async () => {
    expect((await ok("PUT", "/api/admin/rules", { rules: [RULE] })).policy.rules).toEqual([RULE]);
  });
  test("an invalid list gets a 400 naming every problem, and changes nothing", async () => {
    await ok("PUT", "/api/admin/rules", { rules: [RULE] });
    const b = await refused("PUT", "/api/admin/rules", { rules: [{ id: "a", allow: {} }, { id: "b", when: {} }] }, "rules[0].when");
    expect(b.errors).toEqual(["rules[0].when must be an object", "rules[1].allow must be an object"]);
    await refused("PUT", "/api/admin/rules", { rules: "none" }, "rules must be an array");
    await refused("PUT", "/api/admin/rules", "{not json", "JSON object");
    await refused("PUT", "/api/admin/rules", [RULE], "JSON object");
    expect(stack.imaging.getPolicy().rules).toEqual([RULE]);
  });
});

describe("settings", () => {
  test("valid settings apply, and the token lifetime reaches new tokens", async () => {
    const s = await ok("PUT", "/api/admin/settings", { contextLifetimeSeconds: 60, maxSeriesInContext: 3, tokenLifetimeSeconds: 900, refreshTokenLifetimeSeconds: 5000 });
    expect(s.settings).toEqual({ contextLifetimeSeconds: 60, maxSeriesInContext: 3, tokenLifetimeSeconds: 900, refreshTokenLifetimeSeconds: 5000 });
    expect(stack.imaging.getPolicy().contextLifetimeSeconds).toBe(60);
    const t = await scriptedLaunch("josh");
    expect(t.expires_in).toBe(900);
    expect(stack.auth.grantOf(t.access_token)).toBeDefined();
  });
  for (const [name, body, message] of [
    ["zero lifetime", { contextLifetimeSeconds: 0 }, "contextLifetimeSeconds"],
    ["text", { tokenLifetimeSeconds: "900" }, "tokenLifetimeSeconds"],
    ["null", { maxSeriesInContext: null }, "maxSeriesInContext"],
    ["an unknown name", { color: 1 }, 'unknown field "color"'],
  ] as const) {
    test(`${name} gets a 400, and changes nothing`, async () => {
      await refused("PUT", "/api/admin/settings", { maxSeriesInContext: 3, ...body }, message);
      expect(stack.stores.saved.getSettings().maxSeriesInContext).toBe(12);
    });
  }
});

describe("clock", () => {
  test("advances and resets", async () => {
    const s = await ok("POST", "/api/admin/clock", { advanceSeconds: 600 });
    expect(s.clock.offsetSeconds).toBe(600);
    expect(now() - Math.floor(Date.now() / 1000)).toBeGreaterThanOrEqual(599);
    expect((await ok("POST", "/api/admin/clock", { reset: true })).clock.offsetSeconds).toBe(0);
  });
  test("rejects anything else", async () => {
    for (const body of [{}, { advanceSeconds: -5 }, { advanceSeconds: 1.5 }, { advanceSeconds: "60" }, { advanceSeconds: 1e12 }]) await refused("POST", "/api/admin/clock", body, "advanceSeconds");
  });
});

describe("backend", () => {
  test("selects a known backend, and reports self-tests", async () => {
    expect((await ok("POST", "/api/admin/backend", { backend: "minio" })).backend.current).toBe("minio");
    await refused("POST", "/api/admin/backend", { backend: "floppy" }, "backend must be");
    stack.setBackend("static-files");
    const r = await ok("GET", "/api/admin/backends");
    expect(r.backends.map((b: any) => b.name)).toEqual(["static-files", "minio", "orthanc"]);
    expect(r.backends[0].ok).toBe(true);
  });
  test("the flow player's selector rejects bad input", async () => {
    expect((await call("POST", "/api/backend", "{nope")).status).toBe(400);
    expect((await call("POST", "/api/backend", { backend: "floppy" })).status).toBe(400);
  });
});

describe("outage", () => {
  test("injecting an outage fails decisions, and clearing it restores them", async () => {
    expect((await ok("POST", "/api/admin/outage", { on: true })).outage).toBe(true);
    await refused("POST", "/api/admin/outage", { on: "yes" }, "on must be");
    const t = await scriptedLaunch("josh");
    const uid = stack.manifest.studies[0].uid;
    const get = () => fetch(`${CONFIG.proxyUrl}/wado/-/studies/${uid}`, { headers: { Authorization: `Bearer ${t.access_token}`, Accept: "multipart/related; type=application/dicom; transfer-syntax=*" } });
    const during = await get();
    await during.body?.cancel();
    expect(during.status).toBe(503);
    expect((await ok("POST", "/api/admin/outage", { on: false })).outage).toBe(false);
  });
});

describe("tokens", () => {
  test("revoke all ends access and refresh tokens in the active store only", async () => {
    stack.resetAll();
    const scratch = await scriptedLaunch("josh");
    stack.useStore("saved");
    const t = await scriptedLaunch("josh");
    const search = () => fetch(`${CONFIG.imagingUrl}/fhir/ImagingStudy?patient=josh-example`, { headers: { Authorization: `Bearer ${t.access_token}` } });
    expect((await search()).status).toBe(200);
    const s = await ok("POST", "/api/admin/tokens/revoke-all");
    expect(s.store.saved.counts.liveAccessTokens).toBe(0);
    expect((await search()).status).toBe(401);
    const refreshed = await fetch(stack.auth.tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refresh_token }).toString() });
    expect(refreshed.status).toBe(400);
    expect(stack.stores.scratch.getToken(scratch.access_token, "access")!.revoked).toBe(false);
  });
});

describe("/api/policy", () => {
  test("a bad PUT gets a 400, and doesn't corrupt the policy", async () => {
    stack.imaging.setPolicy({ rules: [RULE] });
    const cases: [unknown, string][] = [
      ["{not json", "valid JSON"],
      [[RULE], "JSON object"],
      [{ rules: "x" }, "rules must be an array"],
      [{ rules: [{ id: "a" }] }, "rules[0].when"],
      [{ rules: [], contextLifetimeSeconds: "soon" }, "contextLifetimeSeconds"],
      [{ rules: [], delegations: [{ patient: "p" }] }, "delegations[0]"],
      [{ rules: [], whatever: 1 }, 'unknown field "whatever"'],
    ];
    for (const [body, message] of cases) await refused("PUT", "/api/policy", body, message);
    expect(stack.imaging.getPolicy().rules).toEqual([RULE]);
    // Search keeps working on what's there.
    const t = await scriptedLaunch("josh");
    expect((await fetch(`${CONFIG.imagingUrl}/fhir/ImagingStudy?patient=josh-example`, { headers: { Authorization: `Bearer ${t.access_token}` } })).status).toBe(200);
  });
  test("what GET returns can be sent back by PUT", async () => {
    stack.imaging.setPolicy({ rules: [RULE], delegations: [DELEGATION], appGrants: [GRANT] });
    const p = await ok("GET", "/api/policy");
    expect(await ok("PUT", "/api/policy", p)).toEqual(p);
  });
});

describe("writes from another web origin", () => {
  test("are refused, and same-origin writes are not", async () => {
    const evil = { origin: "https://evil.example" };
    expect((await call("POST", "/api/admin/store/reset-saved", { confirm: true }, evil)).status).toBe(403);
    expect((await call("PUT", "/api/policy", { rules: [] }, evil)).status).toBe(403);
    expect((await call("POST", "/api/admin/store/activate", { store: "saved" }, { origin: CONFIG.demoUrl })).status).toBe(200);
  });
});

describe("writes naming another Host, over real HTTP", () => {
  let server: ReturnType<typeof Bun.serve>;
  beforeAll(() => { server = Bun.serve({ port: PORTS.demo, hostname: "127.0.0.1", fetch: demo.fetch }); });
  afterAll(() => server.stop(true));
  const send = (path: string, host: string | undefined, init: RequestInit = { method: "POST", body: "{}" }) => fetch(`${CONFIG.demoUrl}${path}`, { ...init, headers: { "content-type": "application/json", ...(host ? { host } : {}) } });

  test("are refused with a 403 and change nothing", async () => {
    stack.stores.saved.setPolicy({ rules: [RULE] });
    for (const host of ["evil.example", `evil.example:${PORTS.demo}`, "127.0.0.1", `127.0.0.1:${PORTS.demo + 1}`, `127.0.0.1.evil.example:${PORTS.demo}`, `10.0.0.5:${PORTS.demo}`]) {
      expect((await send("/api/admin/store/reset-scratch", host)).status).toBe(403);
      expect((await send("/api/admin/signing-key/rotate", host)).status).toBe(403);
      expect((await send("/api/policy", host, { method: "PUT", body: JSON.stringify({ rules: [] }) })).status).toBe(403);
    }
    expect(stack.stores.saved.rules()).toEqual([RULE]);
  });
  test("this server's own address and port are accepted, with or without naming it", async () => {
    expect((await send("/api/policy", undefined, { method: "PUT", body: JSON.stringify({ maxSeriesInContext: 7 }) })).status).toBe(200);
    expect((await send("/api/policy", `localhost:${PORTS.demo}`, { method: "PUT", body: JSON.stringify({ maxSeriesInContext: 8 }) })).status).toBe(200);
    expect(stack.imaging.getPolicy().maxSeriesInContext).toBe(8);
  });
  test("reads aren't affected", async () => {
    expect((await send("/api/admin/status", "evil.example", { method: "GET" })).status).toBe(200);
  });
});

describe("loading pages", () => {
  test("nothing a page loads changes the active store or the flow", async () => {
    await ok("POST", "/api/flows/patient-sites/start");
    await ok("POST", "/api/flows/patient-sites/steps/consent", { inputs: { mode: "scripted", sites: ["Lakeside Imaging"] } });
    for (const path of ["/", "/app.js", "/styles.css", "/admin", "/admin.js", "/api/flows", "/api/store", "/api/flow-state", "/api/session", "/api/admin/status", "/api/policy"]) {
      expect((await call("GET", path)).status).toBe(200);
    }
    expect(stack.stores.activeName).toBe("scratch");
    const state = await ok("GET", "/api/flow-state");
    expect(state.flow).toBe("patient-sites");
    expect(Object.keys(state.completed)).toEqual(["consent"]);
    expect(state.completed.consent.result.checks.every((c: any) => c.ok)).toBe(true);
    expect(state.completed.consent.inputs.sites).toEqual(["Lakeside Imaging"]);
    expect(state.policy.appGrants.length).toBe(1);
    expect(state.store.label).toBe("Flow scratch: reset when a flow starts");
  });
  test("the home page script sends nothing on load except reads", async () => {
    const js = await (await call("GET", "/app.js")).text();
    const init = js.slice(js.indexOf("async function init()"), js.indexOf("function showBackend"));
    expect(init).not.toContain("activate");
    expect(init.slice(0, init.indexOf("sel.onchange"))).not.toContain("post(");
    expect(js).toContain("backToSaved");
    expect(await (await call("GET", "/")).text()).toContain("Back to saved policy");
  });
  test("a flow is restored after going back to saved and returning", async () => {
    await ok("POST", "/api/flows/patient-sites/start");
    await ok("POST", "/api/flows/patient-sites/steps/consent", { inputs: { mode: "scripted", sites: ["Lakeside Imaging"] } });
    expect((await ok("POST", "/api/admin/store/activate", { store: "saved" })).store.active).toBe("saved");
    const search = await ok("POST", "/api/flows/patient-sites/steps/search", {});
    expect(search.store.active).toBe("scratch");
    expect(search.result.checks.every((c: any) => c.ok)).toBe(true);
  });
});

describe("a second tab", () => {
  test("can't rerun a finished step, or disturb a flow by running a step of another", async () => {
    await ok("POST", "/api/flows/patient-sites/start");
    await ok("POST", "/api/flows/patient-sites/steps/consent", { inputs: { mode: "scripted", sites: ["Lakeside Imaging"] } });
    expect((await call("POST", "/api/flows/patient-sites/steps/consent", { inputs: {} })).status).toBe(409);
    expect((await call("POST", "/api/flows/caregiver/steps/delegate", { inputs: {} })).status).toBe(409);
    const state = await ok("GET", "/api/flow-state");
    expect(state.flow).toBe("patient-sites");
    expect(state.policy.appGrants[0].sites).toEqual(["Lakeside Imaging"]);
  });
  test("can't start a step while another is running", async () => {
    await ok("POST", "/api/flows/patient-sites/start");
    const first = call("POST", "/api/flows/patient-sites/steps/consent", { inputs: { mode: "scripted", sites: ["Lakeside Imaging"] } });
    const second = await call("POST", "/api/flows/patient-sites/steps/search", {});
    expect(second.status).toBe(409);
    expect((await first).status).toBe(200);
  });
});
