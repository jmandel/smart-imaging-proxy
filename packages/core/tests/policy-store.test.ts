// The policy store has to keep what it's given across close and reopen, and a write is all or none.
// Everything here runs against memory stores, or a file in its own temporary directory.
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash, sign, verify } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Delegation, generateEd25519, PolicyStore, PolicyValidationError, type Rule, SCHEMA_VERSION } from "../src";
const dirs: string[] = [];
const tempPath = () => { const d = mkdtempSync(join(tmpdir(), "policy-store-test-")); dirs.push(d); return join(d, "nested", "policy.sqlite"); };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

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
