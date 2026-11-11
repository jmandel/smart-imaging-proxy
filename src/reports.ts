// Diagnostic reports, as the clinical FHIR server gives them: one for each study, written as a hospital would,
// with a PDF and a text attachment. Everything here takes the studies already released to the token, so a report
// is reachable exactly when its images are. Invented content, and each says so.
import type { CatalogStudy } from "@smart-imaging-proxy/core";
import source from "../data/studies.source.json";
import care from "../data/care-team.json";
import people from "../data/patient.json";
import { buildReport, conclusion, type Organization, type Practitioner, type ReportInput } from "./reports/report";
import { renderText, type Doc } from "./reports/doc";
import { buildPdf } from "./reports/pdf";
import { patientOnFile } from "./clinical";
import { ACCESSION_SYSTEM } from "./config";

const definitions = new Map((source as any).studies.map((s: any) => [s.id, s]));
const person = (id: string) => (care.practitioners as Practitioner[]).find(p => p.id === id);
const fallback: Practitioner = { id: "unassigned", given: ["Sample"], family: "Clinician", role: "Radiology", organization: "" };
const given = (id: string) => id === (people as any).id ? (people as any).given : [id.split("-")[0]!.replace(/^./, c => c.toUpperCase())];

const reportId = (study: CatalogStudy) => `report-${study.id}`;
const isoDate = (d?: string) => d && /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d;

function docFor(study: CatalogStudy): { input: ReportInput; doc: Doc; signed?: string } | undefined {
  const def: any = definitions.get(study.id);
  if (!def?.report?.impression) return undefined;
  const c = def.clinical ?? {}, p = patientOnFile(study.patient);
  const encounter = (care.encounters as any[]).find(e => e.id === c.encounter);
  const facility = ((care.organizations as Organization[]).find(o => o.name === study.site) ?? { id: "site", name: study.site ?? "Sample Imaging", address: [], phone: "" }) as Organization;
  const time = study.time ? ` ${study.time.slice(0, 2)}:${study.time.slice(2, 4)}` : "";
  const doc = buildReport(def.report, {
    patient: { family: "Example", given: given(study.patient), birthDate: p?.birthDate ?? "Unknown", gender: p?.gender ?? "unknown", mrn: p?.mrn ?? "" },
    accession: study.accession ?? "", examDateTime: `${isoDate(study.date)}${time}`, location: c.location ?? encounter?.location ?? "Outpatient Imaging", equipment: def.equipment,
    series: study.series.map(s => ({ number: s.number, description: s.description || s.modality, images: s.instanceCount })),
    orderedBy: person(c.orderedBy) ?? fallback, readBy: person(c.readBy) ?? fallback, signed: c.signed ?? isoDate(study.date) ?? "", facility,
  });
  return { input: def.report, doc, signed: c.signed };
}

function resourceFor(study: CatalogStudy, fhir: string, imagingFhir: string) {
  const built = docFor(study);
  if (!built) return undefined;
  const id = reportId(study), { input } = built, pathology = input.kind === "pathology";
  const title = input.title.replace(/^SYNTHETIC:?\s*/i, "");
  return {
    resourceType: "DiagnosticReport", id, status: "final",
    category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/v2-0074", code: pathology ? "SP" : "RAD" }] }],
    code: { ...(input.code ? { coding: [input.code] } : {}), text: title },
    subject: { reference: `${fhir}/Patient/${study.patient}` },
    ...(isoDate(study.date) ? { effectiveDateTime: isoDate(study.date) } : {}),
    ...(study.accession ? { identifier: [{ type: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v2-0203", code: "ACSN" }] }, system: ACCESSION_SYSTEM, value: study.accession }] } : {}),
    conclusion: conclusion(input),
    // By the study's DICOM UID, which an ImagingStudy search's identifier takes: this server doesn't read ImagingStudy by id.
    imagingStudy: [{ type: "ImagingStudy", identifier: { system: "urn:dicom:uid", value: `urn:oid:${study.uid}` }, display: title }],
    presentedForm: [
      { contentType: "application/pdf", url: `${fhir}/Binary/${id}.pdf`, title: `${title} (PDF)` },
      { contentType: "text/plain", url: `${fhir}/Binary/${id}.txt`, title: `${title} (text)` },
    ],
  };
}

export function reportSearch(released: CatalogStudy[], fhir: string, imagingFhir: string) {
  const resources = released.flatMap(s => resourceFor(s, fhir, imagingFhir) ?? []);
  return { resourceType: "Bundle", type: "searchset", total: resources.length, entry: resources.map(r => ({ fullUrl: `${fhir}/DiagnosticReport/${r.id}`, resource: r, search: { mode: "match" } })) };
}
export function reportRead(id: string, released: CatalogStudy[], fhir: string, imagingFhir: string) {
  const study = released.find(s => reportId(s) === id);
  return study && resourceFor(study, fhir, imagingFhir);
}
export function reportAttachment(file: string, released: CatalogStudy[], _fhir: string): { bytes: Uint8Array | string; contentType: string } | undefined {
  const m = file.match(/^(.+)\.(pdf|txt)$/);
  const study = m && released.find(s => reportId(s) === m[1]);
  const built = study && docFor(study);
  if (!built) return undefined;
  return m![2] === "pdf" ? { bytes: buildPdf(built.doc), contentType: "application/pdf" } : { bytes: renderText(built.doc), contentType: "text/plain; charset=utf-8" };
}
