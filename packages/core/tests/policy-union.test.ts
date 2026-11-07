// Access is the union of every grant that applies: policies and choices only grant, order never
// matters, and restriction lives only inside a grant's own reach. Also: what removing a grant
// takes with it, labels, birth dates and ages, share keys, and request validation.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCatalog, createImagingServer, createModel, createPolicyClient, type CatalogStudy, type OrgPolicy, PolicyStore, type Relationship, type Snapshot, validateOrgPolicy } from "../src";
import { manualClock, put } from "./support";

const SECRET = "s3cret", POLICY_SECRET = "p0licy";
const CONF = "confidential-adolescent";
const catalog = createCatalog();
put(catalog, "1.1", { site: "Site A" }, "teen", "CT");
put(catalog, "1.2", { site: "Site B", labels: [CONF] }, "teen", "MR");
put(catalog, "1.3", { site: "Site B", labels: ["Confidential-Adolescent "] }, "teen", "MR");
put(catalog, "1.4", { site: "Site A", labels: ["confidential-adolscent"] }, "teen", "CT");
put(catalog, "1.5", { site: "Site A", labels: ["Not A Label!"] }, "teen", "CT");
put(catalog, "2.1", { site: "Site A" }, "pat", "CT");
put(catalog, "2.2", { site: "Site B" }, "pat", "MR");
put(catalog, "3.1", { site: "Site A" }, "future", "CT");
put(catalog, "4.1", { site: "Site A" }, "bad", "CT");
put(catalog, "5.1", { site: "Site A" }, "edge", "CT");
const TEEN_ALL = ["study-1.1", "study-1.2", "study-1.3", "study-1.4", "study-1.5"];
const BIRTH: Record<string, string> = { teen: "2011-01-01", pat: "1980-05-05", future: "2030-01-01", bad: "2008-13-45", edge: "2011-01-01" };
const NAMES: Record<string, string> = { "user:parent": "Parent", "user:other": "Other", "user:sitter": "Sitter", "user:teen": "Teen", "patient:teen": "Teen", "label:confidential-adolescent": "confidential adolescent care" };
const guardian = (p: string, who = "parent"): Relationship => ({ subject: `user:${who}`, relation: "guardian_of", object: `patient:${p}` });
const UNDER_13: OrgPolicy = { id: "guardians-under-13", type: "guardian-access", when: { age: { max: 12 } }, allow: "all" };
const TEENS: OrgPolicy = { id: "guardians-13-to-17", type: "guardian-access", when: { age: { min: 13, max: 17 } }, allow: "all", except: [CONF] };
const SHARING: OrgPolicy = { id: "share", type: "sharing", allowedFrom: ["patient", "guardian"] };
const store = new PolicyStore({ mode: "memory", onFile: { relationships: ["teen", "future", "bad", "edge"].map(p => guardian(p)), policies: [UNDER_13, TEENS, SHARING] } });
const clock = manualClock(Date.UTC(2026, 10, 7) / 1000);
const token = (sub: string, patient: string, fhirUser = `RelatedPerson/${sub}`) => ({ client_id: "viewer", sub, fhirUser, patient, scope: "patient/ImagingStudy.rs" });
const TOKENS: Record<string, any> = {
  "parent-teen": token("parent", "teen"), "other-teen": token("other", "teen"), "sitter-teen": token("sitter", "teen"),
  "teen-teen": token("teen", "teen", "Patient/teen"), "parent-future": token("parent", "future"), "parent-bad": token("parent", "bad"),
  service: { client_id: "svc", scope: "system/ImagingStudy.rs" },
};
const serverFor = (timeZone?: string) => createImagingServer({
  base: "http://imaging.test/fhir", clinicalFhirBase: "http://clinical.test/fhir", proxyBase: () => "http://proxy.test",
  introspect: async t => TOKENS[t] ? { active: true, exp: clock.now() + 3600, ...TOKENS[t] } : { active: false },
  patientOf: u => ({ teen: "teen", pat: "pat" } as Record<string, string>)[u], patientAttributes: p => ({ birthDate: BIRTH[p] }), name: r => NAMES[r] ?? r,
  serviceSecret: SECRET, policySecret: POLICY_SECRET, catalog: () => catalog, keyStore: store, store: () => store, clock, ...(timeZone ? { timeZone } : {}),
});
const imaging = serverFor();
const http = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: imaging.fetch });
const base = `http://127.0.0.1:${http.port}`;
const policy = createPolicyClient({ base, policySecret: POLICY_SECRET });
const raw = (path: string, init: RequestInit = {}) => fetch(`${base}/policy/v2${path}`, { ...init, headers: { Authorization: `Bearer ${POLICY_SECRET}`, "content-type": "application/json" } });
const search = async (t: string, patient: string, server = imaging) => {
  const r = await server.fetch(new Request(`http://imaging.test/fhir/ImagingStudy?patient=${patient}`, { headers: { Authorization: `Bearer ${t}` } }));
  return r.status === 200 ? ((await r.json()) as any).entry?.filter((e: any) => e.resource.resourceType === "ImagingStudy").map((e: any) => e.resource.id).sort() ?? [] : r.status;
};
const approve = (by: string, patient: string, sites?: string[]) => store.putApproval({ by: `user:${by}`, app: "app:viewer", patient: `patient:${patient}`, ...(sites ? { sites } : {}) });
const share = (from: string, to: string, patient: string, sites: string[]) => store.putShare({ from: `user:${from}`, with: `user:${to}`, patient: `patient:${patient}`, sites, label: "helper" });
const explainFor = (user: string, patient: string, fhirUser = `RelatedPerson/${user}`) => policy.explain({ client: "viewer", user, fhirUser, patient });
afterAll(() => { http.stop(true); store.close(); catalog.close(); });
beforeEach(() => { store.resetAll(); clock.reset(); });

describe("a store in an older format", () => {
  test("stops the server with a message to reset saved policy, and isn't read", () => {
    const dir = mkdtempSync(join(tmpdir(), "old-store-"));
    try {
      for (const version of [1, 4, 5]) {
        const path = join(dir, `v${version}.sqlite`);
        const db = new Database(path);
        db.exec(`CREATE TABLE rules (id TEXT, position INTEGER, body TEXT); PRAGMA user_version = ${version}`);
        db.close();
        expect(() => new PolicyStore({ mode: "file", path })).toThrow(/older format.*reset saved policy/is);
        const after = new Database(path);
        expect((after.query("PRAGMA user_version").get() as any).user_version).toBe(version);
        after.close();
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("union of grants", () => {
  test("no policy type takes withdrawn, or any other way to deny", () => {
    const errors: string[] = [];
    validateOrgPolicy({ id: "x", type: "service-access", service: "service:svc", patients: "any", allow: { all: true }, withdrawn: true }, "p", errors);
    expect(errors).toEqual(['p: unknown field "withdrawn"']);
  });
  test("overlapping guardian-access policies add up, in either order, and explain lists each one that granted", async () => {
    approve("parent", "teen");
    const ALL_TEENS: OrgPolicy = { id: "teen-guardians-see-all", type: "guardian-access", when: { age: { min: 15, max: 15 } }, allow: "all" };
    for (const order of [[UNDER_13, TEENS, ALL_TEENS, SHARING], [ALL_TEENS, UNDER_13, TEENS, SHARING]]) {
      store.setDocument({ policies: order });
      // The studies with unknown labels stay hidden from every guardian grant.
      expect(await search("parent-teen", "teen")).toEqual(["study-1.1", "study-1.2", "study-1.3"]);
      const row = (await explainFor("parent", "teen")).studies.find((s: any) => s.id === "study-1.1");
      expect(row.because.filter((b: any) => b.level === "policy").map((b: any) => b.ref).sort()).toEqual(["policy:guardians-13-to-17", "policy:teen-guardians-see-all"]);
    }
  });
  test("overlapping service-access policies add up: modalities, and series one withholds that another releases", async () => {
    const CT: OrgPolicy = { id: "ct", type: "service-access", service: "service:svc", patients: "patient:pat", allow: { modalities: ["CT"] }, withholdSeries: ["2.1.1"] };
    const MR: OrgPolicy = { id: "mr", type: "service-access", service: "service:svc", patients: "any", allow: { modalities: ["MR"] } };
    const SITE_A: OrgPolicy = { id: "site-a", type: "service-access", service: "service:svc", patients: "any", allow: { sites: ["Site A"] } };
    store.replacePolicies("service-access", [CT, MR]);
    expect(await search("service", "pat")).toEqual(["study-2.2"]);
    store.replacePolicies("service-access", [MR, CT, SITE_A]);
    expect(await search("service", "pat")).toEqual(["study-2.1", "study-2.2"]);
    const row = (await policy.explain({ client: "svc", patient: "pat" })).studies.find((s: any) => s.id === "study-2.1");
    // ct withholds the study's only series, so it contributes nothing, and site-a releases it whole.
    expect(row.release).toBe("study");
    expect(row.policies).toEqual(["site-a"]);
    expect(row.because.map((b: any) => b.ref)).toEqual(["policy:site-a"]);
  });
  test("a patient's share to their own guardian counts as well as the guardian route", async () => {
    approve("parent", "teen");
    expect(await search("parent-teen", "teen")).not.toContain("study-1.2");
    share("teen", "parent", "teen", ["Site B"]);
    expect(await search("parent-teen", "teen")).toContain("study-1.2");
  });
  test("an app approval still narrows: at most the user's access, at the approval's sites", async () => {
    share("teen", "parent", "teen", ["Site B"]);
    approve("parent", "teen", ["Site B"]);
    expect(await search("parent-teen", "teen")).toEqual(["study-1.2", "study-1.3"]);
  });
});

describe("removing a grant takes what hangs off it", () => {
  test("a guardian relationship goes with that guardian's shares and app approvals for the patient, in the same write", async () => {
    share("parent", "sitter", "teen", ["Site A"]);
    share("parent", "sitter", "pat", ["Site A"]);
    approve("parent", "teen");
    approve("sitter", "teen");
    const r = await policy.removeRelationship({ subject: "user:parent", relation: "guardian_of", object: "patient:teen" });
    expect(r).toEqual({ policy: store.policyRevision(), patient: store.patientRevision("patient:teen") });
    expect(store.shares().map(s => s.patient)).toEqual(["patient:pat"]);
    expect(store.approvals()).toEqual([]);
    // Putting the relationship back brings nothing else back.
    store.putRelationship(guardian("teen"));
    expect(await search("sitter-teen", "teen")).toEqual([]);
    expect(await search("parent-teen", "teen")).toEqual([]);
  });
  test("a share goes with its recipient's app approvals on that patient, so sharing again doesn't bring an app back", async () => {
    share("parent", "sitter", "teen", ["Site A"]);
    approve("sitter", "teen");
    approve("parent", "teen");
    await policy.removeShares({ with: "user:sitter", from: "user:parent", patient: "patient:teen" });
    expect(store.approvals().map(a => a.by)).toEqual(["user:parent"]);
    share("parent", "sitter", "teen", ["Site A"]);
    expect(await search("sitter-teen", "teen")).toEqual([]);
  });
});

describe("shares", () => {
  test("are kept per sharer: two people's shares with one person both stand", async () => {
    share("teen", "sitter", "teen", ["Site B"]);
    share("parent", "sitter", "teen", ["Site A"]);
    expect(store.shares().map(s => s.from).sort()).toEqual(["user:parent", "user:teen"]);
    approve("sitter", "teen");
    expect(await search("sitter-teen", "teen")).toEqual(["study-1.1", "study-1.2", "study-1.3"]);
  });
  test("a recipient's explain doesn't name the label that keeps a study from the sharer", async () => {
    share("parent", "sitter", "teen", ["Site A", "Site B"]);
    const row = (await explainFor("sitter", "teen")).studies.find((s: any) => s.id === "study-1.2");
    expect(row.release).toBe("none");
    expect(row.why).not.toMatch(/confidential|label/i);
    expect(row.because.some((b: any) => b.ref.startsWith("study:") || /confidential|label/i.test(b.text))).toBe(false);
  });
  test("POST /shares and /app-approvals refuse sites that aren't strings", async () => {
    for (const sites of [[1], [null], ["Site A", {}], "Site A"]) {
      expect((await raw("/shares", { method: "POST", body: JSON.stringify({ from: "user:teen", with: "user:sitter", patient: "patient:teen", sites, label: "helper" }) })).status).toBe(400);
      expect((await raw("/app-approvals", { method: "POST", body: JSON.stringify({ by: "user:teen", app: "app:viewer", patient: "patient:teen", fhirUser: "Patient/teen", sites }) })).status).toBe(400);
    }
    expect([store.shares(), store.approvals()]).toEqual([[], []]);
  });
});

describe("labels", () => {
  test("match whatever their case and spacing, and one outside the policies' labels, or malformed, hides the study from every guardian-access grant", async () => {
    approve("parent", "teen");
    expect(await search("parent-teen", "teen")).toEqual(["study-1.1"]);
    // The patient sees everything, labels or not.
    approve("teen", "teen");
    expect(await search("teen-teen", "teen")).toEqual(TEEN_ALL);
    const why = Object.fromEntries((await explainFor("parent", "teen")).studies.map((s: any) => [s.id, s.why]));
    expect(why["study-1.4"]).toContain("unknown label");
    expect(why["study-1.5"]).toContain("unknown label");
  });
  test("a policy's labels must be label names", () => {
    const errors: string[] = [];
    validateOrgPolicy({ ...TEENS, except: ["Confidential Adolescent"] }, "p", errors);
    expect(errors).toEqual(["p.except must be a list of labels, such as confidential-adolescent"]);
  });
});

describe("birth dates and ages", () => {
  test("a future or invalid birth date gives no guardian-access grant", async () => {
    store.putApproval({ by: "user:parent", app: "app:viewer", patient: "patient:future" });
    store.putApproval({ by: "user:parent", app: "app:viewer", patient: "patient:bad" });
    expect(await search("parent-future", "future")).toEqual([]);
    expect(await search("parent-bad", "bad")).toEqual([]);
    expect((await policy.approveApp({ by: "user:parent", app: "app:viewer", patient: "patient:bad", fhirUser: "RelatedPerson/parent" })).ok).toBe(false);
  });
  test("age is counted in the organization's time zone, UTC unless set", async () => {
    // 03:00 UTC on Teen's 18th birthday is still the day before in Los Angeles.
    clock.set(Date.UTC(2029, 0, 1, 3) / 1000);
    approve("parent", "teen");
    expect(await search("parent-teen", "teen")).toEqual([]);
    const la = serverFor("America/Los_Angeles");
    expect(await search("parent-teen", "teen", la)).toEqual(["study-1.1"]);
    expect(() => serverFor("Not/A_Zone")).toThrow("timeZone");
  });
  test("an empty age band is refused", () => {
    const errors: string[] = [];
    validateOrgPolicy({ ...UNDER_13, when: { age: {} } }, "p", errors);
    expect(errors).toEqual(["p.when.age must have min, max, or both"]);
  });
});

describe("adding a grant never takes access away", () => {
  // A small seeded generator, so a failure repeats.
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
  const some = <T>(xs: readonly T[]) => xs.filter(() => rnd() < 0.5);
  const USERS = ["u1", "u2", "u3", "u4"], PATIENTS = ["p1", "p2", "p3"], SITES = ["A", "B", "C"], LABELS = [CONF, "other-label", "Confidential-Adolescent"], MODS = ["CT", "MR", "CR"];
  const PATIENT_OF: Record<string, string> = { u1: "p1", u2: "p2" };
  const BIRTHS: Record<string, string> = { p1: "2011-06-01", p2: "2016-03-01", p3: "1990-01-01" };
  const STUDIES: CatalogStudy[] = PATIENTS.flatMap(p => [0, 1, 2, 3].map(i => ({
    pk: 0, uid: `${p}.${i}`, id: `${p}-${i}`, patient: p, status: "available" as const, date: `20${10 + i}0101`, site: pick(SITES), labels: rnd() < 0.4 ? [pick(LABELS)] : undefined,
    lastUpdated: "2020-01-01T00:00:00Z", version: 1, seriesCount: 2, instanceCount: 2, hierarchyBytes: 0,
    series: [{ uid: `${p}.${i}.1`, number: 1, modality: pick(MODS), instanceCount: 1 }, { uid: `${p}.${i}.2`, number: 2, modality: pick(MODS), instanceCount: 1 }],
  })));
  const model = createModel({ patientOf: u => PATIENT_OF[u], attributesOf: p => ({ birthDate: BIRTHS[p] }), now: () => Date.UTC(2026, 10, 7) / 1000, name: r => r });
  const randomPolicy = (i: number): OrgPolicy => {
    const t = pick(["guardian-access", "sharing", "service-access"] as const);
    if (t === "guardian-access") { const min = pick([undefined, 0, 13]), max = pick([undefined, 12, 17, 40]); return { id: `g${i}`, type: t, when: { age: min === undefined && max === undefined ? { max: 12 } : { ...(min !== undefined ? { min } : {}), ...(max !== undefined && (min === undefined || max >= min) ? { max } : {}) } }, allow: "all", ...(rnd() < 0.5 ? { except: [CONF] } : {}) }; }
    if (t === "sharing") return { id: `s${i}`, type: t, allowedFrom: pick([["patient"], ["guardian"], ["patient", "guardian"]] as const) as any };
    const allow = pick([{ all: true }, { sites: some(SITES) }, { modalities: some(MODS) }, { since: "2012-01-01" }, { studies: some(STUDIES.map(s => s.id)) }]);
    return { id: `v${i}`, type: t, service: pick(["service:s1", "service:s2"]), patients: pick(["any", ...PATIENTS.map(p => `patient:${p}`)]), allow, ...(rnd() < 0.3 ? { withholdSeries: some(STUDIES.flatMap(s => s.series.map(x => x.uid))) } : {}) };
  };
  const randomShare = () => ({ from: `user:${pick(USERS)}`, with: `user:${pick(USERS)}`, patient: `patient:${pick(PATIENTS)}`, sites: some(SITES), label: "x" });
  const randomApproval = () => ({ by: `user:${pick(USERS)}`, app: "app:a1", patient: `patient:${pick(PATIENTS)}`, ...(rnd() < 0.5 ? { sites: some(SITES) } : {}) });
  const randomRelationship = () => ({ subject: `user:${pick(USERS)}`, relation: "guardian_of", object: `patient:${pick(PATIENTS)}` });
  const randomDoc = (): Snapshot => ({
    policies: Array.from({ length: Math.floor(rnd() * 5) }, (_, i) => randomPolicy(i)),
    relationships: Array.from({ length: Math.floor(rnd() * 4) }, randomRelationship),
    shares: Array.from({ length: Math.floor(rnd() * 4) }, randomShare),
    approvals: Array.from({ length: Math.floor(rnd() * 4) }, randomApproval),
  });
  /** Every decision, as the set of series it releases, for each user's app and each service. */
  const decisions = (s: Snapshot) => {
    const out = new Map<string, Set<string>>();
    for (const st of STUDIES) {
      const subjects = [...USERS.map(u => ({ client_id: "a1", sub: u, fhirUser: PATIENT_OF[u] ? `Patient/${PATIENT_OF[u]}` : `RelatedPerson/${u}`, patient: st.patient })), { client_id: "s1" }, { client_id: "s2" }];
      for (const t of subjects) {
        const d = model.evaluate(s, t, st);
        out.set(`${t.client_id}/${t.sub ?? ""}/${st.id}`, new Set(d.release === "none" ? [] : d.release === "study" ? st.series.map(x => x.uid) : d.release.series));
      }
    }
    for (const c of ["s1", "s2"]) for (const p of PATIENTS) out.set(`search ${c} ${p}`, new Set([model.preAuthorized(s, c, p)].flat().filter(Boolean).length ? ["allowed"] : []));
    return out;
  };
  const insertAt = <T>(xs: T[], x: T) => { const i = Math.floor(rnd() * (xs.length + 1)); return [...xs.slice(0, i), x, ...xs.slice(i)]; };
  test("for random documents, adding any one policy, relationship or choice never shrinks a decision or a search", () => {
    let checked = 0;
    for (let n = 0; n < 400; n++) {
      const doc = randomDoc();
      const kind = pick(["policies", "relationships", "shares", "approvals"] as const);
      const added: Snapshot = { ...doc, [kind]: insertAt(doc[kind] as any[], kind === "policies" ? randomPolicy(99) : kind === "relationships" ? randomRelationship() : kind === "shares" ? randomShare() : randomApproval()) };
      // A choice with the same key as one already there replaces it, which isn't adding.
      const keys = (xs: any[]) => xs.map(x => kind === "shares" ? `${x.patient} ${x.from} ${x.with}` : kind === "approvals" ? `${x.by} ${x.app} ${x.patient}` : JSON.stringify(x));
      if (new Set(keys(added[kind] as any[])).size !== (added[kind] as any[]).length) continue;
      const before = decisions(doc), after = decisions(added);
      for (const [k, v] of before) for (const series of v) {
        if (!after.get(k)!.has(series)) throw new Error(`adding ${kind} took ${series} away from ${k}\n${JSON.stringify({ doc, added: added[kind] })}`);
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(300);
  });
});
