// Reports follow their studies: what an app can see of the images is what it can read about them.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { scriptedLaunch } from "../src/flows/oauth";
import { reportAttachment } from "../src/reports";
import { startStack, type Stack } from "../src/stack";

let stack: Stack;
beforeAll(async () => { stack = await startStack(join(import.meta.dir, "..")); });
afterAll(() => stack.stop());
const SCOPE = "launch/patient patient/*.rs";
const launch = (w: any, user: string, o: any = {}) => scriptedLaunch(user, "portal-app", { at: w.urls, scope: SCOPE, ...o });
const get = (u: string, t: string) => fetch(u, { headers: { authorization: `Bearer ${t}` } });
const search = async (w: any, t: string, p: string) => { const r: any = await (await get(`${w.urls.auth}/fhir/DiagnosticReport?patient=${p}`, t)).json(); return r.entry.map((e: any) => e.resource.id).sort() as string[]; };

test("every study's report renders, as PDF and text, with the right identity", () => {
  const w = stack.sandboxes.mint(), all = w.catalog.allStudies();
  expect(all.length).toBe(10);
  for (const st of all) {
    const pdf = reportAttachment(`report-${st.id}.pdf`, all, "x")!, text = reportAttachment(`report-${st.id}.txt`, all, "x")!;
    expect(new TextDecoder().decode((pdf.bytes as Uint8Array).slice(0, 5))).toBe("%PDF-");
    expect(text.bytes as string).toContain(st.patient.split("-")[0]!.toUpperCase());
    if (st.accession) expect(text.bytes as string).toContain(st.accession);
  }
});
test("a patient's own token reads all their reports, by search, read and attachment", async () => {
  const w = stack.sandboxes.mint(), t = await launch(w, "josh", { patient: "josh-example" });
  const ids = await search(w, t.access_token, "Patient/josh-example");
  expect(ids.length).toBe(6);
  const r: any = await (await get(`${w.urls.auth}/fhir/DiagnosticReport/${ids[0]}`, t.access_token)).json();
  expect(r.subject.reference).toBe(`${w.urls.auth}/fhir/Patient/josh-example`);
  expect(r.conclusion.length).toBeGreaterThan(0);
  const pdf = await get(r.presentedForm[0].url, t.access_token);
  expect(pdf.headers.get("content-type")).toBe("application/pdf");
  expect((await get(`${w.urls.auth}/fhir/DiagnosticReport?patient=sam-example`, t.access_token)).status).toBe(403);
  expect((await fetch(r.presentedForm[0].url)).status).toBe(401);
});
test("a guardian can't read a report on a study withheld from them", async () => {
  const w = stack.sandboxes.mint(), t = await launch(w, "sam-caregiver", { patient: "riley-example" });
  const ids = await search(w, t.access_token, "riley-example");
  expect(ids).toEqual(["report-syn-riley-knee-mr-2022"]);
  expect((await get(`${w.urls.auth}/fhir/DiagnosticReport/report-syn-riley-skin-slide-2023`, t.access_token)).status).toBe(404);
  expect((await get(`${w.urls.auth}/fhir/Binary/report-syn-riley-skin-slide-2023.pdf`, t.access_token)).status).toBe(404);
});
test("narrowing an approval to some sites narrows the reports too", async () => {
  const w = stack.sandboxes.mint(), t = await launch(w, "josh", { patient: "josh-example", sites: ["Lakeside Imaging"] });
  expect(await search(w, t.access_token, "josh-example")).toEqual(["report-mri-brain-2020"]);
});
test("a token without the report scope gets nothing", async () => {
  const w = stack.sandboxes.mint(), t = await launch(w, "josh", { patient: "josh-example", scope: "launch/patient patient/ImagingStudy.rs" });
  expect((await get(`${w.urls.auth}/fhir/DiagnosticReport?patient=josh-example`, t.access_token)).status).toBe(403);
});
test("no one's name collides: the clinicians aren't the patients", async () => {
  const care = (await import("../data/care-team.json")).default as any, source = (await import("../data/studies.source.json")).default as any;
  const patients = new Set(["josh-example", "sam-example", "riley-example", "robin-example"]);
  for (const p of care.practitioners) expect(patients.has(p.id)).toBe(false);
  for (const s of source.studies) for (const k of ["orderedBy", "readBy"]) if (s.clinical?.[k]) expect(care.practitioners.some((p: any) => p.id === s.clinical[k])).toBe(true);
});
