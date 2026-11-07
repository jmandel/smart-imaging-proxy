// Durable state for the demo: Imaging Server policy, its signing key, and the Authorization
// Server's token records. One SQLite database holds all of it, which a deployment wouldn't do:
// here it keeps the configuration in one place you can inspect and reset.
import { STORAGE } from "./config";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createPrivateKey, createPublicKey, randomBytes, type KeyObject } from "node:crypto";
import { generateEd25519, sha, type KeyPair } from "./jws";
import people from "../data/patient.json";

export interface Rule {
  id: string;
  description?: string;
  when: { client?: string; user?: string; patient?: string };
  allow: { all?: boolean; sites?: string[]; modalities?: string[]; studies?: string[]; since?: string };
  withholdSeries?: string[];
  /** "restricted" sends every retrieval through can_i, rather than listing series in the URL. */
  contextForm?: "auto" | "restricted";
  withdrawn?: boolean;
}
/** A patient, or a patient's guardian, lets a related person sign in and see some of the patient's records. `asGuardian` makes it last only while the grantor is the guardian. */
export interface Delegation { patient: string; grantedBy: string; delegate: string; relationship: string; sites: string[]; asGuardian?: boolean; }
/** An account on file as able to act for a patient, covering their record apart from `excludedStudies`, which are confidential from them. No one chose it by sharing. */
export interface Guardian { patient: string; guardian: string; relationship: string; excludedStudies?: string[]; }
/** The guardians on file in `data/patient.json`, which stands in for a registration office. */
export const STANDING_GUARDIANS: Guardian[] = people.otherPatients.flatMap((p: { id: string; guardians?: { account: string; relationship: string; excludedStudies?: string[] }[] }) => (p.guardians ?? []).map(g => ({ patient: p.id, guardian: g.account, relationship: g.relationship, ...(g.excludedStudies ? { excludedStudies: g.excludedStudies } : {}) })));
/** A signed-in user lets an app act for them. No `sites` means everything that user can see. */
export interface AppGrant { client: string; user: string; patient: string; sites?: string[]; }
export interface Policy { rules: Rule[]; delegations: Delegation[]; guardians: Guardian[]; appGrants: AppGrant[]; contextLifetimeSeconds: number; maxSeriesInContext: number; }
export const defaultPolicy = (): Policy => ({ rules: [], delegations: [], guardians: STANDING_GUARDIANS, appGrants: [], contextLifetimeSeconds: 300, maxSeriesInContext: 12 });

export interface Settings { contextLifetimeSeconds: number; maxSeriesInContext: number; tokenLifetimeSeconds: number; refreshTokenLifetimeSeconds: number; }
const REFRESH_DEFAULT = 30 * 86400;
const defaultSettings = (): Settings => ({ contextLifetimeSeconds: 300, maxSeriesInContext: 12, tokenLifetimeSeconds: 3600, refreshTokenLifetimeSeconds: REFRESH_DEFAULT });
const LIMITS: Record<keyof Settings, [number, number]> = { contextLifetimeSeconds: [1, 86400], maxSeriesInContext: [0, 10000], tokenLifetimeSeconds: [1, 2592000], refreshTokenLifetimeSeconds: [1, 31536000] };

export type TokenKind = "access" | "refresh";
/** `family` is shared by every token descended from one refresh token. It isn't derived from any token. */
export interface TokenRecord { client_id: string; scope: string; patient?: string; sub?: string; fhirUser?: string; family?: string; exp?: number; revoked: boolean; }

export const SCHEMA_VERSION = 4;
export type Durability = "off" | "normal" | "full";
const SYNCHRONOUS: Record<Durability, number> = { off: 0, normal: 1, full: 2 };
export const DEFAULT_POLICY_DB = `${STORAGE}/policy.sqlite`;

export interface StoreConfig { mode: "file" | "memory"; path?: string; durability?: Durability; }

/** Reads POLICY_STORE, POLICY_DB and POLICY_DURABILITY. A bad value stops startup with a clear message. */
export function storeConfigFromEnv(env: Record<string, string | undefined> = process.env): StoreConfig {
  const mode = env.POLICY_STORE ?? "file";
  if (mode !== "file" && mode !== "memory") throw new Error(`POLICY_STORE must be file or memory, not "${mode}"`);
  const durability = env.POLICY_DURABILITY ?? "normal";
  if (!Object.hasOwn(SYNCHRONOUS, durability)) throw new Error(`POLICY_DURABILITY must be off, normal or full, not "${durability}"`);
  return { mode, path: env.POLICY_DB || DEFAULT_POLICY_DB, durability: durability as Durability };
}

export class PolicyValidationError extends Error {
  constructor(public errors: string[]) { super(errors.join("; ")); this.name = "PolicyValidationError"; }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isTextList = (v: unknown): v is string[] => Array.isArray(v) && v.every(isText);
function unknownKeys(o: Record<string, unknown>, allowed: string[], at: string, errors: string[]) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) errors.push(`${at}: unknown field "${k}"`);
}

function validateRule(r: unknown, at: string, errors: string[]) {
  if (!isObject(r)) { errors.push(`${at} must be an object`); return; }
  unknownKeys(r, ["id", "description", "when", "allow", "withholdSeries", "contextForm", "withdrawn"], at, errors);
  if (!isText(r.id)) errors.push(`${at}.id must be a non-empty string`);
  if (r.description !== undefined && typeof r.description !== "string") errors.push(`${at}.description must be a string`);
  if (!isObject(r.when)) errors.push(`${at}.when must be an object`);
  else {
    unknownKeys(r.when, ["client", "user", "patient"], `${at}.when`, errors);
    for (const k of ["client", "user", "patient"]) if (r.when[k] !== undefined && !isText(r.when[k])) errors.push(`${at}.when.${k} must be a non-empty string`);
  }
  if (!isObject(r.allow)) errors.push(`${at}.allow must be an object`);
  else {
    unknownKeys(r.allow, ["all", "sites", "modalities", "studies", "since"], `${at}.allow`, errors);
    if (r.allow.all !== undefined && typeof r.allow.all !== "boolean") errors.push(`${at}.allow.all must be true or false`);
    for (const k of ["sites", "modalities", "studies"]) if (r.allow[k] !== undefined && !isTextList(r.allow[k])) errors.push(`${at}.allow.${k} must be a list of strings`);
    if (r.allow.since !== undefined && !(typeof r.allow.since === "string" && /^\d{4}-?\d{2}-?\d{2}$/.test(r.allow.since))) errors.push(`${at}.allow.since must be a date, YYYY-MM-DD`);
  }
  if (r.withholdSeries !== undefined && !isTextList(r.withholdSeries)) errors.push(`${at}.withholdSeries must be a list of strings`);
  if (r.contextForm !== undefined && r.contextForm !== "auto" && r.contextForm !== "restricted") errors.push(`${at}.contextForm must be auto or restricted`);
  if (r.withdrawn !== undefined && typeof r.withdrawn !== "boolean") errors.push(`${at}.withdrawn must be true or false`);
}

function duplicates(items: unknown[], keyOf: (o: Record<string, unknown>) => string, describe: string, errors: string[]) {
  const seen = new Set<string>();
  for (const o of items) {
    if (!isObject(o)) continue;
    const key = keyOf(o);
    if (seen.has(key)) errors.push(`${describe}: duplicate ${key}`);
    seen.add(key);
  }
}

export function validateSetting(name: keyof Settings, v: unknown, errors: string[]) {
  const [min, max] = LIMITS[name];
  if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) errors.push(`${name} must be a whole number from ${min} to ${max}`);
}

/** Every problem with a policy, or a part of one. Each message names the field it's about. */
export function validatePolicy(p: unknown): string[] {
  const errors: string[] = [];
  if (!isObject(p)) return ["policy must be a JSON object"];
  unknownKeys(p, ["rules", "delegations", "guardians", "appGrants", "contextLifetimeSeconds", "maxSeriesInContext"], "policy", errors);
  if (p.rules !== undefined) {
    if (!Array.isArray(p.rules)) errors.push("rules must be an array");
    else { p.rules.forEach((r, i) => validateRule(r, `rules[${i}]`, errors)); duplicates(p.rules, r => `id ${r.id}`, "rules", errors); }
  }
  if (p.delegations !== undefined) {
    if (!Array.isArray(p.delegations)) errors.push("delegations must be an array");
    else {
      p.delegations.forEach((d, i) => {
        const at = `delegations[${i}]`;
        if (!isObject(d)) { errors.push(`${at} must be an object`); return; }
        unknownKeys(d, ["patient", "grantedBy", "delegate", "relationship", "sites", "asGuardian"], at, errors);
        for (const k of ["patient", "grantedBy", "delegate", "relationship"]) if (!isText(d[k])) errors.push(`${at}.${k} must be a non-empty string`);
        if (!isTextList(d.sites)) errors.push(`${at}.sites must be a list of strings`);
        if (d.asGuardian !== undefined && typeof d.asGuardian !== "boolean") errors.push(`${at}.asGuardian must be true or false`);
      });
      duplicates(p.delegations, d => `patient ${d.patient} and delegate ${d.delegate}`, "delegations", errors);
    }
  }
  if (p.guardians !== undefined) {
    if (!Array.isArray(p.guardians)) errors.push("guardians must be an array");
    else {
      p.guardians.forEach((g, i) => {
        const at = `guardians[${i}]`;
        if (!isObject(g)) { errors.push(`${at} must be an object`); return; }
        unknownKeys(g, ["patient", "guardian", "relationship", "excludedStudies"], at, errors);
        if (g.excludedStudies !== undefined && !(Array.isArray(g.excludedStudies) && g.excludedStudies.every(isText))) errors.push(`${at}.excludedStudies must be an array of study IDs`);
        for (const k of ["patient", "guardian", "relationship"]) if (!isText(g[k])) errors.push(`${at}.${k} must be a non-empty string`);
      });
      duplicates(p.guardians, g => `patient ${g.patient} and guardian ${g.guardian}`, "guardians", errors);
    }
  }
  if (p.appGrants !== undefined) {
    if (!Array.isArray(p.appGrants)) errors.push("appGrants must be an array");
    else {
      p.appGrants.forEach((g, i) => {
        const at = `appGrants[${i}]`;
        if (!isObject(g)) { errors.push(`${at} must be an object`); return; }
        unknownKeys(g, ["client", "user", "patient", "sites"], at, errors);
        for (const k of ["client", "user", "patient"]) if (!isText(g[k])) errors.push(`${at}.${k} must be a non-empty string`);
        if (g.sites !== undefined && !isTextList(g.sites)) errors.push(`${at}.sites must be a list of strings`);
      });
      duplicates(p.appGrants, g => `client ${g.client}, user ${g.user} and patient ${g.patient}`, "appGrants", errors);
    }
  }
  for (const k of ["contextLifetimeSeconds", "maxSeriesInContext"] as const) if (p[k] !== undefined) validateSetting(k, p[k], errors);
  return errors;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS delegations (
    patient TEXT NOT NULL, delegate TEXT NOT NULL, granted_by TEXT NOT NULL, relationship TEXT NOT NULL, sites TEXT NOT NULL, as_guardian INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (patient, delegate));
  CREATE TABLE IF NOT EXISTS guardians (
    patient TEXT NOT NULL, guardian TEXT NOT NULL, relationship TEXT NOT NULL, excluded_studies TEXT NOT NULL DEFAULT '[]',
    PRIMARY KEY (patient, guardian));
  CREATE TABLE IF NOT EXISTS app_grants (
    client TEXT NOT NULL, user TEXT NOT NULL, patient TEXT NOT NULL, sites TEXT,
    PRIMARY KEY (client, user, patient));
  CREATE TABLE IF NOT EXISTS rules (id TEXT PRIMARY KEY, position INTEGER NOT NULL, body TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS signing_keys (kid TEXT PRIMARY KEY, private_key TEXT NOT NULL, public_key TEXT NOT NULL, retired INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS tokens (
    hash TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')), record TEXT NOT NULL, exp INTEGER, revoked INTEGER NOT NULL DEFAULT 0);`;

export class PolicyStore {
  readonly db: Database;
  readonly mode: "file" | "memory";
  readonly path: string;
  readonly durability: Durability;

  constructor(config: StoreConfig) {
    this.mode = config.mode;
    this.path = config.mode === "file" ? (config.path ?? DEFAULT_POLICY_DB) : ":memory:";
    this.durability = config.durability ?? "normal";
    if (config.mode === "file") mkdirSync(dirname(this.path), { recursive: true });
    this.db = new Database(this.path, { create: true });
    // The file holds a private key, so only this user reads it. WAL and SHM files inherit the mode.
    if (config.mode === "file" && existsSync(this.path)) chmodSync(this.path, 0o600);
    this.db.exec("PRAGMA busy_timeout = 2000");
    if (config.mode === "file") this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`PRAGMA synchronous = ${SYNCHRONOUS[this.durability]}`);
    const found = this.schemaVersion();
    if (found > SCHEMA_VERSION) { this.db.close(); throw new Error(`${this.path} has schema version ${found}, and this code knows only up to ${SCHEMA_VERSION}`); }
    if (found < SCHEMA_VERSION) this.tx(() => {
      if (found === 0) this.db.exec(SCHEMA);
      if (found === 1) {
        this.db.exec("ALTER TABLE signing_keys ADD COLUMN retired INTEGER NOT NULL DEFAULT 0");
        this.db.run("UPDATE tokens SET exp = ? WHERE kind = 'refresh' AND exp IS NULL", [Math.floor(Date.now() / 1000) + REFRESH_DEFAULT]);
      }
      if (found === 1 || found === 2) {
        this.db.exec("ALTER TABLE delegations ADD COLUMN as_guardian INTEGER NOT NULL DEFAULT 0");
        this.db.exec("CREATE TABLE guardians (patient TEXT NOT NULL, guardian TEXT NOT NULL, relationship TEXT NOT NULL, excluded_studies TEXT NOT NULL DEFAULT '[]', PRIMARY KEY (patient, guardian))");
      }
      if (found === 3) this.db.exec("ALTER TABLE guardians ADD COLUMN excluded_studies TEXT NOT NULL DEFAULT '[]'");
      this.seedGuardians();
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
  }

  private tx<T>(fn: () => T): T { return this.db.transaction(fn)(); }
  private schemaVersion(): number { return (this.db.query("PRAGMA user_version").get() as any).user_version; }

  // Policy

  getPolicy(): Policy {
    const s = this.getSettings();
    return { rules: this.rules(), delegations: this.delegations(), guardians: this.guardians(), appGrants: this.appGrants(), contextLifetimeSeconds: s.contextLifetimeSeconds, maxSeriesInContext: s.maxSeriesInContext };
  }
  rules(): Rule[] { return (this.db.query("SELECT body FROM rules ORDER BY position").all() as any[]).map(r => JSON.parse(r.body)); }
  delegations(): Delegation[] {
    return (this.db.query("SELECT patient, granted_by, delegate, relationship, sites, as_guardian FROM delegations ORDER BY rowid").all() as any[])
      .map(d => ({ patient: d.patient, grantedBy: d.granted_by, delegate: d.delegate, relationship: d.relationship, sites: JSON.parse(d.sites), ...(d.as_guardian ? { asGuardian: true } : {}) }));
  }
  guardians(): Guardian[] { return (this.db.query("SELECT patient, guardian, relationship, excluded_studies FROM guardians ORDER BY rowid").all() as any[]).map(({ excluded_studies, ...g }) => { const excluded = JSON.parse(excluded_studies); return excluded.length ? { ...g, excludedStudies: excluded } : g; }); }
  private putGuardian(g: Guardian) { this.db.run("INSERT OR REPLACE INTO guardians (patient, guardian, relationship, excluded_studies) VALUES (?, ?, ?, ?)", [g.patient, g.guardian, g.relationship, JSON.stringify(g.excludedStudies ?? [])]); }
  private seedGuardians() { for (const g of STANDING_GUARDIANS) this.putGuardian(g); }
  appGrants(): AppGrant[] {
    return (this.db.query("SELECT client, user, patient, sites FROM app_grants ORDER BY rowid").all() as any[])
      .map(g => ({ client: g.client, user: g.user, patient: g.patient, ...(g.sites === null ? {} : { sites: JSON.parse(g.sites) }) }));
  }

  /** Replaces the parts given, all or none. Throws PolicyValidationError, changing nothing, if any part is invalid. */
  setPolicy(p: Partial<Policy>) {
    const errors = validatePolicy(p);
    if (errors.length) throw new PolicyValidationError(errors);
    this.tx(() => {
      if (p.rules) {
        this.db.run("DELETE FROM rules");
        p.rules.forEach((r, i) => this.db.run("INSERT INTO rules (id, position, body) VALUES (?, ?, ?)", [r.id, i, JSON.stringify(r)]));
      }
      if (p.delegations) {
        this.db.run("DELETE FROM delegations");
        for (const d of p.delegations) this.putDelegation(d);
      }
      if (p.guardians) {
        this.db.run("DELETE FROM guardians");
        for (const g of p.guardians) this.putGuardian(g);
      }
      if (p.guardians || p.delegations) for (const d of this.delegations()) if (d.asGuardian && !this.guardians().some(g => g.guardian === d.grantedBy && g.patient === d.patient)) this.db.run("DELETE FROM delegations WHERE patient = ? AND granted_by = ? AND delegate = ?", [d.patient, d.grantedBy, d.delegate]);
      if (p.appGrants) {
        this.db.run("DELETE FROM app_grants");
        for (const g of p.appGrants) this.putAppGrant(g);
      }
      if (p.contextLifetimeSeconds !== undefined) this.writeSetting("contextLifetimeSeconds", p.contextLifetimeSeconds);
      if (p.maxSeriesInContext !== undefined) this.writeSetting("maxSeriesInContext", p.maxSeriesInContext);
    });
  }
  /** Merges a change into one rule. The result has to be a valid rule. An unknown id changes nothing. */
  updateRule(id: string, patch: Partial<Rule>) {
    const rules = this.rules();
    if (!rules.some(r => r.id === id)) return;
    this.setPolicy({ rules: rules.map(r => r.id === id ? { ...r, ...patch } : r) });
  }
  putDelegation(d: Delegation) {
    this.tx(() => {
      this.db.run("DELETE FROM delegations WHERE patient = ? AND delegate = ?", [d.patient, d.delegate]);
      this.db.run("INSERT INTO delegations (patient, delegate, granted_by, relationship, sites, as_guardian) VALUES (?, ?, ?, ?, ?, ?)", [d.patient, d.delegate, d.grantedBy, d.relationship, JSON.stringify(d.sites), d.asGuardian ? 1 : 0]);
    });
  }
  /** Removes delegations matching every field given, and returns how many. */
  removeDelegations(m: { patient?: string; grantedBy?: string; delegate: string }): number {
    return this.db.run("DELETE FROM delegations WHERE delegate = ?1 AND (?2 IS NULL OR patient = ?2) AND (?3 IS NULL OR granted_by = ?3)", [m.delegate, m.patient ?? null, m.grantedBy ?? null]).changes;
  }
  putAppGrant(g: AppGrant) {
    this.tx(() => {
      this.db.run("DELETE FROM app_grants WHERE client = ? AND user = ? AND patient = ?", [g.client, g.user, g.patient]);
      this.db.run("INSERT INTO app_grants (client, user, patient, sites) VALUES (?, ?, ?, ?)", [g.client, g.user, g.patient, g.sites ? JSON.stringify(g.sites) : null]);
    });
  }
  /** Removes an app's grants from one user, for one patient if `patient` is given, and returns how many. */
  removeAppGrants(m: { client: string; user: string; patient?: string }): number {
    return this.db.run("DELETE FROM app_grants WHERE client = ?1 AND user = ?2 AND (?3 IS NULL OR patient = ?3)", [m.client, m.user, m.patient ?? null]).changes;
  }

  // Settings

  getSettings(): Settings {
    const out = defaultSettings();
    for (const row of this.db.query("SELECT key, value FROM settings").all() as any[]) if (Object.hasOwn(out, row.key)) (out as any)[row.key] = JSON.parse(row.value);
    return out;
  }
  private writeSetting(key: keyof Settings, value: number) { this.db.run("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", [key, JSON.stringify(value)]); }
  /** Changes the settings given, all or none. */
  setSettings(s: Partial<Settings>) {
    const errors: string[] = [];
    if (!isObject(s)) throw new PolicyValidationError(["settings must be a JSON object"]);
    for (const [k, v] of Object.entries(s)) {
      if (!Object.hasOwn(LIMITS, k)) errors.push(`settings: unknown field "${k}"`);
      else validateSetting(k as keyof Settings, v, errors);
    }
    if (errors.length) throw new PolicyValidationError(errors);
    this.tx(() => { for (const [k, v] of Object.entries(s)) this.writeSetting(k as keyof Settings, v as number); });
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
   * Clears what people chose: delegations, grants, rules and settings. Guardians go back to the ones on
   * file, since no one here chose those. Tokens and the signing key stay.
   */
  resetPolicy() { this.tx(() => { for (const t of ["delegations", "guardians", "app_grants", "rules", "settings"]) this.db.run(`DELETE FROM ${t}`); this.seedGuardians(); }); }
  /** Resets policy and clears tokens. The signing key stays. */
  resetAll() { this.tx(() => { this.resetPolicy(); this.db.run("DELETE FROM tokens"); }); }

  info() {
    const count = (sql: string) => (this.db.query(`SELECT count(*) AS n FROM ${sql}`).get() as any).n as number;
    const sync = (this.db.query("PRAGMA synchronous").get() as any).synchronous as number;
    return {
      mode: this.mode,
      path: this.path,
      durability: (Object.keys(SYNCHRONOUS) as Durability[]).find(k => SYNCHRONOUS[k] === sync) ?? String(sync),
      journal: (this.db.query("PRAGMA journal_mode").get() as any).journal_mode as string,
      schemaVersion: this.schemaVersion(),
      counts: {
        delegations: count("delegations"), guardians: count("guardians"), appGrants: count("app_grants"), rules: count("rules"), settings: count("settings"), signingKeys: count("signing_keys WHERE retired = 0"), retiredSigningKeys: count("signing_keys WHERE retired = 1"),
        accessTokens: count("tokens WHERE kind = 'access'"), liveAccessTokens: count("tokens WHERE kind = 'access' AND revoked = 0"),
        refreshTokens: count("tokens WHERE kind = 'refresh' AND revoked = 0"),
      },
    };
  }
  close() { this.db.close(); }
}

export type StoreName = "saved" | "scratch";
export const STORE_LABELS: Record<StoreName, string> = { saved: "Saved policy", scratch: "Flow scratch: reset when a flow starts" };

/**
 * The saved store holds configuration that outlives a flow. Flows run against a scratch store in
 * memory, so they can start from a known state every time without disturbing saved configuration.
 * The signing key lives only in the saved store, and URLs from both stores are signed with it.
 */
export function createStores(config: StoreConfig) {
  const saved = new PolicyStore(config);
  const scratch = new PolicyStore({ mode: "memory" });
  let activeName: StoreName = "saved";
  return {
    saved, scratch,
    get active() { return activeName === "saved" ? saved : scratch; },
    get activeName() { return activeName; },
    get activeLabel() { return STORE_LABELS[activeName]; },
    activate(name: StoreName) { activeName = name; },
    close() { saved.close(); scratch.close(); },
  };
}
export type Stores = ReturnType<typeof createStores>;
