// Durable state: Imaging Server policy in its three levels, its signing key, and the Authorization
// Server's token records. One SQLite database holds all of it, which keeps the configuration in one
// place you can inspect and reset. A write about one patient raises that patient's revision, and an
// organization policy write raises the policy revision. Every relationship, share and approval has an
// id, never reused, and each choice records the rows it rests on: deleting a row deletes, in the same
// write, every choice resting only on deleted rows, by id alone. Reads for decisions take one patient's rows,
// by index, and organization policy from memory. Revisions count writes to the store only: a patient's
// age and a study's labels decide access too, so a cache of decisions can't be keyed by revision alone.
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createPrivateKey, createPublicKey, randomBytes, type KeyObject } from "node:crypto";
import { generateEd25519, sha, type KeyPair } from "./jws";
import { bandOverlaps, GUARDIAN_OF, idOf, SELF, type Ref, validateApproval, validateDocument, validateOrgPolicy, validateRelationship, validateShare, type AppApproval, type OrgPolicy, type PolicyDocument, type Relationship, type Revision, type Share, type Snapshot } from "./policy-model";

export interface Settings { contextLifetimeSeconds: number; maxSeriesInContext: number; tokenLifetimeSeconds: number; refreshTokenLifetimeSeconds: number; }
const REFRESH_DEFAULT = 30 * 86400;
const defaultSettings = (): Settings => ({ contextLifetimeSeconds: 300, maxSeriesInContext: 12, tokenLifetimeSeconds: 3600, refreshTokenLifetimeSeconds: REFRESH_DEFAULT });
const LIMITS: Record<keyof Settings, [number, number]> = { contextLifetimeSeconds: [1, 86400], maxSeriesInContext: [0, 10000], tokenLifetimeSeconds: [1, 2592000], refreshTokenLifetimeSeconds: [1, 31536000] };

export type TokenKind = "access" | "refresh";
/** `family` is shared by every token descended from one refresh token. It isn't derived from any token. */
export interface TokenRecord { client_id: string; scope: string; patient?: string; sub?: string; fhirUser?: string; family?: string; exp?: number; revoked: boolean; }

export const SCHEMA_VERSION = 9;
export type Durability = "off" | "normal" | "full";
const SYNCHRONOUS: Record<Durability, number> = { off: 0, normal: 1, full: 2 };
export const DURABILITIES = Object.keys(SYNCHRONOUS) as Durability[];

/** What's on file: the facts and organization policy a new database starts with, and a reset puts back. No one chose these. */
export interface OnFile { relationships?: Relationship[]; policies?: OrgPolicy[]; approvals?: AppApproval[]; }
/**
 * A file store needs `path`. `patientOf` says which patient a user account is, so a choice made as the
 * patient can rest on that, and `now`, in seconds, stamps relationships when they're recorded.
 */
export interface StoreConfig { mode: "file" | "memory"; path?: string; durability?: Durability; onFile?: OnFile; patientOf?: (user: string) => string | undefined; now?: () => number; }

export class PolicyValidationError extends Error {
  constructor(public errors: string[]) { super(errors.join("; ")); this.name = "PolicyValidationError"; }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export function validateSetting(name: keyof Settings, v: unknown, errors: string[]) {
  const [min, max] = LIMITS[name];
  if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) errors.push(`${name} must be a whole number from ${min} to ${max}`);
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS relationships (id TEXT PRIMARY KEY, subject TEXT NOT NULL, relation TEXT NOT NULL, object TEXT NOT NULL, recorded_by TEXT, recorded_at TEXT NOT NULL, UNIQUE (subject, relation, object));
  CREATE INDEX IF NOT EXISTS relationships_by_object ON relationships (object);
  CREATE INDEX IF NOT EXISTS relationships_by_subject ON relationships (subject);
  CREATE TABLE IF NOT EXISTS policies (id TEXT PRIMARY KEY, position INTEGER NOT NULL, body TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS shares (id TEXT PRIMARY KEY, patient TEXT NOT NULL, with_user TEXT NOT NULL, from_user TEXT NOT NULL, sites TEXT NOT NULL, label TEXT NOT NULL, basis TEXT NOT NULL, UNIQUE (patient, from_user, with_user));
  CREATE INDEX IF NOT EXISTS shares_by_with ON shares (with_user);
  CREATE INDEX IF NOT EXISTS shares_by_from ON shares (from_user);
  CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, app TEXT NOT NULL, by_user TEXT NOT NULL, patient TEXT NOT NULL, sites TEXT, studies TEXT, basis TEXT NOT NULL, UNIQUE (app, by_user, patient));
  CREATE INDEX IF NOT EXISTS approvals_by_patient ON approvals (patient);
  CREATE INDEX IF NOT EXISTS approvals_by_user ON approvals (by_user);
  CREATE TABLE IF NOT EXISTS used_ids (id TEXT PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS patient_revisions (patient TEXT PRIMARY KEY, revision INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS signing_keys (kid TEXT PRIMARY KEY, private_key TEXT NOT NULL, public_key TEXT NOT NULL, retired INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS tokens (
    hash TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')), record TEXT NOT NULL, exp INTEGER, revoked INTEGER NOT NULL DEFAULT 0);`;
const POLICY_TABLES = ["relationships", "policies", "shares", "approvals", "settings"];

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
  private readonly patientOf?: (user: string) => string | undefined;
  private readonly now: () => number;

  constructor(config: StoreConfig) {
    if (config.mode === "file" && !config.path) throw new Error("a file policy store needs a path");
    this.mode = config.mode;
    this.path = config.mode === "file" ? config.path! : ":memory:";
    const errors = validateDocument({ relationships: config.onFile?.relationships ?? [], policies: config.onFile?.policies ?? [] });
    if (errors.length) throw new PolicyValidationError(errors);
    this.onFile = structuredClone({ relationships: config.onFile?.relationships ?? [], policies: config.onFile?.policies ?? [], approvals: config.onFile?.approvals ?? [] });
    this.durability = config.durability ?? "normal";
    this.patientOf = config.patientOf;
    this.now = config.now ?? (() => Date.now() / 1000);
    if (config.mode === "file") mkdirSync(dirname(this.path), { recursive: true });
    this.db = new Database(this.path, { create: true });
    // The file holds a private key, so only this user reads it. WAL and SHM files inherit the mode.
    if (config.mode === "file" && existsSync(this.path)) chmodSync(this.path, 0o600);
    this.db.exec("PRAGMA busy_timeout = 2000");
    if (config.mode === "file") this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`PRAGMA synchronous = ${SYNCHRONOUS[this.durability]}`);
    // Version 9 only adds a column, so a world saved at 8 keeps working.
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
    // Union semantics rely on guardian bands never overlapping, whatever wrote the file.
    const overlaps = bandOverlaps(this.policies());
    if (overlaps.length) {
      this.db.close();
      throw new Error(`The policy store at ${this.path} holds overlapping guardian-access policies (${overlaps.join("; ")}). Reset saved policy: delete ${this.path}, or point POLICY_DB at a new file.`);
    }
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

  // Ids: every relationship, share and approval has one, made here or given in a document, and no id is
  // ever used twice, even after its row is deleted or the policy reset.

  private used(id: string) { return !!this.db.query("SELECT 1 FROM used_ids WHERE id = ?").get(id); }
  private claimId(id: string) {
    if (this.used(id)) throw new PolicyValidationError([`id ${id} was used before, and ids aren't reused: leave id out for a new row`]);
    this.db.run("INSERT INTO used_ids (id) VALUES (?)", [id]);
  }
  private newId(kind: "rel" | "share" | "approval"): string {
    for (let n = this.meta("next_id") + 1; ; n++) {
      if (this.used(`${kind}-${n}`)) continue;
      this.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('next_id', ?)", [String(n)]);
      this.db.run("INSERT INTO used_ids (id) VALUES (?)", [`${kind}-${n}`]);
      return `${kind}-${n}`;
    }
  }

  private seedOnFile() {
    // What's on file is the same rows each time, so a given id comes back after a reset, which clears every choice.
    for (const r of this.onFile.relationships) {
      if (r.id) this.db.run("INSERT OR IGNORE INTO used_ids (id) VALUES (?)", [r.id]);
      this.insertRelationship(r, r.id ?? this.newId("rel"));
    }
    for (const p of this.onFile.policies) this.putPolicyRow(p);
    this.policies.cache = undefined;
    // Choices on file rest on the routes just recorded, as any approval does: one whose route isn't on file isn't recorded.
    for (const a of this.onFile.approvals) { try { this.upsertApproval(a); } catch (e) { if (!(e instanceof PolicyValidationError)) throw e; } }
  }

  // Level 1

  private relationshipRows(where = "1", ...args: string[]): Relationship[] {
    return (this.db.query(`SELECT id, subject, relation, object, recorded_by, recorded_at FROM relationships WHERE ${where} ORDER BY rowid`).all(...args) as any[])
      .map(r => ({ id: r.id, subject: r.subject, relation: r.relation, object: r.object, ...(r.recorded_by ? { recordedBy: r.recorded_by } : {}), recordedAt: r.recorded_at }));
  }
  relationships(): Relationship[] { return this.relationshipRows(); }
  private insertRelationship(r: Relationship, id: string) {
    this.db.run("INSERT INTO relationships (id, subject, relation, object, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?)", [id, r.subject, r.relation, r.object, r.recordedBy ?? null, r.recordedAt ?? new Date(this.now() * 1000).toISOString()]);
  }
  /** The row for a relationship: the one with its id, the one already there for its subject, relation and object, or a new one. */
  private upsertRelationship(r: Relationship): string {
    const same = this.relationshipRows("subject = ?1 AND relation = ?2 AND object = ?3", r.subject, r.relation, r.object)[0];
    const byId = r.id ? this.relationshipRows("id = ?", r.id)[0] : undefined;
    if (r.id && byId && (byId.subject !== r.subject || byId.relation !== r.relation || byId.object !== r.object)) throw new PolicyValidationError([`id ${r.id} is a different relationship`]);
    if (same) {
      if (r.id && same.id !== r.id) throw new PolicyValidationError([`${r.subject} ${r.relation} ${r.object} is on file as ${same.id}`]);
      if (r.recordedBy !== undefined) this.db.run("UPDATE relationships SET recorded_by = ? WHERE id = ?", [r.recordedBy, same.id]);
      return same.id!;
    }
    const id = r.id ? (this.claimId(r.id), r.id) : this.newId("rel");
    this.insertRelationship(r, id);
    return id;
  }
  /** Adds a relationship, or keeps the one already there. */
  putRelationship(r: Relationship): Revision { checked([r], "relationship", validateRelationship); return this.patientWrite(PolicyStore.patientOfRelationship(r), () => { this.upsertRelationship(r); })!; }
  /** The relationship with this subject, relation and object, if on file. */
  relationshipOf(r: Pick<Relationship, "subject" | "relation" | "object">): Relationship | undefined { return this.relationshipRows("subject = ?1 AND relation = ?2 AND object = ?3", r.subject, r.relation, r.object)[0]; }
  /**
   * Removes a relationship, and every choice resting only on it, and returns the revisions, or undefined
   * if there was none. Putting it back makes a new row, which brings none of them back.
   */
  removeRelationship(r: Pick<Relationship, "subject" | "relation" | "object">): Revision | undefined {
    const patient = PolicyStore.patientOfRelationship(r);
    return this.patientWrite(patient, () => {
      if (this.db.run("DELETE FROM relationships WHERE subject = ? AND relation = ? AND object = ?", [r.subject, r.relation, r.object]).changes === 0) return false;
      this.prune(patient);
    });
  }
  /**
   * Deletes, for one patient, every share whose basis is gone, then every approval none of whose basis
   * remains. It compares ids only: policies, ages and the clock don't enter into it.
   */
  private prune(patient: string) {
    const rels = new Set(this.relationshipRows("object = ?", patient).map(r => r.id));
    for (const x of this.shareRows("patient = ?", patient)) if (x.basis !== SELF && !rels.has(x.basis)) this.db.run("DELETE FROM shares WHERE id = ?", [x.id!]);
    const shares = new Set(this.shareRows("patient = ?", patient).map(x => x.id));
    for (const a of this.approvalRows("patient = ?", patient)) if (!a.basis!.some(b => b === SELF || rels.has(b) || shares.has(b))) this.db.run("DELETE FROM approvals WHERE id = ?", [a.id!]);
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
    // Checked inside the write, so two writers sharing one file can't each add half an overlap.
    return this.policyWrite(() => {
      const overlaps = bandOverlaps([...this.policies().filter(x => x.id !== p.id), p]);
      if (overlaps.length) throw new PolicyValidationError(overlaps);
      this.putPolicyRow(p);
    });
  }
  removePolicy(id: string): Revision | undefined { return this.db.query("SELECT 1 FROM policies WHERE id = ?").get(id) ? this.policyWrite(() => this.db.run("DELETE FROM policies WHERE id = ?", [id])) : undefined; }
  /** Replaces every policy of one type with these. */
  replacePolicies(type: OrgPolicy["type"], ps: OrgPolicy[]): Revision {
    const errors = validateDocument({ policies: ps });
    for (const [i, p] of ps.entries()) if (p.type !== type) errors.push(`policies[${i}].type must be ${type}`);
    if (errors.length) throw new PolicyValidationError(errors);
    return this.policyWrite(() => {
      const overlaps = bandOverlaps([...this.policies().filter(x => x.type !== type), ...ps]);
      if (overlaps.length) throw new PolicyValidationError(overlaps);
      for (const p of this.policiesOf(type)) this.db.run("DELETE FROM policies WHERE id = ?", [p.id]);
      for (const p of ps) {
        if (this.db.query("SELECT 1 FROM policies WHERE id = ?").get(p.id)) throw new PolicyValidationError([`policy ${p.id} is already a policy of another type`]);
        this.putPolicyRow(p);
      }
    });
  }

  // Level 3

  private shareRows(where = "1", ...args: string[]): Share[] {
    return (this.db.query(`SELECT id, patient, with_user, from_user, sites, label, basis FROM shares WHERE ${where} ORDER BY rowid`).all(...args) as any[])
      .map(s => ({ id: s.id, from: s.from_user, with: s.with_user, patient: s.patient, sites: JSON.parse(s.sites), label: s.label, basis: s.basis }));
  }
  shares(): Share[] { return this.shareRows(); }
  private isSelf(user: Ref, patient: Ref) { return !!this.patientOf && this.patientOf(idOf(user, "user") ?? "") === idOf(patient, "patient"); }
  /** The route a sharer holds now, from the rows alone: being the patient, or their guardian relationship. */
  private shareBasis(s: Share): string {
    if (this.isSelf(s.from, s.patient)) return SELF;
    const rel = this.relationshipOf({ subject: s.from, relation: GUARDIAN_OF, object: s.patient });
    if (rel) return rel.id!;
    throw new PolicyValidationError([`${s.from} holds no route to ${s.patient} to share: they aren't the patient, and have no guardian relationship on file`]);
  }
  private checkShareBasis(s: Share, basis: string) {
    if (basis === SELF ? this.patientOf && !this.isSelf(s.from, s.patient) : !this.relationshipRows("id = ?1 AND subject = ?2 AND relation = ?3 AND object = ?4", basis, s.from, GUARDIAN_OF, s.patient).length)
      throw new PolicyValidationError([`share from ${s.from}: basis ${basis} isn't a route they hold to ${s.patient}`]);
  }
  /**
   * The row for a share: the one with its id, or the one for its patient, sharer and recipient, updated,
   * or a new one. A share keeps the basis it was made on unless one is given; a new one records the
   * sharer's route now. A kept share's basis isn't checked: if it's gone, the prune that follows removes it.
   */
  private upsertShare(s: Share) {
    const byKey = this.shareRows("patient = ?1 AND from_user = ?2 AND with_user = ?3", s.patient, s.from, s.with)[0];
    const byId = s.id ? this.shareRows("id = ?", s.id)[0] : undefined;
    if (s.id && byId && (byId.patient !== s.patient || byId.from !== s.from || byId.with !== s.with)) throw new PolicyValidationError([`id ${s.id} is a different share`]);
    if (s.id && byKey && byKey.id !== s.id) throw new PolicyValidationError([`the share from ${s.from} with ${s.with} of ${s.patient} is on file as ${byKey.id}`]);
    const held = byId ?? byKey;
    if (held) {
      if (s.basis !== undefined && s.basis !== held.basis) this.checkShareBasis(s, s.basis);
      this.db.run("UPDATE shares SET sites = ?, label = ?, basis = ? WHERE id = ?", [JSON.stringify(s.sites), s.label, s.basis ?? held.basis!, held.id!]);
      return;
    }
    const basis = s.basis ?? this.shareBasis(s);
    if (s.basis !== undefined) this.checkShareBasis(s, basis);
    const id = s.id ? (this.claimId(s.id), s.id) : this.newId("share");
    this.db.run("INSERT INTO shares (id, patient, with_user, from_user, sites, label, basis) VALUES (?, ?, ?, ?, ?, ?, ?)", [id, s.patient, s.with, s.from, JSON.stringify(s.sites), s.label, basis]);
  }
  /** Puts a share, one per patient, sharer and recipient. The policy API checks it against organization policy first. */
  putShare(s: Share): Revision { checked([s], "share", validateShare); return this.patientWrite(s.patient, () => { this.upsertShare(s); })!; }
  /** The share from one person with another of a patient's records, if on file. */
  shareOf(s: Pick<Share, "patient" | "from" | "with">): Share | undefined { return this.shareRows("patient = ?1 AND from_user = ?2 AND with_user = ?3", s.patient, s.from, s.with)[0]; }
  /**
   * Removes shares matching every field given, and every approval resting only on deleted rows, and
   * returns the revisions, or undefined if there were none.
   */
  removeShares(m: { with: string; from?: string; patient?: string }): Revision | undefined {
    const hit = this.shareRows("with_user = ?1 AND (?2 IS NULL OR from_user = ?2) AND (?3 IS NULL OR patient = ?3)", m.with, m.from ?? null as any, m.patient ?? null as any);
    if (!hit.length) return undefined;
    return this.tx(() => {
      for (const s of hit) this.db.run("DELETE FROM shares WHERE id = ?", [s.id!]);
      for (const p of new Set(hit.map(s => s.patient))) { this.prune(p); this.bumpPatient(p); }
      return this.revision(hit.length === 1 ? hit[0]!.patient : undefined);
    });
  }
  private approvalRows(where = "1", ...args: string[]): AppApproval[] {
    return (this.db.query(`SELECT id, app, by_user, patient, sites, studies, basis FROM approvals WHERE ${where} ORDER BY rowid`).all(...args) as any[])
      .map(a => ({ id: a.id, by: a.by_user, app: a.app, patient: a.patient, ...(a.sites === null ? {} : { sites: JSON.parse(a.sites) }), ...(a.studies === null ? {} : { studies: JSON.parse(a.studies) }), basis: JSON.parse(a.basis) }));
  }
  approvals(): AppApproval[] { return this.approvalRows(); }
  /** Every route a user holds to a patient now, from the rows alone: being the patient, guardian relationships, and shares with them. */
  private routesOf(user: Ref, patient: Ref): string[] {
    return [
      ...(this.isSelf(user, patient) ? [SELF] : []),
      ...this.relationshipRows("subject = ?1 AND relation = ?2 AND object = ?3", user, GUARDIAN_OF, patient).map(r => r.id!),
      ...this.shareRows("patient = ?1 AND with_user = ?2", patient, user).map(x => x.id!),
    ];
  }
  private approvalBasis(a: AppApproval): string[] {
    const basis = this.routesOf(a.by, a.patient);
    if (!basis.length) throw new PolicyValidationError([`${a.by} holds no route to ${a.patient} to approve an app for: they aren't the patient, a guardian, or anyone's share's recipient`]);
    return basis;
  }
  private checkApprovalBasis(a: AppApproval, basis: string[]) {
    const held = new Set(this.routesOf(a.by, a.patient));
    for (const b of basis) if (!held.has(b) && !(b === SELF && !this.patientOf)) throw new PolicyValidationError([`approval by ${a.by}: basis ${b} isn't a route they hold to ${a.patient}`]);
  }
  /**
   * The row for an approval: the one with its id, or the one for its user, app and patient, or a new one.
   * Each approval rests on every route its user holds when making it, or the basis given, so a route
   * gained later counts only once they approve again. A kept approval's basis isn't checked: the prune
   * that follows removes it if nothing in it remains.
   */
  private upsertApproval(a: AppApproval, keeping = false) {
    const byKey = this.approvalRows("app = ?1 AND by_user = ?2 AND patient = ?3", a.app, a.by, a.patient)[0];
    const byId = a.id ? this.approvalRows("id = ?", a.id)[0] : undefined;
    if (a.id && byId && (byId.app !== a.app || byId.by !== a.by || byId.patient !== a.patient)) throw new PolicyValidationError([`id ${a.id} is a different approval`]);
    if (a.id && byKey && byKey.id !== a.id) throw new PolicyValidationError([`the approval by ${a.by} of ${a.app} for ${a.patient} is on file as ${byKey.id}`]);
    const held = byId ?? byKey;
    const basis = a.basis ?? this.approvalBasis(a);
    if (a.basis !== undefined && !(keeping && held && JSON.stringify(held.basis) === JSON.stringify(a.basis))) this.checkApprovalBasis(a, basis);
    if (held) { this.db.run("UPDATE approvals SET sites = ?, studies = ?, basis = ? WHERE id = ?", [a.sites ? JSON.stringify(a.sites) : null, a.studies ? JSON.stringify(a.studies) : null, JSON.stringify(basis), held.id!]); return; }
    const id = a.id ? (this.claimId(a.id), a.id) : this.newId("approval");
    this.db.run("INSERT INTO approvals (id, app, by_user, patient, sites, studies, basis) VALUES (?, ?, ?, ?, ?, ?, ?)", [id, a.app, a.by, a.patient, a.sites ? JSON.stringify(a.sites) : null, a.studies ? JSON.stringify(a.studies) : null, JSON.stringify(basis)]);
  }
  /** Puts an app approval, resting on every route its user holds now unless a basis is given. */
  putApproval(a: AppApproval): Revision { checked([a], "approval", validateApproval); return this.patientWrite(a.patient, () => { this.upsertApproval(a); })!; }
  /** The approval by a user of an app for a patient, if on file. */
  approvalOf(a: Pick<AppApproval, "by" | "app" | "patient">): AppApproval | undefined { return this.approvalRows("app = ?1 AND by_user = ?2 AND patient = ?3", a.app, a.by, a.patient)[0]; }
  removeApprovals(m: { by: string; app: string; patient?: string }): Revision | undefined {
    const hit = this.approvalRows("app = ?1 AND by_user = ?2 AND (?3 IS NULL OR patient = ?3)", m.app, m.by, m.patient ?? null as any);
    if (!hit.length) return undefined;
    return this.tx(() => {
      for (const a of hit) { this.db.run("DELETE FROM approvals WHERE id = ?", [a.id!]); this.bumpPatient(a.patient); }
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
  /** The relationships, policies and approvals a new store starts with, as configured. */
  defaults(): Required<OnFile> { return structuredClone(this.onFile); }
  snapshot(): PolicyDocument & { revision: Revision } {
    return this.tx(() => ({ relationships: this.relationships(), policies: this.policies(), shares: this.shares(), approvals: this.approvals(), revision: this.revision() }));
  }
  /**
   * Replaces the parts given, all or none, matching rows by id. A row whose id the document keeps is the
   * same row, and its dependents stay; a row without an id is new; a row the document leaves out is
   * deleted, with every choice resting only on deleted rows. A row naming an id used before, and since
   * deleted, is refused. Throws PolicyValidationError, changing nothing, if anything is invalid.
   */
  setDocument(d: Partial<PolicyDocument>): Revision {
    const errors = validateDocument(d);
    if (errors.length) throw new PolicyValidationError(errors);
    return this.policyWrite(() => {
      const before = this.patientsWithRows();
      const drop = (table: string, rows: { id?: string }[]) => {
        const keep = new Set(rows.flatMap(r => r.id ? [r.id] : []));
        for (const { id } of this.db.query(`SELECT id FROM ${table}`).all() as any[]) if (!keep.has(id)) this.db.run(`DELETE FROM ${table} WHERE id = ?`, [id]);
      };
      /** A choice on file stays only as the same choice: a row whose id or whose person, patient and app or recipient now belong to another row goes. */
      const dropChanged = <T extends { id?: string }>(table: string, rows: T[], held: T[], key: (x: T) => string) => {
        const wanted = new Map(rows.flatMap(r => r.id ? [[r.id, key(r)] as const] : [])), keys = new Map(rows.map(r => [key(r), r.id]));
        for (const h of held) if ((wanted.has(h.id!) && wanted.get(h.id!) !== key(h)) || (keys.has(key(h)) && keys.get(key(h)) && keys.get(key(h)) !== h.id)) this.db.run(`DELETE FROM ${table} WHERE id = ?`, [h.id!]);
      };
      if (d.relationships) { drop("relationships", d.relationships); for (const r of d.relationships) this.upsertRelationship(r); }
      if (d.policies) { this.db.run("DELETE FROM policies"); for (const p of d.policies) this.putPolicyRow(p); this.policies.cache = undefined; }
      if (d.shares) { drop("shares", d.shares); dropChanged("shares", d.shares, this.shareRows(), x => `${x.patient} ${x.from} ${x.with}`); for (const x of d.shares) this.upsertShare(x); }
      if (d.approvals) { drop("approvals", d.approvals); dropChanged("approvals", d.approvals, this.approvalRows(), x => `${x.patient} ${x.by} ${x.app}`); for (const a of d.approvals) this.upsertApproval(a, true); }
      for (const p of new Set([...before, ...this.patientsWithRows()])) this.prune(p);
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
  /** Drops every token issued to these clients, and returns how many. */
  deleteTokensOf(clients: string[]): number { return clients.reduce((n, c) => n + this.db.run("DELETE FROM tokens WHERE json_extract(record, '$.client_id') = ?", [c]).changes, 0); }
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
  /** A small value its owner keeps with this store, such as a world's choice of backend. */
  note(key: string): string | undefined { return (this.db.query("SELECT value FROM meta WHERE key = ?").get(`note:${key}`) as { value: string } | null)?.value; }
  setNote(key: string, value: string) { this.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", [`note:${key}`, value]); }
  close() { this.db.close(); }
}
