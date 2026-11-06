// Rebuilds the Orthanc catalog using only Orthanc's QIDO-RS API: bun scripts/catalog-from-orthanc.ts
// It builds a new file and moves it into place. A server already running keeps the catalog it
// opened until it restarts. Orthanc is only read.
import { renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CONFIG } from "../src/config";
import { createCatalog, DEFAULT_CATALOG_DB, orthancCatalogPath, seedPatientLinks } from "../src/catalog";
import { catalogFromOrthanc } from "../src/catalog-orthanc";

const root = join(import.meta.dir, "..");
const target = orthancCatalogPath(process.env.CATALOG_DB || DEFAULT_CATALOG_DB);
const building = `${target}.building`;
for (const f of [building, `${building}-wal`, `${building}-shm`]) rmSync(f, { force: true });

const catalog = createCatalog(building);
seedPatientLinks(catalog, await Bun.file(join(root, "data/patient.json")).json());
const report = await catalogFromOrthanc(catalog, CONFIG.orthanc, await Bun.file(join(root, "data/orthanc-catalog.json")).json());
const stats = catalog.stats();
catalog.close();
for (const f of [`${target}-wal`, `${target}-shm`]) rmSync(f, { force: true });
renameSync(building, target);

console.log(`${target}: ${stats.studies} studies, ${stats.series} series, ${stats.hierarchyBytes} hierarchy bytes as stored`);
for (const u of report.unlinked) console.log(`Skipped ${u.study}: Patient ID ${u.sourcePatientId ?? "(none)"} isn't linked to a patient`);
