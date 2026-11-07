// Re-runnable ingest into the archive format, for any object store.
//
//   parse and validate > normalize > compress > upload content > upload indexes and metadata > current.json
//
// `current.json` is written last, and that write is the publish: until then readers see the old
// version. Content is addressed by the hash of its PS3.10 bytes, so a re-run writes nothing new,
// and a study whose documents come out the same keeps its version.
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { parsePart10, readFileMeta, str, num, type DicomJson } from "../dicom";
import { EVRLE, JPEG_LOSSLESS, PRIVATE_TEST_SYNTAX, isLossy, isStandard } from "../syntax";
import { ArchiveReader } from "./reader";
import { ObjectNotFoundError, type ObjectStore } from "./sources";
import { ARCHIVE_FORMAT, archiveKeys, type InstanceRecord, type Offer, type SeriesIndex, type SeriesMetadata, type StudyDocument } from "./types";
import { encodeJson, wrapperPaysOff, zstdCompress, zstdDecompressSync } from "./zstd";

export const QUARANTINE_REPORT_KEY = "reports/quarantine.json";

/** One study to ingest. Files are read in sorted order, so a run doesn't depend on directory order. */
export interface StudyInput {
  id: string;
  title?: string;
  site?: string;
  /** Labels on the record, which go into its study document. */
  labels?: string[];
  files: string[];
  /** Changes a working copy of each file before anything reads it. */
  rewrite?: (file: string) => Promise<void>;
  /** Adds a JPEG Lossless offer to each Explicit VR instance. */
  jpegLosslessVariant?: boolean;
  /** Gives the first instance a synthetic private transfer syntax, as its stored form. */
  privateSyntaxFixture?: boolean;
}

export interface QuarantineItem { study: string; input: string; stage: string; reason: string; }
export interface IngestWarning { study: string; sop: string; reason: string; }

/**
 * - `published`: this version is now live.
 * - `unchanged`: documents match the live version, so nothing was written.
 * - `held`: inputs were quarantined and a version is already live. It stays live, so a bad file
 *   can't silently remove images from a study.
 * - `empty`: nothing valid to publish, and any live version stays.
 */
export interface StudyResult { id: string; uid?: string; status: "published" | "unchanged" | "held" | "empty"; version?: number; instances: number; quarantined: number; }
export interface IngestRun { results: StudyResult[]; quarantine: QuarantineItem[]; warnings: IngestWarning[]; contentWrites: number; documentWrites: number; }

export async function runTool(cmd: string[]) {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const code = await p.exited;
  if (code !== 0) throw new Error(`${cmd[0]} failed (${code}): ${(await new Response(p.stderr).text()).slice(0, 400)}`);
}

const UID = /^[0-9]+(\.[0-9]+)*$/;
const validUid = (u: string | undefined): u is string => !!u && u.length <= 64 && UID.test(u);
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
/** Implicit VR and big endian are barred from web services, and deflated isn't readable in place. */
const NEEDS_EXPLICIT = new Set(["1.2.840.10008.1.2", "1.2.840.10008.1.2.2", "1.2.840.10008.1.2.1.99"]);

/** Thrown for a problem with one input, which quarantines that input. Store failures aren't caught. */
class InputRejected extends Error { constructor(public stage: string, reason: string) { super(reason); } }

async function putContent(store: ObjectStore, run: IngestRun, bytes: Uint8Array, offer: Pick<Offer, "syntax" | "stored" | "private">): Promise<Offer> {
  const hash = sha256(bytes);
  const made = (encoding: Offer["encoding"], objectBytes: number): Offer => ({ ...offer, key: archiveKeys.content(hash, encoding), encoding, objectBytes, storedBytes: bytes.length, sha256: hash });
  // What's already stored decides, so a change of zstd version can't move a key or start a new version.
  const wrapped = await store.size(archiveKeys.content(hash, "zstd"));
  if (wrapped !== undefined) return made("zstd", wrapped);
  if (await store.size(archiveKeys.content(hash, "none")) === bytes.length) return made("none", bytes.length);
  const compressed = zstdCompress(bytes);
  run.contentWrites++;
  if (!wrapperPaysOff(bytes.length, compressed.length)) {
    await store.write(archiveKeys.content(hash, "none"), bytes);
    return made("none", bytes.length);
  }
  // Passthrough serves these bytes without decoding them, so this is where they're proven to decode.
  if (sha256(zstdDecompressSync(compressed)) !== hash) throw new Error(`zstd round trip failed for ${hash}`);
  await store.write(archiveKeys.content(hash, "zstd"), compressed);
  return made("zstd", compressed.length);
}

async function storedBytes(store: ObjectStore, offer: Offer): Promise<Uint8Array> {
  const raw = await store.bytes(offer.key);
  return offer.encoding === "zstd" ? zstdDecompressSync(raw) : raw;
}

/** The same file with a different Transfer Syntax UID in File Meta. The dataset isn't touched. */
export function withPrivateSyntax(b: Uint8Array, syntax = PRIVATE_TEST_SYNTAX): Uint8Array {
  const m = readFileMeta(b);
  if (!m) throw new Error("no File Meta");
  const uid = new TextEncoder().encode(syntax.length % 2 ? syntax + "\0" : syntax);
  for (let i = 132; i < m.datasetOffset; ) {
    const dv = new DataView(b.buffer, b.byteOffset + i);
    const e = dv.getUint16(2, true), vr = String.fromCharCode(b[i + 4]!, b[i + 5]!);
    const long = ["OB", "UN"].includes(vr);
    const len = long ? dv.getUint32(8, true) : dv.getUint16(6, true);
    const head = long ? 12 : 8;
    if (e === 0x0010) {
      const out = new Uint8Array(b.length - len + uid.length);
      out.set(b.subarray(0, i + 6));
      const dvo = new DataView(out.buffer);
      dvo.setUint16(i + 6, uid.length, true);
      out.set(uid, i + 8);
      out.set(b.subarray(i + head + len), i + 8 + uid.length);
      // File Meta group length is at offset 140.
      dvo.setUint32(140, dvo.getUint32(140, true) + uid.length - len, true);
      return out;
    }
    i += head + len;
  }
  throw new Error("no transfer syntax element");
}

interface SeriesBuild { uid: string; number: number; modality: string; description: string; bodyPart?: string; instances: InstanceRecord[]; metadata: Map<string, DicomJson>; }

/** Normalizes, parses and validates one input. Rejects it, with a stage and reason, if anything is wrong. */
async function prepare(input: string, n: number, study: StudyInput, work: string) {
  let stage = "read";
  const fail = (e: unknown) => new InputRejected(stage, e instanceof Error ? e.message : String(e));
  const scratch = join(work, `${n}.dcm`), converted = `${scratch}.e`;
  try {
    let path = input;
    if (study.rewrite) {
      stage = "rewrite";
      await copyFile(input, scratch);
      await study.rewrite(scratch);
      path = scratch;
    }
    stage = "read";
    const head = readFileMeta(new Uint8Array(await Bun.file(path).slice(0, 4096).arrayBuffer()));
    if (!head) throw new Error("no File Meta");
    const sourceSyntax = head.transferSyntax;
    if (NEEDS_EXPLICIT.has(sourceSyntax)) {
      stage = "normalize";
      await runTool(["dcmconv", "+te", path, converted]);
      path = converted;
    }
    stage = "parse";
    const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
    const parsed = parsePart10(bytes);
    stage = "validate";
    const studyUid = str(parsed.dataset, "0020000D"), seriesUid = str(parsed.dataset, "0020000E"), sop = str(parsed.dataset, "00080018");
    if (!validUid(studyUid)) throw new Error(`invalid Study Instance UID: ${studyUid}`);
    if (!validUid(seriesUid)) throw new Error(`invalid Series Instance UID: ${seriesUid}`);
    if (!validUid(sop)) throw new Error(`invalid SOP Instance UID: ${sop}`);
    if (!parsed.sopClass) throw new Error("no SOP Class in File Meta");
    if (!isStandard(parsed.transferSyntax)) throw new Error(`private transfer syntax ${parsed.transferSyntax}, with no decoder to convert it`);
    return { bytes, parsed, path, studyUid, seriesUid, sop, sourceSyntax };
  } catch (e) { await rm(converted, { force: true }); await rm(scratch, { force: true }); throw fail(e); }
}

async function liveDocuments(reader: ArchiveReader, uid: string) {
  try {
    const version = await reader.currentVersion(uid);
    const study = await reader.study(uid, version);
    const series = await Promise.all(study.series.map(async s => ({ index: await reader.seriesIndex(uid, version, s.uid), metadata: await reader.seriesMetadata(uid, version, s.uid) })));
    return { version, study, series };
  } catch (e) { if (e instanceof ObjectNotFoundError) return undefined; throw e; }
}

async function ingestStudy(store: ObjectStore, input: StudyInput, work: string, run: IngestRun): Promise<StudyResult> {
  const quarantine = (name: string, stage: string, reason: string) => { run.quarantine.push({ study: input.id, input: name, stage, reason }); quarantined++; };
  const label = (file: string) => `${basename(dirname(file))}/${basename(file)}`;
  const series = new Map<string, SeriesBuild>();
  const seen = new Set<string>();
  let quarantined = 0, uid: string | undefined;
  let attrs: Partial<StudyDocument> = {};

  for (const [n, file] of [...input.files].sort().entries()) {
    let p: Awaited<ReturnType<typeof prepare>>;
    try { p = await prepare(file, n, input, work); } catch (e) {
      if (e instanceof InputRejected) { quarantine(label(file), e.stage, e.message); continue; }
      throw e;
    }
    const scratch = join(work, `${n}.dcm`), variantPath = join(work, `${n}.variant.dcm`);
    try {
      uid ??= p.studyUid;
      if (p.studyUid !== uid) { quarantine(label(file), "validate", `belongs to study ${p.studyUid}, and this study is ${uid}`); continue; }
      if (seen.has(p.sop)) { quarantine(label(file), "validate", `repeats SOP Instance ${p.sop}`); continue; }
      seen.add(p.sop);
      const d = p.parsed.dataset;
      attrs = { accession: str(d, "00080050"), date: str(d, "00080020"), time: str(d, "00080030"), description: str(d, "00081030") ?? input.title ?? input.id, sourcePatientId: str(d, "00100020"), sourcePatientIssuer: str(d, "00100021") };
      if (isLossy(p.parsed.transferSyntax) && str(d, "00282110") !== "01") run.warnings.push({ study: input.id, sop: p.sop, reason: "lossy transfer syntax without Lossy Image Compression (0028,2110) = 01" });
      let s = series.get(p.seriesUid);
      if (!s) {
        s = { uid: p.seriesUid, number: num(d, "00200011") ?? 0, modality: str(d, "00080060") ?? "OT", description: str(d, "0008103E") ?? "", bodyPart: str(d, "00180015"), instances: [], metadata: new Map() };
        series.set(p.seriesUid, s);
      }
      const offers = [await putContent(store, run, p.bytes, { syntax: p.parsed.transferSyntax, stored: true })];
      if (input.jpegLosslessVariant && p.parsed.transferSyntax === EVRLE) {
        try {
          await runTool(["dcmcjpeg", "+e1", p.path, variantPath]);
          offers.push(await putContent(store, run, await Bun.file(variantPath).bytes(), { syntax: JPEG_LOSSLESS, stored: false }));
        } catch (e) {
          if (e instanceof Error && e.message.startsWith("dcmcjpeg")) run.warnings.push({ study: input.id, sop: p.sop, reason: `no JPEG Lossless variant: ${e.message}` });
          else throw e;
        }
      }
      s.instances.push({ uid: p.sop, number: num(d, "00200013") ?? 0, sopClass: p.parsed.sopClass, bulk: p.parsed.bulk, ...(p.sourceSyntax !== p.parsed.transferSyntax ? { sourceSyntax: p.sourceSyntax } : {}), offers });
      s.metadata.set(p.sop, d);
    } finally {
      await rm(scratch, { force: true }); await rm(`${scratch}.e`, { force: true }); await rm(variantPath, { force: true });
    }
  }

  if (!uid || !series.size) {
    quarantine(input.id, "study", "no valid instances");
    return { id: input.id, uid, status: "empty", instances: 0, quarantined };
  }

  const ordered = [...series.values()].sort((a, b) => a.number - b.number);
  for (const s of ordered) s.instances.sort((a, b) => a.number - b.number);

  if (input.privateSyntaxFixture) {
    const inst = ordered[0]!.instances[0]!, standard = inst.offers[0]!;
    const privateBytes = withPrivateSyntax(await storedBytes(store, standard));
    inst.offers.unshift(await putContent(store, run, privateBytes, { syntax: PRIVATE_TEST_SYNTAX, stored: true, private: true }));
    standard.stored = false;
    // Bulk offsets refer to the stored form, which is now this one.
    inst.bulk = parsePart10(privateBytes).bulk;
  }

  const instances = ordered.reduce((n, s) => n + s.instances.length, 0);
  const documents = (version: number) => ({
    study: {
      format: ARCHIVE_FORMAT, uid: uid!, id: input.id, version, title: input.title, ...attrs, site: input.site, ...(input.labels?.length ? { labels: input.labels } : {}),
      series: ordered.map(s => ({ uid: s.uid, number: s.number, modality: s.modality, instanceCount: s.instances.length })),
    } satisfies StudyDocument,
    series: ordered.map(s => ({
      index: { format: ARCHIVE_FORMAT, study: uid!, version, uid: s.uid, number: s.number, modality: s.modality, description: s.description, bodyPart: s.bodyPart, instances: s.instances } satisfies SeriesIndex,
      metadata: { format: ARCHIVE_FORMAT, instances: Object.fromEntries(s.metadata) } satisfies SeriesMetadata,
    })),
  });

  const live = await liveDocuments(new ArchiveReader(store, { currentTtlMs: 0, cacheBytes: 0 }), uid);
  if (live) {
    if (quarantined) return { id: input.id, uid, status: "held", version: live.version, instances, quarantined };
    const { study, series: docs } = documents(live.version);
    if (JSON.stringify({ study, series: docs }) === JSON.stringify({ study: live.study, series: live.series })) return { id: input.id, uid, status: "unchanged", version: live.version, instances, quarantined };
  }

  // A failed earlier attempt may have left unpublished objects at this version. Nothing refers to them, so they can be replaced.
  const version = (live?.version ?? 0) + 1;
  const docs = documents(version);
  for (const s of docs.series) {
    await store.write(archiveKeys.seriesIndex(uid, version, s.index.uid), encodeJson(s.index));
    await store.write(archiveKeys.seriesMetadata(uid, version, s.index.uid), encodeJson(s.metadata));
    run.documentWrites += 2;
  }
  await store.write(archiveKeys.study(uid, version), encodeJson(docs.study));
  run.documentWrites++;
  await store.write(archiveKeys.current(uid), JSON.stringify({ version }));
  run.documentWrites++;
  return { id: input.id, uid, status: "published", version, instances, quarantined };
}

/** Bad inputs go to the report and other work carries on. A failing store stops the run, with nothing new published for the study in progress. */
export async function ingestStudies(store: ObjectStore, studies: StudyInput[], opts: { workRoot?: string; log?: (r: StudyResult) => void } = {}): Promise<IngestRun> {
  const run: IngestRun = { results: [], quarantine: [], warnings: [], contentWrites: 0, documentWrites: 0 };
  const root = opts.workRoot ?? tmpdir();
  await mkdir(root, { recursive: true });
  const work = await mkdtemp(join(root, "smart-imaging-ingest-"));
  try {
    for (const study of studies) {
      const result = await ingestStudy(store, study, work, run);
      run.results.push(result);
      opts.log?.(result);
    }
  } finally { await rm(work, { recursive: true, force: true }); }

  const report = JSON.stringify({ format: ARCHIVE_FORMAT, quarantine: run.quarantine, warnings: run.warnings }, null, 1);
  const previous = await store.text(QUARANTINE_REPORT_KEY).catch(e => { if (e instanceof ObjectNotFoundError) return undefined; throw e; });
  if (previous !== report) { await store.write(QUARANTINE_REPORT_KEY, new TextEncoder().encode(report)); run.documentWrites++; }
  return run;
}
