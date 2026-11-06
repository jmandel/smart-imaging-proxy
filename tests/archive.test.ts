// The archive format, ingest, and the backend over it. Small studies are built here, so these
// tests say exactly what each file holds. The last block checks the real archive and MinIO.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { S3Client } from "bun";
import { ingestStudies, QUARANTINE_REPORT_KEY, runTool, withPrivateSyntax, type StudyInput } from "../src/archive/ingest";
import { ByteLru } from "../src/archive/lru";
import { ArchiveReader } from "../src/archive/reader";
import { fileStore, ObjectNotFoundError, s3Store, type ObjectStore } from "../src/archive/sources";
import { ARCHIVE_FORMAT, archiveKeys, type ObjectSource, type Offer, type SeriesIndex, type StudyDocument } from "../src/archive/types";
import { decodeJson, wrapperPaysOff, zstdCompress, zstdDecode, zstdDecompressSync } from "../src/archive/zstd";
import { ArchiveBackend, chooseOffer } from "../src/backends/archive";
import { withTruncation } from "../src/backends/truncation";
import { BackendError, type Backend, type PartStream } from "../src/backends/types";
import { CONFIG } from "../src/config";
import { parsePart10, readFileMeta } from "../src/dicom";
import { closing, newBoundary, partFooter, partHeader, readMultipart } from "../src/multipart";
import { EVRLE, isStandard, JPEG_BASELINE, JPEG_LOSSLESS, PRIVATE_DEMO } from "../src/syntax";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const ANY = [{ syntax: "*", q: 1 }];
const enc = new TextEncoder();
const concat = (parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts));
async function collect(src: AsyncIterable<Uint8Array>) { const out: Uint8Array[] = []; for await (const c of src) out.push(c); return concat(out); }

// ---------- A small PS3.10 writer ----------

function explicit(group: number, element: number, vr: string, value: Uint8Array): Uint8Array {
  const pad = value.length % 2 ? concat([value, new Uint8Array([vr === "UI" ? 0 : 32])]) : value;
  const long = ["OB", "OW", "UN"].includes(vr);
  const head = new Uint8Array(long ? 12 : 8);
  const dv = new DataView(head.buffer);
  dv.setUint16(0, group, true); dv.setUint16(2, element, true);
  head[4] = vr.charCodeAt(0); head[5] = vr.charCodeAt(1);
  if (long) dv.setUint32(8, pad.length, true); else dv.setUint16(6, pad.length, true);
  return concat([head, pad]);
}
const text = (g: number, e: number, vr: string, s: string) => explicit(g, e, vr, enc.encode(s));
const us = (g: number, e: number, v: number) => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, true); return explicit(g, e, "US", b); };

interface Fixture {
  study: string; series: string; sop: string; number?: number; seriesNumber?: number; modality?: string; patientId?: string; syntax?: string;
  /** 16-bit native pixels, in a square image. */
  pixels?: Uint8Array;
  /** One encapsulated fragment, instead of native pixels. */
  fragment?: Uint8Array;
  /** An element that sits before pixel data, for bulk reads. */
  document?: Uint8Array;
  omitSop?: boolean;
}

function part10(f: Fixture): Uint8Array {
  const sopClass = "1.2.840.10008.5.1.4.1.1.1", syntax = f.syntax ?? EVRLE;
  const metaBody = concat([explicit(2, 1, "OB", new Uint8Array([0, 1])), text(2, 2, "UI", sopClass), text(2, 3, "UI", f.sop), text(2, 0x10, "UI", syntax), text(2, 0x12, "UI", "1.2.3.4.5")]);
  const groupLength = new Uint8Array(4); new DataView(groupLength.buffer).setUint32(0, metaBody.length, true);
  const elements: Uint8Array[] = [
    new Uint8Array(128), enc.encode("DICM"), explicit(2, 0, "UL", groupLength), metaBody,
    text(8, 0x16, "UI", sopClass),
    ...(f.omitSop ? [] : [text(8, 0x18, "UI", f.sop)]),
    text(8, 0x20, "DA", "20200102"), text(8, 0x30, "TM", "030405"), text(8, 0x50, "SH", "ACC1"), text(8, 0x60, "CS", f.modality ?? "CR"), text(8, 0x1030, "LO", "A test study"),
    text(0x10, 0x10, "PN", "Doe^Pat"), text(0x10, 0x20, "LO", f.patientId ?? "PID-1"),
    text(0x20, 0x0d, "UI", f.study), text(0x20, 0x0e, "UI", f.series), text(0x20, 0x11, "IS", String(f.seriesNumber ?? 1)), text(0x20, 0x13, "IS", String(f.number ?? 1)),
  ];
  const side = f.pixels ? Math.sqrt(f.pixels.length / 2) : 8;
  elements.push(us(0x28, 2, 1), text(0x28, 4, "CS", "MONOCHROME2"), us(0x28, 0x10, side), us(0x28, 0x11, side), us(0x28, 0x100, 16), us(0x28, 0x101, 16), us(0x28, 0x102, 15), us(0x28, 0x103, 0));
  if (f.fragment) elements.push(text(0x28, 0x2110, "CS", "01"));
  if (f.document) elements.push(explicit(0x42, 0x11, "OB", f.document));
  if (f.pixels) elements.push(explicit(0x7fe0, 0x10, "OW", f.pixels));
  if (f.fragment) {
    const item = (len: number) => { const b = new Uint8Array(8); const dv = new DataView(b.buffer); dv.setUint16(0, 0xfffe, true); dv.setUint16(2, 0xe000, true); dv.setUint32(4, len, true); return b; };
    const head = explicit(0x7fe0, 0x10, "OB", new Uint8Array(0));
    new DataView(head.buffer).setUint32(8, 0xffffffff, true);
    const end = new Uint8Array(8); const dv = new DataView(end.buffer); dv.setUint16(0, 0xfffe, true); dv.setUint16(2, 0xe0dd, true);
    const frag = f.fragment.length % 2 ? concat([f.fragment, new Uint8Array(1)]) : f.fragment;
    elements.push(head, item(0), item(frag.length), frag, end);
  }
  return concat(elements);
}

/** Pixels that compress well, and differ by seed. */
const smooth = (side: number, seed = 0) => { const b = new Uint8Array(side * side * 2); for (let i = 0; i < b.length; i += 2) { b[i] = ((i >> 4) + seed) & 255; b[i + 1] = 2; } return b; };
const noise = (n: number) => new Uint8Array(randomBytes(n));
/** About half entropy: decodes to much more than it stores, without being trivially small. */
const halfNoise = (n: number) => { const b = noise(n); for (let i = 0; i < n; i++) b[i]! &= 0x0f; return b; };

// ---------- Stores that record what happens ----------

function recording(inner: ObjectStore, failOn?: (key: string) => boolean) {
  const writes: string[] = [];
  const store: ObjectStore = { ...inner, write: async (k, d) => { if (failOn?.(k)) throw new Error(`injected store failure on ${k}`); writes.push(k); await inner.write(k, d); } };
  return { store, writes };
}

function counting(inner: ObjectSource) {
  const c = { reads: [] as string[], ranges: [] as string[], documents: [] as string[], pulled: 0, closed: 0 };
  const track = async function* (src: AsyncIterable<Uint8Array>) {
    try { for await (const chunk of src) { c.pulled += chunk.length; yield chunk; } } finally { c.closed++; }
  };
  const source: ObjectSource = {
    name: inner.name,
    read: k => { c.reads.push(k); return track(inner.read(k)); },
    readRange: (k, s, l) => { c.ranges.push(k); return track(inner.readRange(k, s, l)); },
    bytes: k => { c.documents.push(k); return inner.bytes(k); },
    text: k => { c.documents.push(k); return inner.text(k); },
    list: p => inner.list(p),
  };
  return { source, c };
}

async function drain(stream: PartStream) {
  const parts: { sop?: string; syntax?: string; encoding?: string; bytes?: number; body: Uint8Array }[] = [];
  while (true) {
    const r = await stream.parts.next();
    if (r.done) return { parts, end: r.value };
    parts.push({ sop: r.value.sop, syntax: r.value.syntax, encoding: r.value.encoding, bytes: r.value.bytes, body: await collect(r.value.body) });
  }
}

async function kindOf(work: () => Promise<unknown>) {
  try { await work(); return "ok"; } catch (e) { return e instanceof BackendError ? e.kind : `threw ${e}`; }
}

// ---------- Shared files ----------

let root: string;
const STUDY = "1.2.3.100", S1 = "1.2.3.100.1", S2 = "1.2.3.100.2", S3 = "1.2.3.100.3";
const VSTUDY = "1.2.3.200", VSERIES = "1.2.3.200.1";
let inputs: Record<string, string> = {};
const fresh = async () => fileStore(await mkdtemp(join(root, "store-")));
const dirOf = async () => { const dir = await mkdtemp(join(root, "store-")); return { dir, store: fileStore(dir) }; };

const study = (files: string[], extra: Partial<StudyInput> = {}): StudyInput => ({ id: "test-study", title: "Test study", site: "Test Site", files, ...extra });
const mainInputs = () => ["a1", "a2", "b1", "lossy"].map(n => inputs[n]!);
const variantStudy = () => study([inputs.v1!, inputs.v2!], { id: "variant-study", jpegLosslessVariant: true, privateSyntaxFixture: true });
const put = async (name: string, f: Fixture) => { const p = join(root, "in", `${name}.dcm`); await Bun.write(p, part10(f)); inputs[name] = p; return p; };

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "archive-test-"));
  await mkdir(join(root, "in"), { recursive: true });
  await put("a1", { study: STUDY, series: S1, sop: "1.2.3.100.1.1", number: 1, seriesNumber: 1, pixels: smooth(64) });
  await put("a2", { study: STUDY, series: S1, sop: "1.2.3.100.1.2", number: 2, seriesNumber: 1, pixels: smooth(64, 9) });
  await put("b1", { study: STUDY, series: S2, sop: "1.2.3.100.2.1", number: 1, seriesNumber: 2, modality: "DX", pixels: noise(128 * 128 * 2) });
  await put("lossy", { study: STUDY, series: S3, sop: "1.2.3.100.3.1", number: 1, seriesNumber: 3, modality: "SM", syntax: JPEG_BASELINE, fragment: noise(40000) });
  await put("v1", { study: VSTUDY, series: VSERIES, sop: "1.2.3.200.1.1", number: 1, pixels: smooth(64, 3) });
  await put("v2", { study: VSTUDY, series: VSERIES, sop: "1.2.3.200.1.2", number: 2, pixels: smooth(64, 4) });
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

// ---------- Tests ----------

describe("Format", () => {
  test("ingest writes the documented layout, and every document says what it is", async () => {
    const store = await fresh();
    const run = await ingestStudies(store, [study(mainInputs())]);
    expect(run.results[0]).toMatchObject({ uid: STUDY, status: "published", version: 1, instances: 4 });
    const keys: string[] = [];
    for await (const k of store.list("studies/")) keys.push(k);
    expect(keys).toEqual([
      `studies/${STUDY}/current.json`,
      `studies/${STUDY}/v1/series/${S1}/index.json.zst`, `studies/${STUDY}/v1/series/${S1}/metadata.json.zst`,
      `studies/${STUDY}/v1/series/${S2}/index.json.zst`, `studies/${STUDY}/v1/series/${S2}/metadata.json.zst`,
      `studies/${STUDY}/v1/series/${S3}/index.json.zst`, `studies/${STUDY}/v1/series/${S3}/metadata.json.zst`,
      `studies/${STUDY}/v1/study.json.zst`,
    ]);
    expect(JSON.parse(await store.text(archiveKeys.current(STUDY)))).toEqual({ version: 1 });
    const doc = await decodeJson<StudyDocument>(await store.bytes(archiveKeys.study(STUDY, 1)));
    expect(doc).toMatchObject({ format: ARCHIVE_FORMAT, uid: STUDY, id: "test-study", version: 1, title: "Test study", site: "Test Site", sourcePatientId: "PID-1", accession: "ACC1", date: "20200102", time: "030405", description: "A test study" });
    expect(doc.series).toEqual([{ uid: S1, number: 1, modality: "CR", instanceCount: 2 }, { uid: S2, number: 2, modality: "DX", instanceCount: 1 }, { uid: S3, number: 3, modality: "SM", instanceCount: 1 }]);
  });

  test("content is named by the SHA-256 of the PS3.10 bytes, whatever its encoding", async () => {
    const store = await fresh();
    await ingestStudies(store, [study(mainInputs())]);
    const index = await decodeJson<SeriesIndex>(await store.bytes(archiveKeys.seriesIndex(STUDY, 1, S1)));
    const original = await Bun.file(inputs.a1!).bytes();
    const offer = index.instances[0]!.offers[0]!;
    expect(offer).toMatchObject({ syntax: EVRLE, stored: true, encoding: "zstd", key: `content/${sha(original)}.dcm.zst`, sha256: sha(original), storedBytes: original.length });
    const object = await store.bytes(offer.key);
    expect(object.length).toBe(offer.objectBytes);
    expect(sha(zstdDecompressSync(object))).toBe(sha(original));
  });

  test("bulk offsets point into the decoded PS3.10 bytes, and metadata documents link to them", async () => {
    const store = await fresh();
    await ingestStudies(store, [study(mainInputs())]);
    const backend = new ArchiveBackend(store);
    const original = await Bun.file(inputs.a1!).bytes();
    const pixels = smooth(64);
    const index = await decodeJson<SeriesIndex>(await store.bytes(archiveKeys.seriesIndex(STUDY, 1, S1)));
    const el = index.instances[0]!.bulk!["7FE00010"]!;
    expect(sha(original.subarray(el.offset, el.offset + el.length))).toBe(sha(pixels));
    const items = await backend.getMetadata({ study: STUDY, series: S1, instance: "1.2.3.100.1.1" });
    expect(items).toHaveLength(1);
    expect(items[0]["7FE00010"].BulkDataURI).toBe("bulk:7FE00010");
    expect(items[0].__path).toEqual({ series: S1, instance: "1.2.3.100.1.1" });
    expect(items[0]["00100020"].Value[0]).toBe("PID-1");
  });

  test("each study in the source data carries a site", async () => {
    const def = await Bun.file(join(import.meta.dir, "../data/studies.source.json")).json();
    expect(def.studies.every((s: any) => typeof s.site === "string" && s.site.length > 0)).toBe(true);
  });

  test("Implicit VR and deflated inputs are stored as Explicit VR, recording what they were", async () => {
    const store = await fresh();
    const implicit = join(root, "in", "implicit.dcm"), deflated = join(root, "in", "deflated.dcm");
    const s = "1.2.3.300";
    const a = await put("i", { study: s, series: `${s}.1`, sop: `${s}.1.1`, pixels: smooth(32) });
    const b = await put("d", { study: s, series: `${s}.1`, sop: `${s}.1.2`, number: 2, pixels: smooth(32, 1) });
    await runTool(["dcmconv", "+ti", a, implicit]);
    await runTool(["dcmconv", "+td", b, deflated]);
    expect(readFileMeta(await Bun.file(implicit).bytes())!.transferSyntax).toBe("1.2.840.10008.1.2");
    const run = await ingestStudies(store, [study([implicit, deflated])]);
    expect(run.quarantine).toEqual([]);
    const index = await new ArchiveReader(store).seriesIndex(s, 1, `${s}.1`);
    expect(index.instances.map(i => i.sourceSyntax)).toEqual(["1.2.840.10008.1.2", "1.2.840.10008.1.2.1.99"]);
    for (const i of index.instances) expect(i.offers.map(o => o.syntax)).toEqual([EVRLE]);
    const { parts } = await drain(await new ArchiveBackend(store).openInstances({ study: s }, ANY));
    for (const p of parts) expect(readFileMeta(p.body)!.transferSyntax).toBe(EVRLE);
  });
});

describe("Re-running ingest", () => {
  test("unchanged input writes nothing at all", async () => {
    const base = await fresh();
    await ingestStudies(base, [study(mainInputs()), variantStudy()]);
    const { store, writes } = recording(base);
    const run = await ingestStudies(store, [study(mainInputs()), variantStudy()]);
    expect(run.results.map(r => [r.status, r.version])).toEqual([["unchanged", 1], ["unchanged", 1]]);
    expect(writes).toEqual([]);
    expect(run).toMatchObject({ contentWrites: 0, documentWrites: 0 });
  });

  test("the order of input files doesn't matter", async () => {
    const store = await fresh();
    await ingestStudies(store, [study(mainInputs())]);
    const run = await ingestStudies(store, [study([...mainInputs()].reverse())]);
    expect(run.results[0]!.status).toBe("unchanged");
  });

  test("changed input writes version+1, and the old version stays whole and readable", async () => {
    const store = await fresh();
    const a2 = await put("c2", { study: STUDY, series: S1, sop: "1.2.3.100.1.2", number: 2, seriesNumber: 1, pixels: smooth(64, 9) });
    const files = [inputs.a1!, a2];
    await ingestStudies(store, [study(files)]);
    const before = new Map<string, string>();
    for await (const k of store.list("")) if (!k.endsWith("current.json") && !k.startsWith("reports/")) before.set(k, sha(await store.bytes(k)));
    const v1 = await collect((await (await new ArchiveBackend(store).openInstances({ study: STUDY, instance: "1.2.3.100.1.2" }, ANY)).parts.next()).value.body);

    await put("c2", { study: STUDY, series: S1, sop: "1.2.3.100.1.2", number: 2, seriesNumber: 1, pixels: smooth(64, 77) });
    const run = await ingestStudies(store, [study(files)]);
    expect(run.results[0]).toMatchObject({ status: "published", version: 2 });
    expect(JSON.parse(await store.text(archiveKeys.current(STUDY)))).toEqual({ version: 2 });
    for (const [k, h] of before) expect(sha(await store.bytes(k))).toBe(h);

    const backend = new ArchiveBackend(store);
    const scope = { study: STUDY, instance: "1.2.3.100.1.2" };
    const old = await drain(await backend.openInstances({ ...scope, version: 1 }, ANY));
    const cur = await drain(await backend.openInstances(scope, ANY));
    expect(sha(old.parts[0]!.body)).toBe(sha(v1));
    expect(old.end).toBe("complete");
    expect(sha(cur.parts[0]!.body)).toBe(sha(await Bun.file(a2).bytes()));
    expect(sha(cur.parts[0]!.body)).not.toBe(sha(v1));
    // Content shared by both versions is one object.
    const sameInstance = (await new ArchiveReader(store).seriesIndex(STUDY, 2, S1)).instances[0]!.offers[0]!.key;
    expect(before.has(sameInstance)).toBe(true);
  });

  test("current.json is the last write, and a failure before it leaves the old version live", async () => {
    const base = await fresh();
    const a2 = await put("o2", { study: STUDY, series: S1, sop: "1.2.3.100.1.2", number: 2, seriesNumber: 1, pixels: smooth(64, 9) });
    const files = [inputs.a1!, a2];

    const first = recording(base);
    await ingestStudies(first.store, [study(files)]);
    const order = first.writes.filter(k => !k.startsWith("reports/"));
    expect(order.at(-1)).toBe(archiveKeys.current(STUDY));
    expect(order.at(-2)).toBe(archiveKeys.study(STUDY, 1));
    expect(order.findLastIndex(k => k.startsWith("content/"))).toBeLessThan(order.findIndex(k => k.startsWith("studies/")));

    await put("o2", { study: STUDY, series: S1, sop: "1.2.3.100.1.2", number: 2, seriesNumber: 1, pixels: smooth(64, 55) });
    for (const failing of [(k: string) => k.endsWith("metadata.json.zst"), (k: string) => k.endsWith("study.json.zst"), (k: string) => k.endsWith("current.json")]) {
      const { store } = recording(base, failing);
      await expect(ingestStudies(store, [study(files)])).rejects.toThrow("injected store failure");
      expect(JSON.parse(await base.text(archiveKeys.current(STUDY)))).toEqual({ version: 1 });
      const { parts, end } = await drain(await new ArchiveBackend(base).openInstances({ study: STUDY, instance: "1.2.3.100.1.2" }, ANY));
      expect(end).toBe("complete");
      expect(sha(parts[0]!.body)).toBe(sha(part10({ study: STUDY, series: S1, sop: "1.2.3.100.1.2", number: 2, seriesNumber: 1, pixels: smooth(64, 9) })));
    }

    // The retry finishes the job, at the version the failed attempts were writing.
    const retry = await ingestStudies(base, [study(files)]);
    expect(retry.results[0]).toMatchObject({ status: "published", version: 2 });
  });

  test("a failure on a study's first ingest leaves it unpublished", async () => {
    const base = await fresh();
    const { store } = recording(base, k => k.endsWith("current.json"));
    await expect(ingestStudies(store, [study(mainInputs())])).rejects.toThrow("injected store failure");
    expect(await kindOf(() => new ArchiveBackend(base).openInstances({ study: STUDY }, ANY))).toBe("NotFound");
  });

  test("the working directory is removed, including after a failure", async () => {
    const workRoot = await mkdtemp(join(root, "work-"));
    const base = await fresh();
    await ingestStudies(base, [variantStudy()], { workRoot });
    const { store } = recording(await fresh(), () => true);
    await expect(ingestStudies(store, [variantStudy()], { workRoot })).rejects.toThrow();
    expect([...new Bun.Glob("*").scanSync({ cwd: workRoot, onlyFiles: false })]).toEqual([]);
  });
});

describe("Quarantine", () => {
  test("corrupt inputs are reported with a reason, and other instances and studies carry on", async () => {
    const dir = join(root, "corrupt");
    await mkdir(dir, { recursive: true });
    const good = part10({ study: "1.2.3.400", series: "1.2.3.400.1", sop: "1.2.3.400.1.9", pixels: smooth(32) });
    await Bun.write(join(dir, "garbage.dcm"), noise(4096));
    await Bun.write(join(dir, "cut.dcm"), good.subarray(0, good.length - 200));
    await Bun.write(join(dir, "scrambled.dcm"), concat([good.subarray(0, 400), noise(600), good.subarray(1000)]));
    await Bun.write(join(dir, "nosop.dcm"), part10({ study: "1.2.3.400", series: "1.2.3.400.1", sop: "1.2.3.400.1.8", omitSop: true, pixels: smooth(8) }));
    await Bun.write(join(dir, "other.dcm"), part10({ study: "9.9.9", series: "9.9.9.1", sop: "9.9.9.1.1", pixels: smooth(8) }));
    await Bun.write(join(dir, "private.dcm"), part10({ study: "1.2.3.400", series: "1.2.3.400.1", sop: "1.2.3.400.1.7", syntax: PRIVATE_DEMO, pixels: smooth(8) }));
    await Bun.write(join(dir, "ok.dcm"), part10({ study: "1.2.3.400", series: "1.2.3.400.1", sop: "1.2.3.400.1.1", pixels: smooth(32, 1) }));
    const missing = join(dir, "also-missing.dcm");
    const badNames = ["garbage", "cut", "scrambled", "nosop", "does-not-exist"].map(n => join(dir, `${n}.dcm`));

    const { dir: archive, store } = await dirOf();
    const run = await ingestStudies(store, [
      study([...badNames, join(dir, "ok.dcm"), join(dir, "other.dcm"), join(dir, "private.dcm"), missing], { id: "mixed" }),
      study([join(dir, "garbage.dcm")], { id: "all-bad" }),
      study(mainInputs(), { id: "clean" }),
    ]);
    expect(run.results.map(r => [r.id, r.status, r.instances])).toEqual([["mixed", "published", 1], ["all-bad", "empty", 0], ["clean", "published", 4]]);
    const by = Object.fromEntries(run.quarantine.filter(q => q.study === "mixed").map(q => [q.input.split("/").pop(), q]));
    expect(by["garbage.dcm"]!.reason).toContain("no File Meta");
    expect(by["cut.dcm"]!.reason).toContain("runs past the end");
    expect(by["scrambled.dcm"]!.stage).toBe("parse");
    expect(by["nosop.dcm"]!.reason).toContain("SOP Instance UID");
    expect(by["other.dcm"]!.reason).toContain("belongs to study");
    expect(by["private.dcm"]!.reason).toContain("private transfer syntax");
    expect(by["does-not-exist.dcm"]!.stage).toBe("read");
    expect(run.quarantine.find(q => q.study === "all-bad")!.reason).toBeTruthy();

    const report = JSON.parse(await Bun.file(join(archive, QUARANTINE_REPORT_KEY)).text());
    expect(report.quarantine).toEqual(run.quarantine);
    // A quarantined instance isn't released: it isn't in the index or the content store's references.
    const backend = new ArchiveBackend(store);
    expect((await drain(await backend.openInstances({ study: "1.2.3.400" }, ANY))).parts.map(p => p.sop)).toEqual(["1.2.3.400.1.1"]);
    expect(await kindOf(() => backend.listSeries("9.9.9"))).toBe("NotFound");
  });

  test("a study with a live version holds it when a new input is bad", async () => {
    const dir = await mkdtemp(join(root, "held-"));
    await Bun.write(join(dir, "bad.dcm"), noise(1000));
    const store = await fresh();
    await ingestStudies(store, [study(mainInputs())]);
    const run = await ingestStudies(store, [study([...mainInputs().slice(1), join(dir, "bad.dcm")])]);
    expect(run.results[0]).toMatchObject({ status: "held", version: 1, quarantined: 1 });
    expect(JSON.parse(await store.text(archiveKeys.current(STUDY)))).toEqual({ version: 1 });
  });

  test("the report is rewritten only when it changes", async () => {
    const base = await fresh();
    const dir = await mkdtemp(join(root, "report-"));
    await Bun.write(join(dir, "bad.dcm"), noise(1000));
    await ingestStudies(base, [study([join(dir, "bad.dcm")])]);
    const { store, writes } = recording(base);
    await ingestStudies(store, [study([join(dir, "bad.dcm")])]);
    expect(writes).toEqual([]);
  });
});

describe("The 5% rule", () => {
  test("the threshold is exactly 5%", () => {
    expect(wrapperPaysOff(100, 95)).toBe(true);
    expect(wrapperPaysOff(100, 96)).toBe(false);
    expect(wrapperPaysOff(100, 100)).toBe(false);
  });

  test("a lossy instance that won't compress stays byte-for-byte", async () => {
    const store = await fresh();
    await ingestStudies(store, [study(mainInputs())]);
    const index = await new ArchiveReader(store).seriesIndex(STUDY, 1, S3);
    const offer = index.instances[0]!.offers[0]!;
    const original = await Bun.file(inputs.lossy!).bytes();
    expect(offer).toMatchObject({ syntax: JPEG_BASELINE, encoding: "none", objectBytes: original.length, storedBytes: original.length });
    expect(offer.key).toBe(`content/${sha(original)}.dcm`);
    expect(sha(await store.bytes(offer.key))).toBe(sha(original));
  });

  test("a lossy instance gets the wrapper when it saves 5%", async () => {
    const store = await fresh();
    const repeated = new Uint8Array(40000);
    for (let i = 0; i < repeated.length; i++) repeated[i] = i % 7;
    const s = "1.2.3.500";
    const p = await put("lossy2", { study: s, series: `${s}.1`, sop: `${s}.1.1`, syntax: JPEG_BASELINE, fragment: repeated });
    await ingestStudies(store, [study([p])]);
    const offer = (await new ArchiveReader(store).seriesIndex(s, 1, `${s}.1`)).instances[0]!.offers[0]!;
    expect(offer.encoding).toBe("zstd");
    expect(offer.key.endsWith(".dcm.zst")).toBe(true);
    expect(offer.objectBytes).toBeLessThanOrEqual(offer.storedBytes * 0.95);
  });

  test("an instance that won't compress is stored as itself, even with Explicit VR", async () => {
    const store = await fresh();
    await ingestStudies(store, [study(mainInputs())]);
    const offer = (await new ArchiveReader(store).seriesIndex(STUDY, 1, S2)).instances[0]!.offers[0]!;
    expect(offer).toMatchObject({ syntax: EVRLE, encoding: "none" });
  });
});

describe("Offers", () => {
  // chooseRepresentation as it read before offers replaced representations, kept here as the reference.
  function chooseRepresentation(inst: any, plan: { syntax: string }[]): any {
    const reps: any[] = inst.representations;
    for (const item of plan) {
      if (item.syntax === "*") {
        const stored = reps.find(r => r.stored);
        if (stored && isStandard(stored.syntax)) return stored;
        const standard = reps.find(r => isStandard(r.syntax));
        if (standard) return standard;
        continue;
      }
      const match = reps.find(r => r.syntax === item.syntax);
      if (match) return match;
    }
    return undefined;
  }
  const plans = [[{ syntax: "*", q: 1 }], [{ syntax: EVRLE, q: 1 }], [{ syntax: JPEG_LOSSLESS, q: 1 }], [{ syntax: PRIVATE_DEMO, q: 1 }], [{ syntax: JPEG_BASELINE, q: 1 }], [{ syntax: JPEG_BASELINE, q: 1 }, { syntax: EVRLE, q: 0.5 }], [{ syntax: JPEG_LOSSLESS, q: 1 }, { syntax: EVRLE, q: 0.5 }], [{ syntax: PRIVATE_DEMO, q: 1 }, { syntax: "*", q: 0.5 }], [{ syntax: "*", q: 1 }, { syntax: PRIVATE_DEMO, q: 0.5 }], [{ syntax: "1.2.3.4", q: 1 }]];

  test("the private and variant fixtures have the expected offers", async () => {
    const store = await fresh();
    await ingestStudies(store, [variantStudy()]);
    const [first, second] = (await new ArchiveReader(store).seriesIndex(VSTUDY, 1, VSERIES)).instances;
    expect(first!.offers.map(o => [o.syntax, o.stored, !!o.private])).toEqual([[PRIVATE_DEMO, true, true], [EVRLE, false, false], [JPEG_LOSSLESS, false, false]]);
    expect(second!.offers.map(o => [o.syntax, o.stored, !!o.private])).toEqual([[EVRLE, true, false], [JPEG_LOSSLESS, false, false]]);
  });

  test("offers are chosen exactly as chooseRepresentation chose, on every fixture and plan", async () => {
    const store = await fresh();
    await ingestStudies(store, [variantStudy(), study(mainInputs())]);
    const reader = new ArchiveReader(store);
    const lists = [...(await reader.seriesIndex(VSTUDY, 1, VSERIES)).instances, ...(await reader.seriesIndex(STUDY, 1, S3)).instances].map(i => i.offers);
    for (const offers of lists) for (const plan of plans) {
      expect(chooseOffer(offers, plan)?.syntax).toBe(chooseRepresentation({ representations: offers }, plan)?.syntax);
    }
    // The shape that matters: * never returns the private syntax, and naming it does.
    expect(chooseOffer(lists[0]!, ANY)!.syntax).toBe(EVRLE);
    expect(chooseOffer(lists[0]!, [{ syntax: PRIVATE_DEMO, q: 1 }])!.syntax).toBe(PRIVATE_DEMO);
    expect(chooseOffer(lists[2]!, [{ syntax: EVRLE, q: 1 }])).toBeUndefined();
  });

  test("each offer yields a file that says what it is, and bulk reads come from the stored form", async () => {
    const store = await fresh();
    await ingestStudies(store, [variantStudy()]);
    const backend = new ArchiveBackend(store);
    const scope = { study: VSTUDY, series: VSERIES, instance: "1.2.3.200.1.1" };
    for (const syntax of [PRIVATE_DEMO, EVRLE, JPEG_LOSSLESS]) {
      const { parts, end } = await drain(await backend.openInstances(scope, [{ syntax, q: 1 }]));
      expect(end).toBe("complete");
      expect(parts[0]!.syntax).toBe(syntax);
      expect(readFileMeta(parts[0]!.body)!.transferSyntax).toBe(syntax);
    }
    const original = await Bun.file(inputs.v1!).bytes();
    expect(sha((await drain(await backend.openInstances(scope, [{ syntax: EVRLE, q: 1 }]))).parts[0]!.body)).toBe(sha(original));
    const index = await backend.reader.seriesIndex(VSTUDY, 1, VSERIES);
    const inst = index.instances[0]!;
    expect(inst.bulk).toEqual(parsePart10(withPrivateSyntax(original)).bulk);
    const pixels = await collect((await backend.openBulk(VSTUDY, VSERIES, inst.uid, "7fe00010")).body);
    expect(sha(pixels)).toBe(sha(smooth(64, 3)));
  });
});

describe("Retrieval", () => {
  const offersOf = async (store: ObjectStore, s: string, series: string) => (await new ArchiveReader(store).seriesIndex(s, 1, series)).instances.flatMap(i => i.offers.filter(o => o.stored));

  test("without passthrough: decoded PS3.10 bytes, a plan with exact sizes, and no encoding", async () => {
    const store = await fresh();
    await ingestStudies(store, [study(mainInputs())]);
    const stream = await new ArchiveBackend(store).openInstances({ study: STUDY }, ANY);
    const originals = await Promise.all(mainInputs().map(p => Bun.file(p).bytes()));
    expect(stream.plan!.map(p => p.bytes)).toEqual(originals.map(o => o.length));
    expect(stream.plan!.every(p => p.encoding === "none")).toBe(true);
    const { parts, end } = await drain(stream);
    expect(end).toBe("complete");
    parts.forEach((p, i) => {
      expect(sha(p.body)).toBe(sha(originals[i]!));
      expect(p.bytes).toBe(p.body.length);
      expect(p.encoding).toBe("none");
      expect(p.sop).toBe(stream.plan![i]!.sop);
      expect(p.syntax).toBe(stream.plan![i]!.syntax);
    });
  });

  test("passthrough: stored bytes unchanged, which decode to the exact PS3.10 bytes", async () => {
    const store = await fresh();
    await ingestStudies(store, [study(mainInputs())]);
    const stream = await new ArchiveBackend(store).openInstances({ study: STUDY }, ANY, { passthroughZstd: true });
    expect(stream.plan!.map(p => p.encoding)).toEqual(["zstd", "zstd", "none", "none"]);
    const { parts, end } = await drain(stream);
    expect(end).toBe("complete");
    const originals = await Promise.all(mainInputs().map(p => Bun.file(p).bytes()));
    const offers = [...await offersOf(store, STUDY, S1), ...await offersOf(store, STUDY, S2), ...await offersOf(store, STUDY, S3)];
    parts.forEach((p, i) => {
      expect(p.bytes).toBe(p.body.length);
      expect(p.bytes).toBe(stream.plan![i]!.bytes);
      expect(p.bytes).toBe(offers[i]!.objectBytes);
      expect(sha(p.encoding === "zstd" ? zstdDecompressSync(p.body) : p.body)).toBe(sha(originals[i]!));
    });
  });

  test("a whole study as one zstd stream: concatenated stored objects and small framing frames", async () => {
    const store = await fresh();
    await ingestStudies(store, [study(mainInputs())]);
    const stream = await new ArchiveBackend(store).openInstances({ study: STUDY }, ANY, { passthroughZstd: true });
    const boundary = newBoundary();
    let total = 0;
    const wire = (async function* () {
      const frame = (b: Uint8Array) => { const z = zstdCompress(b); total += z.length; return z; };
      while (true) {
        const r = await stream.parts.next();
        if (r.done) { expect(r.value).toBe("complete"); break; }
        yield frame(partHeader(boundary, { "Content-Type": `application/dicom; transfer-syntax=${r.value.syntax}` }));
        if (r.value.encoding === "zstd") for await (const c of r.value.body) { total += c.length; yield c; }
        else yield frame(await collect(r.value.body));
        yield frame(partFooter);
      }
      yield frame(closing(boundary));
    })();
    const received: Uint8Array[] = [];
    let current: Uint8Array[] = [], complete = false;
    for await (const ev of readMultipart(zstdDecode(wire), boundary)) {
      if (ev.type === "start") current = [];
      if (ev.type === "data") current.push(ev.bytes);
      if (ev.type === "end") received.push(concat(current));
      if (ev.type === "complete") complete = true;
    }
    expect(complete).toBe(true);
    const originals = await Promise.all(mainInputs().map(p => Bun.file(p).bytes()));
    expect(received.map(sha)).toEqual(originals.map(sha));
    expect(total).toBeLessThan(originals.reduce((n, o) => n + o.length, 0));
  });

  describe("corruption", () => {
    const flip = (b: Uint8Array) => { const c = new Uint8Array(b); c[c.length - 1]! ^= 0xff; return c; };

    test("wrong decoded bytes end the stream as truncated, and nothing after them opens", async () => {
      const base = await fresh();
      await ingestStudies(base, [study(mainInputs())]);
      const [first] = await offersOf(base, STUDY, S1);
      await base.write(first!.key, zstdCompress(flip(await Bun.file(inputs.a1!).bytes())));
      const { source, c } = counting(base);
      const { parts, end } = await drain(await new ArchiveBackend(source).openInstances({ study: STUDY }, ANY));
      expect(end).toBe("truncated");
      expect(parts).toHaveLength(1);
      expect(c.reads).toHaveLength(1);
    });

    test("an unencoded object with the wrong bytes does too", async () => {
      const base = await fresh();
      await ingestStudies(base, [study(mainInputs())]);
      const [offer] = await offersOf(base, STUDY, S3);
      await base.write(offer!.key, flip(await base.bytes(offer!.key)));
      expect((await drain(await new ArchiveBackend(base).openInstances({ study: STUDY, series: S3 }, ANY))).end).toBe("truncated");
    });

    test("a short object does too, in both modes", async () => {
      const base = await fresh();
      await ingestStudies(base, [study(mainInputs())]);
      const [offer] = await offersOf(base, STUDY, S3);
      await base.write(offer!.key, (await base.bytes(offer!.key)).subarray(0, 1000));
      const backend = new ArchiveBackend(base);
      expect((await drain(await backend.openInstances({ study: STUDY, series: S3 }, ANY))).end).toBe("truncated");
      const [wrapped] = await offersOf(base, STUDY, S1);
      await base.write(wrapped!.key, (await base.bytes(wrapped!.key)).subarray(0, 50));
      expect((await drain(await backend.openInstances({ study: STUDY, instance: "1.2.3.100.1.1" }, ANY, { passthroughZstd: true }))).end).toBe("truncated");
    });

    test("passthrough doesn't check the digest: that happens at ingest", async () => {
      const base = await fresh();
      await ingestStudies(base, [study(mainInputs())]);
      const [first] = await offersOf(base, STUDY, S1);
      // The same length, so only a digest could notice.
      const stored = await base.bytes(first!.key);
      const copy = new Uint8Array(stored);
      copy[stored.length >> 1]! ^= 0xff;
      await base.write(first!.key, copy);
      const { end } = await drain(await new ArchiveBackend(base).openInstances({ study: STUDY, instance: "1.2.3.100.1.1" }, ANY, { passthroughZstd: true }));
      expect(end).toBe("complete");
    });

    test("a part the consumer abandons isn't reported as complete", async () => {
      const base = await fresh();
      await ingestStudies(base, [study(mainInputs())]);
      const { source, c } = counting(base);
      const stream = await new ArchiveBackend(source).openInstances({ study: STUDY, series: S1 }, ANY);
      const first = await stream.parts.next();
      for await (const _ of first.value.body) break;
      const next = await stream.parts.next();
      expect(next).toEqual({ done: true, value: "truncated" });
      expect(c.closed).toBe(1);
    });
  });

  test("404 and 406 are decided before any content object opens", async () => {
    const base = await fresh();
    await ingestStudies(base, [study(mainInputs())]);
    const { source, c } = counting(base);
    const backend = new ArchiveBackend(source);
    const cases: [string, () => Promise<unknown>][] = [
      ["NotFound", () => backend.openInstances({ study: "9.9.9" }, ANY)],
      ["NotFound", () => backend.openInstances({ study: STUDY, series: "9.9.9" }, ANY)],
      ["NotFound", () => backend.openInstances({ study: STUDY, series: S1, instance: "9.9.9" }, ANY)],
      ["NotFound", () => backend.openInstances({ study: STUDY, onlySeries: ["9.9.9"] }, ANY)],
      ["NotFound", () => backend.openInstances({ study: STUDY, series: S1, onlySeries: [S2] }, ANY)],
      ["NotFound", () => backend.openInstances({ study: STUDY, version: 99 }, ANY)],
      ["NotAcceptable", () => backend.openInstances({ study: STUDY }, [{ syntax: EVRLE, q: 1 }])],
      ["NotAcceptable", () => backend.openInstances({ study: STUDY, series: S1 }, [{ syntax: JPEG_BASELINE, q: 1 }])],
      ["NotAcceptable", () => backend.openInstances({ study: STUDY, series: S1 }, [])],
    ];
    for (const [kind, run] of cases) expect(await kindOf(run)).toBe(kind);
    expect(c.reads).toEqual([]);
    expect(c.ranges).toEqual([]);
    expect(c.documents.every(k => k.startsWith("studies/"))).toBe(true);
  });

  test("only permitted series' indexes are read", async () => {
    const base = await fresh();
    await ingestStudies(base, [study(mainInputs())]);
    const indexes = (c: { documents: string[] }) => c.documents.filter(k => k.includes("/series/")).sort();

    const a = counting(base);
    const onlyOne = await new ArchiveBackend(a.source).openInstances({ study: STUDY, onlySeries: [S2] }, ANY);
    expect(onlyOne.plan!.map(p => p.sop)).toEqual(["1.2.3.100.2.1"]);
    expect(indexes(a.c)).toEqual([archiveKeys.seriesIndex(STUDY, 1, S2)]);

    const b = counting(base);
    await new ArchiveBackend(b.source).openInstances({ study: STUDY, series: S1 }, ANY);
    expect(indexes(b.c)).toEqual([archiveKeys.seriesIndex(STUDY, 1, S1)]);

    const m = counting(base);
    const items = await new ArchiveBackend(m.source).getMetadata({ study: STUDY, onlySeries: [S1, S3] });
    expect(items.map(i => i.__path.series)).toEqual([S1, S1, S3]);
    expect(indexes(m.c)).toEqual([archiveKeys.seriesMetadata(STUDY, 1, S1), archiveKeys.seriesMetadata(STUDY, 1, S3)]);

    const all = counting(base);
    expect((await new ArchiveBackend(all.source).openInstances({ study: STUDY }, ANY)).plan).toHaveLength(4);
    expect(indexes(all.c)).toHaveLength(3);
    expect(all.c.reads).toEqual([]);
  });

  test("index reads run in parallel, up to a small limit", async () => {
    const base = await fresh();
    const s = "1.2.3.600";
    const files = await Promise.all(Array.from({ length: 10 }, (_, i) => put(`p${i}`, { study: s, series: `${s}.${i + 1}`, sop: `${s}.${i + 1}.1`, seriesNumber: i + 1, pixels: smooth(8, i) })));
    await ingestStudies(base, [study(files)]);
    let now = 0, peak = 0;
    const slow: ObjectSource = { ...base, bytes: async k => { if (!k.includes("/series/")) return base.bytes(k); now++; peak = Math.max(peak, now); await Bun.sleep(5); now--; return base.bytes(k); } };
    const { plan } = await new ArchiveBackend(slow, { documentConcurrency: 3 }).openInstances({ study: s }, ANY);
    expect(plan).toHaveLength(10);
    expect(peak).toBe(3);
    expect(plan!.map(p => p.sop)).toEqual(Array.from({ length: 10 }, (_, i) => `${s}.${i + 1}.1`));
  });

  test("parts are lazy: nothing opens until its body is consumed", async () => {
    const base = await fresh();
    await ingestStudies(base, [study(mainInputs())]);
    const { source, c } = counting(base);
    const stream = await new ArchiveBackend(source).openInstances({ study: STUDY, series: S1 }, ANY);
    expect(c.reads).toEqual([]);
    const first = await stream.parts.next();
    expect(c.reads).toEqual([]);
    await collect(first.value.body);
    expect(c.reads).toHaveLength(1);
    const second = await stream.parts.next();
    expect(c.reads).toHaveLength(1);
    await collect(second.value.body);
    expect(c.reads).toHaveLength(2);
    expect((await stream.parts.next()).value).toBe("complete");
  });

  describe("over a large object", () => {
    const s = "1.2.3.700", series = `${s}.1`, sop = `${s}.1.1`, documentBytes = noise(4096);
    let base: ObjectStore, offer: Offer, rawOffer: Offer, pixels: Uint8Array;
    beforeAll(async () => {
      base = await fresh();
      pixels = halfNoise(2048 * 2048 * 2);
      const p = await put("large", { study: s, series, sop, document: documentBytes, pixels });
      const raw = await put("largeraw", { study: s, series, sop: `${s}.1.2`, number: 2, document: documentBytes, pixels: noise(2048 * 2048 * 2) });
      await ingestStudies(base, [study([p, raw])]);
      const instances = (await new ArchiveReader(base).seriesIndex(s, 1, series)).instances;
      offer = instances[0]!.offers[0]!;
      rawOffer = instances[1]!.offers[0]!;
      expect(offer.encoding).toBe("zstd");
      expect(rawOffer.encoding).toBe("none");
    });

    test("decompression doesn't read ahead of the consumer", async () => {
      const { source, c } = counting(base);
      const stream = await new ArchiveBackend(source).openInstances({ study: s, series, instance: sop }, ANY);
      const body = (await stream.parts.next()).value.body;
      const it = body[Symbol.asyncIterator]();
      await it.next();
      await Bun.sleep(100);
      expect(c.pulled).toBeLessThan(1024 * 1024);
      expect(offer.objectBytes).toBeGreaterThan(3 * 1024 * 1024);
      await it.return?.();
      expect(c.closed).toBe(1);
    });

    test("a local stored read doesn't either", async () => {
      const { source, c } = counting(base);
      const stream = await new ArchiveBackend(source).openInstances({ study: s, series, instance: `${s}.1.2` }, ANY, { passthroughZstd: true });
      const it = (await stream.parts.next()).value.body[Symbol.asyncIterator]();
      await it.next();
      await Bun.sleep(50);
      expect(c.pulled).toBeLessThan(512 * 1024);
      await it.return?.();
    });

    test("bulk from a zstd object stops reading once it has the element", async () => {
      const { source, c } = counting(base);
      const { body } = await new ArchiveBackend(source).openBulk(s, series, sop, "00420011");
      expect(c.reads).toEqual([]);
      expect(sha(await collect(body))).toBe(sha(documentBytes));
      expect(c.reads).toEqual([offer.key]);
      expect(c.ranges).toEqual([]);
      expect(c.pulled).toBeLessThan(1024 * 1024);
      expect(c.closed).toBe(1);
    });

    test("the last element of a zstd object reads correctly", async () => {
      const { body } = await new ArchiveBackend(base).openBulk(s, series, sop, "7FE00010");
      expect(sha(await collect(body))).toBe(sha(pixels));
    });

    test("bulk from an unencoded object uses a range", async () => {
      const { source, c } = counting(base);
      const { body } = await new ArchiveBackend(source).openBulk(s, series, `${s}.1.2`, "00420011");
      expect(sha(await collect(body))).toBe(sha(documentBytes));
      expect(c.reads).toEqual([]);
      expect(c.ranges).toEqual([rawOffer.key]);
      expect(c.pulled).toBe(documentBytes.length);
    });

    test("a bulk element that isn't there is NotFound, before anything opens", async () => {
      const { source, c } = counting(base);
      const backend = new ArchiveBackend(source);
      expect(await kindOf(() => backend.openBulk(s, series, sop, "7FE00011"))).toBe("NotFound");
      expect(await kindOf(() => backend.openBulk(s, series, "9.9", "7FE00010"))).toBe("NotFound");
      expect(await kindOf(() => backend.openBulk(s, "9.9", sop, "7FE00010"))).toBe("NotFound");
      expect(c.reads).toEqual([]);
      expect(c.ranges).toEqual([]);
    });
  });

  test("a version that no longer exists is NotFound, for every operation", async () => {
    const dir = await mkdtemp(join(root, "gone-"));
    const store = fileStore(dir);
    const files = [await put("g1", { study: "1.2.3.800", series: "1.2.3.800.1", sop: "1.2.3.800.1.1", pixels: smooth(8) })];
    await ingestStudies(store, [study(files)]);
    await put("g1", { study: "1.2.3.800", series: "1.2.3.800.1", sop: "1.2.3.800.1.1", pixels: smooth(8, 5) });
    await ingestStudies(store, [study(files)]);
    const backend = new ArchiveBackend(store);
    expect((await backend.openInstances({ study: "1.2.3.800", version: 1 }, ANY)).plan).toHaveLength(1);
    await rm(join(dir, "studies/1.2.3.800/v1"), { recursive: true });
    const after = new ArchiveBackend(store);
    expect(await kindOf(() => after.openInstances({ study: "1.2.3.800", version: 1 }, ANY))).toBe("NotFound");
    expect(await kindOf(() => after.getMetadata({ study: "1.2.3.800", version: 1 }))).toBe("NotFound");
    expect(await kindOf(() => after.openBulk("1.2.3.800", "1.2.3.800.1", "1.2.3.800.1.1", "7FE00010", 1))).toBe("NotFound");
    expect((await after.openInstances({ study: "1.2.3.800" }, ANY)).plan).toHaveLength(1);
  });

  test("a store that can't answer is Unavailable, and a bad document isn't mistaken for a missing one", async () => {
    const base = await fresh();
    await ingestStudies(base, [study(mainInputs())]);
    const down: ObjectSource = { ...base, text: async () => { throw new Error("connection refused"); } };
    expect(await kindOf(() => new ArchiveBackend(down).listSeries(STUDY))).toBe("Unavailable");
    await base.write(archiveKeys.study(STUDY, 1), new TextEncoder().encode("not zstd"));
    expect(await kindOf(() => new ArchiveBackend(base).listSeries(STUDY))).toBe("Unknown");
    await base.write(archiveKeys.study(STUDY, 1), new Uint8Array(zstdCompress(enc.encode(JSON.stringify({ format: 99 })))));
    expect(await kindOf(() => new ArchiveBackend(base).listSeries(STUDY))).toBe("Unknown");
  });

  test("withTruncation passes options and the plan through", async () => {
    const store = await fresh();
    await ingestStudies(store, [study(mainInputs())]);
    let limit: number | undefined = 1;
    const backend: Backend = withTruncation(new ArchiveBackend(store), () => limit);
    const cut = await backend.openInstances({ study: STUDY }, ANY, { passthroughZstd: true });
    expect(cut.plan).toHaveLength(4);
    const { parts, end } = await drain(cut);
    expect(end).toBe("truncated");
    expect(parts).toHaveLength(1);
    expect(parts[0]!.encoding).toBe("zstd");
    limit = undefined;
    expect((await drain(await backend.openInstances({ study: STUDY }, ANY, { passthroughZstd: true }))).end).toBe("complete");
  });
});

describe("ArchiveReader", () => {
  test("the current version is cached for a short time, then read again", async () => {
    const base = await fresh();
    await ingestStudies(base, [study(mainInputs())]);
    const { source, c } = counting(base);
    let t = 1000;
    const reader = new ArchiveReader(source, { currentTtlMs: 100, now: () => t });
    expect(await reader.currentVersion(STUDY)).toBe(1);
    await base.write(archiveKeys.current(STUDY), JSON.stringify({ version: 7 }));
    expect(await reader.currentVersion(STUDY)).toBe(1);
    expect(c.documents).toHaveLength(1);
    t += 101;
    expect(await reader.currentVersion(STUDY)).toBe(7);
    expect(c.documents).toHaveLength(2);
  });

  test("versioned documents are cached, each caller gets its own copy, and concurrent misses share a read", async () => {
    const base = await fresh();
    await ingestStudies(base, [study(mainInputs())]);
    const { source, c } = counting(base);
    const reader = new ArchiveReader(source);
    const [a, b] = await Promise.all([reader.seriesMetadata(STUDY, 1, S1), reader.seriesMetadata(STUDY, 1, S1)]);
    expect(c.documents).toHaveLength(1);
    (a.instances as any)["1.2.3.100.1.1"]["7FE00010"].BulkDataURI = "changed";
    expect((b.instances as any)["1.2.3.100.1.1"]["7FE00010"].BulkDataURI).toBe("bulk:7FE00010");
    const again = await reader.seriesMetadata(STUDY, 1, S1);
    expect((again.instances as any)["1.2.3.100.1.1"]["7FE00010"].BulkDataURI).toBe("bulk:7FE00010");
    expect(c.documents).toHaveLength(1);
    expect(reader.cachedBytes).toBe((await base.bytes(archiveKeys.seriesMetadata(STUDY, 1, S1))).length);
  });

  test("the document cache stays within its budget", async () => {
    const base = await fresh();
    await ingestStudies(base, [study(mainInputs())]);
    const size = (await base.bytes(archiveKeys.seriesIndex(STUDY, 1, S1))).length;
    const reader = new ArchiveReader(base, { cacheBytes: size + 10 });
    for (const s of [S1, S2, S3]) { await reader.seriesIndex(STUDY, 1, s); await reader.seriesMetadata(STUDY, 1, s); }
    expect(reader.cachedBytes).toBeLessThanOrEqual(size + 10);
  });

  test("a missing object is its own error", async () => {
    const store = await fresh();
    await expect(store.bytes("nope")).rejects.toBeInstanceOf(ObjectNotFoundError);
    await expect(store.text("nope")).rejects.toBeInstanceOf(ObjectNotFoundError);
    await expect(collect(store.read("nope"))).rejects.toBeInstanceOf(ObjectNotFoundError);
    expect(await store.size("nope")).toBeUndefined();
  });
});

describe("ByteLru", () => {
  test("evicts the least recently used until it fits its budget in bytes", () => {
    const lru = new ByteLru<string>(100);
    lru.set("a", "a", 40); lru.set("b", "b", 40);
    expect(lru.get("a")).toBe("a");
    lru.set("c", "c", 40);
    expect(lru.get("b")).toBeUndefined();
    expect(lru.get("a")).toBe("a");
    expect(lru.get("c")).toBe("c");
    expect(lru.bytes).toBe(80);
  });
  test("a big entry can push out many small ones, and entry count isn't the limit", () => {
    const lru = new ByteLru<number>(100);
    for (let i = 0; i < 100; i++) lru.set(`k${i}`, i, 1);
    expect(lru.size).toBe(100);
    lru.set("big", 1, 95);
    expect(lru.size).toBe(6);
    expect(lru.bytes).toBe(100);
  });
  test("something larger than the budget isn't kept, and replacing an entry re-counts it", () => {
    const lru = new ByteLru<number>(10);
    lru.set("a", 1, 5);
    lru.set("huge", 1, 11);
    expect(lru.get("huge")).toBeUndefined();
    expect(lru.get("a")).toBe(1);
    lru.set("a", 2, 7);
    expect(lru.bytes).toBe(7);
    lru.delete("a");
    expect(lru.bytes).toBe(0);
  });
});

describe("Local files and MinIO", () => {
  const { endpoint, accessKey, secretKey } = CONFIG.minio;
  const client = (bucket: string) => new S3Client({ endpoint, accessKeyId: accessKey, secretAccessKey: secretKey, bucket });
  const bucketCall = (method: string, bucket: string) => Bun.spawn(["curl", "-s", "--aws-sigv4", "aws:amz:us-east-1:s3", "--user", `${accessKey}:${secretKey}`, "-X", method, `${endpoint}/${bucket}`], { stdout: "ignore", stderr: "ignore" }).exited;
  const listAll = async (s: ObjectSource, prefix = "") => { const out: string[] = []; for await (const k of s.list(prefix)) out.push(k); return out; };

  describe("from one ingest run each", () => {
    const bucket = `archive-test-${process.pid}-${Date.now()}`;
    let local: ObjectStore, remote: ObjectStore;
    beforeAll(async () => {
      await bucketCall("PUT", bucket);
      local = await fresh();
      remote = s3Store(client(bucket));
      const studies = () => [study(mainInputs()), variantStudy()];
      await ingestStudies(local, studies());
      await ingestStudies(remote, studies());
    });
    afterAll(async () => {
      const c = client(bucket);
      for (const k of await listAll(remote)) await c.delete(k);
      await bucketCall("DELETE", bucket);
    });

    test("the same keys, in the same order, with the same bytes", async () => {
      const keys = await listAll(local);
      expect(keys.length).toBeGreaterThan(15);
      expect(await listAll(remote)).toEqual(keys);
      for (const k of keys) expect(sha(await remote.bytes(k))).toBe(sha(await local.bytes(k)));
    });

    test("listing respects a prefix, on a directory or within a name", async () => {
      for (const p of ["studies/", `studies/${STUDY}/`, `studies/${STUDY}/v1/ser`, "content/", "nothing/"]) expect(await listAll(remote, p)).toEqual(await listAll(local, p));
    });

    test("re-ingesting into MinIO writes nothing", async () => {
      const { store, writes } = recording(remote);
      const run = await ingestStudies(store, [study(mainInputs()), variantStudy()]);
      expect(run.results.map(r => r.status)).toEqual(["unchanged", "unchanged"]);
      expect(writes).toEqual([]);
    });

    test("a missing object is the same error, for whole objects, streams and sizes", async () => {
      await expect(remote.bytes("nope")).rejects.toBeInstanceOf(ObjectNotFoundError);
      await expect(remote.text("nope")).rejects.toBeInstanceOf(ObjectNotFoundError);
      await expect(collect(remote.read("nope"))).rejects.toBeInstanceOf(ObjectNotFoundError);
      expect(await remote.size("nope")).toBeUndefined();
      expect(await kindOf(() => new ArchiveBackend(remote).listSeries("9.9.9"))).toBe("NotFound");
    });

    test("the backend returns byte-identical results, in every mode", async () => {
      const a = new ArchiveBackend(local), b = new ArchiveBackend(remote);
      for (const [scope, plan, options] of [[{ study: STUDY }, ANY, {}], [{ study: STUDY }, ANY, { passthroughZstd: true }], [{ study: VSTUDY }, [{ syntax: JPEG_LOSSLESS, q: 1 }], {}], [{ study: VSTUDY }, [{ syntax: PRIVATE_DEMO, q: 1 }, { syntax: EVRLE, q: 0.5 }], { passthroughZstd: true }]] as const) {
        const x = await a.openInstances(scope, plan as any, options), y = await b.openInstances(scope, plan as any, options);
        expect(y.plan).toEqual(x.plan!);
        const dx = await drain(x), dy = await drain(y);
        expect(dy.end).toBe("complete");
        expect(dy.parts.map(p => [p.sop, p.syntax, p.encoding, p.bytes, sha(p.body)])).toEqual(dx.parts.map(p => [p.sop, p.syntax, p.encoding, p.bytes, sha(p.body)]));
      }
      expect(await b.getMetadata({ study: STUDY })).toEqual(await a.getMetadata({ study: STUDY }));
      const [p1, p2] = await Promise.all([a, b].map(async x => sha(await collect((await x.openBulk(STUDY, S1, "1.2.3.100.1.1", "7FE00010")).body))));
      expect(p2).toBe(p1!);
    });

    test("a range and an early stop work against MinIO", async () => {
      const key = (await new ArchiveReader(remote).seriesIndex(STUDY, 1, S3)).instances[0]!.offers[0]!.key;
      expect(sha(await collect(remote.readRange(key, 132, 100)))).toBe(sha((await local.bytes(key)).subarray(132, 232)));
      for await (const _ of remote.read(key)) break;
    });
  });

  describe("the real archive", () => {
    const dirStore = () => fileStore(CONFIG.archive.dir);
    const bucketStore = () => s3Store(client(CONFIG.archive.bucket));
    const SITES = () => Bun.file(join(import.meta.dir, "../data/studies.source.json")).json().then((d: any) => Object.fromEntries(d.studies.map((s: any) => [s.id, s.site])));
    const manifest = async () => {
      const reader = new ArchiveReader(dirStore());
      const uids = (await listAll(dirStore())).filter(k => k.endsWith("/current.json")).map(k => k.split("/")[1]!);
      return { studies: await Promise.all(uids.map(async uid => reader.study(uid, await reader.currentVersion(uid)))) };
    };

    test("the bucket holds exactly what the directory holds", async () => {
      const a = dirStore(), b = bucketStore();
      const keys = await listAll(a);
      expect(keys.filter(k => k.endsWith("current.json"))).toHaveLength(6);
      expect(await listAll(b)).toEqual(keys);
      for (const k of keys) {
        if (k.startsWith("content/")) expect(await b.size(k)).toBe((await a.size(k))!);
        else expect(sha(await b.bytes(k))).toBe(sha(await a.bytes(k)));
      }
    });

    test("studies say where they came from, and who the images say they're of", async () => {
      const m = await manifest();
      const sites: any = await SITES();
      const reader = new ArchiveReader(dirStore());
      for (const s of m.studies) {
        const doc = await reader.study(s.uid, await reader.currentVersion(s.uid));
        expect(doc).toMatchObject({ format: ARCHIVE_FORMAT, id: s.id, uid: s.uid, site: sites[s.id], sourcePatientId: "JEXAMPLE01", accession: s.accession });
        expect(doc.series.map(x => x.uid)).toEqual(s.series.map((x: any) => x.uid));
      }
    });

    test("every real study's offers verify, from both stores, and the fixture is where it should be", async () => {
      const m = await manifest();
      const wrist = m.studies.find((s: any) => s.id === "xr-wrist-left-2012");
      const a = new ArchiveBackend(dirStore()), b = new ArchiveBackend(bucketStore());
      const plan = [{ syntax: "*", q: 1 }];
      const x = await a.openInstances({ study: wrist.uid }, plan, { passthroughZstd: true });
      const y = await b.openInstances({ study: wrist.uid }, plan);
      expect(x.plan!.every(p => p.syntax === EVRLE)).toBe(true);
      const dx = await drain(x), dy = await drain(y);
      expect(dy.end).toBe("complete");
      dx.parts.forEach((p, i) => {
        expect(p.encoding).toBe("zstd");
        expect(sha(zstdDecompressSync(p.body))).toBe(sha(dy.parts[i]!.body));
        expect(dy.parts[i]!.body.length).toBe(dy.parts[i]!.bytes!);
      });
      const first = wrist.series[0];
      const offers = (await a.reader.seriesIndex(wrist.uid, await a.reader.currentVersion(wrist.uid), first.uid)).instances[0]!.offers;
      expect(offers.map(o => [o.syntax, o.stored, !!o.private])).toEqual([[PRIVATE_DEMO, true, true], [EVRLE, false, false], [JPEG_LOSSLESS, false, false]]);
    }, 60000);

    test("the slide keeps its lossy instances, and the 5% rule was applied to each", async () => {
      const m = await manifest();
      const slide = m.studies.find((s: any) => s.id === "slide-lung-2023");
      const reader = new ArchiveReader(dirStore());
      const version = await reader.currentVersion(slide.uid);
      const offers = (await reader.seriesIndex(slide.uid, version, slide.series[0].uid)).instances.flatMap(i => i.offers);
      expect(offers.filter(o => o.syntax === JPEG_BASELINE)).toHaveLength(3);
      for (const o of offers) {
        if (o.encoding === "zstd") expect(o.objectBytes).toBeLessThanOrEqual(o.storedBytes * 0.95);
        else {
          expect(o.objectBytes).toBe(o.storedBytes);
          expect(o.key.endsWith(".dcm")).toBe(true);
        }
      }
    });

    test("a paused read from MinIO doesn't buffer the object", async () => {
      const m = await manifest();
      const slide = m.studies.find((s: any) => s.id === "slide-lung-2023");
      const b = new ArchiveBackend(bucketStore());
      const { plan } = await b.openInstances({ study: slide.uid }, ANY);
      const largest = plan!.reduce((x, p) => p.bytes > x.bytes ? p : x);
      expect(largest.bytes).toBeGreaterThan(50 * 1024 * 1024);
      const stream = await b.openInstances({ study: slide.uid, instance: largest.sop }, ANY);
      const it = (await stream.parts.next()).value.body[Symbol.asyncIterator]();
      await it.next();
      Bun.gc(true);
      const before = process.memoryUsage().rss;
      await Bun.sleep(500);
      expect(process.memoryUsage().rss - before).toBeLessThan(largest.bytes / 2);
      await it.return?.();
    }, 60000);
  });
});
