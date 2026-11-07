// The policy API and the three-level model behind it, through the client and as raw HTTP, against one
// Imaging Server and its store. A parent is guardian of a child of 10, a teenager of 15, and an adult.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createCatalog, createImagingServer, createPolicyClient, type OrgPolicy, PolicyApiError, PolicyStore, type Relationship } from "../src";
import { manualClock, put, recordingObserver } from "./support";

const SECRET = "s3cret", POLICY_SECRET = "p0licy";
const CONFIDENTIAL = "confidential-adolescent";
const catalog = createCatalog();
put(catalog, "1.1", { site: "Site A" }, "pat");
put(catalog, "2.1", { site: "Site B" }, "pat");
put(catalog, "3.1", { site: "Site C", labels: [CONFIDENTIAL] }, "kid");
put(catalog, "4.1", { site: "Site D" }, "kid");
put(catalog, "5.1", { site: "Site C", labels: [CONFIDENTIAL] }, "teen");
put(catalog, "6.1", { site: "Site D" }, "teen");
put(catalog, "7.1", { site: "Site D" }, "adult");
const BIRTH: Record<string, string> = { pat: "1980-05-05", kid: "2016-01-01", teen: "2011-01-01", adult: "1990-01-01" };
const NAMES: Record<string, string> = { "user:parent": "Parent", "user:pat": "Pat", "user:sitter": "Sitter", "patient:teen": "Teen", "patient:kid": "Kid", "app:viewer": "the Viewer", "label:confidential-adolescent": "confidential adolescent care" };
const guardian = (p: string): Relationship => ({ subject: "user:parent", relation: "guardian_of", object: `patient:${p}`, recordedBy: "registration" });
const UNDER_13: OrgPolicy = { id: "guardians-under-13", type: "guardian-access", when: { age: { max: 12 } }, allow: "all" };
const TEENS: OrgPolicy = { id: "guardians-13-to-17", type: "guardian-access", when: { age: { min: 13, max: 17 } }, allow: "all", except: [CONFIDENTIAL] };
const SHARING: OrgPolicy = { id: "patients-and-guardians-share", type: "sharing", allowedFrom: ["patient", "guardian"] };
const REFERRAL: OrgPolicy = { id: "referral", type: "service-access", service: "service:referral", patients: "patient:pat", allow: { sites: ["Site B"] } };
const store = new PolicyStore({ mode: "memory", onFile: { relationships: ["kid", "teen", "adult"].map(guardian), policies: [UNDER_13, TEENS, SHARING] } });
const recorder = recordingObserver();
const clock = manualClock(Date.UTC(2026, 10, 7) / 1000);
const TOKENS: Record<string, any> = {
  "parent-teen": { client_id: "viewer", sub: "parent", fhirUser: "RelatedPerson/parent", patient: "teen", scope: "patient/ImagingStudy.rs" },
  "parent-kid": { client_id: "viewer", sub: "parent", fhirUser: "RelatedPerson/parent", patient: "kid", scope: "patient/ImagingStudy.rs" },
  "sitter-teen": { client_id: "viewer", sub: "sitter", fhirUser: "RelatedPerson/sitter", patient: "teen", scope: "patient/ImagingStudy.rs" },
  referral: { client_id: "referral", scope: "system/ImagingStudy.rs" },
};
const imaging = createImagingServer({
  base: "http://imaging.test/fhir", clinicalFhirBase: "http://clinical.test/fhir", proxyBase: () => "http://proxy.test",
  introspect: async t => TOKENS[t] ? { active: true, exp: clock.now() + 3600, ...TOKENS[t] } : { active: false },
  patientOf: u => ({ pat: "pat" } as Record<string, string>)[u], patientAttributes: p => ({ birthDate: BIRTH[p] }), name: r => NAMES[r] ?? r,
  serviceSecret: SECRET, policySecret: POLICY_SECRET, catalog: () => catalog, keyStore: store, store: () => store, observer: recorder.observer, clock,
});
const http = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: imaging.fetch });
const base = `http://127.0.0.1:${http.port}`;
const policy = createPolicyClient({ base, policySecret: POLICY_SECRET });
const raw = (path: string, init: RequestInit = {}, secret = POLICY_SECRET) => fetch(`${base}/policy/v2${path}`, { ...init, headers: { Authorization: `Bearer ${secret}`, "content-type": "application/json", ...init.headers } });
const approveViewer = (patient: string, sites?: string[]) => policy.approveApp({ by: "user:parent", app: "app:viewer", patient: `patient:${patient}`, fhirUser: "RelatedPerson/parent", ...(sites ? { sites } : {}) });
const explain = (patient: string, user = "parent") => policy.explain({ client: "viewer", user, fhirUser: `RelatedPerson/${user}`, patient });
const released = (x: any) => Object.fromEntries(x.studies.map((s: any) => [s.id, s.release]));
const search = async (token: string, patient: string) => {
  const r = await imaging.fetch(new Request(`http://imaging.test/fhir/ImagingStudy?patient=${patient}`, { headers: { Authorization: `Bearer ${token}` } }));
  return r.status === 200 ? ((await r.json()) as any).entry?.filter((e: any) => e.resource.resourceType === "ImagingStudy").map((e: any) => e.resource.id).sort() ?? [] : r.status;
};
const decide = async (token: string, study: string) => {
  const r = await imaging.fetch(new Request("http://imaging.test/access/v1/evaluation", { method: "POST", headers: { Authorization: `Bearer ${SECRET}` }, body: JSON.stringify({ subject: { type: "smart_bearer_token", id: "x", properties: { access_token: token } }, resource: { type: "dicom_study", id: study }, action: { name: "retrieve" } }) }));
  return (await r.json()) as any;
};
afterAll(() => { http.stop(true); store.close(); catalog.close(); });
beforeEach(() => { store.resetAll(); clock.reset(); });

describe("the API", () => {
  test("needs the policy credential on every call, and refuses the proxy's service credential", async () => {
    for (const [path, method] of [["/document", "GET"], ["/policies/x", "PUT"], ["/shares", "POST"], ["/reset", "POST"], ["/nothing", "GET"]]) {
      expect((await raw(path!, { method }, "wrong")).status).toBe(401);
      expect((await raw(path!, { method }, SECRET)).status).toBe(401);
      expect((await fetch(`${base}/policy/v2${path}`, { method })).status).toBe(401);
    }
    expect((await raw("/document", {}, POLICY_SECRET)).status).toBe(200);
    expect((await fetch(`${base}/policy/v1/policy`, { headers: { Authorization: `Bearer ${POLICY_SECRET}` } })).status).toBe(404);
    expect(recorder.spans.filter(s => s.kind === "server" && s.name.startsWith("GET /policy/v2")).every(s => s.service === "policy")).toBe(true);
  });
  test("an empty filter from the client means no filter", async () => {
    const sent: string[] = [];
    const client = createPolicyClient({ base, policySecret: POLICY_SECRET, fetch: (_op, url, init) => { sent.push(url); return fetch(url, init); } });
    await client.removeShares({ with: "user:sitter", from: "user:parent", patient: "" });
    expect(new URL(sent[0]!).searchParams.has("patient")).toBe(false);
  });
  test("refuses a bad document whole, naming each problem, and raises no revision", async () => {
    const before = await policy.getDocument();
    const e = await policy.setDocument({ policies: [{ id: "", type: "sharing", allowedFrom: [] } as any], shares: [{ from: "parent" } as any] }).catch(x => x);
    expect(e).toBeInstanceOf(PolicyApiError);
    expect(e.status).toBe(400);
    expect(e.errors).toEqual(expect.arrayContaining(["policies[0].id must be a non-empty string", "policies[0].allowedFrom must list patient, guardian, or both", "shares[0].from must be a reference, user:id"]));
    expect((await raw("/document", { method: "PUT", body: "{not json" })).status).toBe(400);
    expect((await raw("/policies", { method: "PUT", body: "[]" })).status).toBe(400);
    expect((await raw("/policies/x", { method: "PUT", body: JSON.stringify({ ...SHARING }) })).status).toBe(400);
    expect(await policy.getDocument()).toEqual(before);
  });
  test("every list, put and delete answers with its revisions", async () => {
    const p0 = store.policyRevision();
    expect(await policy.putPolicy(REFERRAL)).toEqual({ policy: p0 + 1 });
    expect((await policy.policies("service-access")).map(p => p.id)).toEqual(["referral"]);
    expect(await policy.replacePolicies("service-access", [])).toEqual({ policy: p0 + 2 });
    expect(await policy.removePolicy("referral")).toBeUndefined();
    const rel = { subject: "user:sitter", relation: "guardian_of", object: "patient:kid" };
    const r1 = await policy.putRelationship(rel);
    expect(r1).toEqual({ policy: p0 + 2, patient: store.patientRevision("patient:kid") });
    expect(await policy.relationships()).toContainEqual(rel);
    expect((await policy.removeRelationship(rel))!.patient).toBe(r1.patient! + 1);
    expect(await policy.removeRelationship(rel)).toBeUndefined();
    const shared = await policy.share({ from: "user:pat", with: "user:sitter", patient: "patient:pat", sites: ["Site A"], label: "caregiver" });
    expect(shared).toMatchObject({ ok: true, revision: { patient: store.patientRevision("patient:pat") } });
    expect(await policy.shares()).toEqual([{ from: "user:pat", with: "user:sitter", patient: "patient:pat", sites: ["Site A"], label: "caregiver" }]);
    expect(await policy.removeShares({ with: "user:sitter", from: "user:pat" })).toMatchObject({ patient: store.patientRevision("patient:pat") });
    expect(await policy.setSettings({ maxSeriesInContext: 3 })).toEqual({ policy: p0 + 3 });
    expect((await policy.getSettings()).maxSeriesInContext).toBe(3);
  });
  test("a reset clears choices and settings, and puts facts and policy back as they are on file", async () => {
    await approveViewer("teen");
    await policy.putPolicy(REFERRAL);
    await policy.removeRelationship(guardian("teen"));
    store.putToken("t", "access", { client_id: "c", scope: "s" });
    await policy.reset();
    expect(await policy.approvals()).toEqual([]);
    expect((await policy.policies()).map(p => p.id)).toEqual([UNDER_13.id, TEENS.id, SHARING.id]);
    expect(await policy.relationships()).toContainEqual(guardian("teen"));
    expect(store.getToken("t", "access")).toBeDefined();
    await policy.reset({ tokens: true });
    expect(store.getToken("t", "access")).toBeUndefined();
    expect((await raw("/reset", { method: "POST", body: JSON.stringify({ everything: true }) })).status).toBe(400);
  });
});

describe("guardian-access, by age band", () => {
  test("a guardian of a child under 13 sees every study, the confidential one too", async () => {
    await approveViewer("kid");
    expect(released(await explain("kid"))).toEqual({ "study-3.1": "study", "study-4.1": "study" });
    expect(await search("parent-kid", "kid")).toEqual(["study-3.1", "study-4.1"]);
    expect((await decide("parent-kid", "3.1")).decision).toBe(true);
  });
  test("a guardian of a 15-year-old sees everything but what's labeled confidential, at search, decision and explain", async () => {
    await approveViewer("teen");
    const x = await explain("teen");
    expect(released(x)).toEqual({ "study-5.1": "none", "study-6.1": "study" });
    expect(await search("parent-teen", "teen")).toEqual(["study-6.1"]);
    expect((await decide("parent-teen", "5.1")).decision).toBe(false);
    expect((await decide("parent-teen", "6.1")).decision).toBe(true);
    const hidden = x.studies.find((s: any) => s.id === "study-5.1");
    expect(hidden.because).toEqual([
      { level: "fact", ref: "user:parent", text: "Parent is Teen's guardian" },
      { level: "policy", ref: "policy:guardians-13-to-17", text: "Guardians of patients 13 to 17 see all studies, except those labeled confidential adolescent care" },
      { level: "fact", ref: "study:study-5.1", text: "Labeled confidential adolescent care" },
    ]);
    expect(hidden.why).toContain("guardians-13-to-17");
    expect(x.studies.find((s: any) => s.id === "study-6.1").because.map((b: any) => b.level)).toEqual(["fact", "policy", "choice"]);
    expect(x.studies.find((s: any) => s.id === "study-6.1").because[2]).toEqual({ level: "choice", ref: "approval:user:parent:app:viewer:patient:teen", text: "Parent approved the Viewer for all sites" });
  });
  test("past the top of every band, a guardian sees nothing, and a choice for that patient is refused naming the policy", async () => {
    const r = await approveViewer("adult");
    expect(r).toEqual({ ok: false, refusal: { error: expect.stringContaining("no guardian-access policy covers patients aged 36"), policy: "guardians-under-13" } });
    expect(released(await explain("adult"))).toEqual({ "study-7.1": "none" });
  });
  test("age is worked out at check time, by the clock: on turning 18, the teen band stops applying", async () => {
    await approveViewer("teen");
    expect(await search("parent-teen", "teen")).toEqual(["study-6.1"]);
    // 2029-01-01 is the 18th birthday.
    clock.advance(Date.UTC(2029, 0, 1) / 1000 - clock.now());
    expect(await search("parent-teen", "teen")).toEqual([]);
    expect((await decide("parent-teen", "6.1")).decision).toBe(false);
    expect((await explain("teen")).studies[0].why).toBe("no guardian-access policy covers patients aged 18");
    clock.advance(-1);
    expect(await search("parent-teen", "teen")).toEqual(["study-6.1"]);
  });
  test("a fact alone grants nothing: with no guardian-access policy, the guardian sees nothing", async () => {
    await approveViewer("kid");
    await policy.replacePolicies("guardian-access", []);
    expect(released(await explain("kid"))).toEqual({ "study-3.1": "none", "study-4.1": "none" });
    expect(await search("parent-kid", "kid")).toEqual([]);
  });
});

describe("sharing", () => {
  test("a guardian's share narrows to what they may see, and can't reach the confidential study however it's written", async () => {
    const r = await policy.share({ from: "user:parent", with: "user:sitter", patient: "patient:teen", sites: ["Site C", "Site D"], label: "sitter" });
    expect(r).toMatchObject({ ok: true, share: { sites: ["Site D"] } });
    await policy.approveApp({ by: "user:sitter", app: "app:viewer", patient: "patient:teen", fhirUser: "RelatedPerson/sitter" });
    expect(await search("sitter-teen", "teen")).toEqual(["study-6.1"]);
    // A share stored past the sharer's access still gives no more than they have.
    store.putShare({ from: "user:parent", with: "user:sitter", patient: "patient:teen", sites: ["Site C", "Site D"], label: "sitter" });
    expect(await search("sitter-teen", "teen")).toEqual(["study-6.1"]);
    const x = await explain("teen", "sitter");
    const hidden = x.studies.find((s: any) => s.id === "study-5.1");
    expect(hidden.release).toBe("none");
    expect(hidden.why).toContain("Parent can't see this study, so their share can't include it");
    expect(hidden.because.map((b: any) => b.level)).toEqual(["fact", "policy", "fact", "policy", "choice"]);
    expect(x.studies.find((s: any) => s.id === "study-6.1").because.map((b: any) => b.level)).toEqual(["fact", "policy", "policy", "choice", "choice"]);
  });
  test("a share ends when the sharer stops being a guardian", async () => {
    await policy.share({ from: "user:parent", with: "user:sitter", patient: "patient:teen", sites: ["Site D"], label: "sitter" });
    await policy.approveApp({ by: "user:sitter", app: "app:viewer", patient: "patient:teen", fhirUser: "RelatedPerson/sitter" });
    expect(await search("sitter-teen", "teen")).toEqual(["study-6.1"]);
    await policy.removeRelationship(guardian("teen"));
    expect(await search("sitter-teen", "teen")).toEqual([]);
  });
  test("a share policy doesn't allow is refused, naming the policy", async () => {
    await policy.putPolicy({ ...SHARING, allowedFrom: ["patient"] } as OrgPolicy);
    expect(await policy.share({ from: "user:parent", with: "user:sitter", patient: "patient:teen", sites: ["Site D"], label: "sitter" })).toEqual({ ok: false, refusal: { error: "no sharing policy lets guardians share", policy: SHARING.id } });
    expect(await policy.share({ from: "user:sitter", with: "user:pat", patient: "patient:teen", sites: ["Site D"], label: "x" })).toMatchObject({ ok: false, refusal: { policy: SHARING.id } });
    expect((await raw("/shares", { method: "POST", body: JSON.stringify({ from: "user:parent", with: "user:sitter", patient: "patient:teen", sites: [], label: "sitter" }) })).status).toBe(403);
    expect(await policy.share({ from: "user:pat", with: "user:sitter", patient: "patient:pat", sites: ["Site A", "Site Z"], label: "friend" })).toMatchObject({ ok: true, share: { sites: ["Site A"] } });
    expect(await policy.shares()).toEqual([{ from: "user:pat", with: "user:sitter", patient: "patient:pat", sites: ["Site A"], label: "friend" }]);
  });
});

describe("app approvals", () => {
  test("narrow to what the user holds, and all of it is no limit", async () => {
    expect(await approveViewer("kid", ["Site C", "Site Z"])).toMatchObject({ ok: true, approval: { sites: ["Site C"] } });
    expect(await search("parent-kid", "kid")).toEqual(["study-3.1"]);
    expect(await approveViewer("kid", ["Site C", "Site D"])).toMatchObject({ ok: true, approval: { by: "user:parent", app: "app:viewer", patient: "patient:kid" } });
    expect((await policy.approvals())[0]!.sites).toBeUndefined();
    expect(await search("parent-kid", "kid")).toEqual(["study-3.1", "study-4.1"]);
    expect(await policy.removeApprovals({ by: "user:parent", app: "app:viewer", patient: "patient:kid" })).toBeDefined();
    expect(await search("parent-kid", "kid")).toEqual([]);
    expect(await policy.removeApprovals({ by: "user:parent", app: "app:viewer" })).toBeUndefined();
  });
  test("for a patient the user holds no record of, are refused naming the policy", async () => {
    expect(await policy.approveApp({ by: "user:sitter", app: "app:viewer", patient: "patient:teen", fhirUser: "RelatedPerson/sitter" })).toMatchObject({ ok: false, refusal: { policy: "sharing" } });
  });
});

describe("service-access", () => {
  test("decides a backend service's access from policy alone, with no choices in its chain", async () => {
    expect(await search("referral", "pat")).toBe(403);
    await policy.putPolicy(REFERRAL);
    expect(await search("referral", "pat")).toEqual(["study-2.1"]);
    expect((await decide("referral", "1.1")).decision).toBe(false);
    const x = await policy.explain({ client: "referral", patient: "pat" });
    expect(x.searchAllowed).toBe(true);
    for (const s of x.studies) expect(s.because).toEqual([{ level: "policy", ref: "policy:referral", text: "service:referral may see patient:pat's studies at Site B" }]);
    await policy.putPolicy({ ...REFERRAL, withdrawn: true } as OrgPolicy);
    expect(await search("referral", "pat")).toBe(403);
  });
});

describe("revisions on decisions", () => {
  test("explain and the decision call say which revisions they read", async () => {
    await approveViewer("teen");
    const x = await explain("teen");
    expect(x.revision).toEqual(store.revision("patient:teen"));
    const d = await decide("parent-teen", "6.1");
    expect(d.context).toMatchObject({ policy_revision: store.policyRevision(), patient_revision: store.patientRevision("patient:teen") });
    await policy.putPolicy(REFERRAL);
    expect((await decide("parent-teen", "6.1")).context.policy_revision).toBe(d.context.policy_revision + 1);
    expect((await decide("parent-teen", "6.1")).context.patient_revision).toBe(d.context.patient_revision);
  });
  test("a decision reads only its own patient's rows", async () => {
    await approveViewer("teen");
    const reads: string[] = [];
    const snapshot = store.patientSnapshot.bind(store);
    store.patientSnapshot = (p: string) => { reads.push(p); return snapshot(p); };
    try {
      await decide("parent-teen", "6.1");
      await search("parent-teen", "teen");
      expect(new Set(reads)).toEqual(new Set(["patient:teen"]));
    } finally { store.patientSnapshot = snapshot; }
  });
});
