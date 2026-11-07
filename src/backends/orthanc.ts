// An upstream DICOMweb backend, tested against Orthanc. Everything the research found
// wrong at this boundary is corrected here or in the proxy.
import type { PlanItem } from "../accept";
import { boundaryOf, readMultipart } from "../multipart";
import { tfetch } from "../trace";
import { BackendError, type Backend, type Capabilities, type InstancePart, type PartStream, type Scope } from "./types";

export interface OrthancConfig { base: string; user: string; password: string; }
const asIterable = (s: ReadableStream<Uint8Array>) => s as unknown as AsyncIterable<Uint8Array>;
const knownLength = (header: string | null | undefined): { bytes?: number } => /^\d+$/.test(header ?? "") ? { bytes: Number(header) } : {};

const BULK_PEEK = 1 << 20;
const SEQUENCE_DELIMITER = new Uint8Array([0xfe, 0xff, 0xdd, 0xe0, 0, 0, 0, 0]);
/** One encapsulated item, the form the element has in a PS3.10 file, so it matches what the stores serve. */
function item(chunks: Uint8Array[]) {
  const length = chunks.reduce((n, c) => n + c.length, 0), out = new Uint8Array(8 + length);
  out.set([0xfe, 0xff, 0x00, 0xe0]);
  new DataView(out.buffer).setUint32(4, length, true);
  let at = 8;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}
function mapError(status: number): BackendError {
  if (status === 404) return new BackendError("NotFound");
  if (status === 400 || status === 406 || status === 415) return new BackendError("NotAcceptable");
  if (status === 503) return new BackendError("Unavailable");
  // Orthanc answers 500 for syntaxes it can't produce as well as for corrupt data.
  if (status === 500) return new BackendError("CannotDecode");
  return new BackendError("Unknown", `upstream ${status}`);
}

export class OrthancBackend implements Backend {
  private auth: string;
  constructor(private cfg: OrthancConfig) { this.auth = "Basic " + btoa(`${cfg.user}:${cfg.password}`); }
  capabilities(): Capabilities {
    return {
      name: "orthanc", selection: "one-per-request", hasManifest: false, enforcesHierarchy: true,
      notes: ["Uses only the top Accept item, so the proxy retries down the plan.", "Sends no transfer-syntax on parts, so the proxy reads File Meta.", "Reports failures with 400 or 500, which the proxy turns into 406."],
    };
  }
  private url(path: string) { return `${this.cfg.base}/dicom-web${path}`; }
  private async get(path: string, accept: string) {
    return tfetch("backend", `upstream GET ${path.replace(/2\.25\.[0-9.]+|[0-9]+(\.[0-9]+){4,}/g, "{uid}")}`, this.url(path), { headers: { Accept: accept, Authorization: this.auth }, redirect: "error" }, { backend: "orthanc", accept });
  }
  private path(s: Scope) {
    let p = `/studies/${s.study}`;
    if (s.series) p += `/series/${s.series}`;
    if (s.instance) p += `/instances/${s.instance}`;
    return p;
  }
  async listSeries(study: string) {
    const r = await this.get(`/studies/${study}/series`, "application/dicom+json");
    if (!r.ok) throw mapError(r.status);
    const items: any[] = await r.json();
    return items.map(i => i["0020000E"].Value[0]);
  }
  private async openOne(path: string, plan: PlanItem[]) {
    let last: BackendError = new BackendError("NotAcceptable");
    for (const item of plan) {
      const r = await this.get(path, `multipart/related; type="application/dicom"; transfer-syntax=${item.syntax}`);
      if (r.ok) return r;
      await r.body?.cancel();
      last = mapError(r.status);
      if (last.kind === "NotFound" || last.kind === "Unavailable") throw last;
    }
    throw last.kind === "CannotDecode" ? new BackendError("NotAcceptable", "upstream could not produce an accepted syntax") : last;
  }
  async openInstances(scope: Scope, plan: PlanItem[]): Promise<PartStream> {
    const paths: string[] = scope.onlySeries && !scope.series
      ? scope.onlySeries.map(s => `/studies/${scope.study}/series/${s}`)
      : [this.path(scope)];
    const first = await this.openOne(paths[0]!, plan);
    const self = this;
    async function* gen(): AsyncGenerator<InstancePart, "complete" | "truncated"> {
      for (const [i, p] of paths.entries()) {
        const r = i === 0 ? first : await self.openOne(p, plan);
        const boundary = boundaryOf(r.headers.get("content-type"));
        if (!boundary) return "truncated";
        const events = readMultipart(asIterable(r.body!), boundary);
        let done: "complete" | "truncated" | undefined;
        try {
          // One part at a time: the consumer drains each body before asking for the next.
          let pending = await events.next();
          while (!pending.done && pending.value.type !== "complete" && pending.value.type !== "truncated") {
            if (pending.value.type !== "start") { pending = await events.next(); continue; }
            const syntax = pending.value.headers["content-type"]?.match(/transfer-syntax=([0-9.]+)/)?.[1];
            let trailing: any;
            const body = (async function* () {
              while (true) {
                const n = await events.next();
                if (n.done || n.value.type !== "data") { trailing = n; return; }
                yield n.value.bytes;
              }
            })();
            yield { syntax, body };
            for await (const _ of body) { /* drain anything the consumer left */ }
            if (trailing?.done || trailing?.value?.type === "truncated") { done = "truncated"; break; }
            pending = await events.next();
          }
          if (!done && !pending.done && pending.value.type === "truncated") done = "truncated";
          if (!done && pending.done) done = "truncated";
          if (done === "truncated") return "truncated";
        } finally {
          // Reached early when the consumer stops, and this is what cancels the upstream read.
          await events.return(undefined);
        }
      }
      return "complete";
    }
    return { parts: gen() };
  }
  async getMetadata(scope: Scope) {
    const paths = scope.onlySeries && !scope.series ? scope.onlySeries.map(s => `/studies/${scope.study}/series/${s}/metadata`) : [`${this.path(scope)}/metadata`];
    const out: any[] = [];
    for (const p of paths) {
      const r = await this.get(p, "application/dicom+json");
      if (!r.ok) throw mapError(r.status);
      const items: any[] = await r.json();
      out.push(...items);
    }
    for (const item of out) {
      const series = item["0020000E"]?.Value?.[0], instance = item["00080018"]?.Value?.[0];
      item.__path = { series, instance };
      item.__rawUrls = JSON.stringify(item).match(/https?:\/\/[^"]+/g) ?? [];
    }
    return out;
  }
  async openBulk(study: string, series: string, instance: string, ref: string) {
    // Orthanc answers for any tag, and with a 500 for what it can't read. As with the stores, only what the metadata lists as bulk data is.
    const meta = /^[0-9a-f]{8}(\/\d+\/[0-9a-f]{8})*$/i.test(ref) ? await this.get(`/studies/${study}/series/${series}/instances/${instance}/metadata`, "application/dicom+json") : undefined;
    if (!meta?.ok || !(await meta.text()).toLowerCase().includes(`/bulk/${ref.toLowerCase()}"`)) throw mapError(404);
    const r = await this.get(`/studies/${study}/series/${series}/instances/${instance}/bulk/${ref.toLowerCase()}`, "*/*");
    if (!r.ok) throw mapError(r.status);
    const boundary = boundaryOf(r.headers.get("content-type"));
    if (!boundary) return { ...knownLength(r.headers.get("content-length")), body: asIterable(r.body!) };
    // Orthanc wraps an element in one multipart part, except encapsulated data: an offset table, then a part per fragment.
    const events = readMultipart(asIterable(r.body!), boundary);
    const start = await events.next();
    if (start.done || start.value.type !== "start") { await events.return(undefined); throw new BackendError("Unknown", "upstream bulk response has no part"); }
    const first: Uint8Array[] = [];
    let held = 0, firstEnded = false;
    while (held <= BULK_PEEK && !firstEnded) {
      const e = await events.next();
      if (e.done || (e.value.type !== "data" && e.value.type !== "end")) { await events.return(undefined); throw new BackendError("Unknown", "upstream ended before the bulk element was complete"); }
      if (e.value.type === "data") { first.push(e.value.bytes); held += e.value.bytes.length; } else firstEnded = true;
    }
    const after = firstEnded ? await events.next() : undefined;
    const encapsulated = after?.value?.type === "start";
    if (firstEnded && !encapsulated && after?.value?.type !== "complete") { await events.return(undefined); throw new BackendError("Unknown", "upstream ended before the bulk element was complete"); }
    const body = (async function* () {
      try {
        if (encapsulated) {
          yield item(first);
          for (;;) {
            const bytes: Uint8Array[] = [];
            for (;;) {
              const e = await events.next();
              if (e.done || (e.value.type !== "data" && e.value.type !== "end")) throw new Error("upstream ended before the bulk element was complete");
              if (e.value.type === "end") break;
              bytes.push(e.value.bytes);
            }
            yield item(bytes);
            const next = await events.next();
            if (next.value?.type === "complete") break;
            if (next.done || next.value.type !== "start") throw new Error("upstream ended before the bulk element was complete");
          }
          yield SEQUENCE_DELIMITER;
          return;
        }
        for (const b of first) yield b;
        if (firstEnded) return;
        for await (const e of events) {
          if (e.type === "data") yield e.bytes;
          else if (e.type === "end") {
            // More parts after a part this large would be encapsulated data this path can't frame.
            if ((await events.next()).value?.type === "complete") return;
            break;
          } else break;
        }
        throw new Error("upstream ended before the bulk element was complete");
      } finally { await events.return(undefined); }
    })();
    // A part larger than the peek is taken as the whole element: an offset table that size would need over 260,000 frames.
    return { ...(encapsulated ? {} : firstEnded ? { bytes: held } : knownLength(start.value.headers["content-length"])), body };
  }
  async rawProbe(path: string, accept: string) {
    const r = await this.get(path, accept);
    const reader = r.body?.getReader();
    const chunk = reader ? (await reader.read()).value : undefined;
    await reader?.cancel();
    const text = chunk ? new TextDecoder("latin1").decode(chunk.subarray(0, 600)) : "";
    const label = text.match(/Content-Type:[^\r\n]*/i)?.[0] ?? null;
    return { status: r.status, contentType: r.headers.get("content-type"), partSyntaxLabel: label, bodyPreview: text.slice(0, 240).replace(/[^\x20-\x7e\r\n]/g, "·") };
  }
}
