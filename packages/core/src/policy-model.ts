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

/** `subject relation object`, such as `user:sam guardian_of patient:riley`. */
export interface Relationship { subject: Ref; relation: string; object: Ref; recordedBy?: string; }
export const GUARDIAN_OF = "guardian_of";
/** What evaluation reads of a patient's record. */
export interface PatientAttributes { birthDate?: string; }

// Level 2: organization policy

/** Whole years, both ends included. */
export interface AgeBand { min?: number; max?: number; }
/** Guardians of patients in an age band see the patient's studies, except those with any of `except`'s labels. */
export interface GuardianAccessPolicy { id: string; type: "guardian-access"; description?: string; when: { age: AgeBand }; allow: "all"; except?: string[]; }
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
  withdrawn?: boolean;
}
export type OrgPolicy = GuardianAccessPolicy | SharingPolicy | ServiceAccessPolicy;
export const POLICY_TYPES = ["guardian-access", "sharing", "service-access"] as const;
export type PolicyType = typeof POLICY_TYPES[number];

// Level 3: people's choices

/** `from` lets `with` see `patient`'s records at `sites`, as their `label`, such as caregiver. */
export interface Share { from: Ref; with: Ref; patient: Ref; sites: string[]; label: string; }
/** `by` lets `app` act for them on `patient`'s records. No `sites` means everything `by` can see. */
export interface AppApproval { by: Ref; app: Ref; patient: Ref; sites?: string[]; }

/** The levels the policy store holds, as a scope seed or a whole-document write gives them. Labels are the catalog's. */
export interface PolicyDocument { relationships: Relationship[]; policies: OrgPolicy[]; shares: Share[]; approvals: AppApproval[]; }
/** The policy revision, which organization policy writes raise, and one patient's, which writes about that patient raise. */
export interface Revision { policy: number; patient?: number; }

export type Level = "fact" | "policy" | "choice";
/** One reason behind a decision. */
export interface Because { level: Level; ref: Ref; text: string; }
export type Release = "none" | "study" | { series: string[] };
export interface Decision { release: Release; because: Because[]; why: string; policy?: ServiceAccessPolicy; }

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

export function validateRelationship(r: unknown, at: string, errors: string[]) {
  if (!isObject(r)) { errors.push(`${at} must be an object`); return; }
  unknownKeys(r, ["subject", "relation", "object", "recordedBy"], at, errors);
  needRef(r, "subject", undefined, at, errors); needRef(r, "object", undefined, at, errors);
  if (!(typeof r.relation === "string" && /^[a-z][a-z_]*$/.test(r.relation))) errors.push(`${at}.relation must be a name such as guardian_of`);
  if (r.recordedBy !== undefined && !isText(r.recordedBy)) errors.push(`${at}.recordedBy must be a non-empty string`);
}
export function validateOrgPolicy(p: unknown, at: string, errors: string[]) {
  if (!isObject(p)) { errors.push(`${at} must be an object`); return; }
  if (!isText(p.id)) errors.push(`${at}.id must be a non-empty string`);
  if (p.description !== undefined && typeof p.description !== "string") errors.push(`${at}.description must be a string`);
  if (p.type === "guardian-access") {
    unknownKeys(p, ["id", "type", "description", "when", "allow", "except"], at, errors);
    const age = isObject(p.when) ? p.when.age : undefined;
    if (!isObject(p.when) || !isObject(age)) errors.push(`${at}.when.age must be an object, with min, max, or both`);
    else {
      unknownKeys(p.when, ["age"], `${at}.when`, errors);
      unknownKeys(age, ["min", "max"], `${at}.when.age`, errors);
      for (const k of ["min", "max"]) if (age[k] !== undefined && !(Number.isInteger(age[k]) && (age[k] as number) >= 0 && (age[k] as number) <= 150)) errors.push(`${at}.when.age.${k} must be a whole number of years`);
      if (typeof age.min === "number" && typeof age.max === "number" && age.min > age.max) errors.push(`${at}.when.age: min is more than max`);
    }
    if (p.allow !== "all") errors.push(`${at}.allow must be "all"`);
    if (p.except !== undefined && !isTextList(p.except)) errors.push(`${at}.except must be a list of labels`);
  } else if (p.type === "sharing") {
    unknownKeys(p, ["id", "type", "description", "allowedFrom"], at, errors);
    if (!(Array.isArray(p.allowedFrom) && p.allowedFrom.length && p.allowedFrom.every(x => x === "patient" || x === "guardian"))) errors.push(`${at}.allowedFrom must list patient, guardian, or both`);
  } else if (p.type === "service-access") {
    unknownKeys(p, ["id", "type", "description", "service", "patients", "allow", "withholdSeries", "contextForm", "withdrawn"], at, errors);
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
    if (p.withdrawn !== undefined && typeof p.withdrawn !== "boolean") errors.push(`${at}.withdrawn must be true or false`);
  } else errors.push(`${at}.type must be one of ${POLICY_TYPES.join(", ")}`);
}
export function validateShare(s: unknown, at: string, errors: string[]) {
  if (!isObject(s)) { errors.push(`${at} must be an object`); return; }
  unknownKeys(s, ["from", "with", "patient", "sites", "label"], at, errors);
  needRef(s, "from", "user", at, errors); needRef(s, "with", "user", at, errors); needRef(s, "patient", "patient", at, errors);
  sitesOk(s.sites, `${at}.sites`, errors);
  if (!isText(s.label)) errors.push(`${at}.label must be a non-empty string, such as caregiver`);
}
export function validateApproval(a: unknown, at: string, errors: string[]) {
  if (!isObject(a)) { errors.push(`${at} must be an object`); return; }
  unknownKeys(a, ["by", "app", "patient", "sites"], at, errors);
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
const shareKey = (s: Record<string, unknown>) => `share with ${s.with} of ${s.patient}`;
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
  policy(p: OrgPolicy, name: Namer): string {
    if (p.type === "guardian-access") return `Guardians of patients ${bandText(p.when.age)} see all studies${p.except?.length ? `, except those labeled ${list(p.except.map(l => name(`label:${l}`)))}` : ""}`;
    if (p.type === "sharing") return `${p.allowedFrom.length === 2 ? "Patients and guardians" : p.allowedFrom[0] === "patient" ? "Patients" : "Guardians"} may share what they can see`;
    const a = p.allow, what = a.all ? "all studies" : [a.modalities && `${list(a.modalities)} studies`, a.studies && `the studies ${list(a.studies)}`, a.sites && `studies at ${list(a.sites)}`, a.since && `studies since ${a.since}`].filter(Boolean).join(", ") || "nothing";
    const whose = p.patients === "any" ? "any patient's" : possessive(name(p.patients));
    return `${name(p.service)} may see ${whose} ${what}${p.withholdSeries?.length ? `, with ${p.withholdSeries.length} series withheld` : ""}${p.withdrawn ? ", withdrawn" : ""}`;
  },
  share: (s: Share, name: Namer) => `${name(s.from)} shared ${sitesText(s.sites)} with ${name(s.with)}, as ${s.label}`,
  approval: (a: AppApproval, name: Namer) => `${name(a.by)} approved ${name(a.app)} for ${sitesText(a.sites)}`,
};

// Evaluation

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
  name: Namer;
}
/** A token, as introspection describes it. */
export interface Subject { client_id: string; sub?: string; fhirUser?: string; patient?: string; }

/** Whole years on the date `now`, or undefined without a birth date. */
export function ageOn(birthDate: string | undefined, now: number): number | undefined {
  const m = birthDate?.match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
  if (!m) return undefined;
  const t = new Date(now * 1000), [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  let age = t.getUTCFullYear() - y;
  if (t.getUTCMonth() + 1 < mo || (t.getUTCMonth() + 1 === mo && t.getUTCDate() < d)) age--;
  return age;
}
const inBand = (b: AgeBand, age: number) => (b.min === undefined || age >= b.min) && (b.max === undefined || age <= b.max);

/** One access route's outcome for one study: granted, with its reasons, or not, with why. */
interface Route { ok: boolean; because: Because[]; why: string; policy?: OrgPolicy; }
const no = (why: string, because: Because[] = [], policy?: OrgPolicy): Route => ({ ok: false, because, why, policy });

export function createModel(ctx: ModelContext) {
  const { name } = ctx;
  const fact = (r: Ref, text: string): Because => ({ level: "fact", ref: r, text });
  const pol = (p: OrgPolicy): Because => ({ level: "policy", ref: `policy:${p.id}`, text: TEXT.policy(p, name) });
  const guardianOf = (s: Snapshot, user: Ref, patient: Ref) => s.relationships.find(r => r.subject === user && r.relation === GUARDIAN_OF && r.object === patient);
  const ageOf = (patient: Ref) => ageOn(ctx.attributesOf(idOf(patient, "patient")!)?.birthDate, ctx.now());
  const isPatient = (user: Ref, patient: Ref, fhirUser?: string) => (fhirUser !== undefined ? fhirUser === `Patient/${idOf(patient, "patient")}` : ctx.patientOf(idOf(user, "user")!) === idOf(patient, "patient"));
  /** The guardian-access policy for this patient's age, if any. */
  const guardianPolicy = (s: Snapshot, patient: Ref) => {
    const age = ageOf(patient);
    return { age, policy: age === undefined ? undefined : s.policies.find((p): p is GuardianAccessPolicy => p.type === "guardian-access" && inBand(p.when.age, age)) };
  };

  /** Level 2 applied to level 1: what a user sees of a study as the patient or a guardian. */
  function baseline(s: Snapshot, user: Ref, patient: Ref, study: CatalogStudy, fhirUser?: string): Route {
    if (isPatient(user, patient, fhirUser)) return { ok: true, because: [fact(patient, TEXT.self(user, patient, name))], why: `${name(user)} is the patient` };
    const rel = guardianOf(s, user, patient);
    if (!rel) return no(`${name(user)} is neither the patient nor a guardian`);
    const because = [fact(rel.subject, TEXT.relationship(rel, name))];
    const { age, policy } = guardianPolicy(s, patient);
    if (!policy) return no(age === undefined ? `${possessive(name(patient))} age isn't on file, so no guardian-access policy applies` : `no guardian-access policy covers patients aged ${age}`, because);
    because.push(pol(policy));
    const hidden = study.labels?.find(l => policy.except?.includes(l));
    if (hidden) return no(`${name(`label:${hidden}`)}: ${policy.id} keeps it from guardians`, [...because, fact(ref("study", study.id), TEXT.label(hidden, name))], policy);
    return { ok: true, because, why: `${name(user)} is a guardian, and ${policy.id} covers this study` };
  }

  /** The sharing policy that lets this person share, given their role, if any. */
  function sharingFor(s: Snapshot, from: Ref, patient: Ref): { role?: "patient" | "guardian"; policy?: SharingPolicy } {
    const role = isPatient(from, patient) ? "patient" : guardianOf(s, from, patient) ? "guardian" : undefined;
    return { role, policy: role && s.policies.find((p): p is SharingPolicy => p.type === "sharing" && p.allowedFrom.includes(role)) };
  }

  /** Baseline, then a share: what a user sees of a study before any app approval. */
  function userRoute(s: Snapshot, user: Ref, patient: Ref, study: CatalogStudy, fhirUser?: string): Route {
    const base = baseline(s, user, patient, study, fhirUser);
    if (base.ok || base.because.length) return base;
    const share = s.shares.find(x => x.with === user && x.patient === patient);
    if (!share) return no(`${name(user)} has no share of ${possessive(name(patient))} records`);
    const choice: Because = { level: "choice", ref: `share:${share.from}:${share.with}:${share.patient}`, text: TEXT.share(share, name) };
    const { role, policy } = sharingFor(s, share.from, patient);
    if (!policy) return no(`no sharing policy lets ${role ? `${role}s` : `${name(share.from)}, who is neither the patient nor a guardian,`} share`, [choice]);
    const theirs = baseline(s, share.from, patient, study);
    if (!theirs.ok) return no(`${name(share.from)} can't see this study, so their share can't include it: ${theirs.why}`, [...theirs.because, pol(policy), choice], theirs.policy);
    if (!share.sites.includes(study.site ?? "")) return no(`the share with ${name(user)} doesn't include ${study.site ?? "a study with no site"}`, [...theirs.because, pol(policy), choice]);
    return { ok: true, because: [...theirs.because, pol(policy), choice], why: `${name(share.from)} shared it with ${name(user)}` };
  }

  /** A service's access, from its service-access policy alone. */
  function servicePolicy(s: Snapshot, client: string, patient: string) {
    return s.policies.find((p): p is ServiceAccessPolicy => p.type === "service-access" && p.service === ref("service", client) && (p.patients === "any" || p.patients === ref("patient", patient)));
  }

  function evaluate(s: Snapshot, t: Subject, study: CatalogStudy): Decision {
    const patient = ref("patient", study.patient);
    if (t.sub) {
      if (!t.patient) return { release: "none", because: [], why: "a user's token has no patient context" };
      if (t.patient !== study.patient) return { release: "none", because: [], why: "token's patient context is a different patient" };
      const user = ref("user", t.sub);
      const r = userRoute(s, user, patient, study, t.fhirUser);
      if (!r.ok) return { release: "none", because: r.because, why: r.why };
      const approval = s.approvals.find(a => a.by === user && a.app === ref("app", t.client_id) && a.patient === patient);
      if (!approval) return { release: "none", because: r.because, why: `${name(user)} hasn't approved ${name(ref("app", t.client_id))}` };
      const because = [...r.because, { level: "choice" as const, ref: `approval:${approval.by}:${approval.app}:${approval.patient}`, text: TEXT.approval(approval, name) }];
      if (approval.sites && !approval.sites.includes(study.site ?? "")) return { release: "none", because, why: `${possessive(name(user))} approval of ${name(approval.app)} doesn't include ${study.site ?? "a study with no site"}` };
      return { release: "study", because, why: r.why };
    }
    // A backend service: organization policy alone, with no choices.
    const p = servicePolicy(s, t.client_id, study.patient);
    if (!p) return { release: "none", because: [], why: "no service-access policy covers this service for this patient" };
    const because = [pol(p)];
    if (p.withdrawn) return { release: "none", because, why: `${p.id}: access withdrawn`, policy: p };
    const a = p.allow;
    const siteOk = !a.sites || a.sites.includes(study.site ?? "");
    const studyOk = !a.studies || a.studies.includes(study.id);
    const modOk = !a.modalities || study.series.some(x => a.modalities!.includes(x.modality));
    const dateOk = !a.since || (study.date ?? "") >= a.since.replaceAll("-", "");
    if (!(a.all || a.sites || a.studies || a.modalities || a.since) || !siteOk || !studyOk || !modOk || !dateOk) return { release: "none", because, why: `${p.id}: study is outside what it allows`, policy: p };
    if (p.withholdSeries?.length) {
      const series = study.series.map(x => x.uid).filter(u => !p.withholdSeries!.includes(u));
      if (!series.length) return { release: "none", because, why: `${p.id}: every series is withheld`, policy: p };
      if (series.length < study.series.length) return { release: { series }, because, why: `${p.id}: ${study.series.length - series.length} series withheld`, policy: p };
    }
    return { release: "study", because, why: `${p.id} allows this study`, policy: p };
  }

  /** Whether a service may search for this patient at all. */
  const preAuthorized = (s: Snapshot, client: string, patient: string) => { const p = servicePolicy(s, client, patient); return p && !p.withdrawn ? p : undefined; };

  /** The studies of a patient's that a user sees before any app approval, by the same routes evaluation takes. */
  const visible = (s: Snapshot, user: Ref, patient: Ref, studies: CatalogStudy[], fhirUser?: string) => studies.filter(st => userRoute(s, user, patient, st, fhirUser).ok);

  return { evaluate, baseline, userRoute, sharingFor, guardianOf, guardianPolicy, preAuthorized, servicePolicy, visible, ageOf, pol, fact };
}
export type Model = ReturnType<typeof createModel>;
