// The clinical FHIR server's read surface, beside the Authorization Server: who the patient is, and the
// active allergies, conditions and medications an app shows next to the images. A small fixed record
// from data/clinical.json, all of it invented, and enough for an app to work as it would against an EHR.
import { scopeAllows } from "@smart-imaging-proxy/core";
import patientFile from "../data/patient.json";
import clinicalFile from "../data/clinical.json";

interface Row { id: string; text: string; status: string; }
type Search = { status: number; body?: unknown };

export const CLINICAL_TYPES = ["AllergyIntolerance", "Condition", "MedicationRequest"] as const;
type ClinicalType = (typeof CLINICAL_TYPES)[number];
export const isClinicalType = (t: string): t is ClinicalType => (CLINICAL_TYPES as readonly string[]).includes(t);

const clinical = clinicalFile as unknown as Record<string, Partial<Record<ClinicalType, Row[]>>>;
const onFile = new Map([patientFile, ...patientFile.otherPatients].map(p => [p.id, p as { id: string; mrn: string; birthDate?: string; gender?: string }]));

/** Whether a scope string lets an app search (`s`, the default) or read (`r`) this type for its patient: SMART v2's permissions, or v1's `.read`, by name or `*`. */
export function hasClinicalScope(scope: string, type: string, op: "r" | "s" = "s"): boolean {
  return scopeAllows(scope, "patient", type, op);
}

/** The types an app's patient-level scope can reach here: imaging and its reports, who the patient is, and the clinical record. */
export const IMAGING_TYPES = ["ImagingStudy", "DiagnosticReport", "Patient"] as const;
const HONORED = new Set<string>([...IMAGING_TYPES, ...CLINICAL_TYPES]);
const CONTEXT_SCOPES = new Set(["launch/patient", "online_access", "offline_access"]);

/** Whether a requested scope asks for the clinical record: its types by name, or `patient/*`. */
export const asksClinical = (scope: string) => scope.split(" ").some(s => /^patient\/\*\./.test(s) || CLINICAL_TYPES.some(t => s.startsWith(`patient/${t}.`)));

/**
 * The scope a sign-in grants: what was asked, less what this server doesn't honor, and less the clinical
 * record if the person didn't share it. Reads and searches only, in the form they were asked (v2's `.cruds`
 * becomes `.rs`); `patient/*` without the clinical record becomes the types still shared, by name. An
 * `openid` or `fhirUser` is left out, since no id_token is issued.
 */
export function grantedScope(requested: string, o: { clinical: boolean }): string {
  const out: string[] = [];
  const add = (s: string) => { if (!out.includes(s)) out.push(s); };
  for (const s of requested.split(" ").filter(Boolean)) {
    if (CONTEXT_SCOPES.has(s)) { add(s); continue; }
    const m = s.match(/^patient\/([A-Za-z]+|\*)\.(.+)$/);
    if (!m) continue;
    const [, type, perm] = m as unknown as [string, string, string];
    const read = perm === "read" || perm === "*" ? "read" : /^c?r?u?d?s?$/.test(perm) ? perm.replace(/[cud]/g, "") : "";
    if (!read) continue;
    if (type === "*") { if (o.clinical) add(`patient/*.${read}`); else for (const t of IMAGING_TYPES) add(`patient/${t}.${read}`); continue; }
    if (!HONORED.has(type) || (!o.clinical && isClinicalType(type))) continue;
    add(`patient/${type}.${read}`);
  }
  return out.join(" ");
}

export const patientOnFile = (id: string) => onFile.get(id);
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

/** The clinical FHIR server's CapabilityStatement: its reads and searches, and SMART's OAuth endpoints. */
export function clinicalCapability(base: string, issuer: string, extra: unknown[] = []) {
  const patientParam = { name: "patient", type: "reference", documentation: "Required: the token's own patient, as an id, Patient/id, or that reference on this base." };
  const status = (name: string) => ({ name, type: "token", documentation: "A comma means any of the values." });
  return {
    resourceType: "CapabilityStatement", status: "active", date: "2026-11-10", kind: "instance", fhirVersion: "4.0.1", format: ["json"],
    implementation: { description: "Clinical FHIR server: the patient's record, beside the Authorization Server. Read-only.", url: base },
    rest: [{
      mode: "server",
      security: {
        service: [{ coding: [{ system: "http://hl7.org/fhir/restful-security-service", code: "SMART-on-FHIR" }] }],
        extension: [{ url: "http://fhir-registry.smarthealthit.org/StructureDefinition/oauth-uris", extension: [{ url: "authorize", valueUri: `${issuer}/authorize` }, { url: "token", valueUri: `${issuer}/token` }, { url: "revoke", valueUri: `${issuer}/revoke` }] }],
        description: "SMART App Launch and Backend Services. Discovery is at .well-known/smart-configuration on this base.",
      },
      resource: [
        { type: "Patient", interaction: [{ code: "read" }] },
        { type: "Condition", interaction: [{ code: "search-type" }], searchParam: [patientParam, status("clinical-status")] },
        { type: "AllergyIntolerance", interaction: [{ code: "search-type" }], searchParam: [patientParam, status("clinical-status")] },
        { type: "MedicationRequest", interaction: [{ code: "search-type" }], searchParam: [patientParam, status("status")] },
        { type: "DiagnosticReport", interaction: [{ code: "read" }, { code: "search-type" }], searchParam: [patientParam], documentation: "A report is available only when the study it describes is released to the token." },
        { type: "Binary", interaction: [{ code: "read" }], documentation: "A report's attachments, at the URLs in presentedForm." },
        ...extra,
      ],
    }],
  };
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
