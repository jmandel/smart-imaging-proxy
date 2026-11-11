// The catalog: one SQLite file the Imaging Server queries for search. It holds no policy and can
// always be rebuilt from its source, so it's a separate file from the policy store, which can't.
// The SQL stays simple enough to move to another database without changing anything around it.
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { CatalogPosition, CatalogSearch, CatalogStore, CatalogStudy, StudyDocument, StudyHierarchy, StudyPublication, TokenFilter } from "./archive/types";

export const CATALOG_SCHEMA_VERSION = 2;
export const DICOM_UID_SYSTEM = "urn:dicom:uid";
/** Where a Patient ID with no stated issuer comes from, in `patient_links`. */
export const UNQUALIFIED_PATIENT_IDS = "dicom-patient-id";
const DEFAULT_BATCH = 200;

// A study with no date has an empty `date`, which sorts after every real date going down, and `pk`
// gives it a stable position among others like it.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS studies (
    pk INTEGER PRIMARY KEY, uid TEXT NOT NULL UNIQUE, id TEXT NOT NULL UNIQUE, patient TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('registered', 'available', 'cancelled')),
    date TEXT NOT NULL, time TEXT, description TEXT, title TEXT, accession TEXT, site TEXT, labels TEXT,
    last_updated TEXT NOT NULL, version INTEGER NOT NULL, series_count INTEGER NOT NULL, instance_count INTEGER NOT NULL, hierarchy_bytes INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS studies_by_date ON studies (patient, date DESC, pk DESC);
  CREATE INDEX IF NOT EXISTS studies_by_last_updated ON studies (patient, last_updated, pk);
  CREATE TABLE IF NOT EXISTS study_identifiers (
    study_pk INTEGER NOT NULL REFERENCES studies (pk), patient TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('identifier', 'based-on')), system TEXT, value TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS study_identifiers_lookup ON study_identifiers (patient, kind, value, system, study_pk);
  CREATE INDEX IF NOT EXISTS study_identifiers_by_study ON study_identifiers (study_pk);
  CREATE TABLE IF NOT EXISTS series (
    study_pk INTEGER NOT NULL REFERENCES studies (pk), position INTEGER NOT NULL, uid TEXT NOT NULL, number INTEGER NOT NULL, modality TEXT NOT NULL, instance_count INTEGER NOT NULL,
    PRIMARY KEY (study_pk, position));
  CREATE TABLE IF NOT EXISTS study_hierarchy (
    study_pk INTEGER PRIMARY KEY REFERENCES studies (pk), zstd_json BLOB NOT NULL);
  CREATE TABLE IF NOT EXISTS patient_links (
    source TEXT NOT NULL, source_patient_id TEXT NOT NULL, patient TEXT NOT NULL,
    PRIMARY KEY (source, source_patient_id));`;

const encoder = new TextEncoder();

/** The Orthanc catalog sits beside the archive catalog, since it's built from a different source. */
export const orthancCatalogPath = (path: string) => path === ":memory:" ? path : path.replace(/(\.sqlite)?$/, "-orthanc$1");

/** The default for `lastUpdated` at ingest: midnight on the study date. */
export function defaultLastUpdated(date?: string): string {
  return `${date ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` : "2020-01-01"}T00:00:00Z`;
}

/** Which `patient_links` source a study's stated identity belongs to. */
export const patientSourceOf = (issuer?: string) => issuer || UNQUALIFIED_PATIENT_IDS;

/** The searchable identifiers of a study: DICOM UID and accession, and the accession as its order. */
export function identifiersOf(d: { uid: string; accession?: string }, accessionSystem?: string): StudyPublication["identifiers"] {
  const system = accessionSystem ? { system: accessionSystem } : {};
  return [
    { kind: "identifier", system: DICOM_UID_SYSTEM, value: `urn:oid:${d.uid}` },
    ...(d.accession ? [
      { kind: "identifier" as const, ...system, value: d.accession },
      { kind: "based-on" as const, ...system, value: d.accession },
    ] : []),
  ];
}

/** `accessionSystem` is the system of the accession numbers, as the catalog that will hold the study names it. */
export function publicationFor(document: StudyDocument, patient: string, hierarchy: StudyHierarchy, accessionSystem?: string): StudyPublication {
  return { document, patient, hierarchy, status: document.status ?? "available", lastUpdated: document.lastUpdated ?? defaultLastUpdated(document.date), identifiers: identifiersOf(document, accessionSystem) };
}

const LAST_UPDATED_SECONDS = "unixepoch(s.last_updated, 'subsec')";
const STUDY_COLUMNS = "s.pk, s.uid, s.id, s.patient, s.status, s.date, s.time, s.description, s.title, s.accession, s.site, s.labels, s.last_updated, s.version, s.series_count, s.instance_count, s.hierarchy_bytes";

/** `accessionSystem` is the identifier system of the studies' accession numbers. Without it, they have none. */
export function createCatalog(path: string = ":memory:", opts: { accessionSystem?: string } = {}): CatalogStore {
  const inMemory = path === ":memory:";
  if (!inMemory) mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  if (!inMemory && existsSync(path)) chmodSync(path, 0o600);
  db.exec("PRAGMA busy_timeout = 2000");
  if (!inMemory) db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  const found = (db.query("PRAGMA user_version").get() as any).user_version as number;
  if (found > CATALOG_SCHEMA_VERSION) { db.close(); throw new Error(`${path} has schema version ${found}, and this code knows only up to ${CATALOG_SCHEMA_VERSION}. The catalog is rebuildable: delete it and build it again.`); }
  // A catalog is derived, so one from an earlier schema starts empty and is built again from its source.
  if (found < CATALOG_SCHEMA_VERSION) db.transaction(() => { if (found) for (const t of ["study_hierarchy", "series", "study_identifiers", "studies"]) db.exec(`DROP TABLE IF EXISTS ${t}`); db.exec(SCHEMA); db.exec(`PRAGMA user_version = ${CATALOG_SCHEMA_VERSION}`); })();

  const toStudy = (r: any, series: CatalogStudy["series"]): CatalogStudy => ({
    pk: r.pk, uid: r.uid, id: r.id, patient: r.patient, status: r.status,
    ...(r.date ? { date: r.date } : {}), ...(r.time ? { time: r.time } : {}), ...(r.description !== null ? { description: r.description } : {}), ...(r.title !== null ? { title: r.title } : {}), ...(r.accession ? { accession: r.accession } : {}), ...(r.site ? { site: r.site } : {}), ...(r.labels ? { labels: JSON.parse(r.labels) } : {}),
    lastUpdated: r.last_updated, version: r.version, seriesCount: r.series_count, instanceCount: r.instance_count, hierarchyBytes: r.hierarchy_bytes, series,
  });
  /** Attaches series rows to study rows, with one query for the whole batch. */
  const withSeries = (rows: any[]): CatalogStudy[] => {
    if (!rows.length) return [];
    const bySeries = new Map<number, CatalogStudy["series"]>(rows.map(r => [r.pk, []]));
    const series = db.query(`SELECT study_pk, uid, number, modality, instance_count FROM series WHERE study_pk IN (${rows.map(() => "?").join(",")}) ORDER BY study_pk, position`).all(...rows.map(r => r.pk)) as any[];
    for (const s of series) bySeries.get(s.study_pk)!.push({ uid: s.uid, number: s.number, modality: s.modality, instanceCount: s.instance_count });
    return rows.map(r => toStudy(r, bySeries.get(r.pk)!));
  };

  const publish = db.transaction((p: StudyPublication) => {
    const d = p.document;
    const raw = encoder.encode(JSON.stringify(p.hierarchy));
    const instanceCount = d.series.reduce((n, s) => n + s.instanceCount, 0);
    const row = db.query(`
      INSERT INTO studies (uid, id, patient, status, date, time, description, title, accession, site, last_updated, version, series_count, instance_count, hierarchy_bytes, labels)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
      ON CONFLICT (uid) DO UPDATE SET id = ?2, patient = ?3, status = ?4, date = ?5, time = ?6, description = ?7, title = ?8, accession = ?9, site = ?10, last_updated = ?11, version = ?12, series_count = ?13, instance_count = ?14, hierarchy_bytes = ?15, labels = ?16
      RETURNING pk`).get(d.uid, d.id, p.patient, p.status, d.date ?? "", d.time ?? null, d.description ?? null, d.title ?? null, d.accession ?? null, d.site ?? null, p.lastUpdated, d.version, d.series.length, instanceCount, raw.length, d.labels?.length ? JSON.stringify(d.labels) : null) as any;
    const pk: number = row.pk;
    for (const table of ["study_identifiers", "series", "study_hierarchy"]) db.run(`DELETE FROM ${table} WHERE study_pk = ?`, [pk]);
    p.identifiers.forEach(i => db.run("INSERT INTO study_identifiers (study_pk, patient, kind, system, value) VALUES (?, ?, ?, ?, ?)", [pk, p.patient, i.kind, i.system ?? null, i.value]));
    d.series.forEach((s, position) => db.run("INSERT INTO series (study_pk, position, uid, number, modality, instance_count) VALUES (?, ?, ?, ?, ?, ?)", [pk, position, s.uid, s.number, s.modality, s.instanceCount]));
    db.run("INSERT INTO study_hierarchy (study_pk, zstd_json) VALUES (?, ?)", [pk, Bun.zstdCompressSync(raw)]);
  });

  return {
    accessionSystem: opts.accessionSystem,
    publish(p) { publish(p); },
    candidates(q: CatalogSearch, after?: CatalogPosition, batch = DEFAULT_BATCH) {
      const where = ["s.patient = ?"], args: (string | number)[] = [q.patient];
      const matching = (kind: string, filter: TokenFilter = []) => {
        for (const anyOf of filter) {
          args.push(q.patient, kind);
          const terms = anyOf.map(t => {
            const term: string[] = [];
            if (t.value !== undefined) { term.push("i.value = ?"); args.push(t.value); }
            if (t.system === null) term.push("i.system IS NULL");
            else if (t.system !== undefined) { term.push("i.system = ?"); args.push(t.system); }
            return `(${term.join(" AND ")})`;
          });
          where.push(`s.pk IN (SELECT i.study_pk FROM study_identifiers i WHERE i.patient = ? AND i.kind = ? AND (${terms.join(" OR ")}))`);
        }
      };
      matching("identifier", q.identifier);
      matching("based-on", q.basedOn);
      // Stored values are compared as instants, however each one spells its offset.
      for (const r of q.lastUpdated ?? []) {
        const bounds: string[] = [];
        if (r.from !== undefined) { bounds.push(`${LAST_UPDATED_SECONDS} >= ?`); args.push(r.from / 1000); }
        if (r.before !== undefined) { bounds.push(`${LAST_UPDATED_SECONDS} < ?`); args.push(r.before / 1000); }
        where.push(`${r.not ? "NOT " : ""}(${bounds.join(" AND ")})`);
      }
      if (after) { where.push("(s.date, s.pk) < (?, ?)"); args.push(after.date, after.pk); }
      return withSeries(db.query(`SELECT ${STUDY_COLUMNS} FROM studies s WHERE ${where.join(" AND ")} ORDER BY s.patient, s.date DESC, s.pk DESC LIMIT ?`).all(...args, batch) as any[]);
    },
    hierarchies(pks: number[]) {
      const out = new Map<number, StudyHierarchy>();
      if (!pks.length) return out;
      const rows = db.query(`SELECT study_pk, zstd_json FROM study_hierarchy WHERE study_pk IN (${pks.map(() => "?").join(",")})`).all(...pks) as any[];
      for (const r of rows) out.set(r.study_pk, JSON.parse(Buffer.from(Bun.zstdDecompressSync(r.zstd_json)).toString("utf8")));
      return out;
    },
    studyByUid(uid) { return withSeries(db.query(`SELECT ${STUDY_COLUMNS} FROM studies s WHERE s.uid = ?`).all(uid) as any[])[0]; },
    patientFor(source, sourcePatientId) { return (db.query("SELECT patient FROM patient_links WHERE source = ? AND source_patient_id = ?").get(source, sourcePatientId) as any)?.patient; },
    linkPatient(source, sourcePatientId, patient) { db.run("INSERT INTO patient_links (source, source_patient_id, patient) VALUES (?1, ?2, ?3) ON CONFLICT (source, source_patient_id) DO UPDATE SET patient = ?3", [source, sourcePatientId, patient]); },
    linkedPatients() { return (db.query("SELECT DISTINCT patient FROM patient_links ORDER BY patient").all() as any[]).map(r => r.patient); },
    sitesFor(patient) { return (db.query("SELECT DISTINCT site FROM studies WHERE patient = ? AND site IS NOT NULL ORDER BY site").all(patient) as any[]).map(r => r.site); },
    allSites() { return (db.query("SELECT DISTINCT site FROM studies WHERE site IS NOT NULL ORDER BY site").all() as any[]).map(r => r.site); },
    allStudies() { return withSeries(db.query(`SELECT ${STUDY_COLUMNS} FROM studies s ORDER BY s.pk`).all() as any[]); },
    stats() {
      const n = (sql: string) => (db.query(sql).get() as any).n as number;
      return { studies: n("SELECT count(*) AS n FROM studies"), series: n("SELECT count(*) AS n FROM series"), hierarchyBytes: n("SELECT coalesce(sum(length(zstd_json)), 0) AS n FROM study_hierarchy"), hierarchyRawBytes: n("SELECT coalesce(sum(hierarchy_bytes), 0) AS n FROM studies"), path };
    },
    close() { db.close(); },
  };
}

/** Links each patient's unqualified Patient ID to their id, from a list that stands in for a master patient index. */
export function seedPatientLinks(catalog: CatalogStore, people: { id: string; mrn: string; otherPatients?: { id: string; mrn: string }[] }) {
  for (const p of [people, ...(people.otherPatients ?? [])]) catalog.linkPatient(UNQUALIFIED_PATIENT_IDS, p.mrn, p.id);
}
