// A backend over the archive format, for any object store. It works from the study document and
// series indexes alone: every 404, 406 and byte count is settled before a content object is opened.
import { createHash } from "node:crypto";
import type { PlanItem } from "../accept";
import { ArchiveFormatError, ArchiveReader, type ArchiveReaderOptions } from "../archive/reader";
import { ObjectNotFoundError } from "../archive/sources";
import type { InstanceRecord, ObjectSource, Offer, StudyDocument } from "../archive/types";
import { zstdDecode } from "../archive/zstd";
import { isStandard } from "../syntax";
import { BackendError, type Backend, type Capabilities, type InstancePart, type OpenOptions, type PartStream, type PlannedPart, type Scope } from "./types";

/** Spec flowchart: walk the plan by weight, for each instance. */
export function chooseOffer(offers: Offer[], plan: PlanItem[]): Offer | undefined {
  for (const item of plan) {
    if (item.syntax === "*") {
      const stored = offers.find(o => o.stored);
      if (stored && isStandard(stored.syntax)) return stored;
      // Private syntaxes are returned only when listed. Offer a standard one instead.
      const standard = offers.find(o => isStandard(o.syntax));
      if (standard) return standard;
      continue;
    }
    const match = offers.find(o => o.syntax === item.syntax);
    if (match) return match;
  }
  return undefined;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]!); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** How a part's body ended, for the part stream to act on once the consumer asks for the next part. */
interface BodyState { finished: boolean; corrupt: boolean; }

export interface ArchiveBackendOptions extends ArchiveReaderOptions { /** Documents read at once for one request. */ documentConcurrency?: number; }

export class ArchiveBackend implements Backend {
  readonly reader: ArchiveReader;
  private concurrency: number;
  constructor(private source: ObjectSource, opts: ArchiveBackendOptions = {}) {
    this.reader = new ArchiveReader(source, opts);
    this.concurrency = opts.documentConcurrency ?? 4;
  }

  capabilities(): Capabilities {
    return {
      name: this.source.name, selection: "per-instance", hasManifest: true, enforcesHierarchy: true,
      notes: ["Serves stored representations only: no runtime transcoding.", "Decides 404, 406 and exact lengths from series indexes, before opening any instance.", "The first instance of the left wrist study carries a synthetic private syntax label."],
    };
  }

  /** Document reads, with storage failures in the backend's terms. */
  private async guarded<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); } catch (e) {
      if (e instanceof BackendError) throw e;
      if (e instanceof ObjectNotFoundError) throw new BackendError("NotFound");
      if (e instanceof ArchiveFormatError) throw new BackendError("Unknown", e.message);
      throw new BackendError("Unavailable", `${this.source.name}: ${(e as Error).message}`);
    }
  }

  private async open(study: string, version?: number): Promise<{ doc: StudyDocument; version: number }> {
    const v = version ?? await this.reader.currentVersion(study);
    return { doc: await this.reader.study(study, v), version: v };
  }

  /** The series a scope may read, from the study document alone. */
  private selectSeries(doc: StudyDocument, scope: Scope): string[] {
    let uids = doc.series.map(s => s.uid);
    if (scope.onlySeries) uids = uids.filter(u => scope.onlySeries!.includes(u));
    if (scope.series) uids = uids.filter(u => u === scope.series);
    if (!uids.length) throw new BackendError("NotFound");
    return uids;
  }

  listSeries(study: string): Promise<string[]> {
    return this.guarded(async () => (await this.open(study)).doc.series.map(s => s.uid));
  }

  openInstances(scope: Scope, plan: PlanItem[], options: OpenOptions = {}): Promise<PartStream> {
    return this.guarded(async () => {
      const { doc, version } = await this.open(scope.study, scope.version);
      const uids = this.selectSeries(doc, scope);
      const indexes = await mapLimit(uids, this.concurrency, u => this.reader.seriesIndex(scope.study, version, u));
      const instances = indexes.flatMap(s => s.instances).filter(i => !scope.instance || i.uid === scope.instance);
      if (!instances.length) throw new BackendError("NotFound");
      // The spec leaves mixed results open. This refuses the whole request, and the app can then ask for smaller resources.
      const chosen = instances.map(inst => {
        const offer = chooseOffer(inst.offers, plan);
        if (!offer) throw new BackendError("NotAcceptable", "an instance has no representation in an accepted transfer syntax");
        const passthrough = !!options.passthroughZstd && offer.encoding === "zstd";
        const part: PlannedPart = { sop: inst.uid, syntax: offer.syntax, encoding: passthrough ? "zstd" : "none", decodedBytes: offer.storedBytes, bytes: passthrough ? offer.objectBytes : offer.storedBytes };
        return { offer, part, passthrough };
      });
      const open = (c: (typeof chosen)[number], state: BodyState) => c.passthrough ? this.storedBody(c.offer, state) : this.decodedBody(c.offer, state);
      async function* parts(): AsyncGenerator<InstancePart, "complete" | "truncated"> {
        for (const c of chosen) {
          const state: BodyState = { finished: false, corrupt: false };
          const body = open(c, state);
          yield { ...c.part, body };
          // Closes a body the consumer left part way. A part that wasn't delivered whole, or whose
          // digest failed, ends the stream as truncated, so it can never look complete.
          await body.return(undefined);
          if (state.corrupt || !state.finished) return "truncated";
        }
        return "complete";
      }
      return { parts: parts(), plan: chosen.map(c => c.part) };
    });
  }

  /**
   * Stored bytes, unchanged. The digest covers decoded bytes and can't be checked without decoding,
   * so in passthrough the digest is verified at ingest only, and here only the length is checked.
   */
  private async *storedBody(offer: Offer, state: BodyState): AsyncGenerator<Uint8Array, void, undefined> {
    let n = 0;
    for await (const chunk of this.source.read(offer.key)) {
      n += chunk.length;
      if (n > offer.objectBytes) { state.corrupt = true; return; }
      yield chunk;
    }
    if (n !== offer.objectBytes) state.corrupt = true;
    state.finished = true;
  }

  /** PS3.10 bytes, decompressed as they're pulled, and checked against the digest as they pass. */
  private async *decodedBody(offer: Offer, state: BodyState): AsyncGenerator<Uint8Array, void, undefined> {
    const stored = this.source.read(offer.key);
    const decoded = offer.encoding === "zstd" ? zstdDecode(stored) : stored;
    const digest = createHash("sha256");
    let n = 0;
    for await (const chunk of decoded) {
      n += chunk.length;
      if (n > offer.storedBytes) { state.corrupt = true; return; }
      digest.update(chunk);
      yield chunk;
    }
    if (n !== offer.storedBytes || digest.digest("hex") !== offer.sha256) state.corrupt = true;
    state.finished = true;
  }

  getMetadata(scope: Scope): Promise<any[]> {
    return this.guarded(async () => {
      const { doc, version } = await this.open(scope.study, scope.version);
      const uids = this.selectSeries(doc, scope);
      const documents = await mapLimit(uids, this.concurrency, u => this.reader.seriesMetadata(scope.study, version, u));
      const out: any[] = [];
      uids.forEach((series, i) => {
        for (const [instance, item] of Object.entries(documents[i]!.instances)) {
          if (scope.instance && instance !== scope.instance) continue;
          out.push({ ...(item as object), __path: { series, instance } });
        }
      });
      if (!out.length) throw new BackendError("NotFound");
      return out;
    });
  }

  openBulk(study: string, series: string, instance: string, ref: string, version?: number) {
    return this.guarded(async () => {
      const { doc, version: v } = await this.open(study, version);
      this.selectSeries(doc, { study, series });
      const index = await this.reader.seriesIndex(study, v, series);
      const inst: InstanceRecord | undefined = index.instances.find(i => i.uid === instance);
      const element = inst?.bulk?.[ref.toUpperCase()];
      const stored = inst?.offers.find(o => o.stored);
      if (!element || !stored) throw new BackendError("NotFound");
      return { contentType: "application/octet-stream", body: this.bulkBody(stored, element) };
    });
  }

  /** Bulk offsets are into decoded bytes, so a zstd object is decoded from its start, as far as the element. */
  private async *bulkBody(stored: Offer, element: { offset: number; length: number }): AsyncGenerator<Uint8Array> {
    if (stored.encoding === "none") yield* exactly(this.source.readRange(stored.key, element.offset, element.length), element.length);
    else yield* slice(zstdDecode(this.source.read(stored.key)), element.offset, element.length);
  }
}

/** A short read fails loudly: a bulk response has no digest to catch it. */
async function* exactly(source: AsyncIterable<Uint8Array>, length: number): AsyncGenerator<Uint8Array> {
  let n = 0;
  for await (const chunk of source) { n += chunk.length; yield chunk; }
  if (n !== length) throw new Error(`bulk element ended at ${n} of ${length} bytes`);
}

/** The bytes at [offset, offset + length) of a stream. Stops reading the source once it has them. */
async function* slice(source: AsyncIterable<Uint8Array>, offset: number, length: number): AsyncGenerator<Uint8Array> {
  if (length === 0) return;
  let at = 0, sent = 0;
  for await (const chunk of source) {
    const from = Math.max(0, offset - at), to = Math.min(chunk.length, offset + length - at);
    at += chunk.length;
    if (from < to) {
      yield chunk.subarray(from, to);
      sent += to - from;
      if (sent === length) return;
    }
  }
  throw new Error(`bulk element ended at ${sent} of ${length} bytes`);
}
