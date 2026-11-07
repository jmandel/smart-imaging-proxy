// The archive format and the interfaces around it. Ingest writes this, backends and the catalog
// read it. Objects are immutable: a change to a study writes a new version, and `current.json` is
// the single small object that says which version is live.
//
//   studies/{study}/current.json                               { "version": 3 }
//   studies/{study}/v{version}/study.json.zst                  StudyDocument
//   studies/{study}/v{version}/series/{series}/index.json.zst  SeriesIndex
//   studies/{study}/v{version}/series/{series}/metadata.json.zst  SeriesMetadata
//   content/{sha256}.dcm[.zst]                                 PS3.10 bytes, by the hash of those bytes

export const ARCHIVE_FORMAT = 2;

export const archiveKeys = {
  current: (study: string) => `studies/${study}/current.json`,
  study: (study: string, version: number) => `studies/${study}/v${version}/study.json.zst`,
  seriesIndex: (study: string, version: number, series: string) => `studies/${study}/v${version}/series/${series}/index.json.zst`,
  seriesMetadata: (study: string, version: number, series: string) => `studies/${study}/v${version}/series/${series}/metadata.json.zst`,
  content: (sha256: string, encoding: ObjectEncoding) => `content/${sha256}.dcm${encoding === "zstd" ? ".zst" : ""}`,
};

export type ObjectEncoding = "none" | "zstd";

/** One way an instance can be served. The stored form is one offer, and any variants are others. */
export interface Offer {
  syntax: string;
  /** The form this instance is held in, which is what `*` returns. */
  stored: boolean;
  /** Returned only when the request names this syntax. */
  private?: boolean;
  key: string;
  encoding: ObjectEncoding;
  /** Size of the object in the store. */
  objectBytes: number;
  /** Size of the PS3.10 file once any object encoding is removed. */
  storedBytes: number;
  /** SHA-256 of the PS3.10 bytes, which also names the object. */
  sha256: string;
}

export interface InstanceRecord {
  uid: string;
  number: number;
  sopClass: string;
  /** Bulk elements at any depth, by path (`bulkPath`: a tag, or tag, item number from 1, tag, ...), as offsets into the decoded stored PS3.10 file. */
  bulk?: Record<string, { offset: number; length: number }>;
  /** The transfer syntax as received, when ingest normalized it to something else. */
  sourceSyntax?: string;
  offers: Offer[];
}

export interface SeriesIndex {
  format: number;
  study: string;
  version: number;
  uid: string;
  number: number;
  modality: string;
  description?: string;
  bodyPart?: string;
  instances: InstanceRecord[];
}

/** DICOM JSON for each instance in a series, by SOP Instance UID. */
export interface SeriesMetadata { format: number; instances: Record<string, unknown>; }

export interface StudyDocument {
  format: number;
  uid: string;
  /** The FHIR `ImagingStudy.id`. */
  id: string;
  version: number;
  title?: string;
  description?: string;
  accession?: string;
  date?: string;
  time?: string;
  /** Identity as the images state it, resolved to a FHIR Patient through `patient_links`. */
  sourcePatientId?: string;
  sourcePatientIssuer?: string;
  site?: string;
  /** Labels on the record, such as `confidential-adolescent`, which organization policy can hide by. */
  labels?: string[];
  /** ISO 8601. Absent means the catalog derives it from `date`. */
  lastUpdated?: string;
  /** Absent means `available`. */
  status?: "registered" | "available" | "cancelled";
  series: { uid: string; number: number; modality: string; instanceCount: number }[];
}

/** What search needs about a study, without any storage details. Stored compressed in the catalog. */
export interface StudyHierarchy {
  series: {
    uid: string; number: number; modality: string; description?: string; bodyPart?: string;
    instances: { uid: string; number: number; sopClass: string }[];
  }[];
}

/** One row per study in the catalog, without its hierarchy. Policy runs over these. */
export interface CatalogStudy {
  pk: number;
  uid: string;
  id: string;
  patient: string;
  status: "registered" | "available" | "cancelled";
  /** `YYYYMMDD`, as in DICOM. */
  date?: string;
  time?: string;
  description?: string;
  title?: string;
  accession?: string;
  site?: string;
  /** The study's labels, from its document. */
  labels?: string[];
  /** ISO 8601. */
  lastUpdated: string;
  version: number;
  seriesCount: number;
  instanceCount: number;
  /** Size of the uncompressed hierarchy, which search's page budget is measured in. */
  hierarchyBytes: number;
  series: { uid: string; number: number; modality: string; instanceCount: number }[];
}

/** One FHIR token. No `system` is any system, and `null` is an identifier with none. No `value` is any value. */
export interface TokenTerm { system?: string | null; value?: string; }
/** Every inner list has to match (repeated parameters), by any one of its terms (comma-separated values). */
export type TokenFilter = TokenTerm[][];
/** Epoch milliseconds: `from` is inclusive and `before` exclusive. `not` is everything outside the range. */
export interface InstantRange { from?: number; before?: number; not?: boolean; }

export interface CatalogSearch {
  patient: string;
  /** Matches any identifier on the study: DICOM UID or accession. */
  identifier?: TokenFilter;
  /** Matches order identifiers, for `based-on:identifier`. */
  basedOn?: TokenFilter;
  /** `lastUpdated` is in every one of these. */
  lastUpdated?: InstantRange[];
}

/** Newest first: `(date DESC, pk DESC)`. A cursor resumes strictly after this position. */
export interface CatalogPosition { date: string; pk: number; }

export interface StudyPublication { document: StudyDocument; patient: string; status: CatalogStudy["status"]; lastUpdated: string; hierarchy: StudyHierarchy; identifiers: { kind: "identifier" | "based-on"; system?: string; value: string }[]; }

/**
 * The catalog: rebuildable from the archive, and read by the Imaging Server. Search needs
 * no bucket reads. Queries are scoped to a patient, since the search API always is.
 */
export interface CatalogStore {
  /** The identifier system of accession numbers, if the deployment names one. */
  readonly accessionSystem?: string;
  /** Atomically makes this version of the study searchable. Ingest makes a version live separately, by writing `current.json`. */
  publish(p: StudyPublication): void;
  /** Rows for one patient, in order, starting after `after`, without hierarchies. */
  candidates(q: CatalogSearch, after?: CatalogPosition, batch?: number): CatalogStudy[];
  /** Hierarchies for a page, with one query. */
  hierarchies(pks: number[]): Map<number, StudyHierarchy>;
  studyByUid(uid: string): CatalogStudy | undefined;
  /** FHIR Patient for a source identity, if it's linked. */
  patientFor(source: string, sourcePatientId: string): string | undefined;
  linkPatient(source: string, sourcePatientId: string, patient: string): void;
  /** Every FHIR Patient some source identity links to. */
  linkedPatients(): string[];
  /** The sites one patient has studies at. */
  sitesFor(patient: string): string[];
  /** Every study, for an operator's displays and for tests. Search must not use this. */
  allStudies(): CatalogStudy[];
  /** `hierarchyBytes` is as stored, compressed. `hierarchyRawBytes` is the same data uncompressed. */
  stats(): { studies: number; series: number; hierarchyBytes: number; hierarchyRawBytes: number; path: string };
  close(): void;
}

/** A store of immutable objects. Local files and the S3 bucket both provide this. */
export interface ObjectSource {
  name: string;
  read(key: string): AsyncIterable<Uint8Array>;
  readRange(key: string, start: number, length: number): AsyncIterable<Uint8Array>;
  /** Whole small objects: documents and indexes. */
  bytes(key: string): Promise<Uint8Array>;
  text(key: string): Promise<string>;
  /** Keys under a prefix. Only the catalog rebuild and reconciliation list: never a request path. */
  list(prefix: string): AsyncIterable<string>;
}
