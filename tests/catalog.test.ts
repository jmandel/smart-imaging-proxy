// The demo's catalogs, built from its archive and from Orthanc, with search over real HTTP.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { catalogFromOrthanc, type CatalogStore, createCatalog, patientSourceOf, seedPatientLinks } from "@smart-imaging-proxy/core";
import { startStack, type Stack } from "../src/stack";
import { FLOWS, registerClients } from "../src/flows";
import { scriptedLaunch } from "../src/flows/oauth";
import { ACCESSION_SYSTEM, CONFIG } from "../src/config";

const root = join(import.meta.dir, "..");

describe("the repository", () => {
  test("nothing reads a manifest", async () => {
    const glob = new Bun.Glob("{src,scripts,tests,packages/*/src,packages/*/tests}/**/*.ts");
    const readers: string[] = [];
    for await (const f of glob.scan({ cwd: root })) {
      if (f === "tests/catalog.test.ts") continue;
      if ((await Bun.file(join(root, f)).text()).includes("data/manifest.json")) readers.push(f);
    }
    expect(readers).toEqual([]);
  });
});

describe("the real stack", () => {
  let stack: Stack;
  beforeAll(async () => { stack = await startStack(root); registerClients(stack); });
  afterAll(() => stack.stop());
  const searchWith = async (token: string, q: string) => (await fetch(`${CONFIG.imagingUrl}/fhir/ImagingStudy?${q}`, { headers: { Authorization: `Bearer ${token}` } })).json() as Promise<any>;

  test("search makes no allStudies call, and one hierarchies call, through real HTTP", async () => {
    stack.setBackend("static-files");
    await stack.resetAll();
    const c = stack.catalog;
    const token = (await scriptedLaunch("josh")).access_token;
    let all = 0, hier = 0;
    const allStudies = c.allStudies, hierarchies = c.hierarchies;
    c.allStudies = () => { all++; return allStudies.call(c); };
    c.hierarchies = pks => { hier++; return hierarchies.call(c, pks); };
    const b = await searchWith(token, "patient=josh-example");
    c.allStudies = allStudies; c.hierarchies = hierarchies;
    expect(b.total).toBe(6);
    expect(all).toBe(0);
    expect(hier).toBe(1);
  });
  test("patient links: Josh's and Robin's Patient IDs are seeded, and Robin's search is empty and real", async () => {
    for (const c of [stack.catalogs.archive, stack.catalogs.orthanc]) {
      expect(c.patientFor(patientSourceOf(), "JEXAMPLE01")).toBe("josh-example");
      expect(c.patientFor(patientSourceOf(), "REXAMPLE01")).toBe("robin-example");
      expect(c.patientFor(patientSourceOf(), "NOBODY")).toBeUndefined();
      expect(c.sitesFor("robin-example")).toEqual([]);
      expect(c.sitesFor("josh-example").sort()).toEqual(["Lakeside Imaging", "Northside Pathology", "Riverside Hospital"]);
    }
    stack.setBackend("static-files");
    await stack.resetAll();
    const b = await searchWith((await scriptedLaunch("robin")).access_token, "patient=robin-example");
    expect(b.total).toBe(0);
    expect(b.entry).toBeUndefined();
  });
  test("the capability statement describes paging", async () => {
    const m: any = await (await fetch(`${CONFIG.imagingUrl}/fhir/metadata`)).json();
    const names = m.rest[0].resource[0].searchParam.map((p: any) => p.name);
    expect(names).toEqual(expect.arrayContaining(["_count", "_cursor", "_lastUpdated"]));
  });
  test("the capability statement meets cpb-2 and cpb-14, and says which changes update _lastUpdated", async () => {
    const m: any = await (await fetch(`${CONFIG.imagingUrl}/fhir/metadata`)).json();
    expect(m.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(m.kind).toBe("instance");
    expect(m.implementation.description).toBeTruthy();
    expect(m.implementation.url).toBe(`${CONFIG.imagingUrl}/fhir`);
    expect(m.rest[0].resource[0].searchParam.find((p: any) => p.name === "_lastUpdated").documentation).toContain("changes it");
  });
  test("the flow list has the paged-search flow, numbered after the others, with no two the same", () => {
    const f = FLOWS.find(x => x.id === "paged-search")!;
    expect(f.number).toBe(14);
    expect(f.group).toBe("protocol");
    expect(new Set(FLOWS.map(x => x.number)).size).toBe(FLOWS.length);
  });
  test("selecting a backend selects its catalog", () => {
    stack.setBackend("static-files");
    expect(stack.catalog).toBe(stack.catalogs.archive);
    stack.setBackend("s3");
    expect(stack.catalog).toBe(stack.catalogs.archive);
    stack.setBackend("orthanc");
    expect(stack.catalog).toBe(stack.catalogs.orthanc);
    stack.setBackend("static-files");
  });

  describe("the catalog built from Orthanc's QIDO-RS API", () => {
    test("it holds the same studies, series and instances as the archive catalog", () => {
      const a = stack.catalogs.archive, o = stack.catalogs.orthanc;
      const key = (c: CatalogStore) => c.allStudies().map(s => ({ uid: s.uid, id: s.id, patient: s.patient, accession: s.accession, site: s.site, date: s.date, time: s.time, description: s.description, title: s.title, status: s.status, lastUpdated: s.lastUpdated, instanceCount: s.instanceCount, seriesCount: s.seriesCount })).sort((x, y) => (x.uid < y.uid ? -1 : 1));
      expect(key(o)).toEqual(key(a));
      const instancesByUid = (c: CatalogStore) => {
        const out: Record<string, any> = {};
        for (const s of c.allStudies()) for (const x of c.hierarchies([s.pk]).get(s.pk)!.series) out[x.uid] = { number: x.number, modality: x.modality, description: x.description, instances: [...x.instances].sort((p, q) => (p.uid < q.uid ? -1 : 1)) };
        return out;
      };
      expect(instancesByUid(o)).toEqual(instancesByUid(a));
    });
    test("it's built with QIDO-RS alone, and reads nothing else", async () => {
      const paths: { method: string; path: string }[] = [];
      const upstream = Bun.serve({
        port: 0, hostname: "127.0.0.1",
        async fetch(req) {
          const u = new URL(req.url);
          paths.push({ method: req.method, path: u.pathname });
          const r = await fetch(`${CONFIG.orthanc.base}${u.pathname}${u.search}`, { headers: { Authorization: req.headers.get("authorization")!, Accept: req.headers.get("accept")! } });
          return new Response(await r.arrayBuffer(), { status: r.status, headers: { "content-type": r.headers.get("content-type") ?? "application/json" } });
        },
      });
      const c = createCatalog(":memory:", { accessionSystem: ACCESSION_SYSTEM });
      seedPatientLinks(c, await Bun.file(join(root, "data/patient.json")).json());
      const report = await catalogFromOrthanc(c, { ...CONFIG.orthanc, base: `http://127.0.0.1:${upstream.port}` }, await Bun.file(join(root, "data/orthanc-catalog.json")).json());
      upstream.stop(true);
      expect(report.published.length).toBe(10);
      expect(report.unlinked).toEqual([]);
      expect(paths.every(p => p.method === "GET")).toBe(true);
      expect(paths.every(p => /^\/dicom-web\/studies(\/[0-9.]+\/series(\/[0-9.]+\/instances)?)?$/.test(p.path))).toBe(true);
      c.close();
    });
    test("an unlinked patient is reported and skipped, and a study with no operator entry uses its UID", async () => {
      const unlinked = createCatalog(":memory:", { accessionSystem: ACCESSION_SYSTEM });
      const r = await catalogFromOrthanc(unlinked, CONFIG.orthanc, { studies: {} });
      expect(r.published).toEqual([]);
      expect(r.unlinked.length).toBe(10);
      expect(new Set(r.unlinked.map(u => u.sourcePatientId))).toEqual(new Set(["JEXAMPLE01", "SEXAMPLE01", "RYEXAMPLE01"]));
      expect(unlinked.stats().studies).toBe(0);
      unlinked.close();
      const c = createCatalog(":memory:", { accessionSystem: ACCESSION_SYSTEM });
      seedPatientLinks(c, await Bun.file(join(root, "data/patient.json")).json());
      await catalogFromOrthanc(c, CONFIG.orthanc, { studies: {} });
      for (const s of c.allStudies()) { expect(s.id).toBe(s.uid); expect(s.site).toBeUndefined(); }
      c.close();
    });
    test("search and retrieval use it when Orthanc is selected", async () => {
      stack.setBackend("orthanc");
      await stack.resetAll();
      const token = (await scriptedLaunch("josh")).access_token;
      const b = await searchWith(token, "patient=josh-example&_count=2");
      expect(b.total).toBe(6);
      const s = b.entry.find((e: any) => e.resource.resourceType === "ImagingStudy").resource;
      const address = b.entry.find((e: any) => e.fullUrl === s.endpoint[0].reference).resource.address;
      const uid = s.identifier[0].value.replace("urn:oid:", "");
      const r = await fetch(`${address}/studies/${uid}/series/${s.series[0].uid}/instances/${s.series[0].instance[0].uid}`, { headers: { Authorization: `Bearer ${token}`, Accept: "multipart/related; type=application/dicom; transfer-syntax=*" } });
      expect(r.status).toBe(200);
      await r.body?.cancel();
      stack.setBackend("static-files");
    });
  });
});
