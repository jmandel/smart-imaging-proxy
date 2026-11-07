// The policy store has to keep what it's given across close and reopen, and a write is all or none.
// Everything here runs against memory stores, or a file in its own temporary directory.
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash, sign, verify } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppApproval, generateEd25519, type OrgPolicy, PolicyStore, PolicyValidationError, type Relationship, SCHEMA_VERSION, type Share } from "../src";
const dirs: string[] = [];
const tempPath = () => { const d = mkdtempSync(join(tmpdir(), "policy-store-test-")); dirs.push(d); return join(d, "nested", "policy.sqlite"); };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const SERVICE: OrgPolicy = { id: "r1", type: "service-access", description: "a policy", service: "service:c1", patients: "patient:josh-example", allow: { sites: ["Lakeside Imaging"], since: "2020-01-01" }, withholdSeries: ["1.2.3"], contextForm: "restricted" };
const SERVICE2: OrgPolicy = { id: "r2", type: "service-access", service: "service:c2", patients: "any", allow: { all: true }, withdrawn: true };
const GUARDIANS: OrgPolicy = { id: "teen-guardians", type: "guardian-access", when: { age: { min: 13, max: 17 } }, allow: "all", except: ["confidential-adolescent"] };
const SHARING: OrgPolicy = { id: "sharing", type: "sharing", allowedFrom: ["patient", "guardian"] };
const GUARDIAN: Relationship = { subject: "user:sam", relation: "guardian_of", object: "patient:riley", recordedBy: "registration" };
const SHARE: Share = { from: "user:josh", with: "user:sam", patient: "patient:josh-example", sites: ["Lakeside Imaging"], label: "caregiver" };
const APPROVAL: AppApproval = { by: "user:josh", app: "app:portal-app", patient: "patient:josh-example", sites: ["Riverside Hospital"] };
const ON_FILE = { relationships: [GUARDIAN], policies: [GUARDIANS, SHARING] };

describe("durability", () => {
  test("facts, policies, choices, settings, revisions, the signing key, and token records survive close and reopen", () => {
    const path = tempPath();
    const a = new PolicyStore({ mode: "file", path, durability: "full", onFile: ON_FILE });
    a.setDocument({ policies: [GUARDIANS, SHARING, SERVICE, SERVICE2], shares: [SHARE], approvals: [APPROVAL, { by: "user:josh", app: "app:viewer", patient: "patient:josh-example" }] });
    a.setSettings({ tokenLifetimeSeconds: 1234, contextLifetimeSeconds: 77, maxSeriesInContext: 5 });
    const revision = a.revision("patient:josh-example");
    const key = a.currentSigningKey();
    const signature = sign(null, Buffer.from("hello"), key.privateKey);
    a.putToken("raw-access-token-value", "access", { client_id: "portal-app", scope: "s", patient: "josh-example", sub: "josh" }, 999);
    a.putToken("raw-revoked-token-value", "access", { client_id: "portal-app", scope: "s" }, 999);
    a.revokeToken("raw-revoked-token-value");
    a.putToken("raw-refresh-token-value", "refresh", { client_id: "portal-app", scope: "s", sub: "josh" });
    a.close();

    const b = new PolicyStore({ mode: "file", path, durability: "full", onFile: ON_FILE });
    const p = b.snapshot();
    expect(p.relationships).toEqual([GUARDIAN]);
    expect(p.policies).toEqual([GUARDIANS, SHARING, SERVICE, SERVICE2]);
    expect(p.shares).toEqual([SHARE]);
    expect(p.approvals).toEqual([APPROVAL, { by: "user:josh", app: "app:viewer", patient: "patient:josh-example" }]);
    expect(b.getSettings()).toMatchObject({ tokenLifetimeSeconds: 1234, contextLifetimeSeconds: 77, maxSeriesInContext: 5 });
    expect(b.revision("patient:josh-example")).toEqual(revision);
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

  test("a version 1 database is upgraded in place: tokens and keys kept, rules for a client become service-access policies", () => {
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
    old.run("INSERT INTO rules VALUES ('r', 0, ?)", [JSON.stringify({ id: "r1", description: "a policy", when: { client: "c1", patient: "josh-example" }, allow: { sites: ["Lakeside Imaging"], since: "2020-01-01" }, withholdSeries: ["1.2.3"], contextForm: "restricted" })]);
    old.run("INSERT INTO delegations VALUES ('josh-example', 'sam', 'josh', 'caregiver', ?)", [JSON.stringify(["Lakeside Imaging"])]);
    old.run("INSERT INTO tokens VALUES (?, 'refresh', ?, NULL, 0)", [createHash("sha256").update("old-refresh").digest("base64url"), JSON.stringify({ client_id: "c", scope: "s" })]);
    old.close();

    const s = new PolicyStore({ mode: "file", path, onFile: ON_FILE });
    expect(s.info().schemaVersion).toBe(SCHEMA_VERSION);
    expect(s.currentSigningKey().kid).toBe("imaging-2026-11");
    expect(s.policies()).toEqual([SERVICE, GUARDIANS, SHARING]);
    expect(s.shares()).toEqual([SHARE]);
    expect(s.relationships()).toEqual([GUARDIAN]);
    expect(s.getToken("old-refresh", "refresh")!.exp).toBeGreaterThan(Date.now() / 1000 + 29 * 86400);
    s.close();
  });
});

describe("writes", () => {
  const store = () => new PolicyStore({ mode: "memory", onFile: ON_FILE });

  test("a failure partway through a write changes nothing, and raises no revision", () => {
    const s = store();
    s.setDocument({ policies: [GUARDIANS, SHARING, SERVICE], shares: [SHARE] });
    const before = s.revision("patient:josh-example");
    s.db.exec("CREATE TRIGGER fail BEFORE INSERT ON approvals BEGIN SELECT RAISE(ABORT, 'simulated failure'); END");
    expect(() => s.setDocument({ policies: [SERVICE2], shares: [], approvals: [APPROVAL] })).toThrow("simulated failure");
    const p = s.snapshot();
    expect(p.policies).toEqual([GUARDIANS, SHARING, SERVICE]);
    expect(p.shares).toEqual([SHARE]);
    expect(p.approvals).toEqual([]);
    expect(s.revision("patient:josh-example")).toEqual(before);
    s.close();
  });

  const INVALID: [string, any, string][] = [
    ["policies isn't a list", { policies: "x" }, "policies must be an array"],
    ["an unknown type", { policies: [{ id: "a", type: "anything" }] }, "policies[0].type must be one of guardian-access, sharing, service-access"],
    ["a service policy with no service", { policies: [{ id: "a", type: "service-access", patients: "any", allow: {} }] }, "policies[0].service"],
    ["a service policy with no allow", { policies: [{ id: "a", type: "service-access", service: "service:x", patients: "any" }] }, "policies[0].allow must be an object"],
    ["a service policy for a bare patient id", { policies: [{ id: "a", type: "service-access", service: "service:x", patients: "josh", allow: {} }] }, "policies[0].patients"],
    ["a misspelled allow field", { policies: [{ id: "a", type: "service-access", service: "service:x", patients: "any", allow: { site: ["x"] } }] }, 'policies[0].allow: unknown field "site"'],
    ["a bad date", { policies: [{ id: "a", type: "service-access", service: "service:x", patients: "any", allow: { since: "soon" } }] }, "policies[0].allow.since"],
    ["a bad context form", { policies: [{ id: "a", type: "service-access", service: "service:x", patients: "any", allow: {}, contextForm: "x" }] }, "policies[0].contextForm"],
    ["a guardian policy with no age band", { policies: [{ id: "a", type: "guardian-access", allow: "all" }] }, "policies[0].when.age"],
    ["an age band upside down", { policies: [{ id: "a", type: "guardian-access", when: { age: { min: 18, max: 13 } }, allow: "all" }] }, "min is more than max"],
    ["a guardian policy that allows less than all", { policies: [{ id: "a", type: "guardian-access", when: { age: {} }, allow: "some" }] }, 'policies[0].allow must be "all"'],
    ["sharing from nobody", { policies: [{ id: "a", type: "sharing", allowedFrom: [] }] }, "policies[0].allowedFrom"],
    ["duplicate policy ids", { policies: [SHARING, SHARING] }, "duplicate id sharing"],
    ["a relationship with a bare subject", { relationships: [{ subject: "sam", relation: "guardian_of", object: "patient:riley" }] }, "relationships[0].subject"],
    ["a share with no sites", { shares: [{ from: "user:a", with: "user:b", patient: "patient:p", label: "x" }] }, "shares[0].sites"],
    ["a share from a patient ref", { shares: [{ ...SHARE, from: "patient:josh-example" }] }, "shares[0].from must be a reference, user:id"],
    ["duplicate shares", { shares: [SHARE, SHARE] }, "duplicate"],
    ["an approval with no app", { approvals: [{ by: "user:a", patient: "patient:p" }] }, "approvals[0].app"],
    ["an unknown field", { rulez: [] }, 'unknown field "rulez"'],
  ];
  for (const [name, input, message] of INVALID) {
    test(`validation: ${name}`, () => {
      const s = store();
      s.putPolicy(SERVICE);
      const before = s.revision();
      let err: any;
      try { s.setDocument(input); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(PolicyValidationError);
      expect(err.message).toContain(message);
      expect(s.policies()).toEqual([GUARDIANS, SHARING, SERVICE]);
      expect(s.revision()).toEqual(before);
      s.close();
    });
  }

  test("a policy put replaces the one with its id in place, and an invalid one is refused", () => {
    const s = store();
    s.putPolicy(SERVICE);
    expect(() => s.putPolicy({ ...SERVICE, allow: "everything" as any })).toThrow(PolicyValidationError);
    s.putPolicy({ ...SERVICE, withdrawn: true } as OrgPolicy);
    expect(s.policies().map(p => p.id)).toEqual(["teen-guardians", "sharing", "r1"]);
    expect((s.policies()[2] as any).withdrawn).toBe(true);
    expect(s.removePolicy("no-such-policy")).toBeUndefined();
    s.close();
  });

  test("replacing one type's policies leaves the other types alone", () => {
    const s = store();
    s.replacePolicies("service-access", [SERVICE, SERVICE2]);
    s.replacePolicies("service-access", [SERVICE2]);
    expect(s.policies().map(p => p.id)).toEqual(["teen-guardians", "sharing", "r2"]);
    expect(() => s.replacePolicies("service-access", [SHARING])).toThrow("policies[0].type must be service-access");
    s.close();
  });

  test("what snapshot returns can always be written back", () => {
    const s = store();
    s.setDocument({ policies: [GUARDIANS, SHARING, SERVICE, SERVICE2], shares: [SHARE], approvals: [APPROVAL] });
    const { revision, ...before } = s.snapshot();
    s.setDocument(before);
    const { revision: _r, ...after } = s.snapshot();
    expect(after).toEqual(before);
    s.close();
  });

  test("a reset clears choices and settings, and puts what's on file back", () => {
    const s = store();
    s.setDocument({ relationships: [], policies: [SERVICE], shares: [SHARE], approvals: [APPROVAL] });
    s.setSettings({ maxSeriesInContext: 3 });
    s.putToken("t", "access", { client_id: "c", scope: "s" });
    s.resetPolicy();
    const { revision, ...after } = s.snapshot();
    expect(after).toEqual({ relationships: [GUARDIAN], policies: [GUARDIANS, SHARING], shares: [], approvals: [] });
    expect(s.getSettings().maxSeriesInContext).toBe(12);
    expect(s.getToken("t", "access")).toBeDefined();
    s.resetAll();
    expect(s.getToken("t", "access")).toBeUndefined();
    s.close();
  });
});

describe("revisions", () => {
  const store = () => new PolicyStore({ mode: "memory", onFile: ON_FILE });
  test("a write about one patient raises that patient's revision, and nobody else's", () => {
    const s = store();
    const josh = () => s.patientRevision("patient:josh-example"), riley = () => s.patientRevision("patient:riley");
    const [p0, r0] = [s.policyRevision(), riley()];
    expect(s.putShare(SHARE)).toEqual({ policy: p0, patient: josh() });
    expect(josh()).toBe(1);
    expect(s.putApproval(APPROVAL).patient).toBe(2);
    expect(s.removeShares({ with: "user:sam", patient: "patient:josh-example" })!.patient).toBe(3);
    expect(s.removeApprovals({ by: "user:josh", app: "app:portal-app" })!.patient).toBe(4);
    expect(s.removeShares({ with: "user:nobody" })).toBeUndefined();
    expect(josh()).toBe(4);
    expect(riley()).toBe(r0);
    expect(s.policyRevision()).toBe(p0);
    expect(s.putRelationship({ subject: "user:alex", relation: "guardian_of", object: "patient:riley" }).patient).toBe(r0 + 1);
    expect(josh()).toBe(4);
  });
  test("organization policy and settings raise the policy revision; a reset raises every patient's too", () => {
    const s = store();
    s.putShare(SHARE);
    const p0 = s.policyRevision(), j0 = s.patientRevision("patient:josh-example");
    expect(s.putPolicy(SERVICE)).toEqual({ policy: p0 + 1 });
    expect(s.setSettings({ maxSeriesInContext: 3 }).policy).toBe(p0 + 2);
    expect(s.removePolicy("r1")!.policy).toBe(p0 + 3);
    expect(s.patientRevision("patient:josh-example")).toBe(j0);
    s.resetPolicy();
    expect(s.policyRevision()).toBe(p0 + 4);
    expect(s.patientRevision("patient:josh-example")).toBe(j0 + 1);
    expect(s.patientRevision("patient:riley")).toBeGreaterThan(0);
  });
  test("a patient's snapshot holds only that patient's rows, at its revisions", () => {
    const s = store();
    s.setDocument({ shares: [SHARE, { ...SHARE, patient: "patient:riley", from: "user:sam", with: "user:alex" }], approvals: [APPROVAL] });
    const snap = s.patientSnapshot("patient:josh-example");
    expect(snap.shares).toEqual([SHARE]);
    expect(snap.approvals).toEqual([APPROVAL]);
    expect(snap.relationships).toEqual([]);
    expect(snap.revision).toEqual(s.revision("patient:josh-example"));
    expect(s.patientSnapshot("patient:riley").relationships).toEqual([GUARDIAN]);
  });
  test("organization policy is held in memory, and read again after any write to it, by this store or another", () => {
    const path = tempPath();
    const a = new PolicyStore({ mode: "file", path, onFile: ON_FILE }), b = new PolicyStore({ mode: "file", path, onFile: ON_FILE });
    const first = a.policies();
    expect(a.policies()).toBe(first);
    b.putPolicy(SERVICE);
    expect(a.policies()).not.toBe(first);
    expect(a.policies().map(p => p.id)).toEqual(["teen-guardians", "sharing", "r1"]);
    a.close(); b.close();
  });
});
