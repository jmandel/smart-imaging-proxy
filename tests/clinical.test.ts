// The clinical FHIR server's searches, and the public deployment's read-only root.
import { describe, expect, test } from "bun:test";
import { clinicalSearch, demographics, hasClinicalScope } from "../src/clinical";
import { publicRootGate } from "../src/gateway";

const BASE = "https://x.example/fhir";
const token = { patient: "josh-example", scope: "launch/patient patient/*.rs" };
const params = (s: string) => new URLSearchParams(s);
const texts = (r: any) => r.body.entry.map((e: any) => e.resource.code?.text ?? e.resource.medicationCodeableConcept?.text);

describe("clinical search", () => {
  test("clinical-status filters", () => {
    const all = clinicalSearch("Condition", params("patient=Patient/josh-example"), token, BASE);
    const active = clinicalSearch("Condition", params("patient=Patient/josh-example&clinical-status=active"), token, BASE);
    expect(all.status).toBe(200);
    expect(texts(all).length).toBeGreaterThan(texts(active).length);
  });
  test("a medication's filter is status", () => {
    const r: any = clinicalSearch("MedicationRequest", params("patient=josh-example&status=active"), token, BASE);
    expect(r.body.entry[0].resource.subject.reference).toBe(`${BASE}/Patient/josh-example`);
    expect(clinicalSearch("MedicationRequest", params("patient=josh-example&status=stopped"), token, BASE).body).toMatchObject({ total: 0 });
  });
  test("a patient with nothing on file is an empty result", () => {
    expect(clinicalSearch("Condition", params("patient=robin-example"), { patient: "robin-example", scope: "patient/*.rs" }, BASE).body).toMatchObject({ total: 0, entry: [] });
  });
  test("only the token's own patient, and only with scope", () => {
    expect(clinicalSearch("Condition", params("patient=sam-example"), token, BASE).status).toBe(403);
    expect(clinicalSearch("Condition", params(""), token, BASE).status).toBe(400);
    expect(clinicalSearch("Condition", params("patient=josh-example"), { patient: "josh-example", scope: "patient/ImagingStudy.rs" }, BASE).status).toBe(403);
    expect(clinicalSearch("Condition", params("patient=josh-example"), { scope: "patient/*.rs" }, BASE).status).toBe(403);
  });
  test("scopes", () => {
    for (const s of ["patient/Condition.rs", "patient/Condition.s", "patient/Condition.read", "patient/*.rs", "patient/*.read"]) expect(hasClinicalScope(s, "Condition")).toBe(true);
    for (const s of ["patient/Allergy.rs", "system/*.rs", "patient/Condition.r"]) expect(hasClinicalScope(s, "Condition")).toBe(false);
  });
  test("demographics come from the patient record", () => expect(demographics("josh-example")).toMatchObject({ birthDate: "1982-01-01", gender: "male" }));
});

describe("a public deployment's root", () => {
  test("is read-only, with one way to get a sandbox", () => {
    expect(publicRootGate("POST", "/api/sandbox/reset")?.status).toBe(403);
    expect(publicRootGate("POST", "/token")?.status).toBe(403);
    expect(publicRootGate("POST", "/api/sandboxes")).toBeUndefined();
    expect(publicRootGate("OPTIONS", "/token")).toBeUndefined();
  });
  test("reads pass, and pages that change things open a scope only by running a script", async () => {
    expect(publicRootGate("GET", "/")).toBeUndefined();
    expect(publicRootGate("GET", "/fhir/metadata")).toBeUndefined();
    const page = publicRootGate("GET", "/explore")!;
    expect(await page.text()).toContain('fetch("/api/sandboxes",{method:"POST"})');
  });
});
