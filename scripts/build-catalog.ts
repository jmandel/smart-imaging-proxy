// Rebuilds the catalog from the archive: bun scripts/build-catalog.ts [archive directory]
// It builds a new file and moves it into place, so a failed build leaves the old catalog. A server
// already running keeps the catalog it opened until it restarts.
import { renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CONFIG } from "../src/config";
import { createCatalog, DEFAULT_CATALOG_DB, seedPatientLinks } from "../src/catalog";
import { rebuildFromArchive } from "../src/catalog-archive";
import { fileStore } from "../src/archive/sources";

const root = join(import.meta.dir, "..");
const archive = process.argv[2] ?? process.env.ARCHIVE_DIR ?? CONFIG.archive.dir;
const target = process.env.CATALOG_DB || DEFAULT_CATALOG_DB;
const building = `${target}.building`;
for (const f of [building, `${building}-wal`, `${building}-shm`]) rmSync(f, { force: true });

const catalog = createCatalog(building);
seedPatientLinks(catalog, await Bun.file(join(root, "data/patient.json")).json());
const report = await rebuildFromArchive(fileStore(archive), catalog);
const stats = catalog.stats();
catalog.close();
for (const f of [`${target}-wal`, `${target}-shm`]) rmSync(f, { force: true });
renameSync(building, target);

console.log(`${target}: ${stats.studies} studies, ${stats.series} series, ${stats.hierarchyBytes} hierarchy bytes as stored`);
for (const u of report.unlinked) console.log(`Skipped ${u.study}: Patient ID ${u.sourcePatientId ?? "(none)"} isn't linked to a patient`);
