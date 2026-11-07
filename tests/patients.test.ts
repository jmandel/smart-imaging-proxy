// Several patients, and a caregiver choosing among them: what each person can reach on every backend,
// what one patient's token can't reach, the standing guardian, sharing, and the synthetic data.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { startStack, type BackendName, type Stack } from "../src/stack";
import { defaultsFor, FLOWS, registerClients, runStep, startFlow } from "../src/flows";
import { accountUrl, buildAuthorization, CLINICAL_FHIR, scriptedLaunch, submitConsent, submitDelegation, submitRevocation } from "../src/flows/oauth";
import { createDemoServer } from "../src/demo-server";
import { PolicyStore, SCHEMA_VERSION, STANDING_GUARDIANS } from "../src/policy-store";
import { parsePart10, str } from "../src/dicom";
import { fileStore } from "../src/archive/sources";
import { ArchiveReader } from "../src/archive/reader";
import { CONFIG } from "../src/config";
import { syntheticInstance, syntheticStudies, writeSynthetic } from "../scripts/generate-synthetic";

const root = join(import.meta.dir, "..");
const BACKENDS: BackendName[] = (process.env.BACKENDS?.split(",") as BackendName[]) ?? ["static-files", "s3", "orthanc"];
const JOSH = ["ct-abdomen-pelvis-2012", "mri-brain-2020", "slide-lung-2023", "xr-hand-right-2012", "xr-hand-wrist-right-2012", "xr-wrist-left-2012"];
const SAM = ["syn-sam-chest-xr-2021", "syn-sam-ct-sinus-2024"];
const CONFIDENTIAL = "syn-riley-skin-slide-2023";
const RILEY = ["syn-riley-knee-mr-2022"]; // What Sam gets: the other study is confidential from Sam.
const SAM_ACCOUNT = "sam-caregiver";
const AUTH = CLINICAL_FHIR.replace("/fhir", "");

let stack: Stack; let demo: ReturnType<typeof createDemoServer>; let clients: ReturnType<typeof registerClients>;
beforeAll(async () => { stack = await startStack(root); clients = registerClients(stack); demo = createDemoServer(stack, clients, root); });
afterAll(() => stack.stop());
beforeEach(() => { stack.resetAll(); stack.setBackend("static-files"); });

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
      expect(stack.imaging.getPolicy().delegations).toEqual([]);
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
  const riley = STANDING_GUARDIANS[0]!;
  test("is what data/patient.json has on file, and Riley has no account", async () => {
    expect(STANDING_GUARDIANS).toEqual([{ patient: "riley-example", guardian: SAM_ACCOUNT, relationship: "guardian", excludedStudies: [CONFIDENTIAL] }]);
    expect((await fetch(`${AUTH}/account/signin`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "username=riley", redirect: "manual" })).status).toBe(401);
  });
  test("survives every reset, in saved and in scratch, and a reset still clears what people chose", async () => {
    stack.useStore("saved");
    await shareFromJosh(["Lakeside Imaging"]);
    await launchFor("riley-example");
    const res = await demo.fetch(new Request(`${CONFIG.demoUrl}/api/admin/store/reset-saved`, { method: "POST", headers: { host: new URL(CONFIG.demoUrl).host, "content-type": "application/json" }, body: JSON.stringify({ confirm: true }) }));
    const status: any = await res.json();
    expect(status.policy.guardians).toEqual([riley]);
    expect(status.policy.delegations).toEqual([]);
    expect(status.policy.appGrants).toEqual([]);
    expect(status.store.saved.counts).toMatchObject({ guardians: 1, delegations: 0, appGrants: 0 });
    expect((await search((await launchFor("riley-example")).access_token, "riley-example")).ids).toEqual(RILEY);
    stack.resetSaved();
    stack.resetAll();
    expect(stack.stores.scratch.guardians()).toEqual([riley]);
    expect(stack.stores.saved.guardians()).toEqual([riley]);
  }, 60000);
  test("is real policy: taking it away ends Sam's access at once, and a reset puts it back", async () => {
    const t = await launchFor("riley-example");
    expect((await search(t.access_token, "riley-example")).ids).toEqual(RILEY);
    stack.imaging.setPolicy({ guardians: [] });
    expect((await search(t.access_token, "riley-example")).ids).toEqual([]);
    expect((await launchFor("riley-example")).error).toBe("access_denied");
    stack.resetAll();
    expect((await search((await launchFor("riley-example")).access_token, "riley-example")).ids).toEqual(RILEY);
  }, 60000);
  test("a confidential study is left out everywhere for a guardian, with the token still Riley's", async () => {
    const t = await launchFor("riley-example");
    expect(t.patient).toBe("riley-example");
    const r = await search(t.access_token, "riley-example");
    expect(r.ids).toEqual(RILEY);
    expect((await wado(CONFIG.proxyUrl + "/wado/-", uidOf(CONFIDENTIAL), t.access_token)).status).toBe(404);
    expect((await accountPage(SAM_ACCOUNT)).html).not.toContain('value="Northside Pathology"');
    const e = await stack.explain({ client: "portal-app", user: SAM_ACCOUNT, fhirUser: "Patient/sam-example", patient: "riley-example" });
    expect(e.studies.find((s: any) => s.id === CONFIDENTIAL).reason).toContain("confidential");
    expect(STANDING_GUARDIANS[0]!.excludedStudies).toEqual([CONFIDENTIAL]);
  }, 60000);
  test("a confidential study stays out however a share from the guardian is written, and pages don't name its site", async () => {
    stack.useStore("scratch");
    stack.imaging.setPolicy({ delegations: [{ patient: "riley-example", grantedBy: SAM_ACCOUNT, delegate: "alex-neighbor", relationship: "neighbor", sites: ["Lakeside Imaging", "Northside Pathology"] }] });
    const t = await launchFor("riley-example", "alex-neighbor");
    expect((await search(t.access_token, "riley-example")).ids).toEqual(RILEY);
    expect((await wado(CONFIG.proxyUrl + "/wado/-", uidOf(CONFIDENTIAL), t.access_token)).status).toBe(404);
    expect((await accountPage(SAM_ACCOUNT)).html).not.toContain("Northside Pathology");
    expect((await accountPage("alex-neighbor")).html).not.toContain("Northside Pathology");
    stack.useStore("saved");
  }, 60000);
  test("only the patient or a guardian can grant, however a row is written", async () => {
    stack.useStore("scratch");
    const share = (grantedBy: string) => ({ patient: "riley-example", grantedBy, delegate: "robin", relationship: "x", sites: ["Northside Pathology", "Lakeside Imaging"] });
    for (const grantedBy of ["alex-neighbor", "SAM-CAREGIVER", "sam-caregiver ", "riley-example", "josh"]) {
      stack.imaging.setPolicy({ delegations: [share(grantedBy)] });
      expect([grantedBy, (await launchFor("riley-example", "robin")).error]).toEqual([grantedBy, "access_denied"]);
    }
    stack.imaging.setPolicy({ delegations: [{ ...share("sam-caregiver") }] });
    const t = await launchFor("riley-example", "robin");
    expect((await search(t.access_token, "riley-example")).ids).toEqual(RILEY);
    expect((await wado(CONFIG.proxyUrl + "/wado/-", uidOf(CONFIDENTIAL), t.access_token)).status).toBe(404);
    stack.useStore("saved");
  }, 60000);
  test("an account page doesn't name a confidential study's site, through someone's app grant either", async () => {
    stack.useStore("scratch");
    stack.imaging.setPolicy({ delegations: [{ patient: "riley-example", grantedBy: SAM_ACCOUNT, delegate: "alex-neighbor", relationship: "neighbor", sites: ["Lakeside Imaging"], asGuardian: true }], appGrants: [{ client: "portal-app", user: "alex-neighbor", patient: "riley-example", sites: ["Northside Pathology"] }] });
    expect((await accountPage("alex-neighbor")).html).not.toContain("Northside Pathology");
    stack.useStore("saved");
  }, 30000);
  test("pages don't name a confidential study's site, from a grant or a row that grants nothing", async () => {
    stack.useStore("scratch");
    stack.imaging.setPolicy({ delegations: [], appGrants: [{ client: "portal-app", user: "alex-neighbor", patient: "riley-example", sites: ["Northside Pathology"] }] });
    const scratchPage = (await accountPage("alex-neighbor")).html;
    expect(scratchPage).not.toContain("Northside Pathology");
    expect(scratchPage).toContain("no sites");
    stack.useStore("saved");
    const saved = stack.stores.saved;
    saved.setPolicy({ delegations: [{ patient: "riley-example", grantedBy: SAM_ACCOUNT, delegate: "alex-neighbor", relationship: "neighbor", sites: ["Lakeside Imaging"], asGuardian: true }], appGrants: [{ client: "portal-app", user: "alex-neighbor", patient: "riley-example", sites: ["Northside Pathology"] }] });
    const granted = await stack.explain({ client: "portal-app", user: "alex-neighbor", fhirUser: "RelatedPerson/alex-neighbor", patient: "riley-example" });
    expect(granted.appGrant.sites).toEqual([]);
    saved.setPolicy({ delegations: [{ patient: "riley-example", grantedBy: "josh", delegate: "alex-neighbor", relationship: "neighbor", sites: ["Northside Pathology"] }] });
    const refused = await stack.explain({ client: "portal-app", user: "alex-neighbor", fhirUser: "RelatedPerson/alex-neighbor", patient: "riley-example" });
    expect(refused.delegation).toBeUndefined();
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
  test("a guardian's share written while they aren't the guardian isn't kept", () => {
    const riley = stack.imaging.getPolicy().guardians;
    stack.imaging.setPolicy({ guardians: [] });
    stack.imaging.setPolicy({ delegations: [{ patient: "riley-example", grantedBy: SAM_ACCOUNT, delegate: "alex-neighbor", relationship: "neighbor", sites: ["Lakeside Imaging"], asGuardian: true }] });
    stack.imaging.setPolicy({ guardians: riley });
    expect(stack.imaging.getPolicy().delegations).toEqual([]);
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
    expect(stack.imaging.getPolicy().delegations[0]!.sites).toEqual(["Lakeside Imaging"]);
    stack.imaging.setPolicy({ delegations: [{ patient: "riley-example", grantedBy: SAM_ACCOUNT, delegate: "alex-neighbor", relationship: "neighbor", sites: ["Lakeside Imaging", "Northside Pathology"], asGuardian: true }] });
    const t = await launchFor("riley-example", "alex-neighbor");
    expect((await search(t.access_token, "riley-example")).ids).toEqual(RILEY);
  }, 60000);
  test("a share made as guardian doesn't come back with the guardian", async () => {
    const riley = stack.imaging.getPolicy().guardians;
    await submitDelegation(accountUrl(SAM_ACCOUNT), { user: SAM_ACCOUNT, delegate: "alex-neighbor", relationship: "neighbor", sites: ["Lakeside Imaging"], patient: "riley-example" });
    const t = await launchFor("riley-example", "alex-neighbor");
    stack.imaging.setPolicy({ guardians: [] });
    expect(stack.imaging.getPolicy().delegations).toEqual([]);
    stack.imaging.setPolicy({ guardians: riley });
    expect((await search(t.access_token, "riley-example")).ids).toEqual([]);
  }, 60000);
  test("what a guardian shared lasts only while they're the guardian", async () => {
    await submitDelegation(accountUrl(SAM_ACCOUNT), { user: SAM_ACCOUNT, delegate: "alex-neighbor", relationship: "neighbor", sites: ["Lakeside Imaging"], patient: "riley-example" });
    expect(stack.imaging.getPolicy().delegations[0]).toMatchObject({ patient: "riley-example", grantedBy: SAM_ACCOUNT, asGuardian: true });
    const t = await launchFor("riley-example", "alex-neighbor");
    expect((await search(t.access_token, "riley-example")).ids).toEqual(["syn-riley-knee-mr-2022"]);
    stack.imaging.setPolicy({ guardians: [] });
    expect((await search(t.access_token, "riley-example")).ids).toEqual([]);
  }, 60000);
  test("a store from before guardians gains them when it opens, keeping what's in it", () => {
    const dir = mkdtempSync(join(tmpdir(), "patients-store-"));
    try {
      const path = join(dir, "old.sqlite");
      const old = new Database(path, { create: true });
      old.exec(`CREATE TABLE delegations (patient TEXT NOT NULL, delegate TEXT NOT NULL, granted_by TEXT NOT NULL, relationship TEXT NOT NULL, sites TEXT NOT NULL, PRIMARY KEY (patient, delegate));
        CREATE TABLE app_grants (client TEXT NOT NULL, user TEXT NOT NULL, patient TEXT NOT NULL, sites TEXT, PRIMARY KEY (client, user, patient));
        CREATE TABLE rules (id TEXT PRIMARY KEY, position INTEGER NOT NULL, body TEXT NOT NULL);
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE signing_keys (kid TEXT PRIMARY KEY, private_key TEXT NOT NULL, public_key TEXT NOT NULL, retired INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE tokens (hash TEXT PRIMARY KEY, kind TEXT NOT NULL, record TEXT NOT NULL, exp INTEGER, revoked INTEGER NOT NULL DEFAULT 0);
        INSERT INTO delegations VALUES ('josh-example', 'sam-caregiver', 'josh', 'caregiver', '["Lakeside Imaging"]');
        PRAGMA user_version = 2;`);
      old.close();
      const s = new PolicyStore({ mode: "file", path });
      expect(s.info().schemaVersion).toBe(SCHEMA_VERSION);
      expect(s.guardians()).toEqual([riley]);
      expect(s.delegations()).toEqual([{ patient: "josh-example", grantedBy: "josh", delegate: SAM_ACCOUNT, relationship: "caregiver", sites: ["Lakeside Imaging"] }]);
      s.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("policy JSON round-trips through validation, and a bad guardian is refused", () => {
    const s = new PolicyStore({ mode: "memory" });
    s.setPolicy(s.getPolicy());
    expect(s.guardians()).toEqual([riley]);
    expect(() => s.setPolicy({ guardians: [{ patient: "riley-example" } as any] })).toThrow("guardians[0].guardian");
    expect(() => s.setPolicy({ guardians: [riley, riley] })).toThrow("duplicate");
    s.close();
  });
  test("shows on the account page and the admin screen, and on the sign-in picker", async () => {
    const { html } = await accountPage(SAM_ACCOUNT);
    expect(html).toContain("Riley Example</b>: you're their guardian, on file with the Imaging Server");
    expect(html).toContain("Sam Example</b>: your own records");
    const admin: any = await (await demo.fetch(new Request(`${CONFIG.demoUrl}/api/admin/status`, { headers: { host: new URL(CONFIG.demoUrl).host } }))).json();
    expect(admin.policy.guardians).toEqual([riley]);
    expect(await Bun.file(join(root, "web/admin.js")).text()).toContain("Guardians on file");
  });
  test("its chain reads plainly, in the Imaging Server's view", async () => {
    const x = await stack.explain({ client: "portal-app", user: SAM_ACCOUNT, fhirUser: "Patient/sam-example", patient: "riley-example" });
    expect(x.guardian).toEqual(riley);
    expect(x.studies.map((s: any) => s.reason).sort()).toEqual(["sam-caregiver hasn't authorized portal-app", "this study is confidential from sam-caregiver, so riley-example's guardian doesn't get it"]);
  });
});

describe("each link only narrows", () => {
  test("Sam shares part of their own record, and Alex's app gets no more than that", async () => {
    await submitDelegation(accountUrl(SAM_ACCOUNT), { user: SAM_ACCOUNT, delegate: "alex-neighbor", relationship: "neighbor", sites: ["Lakeside Imaging", "Northside Pathology"], patient: "sam-example" });
    // Sam has nothing at Northside, so it isn't recorded.
    expect(stack.imaging.getPolicy().delegations).toEqual([{ patient: "sam-example", grantedBy: SAM_ACCOUNT, delegate: "alex-neighbor", relationship: "neighbor", sites: ["Lakeside Imaging"] }]);
    const wide = await launchFor("sam-example", "alex-neighbor", { sites: ["Lakeside Imaging", "Riverside Hospital"] });
    expect((await search(wide.access_token, "sam-example")).ids).toEqual(["syn-sam-ct-sinus-2024"]);
    expect(stack.imaging.getPolicy().appGrants[0]!.sites).toEqual(["Lakeside Imaging"]);
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
    expect(stack.imaging.getPolicy().delegations.map(d => d.patient)).toEqual(["riley-example"]);
    await launchFor("sam-example"); await launchFor("riley-example");
    const { cookie } = await accountPage(SAM_ACCOUNT);
    await fetch(`${AUTH}/account/apps/revoke`, { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: "client=portal-app&patient=sam-example", redirect: "manual" });
    expect(stack.imaging.getPolicy().appGrants.filter(g => g.user === SAM_ACCOUNT).map(g => g.patient)).toEqual(["riley-example"]);
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
    expect(stack.imaging.getPolicy().appGrants).toEqual([{ client: "portal-app", user: SAM_ACCOUNT, patient: "riley-example", sites: ["Lakeside Imaging"] }]);
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
    const t = await launchFor("riley-example");
    const r = await fetch(`${CLINICAL_FHIR}/Patient/riley-example`, { headers: { Authorization: `Bearer ${t.access_token}` } });
    expect(await r.json()).toEqual({ resourceType: "Patient", id: "riley-example", name: [{ family: "Example", given: ["Riley"] }] });
    expect((await fetch(`${CLINICAL_FHIR}/Patient/sam-example`, { headers: { Authorization: `Bearer ${t.access_token}` } })).status).toBe(403);
  });
});

describe("Browse", () => {
  const browser = () => {
    let cookie = "";
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await demo.fetch(new Request(`${CONFIG.demoUrl}${path}`, { method, headers: { host: new URL(CONFIG.demoUrl).host, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
      const set = r.headers.get("set-cookie");
      if (set) cookie = set.split(";")[0]!;
      return r.json() as Promise<any>;
    };
    const pick = async (user: string, extra: any = {}) => {
      await call("POST", "/api/browse/start", { user, client: "portal-app", mode: "scripted", count: 20, ...extra });
      for (let i = 0; i < 2400; i++) { const s = (await call("GET", "/api/browse/session")).session; if (!s.running) return s; await Bun.sleep(25); }
      throw new Error("never settled");
    };
    return { call, pick };
  };
  const ids = (s: any) => s.page.studies.map((x: any) => x.id).sort();
  beforeEach(() => { stack.useStore("saved"); stack.resetSaved(); });
  test("Sam's choices are who Sam holds, and Josh joins them once he shares", async () => {
    const b = browser();
    const sam = async () => (await b.call("GET", "/api/browse/options")).people.find((p: any) => p.id === SAM_ACCOUNT);
    expect((await sam()).records.map((r: any) => [r.patient, r.via])).toEqual([["sam-example", "self"], ["riley-example", "guardian"]]);
    expect((await sam()).unshared.patient).toBe("josh-example");
    await b.pick(SAM_ACCOUNT, { share: { delegate: SAM_ACCOUNT, sites: ["Lakeside Imaging"] } });
    expect((await sam()).records.map((r: any) => [r.patient, r.via])).toEqual([["sam-example", "self"], ["riley-example", "guardian"], ["josh-example", "delegation"]]);
    expect((await sam()).unshared).toBeUndefined();
  }, 60000);
  test("switching whose records is a real new sign-in and search, and results say whose they are", async () => {
    const b = browser();
    const own = await b.pick(SAM_ACCOUNT);
    expect(own.whose).toMatchObject({ patient: "sam-example", plain: "Sam Example's own records" });
    expect(ids(own)).toEqual(SAM);
    expect(own.explain.chain).toBe("Sam is the patient; Sam gave the Health Records App everything Sam can see");
    const riley = await b.pick(SAM_ACCOUNT, { patient: "riley-example" });
    expect(riley.name).not.toBe(own.name);
    expect(riley.whose).toMatchObject({ patient: "riley-example", plain: "Riley Example's records, which Sam holds as guardian" });
    expect(ids(riley)).toEqual(RILEY);
    expect(riley.explain.chain).toBe("Sam is Riley's guardian, on file; Sam gave the Health Records App everything Sam can see");
    expect(riley.steps.map((x: any) => x.title)).toEqual(expect.arrayContaining(["Exchange the code, with the PKCE verifier", "Search ImagingStudy"]));
    const denied = await b.pick(SAM_ACCOUNT, { patient: "josh-example" });
    expect(denied.status).toBe("denied");
    expect(denied.detail).toContain("Sam doesn't hold Josh Example's records");
    expect(denied.whose.plain).toBe("Josh Example's records, which Sam doesn't hold");
    expect(denied.share.offers.map((o: any) => o.label)).toEqual(["Have Josh share with Sam"]);
    const shared = await b.pick(SAM_ACCOUNT, { share: { delegate: SAM_ACCOUNT, sites: ["Lakeside Imaging"] } });
    expect(shared.whose.plain).toBe("Josh Example's records, shared with Sam as caregiver");
    expect(ids(shared)).toEqual(["mri-brain-2020"]);
  }, 60000);
  test("Sam's own results don't offer Josh's share, and Robin's empty result still doesn't", async () => {
    const b = browser();
    expect((await b.pick(SAM_ACCOUNT)).share).toBeUndefined();
    expect((await b.pick("robin")).share).toBeUndefined();
  }, 60000);
  test("a backend client can search for any linked patient, and rule sets still name only Josh", async () => {
    const b = browser();
    const o = await b.call("GET", "/api/browse/options");
    expect(o.patients.map((p: any) => p.name)).toEqual(["Josh Example", "Riley Example", "Robin Example", "Sam Example"]);
    await b.call("POST", "/api/browse/start", { client: "research-donation", patient: "riley-example", count: 5 });
    let s: any; do { s = (await b.call("GET", "/api/browse/session")).session; await Bun.sleep(25); } while (s.running);
    expect(s.status).toBe("forbidden");
    expect(s.ruleHelp.text).toContain("No named rule set pre-authorizes this client");
    const { RULE_SETS } = await import("../src/rule-presets");
    for (const set of RULE_SETS) for (const rule of set.rules(stack.catalog) ?? []) expect(rule.when.patient).toBe("josh-example");
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
  test("is in the first group, and its defaults pass, covering every step asked for", async () => {
    expect(whose.title).toBe("Caregiver picks whose records");
    expect(whose.group).toBe("policy");
    expect(await Bun.file(join(root, "web/app.js")).text()).toContain('["Who can see what", [1, 2, 15, 3, 4, 6]]');
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
    expect(h.digest("hex")).toBe("694209adccb1c35b88160737b66a01df55580f96a6518b8ce3c84356e43d6a41");
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
    for (const s of studies) expect(catalog[s.accession]).toEqual({ id: s.id, title: expect.stringContaining("SYNTHETIC"), site: s.site });
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
