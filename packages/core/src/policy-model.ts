// The policy model, in three levels. Facts are recorded truths that grant nothing alone:
// relationships, labels on records, which the catalog holds with each study, and patient attributes.
// Organization policy is a fixed list of named policy types with parameters. People's choices, shares
// and app approvals, act within what organization policy allows. Evaluation applies policy to facts
// for a baseline, which shares extend and app approvals narrow, and labels remove what a policy says
// they hide. Every reason it gives is tagged with its level, and its text comes from a template for
// that type and level.
import type { CatalogStudy } from "./archive/types";

/** `kind:id`, such as `user:sam`, `patient:riley-example`, `study:knee-mr`, `app:portal-app`, `service:referral`. */
export type Ref = string;
export const ref = (kind: string, id: string): Ref => `${kind}:${id}`;
export const idOf = (r: Ref | undefined, kind: string) => r?.startsWith(`${kind}:`) ? r.slice(kind.length + 1) : undefined;

// Level 1: facts

/**
 * `subject relation object`, such as `user:sam guardian_of patient:riley`. The store gives each row an
 * `id`, never reused, so a re-created relationship is a new row, and `recordedAt`, when it was recorded.
 */
export interface Relationship { id?: string; subject: Ref; relation: string; object: Ref; recordedBy?: string; recordedAt?: string; }
export const GUARDIAN_OF = "guardian_of";
/** What evaluation reads of a patient's record. */
export interface PatientAttributes { birthDate?: string; }

// Level 2: organization policy

/** Whole years, both ends included. */
export interface AgeBand { min?: number; max?: number; }
/**
 * Guardians of patients in an age band see the patient's studies, except those with any of `except`'s
 * labels, or with a label it doesn't know: `knownLabels` are labels it reaches, and `except`'s it knows
 * too. Bands never overlap, so one policy decides each age.
 */
export interface GuardianAccessPolicy { id: string; type: "guardian-access"; description?: string; when: { age: AgeBand }; allow: "all"; except?: string[]; knownLabels?: string[]; }
/** Who may share a patient's records: the patient, a guardian, or both. A share never exceeds the sharer's own access. */
export interface SharingPolicy { id: string; type: "sharing"; description?: string; allowedFrom: ("patient" | "guardian")[]; }
/** A backend service's access, to any patient or one, by modalities, studies, sites, or date. */
export interface ServiceAccessPolicy {
  id: string; type: "service-access"; description?: string;
  service: Ref; patients: "any" | Ref;
  allow: { all?: boolean; sites?: string[]; modalities?: string[]; studies?: string[]; since?: string };
  withholdSeries?: string[];
  /** "restricted" sends every retrieval through the decision API, rather than listing series in the URL. */
  contextForm?: "auto" | "restricted";
}
export type OrgPolicy = GuardianAccessPolicy | SharingPolicy | ServiceAccessPolicy;
export const POLICY_TYPES = ["guardian-access", "sharing", "service-access"] as const;
export type PolicyType = typeof POLICY_TYPES[number];

// Level 3: people's choices

/** What a choice rests on: being the patient, or a row, by id. */
export const SELF = "self";
/**
 * `from` lets `with` see `patient`'s records at `sites`, as their `label`, such as caregiver. `basis` is
 * the route the sharer held when sharing: `self`, or their guardian relationship's id. The share reaches
 * only through that route, and goes when it does.
 */
export interface Share { id?: string; from: Ref; with: Ref; patient: Ref; sites: string[]; label: string; basis?: string; }
/**
 * `by` lets `app` act for them on `patient`'s records. No `sites` means everything `by` can see. `basis`
 * is every route `by` held when approving: `self`, guardian relationship ids and share ids. The approval
 * releases only through those routes, and goes when all of them have.
 */
export interface AppApproval { id?: string; by: Ref; app: Ref; patient: Ref; sites?: string[]; basis?: string[]; }

/** The levels the policy store holds, as a scope seed or a whole-document write gives them. Labels are the catalog's. */
export interface PolicyDocument { relationships: Relationship[]; policies: OrgPolicy[]; shares: Share[]; approvals: AppApproval[]; }
/** The policy revision, which organization policy writes raise, and one patient's, which writes about that patient raise. */
export interface Revision { policy: number; patient?: number; }

export type Level = "fact" | "policy" | "choice";
/** One reason behind a decision. */
/** One reason behind a decision. A choice's says what it rests on, `restsOn`. */
export interface Because { level: Level; ref: Ref; text: string; restsOn?: string; }
export type Release = "none" | "study" | { series: string[] };
/** A decision, with the reasons from every grant that contributed, and for a service the policies that did. */
export interface Decision { release: Release; because: Because[]; why: string; policies: ServiceAccessPolicy[]; }

// Validation

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isTextList = (v: unknown): v is string[] => Array.isArray(v) && v.every(isText);
const REF = /^[a-z]+:[^\s]+$/;
const isRef = (v: unknown, kind?: string): v is string => typeof v === "string" && REF.test(v) && (!kind || v.startsWith(`${kind}:`));
function unknownKeys(o: Record<string, unknown>, allowed: string[], at: string, errors: string[]) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) errors.push(`${at}: unknown field "${k}"`);
}
const needRef = (o: Record<string, unknown>, k: string, kind: string | undefined, at: string, errors: string[]) => { if (!isRef(o[k], kind)) errors.push(`${at}.${k} must be a reference${kind ? `, ${kind}:id` : ", kind:id"}`); };
const sitesOk = (v: unknown, at: string, errors: string[]) => { if (!isTextList(v)) errors.push(`${at} must be a list of strings`); };
/** A row id: letters, digits and `._:-`, as the store makes them, such as rel-12. */
const ROW_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const isRowId = (v: unknown): v is string => typeof v === "string" && ROW_ID.test(v) && v !== SELF;
const idOk = (o: Record<string, unknown>, at: string, errors: string[]) => { if (o.id !== undefined && !isRowId(o.id)) errors.push(`${at}.id must be a row id, such as rel-12`); };

/** A label name: lowercase letters and digits, in words joined by hyphens, such as confidential-adolescent. */
const LABEL = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const isLabel = (v: unknown): v is string => typeof v === "string" && LABEL.test(v);
/** A study's label as written, trimmed and lowercased, for matching against policies' labels. */
export const normalizeLabel = (l: string) => l.trim().toLowerCase();

export function validateRelationship(r: unknown, at: string, errors: string[]) {
  if (!isObject(r)) { errors.push(`${at} must be an object`); return; }
  unknownKeys(r, ["id", "subject", "relation", "object", "recordedBy", "recordedAt"], at, errors);
  idOk(r, at, errors);
  if (r.recordedAt !== undefined && !(typeof r.recordedAt === "string" && !Number.isNaN(Date.parse(r.recordedAt)))) errors.push(`${at}.recordedAt must be a date and time`);
  needRef(r, "subject", undefined, at, errors); needRef(r, "object", undefined, at, errors);
  if (!(typeof r.relation === "string" && /^[a-z][a-z_]*$/.test(r.relation))) errors.push(`${at}.relation must be a name such as guardian_of`);
  if (r.recordedBy !== undefined && !isText(r.recordedBy)) errors.push(`${at}.recordedBy must be a non-empty string`);
}
export function validateOrgPolicy(p: unknown, at: string, errors: string[]) {
  if (!isObject(p)) { errors.push(`${at} must be an object`); return; }
  if (!isText(p.id)) errors.push(`${at}.id must be a non-empty string`);
  if (p.description !== undefined && typeof p.description !== "string") errors.push(`${at}.description must be a string`);
  if (p.type === "guardian-access") {
    unknownKeys(p, ["id", "type", "description", "when", "allow", "except", "knownLabels"], at, errors);
    const age = isObject(p.when) ? p.when.age : undefined;
    if (!isObject(p.when) || !isObject(age)) errors.push(`${at}.when.age must be an object, with min, max, or both`);
    else if (age.min === undefined && age.max === undefined) errors.push(`${at}.when.age must have min, max, or both`);
    else {
      unknownKeys(p.when, ["age"], `${at}.when`, errors);
      unknownKeys(age, ["min", "max"], `${at}.when.age`, errors);
      for (const k of ["min", "max"]) if (age[k] !== undefined && !(Number.isInteger(age[k]) && (age[k] as number) >= 0 && (age[k] as number) <= 150)) errors.push(`${at}.when.age.${k} must be a whole number of years`);
      if (typeof age.min === "number" && typeof age.max === "number" && age.min > age.max) errors.push(`${at}.when.age: min is more than max`);
    }
    if (p.allow !== "all") errors.push(`${at}.allow must be "all"`);
    if (p.except !== undefined && !(Array.isArray(p.except) && p.except.every(isLabel))) errors.push(`${at}.except must be a list of labels, such as confidential-adolescent`);
    if (p.knownLabels !== undefined && !(Array.isArray(p.knownLabels) && p.knownLabels.every(isLabel))) errors.push(`${at}.knownLabels must be a list of labels, such as confidential-adolescent`);
  } else if (p.type === "sharing") {
    unknownKeys(p, ["id", "type", "description", "allowedFrom"], at, errors);
    if (!(Array.isArray(p.allowedFrom) && p.allowedFrom.length && p.allowedFrom.every(x => x === "patient" || x === "guardian"))) errors.push(`${at}.allowedFrom must list patient, guardian, or both`);
  } else if (p.type === "service-access") {
    unknownKeys(p, ["id", "type", "description", "service", "patients", "allow", "withholdSeries", "contextForm"], at, errors);
    needRef(p, "service", "service", at, errors);
    if (p.patients !== "any" && !isRef(p.patients, "patient")) errors.push(`${at}.patients must be "any" or patient:id`);
    if (!isObject(p.allow)) errors.push(`${at}.allow must be an object`);
    else {
      unknownKeys(p.allow, ["all", "sites", "modalities", "studies", "since"], `${at}.allow`, errors);
      if (p.allow.all !== undefined && typeof p.allow.all !== "boolean") errors.push(`${at}.allow.all must be true or false`);
      for (const k of ["sites", "modalities", "studies"]) if (p.allow[k] !== undefined && !isTextList(p.allow[k])) errors.push(`${at}.allow.${k} must be a list of strings`);
      if (p.allow.since !== undefined && !(typeof p.allow.since === "string" && /^\d{4}-?\d{2}-?\d{2}$/.test(p.allow.since))) errors.push(`${at}.allow.since must be a date, YYYY-MM-DD`);
    }
    if (p.withholdSeries !== undefined && !isTextList(p.withholdSeries)) errors.push(`${at}.withholdSeries must be a list of strings`);
    if (p.contextForm !== undefined && p.contextForm !== "auto" && p.contextForm !== "restricted") errors.push(`${at}.contextForm must be auto or restricted`);
  } else errors.push(`${at}.type must be one of ${POLICY_TYPES.join(", ")}`);
}
export function validateShare(s: unknown, at: string, errors: string[]) {
  if (!isObject(s)) { errors.push(`${at} must be an object`); return; }
  unknownKeys(s, ["id", "from", "with", "patient", "sites", "label", "basis"], at, errors);
  idOk(s, at, errors);
  if (s.basis !== undefined && s.basis !== SELF && !isRowId(s.basis)) errors.push(`${at}.basis must be self or a relationship's id`);
  needRef(s, "from", "user", at, errors); needRef(s, "with", "user", at, errors); needRef(s, "patient", "patient", at, errors);
  sitesOk(s.sites, `${at}.sites`, errors);
  if (!isText(s.label)) errors.push(`${at}.label must be a non-empty string, such as caregiver`);
}
export function validateApproval(a: unknown, at: string, errors: string[]) {
  if (!isObject(a)) { errors.push(`${at} must be an object`); return; }
  unknownKeys(a, ["id", "by", "app", "patient", "sites", "basis"], at, errors);
  idOk(a, at, errors);
  if (a.basis !== undefined && !(Array.isArray(a.basis) && a.basis.length > 0 && a.basis.every(b => b === SELF || isRowId(b)) && new Set(a.basis).size === a.basis.length)) errors.push(`${at}.basis must list self, relationship ids or share ids, at least one, each once`);
  needRef(a, "by", "user", at, errors); needRef(a, "app", "app", at, errors); needRef(a, "patient", "patient", at, errors);
  if (a.sites !== undefined) sitesOk(a.sites, `${at}.sites`, errors);
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
const relKey = (r: Record<string, unknown>) => `${r.subject} ${r.relation} ${r.object}`;
const shareKey = (s: Record<string, unknown>) => `share from ${s.from} with ${s.with} of ${s.patient}`;
const approvalKey = (a: Record<string, unknown>) => `approval by ${a.by} of ${a.app} for ${a.patient}`;

/** Every problem with a policy document, or any part of one. Each message names the field it's about. */
export function validateDocument(d: unknown): string[] {
  const errors: string[] = [];
  if (!isObject(d)) return ["the document must be a JSON object"];
  unknownKeys(d, ["relationships", "policies", "shares", "approvals"], "document", errors);
  const list = (k: string, check: (x: unknown, at: string, e: string[]) => void, keyOf: (o: Record<string, unknown>) => string) => {
    if (d[k] === undefined) return;
    if (!Array.isArray(d[k])) { errors.push(`${k} must be an array`); return; }
    (d[k] as unknown[]).forEach((x, i) => check(x, `${k}[${i}]`, errors));
    duplicates(d[k] as unknown[], keyOf, k, errors);
  };
  list("relationships", validateRelationship, relKey);
  list("policies", validateOrgPolicy, p => `id ${p.id}`);
  list("shares", validateShare, shareKey);
  list("approvals", validateApproval, approvalKey);
  const ids = ["relationships", "shares", "approvals"].flatMap(k => Array.isArray(d[k]) ? (d[k] as unknown[]).flatMap(x => isObject(x) && typeof x.id === "string" ? [x.id] : []) : []);
  for (const id of new Set(ids.filter((x, i) => ids.indexOf(x) !== i))) errors.push(`document: id ${id} is on more than one row`);
  if (!errors.length && Array.isArray(d.policies)) errors.push(...bandOverlaps(d.policies as OrgPolicy[]));
  return errors;
}

/** Each pair of guardian-access policies whose age bands overlap, which no set of policies may hold. */
export function bandOverlaps(policies: OrgPolicy[]): string[] {
  const g = policies.filter((p): p is GuardianAccessPolicy => p.type === "guardian-access");
  const errors: string[] = [];
  for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) {
    const [a, b] = [g[i]!.when.age, g[j]!.when.age];
    if ((a.min ?? 0) <= (b.max ?? Infinity) && (b.min ?? 0) <= (a.max ?? Infinity)) errors.push(`policies: guardian-access policies ${g[i]!.id} (${bandText(a)}) and ${g[j]!.id} (${bandText(b)}) overlap`);
  }
  return errors;
}

// Text: one template per type and level. `name` gives a reference's display name.

export type Namer = (r: Ref) => string;
export const defaultName: Namer = r => r.slice(r.indexOf(":") + 1).replaceAll("-", " ");
const possessive = (s: string) => `${s}'s`;
const list = (items: string[]) => items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
const sitesText = (sites: string[] | undefined) => sites === undefined ? "all sites" : sites.length ? list(sites) : "no sites";
export function bandText(b: AgeBand) {
  if (b.min === undefined && b.max !== undefined) return `under ${b.max + 1}`;
  if (b.min !== undefined && b.max === undefined) return `${b.min} and older`;
  if (b.min !== undefined && b.max !== undefined) return b.min === b.max ? `aged ${b.min}` : `${b.min} to ${b.max}`;
  return "of any age";
}
export const TEXT = {
  relationship: (r: Relationship, name: Namer) => r.relation === GUARDIAN_OF ? `${name(r.subject)} is ${possessive(name(r.object))} guardian` : `${name(r.subject)} ${r.relation.replaceAll("_", " ")} ${name(r.object)}`,
  self: (user: Ref, _patient: Ref, name: Namer) => `${name(user)} is the patient`,
  label: (label: string, name: Namer) => `Labeled ${name(`label:${label}`)}`,
  unknownLabel: () => "Has a label the guardian-access policy doesn't know",
  policy(p: OrgPolicy, name: Namer): string {
    if (p.type === "guardian-access") return `Guardians of patients ${bandText(p.when.age)} see all studies${p.except?.length ? `, except those labeled ${list(p.except.map(l => name(`label:${l}`)))}` : ""}`;
    if (p.type === "sharing") return `${p.allowedFrom.length === 2 ? "Patients and guardians" : p.allowedFrom[0] === "patient" ? "Patients" : "Guardians"} may share what they can see`;
    const a = p.allow, what = a.all ? "all studies" : [a.modalities && `${list(a.modalities)} studies`, a.studies && `the studies ${list(a.studies)}`, a.sites && `studies at ${list(a.sites)}`, a.since && `studies since ${a.since}`].filter(Boolean).join(", ") || "nothing";
    const whose = p.patients === "any" ? "any patient's" : possessive(name(p.patients));
    return `${name(p.service)} may see ${whose} ${what}${p.withholdSeries?.length ? `, with ${p.withholdSeries.length} series withheld` : ""}`;
  },
  share: (s: Share, name: Namer) => `${name(s.from)} shared ${sitesText(s.sites)} with ${name(s.with)}, as ${s.label}`,
  approval: (a: AppApproval, name: Namer) => `${name(a.by)} approved ${name(a.app)} for ${sitesText(a.sites)}`,
};

// Evaluation
//
// Access is the union of every grant that applies. Policies and choices only grant: adding one never
// takes access away, and their order doesn't matter. A grant's own reach is the only restriction:
// guardian-access reaches studies without the labels it excepts, service-access what its allow names,
// a share the sharer's own access at the sites shared. An app approval narrows a user's access for one
// app, to its sites. Revoking is deleting the grant.

/**
 * What one evaluation reads: organization policy, and one patient's relationships and choices, never
 * any other patient's. A snapshot for a person's own view holds their relationships and choices.
 */
export interface Snapshot { relationships: Relationship[]; policies: OrgPolicy[]; shares: Share[]; approvals: AppApproval[]; revision?: Revision; }
/** What evaluation needs from outside the policy store. */
export interface ModelContext {
  /** The patient a user account is, if any. */
  patientOf(user: string): string | undefined;
  attributesOf(patient: string): PatientAttributes | undefined;
  /** Seconds since the epoch, for ages. */
  now(): number;
  /** The organization's time zone, an IANA name, which ages are counted in. UTC unless given. */
  timeZone?: string;
  name: Namer;
}
/** A token, as introspection describes it. */
export interface Subject { client_id: string; sub?: string; fhirUser?: string; patient?: string; }

/** Whether a time zone is one this runtime knows. */
export function isTimeZone(tz: string) { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; } }
/** A birth date as `YYYY-MM-DD` that is a real calendar date, or undefined. */
export function parseDate(v: string | undefined): [number, number, number] | undefined {
  const m = v?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? [y, mo, d] : undefined;
}
const dayFormats = new Map<string, Intl.DateTimeFormat>();
/** The calendar date at `now` in a time zone. */
function dateIn(now: number, timeZone: string): [number, number, number] {
  let f = dayFormats.get(timeZone);
  if (!f) { f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }); dayFormats.set(timeZone, f); }
  const part = (type: string) => Number(f!.formatToParts(new Date(now * 1000)).find(p => p.type === type)!.value);
  return [part("year"), part("month"), part("day")];
}
/** Whole years on the date `now` in the time zone, or undefined for a missing, invalid or future birth date. */
export function ageOn(birthDate: string | undefined, now: number, timeZone = "UTC"): number | undefined {
  const b = parseDate(birthDate);
  if (!b) return undefined;
  const [y, mo, d] = dateIn(now, timeZone);
  if (y < b[0] || (y === b[0] && (mo < b[1] || (mo === b[1] && d < b[2])))) return undefined;
  return y - b[0] - (mo < b[1] || (mo === b[1] && d < b[2]) ? 1 : 0);
}
const inBand = (b: AgeBand, age: number) => (b.min === undefined || age >= b.min) && (b.max === undefined || age <= b.max);

/** One route's outcome for one study: granted, with its reasons, or not, with why. */
interface Route { ok: boolean; because: Because[]; why: string; policy?: OrgPolicy; role?: "patient" | "guardian"; basis?: string; }
const no = (why: string, because: Because[] = [], policy?: OrgPolicy): Route => ({ ok: false, because, why, policy });
const unique = <T>(xs: T[], key: (x: T) => string) => { const seen = new Set<string>(); return xs.filter(x => { const k = key(x); if (seen.has(k)) return false; seen.add(k); return true; }); };
const reasons = (bs: Because[]) => unique(bs, b => `${b.level} ${b.ref} ${b.text}`);
/** Everything the routes say, granted or not: the granted ones if any are. */
function combine(routes: Route[], none: () => Route): Route {
  const granted = routes.filter(r => r.ok);
  if (granted.length) return { ok: true, because: reasons(granted.flatMap(r => r.because)), why: unique(granted.map(r => r.why), x => x).join("; ") };
  if (!routes.length) return none();
  return { ok: false, because: reasons(routes.flatMap(r => r.because)), why: unique(routes.map(r => r.why), x => x).join("; "), policy: routes.find(r => r.policy)?.policy };
}

export function createModel(ctx: ModelContext) {
  const { name } = ctx;
  const timeZone = ctx.timeZone ?? "UTC";
  if (!isTimeZone(timeZone)) throw new Error(`timeZone ${timeZone} isn't a time zone this runtime knows`);
  const fact = (r: Ref, text: string): Because => ({ level: "fact", ref: r, text });
  const pol = (p: OrgPolicy): Because => ({ level: "policy", ref: `policy:${p.id}`, text: TEXT.policy(p, name) });
  /** What one basis entry is, in words, from the patient's rows. */
  const basisText = (s: Snapshot, b: string, who: Ref) => {
    if (b === SELF) return `${name(who)} being the patient`;
    const rel = s.relationships.find(r => r.id === b);
    if (rel) return `${possessive(name(rel.subject))} guardian relationship${rel.recordedAt ? `, recorded ${rel.recordedAt.slice(0, 10)}` : ""}`;
    const sh = s.shares.find(x => x.id === b);
    return sh ? `${possessive(name(sh.from))} share` : `row ${b}, no longer on file`;
  };
  const shareChoice = (s: Snapshot, sh: Share): Because => ({ level: "choice", ref: `share:${sh.id ?? `${sh.from}:${sh.with}:${sh.patient}`}`, text: TEXT.share(sh, name), ...(sh.basis ? { restsOn: basisText(s, sh.basis, sh.from) } : {}) });
  const guardianOf = (s: Snapshot, user: Ref, patient: Ref) => s.relationships.find(r => r.subject === user && r.relation === GUARDIAN_OF && r.object === patient);
  const ageOf = (patient: Ref) => ageOn(ctx.attributesOf(idOf(patient, "patient")!)?.birthDate, ctx.now(), timeZone);
  const isPatient = (user: Ref, patient: Ref, fhirUser?: string) => (fhirUser !== undefined ? fhirUser === `Patient/${idOf(patient, "patient")}` : ctx.patientOf(idOf(user, "user")!) === idOf(patient, "patient"));
  /** Every guardian-access policy whose band holds this patient's age. */
  const guardianPolicies = (s: Snapshot, patient: Ref) => {
    const age = ageOf(patient);
    return { age, policies: age === undefined ? [] : s.policies.filter((p): p is GuardianAccessPolicy => p.type === "guardian-access" && inBand(p.when.age, age)) };
  };

  /** A user's own routes to a study, as the patient and as a guardian: what they may share. */
  function own(s: Snapshot, user: Ref, patient: Ref, study: CatalogStudy, fhirUser?: string): Route[] {
    const routes: Route[] = [];
    if (isPatient(user, patient, fhirUser)) routes.push({ ok: true, because: [fact(patient, TEXT.self(user, patient, name))], why: `${name(user)} is the patient`, role: "patient", basis: SELF });
    const rel = guardianOf(s, user, patient);
    if (!rel) return routes;
    const is = fact(rel.subject, TEXT.relationship(rel, name));
    const { age, policies } = guardianPolicies(s, patient);
    const basis = rel.id;
    if (!policies.length) routes.push({ ...no(age === undefined ? `${possessive(name(patient))} birth date isn't on file as a valid past date, so no guardian-access policy applies` : `no guardian-access policy covers patients aged ${age}`, [is]), basis });
    // The policy covering the age decides alone: a label it doesn't know, or one that isn't a label, keeps the study from guardians.
    const labels = (study.labels ?? []).map(normalizeLabel);
    for (const p of policies) {
      const known = new Set([...(p.except ?? []), ...(p.knownLabels ?? [])]);
      const unknown = labels.some(l => !isLabel(l) || !known.has(l));
      const hidden = labels.find(l => p.except?.includes(l));
      if (unknown) routes.push({ ...no(`an unknown label keeps it from guardians`, [is, pol(p), fact(ref("study", study.id), TEXT.unknownLabel())], p), basis });
      else if (hidden) routes.push({ ...no(`${name(`label:${hidden}`)}: ${p.id} keeps it from guardians`, [is, pol(p), fact(ref("study", study.id), TEXT.label(hidden, name))], p), basis });
      else routes.push({ ok: true, because: [is, pol(p)], why: `${name(user)} is a guardian, and ${p.id} covers this study`, policy: p, role: "guardian", basis });
    }
    return routes;
  }
  /** The user's own access to a study, as the patient or a guardian. */
  const baseline = (s: Snapshot, user: Ref, patient: Ref, study: CatalogStudy, fhirUser?: string) => combine(own(s, user, patient, study, fhirUser), () => no(`${name(user)} is neither the patient nor a guardian`));

  /** The sharing policies that let this person share, by the roles they hold. */
  function sharingFor(s: Snapshot, from: Ref, patient: Ref): { role?: "patient" | "guardian"; policy?: SharingPolicy; policies: SharingPolicy[]; roles: ("patient" | "guardian")[] } {
    const roles = [...(isPatient(from, patient) ? ["patient" as const] : []), ...(guardianOf(s, from, patient) ? ["guardian" as const] : [])];
    const policies = s.policies.filter((p): p is SharingPolicy => p.type === "sharing" && p.allowedFrom.some(r => roles.includes(r)));
    const role = roles.find(r => policies.some(p => p.allowedFrom.includes(r))) ?? roles[0];
    return { role, policy: policies[0], policies, roles };
  }

  /**
   * Each share with this user, as a route, which an approval names by the share's id. A share reaches
   * what the sharer sees now through the one route it rests on, in a role a sharing policy lets them
   * share in.
   */
  function shared(s: Snapshot, user: Ref, patient: Ref, study: CatalogStudy): Route[] {
    return s.shares.filter(x => x.with === user && x.patient === patient).map(sh => {
      const choice = shareChoice(s, sh), basis = sh.id;
      const { policies } = sharingFor(s, sh.from, patient);
      if (!policies.length) return { ...no(`no sharing policy lets ${name(sh.from)} share`, [choice]), basis };
      const allowed = new Set(policies.flatMap(p => p.allowedFrom));
      const theirs = own(s, sh.from, patient, study).filter(r => r.ok && r.role && allowed.has(r.role) && r.basis === sh.basis);
      // To the recipient, why the sharer can't see a study stays unsaid: it may be a label.
      if (!theirs.length) return { ...no(`${possessive(name(sh.from))} share doesn't reach this study`, [choice]), basis };
      if (!sh.sites.includes(study.site ?? "")) return { ...no(`the share with ${name(user)} doesn't include ${study.site ?? "a study with no site"}`, [choice]), basis };
      return { ok: true, because: [...theirs.flatMap(r => r.because), ...policies.map(pol), choice], why: `${name(sh.from)} shared it with ${name(user)}`, basis };
    });
  }

  /** Every route a user has to a study, before any app approval, or only those an approval rests on. */
  const userRoute = (s: Snapshot, user: Ref, patient: Ref, study: CatalogStudy, fhirUser?: string, basis?: string[]) => {
    const all = [...own(s, user, patient, study, fhirUser), ...shared(s, user, patient, study)];
    return combine(basis ? all.filter(r => r.basis !== undefined && basis.includes(r.basis)) : all, () => no(`${name(user)} has no share of ${possessive(name(patient))} records`));
  };

  /** Every service-access policy for this service and patient. Any one lets it search. */
  const preAuthorized = (s: Snapshot, client: string, patient: string) =>
    s.policies.filter((p): p is ServiceAccessPolicy => p.type === "service-access" && p.service === ref("service", client) && (p.patients === "any" || p.patients === ref("patient", patient)));

  /** What one service-access policy reaches of a study. */
  function reach(p: ServiceAccessPolicy, study: CatalogStudy): { release: Release; why: string } {
    const a = p.allow;
    const siteOk = !a.sites || a.sites.includes(study.site ?? "");
    const studyOk = !a.studies || a.studies.includes(study.id);
    const modOk = !a.modalities || study.series.some(x => a.modalities!.includes(x.modality));
    const dateOk = !a.since || (study.date ?? "") >= a.since.replaceAll("-", "");
    if (!(a.all || a.sites || a.studies || a.modalities || a.since) || !siteOk || !studyOk || !modOk || !dateOk) return { release: "none", why: `${p.id}: study is outside what it allows` };
    if (p.withholdSeries?.length) {
      const series = study.series.map(x => x.uid).filter(u => !p.withholdSeries!.includes(u));
      if (!series.length) return { release: "none", why: `${p.id}: every series is withheld` };
      if (series.length < study.series.length) return { release: { series }, why: `${p.id}: ${study.series.length - series.length} series withheld` };
    }
    return { release: "study", why: `${p.id} allows this study` };
  }

  function evaluate(s: Snapshot, t: Subject, study: CatalogStudy): Decision {
    const patient = ref("patient", study.patient);
    if (t.sub) {
      if (!t.patient) return { release: "none", because: [], why: "a user's token has no patient context", policies: [] };
      if (t.patient !== study.patient) return { release: "none", because: [], why: "token's patient context is a different patient", policies: [] };
      const user = ref("user", t.sub);
      const approval = s.approvals.find(a => a.by === user && a.app === ref("app", t.client_id) && a.patient === patient);
      if (!approval) {
        const r = userRoute(s, user, patient, study, t.fhirUser);
        return { release: "none", because: r.because, why: r.ok ? `${name(user)} hasn't approved ${name(ref("app", t.client_id))}` : r.why, policies: [] };
      }
      // The approval releases only through the routes it rests on: a route gained later needs a new approval.
      const r = userRoute(s, user, patient, study, t.fhirUser, approval.basis ?? []);
      if (!r.ok) return { release: "none", because: r.because, why: r.why, policies: [] };
      const because = [...r.because, { level: "choice" as const, ref: `approval:${approval.id ?? `${approval.by}:${approval.app}:${approval.patient}`}`, text: TEXT.approval(approval, name), ...(approval.basis ? { restsOn: approval.basis.map(b => basisText(s, b, user)).join(" and ") } : {}) }];
      if (approval.sites && !approval.sites.includes(study.site ?? "")) return { release: "none", because, why: `${possessive(name(user))} approval of ${name(approval.app)} doesn't include ${study.site ?? "a study with no site"}`, policies: [] };
      return { release: "study", because, why: r.why, policies: [] };
    }
    // A backend service: organization policy alone, with no choices, as the union of its policies.
    const ps = preAuthorized(s, t.client_id, study.patient);
    if (!ps.length) return { release: "none", because: [], why: "no service-access policy covers this service for this patient", policies: [] };
    const reached = ps.map(p => ({ p, ...reach(p, study) }));
    const granted = reached.filter(r => r.release !== "none");
    if (!granted.length) return { release: "none", because: ps.map(pol), why: reached.map(r => r.why).join("; "), policies: [] };
    const series = new Set(granted.flatMap(r => r.release === "study" ? study.series.map(x => x.uid) : (r.release as { series: string[] }).series));
    const release: Release = series.size === study.series.length ? "study" : { series: study.series.map(x => x.uid).filter(u => series.has(u)) };
    const why = granted.length === 1 ? granted[0]!.why : granted.map(r => r.why).join("; ");
    return { release, because: granted.map(r => pol(r.p)), why: release === "study" && granted.every(r => r.release !== "study") ? `${why}; together they release every series` : why, policies: granted.map(r => r.p) };
  }

  /** The studies of a patient's that a user sees before any app approval, by the same routes evaluation takes. */
  const visible = (s: Snapshot, user: Ref, patient: Ref, studies: CatalogStudy[], fhirUser?: string) => studies.filter(st => userRoute(s, user, patient, st, fhirUser).ok);

  return { evaluate, baseline, userRoute, sharingFor, guardianOf, guardianPolicies, preAuthorized, visible, ageOf, pol, fact };
}
export type Model = ReturnType<typeof createModel>;
