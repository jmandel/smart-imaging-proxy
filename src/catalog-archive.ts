// Rebuilds a catalog from the archive, through ObjectSource alone: every fact in the catalog is in
// the archive's documents, apart from which FHIR Patient a stated identity belongs to.
import { readFile } from "node:fs/promises";
import { Glob } from "bun";
import { join } from "node:path";
import { archiveKeys, type CatalogStore, type ObjectSource, type SeriesIndex, type StudyDocument, type StudyHierarchy } from "./archive/types";
import { patientSourceOf, publicationFor } from "./catalog";

const compressedJson = async <T>(source: ObjectSource, key: string): Promise<T> => JSON.parse(Buffer.from(Bun.zstdDecompressSync(await source.bytes(key))).toString("utf8"));

export interface RebuildReport { published: string[]; unlinked: { study: string; sourcePatientId?: string; sourcePatientIssuer?: string }[]; }

/** Publishes each study's current version. A study with an unlinked patient is reported and skipped, never guessed. */
export async function rebuildFromArchive(source: ObjectSource, catalog: CatalogStore): Promise<RebuildReport> {
  const keys: string[] = [];
  for await (const key of source.list("studies/")) if (key.endsWith("/current.json")) keys.push(key);
  // Sorted, so a rebuild assigns the same keys to the same studies.
  keys.sort();
  const report: RebuildReport = { published: [], unlinked: [] };
  for (const key of keys) {
    const uid = key.split("/")[1]!;
    const { version } = JSON.parse(await source.text(archiveKeys.current(uid))) as { version: number };
    const document = await compressedJson<StudyDocument>(source, archiveKeys.study(uid, version));
    const patient = document.sourcePatientId === undefined ? undefined : catalog.patientFor(patientSourceOf(document.sourcePatientIssuer), document.sourcePatientId);
    if (!patient) { report.unlinked.push({ study: uid, sourcePatientId: document.sourcePatientId, sourcePatientIssuer: document.sourcePatientIssuer }); continue; }
    const hierarchy: StudyHierarchy = { series: [] };
    for (const s of document.series) {
      const index = await compressedJson<SeriesIndex>(source, archiveKeys.seriesIndex(uid, version, s.uid));
      hierarchy.series.push({
        uid: index.uid, number: index.number, modality: index.modality,
        ...(index.description !== undefined ? { description: index.description } : {}), ...(index.bodyPart !== undefined ? { bodyPart: index.bodyPart } : {}),
        instances: index.instances.map(i => ({ uid: i.uid, number: i.number, sopClass: i.sopClass })),
      });
    }
    catalog.publish(publicationFor(document, patient, hierarchy));
    report.published.push(uid);
  }
  return report;
}

/** The archive in a local directory, holding the same keys as a bucket. */
export function directorySource(dir: string): ObjectSource {
  const path = (key: string) => join(dir, key);
  const once = async function* (bytes: Uint8Array) { yield bytes; };
  return {
    name: `directory ${dir}`,
    read: key => Bun.file(path(key)).stream() as unknown as AsyncIterable<Uint8Array>,
    readRange: (key, start, length) => Bun.file(path(key)).slice(start, start + length).stream() as unknown as AsyncIterable<Uint8Array>,
    bytes: async key => new Uint8Array(await readFile(path(key))),
    text: key => Bun.file(path(key)).text(),
    async *list(prefix) { for await (const key of new Glob(`${prefix}**`).scan({ cwd: dir, onlyFiles: true })) yield key; },
  };
}
