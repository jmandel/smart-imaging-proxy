// Choices rest on rows, by id. A share records the route its sharer held, and an app approval the
// routes its user held, when made. Deleting a row deletes what rests only on deleted rows, in the
// same write, and nothing about deletion reads policies, ages or the clock. Policy and age changes
// delete nothing: dependents go quiet and come back.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createCatalog, createImagingServer, createPolicyClient, type AppApproval, type OrgPolicy, PolicyStore, type Relationship, type Share } from "../src";
import { manualClock, put } from "./support";

const SECRET = "s3cret", POLICY_SECRET = "p0licy";
const catalog = createCatalog();
put(catalog, "1.1", { site: "Site A" }, "teen");
put(catalog, "1.2", { site: "Site B" }, "teen");
put(catalog, "2.1", { site: "Site A" }, "pat");
const BIRTH: Record<string, string> = { teen: "2011-01-01", pat: "1980-05-05" };
const PATIENT_OF: Record<string, string> = { pat: "pat" };
const guardian = (p: string, who = "parent"): Relationship => ({ subject: `user:${who}`, relation: "guardian_of", object: `patient:${p}` });
const TEENS: OrgPolicy = { id: "guardians-13-to-17", type: "guardian-access", when: { age: { min: 13, max: 17 } }, allow: "all" };
const SHARING: OrgPolicy = { id: "share", type: "sharing", allowedFrom: ["patient", "guardian"] };
const NOW = Date.UTC(2026, 10, 7) / 1000;
const clock = manualClock(NOW);
const token = (sub: string, patient: string) => ({ client_id: "viewer", sub, fhirUser: PATIENT_OF[sub] ? `Patient/${PATIENT_OF[sub]}` : `RelatedPerson/${sub}`, patient, scope: "patient/ImagingStudy.rs" });
const TOKENS: Record<string, any> = { "parent-teen": token("parent", "teen"), "sitter-teen": token("sitter", "teen"), "sitter-pat": token("sitter", "pat") };

/** One Imaging Server and its store, with the policies given. */
function world(policies: OrgPolicy[]) {
  const store = new PolicyStore({ mode: "memory", onFile: { relationships: [guardian("teen")], policies }, patientOf: u => PATIENT_OF[u], now: () => clock.now() });
  const imaging = createImagingServer({
    base: "http://imaging.test/fhir", clinicalFhirBase: "http://clinical.test/fhir", proxyBase: () => "http://proxy.test",
    introspect: async t => TOKENS[t] ? { active: true, exp: clock.now() + 3600, ...TOKENS[t] } : { active: false },
    patientOf: u => PATIENT_OF[u], patientAttributes: p => ({ birthDate: BIRTH[p] }),
    serviceSecret: SECRET, policySecret: POLICY_SECRET, catalog: () => catalog, keyStore: store, store: () => store, clock,
  });
  const http = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: imaging.fetch });
  const base = `http://127.0.0.1:${http.port}`;
  const policy = createPolicyClient({ base, policySecret: POLICY_SECRET });
  const raw = (path: string, method = "GET", body?: unknown) => fetch(`${base}/policy/v2${path}`, { method, headers: { Authorization: `Bearer ${POLICY_SECRET}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }).then(r => r.json() as Promise<any>);
  const search = async (t: string, patient: string) => {
    const r = await imaging.fetch(new Request(`http://imaging.test/fhir/ImagingStudy?patient=${patient}`, { headers: { Authorization: `Bearer ${t}` } }));
    return r.status === 200 ? ((await r.json()) as any).entry?.filter((e: any) => e.resource.resourceType === "ImagingStudy").map((e: any) => e.resource.id).sort() ?? [] : r.status;
  };
  /** The rows the store holds, without timestamps. */
  const rows = () => { const { revision: _, policies: __, ...d } = store.snapshot(); return JSON.parse(JSON.stringify(d, (k, v) => k === "recordedAt" ? undefined : v)); };
  return { store, policy, raw, search, rows, close() { http.stop(true); store.close(); } };
}
const full = world([TEENS, SHARING]), bare = world([]);
afterAll(() => { full.close(); bare.close(); catalog.close(); });
beforeEach(() => { full.store.resetAll(); bare.store.resetAll(); clock.reset(); });
const shareRow = (w: ReturnType<typeof world>, from: string, to: string, patient: string, sites: string[]) => w.store.putShare({ from: `user:${from}`, with: `user:${to}`, patient: `patient:${patient}`, sites, label: "helper" });
const approveRow = (w: ReturnType<typeof world>, by: string, patient: string) => w.store.putApproval({ by: `user:${by}`, app: "app:viewer", patient: `patient:${patient}` });
const shareOf = (w: ReturnType<typeof world>, from: string) => w.store.shares().find(s => s.from === `user:${from}`)!;

describe("rows and their basis", () => {
  test("relationships, shares and approvals carry ids, a relationship when it was recorded, and each choice what it rests on", async () => {
    const [rel] = full.store.relationships();
    expect(rel!.id).toMatch(/^rel-/);
    expect(rel!.recordedAt).toBe("2026-11-07T00:00:00.000Z");
    const shared = await full.policy.share({ from: "user:parent", with: "user:sitter", patient: "patient:teen", sites: ["Site A"], label: "helper" });
    expect(shared.ok && shared.share).toMatchObject({ id: expect.stringMatching(/^share-/), basis: rel!.id });
    const approved = await full.policy.approveApp({ by: "user:sitter", app: "app:viewer", patient: "patient:teen", fhirUser: "RelatedPerson/sitter" });
    expect(approved.ok && approved.approval).toMatchObject({ id: expect.stringMatching(/^approval-/), basis: [shareOf(full, "parent").id] });
    expect((await full.raw("/shares")).shares[0]).toMatchObject({ id: shareOf(full, "parent").id, basis: rel!.id });
    const r = await full.raw("/relationships", "PUT", guardian("teen", "parent2"));
    expect(r.relationship.id).toMatch(/^rel-/);
    full.store.putShare({ from: "user:pat", with: "user:sitter", patient: "patient:pat", sites: ["Site A"], label: "friend" });
    expect(shareOf(full, "pat").basis).toBe("self");
  });
  test("explain says what a choice rests on", async () => {
    shareRow(full, "parent", "sitter", "teen", ["Site A"]);
    approveRow(full, "sitter", "teen");
    const row = (await full.policy.explain({ client: "viewer", user: "sitter", fhirUser: "RelatedPerson/sitter", patient: "teen" })).studies.find((s: any) => s.id === "study-1.1");
    expect(row.because.filter((b: any) => b.level === "choice").map((b: any) => b.restsOn)).toEqual(["parent's guardian relationship, recorded 2026-11-07", "parent's share"]);
  });
});

/** Rows with each id renamed by order of appearance, so two stores with different histories compare. */
function canonical(d: any) {
  const names = new Map<string, string>();
  const n = (id: string) => { if (id === "self") return id; if (!names.has(id)) names.set(id, `#${names.size}`); return names.get(id)!; };
  for (const k of ["relationships", "shares", "approvals"]) for (const r of d[k]) n(r.id);
  return JSON.parse(JSON.stringify(d, (k, v) => k === "id" || (k === "basis" && typeof v === "string") ? n(v) : k === "basis" ? v.map(n) : v));
}

describe("deleting a row", () => {
  /** The same rows in both worlds, then the same removal through the policy API. */
  async function both(setup: (w: ReturnType<typeof world>) => void, remove: (w: ReturnType<typeof world>) => Promise<unknown>) {
    for (const w of [full, bare]) { setup(w); await remove(w); }
    expect(canonical(full.rows())).toEqual(canonical(bare.rows()));
    return full.rows();
  }
  test("deletes the same rows whatever policies are present", async () => {
    // Sitter is a guardian too, and approved with both routes; parent's share goes.
    const after = await both(w => {
      w.store.putRelationship(guardian("teen", "sitter"));
      shareRow(w, "parent", "sitter", "teen", ["Site A"]);
      approveRow(w, "sitter", "teen");
    }, w => w.policy.removeShares({ with: "user:sitter", from: "user:parent" }));
    expect([after.shares, after.approvals.map((a: AppApproval) => a.by)]).toEqual([[], ["user:sitter"]]);
    const again = await both(w => { w.store.resetAll(); shareRow(w, "parent", "sitter", "teen", ["Site A"]); approveRow(w, "sitter", "teen"); approveRow(w, "parent", "teen"); }, w => w.policy.removeRelationship(guardian("teen")));
    expect([again.relationships, again.shares, again.approvals]).toEqual([[], [], []]);
  });
  test("a re-created relationship revives nothing: it's a new row", async () => {
    shareRow(full, "parent", "sitter", "teen", ["Site A"]);
    approveRow(full, "sitter", "teen");
    approveRow(full, "parent", "teen");
    const old = full.store.relationships()[0]!.id;
    await full.policy.removeRelationship(guardian("teen"));
    await full.policy.putRelationship(guardian("teen"));
    expect(full.store.relationships()[0]!.id).not.toBe(old);
    expect([full.store.shares(), full.store.approvals()]).toEqual([[], []]);
    expect([await full.search("sitter-teen", "teen"), await full.search("parent-teen", "teen")]).toEqual([[], []]);
  });
  test("two shares to one recipient: the approval made on both survives until both are gone", async () => {
    full.store.putRelationship(guardian("teen", "parent2"));
    shareRow(full, "parent", "sitter", "teen", ["Site A"]);
    shareRow(full, "parent2", "sitter", "teen", ["Site A"]);
    approveRow(full, "sitter", "teen");
    await full.policy.removeShares({ with: "user:sitter", from: "user:parent2" });
    expect(full.store.approvals().length).toBe(1);
    expect(await full.search("sitter-teen", "teen")).toEqual(["study-1.1"]);
    await full.policy.removeShares({ with: "user:sitter", from: "user:parent" });
    expect(full.store.approvals()).toEqual([]);
  });
  test("by a document write compares rows by id: kept ids keep their dependents, and a row without one is new", async () => {
    shareRow(full, "parent", "sitter", "teen", ["Site A"]);
    approveRow(full, "sitter", "teen");
    const { revision: _, ...doc } = await full.policy.getDocument();
    await full.policy.setDocument(doc);
    expect([full.store.shares().length, full.store.approvals().length]).toEqual([1, 1]);
    // The same relationship without its id is a new row, so what rested on the old one goes.
    await full.policy.setDocument({ relationships: doc.relationships.map(({ id: _, recordedAt: __, ...r }: Relationship) => r) });
    expect([full.store.relationships().length, full.store.shares(), full.store.approvals()]).toEqual([1, [], []]);
    shareRow(full, "parent", "sitter", "teen", ["Site A"]);
    approveRow(full, "sitter", "teen");
    await full.policy.setDocument({ relationships: [] });
    expect([full.store.shares(), full.store.approvals()]).toEqual([[], []]);
  });
  test("a document row naming an id that was deleted is refused, since ids are never reused", async () => {
    const old = full.store.relationships()[0]!;
    await full.policy.removeRelationship(guardian("teen"));
    expect(await full.policy.setDocument({ relationships: [old] }).catch(e => e.status)).toBe(400);
  });
});

describe("approvals cover their own routes", () => {
  test("an approval made with one route doesn't gain a later one, until the user approves again", async () => {
    full.store.putRelationship(guardian("teen", "parent2"));
    shareRow(full, "parent", "sitter", "teen", ["Site A"]);
    approveRow(full, "sitter", "teen");
    shareRow(full, "parent2", "sitter", "teen", ["Site B"]);
    expect(await full.search("sitter-teen", "teen")).toEqual(["study-1.1"]);
    approveRow(full, "sitter", "teen");
    expect(await full.search("sitter-teen", "teen")).toEqual(["study-1.1", "study-1.2"]);
  });
});

describe("policy and age changes delete nothing", () => {
  test("removing the sharing policy leaves the share and approval quiet, and putting it back brings them back", async () => {
    shareRow(full, "parent", "sitter", "teen", ["Site A"]);
    approveRow(full, "sitter", "teen");
    const before = full.rows();
    await full.policy.removePolicy(SHARING.id);
    expect(await full.search("sitter-teen", "teen")).toEqual([]);
    expect(full.rows()).toEqual(before);
    await full.policy.putPolicy(SHARING);
    expect(await full.search("sitter-teen", "teen")).toEqual(["study-1.1"]);
  });
  test("ageing past the band leaves the guardian's choices quiet", async () => {
    shareRow(full, "parent", "sitter", "teen", ["Site A"]);
    approveRow(full, "sitter", "teen");
    approveRow(full, "parent", "teen");
    const before = full.rows();
    clock.set(Date.UTC(2029, 0, 2) / 1000);
    expect([await full.search("parent-teen", "teen"), await full.search("sitter-teen", "teen")]).toEqual([[], []]);
    expect(full.rows()).toEqual(before);
    clock.reset();
    expect(await full.search("sitter-teen", "teen")).toEqual(["study-1.1"]);
  });
});

describe("random sequences of writes and deletes", () => {
  let seed = 4242;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
  const USERS = ["pat", "u1", "u2", "u3"], PATIENTS = ["pat", "teen"];
  test("never leave a choice resting on a missing row, and delete the same rows whatever the policies", () => {
    const stores = [[TEENS, SHARING], []].map(policies => new PolicyStore({ mode: "memory", onFile: { policies }, patientOf: u => PATIENT_OF[u], now: () => NOW }));
    let steps = 0;
    for (let n = 0; n < 1500; n++) {
      const op = pick(["rel", "unrel", "share", "unshare", "approve", "unapprove", "document"] as const);
      const user = `user:${pick(USERS)}`, other = `user:${pick(USERS)}`, patient = `patient:${pick(PATIENTS)}`;
      const keep = Array.from({ length: 16 }, () => rnd() < 0.8);
      const outcomes = stores.map(s => {
        try {
          if (op === "rel") s.putRelationship({ subject: user, relation: "guardian_of", object: patient });
          if (op === "unrel") s.removeRelationship({ subject: user, relation: "guardian_of", object: patient });
          if (op === "share") s.putShare({ from: user, with: other, patient, sites: ["Site A"], label: "x" });
          if (op === "unshare") s.removeShares({ with: other, patient });
          if (op === "approve") s.putApproval({ by: user, app: "app:a", patient });
          if (op === "unapprove") s.removeApprovals({ by: user, app: "app:a" });
          if (op === "document") { const { revision: _, policies: __, ...d } = s.snapshot(); s.setDocument({ ...d, relationships: d.relationships.filter((_, i) => keep[i % keep.length]) }); }
          return "ok";
        } catch (e) { return (e as Error).message; }
      });
      expect(outcomes[0]).toBe(outcomes[1]!);
      for (const s of stores) {
        const d = s.snapshot(), rels = new Set(d.relationships.map(r => r.id)), shares = new Set(d.shares.map(x => x.id));
        for (const x of d.shares) expect(x.basis === "self" || rels.has(x.basis!)).toBe(true);
        for (const a of d.approvals) expect(a.basis!.some(b => b === "self" || rels.has(b) || shares.has(b))).toBe(true);
      }
      const strip = (s: PolicyStore) => { const { revision: _, policies: __, ...d } = s.snapshot(); return d; };
      expect(strip(stores[0]!)).toEqual(strip(stores[1]!));
      steps++;
    }
    expect(steps).toBeGreaterThan(1000);
    for (const s of stores) s.close();
  });
});
