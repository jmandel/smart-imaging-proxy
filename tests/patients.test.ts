// Several patients, and a caregiver choosing among them: what each person can reach on every backend,
// what one patient's token can't reach, the guardian on file and the policy by age, sharing, and the synthetic data.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStack, type BackendName, type Stack } from "../src/stack";
import { defaultsFor, FLOWS, registerClients, runStep, startFlow } from "../src/flows";
import { accountUrl, buildAuthorization, CLINICAL_FHIR, scriptedLaunch, submitConsent, submitDelegation, submitRevocation } from "../src/flows/oauth";
import { createDemoServer } from "../src/demo-server";
import { ArchiveReader, fileStore, parsePart10, PolicyStore, str } from "@smart-imaging-proxy/core";
import { CONFIG } from "../src/config";
import { GUARDIANS_ON_FILE, ON_FILE } from "../src/stores";
import { syntheticInstance, syntheticStudies, writeSynthetic } from "../scripts/generate-synthetic";
import { adminFor } from "./admin-token";
import { APPROVALS_ON_FILE } from "../src/stores";

const root = join(import.meta.dir, "..");
const BACKENDS: BackendName[] = (process.env.BACKENDS?.split(",") as BackendName[]) ?? ["static-files", "s3", "orthanc"];
const JOSH = ["ct-abdomen-pelvis-2012", "mri-brain-2020", "slide-lung-2023", "xr-hand-right-2012", "xr-hand-wrist-right-2012", "xr-wrist-left-2012"];
const SAM = ["syn-sam-chest-xr-2021", "syn-sam-ct-sinus-2024"];
const CONFIDENTIAL = "syn-riley-skin-slide-2023";
const RILEY = ["syn-riley-knee-mr-2022"]; // What Sam gets: the other study is labeled confidential adolescent care, and Riley is 15.
const SAM_ACCOUNT = "sam-caregiver";
const AUTH = CLINICAL_FHIR.replace("/fhir", "");

let stack: Stack; let demo: ReturnType<typeof createDemoServer>; let clients: ReturnType<typeof registerClients>;
beforeAll(async () => { stack = await startStack(root); clients = registerClients(stack); demo = createDemoServer(stack, clients, root); });
afterAll(() => stack.stop());
beforeEach(async () => { await stack.resetAll(); stack.setBackend("static-files"); });

const search = async (token: string, patient: string) => {
  const r = await fetch(`${CONFIG.imagingUrl}/fhir/ImagingStudy?patient=${patient}&_include=ImagingStudy:endpoint`, { headers: { Authorization: `Bearer ${token}` } });
  const body: any = await r.json();
  const studies = (body.entry ?? []).filter((e: any) => e.resource.resourceType === "ImagingStudy").map((e: any) => e.resource);
  const address = (s: any) => body.entry.find((e: any) => e.fullUrl === s.endpoint[0].reference).resource.address as string;
  const uid = (s: any) => s.identifier[0].value.replace("urn:oid:", "") as string;
  return { status: r.status, ids: studies.map((s: any) => s.id).sort() as string[], studies, address, uid };
};
const launchFor = (patient: string, user = SAM_ACCOUNT, opts: { sites?: string[]; client?: string } = {}) => scriptedLaunch(user, opts.client ?? "portal-app", { patient, sites: opts.sites });
const shareFromJosh = (sites: string[]) => submitDelegation(accountUrl("josh"), { user: "josh", delegate: SAM_ACCOUNT, relationship: "caregiver", sites });
const uidOf = (id: string) => stack.catalog.allStudies().find(s => s.id === id)!.uid;
const wado = (base: string, uid: string, token: string) => fetch(`${base}/studies/${uid}`, { headers: { Authorization: `Bearer ${token}`, Accept: "multipart/related; type=application/dicom; transfer-syntax=*" } });
const drained = async (r: Response) => { const n = (await r.arrayBuffer()).byteLength; return { status: r.status, bytes: n }; };
/** Signs in on the account page, and returns its HTML with the session's cookie. */
const accountPage = async (user: string) => {
  const res = await fetch(`${AUTH}/account/signin`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `username=${user}`, redirect: "manual" });
  const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  return { cookie, html: await (await fetch(`${AUTH}/account`, { headers: { cookie } })).text() };
};

for (const backend of BACKENDS) {
  describe(`what each person sees, on ${backend}`, () => {
    beforeEach(() => stack.setBackend(backend));
    test("Josh still has his six, with nothing of anyone else's", async () => {
      const r = await search((await scriptedLaunch("josh")).access_token, "josh-example");
      expect(r.ids).toEqual(JOSH);
    }, 60000);
    test("Sam's own, and Riley's as guardian, with no one sharing anything, and each is retrievable", async () => {
      for (const [patient, ids] of [["sam-example", SAM], ["riley-example", RILEY]] as const) {
        const t = await launchFor(patient);
        expect(t.patient).toBe(patient);
        const r = await search(t.access_token, patient);
        expect(r.ids).toEqual([...ids]);
        const s = r.studies[0];
        const got = await drained(await wado(r.address(s), r.uid(s), t.access_token));
        expect(got.status).toBe(200);
        expect(got.bytes).toBeGreaterThan(s.numberOfInstances * 256 * 256 * 2);
      }
      expect(stack.store.shares()).toEqual([]);
    }, 60000);
    test("Sam's sites differ, so narrowing means something", () => {
      expect(stack.catalog.sitesFor("sam-example")).toEqual(["Lakeside Imaging", "Riverside Hospital"]);
      expect(stack.catalog.sitesFor("riley-example")).toEqual(["Lakeside Imaging", "Northside Pathology"]);
      expect(stack.catalog.allStudies().filter(s => s.series.length > 1 && [...SAM, ...RILEY].includes(s.id)).length).toBeGreaterThan(0);
    });
    test("Josh is Sam's only after Josh shares, and only what he shared", async () => {
      expect((await launchFor("josh-example")).error).toBe("access_denied");
      await shareFromJosh(["Lakeside Imaging"]);
      const t = await launchFor("josh-example");
      expect((await search(t.access_token, "josh-example")).ids).toEqual(["mri-brain-2020"]);
    }, 60000);
    test("Robin stays empty, and Alex has nothing", async () => {
      expect((await search((await scriptedLaunch("robin")).access_token, "robin-example")).ids).toEqual([]);
      expect((await scriptedLaunch("alex-neighbor")).error).toBe("access_denied");
      expect((await launchFor("sam-example", "alex-neighbor")).error).toBe("access_denied");
      expect((await launchFor("riley-example", "alex-neighbor")).error).toBe("access_denied");
    }, 60000);
    test("a token for one patient is refused for another: 403 on search, 404 on retrieval", async () => {
      await shareFromJosh(["Lakeside Imaging", "Riverside Hospital", "Northside Pathology"]);
      const tokens = { "sam-example": await launchFor("sam-example"), "riley-example": await launchFor("riley-example"), "josh-example": await launchFor("josh-example") };
      const study = { "sam-example": SAM[0]!, "riley-example": RILEY[0]!, "josh-example": "xr-wrist-left-2012" };
      for (const [holder, t] of Object.entries(tokens)) for (const [other, id] of Object.entries(study)) {
        if (holder === other) continue;
        expect([holder, other, (await search(t.access_token, other)).status]).toEqual([holder, other, 403]);
        expect([holder, other, (await drained(await wado(`${CONFIG.proxyUrl}/wado/-`, uidOf(id), t.access_token))).status]).toEqual([holder, other, 404]);
      }
      const r = await search(tokens["josh-example"].access_token, "josh-example");
      const s = r.studies[0];
      expect((await drained(await wado(r.address(s), r.uid(s), tokens["riley-example"].access_token))).status).toBe(404);
    }, 90000);
  });
}

describe("the guardian", () => {
  const riley = GUARDIANS_ON_FILE[0]!;
  const share = (from: string, sites: string[], withUser = "alex-neighbor") => ({ from: `user:${from}`, with: `user:${withUser}`, patient: "patient:riley-example", sites, label: "neighbor" });
  test("is a fact data/patient.json has on file, Riley is 15 by the patient record, and the biopsy's label is in both catalogs", async () => {
    expect(GUARDIANS_ON_FILE).toEqual([{ subject: `user:${SAM_ACCOUNT}`, relation: "guardian_of", object: "patient:riley-example", recordedBy: "registration" }]);
    const people = await Bun.file(join(root, "data/patient.json")).json();
    expect(people.otherPatients.find((p: any) => p.id === "riley-example").birthDate).toBe("2011-01-01");
    for (const s of (await Bun.file(join(root, "data/studies.source.json")).json()).studies.filter((x: any) => x.patient?.id === "riley-example")) expect(s.patient.birthDate).toBe("2011-01-01");
    for (const c of [stack.catalogs.archive, stack.catalogs.orthanc]) expect(c.allStudies().filter(x => x.labels?.length).map(x => [x.id, x.labels])).toEqual([[CONFIDENTIAL, ["confidential-adolescent"]]]);
    expect((await fetch(`${AUTH}/account/signin`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "username=riley", redirect: "manual" })).status).toBe(401);
  });
  test("survives every reset, and is in every new scope, and a reset still clears what people chose", async () => {
    await shareFromJosh(["Lakeside Imaging"]);
    await launchFor("riley-example");
    const res = await demo.fetch(new Request(`${CONFIG.demoUrl}/api/sandbox/reset`, { method: "POST", headers: { host: new URL(CONFIG.demoUrl).host, "content-type": "application/json", ...(await adminFor(demo, "/api/sandbox/reset")) }, body: JSON.stringify({ confirm: true }) }));
    const status: any = await res.json();
    const after = stack.store.snapshot();
    expect(after.relationships).toMatchObject([riley]);
    expect(after.policies).toEqual(ON_FILE.policies);
    expect(after.shares).toEqual([]);
    // What's on file again: each approval for every site, with no one's choice of sites left.
    expect(after.approvals.map((a: any) => [a.by, a.patient, a.sites])).toEqual(APPROVALS_ON_FILE.map(a => [a.by, a.patient, undefined]));
    expect(status.store.counts).toMatchObject({ relationships: 1, policies: 3, shares: 0, approvals: APPROVALS_ON_FILE.length });
    expect((await search((await launchFor("riley-example")).access_token, "riley-example")).ids).toEqual(RILEY);
    await stack.resetSaved();
    await stack.resetAll();
    expect(stack.sandboxes.mint().store.relationships()).toMatchObject([riley]);
    expect(stack.store.relationships()).toMatchObject([riley]);
  }, 60000);
  test("is a fact that grants through policy: taking away either ends Sam's access at once, and a reset puts both back", async () => {
    const t = await launchFor("riley-example");
    expect((await search(t.access_token, "riley-example")).ids).toEqual(RILEY);
    await stack.policy.replacePolicies("guardian-access", []);
    expect((await search(t.access_token, "riley-example")).ids).toEqual([]);
    await stack.resetAll();
    const u = await launchFor("riley-example");
    await stack.policy.removeRelationship(riley);
    expect((await search(u.access_token, "riley-example")).ids).toEqual([]);
    expect((await launchFor("riley-example")).error).toBe("access_denied");
    await stack.resetAll();
    expect((await search((await launchFor("riley-example")).access_token, "riley-example")).ids).toEqual(RILEY);
  }, 60000);
  test("the confidential study is left out everywhere for the guardian of a 15-year-old, with the token still Riley's", async () => {
    const t = await launchFor("riley-example");
    expect(t.patient).toBe("riley-example");
    const r = await search(t.access_token, "riley-example");
    expect(r.ids).toEqual(RILEY);
    expect((await wado(CONFIG.proxyUrl + "/wado/-", uidOf(CONFIDENTIAL), t.access_token)).status).toBe(404);
    expect((await accountPage(SAM_ACCOUNT)).html).not.toContain('value="Northside Pathology"');
    const e = await stack.explain({ client: "portal-app", user: SAM_ACCOUNT, fhirUser: "Patient/sam-example", patient: "riley-example" });
    const hidden = e.studies.find((s: any) => s.id === CONFIDENTIAL);
    expect(hidden.release).toBe("none");
    expect(hidden.because).toEqual([
      { level: "fact", ref: `user:${SAM_ACCOUNT}`, text: "Sam is Riley's guardian" },
      { level: "policy", ref: "policy:guardians-13-to-17", text: "Guardians of patients 13 to 17 see all studies, except those labeled confidential adolescent care" },
      { level: "fact", ref: `study:${CONFIDENTIAL}`, text: "Labeled confidential adolescent care" },
    ]);
  }, 60000);
  test("the age bands follow the sandbox's clock: under 13 the guardian sees the confidential study, and at 18 nothing", async () => {
    const w = stack.sandboxes.mint();
    // Five years back, Riley is 10.
    w.clock.setOffset(-5 * 366 * 86400);
    const young = await scriptedLaunch(SAM_ACCOUNT, "portal-app", { patient: "riley-example", at: w.urls });
    const inSandbox = (token: string) => fetch(`${w.urls.imaging}/fhir/ImagingStudy?patient=riley-example`, { headers: { Authorization: `Bearer ${token}` } }).then(async r => ((await r.json()) as any).entry?.filter((e: any) => e.resource.resourceType === "ImagingStudy").map((e: any) => e.resource.id).sort() ?? []);
    expect(await inSandbox(young.access_token)).toEqual([...RILEY, CONFIDENTIAL].sort());
    const e = await w.explain({ client: "portal-app", user: SAM_ACCOUNT, fhirUser: "Patient/sam-example", patient: "riley-example" });
    expect(e.studies.find((s: any) => s.id === CONFIDENTIAL).because[1]).toEqual({ level: "policy", ref: "policy:guardians-under-13", text: "Guardians of patients under 13 see all studies" });
    // The 18th birthday, 2029-01-01: no guardian-access policy covers Riley any more.
    w.clock.setOffset(Date.UTC(2029, 0, 1) / 1000 - Math.floor(Date.now() / 1000) + 60);
    const adult = await scriptedLaunch(SAM_ACCOUNT, "portal-app", { patient: "riley-example", at: w.urls });
    // Sam holds no record of Riley's now, so a launch for Riley is refused.
    expect(adult.error).toBe("access_denied");
    expect((await w.explain({ client: "portal-app", user: SAM_ACCOUNT, fhirUser: "Patient/sam-example", patient: "riley-example" })).studies[0].why).toBe("no guardian-access policy covers patients aged 18");
  }, 60000);
  test("a guardian's share can't reach the confidential study however it's written, and pages don't name its site", async () => {
    stack.store.putShare(share(SAM_ACCOUNT, ["Lakeside Imaging", "Northside Pathology"]));
    const t = await launchFor("riley-example", "alex-neighbor");
    expect((await search(t.access_token, "riley-example")).ids).toEqual(RILEY);
    expect((await wado(CONFIG.proxyUrl + "/wado/-", uidOf(CONFIDENTIAL), t.access_token)).status).toBe(404);
    expect((await accountPage(SAM_ACCOUNT)).html).not.toContain("Northside Pathology");
    expect((await accountPage("alex-neighbor")).html).not.toContain("Northside Pathology");
  }, 60000);
  test("only the patient or a guardian can share, however a row is written: a share with no route under it is refused", async () => {
    const samsRelationship = stack.store.relationships()[0]!.id!;
    for (const [from, basis] of [["alex-neighbor", undefined], ["SAM-CAREGIVER", undefined], ["riley-example", undefined], ["josh", undefined], ["alex-neighbor", "self"], ["alex-neighbor", samsRelationship]] as const) {
      expect(() => stack.store.setDocument({ shares: [{ ...share(from, ["Northside Pathology", "Lakeside Imaging"], "robin"), ...(basis ? { basis } : {}) }] })).toThrow("route");
      expect([from, stack.store.shares(), (await launchFor("riley-example", "robin")).error]).toEqual([from, [], "access_denied"]);
    }
    stack.store.setDocument({ shares: [share(SAM_ACCOUNT, ["Northside Pathology", "Lakeside Imaging"], "robin")] });
    const t = await launchFor("riley-example", "robin");
    expect((await search(t.access_token, "riley-example")).ids).toEqual(RILEY);
    expect((await wado(CONFIG.proxyUrl + "/wado/-", uidOf(CONFIDENTIAL), t.access_token)).status).toBe(404);
  }, 60000);
  test("a share the organization's policy doesn't allow is refused on the account page, naming the policy", async () => {
    await stack.policy.putPolicy({ ...ON_FILE.policies!.find(p => p.type === "sharing")!, allowedFrom: ["patient"] } as any);
    const r = await submitDelegation(accountUrl(SAM_ACCOUNT), { user: SAM_ACCOUNT, delegate: "alex-neighbor", relationship: "neighbor", sites: ["Lakeside Imaging"], patient: "riley-example" });
    expect(r.status).toBe(403);
    expect(await r.text()).toContain("no sharing policy lets guardians share (patients-and-guardians-share)");
    expect(stack.store.shares()).toEqual([]);
  }, 30000);
  test("pages don't name a confidential study's site, from an approval or a row that grants nothing", async () => {
    // An approval with no route under it can't be written at all.
    expect(() => stack.store.setDocument({ shares: [], approvals: [{ by: "user:alex-neighbor", app: "app:portal-app", patient: "patient:riley-example", sites: ["Northside Pathology"] }] })).toThrow("route");
    const page = (await accountPage("alex-neighbor")).html;
    expect(page).not.toContain("Northside Pathology");
    stack.store.setDocument({ shares: [share(SAM_ACCOUNT, ["Lakeside Imaging"])] });
    // With Sam's share under it, an approval naming only the confidential study's site can be written, and shows as no sites.
    stack.store.putApproval({ by: "user:alex-neighbor", app: "app:portal-app", patient: "patient:riley-example", sites: ["Northside Pathology"] });
    expect((await accountPage("alex-neighbor")).html).not.toContain("Northside Pathology");
    expect((await accountPage("alex-neighbor")).html).toContain("no sites");
  }, 30000);
  test("Orthanc serves encapsulated pixel data with the same bytes as the stores", async () => {
    const row = stack.catalogs.orthanc.allStudies().find(s => s.id === "slide-lung-2023")!;
    const hierarchy = stack.catalogs.orthanc.hierarchies([row.pk]).get(row.pk)!.series[0]!;
    const hash = async (name: "orthanc" | "static-files", instance: string) => {
      const b = await stack.backends[name].openBulk(row.uid, hierarchy.uid, instance, "7FE00010");
      const h = createHash("sha256"); let n = 0;
      for await (const c of b.body) { h.update(c); n += c.length; }
      return { n, sha: h.digest("hex") };
    };
    const instance = hierarchy.instances.find(i => i.uid.endsWith(".28.0"))!.uid;
    const orthanc = await hash("orthanc", instance);
    expect(orthanc.n).toBeGreaterThan(1000000);
    expect(orthanc).toEqual(await hash("static-files", instance));
  }, 60000);
  test("a share from someone who isn't the guardian grants nothing, and can't be made on the account page", async () => {
    await stack.policy.removeRelationship(GUARDIANS_ON_FILE[0]!);
    const r = await submitDelegation(accountUrl(SAM_ACCOUNT), { user: SAM_ACCOUNT, delegate: "alex-neighbor", relationship: "neighbor", sites: ["Lakeside Imaging"], patient: "riley-example" });
    expect(r.status).toBe(403);
    expect(() => stack.store.putShare({ from: `user:${SAM_ACCOUNT}`, with: "user:alex-neighbor", patient: "patient:riley-example", sites: ["Lakeside Imaging"], label: "neighbor" })).toThrow("route");
    expect((await launchFor("riley-example", "alex-neighbor")).error).toBe("access_denied");
  });
  test("Orthanc serves the bulk links its metadata lists, nested ones too, and only those", async () => {
    const row = stack.catalogs.orthanc.allStudies().find(s => s.id === "xr-hand-right-2012")!;
    const series = stack.catalogs.orthanc.hierarchies([row.pk]).get(row.pk)!.series[0]!;
    const open = async (ref: string) => { try { for await (const _ of (await stack.backends.orthanc.openBulk(row.uid, series.uid, series.instances[0]!.uid, ref)).body) { /* drain */ } return 200; } catch (e: any) { return e.kind ?? e.code ?? 404; } };
    expect(await open("7FE00010")).toBe(200);
    expect(await open("00283010/1/00283006")).toBe(200);
    expect(await open("00080018")).not.toBe(200);
    expect(await open("7fe0")).not.toBe(200);
  }, 30000);
  test("a guardian can't share what's confidential from them, even by naming its site", async () => {
    await submitDelegation(accountUrl(SAM_ACCOUNT), { user: SAM_ACCOUNT, delegate: "alex-neighbor", relationship: "neighbor", sites: ["Lakeside Imaging", "Northside Pathology"], patient: "riley-example" });
    expect(stack.store.shares()[0]!.sites).toEqual(["Lakeside Imaging"]);
    stack.store.putShare({ from: `user:${SAM_ACCOUNT}`, with: "user:alex-neighbor", patient: "patient:riley-example", sites: ["Lakeside Imaging", "Northside Pathology"], label: "neighbor" });
    const t = await launchFor("riley-example", "alex-neighbor");
    expect((await search(t.access_token, "riley-example")).ids).toEqual(RILEY);
  }, 60000);
  test("removing a guardian relationship removes what that guardian shared, and putting it back brings none of it back", async () => {
    await submitDelegation(accountUrl(SAM_ACCOUNT), { user: SAM_ACCOUNT, delegate: "alex-neighbor", relationship: "neighbor", sites: ["Lakeside Imaging"], patient: "riley-example" });
    expect(stack.store.shares()[0]).toMatchObject({ patient: "patient:riley-example", from: `user:${SAM_ACCOUNT}` });
    const t = await launchFor("riley-example", "alex-neighbor");
    expect((await search(t.access_token, "riley-example")).ids).toEqual(["syn-riley-knee-mr-2022"]);
    await stack.policy.removeRelationship(GUARDIANS_ON_FILE[0]!);
    expect((await search(t.access_token, "riley-example")).ids).toEqual([]);
    expect([stack.store.shares(), stack.store.approvals().filter(a => a.patient === "patient:riley-example")]).toEqual([[], []]);
    await stack.policy.putRelationship(GUARDIANS_ON_FILE[0]!);
    expect((await search(t.access_token, "riley-example")).ids).toEqual([]);
    const e = await stack.explain({ client: "portal-app", user: "alex-neighbor", fhirUser: "RelatedPerson/alex-neighbor", patient: "riley-example" });
    expect(e.studies[0].why).toBe("Alex has no share of Riley's records");
  }, 60000);
  test("the document round-trips through validation, and a bad relationship is refused", () => {
    const s = new PolicyStore({ mode: "memory", onFile: ON_FILE });
    const { revision, ...doc } = s.snapshot();
    s.setDocument(doc);
    expect(s.relationships()).toMatchObject([riley]);
    expect(() => s.setDocument({ relationships: [{ subject: "riley-example" } as any] })).toThrow("relationships[0].subject");
    expect(() => s.setDocument({ relationships: [riley, riley] })).toThrow("duplicate");
    s.close();
  });
  test("shows on the account page and in Explore", async () => {
    const { html } = await accountPage(SAM_ACCOUNT);
    expect(html).toContain("Riley Example</b>: you're their guardian, on file with the Imaging Server");
    expect(html).toContain("Sam Example</b>: your own records");
    const o: any = await (await demo.fetch(new Request(`${CONFIG.demoUrl}/api/sandbox/explore/cast`, { headers: { host: new URL(CONFIG.demoUrl).host, ...(await adminFor(demo, "/api/sandbox/explore/cast")) } }))).json();
    expect(o.people.find((p: any) => p.id === SAM_ACCOUNT).role).toStartWith("Riley's parent and guardian");
  });
  test("its chain reads plainly, in the Imaging Server's view", async () => {
    const x = await stack.explain({ client: "portal-app", user: SAM_ACCOUNT, fhirUser: "Patient/sam-example", patient: "riley-example" });
    expect(x.studies.map((s: any) => s.why).sort()).toEqual(["Sam is a guardian, and guardians-13-to-17 covers this study", "confidential adolescent care: guardians-13-to-17 keeps it from guardians"]);
  });
});

describe("each link only narrows", () => {
  test("Sam shares part of their own record, and Alex's app gets no more than that", async () => {
    await submitDelegation(accountUrl(SAM_ACCOUNT), { user: SAM_ACCOUNT, delegate: "alex-neighbor", relationship: "neighbor", sites: ["Lakeside Imaging", "Northside Pathology"], patient: "sam-example" });
    // Sam has nothing at Northside, so it isn't recorded.
    expect(stack.store.shares()).toMatchObject([{ from: `user:${SAM_ACCOUNT}`, with: "user:alex-neighbor", patient: "patient:sam-example", sites: ["Lakeside Imaging"], label: "neighbor", basis: "self" }]);
    const wide = await launchFor("sam-example", "alex-neighbor", { sites: ["Lakeside Imaging", "Riverside Hospital"] });
    expect((await search(wide.access_token, "sam-example")).ids).toEqual(["syn-sam-ct-sinus-2024"]);
    expect(stack.store.approvals().find(a => a.by === "user:alex-neighbor")!.sites).toEqual(["Lakeside Imaging"]);
    const none = await launchFor("sam-example", "alex-neighbor", { sites: [] });
    expect((await search(none.access_token, "sam-example")).ids).toEqual([]);
    expect((await drained(await wado(`${CONFIG.proxyUrl}/wado/-`, uidOf("syn-sam-chest-xr-2021"), wide.access_token))).status).toBe(404);
    expect((await search(wide.access_token, "riley-example")).status).toBe(403);
  }, 60000);
  test("Sam's own app can be narrowed too, and sharing with Alex doesn't narrow Sam", async () => {
    await submitDelegation(accountUrl(SAM_ACCOUNT), { user: SAM_ACCOUNT, delegate: "alex-neighbor", relationship: "neighbor", sites: ["Lakeside Imaging"], patient: "sam-example" });
    const t = await launchFor("sam-example", SAM_ACCOUNT, { sites: ["Riverside Hospital"] });
    expect((await search(t.access_token, "sam-example")).ids).toEqual(["syn-sam-chest-xr-2021"]);
    expect((await search((await launchFor("sam-example", SAM_ACCOUNT, { sites: ["Lakeside Imaging", "Riverside Hospital"] })).access_token, "sam-example")).ids).toEqual(SAM);
  }, 30000);
  test("what Josh shared stops at Sam: it can't be passed on, and the page says so", async () => {
    await shareFromJosh(["Lakeside Imaging"]);
    const r = await submitDelegation(accountUrl(SAM_ACCOUNT), { user: SAM_ACCOUNT, delegate: "alex-neighbor", relationship: "neighbor", sites: ["Lakeside Imaging"], patient: "josh-example" });
    expect(r.status).toBe(403);
    expect((await accountPage(SAM_ACCOUNT)).html).toContain("Josh Example shared with you, so you can give an app part of that, and can't pass it on");
  }, 30000);
  test("revoking one person's share or app leaves another's", async () => {
    for (const patient of ["sam-example", "riley-example"]) await submitDelegation(accountUrl(SAM_ACCOUNT), { user: SAM_ACCOUNT, delegate: "alex-neighbor", relationship: "neighbor", sites: ["Lakeside Imaging"], patient });
    await submitRevocation(accountUrl(SAM_ACCOUNT), { user: SAM_ACCOUNT, delegate: "alex-neighbor", patient: "sam-example" });
    expect(stack.store.shares().map(d => d.patient)).toEqual(["patient:riley-example"]);
    await launchFor("sam-example"); await launchFor("riley-example");
    const { cookie } = await accountPage(SAM_ACCOUNT);
    await fetch(`${AUTH}/account/apps/revoke`, { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: "client=portal-app&patient=sam-example", redirect: "manual" });
    expect(stack.store.approvals().filter(g => g.by === `user:${SAM_ACCOUNT}`).map(g => g.patient)).toEqual(["patient:riley-example"]);
  }, 60000);
});

describe("choosing on the Authorization Server's pages", () => {
  const consent = async (hint?: string) => {
    const conf: any = await (await fetch(`${CLINICAL_FHIR}/.well-known/smart-configuration`)).json();
    const a = buildAuthorization(conf.authorization_endpoint, "portal-app", undefined, undefined, SAM_ACCOUNT, hint);
    const page = await (await fetch(a.url)).text();
    const action = new URL(page.match(/<form[^>]*action="([^"]+)"/)![1]!.replaceAll("&amp;", "&"), a.url).toString();
    const signed = await fetch(action, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `username=${SAM_ACCOUNT}`, redirect: "manual" });
    const consentUrl = new URL(signed.headers.get("location")!, a.url).toString();
    const html = await (await fetch(consentUrl)).text();
    return { html, decision: new URL(html.match(/<form[^>]*action="([^"]+)"/)![1]!.replaceAll("&amp;", "&"), consentUrl).toString() };
  };
  const radios = (html: string) => [...html.matchAll(/name="patient" value="([^"]+)"( checked)?/g)].map(m => [m[1], !!m[2]]);
  test("the consent page sets self apart from others, with one selected, and a hint only preselects", async () => {
    const { html } = await consent();
    expect(radios(html)).toEqual([["sam-example", true], ["riley-example", false]]);
    expect(html).toContain('<p class="people-group">You</p>');
    expect(html).toContain("People you hold records for");
    expect(radios((await consent("riley-example")).html)).toEqual([["sam-example", false], ["riley-example", true]]);
    expect(radios((await consent("josh-example")).html)).toEqual([["sam-example", true], ["riley-example", false]]);
  });
  test("each person's sites are their own on the form, and only the chosen person's count", async () => {
    const { html, decision } = await consent("riley-example");
    expect(html).toContain('name="sites@riley-example" value="Lakeside Imaging"');
    expect(html).not.toContain('name="sites@riley-example" value="Northside Pathology"');
    expect(html).toContain('name="sites@sam-example" value="Riverside Hospital"');
    const form = new URLSearchParams({ decision: "approve", patient: "riley-example", "sites_shown@riley-example": "1", "sites_shown@sam-example": "1" });
    form.append("sites@riley-example", "Lakeside Imaging");
    form.append("sites@sam-example", "Lakeside Imaging");
    const r = await fetch(decision, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString(), redirect: "manual" });
    expect(new URL(r.headers.get("location")!).searchParams.get("code")).toBeTruthy();
    expect(stack.store.approvals().filter(a => a.patient === "patient:riley-example")).toMatchObject([{ by: `user:${SAM_ACCOUNT}`, app: "app:portal-app", patient: "patient:riley-example", sites: ["Lakeside Imaging"], basis: [stack.store.relationships()[0]!.id] }]);
  });
  test("a person holding one record sees the plain form", async () => {
    const html = (await accountPage("josh")).html;
    expect(html).toContain('<input type="hidden" name="patient" value="josh-example">');
    expect(html).toContain('name="sites" value="Lakeside Imaging"');
    expect(html).not.toContain("Whose records");
  });
  test("the account page offers whose records to share where there's a choice", async () => {
    const { html } = await accountPage(SAM_ACCOUNT);
    expect(html).toContain("<legend>Whose records</legend>");
    expect(html).toContain('name="sites@riley-example" value="Lakeside Imaging"');
    expect(html).toContain("People who can sign in and see records you hold");
  });
  test("every patient has a Patient resource, for a token for that patient", async () => {
    const t = await scriptedLaunch(SAM_ACCOUNT, "portal-app", { patient: "riley-example", scope: "launch/patient patient/Patient.rs patient/ImagingStudy.rs" });
    const r = await fetch(`${CLINICAL_FHIR}/Patient/riley-example`, { headers: { Authorization: `Bearer ${t.access_token}` } });
    expect(await r.json()).toMatchObject({ resourceType: "Patient", id: "riley-example", name: [{ family: "Example", given: ["Riley"] }], birthDate: "2011-01-01" });
    expect((await fetch(`${CLINICAL_FHIR}/Patient/sam-example`, { headers: { Authorization: `Bearer ${t.access_token}` } })).status).toBe(403);
  });
});

describe("Explore", () => {
  /** Explore's page, as far as the sandbox's side goes: the cast, a view explained from policy, and changes through the policy API. */
  const browser = () => {
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await demo.fetch(new Request(`${CONFIG.demoUrl}${path}`, { method, headers: { host: new URL(CONFIG.demoUrl).host, "content-type": "application/json", ...(await adminFor(demo, path)) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
      return r.json() as Promise<any>;
    };
    let last: any = {}, n = 0;
    const view = async (q: Record<string, string>) => { last = q; const session = `explore-${q.user ?? q.client}-${++n}`; return { session, ...(await call("GET", `/api/sandbox/explore/view?${new URLSearchParams({ session, ...q })}`)) }; };
    const pick = (user: string, extra: any = {}) => view({ user, ...extra });
    const settle = () => view(last);
    const share = (from: string, to: string, patient: string, sites: string[]) => call("POST", "/api/sandbox/policy/shares", { from: `user:${from}`, with: `user:${to}`, patient: `patient:${patient}`, sites, label: "caregiver" });
    return { call, pick, settle, view, share };
  };
  const ids = (s: any) => s.rows.filter((x: any) => x.released).map((x: any) => x.id).sort();
  beforeEach(async () => { await stack.resetSaved(); });
  test("Sam's choices are who Sam holds, and Josh joins them once he shares", async () => {
    const b = browser();
    const sam = async () => (await b.call("GET", "/api/sandbox/explore/cast")).people.find((p: any) => p.id === SAM_ACCOUNT);
    expect((await sam()).records.map((r: any) => [r.patient, r.via])).toEqual([["sam-example", "self"], ["riley-example", "guardian"]]);
    expect((await sam()).others.map((o: any) => o.patient)).toEqual(["josh-example"]);
    await b.pick(SAM_ACCOUNT, { patient: "josh-example" });
    await b.share("josh", SAM_ACCOUNT, "josh-example", ["Lakeside Imaging"]);
    expect((await sam()).records.map((r: any) => [r.patient, r.via])).toEqual([["sam-example", "self"], ["riley-example", "guardian"], ["josh-example", "share"]]);
    expect((await sam()).others).toEqual([]);
  }, 60000);
  test("switching whose records is a new view, and the headline says whose they are", async () => {
    const b = browser();
    const own = await b.pick(SAM_ACCOUNT);
    expect(own.patient).toBe("sam-example");
    expect([own.headline, own.detail]).toEqual(["Sam's own studies", "The Health Records App can see both."]);
    expect(ids(own)).toEqual(SAM);
    expect(own.chain.rows.map((r: any) => [r.level, r.name])).toEqual([["fact", "Sam is the patient"], ["policy", "Imaging network rule: anyone can share what they can see with an app that acts for them. What Sam can see:"], ["choice", "Sam lets the Health Records App act for Sam on Sam's studies at every site"], ["outcome", "What the app can see"]]);
    const riley = await b.pick(SAM_ACCOUNT, { patient: "riley-example" });
    expect(riley.session).not.toBe(own.session);
    // The headline counts none of Riley's studies: Sam may know of only one.
    expect([riley.headline, riley.detail]).toEqual(["Riley's studies Sam can see", "The Health Records App can see this one."]);
    expect(ids(riley)).toEqual(RILEY);
    // The chain names the guardian's age band, and no label: the one study Sam may know of passes every row.
    expect(riley.chain.rows.map((r: any) => [r.level, r.name, r.has])).toEqual([["fact", "Sam is on file as Riley's guardian", []], ["fact", expect.stringMatching(/^Riley is 1[5-7]$/), []], ["policy", "Imaging network rule: guardians of patients aged 13 to 17 can see everything except studies labeled confidential", RILEY], ["policy", "Imaging network rule: anyone can share what they can see with an app that acts for them. What Sam can see:", RILEY], ["choice", "Sam, as Riley's guardian, lets the Health Records App act for Sam on Riley's studies at every site", RILEY], ["outcome", "What the app can see", RILEY]]);
    // The rule's general text names a label, whether or not any study carries it. Nothing that identifies the hidden study is here:
    // not its id, UID, title or site, no lock, no label row, and no count that includes it.
    const hidden = stack.catalog.allStudies().find(x => x.id === "syn-riley-skin-slide-2023")!;
    for (const trace of [hidden.id, hidden.uid, hidden.title!, "Skin biopsy", "skin biopsy", "Northside", "confidential-adolescent", "keeps it from guardians"]) expect([trace, JSON.stringify(riley).includes(trace)]).toEqual([trace, false]);
    expect(riley.chain.columns.some((c: any) => c.locked)).toBe(false);
    expect(riley.chain.rows.some((r: any) => r.kind === "label" || r.kind === "records")).toBe(false);
    expect(riley.rows.length).toBe(1);
    const denied = await b.pick(SAM_ACCOUNT, { patient: "josh-example" });
    expect(denied.status).toBe("no-access");
    expect(denied.headline).toBe("Sam can't see Josh's studies");
    expect(denied.empty.text).toBe("Sam isn't Josh's guardian, and no one shares Josh's studies with Sam.");
    expect(denied.empty.actions.map((o: any) => o.label)).toEqual(["As Josh: share his studies with Sam"]);
    // A denial draws the same diagram, with what's missing and nothing at the end.
    expect(denied.chain.rows.map((r: any) => [r.kind, r.missing ?? false, r.has.length])).toEqual([["sharing", false, 0], ["share", true, 0], ["app-rule", false, 0], ["approval", true, 0], ["outcome", false, 0]]);
    await b.share("josh", SAM_ACCOUNT, "josh-example", ["Lakeside Imaging"]);
    // Sam approves the app for what Josh shares, as Sam's sign-in would.
    await b.call("POST", "/api/sandbox/policy/app-approvals", { by: `user:${SAM_ACCOUNT}`, app: "app:portal-app", patient: "patient:josh-example" });
    const shared = await b.settle();
    expect(shared.patient).toBe("josh-example");
    expect(ids(shared)).toEqual(["mri-brain-2020"]);
    expect(shared.chain.rows.find((r: any) => r.kind === "share")).toMatchObject({ level: "choice", name: "Josh shares his studies at Lakeside with Sam", has: ["mri-brain-2020"] });
  }, 60000);
  test("Sam's own results offer no share from Josh, and Robin's empty result offers one way on, someone else's records", async () => {
    const b = browser();
    expect((await b.pick(SAM_ACCOUNT)).empty).toBeUndefined();
    const robin = await b.pick("robin");
    expect(robin.headline).toBe("Robin has no studies on file");
    expect(robin.empty.actions).toEqual([{ kind: "person", label: "See Josh's studies", user: "josh" }]);
    expect(robin.actions.map((a: any) => a.kind)).toEqual(["revoke-app"]);
  }, 60000);
  test("a service reaches a patient only through its referrals, and rule sets still name only Josh", async () => {
    const b = browser();
    const o = await b.call("GET", "/api/sandbox/explore/cast");
    expect(o.services.map((x: any) => x.id)).toEqual(["hand-referral-service", "outside-release-service", "research-donation"]);
    expect((await b.call("GET", "/api/sandbox/explore/referrals")).referrals.length).toBe(10);
    const s = await b.view({ client: "research-donation", referral: "referral-syn-riley-knee-mr-2022" });
    expect(s.status).toBe("forbidden");
    // No rule set reaches Riley's study for this service: the one way on is a referral one of its rule sets does reach.
    expect(s.empty.actions).toEqual([{ kind: "referral", label: expect.stringMatching(/^Open the .+ referral$/), referral: expect.any(String) }]);
    const next = (await b.call("GET", "/api/sandbox/explore/referrals")).referrals.find((r: any) => r.id === s.empty.actions[0].referral);
    expect(next.patient).toBe("Josh");
    const { RULE_SETS } = await import("../src/rule-presets");
    for (const set of RULE_SETS) for (const rule of set.rules(stack.catalog) ?? []) expect(rule.patients).toBe("patient:josh-example");
  }, 60000);
});

describe("flow 15, and flow 2's choice", () => {
  const whose = FLOWS.find(f => f.number === 15)!;
  const caregiver = FLOWS.find(f => f.number === 2)!;
  const run = async (flow: typeof whose, override: Record<string, Record<string, any>> = {}) => {
    const c = await startFlow(stack, clients, flow);
    const all: Record<string, any[]> = {};
    for (const step of flow.steps) all[step.id] = (await runStep(c, flow, step.id, { ...defaultsFor(c, flow, step.id), ...(override[step.id] ?? {}) })).checks;
    return all;
  };
  const failures = (r: Record<string, any[]>) => Object.values(r).flat().filter(k => !k.ok);
  test("is a policy flow, and its defaults pass, covering every step asked for", async () => {
    expect(whose.title).toBe("Caregiver picks whose records");
    expect(whose.group).toBe("policy");
    const r = await run(whose);
    expect(failures(r)).toEqual([]);
    expect(r.own!.map(k => k.label)).toContain("The token is for Sam's own record");
    expect(r.guardian!.map(k => k.label)).toContain("The guardian is on file, and nobody has shared anything");
    expect(r.josh!.map(k => k.label)).toEqual(expect.arrayContaining(["Before Josh shares, Sam's sign-in for Josh gets no token", "Sam sees only the sites Josh shared"]));
    expect(r.cross!.map(k => k.label)).toEqual(expect.arrayContaining(["Searching for Josh with Riley's token gets 403", "Retrieving Josh's study with Riley's token gets 404, after asking"]));
    expect(r["one-patient"]!.map(k => k.label)).toContain("Sam gave the viewer one person");
  }, 120000);
  test("its other choices pass, or say plainly why not", async () => {
    expect(failures(await run(whose, { josh: { sites: [] }, "one-patient": { whose: "sam-example" }, share: { whose: "riley-example", sites: ["Northside Pathology"] } }))).toEqual([]);
    expect(failures(await run(whose, { share: { whose: "josh-example" } }))).toEqual([]);
    const c = await startFlow(stack, clients, whose);
    const stepped = await runStep(c, whose, "one-patient", { whose: "josh-example" }).then(() => "ran", e => e.message);
    expect(stepped).toBe("Josh hasn't shared records with Sam, so the app has no token");
  }, 120000);
  test("in a real window, someone else signing in, or Sam approving someone else, is explained", async () => {
    const inWindow = async (c: Awaited<ReturnType<typeof startFlow>>, step: string, user: string, patient?: string) => {
      const running = runStep(c, whose, step, { mode: "window" }).then(r => r.checks, e => e.message as string);
      while (!c.pendingAuthUrl) await Bun.sleep(5);
      c.resolveCallback!(await submitConsent(c.pendingAuthUrl, { user, patient }));
      return running;
    };
    expect(await inWindow(await startFlow(stack, clients, whose), "own", "alex-neighbor")).toBe("No patient has shared records with Alex, so the app has no token. alex-neighbor signed in, and this step expected sam-caregiver");
    const checks = await inWindow(await startFlow(stack, clients, whose), "guardian", SAM_ACCOUNT, "sam-example") as any[];
    const wrong = checks.filter(k => !k.ok);
    expect(wrong.map(k => [k.label, k.detail])).toEqual([["The token is for Riley", "Sam approved Sam's records in the window, and this step had Riley's selected"]]);
    expect(checks.find(k => k.label === "The search returns that person's studies, and no one else's").ok).toBe(true);
  }, 60000);
  test("flow 2 passes for each person Sam can act on", async () => {
    for (const patient of ["josh-example", "sam-example", "riley-example"]) {
      expect([patient, failures(await run(caregiver, { "sam-launch": { whose: patient } }))]).toEqual([patient, []]);
    }
    const r = await run(caregiver, { "sam-launch": { whose: "riley-example" } });
    expect(r.searches!.map(k => k.label)).toEqual(expect.arrayContaining(["Sam's app sees only Riley's records, at the sites Sam gave it", "That token asking for Josh gets 403, because it's for Riley"]));
    expect(r.revoke!.map(k => k.label)).toEqual(["Riley's records don't depend on Josh, so Sam's app sees the same studies"]);
  }, 180000);
});

describe("the synthetic data", () => {
  const load = async () => syntheticStudies(await Bun.file(join(root, "data/studies.source.json")).json());
  const hashOfDir = (dir: string) => { const h = createHash("sha256"); for (const f of (readdirSync(dir, { recursive: true }) as string[]).filter(n => n.endsWith(".dcm")).sort()) { h.update(f); h.update(new Uint8Array(Bun.file(join(dir, f)).size)); } return h; };
  test("a rebuild gives the same bytes, which are pinned here", async () => {
    const h = createHash("sha256");
    const studies = await load();
    for (const study of studies) for (const s of study.series) for (let n = 1; n <= s.instances; n++) h.update(syntheticInstance(study, s, n));
    // Riley's birth date, 2011-01-01, is in these bytes.
    expect(h.digest("hex")).toBe("e24530a2ea9dce80ab75381861e5b0163284f0b9395dbe38f094a0ee6ee98d0a");
    const a = mkdtempSync(join(tmpdir(), "synthetic-a-")), b = mkdtempSync(join(tmpdir(), "synthetic-b-"));
    try {
      await writeSynthetic(a, studies); await writeSynthetic(b, studies);
      expect(hashOfDir(a).digest("hex")).toBe(hashOfDir(b).digest("hex"));
      const files = (readdirSync(a, { recursive: true }) as string[]).filter(n => n.endsWith(".dcm"));
      for (const f of files) expect(createHash("sha256").update(await Bun.file(join(a, f)).bytes()).digest("hex")).toBe(createHash("sha256").update(await Bun.file(join(b, f)).bytes()).digest("hex"));
    } finally { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); }
  });
  test("every instance is valid Explicit VR 256 by 256 16-bit, and labeled synthetic where it's read", async () => {
    for (const study of await load()) for (const s of study.series) for (let n = 1; n <= s.instances; n++) {
      const p = parsePart10(syntheticInstance(study, s, n));
      expect(p.transferSyntax).toBe("1.2.840.10008.1.2.1");
      expect(p.pixelLength).toBe(256 * 256 * 2);
      expect(str(p.dataset, "00081030")).toStartWith("SYNTHETIC");
      expect(str(p.dataset, "0008103E")).toStartWith("SYNTHETIC");
      expect(str(p.dataset, "00204000")).toStartWith("SYNTHETIC");
      expect(str(p.dataset, "00100020")).toBe(study.patient.mrn);
      expect(str(p.dataset, "0020000D")!.length).toBeLessThanOrEqual(64);
    }
  });
  test("each study is at one of the existing sites, with its own IDs, and Josh's aren't among them", async () => {
    const def = await Bun.file(join(root, "data/studies.source.json")).json();
    const real = def.studies.filter((s: any) => !s.synthetic);
    const studies = await load();
    expect(studies.map(s => s.id).sort()).toEqual([...RILEY, CONFIDENTIAL, ...SAM].sort());
    expect(new Set(studies.map(s => s.site)).size).toBe(3);
    for (const s of studies) expect(real.map((r: any) => r.site)).toContain(s.site);
    const people = await Bun.file(join(root, "data/patient.json")).json();
    expect(new Set(studies.map(s => s.patient.mrn))).toEqual(new Set(["SEXAMPLE01", "RYEXAMPLE01"]));
    expect(studies.map(s => s.patient.mrn)).not.toContain(people.mrn);
    expect(people.otherPatients.map((p: any) => p.mrn)).toEqual(expect.arrayContaining(["SEXAMPLE01", "RYEXAMPLE01"]));
    const catalog = (await Bun.file(join(root, "data/orthanc-catalog.json")).json()).studies;
    for (const s of studies) expect(catalog[s.accession]).toEqual({ id: s.id, title: expect.stringContaining("SYNTHETIC"), site: s.site, ...(s.id === CONFIDENTIAL ? { labels: ["confidential-adolescent"] } : {}) });
    expect(await Bun.file(join(root, "scripts/generate-synthetic.ts")).text()).not.toMatch(/\bfetch\(|https?:\/\//);
  });
  test("what's in the archive and both catalogs is what the generator makes, sharing nothing with Josh's", async () => {
    const reader = new ArchiveReader(fileStore(CONFIG.archive.dir));
    const offers = async (id: string) => {
      const row = stack.catalogs.archive.allStudies().find(s => s.id === id)!;
      const v = await reader.currentVersion(row.uid);
      const doc = await reader.study(row.uid, v);
      return (await Promise.all(doc.series.map(async s => (await reader.seriesIndex(row.uid, v, s.uid)).instances))).flat().flatMap(i => i.offers.map(o => o.sha256));
    };
    const generated = (await load()).flatMap(study => study.series.flatMap(s => Array.from({ length: s.instances }, (_, i) => createHash("sha256").update(syntheticInstance(study, s, i + 1)).digest("hex"))));
    const held = (await Promise.all([...SAM, ...RILEY, CONFIDENTIAL].map(offers))).flat();
    expect(held.sort()).toEqual(generated.sort());
    const josh = new Set((await Promise.all(JOSH.map(offers))).flat());
    expect(held.filter(h => josh.has(h))).toEqual([]);
    for (const catalog of [stack.catalogs.archive, stack.catalogs.orthanc]) {
      for (const id of [...SAM, ...RILEY, CONFIDENTIAL]) {
        const row = catalog.allStudies().find(s => s.id === id)!;
        expect(row.description).toStartWith("SYNTHETIC");
        expect(row.title).toStartWith("SYNTHETIC");
        expect(catalog.hierarchies([row.pk]).get(row.pk)!.series.every(s => s.description!.startsWith("SYNTHETIC"))).toBe(true);
      }
    }
  });
  test("the docs say which patients are real, public, and synthetic", async () => {
    const readme = await Bun.file(join(root, "README.md")).text();
    for (const words of ["real patient's, de-identified", "CC BY 4.0", "Sam Example's and Riley Example's", "Fully synthetic"]) expect(readme).toContain(words);
    expect((await Bun.file(join(root, "data/patient.json")).json())._note).toContain("fully synthetic");
    expect((await Bun.file(join(root, "data/studies.source.json")).json())._note).toContain("synthetic");
  });
});
