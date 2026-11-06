// Minimal Part 10 reader: enough to index files and produce DICOM JSON metadata.
// Handles Explicit VR Little Endian and encapsulated pixel data.

const LONG_VRS = new Set(["OB", "OD", "OF", "OL", "OV", "OW", "SQ", "UC", "UN", "UR", "UT", "SV", "UV"]);
const STRING_VRS = new Set(["AE", "AS", "CS", "DA", "DT", "LO", "LT", "SH", "ST", "TM", "UC", "UI", "UR", "UT"]);
const BULK_VRS = new Set(["OB", "OD", "OF", "OL", "OV", "OW", "UN"]);
const BULK_THRESHOLD = 1024;
const ALL_VRS = new Set([...LONG_VRS, ...STRING_VRS, ...BULK_VRS, "AT", "DS", "FD", "FL", "IS", "PN", "SH", "SL", "SS", "UL", "US"]);

export type DicomJson = Record<string, { vr: string; Value?: unknown[]; BulkDataURI?: string; InlineBinary?: string }>;

export interface ParsedFile {
  transferSyntax: string;
  sopClass: string;
  dataset: DicomJson;
  pixelOffset?: number;
  pixelLength?: number;
  datasetOffset: number;
  /** Top-level bulk elements, by tag, so bulk routes can read them with a range. */
  bulk: Record<string, { offset: number; length: number }>;
}

const dec = new TextDecoder("latin1");
const tagKey = (g: number, e: number) => g.toString(16).padStart(4, "0").toUpperCase() + e.toString(16).padStart(4, "0").toUpperCase();
const trimValue = (s: string) => s.replace(/[\0 ]+$/, "").replace(/^ +/, "");

class Reader {
  view: DataView;
  constructor(public b: Uint8Array, public pos = 0) {
    this.view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  u16() { const v = this.view.getUint16(this.pos, true); this.pos += 2; return v; }
  u32() { const v = this.view.getUint32(this.pos, true); this.pos += 4; return v; }
  str(n: number) { const s = dec.decode(this.b.subarray(this.pos, this.pos + n)); this.pos += n; return s; }
  get eof() { return this.pos >= this.b.length; }
}

function valueOf(vr: string, bytes: Uint8Array, le = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)): unknown[] | undefined {
  if (bytes.length === 0) return undefined;
  if (STRING_VRS.has(vr)) {
    const text = dec.decode(bytes);
    const parts = vr === "LT" || vr === "ST" || vr === "UT" || vr === "UR" ? [text] : text.split("\\");
    return parts.map(trimValue);
  }
  if (vr === "PN") return dec.decode(bytes).split("\\").map(s => ({ Alphabetic: trimValue(s) }));
  if (vr === "IS" || vr === "DS") return dec.decode(bytes).split("\\").map(trimValue).filter(Boolean).map(Number);
  if (vr === "AT") {
    const out: string[] = [];
    for (let i = 0; i + 4 <= bytes.length; i += 4) out.push(tagKey(le.getUint16(i, true), le.getUint16(i + 2, true)));
    return out;
  }
  const numeric: Record<string, [number, (o: number) => number | bigint]> = {
    US: [2, o => le.getUint16(o, true)], SS: [2, o => le.getInt16(o, true)],
    UL: [4, o => le.getUint32(o, true)], SL: [4, o => le.getInt32(o, true)],
    FL: [4, o => le.getFloat32(o, true)], FD: [8, o => le.getFloat64(o, true)],
  };
  const n = numeric[vr];
  if (n) {
    const out: unknown[] = [];
    for (let i = 0; i + n[0] <= bytes.length; i += n[0]) out.push(n[1](i));
    return out;
  }
  return undefined;
}

function parseItems(r: Reader, end: number): DicomJson[] {
  const items: DicomJson[] = [];
  while (r.pos < end) {
    const g = r.u16(), e = r.u16(), len = r.u32();
    if (g === 0xfffe && e === 0xe0dd) break;
    if (g !== 0xfffe || e !== 0xe000) throw new Error("expected sequence item");
    const stop = len === 0xffffffff ? end : r.pos + len;
    items.push(parseDataset(r, stop, false).dataset);
  }
  return items;
}

function skipFragments(r: Reader): void {
  while (true) {
    const g = r.u16(), e = r.u16(), len = r.u32();
    if (g === 0xfffe && e === 0xe0dd) return;
    r.pos += len;
  }
}

interface Parsed { dataset: DicomJson; pixelOffset?: number; pixelLength?: number; bulk: Record<string, { offset: number; length: number }>; }

// Nested bulk values are inlined, so every BulkDataURI is a top-level element.
function parseDataset(r: Reader, end: number, top: boolean): Parsed {
  const dataset: DicomJson = {};
  const bulk: Parsed["bulk"] = {};
  let pixelOffset: number | undefined, pixelLength: number | undefined;
  while (r.pos + 4 <= end) {
    const g = r.u16(), e = r.u16();
    if (g === 0xfffe && e === 0xe00d) { r.u32(); break; }
    const vr = r.str(2);
    let len: number;
    if (LONG_VRS.has(vr)) { r.pos += 2; len = r.u32(); } else len = r.u16();
    const key = tagKey(g, e);
    if (!ALL_VRS.has(vr)) throw new Error(`element ${key} has no valid VR`);
    if (len !== 0xffffffff && r.pos + len > r.b.length) throw new Error(`element ${key} runs past the end of the file`);
    if (vr === "SQ") {
      const stop = len === 0xffffffff ? end : r.pos + len;
      const items = parseItems(r, stop);
      if (len !== 0xffffffff) r.pos = stop;
      dataset[key] = items.length ? { vr, Value: items } : { vr };
      continue;
    }
    if (len === 0xffffffff) {
      // Encapsulated pixel data
      const start = r.pos;
      skipFragments(r);
      if (key === "7FE00010") { pixelOffset = start; pixelLength = r.pos - start; }
      bulk[key] = { offset: start, length: r.pos - start };
      dataset[key] = { vr, BulkDataURI: `bulk:${key}` };
      continue;
    }
    const bytes = r.b.subarray(r.pos, r.pos + len);
    r.pos += len;
    if (key === "7FE00010") { pixelOffset = r.pos - len; pixelLength = len; }
    if (g === 0x0002 || (g % 2 === 1 && e < 0x100)) continue;
    if (BULK_VRS.has(vr)) {
      if (len > BULK_THRESHOLD && top) { bulk[key] = { offset: r.pos - len, length: len }; dataset[key] = { vr, BulkDataURI: `bulk:${key}` }; }
      else if (len) dataset[key] = { vr, InlineBinary: Buffer.from(bytes).toString("base64") };
      else dataset[key] = { vr };
      continue;
    }
    const value = valueOf(vr, bytes);
    dataset[key] = value ? { vr, Value: value } : { vr };
  }
  return { dataset, pixelOffset, pixelLength, bulk };
}

/** Reads only File Meta, from the start of a Part 10 file or part. */
export function readFileMeta(b: Uint8Array): { transferSyntax: string; sopClass: string; sopInstance: string; datasetOffset: number } | undefined {
  if (b.length < 144 || dec.decode(b.subarray(128, 132)) !== "DICM") return undefined;
  const r = new Reader(b, 132);
  let transferSyntax = "", sopClass = "", sopInstance = "", groupEnd = 0;
  while (r.pos + 8 <= b.length) {
    const start = r.pos;
    const g = r.u16(), e = r.u16();
    if (g !== 0x0002) { r.pos = start; break; }
    const vr = r.str(2);
    let len: number;
    if (LONG_VRS.has(vr)) { r.pos += 2; len = r.u32(); } else len = r.u16();
    if (r.pos + len > b.length) return undefined;
    const v = () => trimValue(dec.decode(b.subarray(r.pos, r.pos + len)));
    if (e === 0x0000) groupEnd = r.pos + len + new DataView(b.buffer, b.byteOffset + r.pos, 4).getUint32(0, true);
    if (e === 0x0002) sopClass = v();
    if (e === 0x0003) sopInstance = v();
    if (e === 0x0010) transferSyntax = v();
    r.pos += len;
    if (groupEnd && r.pos >= groupEnd) break;
  }
  return { transferSyntax, sopClass, sopInstance, datasetOffset: r.pos };
}

export function parsePart10(b: Uint8Array): ParsedFile {
  const meta = readFileMeta(b);
  if (!meta) throw new Error("not a Part 10 file");
  if (meta.transferSyntax === "1.2.840.10008.1.2" || meta.transferSyntax === "1.2.840.10008.1.2.2") {
    throw new Error(`transfer syntax ${meta.transferSyntax} is not readable here; normalize it first`);
  }
  const r = new Reader(b, meta.datasetOffset);
  const parsed = parseDataset(r, b.length, true);
  return { transferSyntax: meta.transferSyntax, sopClass: meta.sopClass, dataset: parsed.dataset, pixelOffset: parsed.pixelOffset, pixelLength: parsed.pixelLength, datasetOffset: meta.datasetOffset, bulk: parsed.bulk };
}

export const str = (d: DicomJson, k: string): string | undefined => {
  const v = d[k]?.Value?.[0];
  if (v === undefined) return undefined;
  if (typeof v === "object" && v && "Alphabetic" in (v as any)) return (v as any).Alphabetic;
  return String(v);
};
export const num = (d: DicomJson, k: string): number | undefined => {
  const v = d[k]?.Value?.[0];
  return typeof v === "number" ? v : undefined;
};
