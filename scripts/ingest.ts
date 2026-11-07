// Builds the archive from data/sources. Re-runnable:
// an unchanged study writes nothing, and a changed one writes a new version.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { ingestStudies, runTool, QUARANTINE_REPORT_KEY, type StudyInput } from "../src/archive/ingest";
import { fileStore } from "../src/archive/sources";
import { CONFIG } from "../src/config";

const root = join(import.meta.dir, "..");
const def = await Bun.file(join(root, "data/studies.source.json")).json();
const patient = await Bun.file(join(root, "data/patient.json")).json();
const VARIANT_STUDIES = new Set(["xr-wrist-left-2012"]);
const PRIVATE_FIXTURE_STUDY = "xr-wrist-left-2012";

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p));
    else if (e.isFile() && e.name.endsWith(".dcm")) out.push(p);
  }
  return out;
}

async function rewriteSlide(file: string, study: any) {
  const h = study.header;
  const args = ["dcmodify", "-nb", "-imt", "-ma", `(0010,0010)=${patient.dicomName}`, "-ma", `(0010,0020)=${patient.mrn}`, "-ma", `(0010,0030)=${patient.birthDate.replaceAll("-", "")}`, "-ma", `(0010,0040)=M`, "-ma", `(0008,0020)=${study.studyDate.replaceAll("-", "")}`, "-ma", `(0008,0030)=${study.studyTime.replaceAll(":", "")}`, "-ma", `(0008,0050)=${study.accession}`];
  for (const [tag, [, value]] of Object.entries<any>(h.set)) args.push("-ma", `(${tag.slice(0, 4)},${tag.slice(4)})=${value}`);
  await runTool([...args, file]);
  // Nested specimen labels, which not every instance carries.
  for (const path of ["(0040,0560)[*].(0040,0551)", "(0040,0560)[*].(0040,0555)[*].(0040,A160)", "(0040,0560)[*].(0040,0610)[*].(0040,0612)[*].(0040,A160)", "(0008,2112)[*].(0040,A160)"]) {
    await runTool(["dcmodify", "-nb", "-imt", "-m", `${path}=EXSL2023-A1`, file]).catch(() => {});
  }
  for (const tag of [...h.remove, ...(def.removeTags?.tags ?? []), "00091001"]) {
    await runTool(["dcmodify", "-nb", "-imt", "-ie", "-ea", `(${tag.slice(0, 4)},${tag.slice(4)})`, file]).catch(() => {});
  }
}

const inputs: StudyInput[] = [];
for (const study of def.studies) {
  const files: string[] = [];
  if (study.archives) for (const a of study.archives) files.push(...await walk(join(root, "data/sources/unpacked", a.replace(/\.tgz$/, ""))));
  else for (const f of study.files) files.push(join(root, "data/sources/raw", f));
  inputs.push({
    id: study.id, title: study.report?.title ?? study.id, site: study.site, files,
    rewrite: study.files ? file => rewriteSlide(file, study) : undefined,
    jpegLosslessVariant: VARIANT_STUDIES.has(study.id),
    privateSyntaxFixture: study.id === PRIVATE_FIXTURE_STUDY,
  });
}

const store = fileStore(CONFIG.archive.dir);
const run = await ingestStudies(store, inputs, {
  workRoot: process.env.INGEST_WORK,
  log: r => console.log(`${r.id}: ${r.status}${r.version ? ` v${r.version}` : ""}, ${r.instances} instances${r.quarantined ? `, ${r.quarantined} quarantined` : ""}${r.uid ? `, ${r.uid}` : ""}`),
});

const total = run.results.reduce((n, r) => n + r.instances, 0);
console.log(`studies ${run.results.length}, instances ${total}, content writes ${run.contentWrites}, document writes ${run.documentWrites}`);
for (const w of run.warnings) console.warn(`warning: ${w.study} ${w.sop}: ${w.reason}`);
if (run.quarantine.length) {
  console.warn(`quarantined ${run.quarantine.length}, listed in ${join(CONFIG.archive.dir, QUARANTINE_REPORT_KEY)}:`);
  for (const q of run.quarantine) console.warn(`  ${q.study} ${q.input} (${q.stage}): ${q.reason}`);
}
