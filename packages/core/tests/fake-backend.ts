// A fake backend that keeps to the contract in src/backends/types.ts, small Part 10 files, and the
// signed contexts and requests the proxy tests send.
import { ath, type Backend, BackendError, generateEd25519, type InstancePart, type KeyPair, type OpenOptions, type PartStream, type PlanItem, type PlannedPart, type Scope, signJws } from "../src";

export const EVRLE = "1.2.840.10008.1.2.1", JPEG = "1.2.840.10008.1.2.4.50";
export const STUDY = "1.2.3", TOKEN = "the-token";
export const ACCEPT = "multipart/related; type=application/dicom; transfer-syntax=*";
export const LOOPBACK = ["127.0.0.1"];
export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
export const until = async (f: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (!f() && Date.now() < end) await sleep(10); return f(); };
export const concat = (parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts));

/** A small but real Part 10 file. Its File Meta states `syntax`, and its size is exact. */
export function dicom(syntax: string, size: number, seed = 0): Uint8Array {
  const value = syntax.length % 2 ? `${syntax}\0` : syntax;
  const head = new Uint8Array(132 + 8 + value.length);
  head.set(new TextEncoder().encode("DICM"), 128);
  const v = new DataView(head.buffer);
  v.setUint16(132, 0x0002, true); v.setUint16(134, 0x0010, true);
  head.set(new TextEncoder().encode("UI"), 136);
  v.setUint16(138, value.length, true);
  head.set(new TextEncoder().encode(value), 140);
  const out = new Uint8Array(Math.max(size, head.length));
  // Compressible, and different for each instance.
  for (let i = head.length; i < out.length; i++) out[i] = ((i >> 6) + seed) & 0xff;
  out.set(head);
  return out;
}

export interface FakeInstance { sop: string; syntax: string; size: number; stored?: Uint8Array; zstd?: Uint8Array; }

export function fakeInstance(sop: string, syntax: string, size: number, opts: { compressed?: boolean } = {}): FakeInstance {
  const stored = dicom(syntax, size, sop.length + Number(sop.slice(-1)));
  return { sop, syntax, size: stored.length, stored, zstd: opts.compressed ? Bun.zstdCompressSync(stored) : undefined };
}

/** Bytes come from a generator on demand, so a study can be far larger than this test's memory. */
export class FakeBackend implements Backend {
  produced = 0; bodiesOpened = 0; bodiesAbandoned = 0; partsAbandoned = 0; bytesRead = 0;
  options?: OpenOptions; scope?: Scope; bulkVersion?: number;
  constructor(public instances: FakeInstance[], public opts: {
    plan?: boolean; chunk?: number; fileMetaOff?: boolean; end?: "complete" | "truncated"; failAtPart?: number; shortPart?: number; longPart?: number; failAtOpen?: BackendError; planOverride?: (p: PlannedPart[]) => PlannedPart[]; dropDecoded?: boolean;
  } = {}) {}
  capabilities() { return { name: "fake", selection: "per-instance" as const, hasManifest: !!this.opts.plan, enforcesHierarchy: true, notes: [] }; }
  async listSeries() { return ["9"]; }
  private async *body(inst: FakeInstance, encoded: boolean, index: number): AsyncGenerator<Uint8Array> {
    this.bodiesOpened++;
    const chunk = this.opts.chunk ?? 64 * 1024;
    let finished = false;
    try {
      if (this.opts.failAtOpen) throw this.opts.failAtOpen;
      const source = encoded ? inst.zstd! : inst.stored;
      let total = source ? source.length : inst.size;
      if (index === this.opts.shortPart) total -= 1;
      if (index === this.opts.longPart) total += 1;
      // A large fake instance repeats one chunk, after a real head.
      const filler = source ? undefined : new Uint8Array(chunk).fill(7);
      const head = source ? undefined : dicom(inst.syntax, 256);
      for (let at = 0; at < total;) {
        const n = Math.min(chunk, total - at);
        if (index === this.opts.failAtPart && at >= n) throw new Error("the object store failed");
        let piece: Uint8Array;
        if (source) piece = at + n <= source.length ? source.subarray(at, at + n) : concat([source.subarray(at), new Uint8Array(at + n - source.length)]);
        else if (at === 0) { piece = new Uint8Array(n); piece.set(filler!.subarray(0, n)); piece.set(head!.subarray(0, Math.min(n, head!.length))); }
        else piece = filler!.subarray(0, n);
        this.produced += piece.length;
        yield piece;
        at += n;
      }
      finished = true;
    } finally { if (!finished) this.bodiesAbandoned++; }
  }
  async openInstances(scope: Scope, _plan: PlanItem[], options?: OpenOptions): Promise<PartStream> {
    this.options = options; this.scope = scope;
    const self = this;
    const encodedFor = (i: FakeInstance) => !!(options?.passthroughZstd && i.zstd);
    let plan: PlannedPart[] | undefined;
    if (this.opts.plan) {
      plan = this.instances.map(i => ({ sop: i.sop, syntax: i.syntax, encoding: encodedFor(i) ? "zstd" as const : "none" as const, bytes: encodedFor(i) ? i.zstd!.length : i.size, ...(encodedFor(i) && !this.opts.dropDecoded ? { decodedBytes: i.size } : {}) }));
      if (this.opts.planOverride) plan = this.opts.planOverride(plan);
    }
    async function* parts(): AsyncGenerator<InstancePart, "complete" | "truncated"> {
      let finished = false;
      try {
        for (const [index, i] of self.instances.entries()) {
          const encoded = !!plan && encodedFor(i);
          yield { sop: i.sop, syntax: self.opts.plan ? i.syntax : undefined, encoding: encoded ? "zstd" : "none", ...(plan ? { bytes: encoded ? i.zstd!.length : i.size } : {}), body: self.body(i, encoded, index) };
        }
        finished = true;
        return self.opts.end ?? "complete";
      } finally { if (!finished) self.partsAbandoned++; }
    }
    return { parts: parts(), ...(plan ? { plan } : {}) };
  }
  async getMetadata(scope: Scope) { this.scope = scope; return [{ __path: { series: "9", instance: "8" } }]; }
  async openBulk(_s: string, _se: string, _i: string, _r: string, version?: number) { this.bulkVersion = version; return { body: (async function* () { yield new Uint8Array(1); })() }; }
}

export const key = generateEd25519("k1");
export const context = (k: KeyPair = key, claims: object = {}) => signJws(k, { v: 1, study: STUDY, ath: ath(TOKEN), exp: 4102444800, ...claims });
export const request = (headers: Record<string, string> = {}, ctx = context(), path = "") => new Request(`http://proxy/wado/${ctx}/studies/${STUDY}${path}`, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: ACCEPT, ...headers } });

export const large = (count: number, size: number) => Array.from({ length: count }, (_, n) => ({ sop: `1.1.${n}`, syntax: EVRLE, size }));
