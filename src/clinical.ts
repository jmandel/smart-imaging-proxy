// The clinical FHIR server's read surface, beside the Authorization Server: who the patient is, and the
// active allergies, conditions and medications an app shows next to the images. A small fixed record
// from data/clinical.json, all of it invented, and enough for an app to work as it would against an EHR.
import patientFile from "../data/patient.json";
import clinicalFile from "../data/clinical.json";

interface Row { id: string; text: string; status: string; }
type Search = { status: number; body?: unknown };

export const CLINICAL_TYPES = ["AllergyIntolerance", "Condition", "MedicationRequest"] as const;
type ClinicalType = (typeof CLINICAL_TYPES)[number];
export const isClinicalType = (t: string): t is ClinicalType => (CLINICAL_TYPES as readonly string[]).includes(t);

const clinical = clinicalFile as unknown as Record<string, Partial<Record<ClinicalType, Row[]>>>;
const onFile = new Map([patientFile, ...patientFile.otherPatients].map(p => [p.id, p as { id: string; mrn: string; birthDate?: string; gender?: string }]));

/** Whether a scope string lets an app search this type for its patient: SMART v2's `.rs` or `.s`, or v1's `.read`, by name or `*`. */
export function hasClinicalScope(scope: string, type: string): boolean {
  return scope.split(" ").some(s => s === `patient/${type}.rs` || s === `patient/${type}.s` || s === `patient/${type}.read` || s === "patient/*.rs" || s === "patient/*.s" || s === "patient/*.read");
}

/** What's on file for a patient's demographics, beyond the name. */
export function demographics(id: string) {
  const p = onFile.get(id);
  return {
    ...(p?.mrn ? { identifier: [{ type: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v2-0203", code: "MR" }] }, value: p.mrn }] } : {}),
    ...(p?.gender ? { gender: p.gender } : {}),
    ...(p?.birthDate ? { birthDate: p.birthDate } : {}),
  };
}

const coded = (system: string, code: string) => ({ coding: [{ system, code }] });
function resourceOf(type: ClinicalType, row: Row, reference: string) {
  const text = { text: row.text };
  if (type === "AllergyIntolerance") return { resourceType: type, id: row.id, clinicalStatus: coded("http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical", row.status), code: text, patient: { reference } };
  if (type === "Condition") return { resourceType: type, id: row.id, clinicalStatus: coded("http://terminology.hl7.org/CodeSystem/condition-clinical", row.status), code: text, subject: { reference } };
  return { resourceType: type, id: row.id, status: row.status, intent: "order", medicationCodeableConcept: text, subject: { reference } };
}

const outcome = (code: string, diagnostics: string) => ({ resourceType: "OperationOutcome", issue: [{ severity: "error", code, diagnostics }] });

/**
 * One search, for a token already known to be live. The token's own patient is the only one it reaches.
 * `patient` is a logical id, `Patient/id`, or that reference on this server's base.
 */
export function clinicalSearch(type: ClinicalType, params: URLSearchParams, token: { patient?: string; scope: string }, base: string): Search {
  if (!token.patient || !hasClinicalScope(token.scope, type)) return { status: 403, body: outcome("forbidden", `scope does not cover ${type}`) };
  const asked = params.get("patient");
  if (!asked) return { status: 400, body: outcome("required", "the patient parameter is required") };
  const id = asked.startsWith(`${base}/Patient/`) ? asked.slice(base.length + "/Patient/".length) : asked.replace(/^Patient\//, "");
  if (id !== token.patient) return { status: 403, body: outcome("forbidden", "patient does not match the token's patient context") };
  const wanted = params.get(type === "MedicationRequest" ? "status" : "clinical-status")?.split(",");
  const rows = (clinical[id]?.[type] ?? []).filter(r => !wanted || wanted.includes(r.status));
  const reference = `${base}/Patient/${id}`;
  return { status: 200, body: {
    resourceType: "Bundle", type: "searchset", total: rows.length,
    entry: rows.map(r => ({ fullUrl: `${base}/${type}/${r.id}`, resource: resourceOf(type, r, reference), search: { mode: "match" } })),
  } };
}
