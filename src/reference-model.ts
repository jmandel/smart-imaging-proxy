// A small reference model of the policy rules, written apart from core's evaluation, which the tours
// check the real system against. It reads a sandbox's policy document and catalog at one moment, and
// says which studies each kind of caller should reach. It knows nothing of how core decides.
//
// Choices rest on rows by id. A share records the one route its sharer shares through, "self" or their
// guardian relationship's id, and reaches only through it. An approval records the routes its user held
// when approving, "self", guardian relationship ids and share ids, and releases only through those.
import type { PolicyDocument, Share } from "@smart-imaging-proxy/core";

export interface RefStudy { id: string; patient: string; site?: string; labels?: string[]; date?: string; modalities: string[]; seriesUids: string[]; }
export interface RefSandbox {
  doc: Pick<PolicyDocument, "relationships" | "policies" | "shares" | "approvals">;
  studies: RefStudy[];
  /** Seconds since the epoch. */
  now: number;
  birthDate(patient: string): string | undefined;
  /** The patient record a user account is, if any. */
  patientOf(user: string): string | undefined;
}

const u = (id: string) => `user:${id}`, p = (id: string) => `patient:${id}`;
/** The route of being the patient. */
const SELF = "self";

/** Whole years at `now`, in UTC, or undefined for no valid past birth date. */
export function ageAt(birthDate: string | undefined, now: number): number | undefined {
  const m = birthDate?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return undefined;
  const t = new Date(now * 1000);
  const [y, mo, d] = [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
  const [by, bm, bd] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const age = y - by - (mo < bm || (mo === bm && d < bd) ? 1 : 0);
  return age < 0 ? undefined : age;
}

export function referenceModel(w: RefSandbox) {
  const { doc } = w;
  const ofPatient = (patient: string) => w.studies.filter(s => s.patient === patient);
  const isPatient = (user: string, patient: string) => w.patientOf(user) === patient;
  /** The user's guardian relationship with the patient, if one is on file. */
  const guardianRow = (user: string, patient: string) => doc.relationships.find(r => r.subject === u(user) && r.relation === "guardian_of" && r.object === p(patient));
  /** The guardian-access policy whose band holds the patient's age today. Bands don't overlap. */
  const band = (patient: string) => {
    const age = ageAt(w.birthDate(patient), w.now);
    if (age === undefined) return undefined;
    return doc.policies.find((x: any) => x.type === "guardian-access" && (x.when.age.min === undefined || age >= x.when.age.min) && (x.when.age.max === undefined || age <= x.when.age.max)) as any;
  };
  /** A guardian sees a study only if the band knows every label on it, and excepts none. */
  const guardianSees = (patient: string, s: RefStudy) => {
    const b = band(patient);
    if (!b) return false;
    const labels = (s.labels ?? []).map(l => l.trim().toLowerCase());
    return labels.every(l => (b.knownLabels ?? []).includes(l) || (b.except ?? []).includes(l)) && !labels.some(l => (b.except ?? []).includes(l));
  };
  const sharingRoles = () => new Set(doc.policies.filter((x: any) => x.type === "sharing").flatMap((x: any) => x.allowedFrom as string[]));

  /**
   * What one of a user's own routes reaches, and whether a sharing policy lets them share it. A route is
   * "self", being the patient, or the id of their guardian relationship with the patient.
   */
  function ownVia(user: string, patient: string, route: string): { s: RefStudy; shareable: boolean }[] {
    const roles = sharingRoles();
    if (route === SELF) return isPatient(user, patient) ? ofPatient(patient).map(s => ({ s, shareable: roles.has("patient") })) : [];
    const rel = doc.relationships.find(r => r.id === route && r.subject === u(user) && r.relation === "guardian_of" && r.object === p(patient));
    if (!rel) return [];
    return ofPatient(patient).filter(s => guardianSees(patient, s)).map(s => ({ s, shareable: roles.has("guardian") }));
  }
  /** A user's own routes to a patient: being the patient, and their guardian relationship, by id. */
  const ownRoutes = (user: string, patient: string) => [...(isPatient(user, patient) ? [SELF] : []), ...(guardianRow(user, patient)?.id ? [guardianRow(user, patient)!.id!] : [])];
  /** Every route a user holds to a patient, from the rows: their own, and each share with them, by id. */
  const routes = (user: string, patient: string) => [...ownRoutes(user, patient), ...doc.shares.filter(x => x.with === u(user) && x.patient === p(patient) && x.id).map(x => x.id!)];
  /** What a share reaches: what its sharer sees through the one route it records, in a role they may share in, at the sites shared. */
  const shareReach = (sh: Share) => sh.basis === undefined ? [] : ownVia(sh.from.slice("user:".length), sh.patient.slice("patient:".length), sh.basis).filter(x => x.shareable && sh.sites.includes(x.s.site ?? "")).map(x => x.s);
  /** What one route of a user's reaches. A route that isn't theirs, or names no row, reaches nothing. */
  function reachVia(user: string, patient: string, route: string): RefStudy[] {
    const sh = doc.shares.find(x => x.id === route && x.with === u(user) && x.patient === p(patient));
    return sh ? shareReach(sh) : ownVia(user, patient, route).map(x => x.s);
  }

  /** What a user sees in their own right, and in which roles. */
  const own = (user: string, patient: string) => ownRoutes(user, patient).flatMap(r => ownVia(user, patient, r));
  /** Everything a user reaches of a patient's, before any app approval, through every route or only those named. */
  function userReach(user: string, patient: string, through?: string[]): RefStudy[] {
    const held = routes(user, patient).filter(r => !through || through.includes(r));
    const ids = new Set(held.flatMap(r => reachVia(user, patient, r).map(s => s.id)));
    return ofPatient(patient).filter(s => ids.has(s.id));
  }
  const approvalOf = (user: string, app: string, patient: string) => doc.approvals.find(x => x.by === u(user) && x.app === `app:${app}` && x.patient === p(patient));
  /** What an app a user approved reaches: only through the routes the approval records, at its sites. No approval reaches nothing. */
  function appReach(user: string, app: string, patient: string): RefStudy[] {
    const a = approvalOf(user, app, patient);
    if (!a) return [];
    return userReach(user, patient, a.basis ?? []).filter(s => !a.sites || a.sites.includes(s.site ?? "") || !!a.studies?.includes(s.id));
  }
  /** Whether a user holds any record of a patient: as the patient, a covered guardian, or a share whose sharer a sharing policy lets share through its route. */
  const holds = (user: string, patient: string) => isPatient(user, patient) || (!!guardianRow(user, patient) && !!band(patient))
    || doc.shares.some(x => x.with === u(user) && x.patient === p(patient) && x.basis !== undefined && (x.basis === SELF ? isPatient(x.from.slice(5), patient) && sharingRoles().has("patient") : !!band(patient) && sharingRoles().has("guardian") && doc.relationships.some(r => r.id === x.basis && r.subject === x.from)));
  /** The sites a person may name to someone else: those of what they see in their own right. */
  const nameableSites = (user: string, patient: string) => [...new Set(own(user, patient).map(x => x.s.site).filter(Boolean) as string[])];
  /** The sites a person may give an app: those of everything they reach. */
  const approvableSites = (user: string, patient: string) => [...new Set(userReach(user, patient).map(s => s.site).filter(Boolean) as string[])];

  /** The route a new share from this person records: being the patient if a sharing policy lets patients share or they're no guardian, else their guardian relationship. */
  const shareBasis = (from: string, patient: string) => isPatient(from, patient) && (sharingRoles().has("patient") || !guardianRow(from, patient)) ? SELF : guardianRow(from, patient)?.id;
  /** The routes a new approval records: every route its user holds now. */
  const approvalBasis = (user: string, patient: string) => routes(user, patient);

  const servicePolicies = (service: string, patient: string) => doc.policies.filter((x: any) => x.type === "service-access" && x.service === `service:${service}` && (x.patients === "any" || x.patients === p(patient))) as any[];
  /** What a backend service reaches: any of its policies' allow, unless that policy withholds every series. */
  function serviceReach(service: string, patient: string): RefStudy[] {
    const ps = servicePolicies(service, patient);
    return ofPatient(patient).filter(s => ps.some(x => {
      const a = x.allow;
      if (!(a.all || a.sites || a.studies || a.modalities || a.since)) return false;
      if (a.sites && !a.sites.includes(s.site ?? "")) return false;
      if (a.studies && !a.studies.includes(s.id)) return false;
      if (a.modalities && !s.modalities.some(m => a.modalities.includes(m))) return false;
      if (a.since && (s.date ?? "") < a.since.replaceAll("-", "")) return false;
      return !s.seriesUids.every(uid => (x.withholdSeries ?? []).includes(uid));
    }));
  }
  /** Whether a service may search a patient at all. */
  const serviceMaySearch = (service: string, patient: string) => servicePolicies(service, patient).length > 0;

  return { userReach, appReach, holds, nameableSites, approvableSites, serviceReach, serviceMaySearch, band, routes, shareBasis, approvalBasis };
}

/**
 * A document after rows were deleted from it: every share whose route is gone goes, then every approval
 * none of whose routes remains. It reads ids alone: being the patient always remains, and policies,
 * ages and the clock don't count.
 */
export function cascade<D extends Pick<PolicyDocument, "relationships" | "shares" | "approvals">>(doc: D): D {
  const rels = new Set(doc.relationships.flatMap(r => r.id ? [r.id] : []));
  const shares = doc.shares.filter(s => s.basis === SELF || (s.basis !== undefined && rels.has(s.basis)));
  const shareIds = new Set(shares.flatMap(s => s.id ? [s.id] : []));
  const approvals = doc.approvals.filter(a => (a.basis ?? []).some(b => b === SELF || rels.has(b) || shareIds.has(b)));
  return { ...doc, shares, approvals };
}
export type ReferenceModel = ReturnType<typeof referenceModel>;
