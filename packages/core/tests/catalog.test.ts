// The catalog, its two builders, and search reading only from it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { archiveKeys, type CatalogStore, createCatalog, createImagingServer, DICOM_UID_SYSTEM, fileStore, identifiersOf, orthancCatalogPath, PolicyStore, publicationFor as publicationIn, rebuildFromArchive, seedPatientLinks, type StudyDocument, type StudyHierarchy } from "../src";
import { documentOf, hierarchyOf, put } from "./support";

/** These tests' catalogs name an accession system, as a deployment would. */
const ACCESSION_SYSTEM = "urn:example:accession";
const ACC = { accessionSystem: ACCESSION_SYSTEM };
const publicationFor = (d: StudyDocument, patient: string, h: StudyHierarchy) => publicationIn(d, patient, h, ACCESSION_SYSTEM);

const root = join(import.meta.dir, "..");
const temp = mkdtempSync(join(tmpdir(), "catalog-test-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

const uidsOf = (rows: { uid: string }[]) => rows.map(r => r.uid);

describe("schema and files", () => {
  test("the tables and indexes are there, the file is private, and a search query uses the index", () => {
    const path = join(temp, "schema.sqlite");
    const c = createCatalog(path, ACC);
    put(c, "1");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const db = new Database(path, { readonly: true });
    const names = (db.query("SELECT name FROM sqlite_master").all() as any[]).map(r => r.name);
    expect(names).toEqual(expect.arrayContaining(["studies", "study_identifiers", "series", "study_hierarchy", "patient_links", "studies_by_date", "studies_by_last_updated", "study_identifiers_lookup"]));
    const plan = (sql: string) => (db.query(`EXPLAIN QUERY PLAN ${sql}`).all("p1", "99", 5) as any[]).map(r => r.detail).join("; ");
    const paged = plan("SELECT pk FROM studies s WHERE s.patient = ?1 AND (s.date, s.pk) < (?2, ?3) ORDER BY s.patient, s.date DESC, s.pk DESC");
    expect(paged).toContain("studies_by_date");
    expect(paged).not.toContain("TEMP B-TREE");
    db.close();
    c.close();
  });
  test("a catalog from a newer schema is refused, with the way out in the message", () => {
    const path = join(temp, "newer.sqlite");
    createCatalog(path, ACC).close();
    const db = new Database(path);
    db.exec("PRAGMA user_version = 99");
    db.close();
    expect(() => createCatalog(path, ACC)).toThrow("rebuildable");
  });
  test("the Orthanc catalog is its own file beside the archive catalog", () => {
    expect(orthancCatalogPath("/a/catalog.sqlite")).toBe("/a/catalog-orthanc.sqlite");
    expect(orthancCatalogPath(":memory:")).toBe(":memory:");
  });
  test("stats report what's held", () => {
    const c = createCatalog(":memory:", ACC);
    expect(c.stats()).toEqual({ studies: 0, series: 0, hierarchyBytes: 0, hierarchyRawBytes: 0, path: ":memory:" });
    put(c, "1");
    const s = c.stats();
    expect([s.studies, s.series]).toEqual([1, 1]);
    expect(s.hierarchyBytes).toBeGreaterThan(0);
    expect(s.hierarchyRawBytes).toBe(JSON.stringify(hierarchyOf("1")).length);
    c.close();
  });
});

describe("publish", () => {
  test("publishing again replaces the study and keeps its pk", () => {
    const c = createCatalog(":memory:", ACC);
    put(c, "1", { accession: "OLD" });
    put(c, "2");
    const before = c.studyByUid("1")!;
    c.publish(publicationFor(documentOf("1", { version: 2, accession: "NEW", description: "changed", series: [{ uid: "1.9", number: 9, modality: "MR", instanceCount: 1 }] }), "p1", { series: [{ uid: "1.9", number: 9, modality: "MR", instances: [{ uid: "1.9.1", number: 1, sopClass: "x" }] }] }));
    const after = c.studyByUid("1")!;
    expect(after.pk).toBe(before.pk);
    expect(after.version).toBe(2);
    expect(after.description).toBe("changed");
    expect(after.series).toEqual([{ uid: "1.9", number: 9, modality: "MR", instanceCount: 1 }]);
    expect(c.hierarchies([after.pk]).get(after.pk)!.series[0]!.uid).toBe("1.9");
    expect(c.candidates({ patient: "p1", identifier: [[{ value: "OLD" }]] })).toEqual([]);
    expect(uidsOf(c.candidates({ patient: "p1", identifier: [[{ value: "NEW" }]] }))).toEqual(["1"]);
    expect(c.stats().studies).toBe(2);
    c.close();
  });
  test("a publish that fails partway changes nothing", () => {
    const c = createCatalog(":memory:", ACC);
    put(c, "1", { description: "first" });
    const before = c.studyByUid("1")!;
    const bad = publicationFor(documentOf("1", { version: 2, description: "second" }), "p1", hierarchyOf("1"));
    bad.identifiers = [{ kind: "identifier", value: "fine" }, { kind: "not-a-kind" as any, value: "breaks the constraint" }];
    expect(() => c.publish(bad)).toThrow();
    expect(c.studyByUid("1")).toEqual(before);
    expect(uidsOf(c.candidates({ patient: "p1", identifier: [[{ value: "fine" }]] }))).toEqual([]);
    expect(uidsOf(c.candidates({ patient: "p1", identifier: [[{ value: "ACC1" }]] }))).toEqual(["1"]);
    expect(c.hierarchies([before.pk]).size).toBe(1);
    const firstNew = publicationFor(documentOf("2"), "p1", hierarchyOf("2"));
    firstNew.identifiers = [{ kind: "not-a-kind" as any, value: "x" }];
    expect(() => c.publish(firstNew)).toThrow();
    expect(c.studyByUid("2")).toBeUndefined();
    c.close();
  });
});

describe("candidates", () => {
  const c = createCatalog(":memory:", ACC);
  // Published out of order. Two share a date, and two have none.
  put(c, "old", { date: "20100101" });
  put(c, "nodate1", { date: undefined });
  put(c, "new", { date: "20230101" });
  put(c, "same1", { date: "20150101" });
  put(c, "same2", { date: "20150101" });
  put(c, "nodate2", { date: undefined });
  put(c, "other", { date: "20990101", accession: "SHARED" }, "p2");
  const ORDER = ["new", "same2", "same1", "old", "nodate2", "nodate1"];

  test("newest first, ties by newest pk, and no date last in a stable position", () => {
    expect(uidsOf(c.candidates({ patient: "p1" }))).toEqual(ORDER);
    expect(uidsOf(c.candidates({ patient: "p1" }))).toEqual(ORDER);
    expect(c.studyByUid("nodate1")!.date).toBeUndefined();
  });
  test("resuming from any position continues exactly, with any batch size", () => {
    for (const batch of [1, 2, 3, 100]) {
      const seen: string[] = [];
      let after: { date: string; pk: number } | undefined;
      for (;;) {
        const rows = c.candidates({ patient: "p1" }, after, batch);
        if (!rows.length) break;
        expect(rows.length).toBeLessThanOrEqual(batch);
        seen.push(...uidsOf(rows));
        const last = rows[rows.length - 1]!;
        after = { date: last.date ?? "", pk: last.pk };
      }
      expect(seen).toEqual(ORDER);
    }
  });
  test("rows carry series for policy, and no hierarchy", () => {
    const row = c.candidates({ patient: "p1" }, undefined, 1)[0]! as any;
    expect(row.series).toEqual([{ uid: "new.1", number: 1, modality: "CT", instanceCount: 2 }]);
    expect(row.hierarchy).toBeUndefined();
    expect(row.hierarchyBytes).toBe(JSON.stringify(hierarchyOf("new")).length);
  });
  test("patients are isolated, whatever the filter", () => {
    expect(uidsOf(c.candidates({ patient: "p2" }))).toEqual(["other"]);
    expect(c.candidates({ patient: "p1", identifier: [[{ value: "SHARED" }]] })).toEqual([]);
    expect(c.candidates({ patient: "p1", identifier: [[{ system: DICOM_UID_SYSTEM, value: "urn:oid:other" }]] })).toEqual([]);
    expect(c.candidates({ patient: "p1", basedOn: [[{ value: "SHARED" }]] })).toEqual([]);
    expect(c.candidates({ patient: "nobody" })).toEqual([]);
  });
  test("identifiers match with and without a system", () => {
    expect(uidsOf(c.candidates({ patient: "p1", identifier: [[{ value: "urn:oid:old" }]] }))).toEqual(["old"]);
    expect(uidsOf(c.candidates({ patient: "p1", identifier: [[{ system: DICOM_UID_SYSTEM, value: "urn:oid:old" }]] }))).toEqual(["old"]);
    expect(c.candidates({ patient: "p1", identifier: [[{ system: "urn:other", value: "urn:oid:old" }]] })).toEqual([]);
    expect(uidsOf(c.candidates({ patient: "p1", identifier: [[{ value: "ACCold" }]] }))).toEqual(["old"]);
    expect(uidsOf(c.candidates({ patient: "p1", identifier: [[{ system: ACCESSION_SYSTEM, value: "ACCold" }]] }))).toEqual(["old"]);
    expect(c.candidates({ patient: "p1", identifier: [[{ system: "", value: "ACCold" }]] })).toEqual([]);
  });
  test("based-on matches only order identifiers", () => {
    expect(uidsOf(c.candidates({ patient: "p1", basedOn: [[{ value: "ACCold" }]] }))).toEqual(["old"]);
    expect(uidsOf(c.candidates({ patient: "p1", basedOn: [[{ system: ACCESSION_SYSTEM, value: "ACCold" }]] }))).toEqual(["old"]);
    expect(c.candidates({ patient: "p1", basedOn: [[{ system: "urn:other", value: "ACCold" }]] })).toEqual([]);
    expect(c.candidates({ patient: "p1", basedOn: [[{ value: "urn:oid:old" }]] })).toEqual([]);
    expect(identifiersOf({ uid: "1" })).toEqual([{ kind: "identifier", system: DICOM_UID_SYSTEM, value: "urn:oid:1" }]);
  });
  test("_lastUpdated is compared as an instant to a stored value, which defaults from the study date", () => {
    expect(c.studyByUid("old")!.lastUpdated).toBe("2010-01-01T00:00:00Z");
    expect(c.studyByUid("nodate1")!.lastUpdated).toBe("2020-01-01T00:00:00Z");
    expect(uidsOf(c.candidates({ patient: "p1", lastUpdated: [{ from: Date.parse("2015-01-01T00:00:00Z") + 1 }] }))).toEqual(["new", "nodate2", "nodate1"]);
    expect(uidsOf(c.candidates({ patient: "p1", lastUpdated: [{ from: Date.parse("2023-01-01T00:00:00Z") + 1 }] }))).toEqual([]);
    c.publish(publicationFor(documentOf("stamped", { date: "19990101", lastUpdated: "2024-06-01T00:00:00Z" }), "p3", hierarchyOf("stamped")));
    expect(uidsOf(c.candidates({ patient: "p3", lastUpdated: [{ from: Date.parse("2024-01-01T00:00:00Z") + 1 }] }))).toEqual(["stamped"]);
    c.publish(publicationFor(documentOf("offset", { date: "19990101", lastUpdated: "2024-06-01T02:00:00+02:00" }), "p3", hierarchyOf("offset")));
    expect(uidsOf(c.candidates({ patient: "p3", lastUpdated: [{ before: Date.parse("2024-06-01T00:00:00.001Z") }, { from: Date.parse("2024-06-01T00:00:00Z") }] })).sort()).toEqual(["offset", "stamped"]);
  });
  test("sites are per patient", () => {
    put(c, "b1", { site: "Site B" }, "p4");
    put(c, "b2", { site: "Site C" }, "p4");
    put(c, "b3", { site: "Site B" }, "p4");
    put(c, "b4", { site: undefined }, "p4");
    expect(c.sitesFor("p4")).toEqual(["Site B", "Site C"]);
    expect(c.sitesFor("nobody")).toEqual([]);
  });
});

describe("hierarchies", () => {
  test("stored compressed, apart from the query rows, and they round-trip", () => {
    const path = join(temp, "hier.sqlite");
    const c = createCatalog(path, ACC);
    const big = hierarchyOf("1", "CT", 2000);
    c.publish(publicationFor(documentOf("1"), "p1", big));
    put(c, "2");
    const pks = uidsOf(c.candidates({ patient: "p1" })).map(u => c.studyByUid(u)!.pk);
    const got = c.hierarchies(pks);
    expect(got.size).toBe(2);
    expect(got.get(c.studyByUid("1")!.pk)).toEqual(big);
    expect(c.hierarchies([]).size).toBe(0);
    const db = new Database(path, { readonly: true });
    const blob = (db.query("SELECT zstd_json FROM study_hierarchy WHERE study_pk = ?").get(c.studyByUid("1")!.pk) as any).zstd_json as Uint8Array;
    expect([...blob.slice(0, 4)]).toEqual([0x28, 0xb5, 0x2f, 0xfd]);
    expect(blob.length).toBeLessThan(JSON.stringify(big).length / 4);
    expect((db.query("PRAGMA table_info(studies)").all() as any[]).map(r => r.type)).not.toContain("BLOB");
    db.close();
    c.close();
  });
});

describe("rebuilding from the archive", () => {
  const zst = (v: unknown) => Bun.zstdCompressSync(new TextEncoder().encode(JSON.stringify(v)));
  async function writeObject(dir: string, key: string, bytes: Uint8Array | string) {
    mkdirSync(dirname(join(dir, key)), { recursive: true });
    await Bun.write(join(dir, key), bytes);
  }
  /** Writes a study in the format of src/archive/types.ts, with an older version beside the current one. */
  async function writeStudy(dir: string, d: StudyDocument, h: StudyHierarchy) {
    await writeObject(dir, archiveKeys.current(d.uid), JSON.stringify({ version: d.version }));
    if (d.version > 1) await writeObject(dir, archiveKeys.study(d.uid, d.version - 1), zst({ ...d, version: d.version - 1, description: "superseded" }));
    await writeObject(dir, archiveKeys.study(d.uid, d.version), zst(d));
    for (const s of h.series) {
      await writeObject(dir, archiveKeys.seriesIndex(d.uid, d.version, s.uid), zst({
        format: 1, study: d.uid, version: d.version, uid: s.uid, number: s.number, modality: s.modality, description: s.description, bodyPart: s.bodyPart,
        instances: s.instances.map(i => ({ ...i, offers: [{ syntax: "1.2.840.10008.1.2.1", stored: true, key: archiveKeys.content("abc", "zstd"), encoding: "zstd", objectBytes: 1, storedBytes: 2, sha256: "abc" }] })),
      }));
      await writeObject(dir, archiveKeys.seriesMetadata(d.uid, d.version, s.uid), zst({ format: 1, instances: {} }));
    }
  }
  const dumpTables = (path: string) => {
    const db = new Database(path, { readonly: true });
    const out: Record<string, unknown[]> = {};
    for (const [t, order] of [["studies", "pk"], ["series", "study_pk, position"], ["study_identifiers", "study_pk, kind, value"], ["patient_links", "source_patient_id"]] as const) out[t] = db.query(`SELECT * FROM ${t} ORDER BY ${order}`).all();
    db.close();
    return out;
  };

  test("the rebuilt catalog matches publishing the same studies, row for row", async () => {
    const dir = mkdtempSync(join(temp, "archive-"));
    const docs = [
      documentOf("1.1", { version: 3, description: "current", time: "120000", title: "Title", sourcePatientIssuer: undefined }),
      documentOf("1.2", { date: undefined, accession: undefined, site: undefined, lastUpdated: "2024-01-01T00:00:00Z" }),
      documentOf("1.3", { sourcePatientId: "MRN2", status: "registered", series: [] }),
    ];
    const hs: StudyHierarchy[] = [hierarchyOf("1.1"), hierarchyOf("1.2"), { series: [] }];
    for (let i = 0; i < docs.length; i++) await writeStudy(dir, docs[i]!, hs[i]!);
    await writeStudy(dir, documentOf("1.4", { sourcePatientId: "UNKNOWN" }), hierarchyOf("1.4"));
    await writeStudy(dir, documentOf("1.5", { sourcePatientId: undefined }), hierarchyOf("1.5"));

    const rebuiltPath = join(temp, "rebuilt.sqlite"), directPath = join(temp, "direct.sqlite");
    const rebuilt = createCatalog(rebuiltPath, ACC);
    const people = { id: "p1", mrn: "MRN1", otherPatients: [{ id: "p2", mrn: "MRN2" }] };
    seedPatientLinks(rebuilt, people);
    const report = await rebuildFromArchive(fileStore(dir), rebuilt);
    expect(report.published).toEqual(["1.1", "1.2", "1.3"]);
    expect(report.unlinked).toEqual([{ study: "1.4", sourcePatientId: "UNKNOWN", sourcePatientIssuer: undefined }, { study: "1.5", sourcePatientId: undefined, sourcePatientIssuer: undefined }]);

    const direct = createCatalog(directPath, ACC);
    seedPatientLinks(direct, people);
    direct.publish(publicationFor(docs[0]!, "p1", hs[0]!));
    direct.publish(publicationFor(docs[1]!, "p1", hs[1]!));
    direct.publish(publicationFor(docs[2]!, "p2", hs[2]!));

    expect(dumpTables(rebuiltPath)).toEqual(dumpTables(directPath));
    const pks = rebuilt.allStudies().map(s => s.pk);
    expect([...rebuilt.hierarchies(pks)]).toEqual([...direct.hierarchies(pks)]);
    expect(rebuilt.studyByUid("1.1")!.description).toBe("current");
    expect(rebuilt.studyByUid("1.3")!.status).toBe("registered");
    expect(rebuilt.studyByUid("1.2")!.lastUpdated).toBe("2024-01-01T00:00:00Z");

    // A second rebuild into a fresh catalog gives the same rows again.
    const againPath = join(temp, "again.sqlite");
    const again = createCatalog(againPath, ACC);
    seedPatientLinks(again, people);
    await rebuildFromArchive(fileStore(dir), again);
    expect(dumpTables(againPath)).toEqual(dumpTables(rebuiltPath));
    for (const c of [rebuilt, direct, again]) c.close();
  });
});

// Search, driven directly against an Imaging Server over a small catalog.
describe("paged search", () => {
  const TOKEN: any = { active: true, client_id: "app", sub: "pat", fhirUser: "Patient/p1", patient: "p1", scope: "patient/ImagingStudy.rs", exp: Math.floor(Date.now() / 1000) + 3600 };
  /** A service's token, for what only organization policy decides, such as withheld series. */
  const SERVICE: any = { active: true, client_id: "svc", scope: "system/ImagingStudy.rs", exp: TOKEN.exp };
  const APPROVAL = { by: "user:pat", app: "app:app", patient: "patient:p1" };
  function server(catalog: CatalogStore, extra: { pageBytes?: number; token?: any } = {}) {
    const store = new PolicyStore({ mode: "memory" });
    store.putApproval(APPROVAL);
    const { token = TOKEN, ...rest } = extra;
    const imaging = createImagingServer({ patientOf: () => undefined, base: "http://fhir", clinicalFhirBase: "http://clinical", proxyBase: () => "http://proxy", introspect: async () => token, serviceSecret: "s", policySecret: "ps", catalog: () => catalog, keyStore: store, store: () => store, ...rest });
    const get = async (q: string) => {
      const r = await imaging.fetch(new Request(q.startsWith("http") ? q : `http://fhir/fhir/ImagingStudy?${q}`, { headers: { Authorization: "Bearer t" } }));
      return { status: r.status, body: await r.json() as any };
    };
    return { imaging, store, get };
  }
  const internal = (next: string) => next.replace("http://fhir/ImagingStudy", "http://fhir/fhir/ImagingStudy");
  const studiesOf = (b: any) => (b.entry ?? []).filter((e: any) => e.resource.resourceType === "ImagingStudy").map((e: any) => e.resource);
  const nextOf = (b: any) => b.link.find((l: any) => l.relation === "next")?.url as string | undefined;
  const walk = async (get: (q: string) => Promise<any>, q: string) => {
    const pages: any[] = [];
    let at: string | undefined = q;
    while (at) {
      const r = await get(at);
      expect(r.status).toBe(200);
      pages.push(r.body);
      const n: string | undefined = nextOf(r.body);
      at = n && internal(n);
    }
    return pages;
  };
  const six = () => {
    const c = createCatalog(":memory:", ACC);
    for (let i = 1; i <= 6; i++) put(c, `9.${i}`, { date: `201${i}0101`, site: i <= 3 ? "Site A" : "Site B" });
    return c;
  };

  test("next links walk every study once, in order, with total on every page", async () => {
    const { get } = server(six());
    const pages = await walk(get, "patient=p1&_count=2");
    expect(pages.length).toBe(3);
    expect(pages.map(p => studiesOf(p).length)).toEqual([2, 2, 2]);
    expect(pages.map(p => p.total)).toEqual([6, 6, 6]);
    expect(pages.flatMap(p => studiesOf(p).map((s: any) => s.id))).toEqual([6, 5, 4, 3, 2, 1].map(i => `study-9.${i}`));
    expect(nextOf(pages[2])).toBeUndefined();
  });
  test("every study's Endpoint is on the same page", async () => {
    const { get } = server(six());
    for (const count of [1, 2, 4, 6]) for (const p of await walk(get, `patient=p1&_count=${count}`)) {
      for (const s of studiesOf(p)) {
        const ep = p.entry.find((e: any) => e.fullUrl === s.endpoint[0].reference);
        expect(ep.resource.resourceType).toBe("Endpoint");
        expect(ep.fullUrl).toStartWith("urn:uuid:");
      }
      expect((p.entry ?? []).length).toBe(studiesOf(p).length * 2);
    }
  });
  test("_count: default 20, larger values clamp to 100, 0 is only the total, and nonsense is a 400", async () => {
    const c = createCatalog(":memory:", ACC);
    for (let i = 0; i < 25; i++) put(c, `8.${i}`, { date: "20200101" });
    const { get } = server(c);
    expect(studiesOf((await get("patient=p1")).body).length).toBe(20);
    const clamped = await get("patient=p1&_count=5000");
    expect(studiesOf(clamped.body).length).toBe(25);
    expect(clamped.status).toBe(200);
    const big = createCatalog(":memory:", ACC);
    for (let i = 0; i < 101; i++) put(big, `7.${i}`, { date: "20200101" });
    const bigGet = server(big).get;
    const page = await bigGet("patient=p1&_count=5000");
    expect(studiesOf(page.body).length).toBe(100);
    expect(page.body.total).toBe(101);
    expect(new URL(nextOf(page.body)!).searchParams.get("_count")).toBe("100");
    const zero = await get("patient=p1&_count=0");
    expect(zero.status).toBe(200);
    expect(zero.body.total).toBe(25);
    expect(zero.body.entry).toBeUndefined();
    expect(nextOf(zero.body)).toBeUndefined();
    for (const bad of ["-1", "abc", "1.5", ""]) {
      const r = await get(`patient=p1&_count=${bad}`);
      expect(r.status).toBe(400);
      expect(r.body.resourceType).toBe("OperationOutcome");
    }
  });
  test("a tampered, truncated or foreign cursor is a 400 with an OperationOutcome", async () => {
    const c = six();
    const { get } = server(c);
    const next = nextOf((await get("patient=p1&_count=2")).body)!;
    const cursor = new URL(next).searchParams.get("_cursor")!;
    const [payload, mac] = cursor.split(".") as [string, string];
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    const forgedPayload = Buffer.from(JSON.stringify({ ...claims, p: claims.p + 1 })).toString("base64url");
    const foreign = nextOf((await server(c).get("patient=p1&_count=2")).body)!;
    for (const bad of [`${forgedPayload}.${mac}`, `${payload}.${mac.slice(0, -2)}AA`, payload, "garbage", "", ".", new URL(foreign).searchParams.get("_cursor")!]) {
      const r = await get(`patient=p1&_count=2&_cursor=${encodeURIComponent(bad)}`);
      expect(r.status).toBe(400);
      expect(r.body.resourceType).toBe("OperationOutcome");
    }
    expect((await get(`patient=p1&_count=2&_cursor=${encodeURIComponent(cursor)}`)).status).toBe(200);
  });
  test("a cursor can't be carried to a changed filter, but _count can change", async () => {
    const { get } = server(six());
    const cursor = new URL(nextOf((await get("patient=p1&_count=2")).body)!).searchParams.get("_cursor")!;
    for (const extra of ["identifier=ACC9.1", "based-on:identifier=ACC9.1", "_lastUpdated=gt2000-01-01T00:00:00Z"]) {
      const r = await get(`patient=p1&_count=2&${extra}&_cursor=${encodeURIComponent(cursor)}`);
      expect(r.status).toBe(400);
      expect(r.body.issue[0].diagnostics).toContain("different filters");
    }
    expect(studiesOf((await get(`patient=p1&_count=3&_cursor=${encodeURIComponent(cursor)}`)).body).length).toBe(3);
  });
  test("a filtered search pages through its own results, and keeps its filters in next", async () => {
    const c = createCatalog(":memory:", ACC);
    for (let i = 1; i <= 3; i++) put(c, `6.${i}`, { date: `201${i}0101`, accession: "SAME" });
    put(c, "6.9", { date: "20190101", accession: "OTHER" });
    const pages = await walk(server(c).get, "patient=p1&identifier=SAME&_count=2");
    expect(pages.map(p => p.total)).toEqual([3, 3]);
    expect(pages.flatMap(p => studiesOf(p).map((s: any) => s.id))).toEqual(["6.3", "6.2", "6.1"].map(u => `study-${u}`));
  });
  test("studies with no date page last, and stably", async () => {
    const c = createCatalog(":memory:", ACC);
    for (const [uid, date] of [["5.1", undefined], ["5.2", "20200101"], ["5.3", undefined], ["5.4", undefined]] as const) put(c, uid, { date });
    const pages = await walk(server(c).get, "patient=p1&_count=1");
    expect(pages.flatMap(p => studiesOf(p).map((s: any) => s.id))).toEqual(["5.2", "5.4", "5.3", "5.1"].map(u => `study-${u}`));
    expect(studiesOf(pages[1])[0].started).toBeUndefined();
  });
  test("policy runs again on each page, and a cursor grants nothing", async () => {
    const { get, store } = server(six());
    const first = (await get("patient=p1&_count=2")).body;
    expect(first.total).toBe(6);
    store.putApproval({ ...APPROVAL, sites: ["Site A"] });
    const second = (await get(internal(nextOf(first)!))).body;
    expect(studiesOf(second).map((s: any) => s.id)).toEqual(["study-9.3", "study-9.2"]);
    expect(second.total).toBe(3);
    store.removeApprovals(APPROVAL);
    const none = (await get(internal(nextOf(first)!))).body;
    expect(none.entry).toBeUndefined();
    expect(none.total).toBe(0);
    expect(nextOf(none)).toBeUndefined();
    store.putApproval(APPROVAL);
    expect(studiesOf((await get(internal(nextOf(first)!))).body).length).toBe(2);
  });
  test("a page loads its hierarchies with exactly one call, for that page only, and never calls allStudies", async () => {
    const c = six();
    const calls: number[][] = [];
    const hierarchies = c.hierarchies, allStudies = c.allStudies;
    c.hierarchies = pks => { calls.push(pks); return hierarchies.call(c, pks); };
    c.allStudies = () => { throw new Error("search must not call allStudies"); };
    const { get } = server(c);
    const pages = await walk(get, "patient=p1&_count=2");
    expect(calls.length).toBe(pages.length);
    expect(calls.every(pks => pks.length === 2)).toBe(true);
    expect(new Set(calls.flat()).size).toBe(6);
    calls.length = 0;
    await get("patient=p1&_count=0");
    expect(calls.length).toBe(0);
    c.allStudies = allStudies;
  });
  test("studies the caller can't see never have their hierarchies read", async () => {
    const c = six();
    const asked: number[] = [];
    const hierarchies = c.hierarchies;
    c.hierarchies = pks => { asked.push(...pks); return hierarchies.call(c, pks); };
    const { get, store } = server(c);
    store.putApproval({ ...APPROVAL, sites: ["Site B"] });
    await get("patient=p1");
    expect(asked.length).toBe(3);
    const siteB = new Set(c.allStudies().filter(s => s.site === "Site B").map(s => s.pk));
    expect(asked.every(pk => siteB.has(pk))).toBe(true);
  });
  test("the byte budget ends a page early, and a page always has at least one study", async () => {
    const c = createCatalog(":memory:", ACC);
    for (let i = 1; i <= 4; i++) put(c, `4.${i}`, { date: `201${i}0101` });
    const size = c.allStudies()[0]!.hierarchyBytes;
    const one = await walk(server(c, { pageBytes: 1 }).get, "patient=p1");
    expect(one.map(p => studiesOf(p).length)).toEqual([1, 1, 1, 1]);
    expect(one.map(p => p.total)).toEqual([4, 4, 4, 4]);
    const two = await walk(server(c, { pageBytes: size * 2 }).get, "patient=p1");
    expect(two.map(p => studiesOf(p).length)).toEqual([2, 2]);
  });
  test("a registered or cancelled study has no endpoint and no series list, and can't be asked about", async () => {
    const c = createCatalog(":memory:", ACC);
    c.publish(publicationFor(documentOf("3.1", { status: "registered", series: [] }), "p1", { series: [] }));
    c.publish(publicationFor(documentOf("3.2", { date: "20100101", status: "cancelled", series: [] }), "p1", { series: [] }));
    const calls: number[][] = [];
    const hierarchies = c.hierarchies;
    c.hierarchies = pks => { calls.push(pks); return hierarchies.call(c, pks); };
    const { get, imaging } = server(c);
    const b = (await get("patient=p1")).body;
    expect(b.total).toBe(2);
    expect(b.entry.length).toBe(2);
    const [r, x] = studiesOf(b);
    expect(r.status).toBe("registered");
    expect(x.status).toBe("cancelled");
    for (const s of [r, x]) { expect(s.endpoint).toBeUndefined(); expect(s.series).toBeUndefined(); expect(s.numberOfSeries).toBeUndefined(); }
    expect(calls.length).toBe(0);
    const res = await imaging.fetch(new Request("http://fhir/access/v1/evaluation", { method: "POST", headers: { Authorization: "Bearer s" }, body: JSON.stringify({ subject: { type: "token", id: "x", properties: { access_token: "t" } }, resource: { type: "study", id: "3.1" }, action: { name: "can_i" } }) }));
    expect(((await res.json()) as any).decision).toBe(false);
  });
  test("every study has a modality, from what's released of it, even with nothing to retrieve", async () => {
    const c = createCatalog(":memory:", ACC);
    const series = [{ uid: "3.3.1", number: 1, modality: "CT", instanceCount: 1 }, { uid: "3.3.2", number: 2, modality: "SR", instanceCount: 1 }];
    c.publish(publicationFor(documentOf("3.3", { status: "registered", series }), "p1", { series: [] }));
    c.publish(publicationFor(documentOf("3.4", { date: "20100101", status: "cancelled", series }), "p1", { series: [] }));
    c.publish(publicationFor(documentOf("3.5", { date: "20000101", status: "registered", series: [] }), "p1", { series: [] }));
    const { get, store } = server(c, { token: SERVICE });
    const codes = async () => Object.fromEntries(studiesOf((await get("patient=p1")).body).map((s: any) => [s.id, s.modality.map((m: any) => m.code)]));
    const access = (o: object) => ({ id: "r", type: "service-access" as const, service: "service:svc", patients: "patient:p1", allow: { all: true }, ...o });
    store.putPolicy(access({}));
    expect(await codes()).toEqual({ "study-3.3": ["CT", "SR"], "study-3.4": ["CT", "SR"], "study-3.5": ["OT"] });
    store.putPolicy(access({ withholdSeries: ["3.3.2", "3.4.1"] }));
    expect((await codes())["study-3.3"]).toEqual(["CT"]);
    store.putPolicy(access({ allow: { studies: ["study-3.3"] } }));
    expect(Object.keys(await codes())).toEqual(["study-3.3"]);
  });
  describe("token search", () => {
    const fixture = () => {
      const c = createCatalog(":memory:", ACC);
      put(c, "7.1", { date: "20210101", accession: "A1" });
      put(c, "7.2", { date: "20200101", accession: "A2" });
      put(c, "7.3", { date: "20190101", accession: "A,B" });
      put(c, "7.9", { accession: "A1" }, "p2");
      const local = documentOf("7.4", { date: "20180101", accession: undefined });
      c.publish({ ...publicationFor(local, "p1", hierarchyOf("7.4")), identifiers: [{ kind: "identifier", value: "LOCAL" }, { kind: "based-on", value: "LOCAL" }] });
      return server(c);
    };
    const ids = async (get: ReturnType<typeof fixture>["get"], q: string) => { const r = await get(`patient=p1&${q}`); expect(r.status).toBe(200); return studiesOf(r.body).map((s: any) => s.id.replace("study-", "")); };
    const e = encodeURIComponent;
    for (const param of ["identifier", "based-on:identifier"]) {
      test(`${param}: empty and malformed values are 400s with an OperationOutcome`, async () => {
        const { get } = fixture();
        for (const bad of ["", ",", "A1,", ",A1", "|", "a|b|c"]) {
          const r = await get(`patient=p1&${param}=${e(bad)}`);
          expect(r.status).toBe(400);
          expect(r.body.resourceType).toBe("OperationOutcome");
          expect(r.body.issue[0].code).toBe("invalid");
        }
        expect((await get(`patient=p1&${param}=A1&${param}=`)).status).toBe(400);
        expect((await get(`patient=p1&${param}=${Array(101).fill("A1").join(",")}`)).status).toBe(400);
      });
      test(`${param}: a comma is OR and a repeat is AND, within the patient`, async () => {
        const { get } = fixture();
        expect(await ids(get, `${param}=A1`)).toEqual(["7.1"]);
        expect(await ids(get, `${param}=A1,A2`)).toEqual(["7.1", "7.2"]);
        expect(await ids(get, `${param}=A1&${param}=A2`)).toEqual([]);
        expect(await ids(get, `${param}=A1&${param}=A1,A2`)).toEqual(["7.1"]);
        expect(await ids(get, `${param}=${e("A\\,B")}`)).toEqual(["7.3"]);
        expect(await ids(get, `${param}=A,B`)).toEqual([]);
      });
      test(`${param}: system|value, |value, value and system|`, async () => {
        const { get } = fixture();
        expect(await ids(get, `${param}=${e(`${ACCESSION_SYSTEM}|A1`)}`)).toEqual(["7.1"]);
        expect(await ids(get, `${param}=${e("urn:other|A1")}`)).toEqual([]);
        expect(await ids(get, `${param}=${e("|A1")}`)).toEqual([]);
        expect(await ids(get, `${param}=${e("|LOCAL")}`)).toEqual(["7.4"]);
        expect(await ids(get, `${param}=LOCAL`)).toEqual(["7.4"]);
        expect(await ids(get, `${param}=${e(`${ACCESSION_SYSTEM}|LOCAL`)}`)).toEqual([]);
        expect(await ids(get, `${param}=${e(`${ACCESSION_SYSTEM}|`)}`)).toEqual(["7.1", "7.2", "7.3"]);
        expect(await ids(get, `${param}=${e("urn:other|")}`)).toEqual([]);
      });
    }
    test("identifier and based-on:identifier filter together, and only their own kinds", async () => {
      const { get } = fixture();
      expect(await ids(get, `identifier=A1&based-on:identifier=A1,A2`)).toEqual(["7.1"]);
      expect(await ids(get, `identifier=A1&based-on:identifier=A2`)).toEqual([]);
      expect(await ids(get, "identifier=urn:oid:7.1")).toEqual(["7.1"]);
      expect(await ids(get, "based-on:identifier=urn:oid:7.1")).toEqual([]);
    });
    test("a cursor binds to the whole filter, and next keeps every repeat", async () => {
      const { get } = fixture();
      const q = "patient=p1&identifier=A1,A2,LOCAL&identifier=A1,A2&_count=1";
      const first = (await get(q)).body;
      expect(first.total).toBe(2);
      const next = nextOf(first)!;
      expect(new URL(next).searchParams.getAll("identifier")).toEqual(["A1,A2,LOCAL", "A1,A2"]);
      expect(studiesOf((await get(internal(next))).body).map((s: any) => s.id)).toEqual(["study-7.2"]);
      const cursor = e(new URL(next).searchParams.get("_cursor")!);
      for (const changed of ["identifier=A1,A2,LOCAL", "identifier=A1,A2,LOCAL&identifier=A1", "identifier=A1,A2,LOCAL&identifier=A1,A2,LOCAL", "identifier=A1,A2&identifier=A1,A2,LOCAL"]) {
        const r = await get(`patient=p1&${changed}&_count=1&_cursor=${cursor}`);
        expect(r.status).toBe(400);
        expect(r.body.issue[0].diagnostics).toContain("different filters");
      }
    });
  });
  describe("_lastUpdated", () => {
    const fixture = () => {
      const c = createCatalog(":memory:", ACC);
      for (const [uid, date, lastUpdated] of [["a", "20240101", "2019-12-31T23:59:59Z"], ["b", "20230101", "2020-01-01T00:00:00Z"], ["c", "20220101", "2020-06-15T12:00:00.250Z"], ["d", "20210101", "2020-12-31T23:59:59.999Z"], ["e", "20200101", "2021-01-01T02:00:00+02:00"], ["f", "20190101", "2021-06-01T00:00:00Z"]] as const) put(c, uid, { date, lastUpdated });
      return server(c);
    };
    const ALL = ["a", "b", "c", "d", "e", "f"];
    const e = encodeURIComponent;
    test("each prefix, compared as instants, over the range a value's precision implies", async () => {
      const { get } = fixture();
      const cases: [string, string[]][] = [
        ["2020", ["b", "c", "d"]], ["eq2020", ["b", "c", "d"]], ["ne2020", ["a", "e", "f"]],
        ["gt2020", ["e", "f"]], ["sa2020", ["e", "f"]], ["ge2020", ["b", "c", "d", "e", "f"]],
        ["lt2020", ["a"]], ["eb2020", ["a"]], ["le2020", ["a", "b", "c", "d"]],
        ["lt2000-01-01T00:00:00Z", []], ["gt2030-01-01T00:00:00Z", []], ["ge2000", ALL], ["le2030", ALL],
        ["2020-06", ["c"]], ["gt2020-06", ["d", "e", "f"]], ["le2020-06", ["a", "b", "c"]],
        ["2020-06-15", ["c"]], ["lt2020-06-15", ["a", "b"]], ["gt2020-06-15", ["d", "e", "f"]],
        ["2020-06-15T12:00", ["c"]], ["2020-06-15T12:00:00Z", ["c"]], ["gt2020-06-15T12:00:00Z", ["d", "e", "f"]], ["2020-06-15T12:00:00.25Z", ["c"]], ["2020-06-15T12:00:00.26Z", []], ["2020-06-15T12:00:00.2Z", ["c"]], ["2020-06-15T12:00:00.250Z", ["c"]], ["gt2020-06-15T12:00:00.250Z", ["d", "e", "f"]], ["ge2020-06-15T12:00:00.250Z", ["c", "d", "e", "f"]], ["lt2020-06-15T12:00:00.250Z", ["a", "b"]], ["le2020-06-15T12:00:00.250Z", ["a", "b", "c"]],
        // The same instant, spelled three ways, on either side.
        ["eq2020-01-01T00:00:00Z", ["b"]], ["eq2020-01-01T00:00:00+00:00", ["b"]], ["eq2019-12-31T19:00:00-05:00", ["b"]], ["gt2020-01-01T00:00:00+00:00", ["c", "d", "e", "f"]], ["gt2020-01-01T02:00:00+02:00", ["c", "d", "e", "f"]],
        ["eq2021-01-01T00:00:00Z", ["e"]], ["lt2021-01-01T00:00:00Z", ["a", "b", "c", "d"]],
      ];
      for (const [value, expected] of cases) {
        const r = await get(`patient=p1&_lastUpdated=${e(value)}`);
        expect([value, r.status]).toEqual([value, 200]);
        expect([value, studiesOf(r.body).map((s: any) => s.id.replace("study-", "")).sort()]).toEqual([value, expected]);
        expect(r.body.total).toBe(expected.length);
      }
    });
    test("a repeat is AND", async () => {
      const { get } = fixture();
      const r = await get("patient=p1&_lastUpdated=ge2020-01-01&_lastUpdated=lt2020-07");
      expect(studiesOf(r.body).map((s: any) => s.id.replace("study-", "")).sort()).toEqual(["b", "c"]);
    });
    test("anything unsupported or unreadable is a 400, never ignored", async () => {
      const { get } = fixture();
      for (const bad of ["", "gt", "nonsense", "gtnonsense", "ap2020", "GT2020", "ge2020,lt2021", "2020-13", "2020-02-30", "2020-00", "20200101", "gt2020-01-01T25:00:00Z", "2020-01-01T00:60:00Z", "2020-01-01T00:00:00+15:00", "2020-01-01T00", "0000", "gt2020-01-01 00:00:00"]) {
        const r = await get(`patient=p1&_lastUpdated=${e(bad)}`);
        expect([bad, r.status]).toEqual([bad, 400]);
        expect(r.body.resourceType).toBe("OperationOutcome");
      }
      expect((await get("patient=p1&_lastUpdated=ge2020&_lastUpdated=nonsense")).status).toBe(400);
    });
    test("a cursor binds to the range the value means, and pages stay filtered", async () => {
      const { get } = fixture();
      const first = (await get("patient=p1&_lastUpdated=ge2020&_count=2")).body;
      expect(first.total).toBe(5);
      const next = nextOf(first)!;
      expect(studiesOf((await get(internal(next))).body).map((s: any) => s.id)).toEqual(["study-d", "study-e"]);
      const cursor = e(new URL(next).searchParams.get("_cursor")!);
      const r = await get(`patient=p1&_lastUpdated=gt2020&_count=2&_cursor=${cursor}`);
      expect(r.status).toBe(400);
      expect(r.body.issue[0].diagnostics).toContain("different filters");
    });
  });
  test("patient is an id, a relative reference, or a reference on the clinical FHIR base", async () => {
    const c = createCatalog(":memory:", ACC);
    put(c, "8.1");
    const { get } = server(c);
    for (const ok of ["p1", "Patient/p1", "http://clinical/Patient/p1"]) expect((await get(`patient=${encodeURIComponent(ok)}`)).body.total).toBe(1);
    for (const foreign of ["https://evil.example/fhir/Patient/p1", "http://clinical.evil/Patient/p1", "http://evil/http://clinical/Patient/p1", "urn:uuid:p1"]) {
      const r = await get(`patient=${encodeURIComponent(foreign)}`);
      expect([foreign, r.status]).toEqual([foreign, 403]);
      expect(r.body.resourceType).toBe("OperationOutcome");
    }
    for (const bad of ["Group/p1", "x/Patient/p1", "http://clinical/Patient/p1/_history/1", "Patient/../Patient/p1", "p1,p2", "Patient/", "a b"]) {
      const r = await get(`patient=${encodeURIComponent(bad)}`);
      expect([bad, r.status]).toEqual([bad, 400]);
      expect(r.body.resourceType).toBe("OperationOutcome");
    }
    expect((await get("patient=p1&patient=p2")).status).toBe(400);
    expect((await get("patient=")).status).toBe(400);
  });
  test("the Bearer scheme is case-insensitive", async () => {
    const c = createCatalog(":memory:", ACC);
    put(c, "8.2");
    const { imaging } = server(c);
    for (const scheme of ["Bearer", "bearer", "BEARER", "bEaReR"]) expect((await imaging.fetch(new Request("http://fhir/fhir/ImagingStudy?patient=p1", { headers: { Authorization: `${scheme} t` } }))).status).toBe(200);
    for (const header of ["Basic t", "bearer", "bearer ", "Bearert"]) expect((await imaging.fetch(new Request("http://fhir/fhir/ImagingStudy?patient=p1", { headers: { Authorization: header } }))).status).toBe(401);
    for (const scheme of ["Bearer", "bearer"]) expect((await imaging.fetch(new Request("http://fhir/policy/v2/relationships", { headers: { Authorization: `${scheme} ps` } }))).status).toBe(200);
  });
  test("a decision and a context carry the version", async () => {
    const c = createCatalog(":memory:", ACC);
    c.publish(publicationFor(documentOf("2.1", { version: 7 }), "p1", hierarchyOf("2.1")));
    const { get, imaging } = server(c);
    const b = (await get("patient=p1")).body;
    const address = b.entry[1].resource.address as string;
    expect(JSON.parse(Buffer.from(address.split("/wado/")[1]!.split(".")[1]!, "base64url").toString()).ver).toBe(7);
    const res = await imaging.fetch(new Request("http://fhir/access/v1/evaluation", { method: "POST", headers: { Authorization: "Bearer s" }, body: JSON.stringify({ subject: { type: "token", id: "x", properties: { access_token: "t" } }, resource: { type: "study", id: "2.1" }, action: { name: "can_i" } }) }));
    const d: any = await res.json();
    expect(d.decision).toBe(true);
    expect(d.context.version).toBe(7);
  });
  test("the Imaging Server has no way to read the archive", async () => {
    const source = (await Promise.all(["imaging-server.ts", "policy-api.ts"].map(f => Bun.file(join(root, "src", f)).text()))).join("\n");
    expect(source).not.toContain("ObjectSource");
    expect(source).not.toContain("archiveKeys");
    expect(source).not.toMatch(/from "\.\/backends/);
  });
  test("a study with no site is outside any list of sites, and inside no limit", async () => {
    const c = createCatalog(":memory:", ACC);
    put(c, "1.1", { site: undefined });
    const { get, store } = server(c);
    expect((await get("patient=p1")).body.total).toBe(1);
    store.putApproval({ ...APPROVAL, sites: ["Site A"] });
    expect((await get("patient=p1")).body.total).toBe(0);
  });
});
