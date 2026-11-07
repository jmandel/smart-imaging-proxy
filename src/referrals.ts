// The work a backend service starts from: a consult referral for each sample study with an accession
// number, made from the catalog. The referral's `subject` is an absolute reference to the patient on
// the clinical FHIR server, and its `supportingInfo` cites the imaging report, which carries the
// order's accession number with its system. Each comes as a collection Bundle, as a referral packet would.
import type { CatalogStore, CatalogStudy } from "@smart-imaging-proxy/core";
import { PATIENT_NAMES } from "./auth-server";

export interface Referral { id: string; study: string; bundle: any; }

/** Sentence case for a title in capitals, keeping short abbreviations, such as CT or H&E, as they are. */
const WORDS = new Set(["and", "with", "of", "the", "for", "to", "in", "on", "lt", "rt"]);
const sentenceCase = (s: string) => {
  if (s !== s.toUpperCase()) return s;
  const out = s.split(/(\s+|,|\/|\()/).map(w => /^[A-Z&]{1,3}$/.test(w) && !WORDS.has(w.toLowerCase()) ? w : w.toLowerCase()).join("");
  return out.replace(/^[a-z]/, c => c.toUpperCase());
};
const isoDate = (d?: string) => d && /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : undefined;
/** The study's title as a report would read it. */
export const reportTitle = (s: Pick<CatalogStudy, "title" | "description" | "id">) => sentenceCase(s.title ?? s.description ?? s.id);

export function referralFor(study: CatalogStudy, clinicalFhir: string, accessionSystem: string): Referral | undefined {
  if (!study.accession) return undefined;
  const patient = `${clinicalFhir}/Patient/${study.patient}`;
  const report = `report-${study.id}`, id = `referral-${study.id}`;
  const first = (PATIENT_NAMES[study.patient] ?? study.patient).split(" ")[0];
  const title = reportTitle(study);
  const accession = { type: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v2-0203", code: "ACSN" }] }, system: accessionSystem, value: study.accession };
  return {
    id, study: study.id,
    bundle: {
      resourceType: "Bundle", type: "collection", id,
      entry: [
        { fullUrl: `${clinicalFhir}/ServiceRequest/${id}`, resource: {
          resourceType: "ServiceRequest", id, status: "active", intent: "order",
          category: [{ coding: [{ system: "http://snomed.info/sct", code: "11429006", display: "Consultation" }] }],
          code: { text: "Consultation" }, subject: { reference: patient, display: PATIENT_NAMES[study.patient] },
          reasonCode: [{ text: `Please see ${first} about the study ${title}` }],
          supportingInfo: [{ reference: `${clinicalFhir}/DiagnosticReport/${report}`, display: title }],
          ...(isoDate(study.date) ? { authoredOn: isoDate(study.date) } : {}),
        } },
        { fullUrl: `${clinicalFhir}/DiagnosticReport/${report}`, resource: {
          resourceType: "DiagnosticReport", id: report, status: "final",
          category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/v2-0074", code: "RAD" }] }],
          code: { text: title }, subject: { reference: patient },
          basedOn: [{ type: "ServiceRequest", identifier: accession }],
          identifier: [accession],
          ...(isoDate(study.date) ? { effectiveDateTime: isoDate(study.date) } : {}),
          ...(study.site ? { performer: [{ display: study.site }] } : {}),
        } },
      ],
    },
  };
}

/** Every referral the catalog's studies make, newest first. */
export const referralsFrom = (catalog: CatalogStore, clinicalFhir: string) =>
  catalog.allStudies().sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "")).flatMap(s => referralFor(s, clinicalFhir, catalog.accessionSystem ?? "") ?? []);

/** What a service reads from a referral to find the study: the patient reference, and the cited report's accession. */
export function citedBy(bundle: any) {
  const sr = bundle.entry.find((e: any) => e.resource.resourceType === "ServiceRequest")?.resource;
  const cited = sr?.supportingInfo?.[0]?.reference;
  const report = bundle.entry.find((e: any) => e.fullUrl === cited)?.resource;
  const accession = report?.identifier?.find((i: any) => i.type?.coding?.some((c: any) => c.code === "ACSN"));
  return { patientRef: sr?.subject?.reference as string | undefined, reason: sr?.reasonCode?.[0]?.text as string | undefined, report: report?.code?.text as string | undefined, system: accession?.system as string | undefined, accession: accession?.value as string | undefined };
}
