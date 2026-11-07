// Durable state: Imaging Server policy in its three levels, its signing key, and the Authorization
// Server's token records. One SQLite database holds all of it, which keeps the configuration in one
// place you can inspect and reset. A write about one patient raises that patient's revision, and an
// organization policy write raises the policy revision. Reads for decisions take one patient's rows,
// by index, and organization policy from memory. Revisions count writes to the store only: a patient's
// age and a study's labels decide access too, so a cache of decisions can't be keyed by revision alone.
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createPrivateKey, createPublicKey, randomBytes, type KeyObject } from "node:crypto";
import { generateEd25519, sha, type KeyPair } from "./jws";
import { bandOverlaps, GUARDIAN_OF, type Ref, validateApproval, validateDocument, validateOrgPolicy, validateRelationship, validateShare, type AppApproval, type OrgPolicy, type PolicyDocument, type Relationship, type Revision, type Share, type Snapshot } from "./policy-model";

export interface Settings { contextLifetimeSeconds: number; maxSeriesInContext: number; tokenLifetimeSeconds: number; refreshTokenLifetimeSeconds: number; }
const REFRESH_DEFAULT = 30 * 86400;
const defaultSettings = (): Settings => ({ contextLifetimeSeconds: 300, maxSeriesInContext: 12, tokenLifetimeSeconds: 3600, refreshTokenLifetimeSeconds: REFRESH_DEFAULT });
const LIMITS: Record<keyof Settings, [number, number]> = { contextLifetimeSeconds: [1, 86400], maxSeriesInContext: [0, 10000], tokenLifetimeSeconds: [1, 2592000], refreshTokenLifetimeSeconds: [1, 31536000] };

export type TokenKind = "access" | "refresh";
/** `family` is shared by every token descended from one refresh token. It isn't derived from any token. */
export interface TokenRecord { client_id: string; scope: string; patient?: string; sub?: string; fhirUser?: string; family?: string; exp?: number; revoked: boolean; }

export const SCHEMA_VERSION = 6;
export type Durability = "off" | "normal" | "full";
const SYNCHRONOUS: Record<Durability, number> = { off: 0, normal: 1, full: 2 };
export const DURABILITIES = Object.keys(SYNCHRONOUS) as Durability[];

/** What's on file: the facts and organization policy a new database starts with, and a reset puts back. No one chose these. */
export interface OnFile { relationships?: Relationship[]; policies?: OrgPolicy[]; }
/** A file store needs `path`. */
export interface StoreConfig { mode: "file" | "memory"; path?: string; durability?: Durability; onFile?: OnFile; }

export class PolicyValidationError extends Error {
  constructor(public errors: string[]) { super(errors.join("; ")); this.name = "PolicyValidationError"; }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export function validateSetting(name: keyof Settings, v: unknown, errors: string[]) {
  const [min, max] = LIMITS[name];
  if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) errors.push(`${name} must be a whole number from ${min} to ${max}`);
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS relationships (subject TEXT NOT NULL, relation TEXT NOT NULL, object TEXT NOT NULL, recorded_by TEXT, PRIMARY KEY (subject, relation, object));
  CREATE INDEX IF NOT EXISTS relationships_by_object ON relationships (object);
  CREATE TABLE IF NOT EXISTS policies (id TEXT PRIMARY KEY, position INTEGER NOT NULL, body TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS shares (patient TEXT NOT NULL, with_user TEXT NOT NULL, from_user TEXT NOT NULL, sites TEXT NOT NULL, label TEXT NOT NULL, PRIMARY KEY (patient, from_user, with_user));
  CREATE INDEX IF NOT EXISTS shares_by_with ON shares (with_user);
  CREATE INDEX IF NOT EXISTS shares_by_from ON shares (from_user);
  CREATE TABLE IF NOT EXISTS approvals (app TEXT NOT NULL, by_user TEXT NOT NULL, patient TEXT NOT NULL, sites TEXT, PRIMARY KEY (app, by_user, patient));
  CREATE INDEX IF NOT EXISTS approvals_by_patient ON approvals (patient);
  CREATE INDEX IF NOT EXISTS approvals_by_user ON approvals (by_user);
  CREATE TABLE IF NOT EXISTS patient_revisions (patient TEXT PRIMARY KEY, revision INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS signing_keys (kid TEXT PRIMARY KEY, private_key TEXT NOT NULL, public_key TEXT NOT NULL, retired INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS tokens (
    hash TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')), record TEXT NOT NULL, exp INTEGER, revoked INTEGER NOT NULL DEFAULT 0);`;
const POLICY_TABLES = ["relationships", "policies", "shares", "approvals", "settings"];

/**
 * Whether a user still has a route to a patient after a revocation, from the patient's rows after it.
 * The policy API passes the Imaging Server's, which knows ages and who each patient is. Without one,
 * another share with them or a guardian relationship counts.
 */
export type StillReaches = (s: Snapshot, user: Ref, patient: Ref) => boolean;
const anyRoute: StillReaches = (s, user, patient) => s.shares.some(x => x.with === user && x.patient === patient) || s.relationships.some(r => r.subject === user && r.relation === GUARDIAN_OF && r.object === patient);

/** Throws PolicyValidationError if any of `items` fails `check`. */
function checked<T>(items: unknown[], at: string, check: (x: unknown, at: string, errors: string[]) => void): T[] {
  const errors: string[] = [];
  items.forEach((x, i) => check(x, items.length === 1 ? at : `${at}[${i}]`, errors));
  if (errors.length) throw new PolicyValidationError(errors);
  return items as T[];
}


export class PolicyStore {
  readonly db: Database;
  readonly mode: "file" | "memory";
  readonly path: string;
  readonly durability: Durability;
  private readonly onFile: Required<OnFile>;

  constructor(config: StoreConfig) {
    if (config.mode === "file" && !config.path) throw new Error("a file policy store needs a path");
    this.mode = config.mode;
    this.path = config.mode === "file" ? config.path! : ":memory:";
    const errors = validateDocument({ relationships: config.onFile?.relationships ?? [], policies: config.onFile?.policies ?? [] });
    if (errors.length) throw new PolicyValidationError(errors);
    this.onFile = structuredClone({ relationships: config.onFile?.relationships ?? [], policies: config.onFile?.policies ?? [] });
    this.durability = config.durability ?? "normal";
    if (config.mode === "file") mkdirSync(dirname(this.path), { recursive: true });
    this.db = new Database(this.path, { create: true });
    // The file holds a private key, so only this user reads it. WAL and SHM files inherit the mode.
    if (config.mode === "file" && existsSync(this.path)) chmodSync(this.path, 0o600);
    this.db.exec("PRAGMA busy_timeout = 2000");
    if (config.mode === "file") this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`PRAGMA synchronous = ${SYNCHRONOUS[this.durability]}`);
    const found = this.schemaVersion();
    if (found !== 0 && found !== SCHEMA_VERSION) {
      this.db.close();
      throw new Error(`The policy store at ${this.path} is in ${found < SCHEMA_VERSION ? "an older" : "a newer"} format (schema ${found}), and this version reads only schema ${SCHEMA_VERSION}. Reset saved policy: delete ${this.path}, or point POLICY_DB at a new file.`);
    }
    if (found === 0) this.tx(() => {
      this.db.exec(SCHEMA);
      this.seedOnFile();
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
  }

  private tx<T>(fn: () => T): T { return this.db.transaction(fn)(); }
  private schemaVersion(): number { return (this.db.query("PRAGMA user_version").get() as any).user_version; }

  private meta(key: string): number { return Number((this.db.query("SELECT value FROM meta WHERE key = ?").get(key) as any)?.value ?? 0); }
  /** The policy revision, which organization policy and settings writes raise. */
  policyRevision(): number { return this.meta("policy"); }
  /** One patient's revision, which every write about that patient raises. */
  patientRevision(patient: string): number { return (this.db.query("SELECT revision FROM patient_revisions WHERE patient = ?").get(patient) as any)?.revision ?? 0; }
  revision(patient?: string): Revision { return { policy: this.policyRevision(), ...(patient ? { patient: this.patientRevision(patient) } : {}) }; }
  private bumpPolicy() { this.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('policy', ?)", [String(this.policyRevision() + 1)]); this.policies.cache = undefined; }
  private bumpPatient(patient: string) { this.db.run("INSERT INTO patient_revisions (patient, revision) VALUES (?, 1) ON CONFLICT (patient) DO UPDATE SET revision = revision + 1", [patient]); }
  /** Every patient with any row of their own, for writes that touch them all. */
  private patientsWithRows(): string[] {
    return (this.db.query("SELECT object AS p FROM relationships WHERE object LIKE 'patient:%' UNION SELECT patient FROM shares UNION SELECT patient FROM approvals UNION SELECT patient FROM patient_revisions").all() as any[]).map(r => r.p);
  }
  /** A write about one patient, in one transaction, returning both revisions. */
  private patientWrite(patient: string, fn: () => boolean | void): Revision | undefined {
    return this.tx(() => { if (fn() === false) return undefined; this.bumpPatient(patient); return this.revision(patient); });
  }
  /** A write that affects everyone: organization policy, settings, or a reset. */
  private policyWrite(fn: () => void, patients: () => string[] = () => []): Revision {
    return this.tx(() => { const before = patients(); fn(); for (const p of new Set([...before, ...patients()])) this.bumpPatient(p); this.bumpPolicy(); return this.revision(); });
  }
  /** The patient a relationship is about: its object, or failing that its subject. */
  private static patientOfRelationship(r: Pick<Relationship, "subject" | "object">) { return r.object.startsWith("patient:") ? r.object : r.subject.startsWith("patient:") ? r.subject : r.object; }

  private seedOnFile() {
    for (const r of this.onFile.relationships) this.putRelationshipRow(r);
    for (const p of this.onFile.policies) this.putPolicyRow(p);
    this.policies.cache = undefined;
  }

  // Level 1

  private relationshipRows(where = "1", ...args: string[]): Relationship[] {
    return (this.db.query(`SELECT subject, relation, object, recorded_by FROM relationships WHERE ${where} ORDER BY rowid`).all(...args) as any[]).map(r => ({ subject: r.subject, relation: r.relation, object: r.object, ...(r.recorded_by ? { recordedBy: r.recorded_by } : {}) }));
  }
  relationships(): Relationship[] { return this.relationshipRows(); }
  private putRelationshipRow(r: Relationship) { this.db.run("INSERT OR REPLACE INTO relationships (subject, relation, object, recorded_by) VALUES (?, ?, ?, ?)", [r.subject, r.relation, r.object, r.recordedBy ?? null]); }
  putRelationship(r: Relationship): Revision { checked([r], "relationship", validateRelationship); return this.patientWrite(PolicyStore.patientOfRelationship(r), () => this.putRelationshipRow(r))!; }
  /**
   * Removes a relationship, and returns the revisions, or undefined if there was none. Removing a guardian
   * relationship removes, in the same write, that guardian's shares for the patient, and what removing
   * those shares removes, and the guardian's own app approvals for the patient unless a route remains.
   */
  removeRelationship(r: Pick<Relationship, "subject" | "relation" | "object">, stillReaches: StillReaches = anyRoute): Revision | undefined {
    return this.patientWrite(PolicyStore.patientOfRelationship(r), () => {
      if (this.db.run("DELETE FROM relationships WHERE subject = ? AND relation = ? AND object = ?", [r.subject, r.relation, r.object]).changes === 0) return false;
      if (r.relation === GUARDIAN_OF) this.cascade([r], [], stillReaches);
    });
  }
  /**
   * What removing grants takes with it: each removed guardian relationship, that guardian's shares for the
   * patient; and for each removed share's recipient, and each removed guardian, their app approvals on
   * the patient, unless they still have a route to it.
   */
  private cascade(guardians: Pick<Relationship, "subject" | "object">[], shares: Pick<Share, "patient" | "with">[], stillReaches: StillReaches) {
    const affected: [Ref, Ref][] = [...guardians.map(g => [g.subject, g.object] as [Ref, Ref]), ...shares.map(x => [x.with, x.patient] as [Ref, Ref])];
    for (const g of guardians) for (const x of this.shareRows("patient = ?1 AND from_user = ?2", g.object, g.subject)) {
      this.db.run("DELETE FROM shares WHERE patient = ? AND from_user = ? AND with_user = ?", [x.patient, x.from, x.with]);
      affected.push([x.with, x.patient]);
    }
    for (const [user, patient] of affected) {
      if (!stillReaches(this.patientRows(patient), user, patient)) this.db.run("DELETE FROM approvals WHERE patient = ? AND by_user = ?", [patient, user]);
    }
  }

  // Level 2

  /**
   * Organization policy, in order, from memory: it's read again when the policy revision changes, which
   * any process's write raises.
   */
  policies = Object.assign((): OrgPolicy[] => {
    const at = this.policyRevision();
    if (this.policies.cache?.at !== at) this.policies.cache = { at, all: (this.db.query("SELECT body FROM policies ORDER BY position, rowid").all() as any[]).map(r => JSON.parse(r.body)) };
    return this.policies.cache.all;
  }, { cache: undefined as { at: number; all: OrgPolicy[] } | undefined });
  /** One type's policies, in order. */
  policiesOf<T extends OrgPolicy["type"]>(type: T): Extract<OrgPolicy, { type: T }>[] { return this.policies().filter((p): p is Extract<OrgPolicy, { type: T }> => p.type === type); }
  private putPolicyRow(p: OrgPolicy) {
    const at = this.db.query("SELECT position FROM policies WHERE id = ?").get(p.id) as any;
    const position = at?.position ?? (((this.db.query("SELECT max(position) AS n FROM policies").get() as any)?.n ?? -1) + 1);
    this.db.run("INSERT OR REPLACE INTO policies (id, position, body) VALUES (?, ?, ?)", [p.id, position, JSON.stringify(p)]);
  }
  /** Adds a policy, or replaces the one with its id. Order is only for listing: access is the union of every policy. */
  putPolicy(p: OrgPolicy): Revision {
    checked([p], "policy", validateOrgPolicy);
    const overlaps = bandOverlaps([...this.policies().filter(x => x.id !== p.id), p]);
    if (overlaps.length) throw new PolicyValidationError(overlaps);
    return this.policyWrite(() => this.putPolicyRow(p));
  }
  removePolicy(id: string): Revision | undefined { return this.db.query("SELECT 1 FROM policies WHERE id = ?").get(id) ? this.policyWrite(() => this.db.run("DELETE FROM policies WHERE id = ?", [id])) : undefined; }
  /** Replaces every policy of one type with these. */
  replacePolicies(type: OrgPolicy["type"], ps: OrgPolicy[]): Revision {
    const errors = validateDocument({ policies: ps });
    for (const [i, p] of ps.entries()) if (p.type !== type) errors.push(`policies[${i}].type must be ${type}`);
    if (!errors.length) errors.push(...bandOverlaps([...this.policies().filter(x => x.type !== type), ...ps]));
    if (errors.length) throw new PolicyValidationError(errors);
    return this.policyWrite(() => {
      for (const p of this.policiesOf(type)) this.db.run("DELETE FROM policies WHERE id = ?", [p.id]);
      for (const p of ps) {
        if (this.db.query("SELECT 1 FROM policies WHERE id = ?").get(p.id)) throw new PolicyValidationError([`policy ${p.id} is already a policy of another type`]);
        this.putPolicyRow(p);
      }
    });
  }

  // Level 3

  private shareRows(where = "1", ...args: string[]): Share[] {
    return (this.db.query(`SELECT patient, with_user, from_user, sites, label FROM shares WHERE ${where} ORDER BY rowid`).all(...args) as any[]).map(s => ({ from: s.from_user, with: s.with_user, patient: s.patient, sites: JSON.parse(s.sites), label: s.label }));
  }
  shares(): Share[] { return this.shareRows(); }
  private putShareRow(s: Share) {
    this.db.run("INSERT OR REPLACE INTO shares (patient, with_user, from_user, sites, label) VALUES (?, ?, ?, ?, ?)", [s.patient, s.with, s.from, JSON.stringify(s.sites), s.label]);
  }
  /** Puts a share as given, one per patient, sharer and recipient. The policy API checks it against organization policy first. */
  putShare(s: Share): Revision { checked([s], "share", validateShare); return this.patientWrite(s.patient, () => this.putShareRow(s))!; }
  /**
   * Removes shares matching every field given, and returns the revisions, or undefined if there were none.
   * A recipient's app approvals on a patient go too, unless another route to the patient remains, so
   * sharing again never brings an app back.
   */
  removeShares(m: { with: string; from?: string; patient?: string }, stillReaches: StillReaches = anyRoute): Revision | undefined {
    const hit = this.shareRows("with_user = ?1 AND (?2 IS NULL OR from_user = ?2) AND (?3 IS NULL OR patient = ?3)", m.with, m.from ?? null as any, m.patient ?? null as any);
    if (!hit.length) return undefined;
    return this.tx(() => {
      for (const s of hit) this.db.run("DELETE FROM shares WHERE patient = ? AND from_user = ? AND with_user = ?", [s.patient, s.from, s.with]);
      this.cascade([], hit, stillReaches);
      for (const p of new Set(hit.map(s => s.patient))) this.bumpPatient(p);
      return this.revision(hit.length === 1 ? hit[0]!.patient : undefined);
    });
  }
  private approvalRows(where = "1", ...args: string[]): AppApproval[] {
    return (this.db.query(`SELECT app, by_user, patient, sites FROM approvals WHERE ${where} ORDER BY rowid`).all(...args) as any[]).map(a => ({ by: a.by_user, app: a.app, patient: a.patient, ...(a.sites === null ? {} : { sites: JSON.parse(a.sites) }) }));
  }
  approvals(): AppApproval[] { return this.approvalRows(); }
  private putApprovalRow(a: AppApproval) {
    this.db.run("DELETE FROM approvals WHERE app = ? AND by_user = ? AND patient = ?", [a.app, a.by, a.patient]);
    this.db.run("INSERT INTO approvals (app, by_user, patient, sites) VALUES (?, ?, ?, ?)", [a.app, a.by, a.patient, a.sites ? JSON.stringify(a.sites) : null]);
  }
  putApproval(a: AppApproval): Revision { checked([a], "approval", validateApproval); return this.patientWrite(a.patient, () => this.putApprovalRow(a))!; }
  removeApprovals(m: { by: string; app: string; patient?: string }): Revision | undefined {
    const hit = this.approvalRows("app = ?1 AND by_user = ?2 AND (?3 IS NULL OR patient = ?3)", m.app, m.by, m.patient ?? null as any);
    if (!hit.length) return undefined;
    return this.tx(() => {
      for (const a of hit) { this.db.run("DELETE FROM approvals WHERE app = ? AND by_user = ? AND patient = ?", [a.app, a.by, a.patient]); this.bumpPatient(a.patient); }
      return this.revision(hit.length === 1 ? hit[0]!.patient : undefined);
    });
  }

  // Reads for decisions, which never scan other patients' rows

  /** Organization policy, and one patient's relationships and choices, at their revisions. */
  patientSnapshot(patient: string): Snapshot { return this.tx(() => this.patientRows(patient)); }
  private patientRows(patient: string): Snapshot {
    return {
      policies: this.policies(), relationships: this.relationshipRows("object = ?", patient),
      shares: this.shareRows("patient = ?", patient), approvals: this.approvalRows("patient = ?", patient), revision: this.revision(patient),
    };
  }
  /** Organization policy, and one person's own relationships and choices: what their account pages read. */
  personSnapshot(user: string): Snapshot {
    return this.tx(() => ({
      policies: this.policies(), relationships: this.relationshipRows("subject = ?", user),
      shares: this.shareRows("with_user = ?1 OR from_user = ?1", user), approvals: this.approvalRows("by_user = ?", user), revision: this.revision(),
    }));
  }

  // The whole document

  /** Every level the store holds, for the admin screen and seeds. Decisions read a patient's snapshot. */
  snapshot(): PolicyDocument & { revision: Revision } {
    return this.tx(() => ({ relationships: this.relationships(), policies: this.policies(), shares: this.shares(), approvals: this.approvals(), revision: this.revision() }));
  }
  /**
   * Replaces the parts given, all or none. Throws PolicyValidationError, changing nothing, if any part is
   * invalid. What it removes takes what hangs off it, as the single removals do: a removed guardian
   * relationship, that guardian's shares and approvals for the patient, and a removed share, its
   * recipient's approvals there, each unless a route remains. The cascade applies after the parts given.
   */
  setDocument(d: Partial<PolicyDocument>, stillReaches: StillReaches = anyRoute): Revision {
    const errors = validateDocument(d);
    if (errors.length) throw new PolicyValidationError(errors);
    return this.policyWrite(() => {
      const key = (x: { subject: string; relation: string; object: string }) => `${x.subject} ${x.relation} ${x.object}`, shareKey = (x: Share) => `${x.patient} ${x.from} ${x.with}`;
      const guardiansBefore = this.relationshipRows("relation = ?", GUARDIAN_OF), sharesBefore = this.shares();
      if (d.relationships) { this.db.run("DELETE FROM relationships"); for (const r of d.relationships) this.putRelationshipRow(r); }
      if (d.policies) { this.db.run("DELETE FROM policies"); for (const p of d.policies) this.putPolicyRow(p); }
      if (d.shares) { this.db.run("DELETE FROM shares"); for (const s of d.shares) this.putShareRow(s); }
      if (d.approvals) { this.db.run("DELETE FROM approvals"); for (const a of d.approvals) this.putApprovalRow(a); }
      this.policies.cache = undefined;
      const guardiansAfter = new Set(this.relationshipRows("relation = ?", GUARDIAN_OF).map(key)), sharesAfter = new Set(this.shares().map(shareKey));
      this.cascade(guardiansBefore.filter(r => !guardiansAfter.has(key(r))), sharesBefore.filter(s => !sharesAfter.has(shareKey(s))), stillReaches);
    }, () => this.patientsWithRows());
  }

  // Settings

  getSettings(): Settings {
    const out = defaultSettings();
    for (const row of this.db.query("SELECT key, value FROM settings").all() as any[]) if (Object.hasOwn(out, row.key)) (out as any)[row.key] = JSON.parse(row.value);
    return out;
  }
  private writeSetting(key: keyof Settings, value: number) { this.db.run("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", [key, JSON.stringify(value)]); }
  /** Changes the settings given, all or none. */
  setSettings(s: Partial<Settings>): Revision {
    const errors: string[] = [];
    if (!isObject(s)) throw new PolicyValidationError(["settings must be a JSON object"]);
    for (const [k, v] of Object.entries(s)) {
      if (!Object.hasOwn(LIMITS, k)) errors.push(`settings: unknown field "${k}"`);
      else validateSetting(k as keyof Settings, v, errors);
    }
    if (errors.length) throw new PolicyValidationError(errors);
    return this.policyWrite(() => { for (const [k, v] of Object.entries(s)) this.writeSetting(k as keyof Settings, v as number); });
  }

  // Signing key

  private insertSigningKey() {
    const fresh = generateEd25519(`imaging-${randomBytes(4).toString("hex")}`);
    this.db.run("INSERT INTO signing_keys (kid, private_key, public_key) VALUES (?, ?, ?)", [fresh.kid, fresh.privateKey.export({ format: "pem", type: "pkcs8" }) as string, fresh.publicKey.export({ format: "pem", type: "spki" }) as string]);
  }
  /** The key in use, created the first time. Stays put across restarts and resets. */
  currentSigningKey(): KeyPair {
    const read = () => this.db.query("SELECT kid, private_key, public_key FROM signing_keys WHERE retired = 0").get() as any;
    const row = read() ?? this.tx(() => { if (!read()) this.insertSigningKey(); return read(); });
    return { kid: row.kid, privateKey: createPrivateKey(row.private_key), publicKey: createPublicKey(row.public_key) };
  }
  /** Public halves of retired keys. They can still confirm a URL was issued here, and can't sign. */
  retiredPublicKeys(): Map<string, KeyObject> {
    const rows = this.db.query("SELECT kid, public_key FROM signing_keys WHERE retired = 1").all() as any[];
    return new Map(rows.map(r => [r.kid, createPublicKey(r.public_key)]));
  }
  /** Retires the key in use, erasing its private half, and makes a new one. */
  rotateSigningKey(): KeyPair {
    this.tx(() => {
      this.db.run("UPDATE signing_keys SET retired = 1, private_key = '' WHERE retired = 0");
      this.insertSigningKey();
    });
    return this.currentSigningKey();
  }

  // Token records. Only the SHA-256 of a token reaches the database, which is why these take the raw token.

  putToken(token: string, kind: TokenKind, record: Omit<TokenRecord, "exp" | "revoked">, exp?: number) {
    this.db.run("INSERT OR REPLACE INTO tokens (hash, kind, record, exp, revoked) VALUES (?, ?, ?, ?, 0)", [sha(token), kind, JSON.stringify(record), exp ?? null]);
  }
  getToken(token: string, kind: TokenKind): TokenRecord | undefined {
    const row = this.db.query("SELECT record, exp, revoked FROM tokens WHERE hash = ? AND kind = ?").get(sha(token), kind) as any;
    return row ? { ...JSON.parse(row.record), ...(row.exp === null ? {} : { exp: row.exp }), revoked: !!row.revoked } : undefined;
  }
  revokeToken(token: string) { this.db.run("UPDATE tokens SET revoked = 1 WHERE hash = ?", [sha(token)]); }
  deleteToken(token: string) { this.db.run("DELETE FROM tokens WHERE hash = ?", [sha(token)]); }
  /** Revokes every token in a family, and returns how many were still live. */
  revokeTokenFamily(family: string): number { return this.db.run("UPDATE tokens SET revoked = 1 WHERE revoked = 0 AND json_extract(record, '$.family') = ?", [family]).changes; }
  revokeAllTokens(): number { return this.db.run("UPDATE tokens SET revoked = 1 WHERE revoked = 0").changes; }
  /** Drops access and refresh tokens that have expired as of this time, and returns how many. */
  purgeExpiredTokens(asOf: number): number { return this.db.run("DELETE FROM tokens WHERE exp <= ?", [asOf]).changes; }

  // Maintenance

  /**
   * Clears what people chose and what was set here: shares, approvals, settings, and any fact or
   * policy beyond what's on file, which goes back as it was. Tokens and the signing key stay.
   */
  resetPolicy(): Revision { return this.policyWrite(() => { for (const t of POLICY_TABLES) this.db.run(`DELETE FROM ${t}`); this.seedOnFile(); }, () => this.patientsWithRows()); }
  /** Resets policy and clears tokens. The signing key stays. */
  resetAll(): Revision { return this.tx(() => { const n = this.resetPolicy(); this.db.run("DELETE FROM tokens"); return n; }); }

  info() {
    const count = (sql: string) => (this.db.query(`SELECT count(*) AS n FROM ${sql}`).get() as any).n as number;
    const sync = (this.db.query("PRAGMA synchronous").get() as any).synchronous as number;
    return {
      mode: this.mode,
      path: this.path,
      durability: (Object.keys(SYNCHRONOUS) as Durability[]).find(k => SYNCHRONOUS[k] === sync) ?? String(sync),
      journal: (this.db.query("PRAGMA journal_mode").get() as any).journal_mode as string,
      schemaVersion: this.schemaVersion(),
      revision: this.policyRevision(),
      counts: {
        relationships: count("relationships"), policies: count("policies"), shares: count("shares"), approvals: count("approvals"), settings: count("settings"), signingKeys: count("signing_keys WHERE retired = 0"), retiredSigningKeys: count("signing_keys WHERE retired = 1"),
        accessTokens: count("tokens WHERE kind = 'access'"), liveAccessTokens: count("tokens WHERE kind = 'access' AND revoked = 0"),
        refreshTokens: count("tokens WHERE kind = 'refresh' AND revoked = 0"),
      },
    };
  }
  close() { this.db.close(); }
}
