// Guardian-access bands never overlap, so one policy decides what a guardian sees at each age, and its
// labels alone decide which studies it reaches. Removing a grant, by whatever write, takes what hangs
// off it, but never an approval another route still supports.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createCatalog, createImagingServer, createPolicyClient, type OrgPolicy, PolicyApiError, PolicyStore, type Relationship, validateDocument } from "../src";
import { manualClock, put } from "./support";

const SECRET = "s3cret", POLICY_SECRET = "p0licy";
const CONF = "confidential-adolescent", REPRO = "reproductive-health";
const catalog = createCatalog();
put(catalog, "1.1", { site: "Site A" }, "teen");
put(catalog, "1.2", { site: "Site B", labels: [CONF] }, "teen");
put(catalog, "1.3", { site: "Site C", labels: [REPRO] }, "teen");
put(catalog, "2.1", { site: "Site A" }, "kid");
put(catalog, "2.2", { site: "Site B", labels: [CONF] }, "kid");
put(catalog, "3.1", { site: "Site A" }, "pat");
const BIRTH: Record<string, string> = { teen: "2011-01-01", kid: "2016-01-01", pat: "1980-05-05" };
const guardian = (p: string, who = "parent"): Relationship => ({ subject: `user:${who}`, relation: "guardian_of", object: `patient:${p}` });
const UNDER_13: OrgPolicy = { id: "guardians-under-13", type: "guardian-access", when: { age: { max: 12 } }, allow: "all", knownLabels: [CONF] };
const TEENS: OrgPolicy = { id: "guardians-13-to-17", type: "guardian-access", when: { age: { min: 13, max: 17 } }, allow: "all", except: [CONF] };
const SHARING: OrgPolicy = { id: "share", type: "sharing", allowedFrom: ["patient", "guardian"] };
const store = new PolicyStore({ mode: "memory", onFile: { relationships: [guardian("teen"), guardian("kid")], policies: [UNDER_13, TEENS, SHARING] } });
const clock = manualClock(Date.UTC(2026, 10, 7) / 1000);
const token = (sub: string, patient: string, fhirUser = `RelatedPerson/${sub}`) => ({ client_id: "viewer", sub, fhirUser, patient, scope: "patient/ImagingStudy.rs" });
const TOKENS: Record<string, any> = { "parent-teen": token("parent", "teen"), "parent-kid": token("parent", "kid"), "sitter-teen": token("sitter", "teen"), "sitter-pat": token("sitter", "pat") };
const imaging = createImagingServer({
  base: "http://imaging.test/fhir", clinicalFhirBase: "http://clinical.test/fhir", proxyBase: () => "http://proxy.test",
  introspect: async t => TOKENS[t] ? { active: true, exp: clock.now() + 3600, ...TOKENS[t] } : { active: false },
  patientOf: u => ({ pat: "pat" } as Record<string, string>)[u], patientAttributes: p => ({ birthDate: BIRTH[p] }),
  serviceSecret: SECRET, policySecret: POLICY_SECRET, catalog: () => catalog, keyStore: store, store: () => store, clock,
});
const http = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: imaging.fetch });
const base = `http://127.0.0.1:${http.port}`;
const policy = createPolicyClient({ base, policySecret: POLICY_SECRET });
const raw = (path: string, method: string, body: unknown) => fetch(`${base}/policy/v2${path}`, { method, headers: { Authorization: `Bearer ${POLICY_SECRET}`, "content-type": "application/json" }, body: JSON.stringify(body) });
const search = async (t: string, patient: string) => {
  const r = await imaging.fetch(new Request(`http://imaging.test/fhir/ImagingStudy?patient=${patient}`, { headers: { Authorization: `Bearer ${t}` } }));
  return r.status === 200 ? ((await r.json()) as any).entry?.filter((e: any) => e.resource.resourceType === "ImagingStudy").map((e: any) => e.resource.id).sort() ?? [] : r.status;
};
const approve = (by: string, patient: string) => store.putApproval({ by: `user:${by}`, app: "app:viewer", patient: `patient:${patient}` });
const share = (from: string, to: string, patient: string, sites: string[]) => store.putShare({ from: `user:${from}`, with: `user:${to}`, patient: `patient:${patient}`, sites, label: "helper" });
afterAll(() => { http.stop(true); store.close(); catalog.close(); });
beforeEach(() => { store.resetAll(); clock.reset(); });

describe("guardian-access bands", () => {
  const OTHER_TEENS: OrgPolicy = { id: "teens-repro", type: "guardian-access", when: { age: { min: 13, max: 17 } }, allow: "all", except: [REPRO] };
  test("that would overlap are refused on every write, naming both, and change nothing", async () => {
    const before = store.snapshot();
    for (const r of [await raw("/policies/teens-repro", "PUT", OTHER_TEENS), await raw("/policies?type=guardian-access", "PUT", [UNDER_13, TEENS, OTHER_TEENS]), await raw("/document", "PUT", { policies: [UNDER_13, TEENS, OTHER_TEENS, SHARING] })]) {
      expect(r.status).toBe(400);
      expect(((await r.json()) as any).errors.join(" ")).toMatch(/guardians-13-to-17 \(13 to 17\) and teens-repro \(13 to 17\) overlap/);
    }
    expect(store.snapshot()).toEqual(before);
    expect(validateDocument({ policies: [UNDER_13, { ...TEENS, when: { age: { min: 12, max: 17 } } }] })).toEqual(["policies: guardian-access policies guardians-under-13 (under 13) and guardians-13-to-17 (12 to 17) overlap"]);
    expect(() => new PolicyStore({ mode: "memory", onFile: { policies: [TEENS, OTHER_TEENS] } })).toThrow("overlap");
    expect(await policy.putPolicy({ ...OTHER_TEENS, id: "old", when: { age: { min: 100 } } }).catch(e => e)).not.toBeInstanceOf(PolicyApiError);
  });
  test("a label is unknown, and hides its study, by the one policy covering the age: naming it in another band doesn't reveal it", async () => {
    approve("parent", "teen");
    expect(await search("parent-teen", "teen")).toEqual(["study-1.1"]);
    await policy.putPolicy({ id: "centenarians", type: "guardian-access", when: { age: { min: 100 } }, allow: "all", except: [REPRO] });
    expect(await search("parent-teen", "teen")).toEqual(["study-1.1"]);
    await policy.putPolicy({ id: "adults", type: "guardian-access", when: { age: { min: 18, max: 99 } }, allow: "all", knownLabels: [REPRO, CONF] });
    expect(await search("parent-teen", "teen")).toEqual(["study-1.1"]);
  });
  test("a policy reaches a label it knows, so under 13 a guardian sees the confidential study", async () => {
    approve("parent", "kid");
    expect(await search("parent-kid", "kid")).toEqual(["study-2.1", "study-2.2"]);
  });
});

describe("a document write", () => {
  test("that removes a guardian relationship removes that guardian's shares and approvals for the patient", async () => {
    share("parent", "sitter", "teen", ["Site A"]);
    approve("sitter", "teen");
    approve("parent", "teen");
    await policy.setDocument({ relationships: [guardian("kid")] });
    expect([store.shares(), store.approvals()]).toEqual([[], []]);
    await policy.putRelationship(guardian("teen"));
    expect(await search("sitter-teen", "teen")).toEqual([]);
  });
  test("that removes a share removes the recipient's approvals that depended on it", async () => {
    share("pat", "sitter", "pat", ["Site A"]);
    approve("sitter", "pat");
    await policy.setDocument({ shares: [] });
    expect(store.approvals()).toEqual([]);
    share("pat", "sitter", "pat", ["Site A"]);
    expect(await search("sitter-pat", "pat")).toEqual([]);
  });
});

describe("a revocation", () => {
  test("keeps the recipient's approval while another share still reaches the patient", async () => {
    store.putRelationship(guardian("teen", "parent2"));
    share("parent", "sitter", "teen", ["Site A"]);
    share("parent2", "sitter", "teen", ["Site A"]);
    approve("sitter", "teen");
    await policy.removeShares({ with: "user:sitter", from: "user:parent2", patient: "patient:teen" });
    expect(store.approvals().map(a => a.by)).toEqual(["user:sitter"]);
    expect(await search("sitter-teen", "teen")).toEqual(["study-1.1"]);
    await policy.removeShares({ with: "user:sitter", from: "user:parent", patient: "patient:teen" });
    expect(store.approvals()).toEqual([]);
  });
  test("keeps a recipient's approval when they're a guardian with a covering grant, and not when no grant covers them", async () => {
    store.putRelationship(guardian("teen", "sitter"));
    share("parent", "sitter", "teen", ["Site A"]);
    approve("sitter", "teen");
    await policy.removeShares({ with: "user:sitter", patient: "patient:teen" });
    expect(store.approvals().map(a => a.by)).toEqual(["user:sitter"]);
    await policy.removePolicy(TEENS.id);
    share("parent", "sitter", "teen", ["Site A"]);
    await policy.removeShares({ with: "user:sitter", patient: "patient:teen" });
    expect(store.approvals()).toEqual([]);
  });
  test("of a guardian relationship keeps that guardian's approval while a share from the patient still reaches them", async () => {
    share("pat", "parent", "pat", ["Site A"]);
    store.putRelationship(guardian("pat"));
    approve("parent", "pat");
    await policy.removeRelationship(guardian("pat"));
    expect(store.approvals().map(a => a.by)).toEqual(["user:parent"]);
  });
});
