// The demo's data as it stands before the archive format merges. This one function is the only
// reader of data/manifest.json, and it's removed at integration, once the archive backend no longer
// needs a manifest and scripts/build-catalog.ts builds the catalog.
import { join } from "node:path";
import type { CatalogStore, StudyDocument, StudyHierarchy } from "./archive/types";
import { patientSourceOf, publicationFor, seedPatientLinks } from "./catalog";

/** Publishes the manifest's studies if the catalog is empty. Returns the manifest for the store backends. */
export async function catalogFromManifest(root: string, catalog: CatalogStore): Promise<any> {
  const SITES: Record<string, string> = {
    "mri-brain-2020": "Lakeside Imaging",
    "ct-abdomen-pelvis-2012": "Riverside Hospital",
    "xr-wrist-left-2012": "Riverside Hospital",
    "xr-hand-wrist-right-2012": "Riverside Hospital",
    "xr-hand-right-2012": "Riverside Hospital",
    "slide-lung-2023": "Northside Pathology",
  };
  const manifest = await Bun.file(join(root, "data/manifest.json")).json();
  seedPatientLinks(catalog, await Bun.file(join(root, "data/patient.json")).json());
  if (catalog.stats().studies > 0) return manifest;
  for (const s of manifest.studies) {
    const document: StudyDocument = {
      format: 1, uid: s.uid, id: s.id, version: 1, title: s.title, description: s.description, accession: s.accession, date: s.date, time: s.time,
      sourcePatientId: s.patientId, site: SITES[s.id],
      series: s.series.map((x: any) => ({ uid: x.uid, number: x.number, modality: x.modality, instanceCount: x.instances.length })),
    };
    const hierarchy: StudyHierarchy = {
      series: s.series.map((x: any) => ({
        uid: x.uid, number: x.number, modality: x.modality,
        ...(x.description !== undefined ? { description: x.description } : {}), ...(x.bodyPart !== undefined ? { bodyPart: x.bodyPart } : {}),
        instances: x.instances.map((i: any) => ({ uid: i.uid, number: i.number, sopClass: i.sopClass })),
      })),
    };
    catalog.publish(publicationFor(document, catalog.patientFor(patientSourceOf(), s.patientId)!, hierarchy));
  }
  return manifest;
}
