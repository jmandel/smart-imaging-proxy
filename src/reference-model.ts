// A small reference model of the policy rules, written apart from core's evaluation, which the tours
// check the real system against. It reads a world's policy document and catalog at one moment, and
// says which studies each kind of caller should reach. It knows nothing of how core decides.
import type { PolicyDocument } from "@smart-imaging-proxy/core";

export interface RefStudy { id: string; patient: string; site?: string; labels?: string[]; date?: string; modalities: string[]; seriesUids: string[]; }
export interface RefWorld {
  doc: Pick<PolicyDocument, "relationships" | "policies" | "shares" | "approvals">;
  studies: RefStudy[];
  /** Seconds since the epoch. */
  now: number;
  birthDate(patient: string): string | undefined;
  /** The patient record a user account is, if any. */
  patientOf(user: string): string | undefined;
}

const u = (id: string) => `user:${id}`, p = (id: string) => `patient:${id}`;

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

export function referenceModel(w: RefWorld) {
  const { doc } = w;
  const ofPatient = (patient: string) => w.studies.filter(s => s.patient === patient);
  const isPatient = (user: string, patient: string) => w.patientOf(user) === patient;
  const isGuardian = (user: string, patient: string) => doc.relationships.some(r => r.subject === u(user) && r.relation === "guardian_of" && r.object === p(patient));
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

  /** What a user sees in their own right, and in which roles. */
  function own(user: string, patient: string) {
    const roles = sharingRoles();
    return ofPatient(patient).filter(s => isPatient(user, patient) || (isGuardian(user, patient) && guardianSees(patient, s))).map(s => ({
      s, shareable: (isPatient(user, patient) && roles.has("patient")) || (isGuardian(user, patient) && guardianSees(patient, s) && roles.has("guardian")),
    }));
  }
  /** Everything a user reaches of a patient's, before any app approval. */
  function userReach(user: string, patient: string): RefStudy[] {
    const ids = new Set(own(user, patient).map(x => x.s.id));
    for (const sh of doc.shares.filter(x => x.with === u(user) && x.patient === p(patient))) {
      const from = sh.from.slice("user:".length);
      for (const x of own(from, patient)) if (x.shareable && sh.sites.includes(x.s.site ?? "")) ids.add(x.s.id);
    }
    return ofPatient(patient).filter(s => ids.has(s.id));
  }
  /** What an app a user approved reaches. No approval reaches nothing. */
  function appReach(user: string, app: string, patient: string): RefStudy[] {
    const a = doc.approvals.find(x => x.by === u(user) && x.app === `app:${app}` && x.patient === p(patient));
    if (!a) return [];
    return userReach(user, patient).filter(s => !a.sites || a.sites.includes(s.site ?? ""));
  }
  /** Whether a user holds any record of a patient: as the patient, a covered guardian, or a share from someone a sharing policy lets share. */
  const holds = (user: string, patient: string) => isPatient(user, patient) || (isGuardian(user, patient) && !!band(patient))
    || doc.shares.some(x => x.with === u(user) && x.patient === p(patient) && (isPatient(x.from.slice(5), patient) ? sharingRoles().has("patient") : isGuardian(x.from.slice(5), patient) && sharingRoles().has("guardian")));
  /** The sites a person may name to someone else: those of what they see in their own right. */
  const nameableSites = (user: string, patient: string) => [...new Set(own(user, patient).map(x => x.s.site).filter(Boolean) as string[])];
  /** The sites a person may give an app: those of everything they reach. */
  const approvableSites = (user: string, patient: string) => [...new Set(userReach(user, patient).map(s => s.site).filter(Boolean) as string[])];

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

  return { userReach, appReach, holds, nameableSites, approvableSites, serviceReach, serviceMaySearch, band };
}
export type ReferenceModel = ReturnType<typeof referenceModel>;
