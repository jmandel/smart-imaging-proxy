// Saved policy has to survive a restart, and a flow must never disturb it. Everything here runs
// against memory stores, or a file in its own temporary directory.
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash, sign, verify } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStores, DEFAULT_POLICY_DB, PolicyStore, PolicyValidationError, SCHEMA_VERSION, storeConfigFromEnv, type Delegation, type Rule } from "../src/policy-store";
import { startStack } from "../src/stack";
import { defaultsFor, FLOWS, registerClients, runStep, startFlow } from "../src/flows";
import { accountUrl, scriptedLaunch, submitDelegation } from "../src/flows/oauth";
import { CONFIG } from "../src/config";
import { generateEd25519 } from "../src/jws";
import { resetClock, now, advance } from "../src/clock";
import { boundaryOf, readMultipart } from "../src/multipart";

const root = join(import.meta.dir, "..");
const dirs: string[] = [];
const tempPath = () => { const d = mkdtempSync(join(tmpdir(), "policy-store-test-")); dirs.push(d); return join(d, "nested", "policy.sqlite"); };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); resetClock(); });

const RULE: Rule = { id: "r1", description: "a rule", when: { client: "c1", patient: "josh-example" }, allow: { sites: ["Lakeside Imaging"], since: "2020-01-01" }, withholdSeries: ["1.2.3"], contextForm: "restricted" };
const RULE2: Rule = { id: "r2", when: {}, allow: { all: true }, withdrawn: true };
const DELEGATION: Delegation = { patient: "josh-example", grantedBy: "josh", delegate: "sam-caregiver", relationship: "caregiver", sites: ["Lakeside Imaging"] };
const GRANT = { client: "portal-app", user: "josh", patient: "josh-example", sites: ["Riverside Hospital"] };

describe("durability", () => {
  test("delegations, grants, rules, settings, the signing key, and token records survive close and reopen", () => {
    const path = tempPath();
    const a = new PolicyStore({ mode: "file", path, durability: "full" });
    a.setPolicy({ rules: [RULE, RULE2], delegations: [DELEGATION], appGrants: [GRANT, { client: "viewer", user: "josh", patient: "josh-example" }], contextLifetimeSeconds: 77, maxSeriesInContext: 5 });
    a.setSettings({ tokenLifetimeSeconds: 1234 });
    const key = a.currentSigningKey();
    const signature = sign(null, Buffer.from("hello"), key.privateKey);
    a.putToken("raw-access-token-value", "access", { client_id: "portal-app", scope: "s", patient: "josh-example", sub: "josh" }, 999);
    a.putToken("raw-revoked-token-value", "access", { client_id: "portal-app", scope: "s" }, 999);
    a.revokeToken("raw-revoked-token-value");
    a.putToken("raw-refresh-token-value", "refresh", { client_id: "portal-app", scope: "s", sub: "josh" });
    a.close();

    const b = new PolicyStore({ mode: "file", path, durability: "full" });
    const p = b.getPolicy();
    expect(p.rules).toEqual([RULE, RULE2]);
    expect(p.delegations).toEqual([DELEGATION]);
    expect(p.appGrants).toEqual([GRANT, { client: "viewer", user: "josh", patient: "josh-example" }]);
    expect(p.contextLifetimeSeconds).toBe(77);
    expect(p.maxSeriesInContext).toBe(5);
    expect(b.getSettings().tokenLifetimeSeconds).toBe(1234);
    const again = b.currentSigningKey();
    expect(again.kid).toBe(key.kid);
    expect(verify(null, Buffer.from("hello"), again.publicKey, signature)).toBe(true);
    expect(b.getToken("raw-access-token-value", "access")).toEqual({ client_id: "portal-app", scope: "s", patient: "josh-example", sub: "josh", exp: 999, revoked: false });
    expect(b.getToken("raw-revoked-token-value", "access")!.revoked).toBe(true);
    expect(b.getToken("raw-refresh-token-value", "refresh")).toEqual({ client_id: "portal-app", scope: "s", sub: "josh", revoked: false });
    expect(b.getToken("raw-refresh-token-value", "access")).toBeUndefined();
    b.close();
  });

  test("tokens are keyed by SHA-256, and the raw token reaches no file", () => {
    const path = tempPath();
    const s = new PolicyStore({ mode: "file", path });
    s.putToken("very-secret-raw-token", "access", { client_id: "c", scope: "s" }, 1);
    const row = s.db.query("SELECT hash FROM tokens").get() as any;
    expect(row.hash).toBe(createHash("sha256").update("very-secret-raw-token").digest("base64url"));
    const dir = join(path, "..");
    const bytes = () => readdirSync(dir).map(f => readFileSync(join(dir, f)).toString("latin1")).join("");
    expect(bytes()).toContain(row.hash);
    expect(bytes()).not.toContain("very-secret-raw-token");
    s.close();
    expect(bytes()).not.toContain("very-secret-raw-token");
  });

  test("a file store uses WAL, reports what SQLite reports, and is readable only by its user", () => {
    for (const durability of ["off", "normal", "full"] as const) {
      const path = tempPath();
      const s = new PolicyStore({ mode: "file", path, durability });
      const info = s.info();
      expect(info).toMatchObject({ mode: "file", path, durability, journal: "wal", schemaVersion: SCHEMA_VERSION });
      expect(statSync(path).mode & 0o777).toBe(0o600);
      s.close();
    }
  });

  test("a memory store touches no file", () => {
    const s = new PolicyStore({ mode: "memory", path: join(tmpdir(), "should-not-exist.sqlite") });
    expect(s.info()).toMatchObject({ mode: "memory", path: ":memory:", journal: "memory", schemaVersion: SCHEMA_VERSION });
    expect(existsSync(join(tmpdir(), "should-not-exist.sqlite"))).toBe(false);
    s.close();
  });

  test("a database from newer code is refused, not altered", () => {
    const path = tempPath();
    const s = new PolicyStore({ mode: "file", path });
    s.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    s.close();
    expect(() => new PolicyStore({ mode: "file", path })).toThrow("schema version");
  });

  test("a version 1 database is upgraded in place, with nothing lost", () => {
    const path = tempPath();
    mkdirSync(join(path, ".."), { recursive: true });
    const old = new Database(path, { create: true });
    old.exec(`
      CREATE TABLE delegations (patient TEXT NOT NULL, delegate TEXT NOT NULL, granted_by TEXT NOT NULL, relationship TEXT NOT NULL, sites TEXT NOT NULL, PRIMARY KEY (patient, delegate));
      CREATE TABLE app_grants (client TEXT NOT NULL, user TEXT NOT NULL, patient TEXT NOT NULL, sites TEXT, PRIMARY KEY (client, user, patient));
      CREATE TABLE rules (id TEXT PRIMARY KEY, position INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE signing_keys (kid TEXT PRIMARY KEY, private_key TEXT NOT NULL, public_key TEXT NOT NULL);
      CREATE TABLE tokens (hash TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')), record TEXT NOT NULL, exp INTEGER, revoked INTEGER NOT NULL DEFAULT 0);
      PRAGMA user_version = 1;`);
    const k = generateEd25519("imaging-2026-11");
    old.run("INSERT INTO signing_keys VALUES (?, ?, ?)", [k.kid, k.privateKey.export({ format: "pem", type: "pkcs8" }) as string, k.publicKey.export({ format: "pem", type: "spki" }) as string]);
    old.run("INSERT INTO rules VALUES ('r', 0, ?)", [JSON.stringify(RULE)]);
    old.run("INSERT INTO tokens VALUES (?, 'refresh', ?, NULL, 0)", [createHash("sha256").update("old-refresh").digest("base64url"), JSON.stringify({ client_id: "c", scope: "s" })]);
    old.close();

    const s = new PolicyStore({ mode: "file", path });
    expect(s.info().schemaVersion).toBe(SCHEMA_VERSION);
    expect(s.currentSigningKey().kid).toBe("imaging-2026-11");
    expect(s.rules()).toEqual([RULE]);
    expect(s.getToken("old-refresh", "refresh")!.exp).toBeGreaterThan(Date.now() / 1000 + 29 * 86400);
    s.close();
  });

  test("the configuration comes from the environment, and bad values stop startup", () => {
    expect(storeConfigFromEnv({})).toEqual({ mode: "file", path: DEFAULT_POLICY_DB, durability: "normal" });
    expect(DEFAULT_POLICY_DB).toBe("/tmp/smart-imaging-demo/policy.sqlite");
    expect(storeConfigFromEnv({ POLICY_STORE: "memory", POLICY_DB: "/x", POLICY_DURABILITY: "full" })).toEqual({ mode: "memory", path: "/x", durability: "full" });
    expect(() => storeConfigFromEnv({ POLICY_STORE: "cloud" })).toThrow("POLICY_STORE");
    expect(() => storeConfigFromEnv({ POLICY_DURABILITY: "extra" })).toThrow("POLICY_DURABILITY");
    expect(() => storeConfigFromEnv({ POLICY_DURABILITY: "constructor" })).toThrow("POLICY_DURABILITY");
  });
});

describe("writes", () => {
  const store = () => new PolicyStore({ mode: "memory" });

  test("a failure partway through a write changes nothing", () => {
    const s = store();
    s.setPolicy({ rules: [RULE], delegations: [DELEGATION] });
    s.db.exec("CREATE TRIGGER fail BEFORE INSERT ON app_grants BEGIN SELECT RAISE(ABORT, 'simulated failure'); END");
    expect(() => s.setPolicy({ rules: [RULE2], delegations: [], appGrants: [GRANT], maxSeriesInContext: 99 })).toThrow("simulated failure");
    const p = s.getPolicy();
    expect(p.rules).toEqual([RULE]);
    expect(p.delegations).toEqual([DELEGATION]);
    expect(p.appGrants).toEqual([]);
    expect(p.maxSeriesInContext).toBe(12);
    s.close();
  });

  const INVALID: [string, any, string][] = [
    ["rules isn't a list", { rules: "x" }, "rules must be an array"],
    ["a rule has no when", { rules: [{ id: "a", allow: {} }] }, "rules[0].when must be an object"],
    ["a rule has no allow", { rules: [{ id: "a", when: {} }] }, "rules[0].allow must be an object"],
    ["a rule has no id", { rules: [{ when: {}, allow: {} }] }, "rules[0].id"],
    ["a misspelled allow field", { rules: [{ id: "a", when: {}, allow: { site: ["x"] } }] }, 'rules[0].allow: unknown field "site"'],
    ["sites isn't a list", { rules: [{ id: "a", when: {}, allow: { sites: "x" } }] }, "rules[0].allow.sites"],
    ["a bad date", { rules: [{ id: "a", when: {}, allow: { since: "soon" } }] }, "rules[0].allow.since"],
    ["a bad context form", { rules: [{ id: "a", when: {}, allow: {}, contextForm: "x" }] }, "rules[0].contextForm"],
    ["duplicate rule ids", { rules: [{ id: "a", when: {}, allow: {} }, { id: "a", when: {}, allow: {} }] }, "duplicate id a"],
    ["a delegation with no sites", { delegations: [{ patient: "p", grantedBy: "g", delegate: "d", relationship: "r" }] }, "delegations[0].sites"],
    ["duplicate delegations", { delegations: [DELEGATION, DELEGATION] }, "duplicate"],
    ["a grant with no user", { appGrants: [{ client: "c", patient: "p" }] }, "appGrants[0].user"],
    ["a negative lifetime", { contextLifetimeSeconds: -1 }, "contextLifetimeSeconds"],
    ["a fractional series limit", { maxSeriesInContext: 1.5 }, "maxSeriesInContext"],
    ["a lifetime given as text", { contextLifetimeSeconds: "300" }, "contextLifetimeSeconds"],
    ["an unknown field", { rulez: [] }, 'unknown field "rulez"'],
  ];
  for (const [name, input, message] of INVALID) {
    test(`validation: ${name}`, () => {
      const s = store();
      s.setPolicy({ rules: [RULE] });
      let err: any;
      try { s.setPolicy(input); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(PolicyValidationError);
      expect(err.message).toContain(message);
      expect(s.getPolicy().rules).toEqual([RULE]);
      s.close();
    });
  }

  test("an update that would make a rule invalid is refused", () => {
    const s = store();
    s.setPolicy({ rules: [RULE] });
    expect(() => s.updateRule("r1", { allow: "everything" as any })).toThrow(PolicyValidationError);
    s.updateRule("r1", { withdrawn: true });
    expect(s.rules()[0]!.withdrawn).toBe(true);
    s.updateRule("no-such-rule", { withdrawn: true });
    expect(s.rules().length).toBe(1);
    s.close();
  });

  test("what getPolicy returns can always be written back", () => {
    const s = store();
    s.setPolicy({ rules: [RULE, RULE2], delegations: [DELEGATION], appGrants: [GRANT] });
    const before = s.getPolicy();
    s.setPolicy(before);
    expect(s.getPolicy()).toEqual(before);
    s.close();
  });
});

describe("saved and scratch", () => {
  test("a store pair starts on saved, and activating doesn't copy anything", () => {
    const stores = createStores({ mode: "memory" });
    stores.saved.setPolicy({ rules: [RULE] });
    expect(stores.activeName).toBe("saved");
    expect(stores.activeLabel).toBe("Saved policy");
    stores.activate("scratch");
    expect(stores.activeLabel).toBe("Flow scratch: reset when a flow starts");
    expect(stores.active.getPolicy().rules).toEqual([]);
    stores.close();
  });

  test("with no configuration, a stack's saved store is in memory", async () => {
    const stack = await startStack(root);
    expect(stack.stores.saved.info().mode).toBe("memory");
    expect(stack.stores.scratch.info().mode).toBe("memory");
    stack.stop();
  });

  test("starting and running a flow leaves the saved store untouched", async () => {
    const path = tempPath();
    const stack = await startStack(root, { store: { mode: "file", path, durability: "normal" } });
    try {
      const clients = registerClients(stack);
      expect(stack.stores.activeName).toBe("saved");
      stack.imaging.setPolicy({ rules: [RULE], delegations: [DELEGATION], appGrants: [GRANT], contextLifetimeSeconds: 77 });
      stack.stores.saved.setSettings({ tokenLifetimeSeconds: 111 });
      const savedToken = await scriptedLaunch("josh", "portal-app");
      expect(savedToken.expires_in).toBe(111);
      const dump = () => JSON.stringify({ tables: ["delegations", "app_grants", "rules", "settings", "signing_keys", "tokens"].map(t => stack.stores.saved.db.query(`SELECT * FROM ${t} ORDER BY 1, 2`).all()) });
      const before = dump();

      const flow = FLOWS.find(f => f.id === "caregiver")!;
      const c = await startFlow(stack, clients, flow);
      expect(stack.stores.activeName).toBe("scratch");
      expect(stack.imaging.getPolicy().rules).toEqual([]);
      expect(stack.imaging.getPolicy().delegations).toEqual([]);
      expect(stack.imaging.getPolicy().contextLifetimeSeconds).toBe(300);
      for (const s of flow.steps) {
        const r = await runStep(c, flow, s.id, defaultsFor(c, flow, s.id));
        expect(r.checks.filter(k => !k.ok)).toEqual([]);
      }
      expect(stack.stores.scratch.getPolicy().appGrants.length).toBeGreaterThan(0);
      expect(dump()).toBe(before);

      // A second flow starts from an empty scratch store.
      await startFlow(stack, clients, FLOWS.find(f => f.id === "backend-referral")!);
      expect(stack.stores.scratch.getPolicy().appGrants).toEqual([]);
      expect(stack.stores.scratch.info().counts.accessTokens).toBe(0);
      expect(dump()).toBe(before);

      stack.useStore("saved");
      expect(stack.imaging.getPolicy().rules).toEqual([RULE]);
      expect(stack.imaging.getPolicy().contextLifetimeSeconds).toBe(77);
    } finally { stack.stop(); }
  }, 60000);

  test("a token lives in the store that issued it", async () => {
    const stack = await startStack(root);
    try {
      const introspect = (token: string) => stack.auth.grantOf(token);
      const saved = await scriptedLaunch("josh");
      stack.resetAll();
      expect(introspect(saved.access_token)).toBeUndefined();
      const scratch = await scriptedLaunch("josh");
      stack.useStore("saved");
      expect(introspect(saved.access_token)!.sub).toBe("josh");
      expect(introspect(scratch.access_token)).toBeUndefined();
    } finally { stack.stop(); }
  });

  test("each store keeps its own clock offset", async () => {
    const stack = await startStack(root);
    try {
      const real = () => Math.floor(Date.now() / 1000);
      stack.resetAll();
      advance(4000);
      stack.useStore("saved");
      expect(now()).toBeLessThan(real() + 10);
      stack.useStore("scratch");
      expect(now()).toBeGreaterThanOrEqual(real() + 3990);
      stack.resetAll();
      expect(now()).toBeLessThan(real() + 10);
    } finally { stack.stop(); }
  });
});

describe("a restart", () => {
  test("keeps policy, the live session, its refresh token, and signed URLs working", async () => {
    const path = tempPath();
    const config = { mode: "file" as const, path, durability: "normal" as const };
    const first = await startStack(root, { store: config });
    let token: any, base: string, uid: string, publicKeyBefore: string;
    try {
      await submitDelegation(accountUrl("josh"), { user: "josh", delegate: "sam-caregiver", relationship: "caregiver", sites: ["Lakeside Imaging"] });
      token = await scriptedLaunch("josh", "portal-app", { sites: ["Riverside Hospital"] });
      const bundle: any = await (await fetch(`${CONFIG.imagingUrl}/fhir/ImagingStudy?patient=josh-example&_include=ImagingStudy:endpoint`, { headers: { Authorization: `Bearer ${token.access_token}` } })).json();
      expect(bundle.total).toBe(4);
      const study = bundle.entry.find((e: any) => e.resource.resourceType === "ImagingStudy").resource;
      base = bundle.entry.find((e: any) => e.fullUrl === study.endpoint[0].reference).resource.address;
      uid = study.identifier[0].value.replace("urn:oid:", "");
      publicKeyBefore = JSON.stringify(first.imaging.jwks());
    } finally { first.stop(); }

    const second = await startStack(root, { store: config });
    try {
      expect(second.stores.activeName).toBe("saved");
      expect(JSON.stringify(second.imaging.jwks())).toBe(publicKeyBefore);
      expect(second.imaging.getPolicy().delegations.map(d => d.delegate)).toEqual(["sam-caregiver"]);
      expect(second.imaging.getPolicy().appGrants[0]!.sites).toEqual(["Riverside Hospital"]);

      const search = await fetch(`${CONFIG.imagingUrl}/fhir/ImagingStudy?patient=josh-example`, { headers: { Authorization: `Bearer ${token.access_token}` } });
      expect(search.status).toBe(200);
      expect(((await search.json()) as any).total).toBe(4);

      const r = await fetch(`${base}/studies/${uid}`, { headers: { Authorization: `Bearer ${token.access_token}`, Accept: "multipart/related; type=application/dicom; transfer-syntax=*" } });
      expect(r.status).toBe(200);
      let complete = false;
      for await (const e of readMultipart(r.body as any, boundaryOf(r.headers.get("content-type"))!)) if (e.type === "complete") complete = true;
      expect(complete).toBe(true);
      expect(second.proxy.events[second.proxy.events.length - 1]!.authz).toBe("instant");

      const refreshed = await fetch(second.auth.tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token.refresh_token }).toString() });
      expect(refreshed.status).toBe(200);
      expect(((await refreshed.json()) as any).patient).toBe("josh-example");
    } finally { second.stop(); }
  }, 60000);
});

describe("token lifecycle", () => {
  const refresh = (url: string, token: string) => fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token }).toString() });

  test("refresh tokens last 30 days by default, and an expired one gets invalid_grant", async () => {
    const stack = await startStack(root);
    try {
      const t = await scriptedLaunch("josh");
      const record = stack.stores.active.getToken(t.refresh_token, "refresh")!;
      expect(record.exp! - now()).toBeGreaterThan(30 * 86400 - 5);
      expect(record.exp! - now()).toBeLessThanOrEqual(30 * 86400);
      advance(30 * 86400 - 60);
      const r = await refresh(stack.auth.tokenUrl, t.refresh_token);
      expect(r.status).toBe(200);
      const next: any = await r.json();
      // Refreshing starts a new period.
      advance(30 * 86400 - 60);
      const again = await refresh(stack.auth.tokenUrl, next.refresh_token);
      expect(again.status).toBe(200);
      const last: any = await again.json();
      advance(30 * 86400 + 1);
      const expired = await refresh(stack.auth.tokenUrl, last.refresh_token);
      expect(expired.status).toBe(400);
      expect(await expired.json()).toEqual({ error: "invalid_grant" });
    } finally { stack.stop(); }
  });

  test("the configured lifetime applies to new refresh tokens", async () => {
    const stack = await startStack(root);
    try {
      stack.stores.active.setSettings({ refreshTokenLifetimeSeconds: 100 });
      const t = await scriptedLaunch("josh");
      advance(101);
      expect((await refresh(stack.auth.tokenUrl, t.refresh_token)).status).toBe(400);
    } finally { stack.stop(); }
  });

  test("purging removes expired access and refresh tokens, by the store's clock, and leaves the rest", async () => {
    const stack = await startStack(root);
    try {
      stack.stores.active.setSettings({ tokenLifetimeSeconds: 100, refreshTokenLifetimeSeconds: 200 });
      const t = await scriptedLaunch("josh");
      const { active } = stack.stores;
      advance(50);
      expect(stack.purgeTokens()).toBe(0);
      advance(51);
      expect(stack.purgeTokens()).toBe(1);
      expect(active.getToken(t.access_token, "access")).toBeUndefined();
      expect(active.getToken(t.refresh_token, "refresh")).toBeDefined();
      advance(100);
      expect(stack.purgeTokens()).toBe(1);
      expect(active.getToken(t.refresh_token, "refresh")).toBeUndefined();
      // Moving the clock back can't bring a purged token back.
      resetClock();
      expect(stack.auth.grantOf(t.access_token)).toBeUndefined();
    } finally { stack.stop(); }
  });

  test("a store's tokens expire by its own clock while the other is active", async () => {
    const stack = await startStack(root);
    try {
      const saved = await scriptedLaunch("josh");
      stack.resetAll();
      advance(100000);
      stack.purgeTokens();
      expect(stack.stores.saved.getToken(saved.access_token, "access")).toBeDefined();
    } finally { stack.stop(); }
  });

  test("purging runs periodically while the stack runs", async () => {
    const stack = await startStack(root, { purgeIntervalMs: 20 });
    try {
      stack.stores.active.setSettings({ tokenLifetimeSeconds: 100, refreshTokenLifetimeSeconds: 100 });
      const t = await scriptedLaunch("josh");
      await Bun.sleep(60);
      expect(stack.stores.active.getToken(t.access_token, "access")).toBeDefined();
      advance(101);
      await Bun.sleep(80);
      expect(stack.stores.active.getToken(t.access_token, "access")).toBeUndefined();
      expect(stack.stores.active.getToken(t.refresh_token, "refresh")).toBeUndefined();
    } finally { stack.stop(); }
  });

  test("purging runs at startup", async () => {
    const path = tempPath();
    const config = { mode: "file" as const, path };
    const s = new PolicyStore(config);
    const past = Math.floor(Date.now() / 1000) - 10;
    s.putToken("old-access", "access", { client_id: "c", scope: "s" }, past);
    s.putToken("old-refresh", "refresh", { client_id: "c", scope: "s" }, past);
    s.putToken("live-refresh", "refresh", { client_id: "c", scope: "s" }, past + 10000);
    s.close();
    const stack = await startStack(root, { store: config });
    try {
      expect(stack.stores.saved.getToken("old-access", "access")).toBeUndefined();
      expect(stack.stores.saved.getToken("old-refresh", "refresh")).toBeUndefined();
      expect(stack.stores.saved.getToken("live-refresh", "refresh")).toBeDefined();
    } finally { stack.stop(); }
  });
});
