// Builds data/studies (Part 10 files by representation) and data/manifest.json.
// Implicit VR becomes Explicit VR Little Endian, since PS3.18 forbids Implicit in web
// responses. Lossy instances stay as stored. A small study gets a JPEG Lossless variant,
// and one instance gets a synthetic private-syntax label for transfer syntax tests.
import { mkdir, readdir, rm, exists, stat, rename, copyFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { parsePart10, readFileMeta, str, num } from "../src/dicom";
import { EVRLE, JPEG_LOSSLESS, PRIVATE_DEMO } from "../src/syntax";

const root = join(import.meta.dir, "..");
const def = await Bun.file(join(root, "data/studies.source.json")).json();
const outDir = process.env.STUDIES_DIR ?? join(root, "data/studies");
const work = process.env.INGEST_WORK ?? "/tmp/smart-imaging-ingest";
const VARIANT_STUDIES = new Set(["xr-wrist-left-2012"]);

async function run(cmd: string[]) {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const code = await p.exited;
  if (code !== 0) throw new Error(`${cmd[0]} failed (${code}): ${(await new Response(p.stderr).text()).slice(0, 400)}`);
}
async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p));
    else if (e.isFile() && e.name.endsWith(".dcm")) out.push(p);
  }
  return out;
}

await rm(outDir, { recursive: true, force: true });
await rm(work, { recursive: true, force: true });
await mkdir(work, { recursive: true });
const manifest: any = { studies: [] };

async function rewriteSlide(file: string, study: any, patient: any) {
  const h = study.header;
  const args = ["dcmodify", "-nb", "-imt", "-ma", `(0010,0010)=${patient.dicomName}`, "-ma", `(0010,0020)=${patient.mrn}`, "-ma", `(0010,0030)=${patient.birthDate.replaceAll("-", "")}`, "-ma", `(0010,0040)=M`, "-ma", `(0008,0020)=${study.studyDate.replaceAll("-", "")}`, "-ma", `(0008,0030)=${study.studyTime.replaceAll(":", "")}`, "-ma", `(0008,0050)=${study.accession}`];
  for (const [tag, [, value]] of Object.entries<any>(h.set)) args.push("-ma", `(${tag.slice(0, 4)},${tag.slice(4)})=${value}`);
  await run([...args, file]);
  // Nested specimen labels, which not every instance carries.
  for (const path of ["(0040,0560)[*].(0040,0551)", "(0040,0560)[*].(0040,0555)[*].(0040,A160)", "(0040,0560)[*].(0040,0610)[*].(0040,0612)[*].(0040,A160)", "(0008,2112)[*].(0040,A160)"]) {
    await run(["dcmodify", "-nb", "-imt", "-m", `${path}=EXSL2023-A1`, file]).catch(() => {});
  }
  for (const tag of [...h.remove, ...(def.removeTags?.tags ?? []), "00091001"]) {
    await run(["dcmodify", "-nb", "-imt", "-ie", "-ea", `(${tag.slice(0, 4)},${tag.slice(4)})`, file]).catch(() => {});
  }
}

const patient = await Bun.file(join(root, "data/patient.json")).json();
const dose = (d: string) => /dose/i.test(d);

for (const study of def.studies) {
  const inputs: string[] = [];
  if (study.archives) {
    for (const a of study.archives) inputs.push(...await walk(join(root, "data/sources/unpacked", a.replace(/\.tgz$/, ""))));
  } else {
    for (const f of study.files) inputs.push(join(root, "data/sources/raw", f));
  }
  const entry: any = { id: study.id, title: study.report?.title ?? study.id, series: new Map<string, any>() };
  for (const [n, src] of inputs.entries()) {
    const tmp = join(work, `${study.id}-${n}.dcm`);
    await copyFile(src, tmp);
    if (study.files) await rewriteSlide(tmp, study, patient);
    let head = readFileMeta(new Uint8Array(await Bun.file(tmp).slice(0, 4096).arrayBuffer()));
    if (!head) throw new Error(`no File Meta: ${src}`);
    if (head.transferSyntax === "1.2.840.10008.1.2" || head.transferSyntax === "1.2.840.10008.1.2.2") {
      await run(["dcmconv", "+te", tmp, tmp + ".e"]);
      await rename(tmp + ".e", tmp);
    }
    const bytes = new Uint8Array(await Bun.file(tmp).arrayBuffer());
    const p = parsePart10(bytes);
    const studyUid = str(p.dataset, "0020000D")!, seriesUid = str(p.dataset, "0020000E")!, sop = str(p.dataset, "00080018")!;
    entry.uid = studyUid;
    entry.accession = str(p.dataset, "00080050");
    entry.date = str(p.dataset, "00080020");
    entry.time = str(p.dataset, "00080030");
    entry.description = str(p.dataset, "00081030") ?? entry.title;
    entry.patientId = str(p.dataset, "00100020");
    entry.patientName = str(p.dataset, "00100010");
    const dest = join(outDir, studyUid, seriesUid, `${sop}.dcm`);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(tmp, dest);
    await rm(tmp);
    let s = entry.series.get(seriesUid);
    if (!s) {
      s = { uid: seriesUid, number: num(p.dataset, "00200011") ?? 0, modality: str(p.dataset, "00080060") ?? "OT", description: str(p.dataset, "0008103E") ?? "", bodyPart: str(p.dataset, "00180015"), instances: [] };
      entry.series.set(seriesUid, s);
    }
    const inst: any = { uid: sop, number: num(p.dataset, "00200013") ?? 0, sopClass: p.sopClass, size: bytes.length, representations: [{ syntax: p.transferSyntax, stored: true, key: `${studyUid}/${seriesUid}/${sop}.dcm`, size: bytes.length }], bulk: p.bulk };
    if (VARIANT_STUDIES.has(study.id) && p.transferSyntax === EVRLE) {
      const v = join(outDir, studyUid, seriesUid, `${sop}.${JPEG_LOSSLESS}.dcm`);
      await run(["dcmcjpeg", "+e1", dest, v]);
      const size = (await stat(v)).size;
      inst.representations.push({ syntax: JPEG_LOSSLESS, stored: false, key: `${studyUid}/${seriesUid}/${sop}.${JPEG_LOSSLESS}.dcm`, size });
    }
    s.instances.push(inst);
    await Bun.write(join(outDir, studyUid, seriesUid, `${sop}.json`), JSON.stringify(p.dataset));
  }
  entry.series = [...entry.series.values()].sort((a: any, b: any) => a.number - b.number);
  for (const s of entry.series) s.instances.sort((a: any, b: any) => a.number - b.number);
  manifest.studies.push(entry);
  console.log(`${study.id}: ${entry.series.length} series, ${inputs.length} instances, ${entry.uid}`);
}

// Synthetic fixture: the XR wrist's first instance, with a private transfer syntax label.
{
  const wrist = manifest.studies.find((s: any) => s.id === "xr-wrist-left-2012");
  const inst = wrist.series[0].instances[0];
  const src = join(outDir, inst.representations[0].key);
  const b = new Uint8Array(await Bun.file(src).arrayBuffer());
  const m = readFileMeta(b)!;
  const pad = (s: string) => (s.length % 2 ? s + "\0" : s);
  const uid = new TextEncoder().encode(pad(PRIVATE_DEMO));
  let at = -1;
  for (let i = 132; i < m.datasetOffset; ) {
    const dv = new DataView(b.buffer, b.byteOffset + i);
    const e = dv.getUint16(2, true), vr = String.fromCharCode(b[i + 4]!, b[i + 5]!);
    const long = ["OB", "UN"].includes(vr);
    const len = long ? dv.getUint32(8, true) : dv.getUint16(6, true);
    const head = long ? 12 : 8;
    if (e === 0x0010) { at = i; 
      const out = new Uint8Array(b.length - len + uid.length);
      out.set(b.subarray(0, i + 6));
      new DataView(out.buffer).setUint16(i + 6, uid.length, true);
      out.set(uid, i + 8);
      out.set(b.subarray(i + head + len), i + 8 + uid.length);
      // File Meta group length is at offset 140.
      const dvo = new DataView(out.buffer);
      dvo.setUint32(140, dvo.getUint32(140, true) + uid.length - len, true);
      const key = inst.representations[0].key.replace(/\.dcm$/, `.private.dcm`);
      await Bun.write(join(outDir, key), out);
      inst.representations.unshift({ syntax: PRIVATE_DEMO, stored: true, private: true, key, size: out.length });
      inst.representations[1].stored = false;
      break;
    }
    i += head + len;
  }
  if (at < 0) throw new Error("no transfer syntax element");
}

await Bun.write(join(root, "data/manifest.json"), JSON.stringify(manifest, null, 1));
await rm(work, { recursive: true, force: true });
const total = manifest.studies.reduce((n: number, s: any) => n + s.series.reduce((m: number, x: any) => m + x.instances.length, 0), 0);
console.log("studies", manifest.studies.length, "instances", total);
