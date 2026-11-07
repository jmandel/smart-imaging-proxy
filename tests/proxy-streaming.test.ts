// The proxy as a streaming service, against a fake backend that keeps to the contract in
// src/backends/types.ts. Clients that need to show what's on the wire use raw sockets, since fetch
// has its own buffers and hides framing.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptsZstd, type PlanItem } from "../src/accept";
import { BackendError, type Backend, type InstancePart, type OpenOptions, type PartStream, type PlannedPart, type Scope } from "../src/backends/types";
import { advance, resetClock } from "../src/clock";
import { ath, generateEd25519, publicJwk, signJws, type KeyPair } from "../src/jws";
import { boundaryOf, readMultipart } from "../src/multipart";
import { createProxy } from "../src/proxy";
import { serveStreaming } from "../src/serve-streaming";
import { flushTraces, setTraceSink, type SpanRecord } from "../src/trace";
import { RAW_BLOCK_MAX, rawFrame, rawFrameSize, RawFrameWriter } from "../src/zstd-frames";

const EVRLE = "1.2.840.10008.1.2.1", JPEG = "1.2.840.10008.1.2.4.50";
const STUDY = "1.2.3", TOKEN = "the-token";
const ACCEPT = "multipart/related; type=application/dicom; transfer-syntax=*";
const LOOPBACK = ["127.0.0.1"];
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (!f() && Date.now() < end) await sleep(10); return f(); };
const concat = (parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts));

/** A small but real Part 10 file. Its File Meta states `syntax`, and its size is exact. */
function dicom(syntax: string, size: number, seed = 0): Uint8Array {
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

interface FakeInstance { sop: string; syntax: string; size: number; stored?: Uint8Array; zstd?: Uint8Array; }

function fakeInstance(sop: string, syntax: string, size: number, opts: { compressed?: boolean } = {}): FakeInstance {
  const stored = dicom(syntax, size, sop.length + Number(sop.slice(-1)));
  return { sop, syntax, size: stored.length, stored, zstd: opts.compressed ? Bun.zstdCompressSync(stored) : undefined };
}

/** Bytes come from a generator on demand, so a study can be far larger than this test's memory. */
class FakeBackend implements Backend {
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

const key = generateEd25519("k1");
const context = (k: KeyPair = key, claims: object = {}) => signJws(k, { v: 1, study: STUDY, ath: ath(TOKEN), exp: 4102444800, ...claims });
const request = (headers: Record<string, string> = {}, ctx = context(), path = "") => new Request(`http://proxy/wado/${ctx}/studies/${STUDY}${path}`, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: ACCEPT, ...headers } });
const proxyOver = (backend: Backend) => createProxy({ publicBase: () => "http://proxy", keys: new Map([[key.kid, key.publicKey]]), decisionUrl: "http://127.0.0.1:1/none", serviceSecret: "s", backend: () => backend });

const cleanups: (() => void)[] = [];
afterEach(() => { for (const c of cleanups.splice(0)) c(); resetClock(); });
async function serving(proxy: ReturnType<typeof createProxy>) {
  const server = await serveStreaming(0, proxy.fetch, { hosts: LOOPBACK });
  cleanups.push(() => server.stop());
  return server;
}

/** A client on a real socket. `pause` stops it reading, so the kernel's buffers fill and then push back. */
function rawClient(port: number, ctx = context(), headers: Record<string, string> = {}) {
  const s = net.connect(port, "127.0.0.1");
  const received: Uint8Array[] = [];
  const state = { bytes: 0, ended: false, error: undefined as string | undefined, head: "" };
  let headRest: Buffer | undefined = Buffer.alloc(0);
  s.on("connect", () => s.write(`GET /wado/${ctx}/studies/${STUDY} HTTP/1.1\r\nHost: proxy\r\nConnection: close\r\nAuthorization: Bearer ${TOKEN}\r\nAccept: ${ACCEPT}\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join("")}\r\n`));
  s.on("data", d => {
    state.bytes += d.length;
    if (headRest) {
      headRest = Buffer.concat([headRest, d]);
      const at = headRest.indexOf("\r\n\r\n");
      if (at < 0) return;
      state.head = headRest.subarray(0, at).toString("latin1");
      state.bytes = headRest.length - at - 4;
      received.push(new Uint8Array(headRest.subarray(at + 4)));
      headRest = undefined;
    } else received.push(new Uint8Array(d));
  });
  const closed = new Promise<void>(r => { s.on("close", () => { state.ended = true; r(); }); s.on("error", e => { state.error = e.message; }); });
  cleanups.push(() => s.destroy());
  return { socket: s, state, received, closed, header: (name: string) => state.head.match(new RegExp(`^${name}: (.*)$`, "im"))?.[1]?.trim() };
}

const CHUNK = 64 * 1024;
const large = (count: number, size: number) => Array.from({ length: count }, (_, n) => ({ sop: `1.1.${n}`, syntax: EVRLE, size }));

describe("backpressure", () => {
  for (const planned of [false, true]) {
    const label = planned ? "with a plan" : "without a plan";
    // The stream reads one chunk for a head, and the trace's wrapper and this reader add none.
    test(`production stays within two chunks of a slow reader, ${label}`, async () => {
      const b = new FakeBackend(large(40, 8 * 1024 * 1024), { plan: planned });
      const res = await proxyOver(b).fetch(request());
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      let consumed = 0, worst = 0;
      for (let i = 0; i < 300; i++) {
        const { value, done } = await reader.read();
        expect(done).toBe(false);
        consumed += value!.length;
        if (i % 50 === 0) await sleep(2);
        worst = Math.max(worst, b.produced - consumed);
      }
      expect(worst).toBeLessThanOrEqual(2 * CHUNK);
      // Nothing moves while nobody reads.
      const held = b.produced;
      await sleep(50);
      expect(b.produced).toBe(held);
      await reader.cancel();
    });

    test(`a reader that goes away stops production and is recorded, ${label}`, async () => {
      const b = new FakeBackend(large(40, 8 * 1024 * 1024), { plan: planned });
      const proxy = proxyOver(b);
      const res = await proxy.fetch(request());
      const reader = res.body!.getReader();
      for (let i = 0; i < 20; i++) await reader.read();
      const before = b.produced;
      await reader.cancel();
      expect(await until(() => b.bodiesAbandoned === 1 && b.partsAbandoned === 1)).toBe(true);
      await sleep(30);
      expect(b.produced).toBe(before);
      const ev = proxy.events.at(-1)!;
      expect(ev.disconnected).toBe(true);
      expect(ev.note).toContain("client disconnected");
      expect(ev.truncated).toBeUndefined();
    });

    test(`a stopped client on a real socket holds production to what the socket buffers, then a hangup ends it, ${label}`, async () => {
      const b = new FakeBackend(large(40, 8 * 1024 * 1024), { plan: planned }); // 320 MB.
      const proxy = proxyOver(b);
      const server = await serving(proxy);
      const c = rawClient(server.port);
      expect(await until(() => c.state.bytes > 200_000)).toBe(true);
      c.socket.pause();
      // Wait for the kernel's buffers to fill, which is when production stops.
      let last = -1;
      await until(() => { const same = b.produced === last; last = b.produced; return same && last > 0; }, 5000);
      await sleep(200);
      const ahead = b.produced - c.state.bytes;
      expect(b.produced).toBeLessThan(40 * 1024 * 1024);
      expect(ahead).toBeLessThan(32 * 1024 * 1024);
      const held = b.produced;
      await sleep(200);
      expect(b.produced).toBe(held);

      c.socket.destroy();
      expect(await until(() => b.partsAbandoned === 1 && b.bodiesAbandoned === 1)).toBe(true);
      await sleep(50);
      expect(b.produced).toBe(held);
      expect(proxy.events.at(-1)!.disconnected).toBe(true);
    });
  }

  test("a slow client gets every byte, and the server span lasts until it has them", async () => {
    const insts = [fakeInstance("1.1.1", EVRLE, 900_000), fakeInstance("1.1.2", EVRLE, 900_000)];
    const proxy = proxyOver(new FakeBackend(insts, { plan: true }));
    const res = await proxy.fetch(request());
    const reader = res.body!.getReader();
    const got: Uint8Array[] = [];
    const started = performance.now();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      got.push(value!);
      await sleep(5);
    }
    const elapsed = performance.now() - started;
    const ev = proxy.events.at(-1)!;
    expect(ev.ms!).toBeGreaterThanOrEqual(elapsed * 0.8);
    expect(ev.bytes).toBe(concat(got).length);
    expect(ev.parts).toBe(2);
    expect(Number(res.headers.get("content-length"))).toBe(concat(got).length);
  });

  test("a client that stops accepting data is dropped after the stall limit, and production ends", async () => {
    const b = new FakeBackend(large(40, 8 * 1024 * 1024), { plan: true });
    const server = await serveStreaming(0, proxyOver(b).fetch, { hosts: LOOPBACK, stallSeconds: 0.3 });
    cleanups.push(() => server.stop());
    const c = rawClient(server.port);
    await until(() => c.state.bytes > 0);
    c.socket.pause();
    expect(await until(() => b.partsAbandoned === 1 && b.bodiesAbandoned === 1, 8000)).toBe(true);
  });
});

describe("spans measure delivery", () => {
  /** The latest version of each span the proxy reported, from a real trace sink. */
  async function collecting(run: () => Promise<void>) {
    const seen = new Map<string, SpanRecord>();
    const sink = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) { for (const r of await req.json() as SpanRecord[]) seen.set(r.span, r); return new Response(null, { status: 204 }); } });
    cleanups.push(() => sink.stop(true));
    setTraceSink(`http://127.0.0.1:${sink.port}`);
    try { await run(); flushTraces(); await sleep(60); } finally { setTraceSink(""); }
    return [...seen.values()].filter(r => r.session === "delivery-test");
  }
  // How a caller's trace reaches any service here.
  const traced = { traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`, baggage: "demo.session=delivery-test" };
  const study = () => [fakeInstance("1.1.1", EVRLE, 400_000), fakeInstance("1.1.2", EVRLE, 400_000)];

  for (const planned of [false, true]) {
    test(`the server span ends when the client finishes, with the stream in its session, ${planned ? "with a plan" : "without one"}`, async () => {
      let elapsed = 0;
      const spans = await collecting(async () => {
        const res = await proxyOver(new FakeBackend(study(), { plan: planned })).fetch(request(traced));
        const reader = res.body!.getReader();
        const started = performance.now();
        while (!(await reader.read()).done) await sleep(3);
        elapsed = performance.now() - started;
      });
      const server = spans.find(s => s.kind === "server")!, stream = spans.find(s => s.name === "stream multipart response")!;
      expect(server.status).toBe("ok");
      expect(server.end! - server.start).toBeGreaterThanOrEqual(elapsed * 0.8);
      expect(stream.parent).toBe(server.span);
      expect(stream.attrs.closing_boundary).toBe(true);
      expect(stream.attrs.bytes_sent).toBeGreaterThan(800_000);
      // Work done while the client pulls still belongs to this request, not to nobody.
      const labels = spans.filter(s => /^part \d/.test(s.name));
      expect(labels.length).toBe(2);
      for (const l of labels) { expect(l.session).toBe("delivery-test"); expect(l.trace).toBe(server.trace); expect(l.parent).toBe(server.span); }
    });
  }

  test("a disconnect ends the spans, and says so", async () => {
    const spans = await collecting(async () => {
      const res = await proxyOver(new FakeBackend(large(10, 8 * 1024 * 1024), { plan: true })).fetch(request(traced));
      const reader = res.body!.getReader();
      for (let i = 0; i < 5; i++) await reader.read();
      await reader.cancel();
    });
    const server = spans.find(s => s.kind === "server")!, stream = spans.find(s => s.name === "stream multipart response")!;
    expect(server.status).toBe("error");
    expect(server.end).toBeGreaterThan(0);
    expect(stream.attrs).toMatchObject({ client_disconnected: true, backend_reads_cancelled: true, closing_boundary: false });
    expect(spans.find(s => s.name === "client stayed until the response ended")!.status).toBe("denied");
  });
});

describe("the response when something fails mid-stream", () => {
  // Both framings end without a closing boundary, and a socket client can tell it's not complete.
  for (const planned of [false, true]) {
    const label = planned ? "Content-Length" : "chunked";
    test(`a failed read aborts a ${label} response`, async () => {
      const insts = [fakeInstance("1.1.1", EVRLE, 400_000), fakeInstance("1.1.2", EVRLE, 400_000), fakeInstance("1.1.3", EVRLE, 400_000)];
      const b = new FakeBackend(insts, { plan: planned, failAtPart: 1 });
      const proxy = proxyOver(b);
      const server = await serving(proxy);
      const c = rawClient(server.port);
      await c.closed;
      const body = concat(c.received);
      const text = Buffer.from(body).toString("latin1");
      const boundary = boundaryOf(c.header("content-type") ?? null)!;
      expect(text).not.toContain(`--${boundary}--`);
      if (planned) expect(body.length).toBeLessThan(Number(c.header("content-length")));
      else {
        expect(c.header("transfer-encoding")).toBe("chunked");
        expect(text.endsWith("0\r\n\r\n")).toBe(false);
      }
      expect(proxy.events.at(-1)!.truncated).toBe(true);
      await expect(fetch(`http://127.0.0.1:${server.port}/wado/${context()}/studies/${STUDY}`, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: ACCEPT } }).then(r => r.arrayBuffer())).rejects.toThrow();
    });
    test(`a backend reporting truncation aborts a ${label} response`, async () => {
      const b = new FakeBackend([fakeInstance("1.1.1", EVRLE, 4096)], { plan: planned, end: "truncated" });
      const c = rawClient((await serving(proxyOver(b))).port);
      await c.closed;
      expect(Buffer.from(concat(c.received)).toString("latin1")).not.toContain(`--${boundaryOf(c.header("content-type") ?? null)}--`);
    });
  }
});

describe("a backend's plan", () => {
  const multipartFrom = async (res: Response) => {
    const parts: { headers: Record<string, string>; bytes: Uint8Array[] }[] = [];
    let complete = false;
    for await (const e of readMultipart(res.body as any, boundaryOf(res.headers.get("content-type"))!)) {
      if (e.type === "start") parts.push({ headers: e.headers, bytes: [] });
      else if (e.type === "data") parts.at(-1)!.bytes.push(e.bytes);
      else if (e.type === "complete") complete = true;
    }
    return { parts: parts.map(p => ({ headers: p.headers, body: concat(p.bytes) })), complete };
  };

  test("gives an exact Content-Length on the wire, and a length on every part", async () => {
    const insts = [fakeInstance("1.1.1", EVRLE, 300_000), fakeInstance("1.1.2", JPEG, 5000)];
    const c = rawClient((await serving(proxyOver(new FakeBackend(insts, { plan: true })))).port);
    await c.closed;
    expect(c.header("transfer-encoding")).toBeUndefined();
    expect(Number(c.header("content-length"))).toBe(c.state.bytes);
    expect(c.header("vary")).toBe("Accept-Encoding");
    const text = Buffer.from(concat(c.received)).toString("latin1");
    expect(text).toContain(`Content-Type: application/dicom; transfer-syntax=${EVRLE}\r\nContent-Length: ${insts[0]!.size}\r\n\r\n`);
    expect(text).toContain(`Content-Type: application/dicom; transfer-syntax=${JPEG}\r\nContent-Length: ${insts[1]!.size}\r\n\r\n`);
    expect(text).toContain(`--${boundaryOf(c.header("content-type") ?? null)}--\r\n`);
  });

  test("is authoritative: the label comes from the plan, whatever the File Meta says", async () => {
    const inst = { ...fakeInstance("1.1.1", EVRLE, 5000), syntax: JPEG };
    const { parts, complete } = await multipartFrom(await proxyOver(new FakeBackend([inst], { plan: true })).fetch(request()));
    expect(complete).toBe(true);
    expect(parts[0]!.headers["content-type"]).toContain(JPEG);
  });

  test("gives one boundary for one request, and another for a different one", async () => {
    const insts = [fakeInstance("1.1.1", EVRLE, 500)];
    const ct = async (i: FakeInstance[], headers = {}) => (await proxyOver(new FakeBackend(i, { plan: true })).fetch(request(headers))).headers.get("content-type");
    expect(await ct(insts)).toBe(await ct(insts));
    expect(await ct(insts)).toBe(await ct(insts, { "Accept-Encoding": "zstd" }));
    expect(await ct(insts)).not.toBe(await ct([fakeInstance("1.1.2", EVRLE, 500)]));
  });

  test("decides 406 before any body is opened", async () => {
    const b = new FakeBackend([fakeInstance("1.1.1", EVRLE, 500), fakeInstance("1.1.2", JPEG, 500)], { plan: true });
    const res = await proxyOver(b).fetch(request({ Accept: `multipart/related; type=application/dicom; transfer-syntax=${EVRLE}` }));
    expect(res.status).toBe(406);
    expect(b.bodiesOpened).toBe(0);
  });

  test("an empty plan is 404, and zstd parts nobody offered to take are 502", async () => {
    expect((await proxyOver(new FakeBackend([], { plan: true })).fetch(request())).status).toBe(404);
    const stray = new FakeBackend([fakeInstance("1.1.1", EVRLE, 500)], { plan: true, planOverride: p => p.map(x => ({ ...x, encoding: "zstd" as const })) });
    expect((await proxyOver(stray).fetch(request())).status).toBe(502);
    expect(stray.bodiesOpened).toBe(0);
  });

  test("an outage on the first part is a status, not a broken 200", async () => {
    const b = new FakeBackend([fakeInstance("1.1.1", EVRLE, 500)], { plan: true, failAtOpen: new BackendError("Unavailable", undefined, 7) });
    const res = await proxyOver(b).fetch(request());
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("7");
  });

  for (const [name, opts, why] of [
    ["short", { shortPart: 1 }, "ended at"],
    ["long", { longPart: 1 }, "ran past"],
  ] as const) test(`a part that runs ${name} of its plan aborts`, async () => {
    const proxy = proxyOver(new FakeBackend([fakeInstance("1.1.1", EVRLE, 5000), fakeInstance("1.1.2", EVRLE, 5000)], { plan: true, ...opts }));
    const res = await proxy.fetch(request());
    await expect(res.arrayBuffer()).rejects.toThrow(why);
    expect(proxy.events.at(-1)!.truncated).toBe(true);
  });

  test("delivering other than what's planned aborts: wrong part, too few, too many", async () => {
    const a = fakeInstance("1.1.1", EVRLE, 500), b = fakeInstance("1.1.2", EVRLE, 500);
    const wrong = new FakeBackend([a, b], { plan: true, planOverride: p => [p[1]!, p[0]!] });
    await expect((await proxyOver(wrong).fetch(request())).arrayBuffer()).rejects.toThrow("where its plan has");
    const few = new FakeBackend([a], { plan: true, planOverride: p => [...p, { ...p[0]!, sop: "1.1.9" }] });
    await expect((await proxyOver(few).fetch(request())).arrayBuffer()).rejects.toThrow("planned parts");
    const many = new FakeBackend([a, b], { plan: true, planOverride: p => [p[0]!] });
    await expect((await proxyOver(many).fetch(request())).arrayBuffer()).rejects.toThrow("planned parts");
  });

  test("without a plan, File Meta labels the part, framing is chunked, and no length is sent", async () => {
    const inst = fakeInstance("1.1.1", JPEG, 6000);
    const b = new FakeBackend([inst]);
    const c = rawClient((await serving(proxyOver(b))).port, undefined, { "Accept-Encoding": "zstd" });
    await c.closed;
    expect(c.header("transfer-encoding")).toBe("chunked");
    expect(c.header("content-length")).toBeUndefined();
    expect(c.header("content-encoding")).toBeUndefined();
    expect(c.header("vary")).toBeUndefined();
    const text = Buffer.from(concat(c.received)).toString("latin1");
    expect(text).toContain(`Content-Type: application/dicom; transfer-syntax=${JPEG}\r\n\r\n`);
    expect(text).toContain("--\r\n");
  });
});

describe("raw zstd frames", () => {
  const sizes = [0, 1, 255, 256, 65791, RAW_BLOCK_MAX - 1, RAW_BLOCK_MAX, RAW_BLOCK_MAX + 1, 2 * RAW_BLOCK_MAX, 1_000_000];
  const content = (n: number) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = (i * 31) & 0xff; return b; };
  const zstdCli = Bun.which("zstd");
  const decodeWithCli = (encoded: Uint8Array) => {
    const dir = mkdtempSync(join(tmpdir(), "raw-frames-"));
    try {
      const file = join(dir, "x.zst");
      writeFileSync(file, encoded);
      const r = Bun.spawnSync([zstdCli!, "-d", "-c", "--no-progress", file], { stdout: "pipe", stderr: "pipe" });
      if (r.exitCode !== 0) throw new Error(r.stderr.toString());
      return new Uint8Array(r.stdout);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  /** Bun's streaming decoder: what `fetch` uses on a `Content-Encoding: zstd` response. */
  const decodeWithBunStream = async (encoded: Uint8Array) => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(encoded, { headers: { "Content-Encoding": "zstd" } }) });
    try { return new Uint8Array(await (await fetch(`http://127.0.0.1:${server.port}/`, { headers: { "Accept-Encoding": "zstd" } })).arrayBuffer()); }
    finally { server.stop(true); }
  };

  test("are exactly the size computed, whatever chunks they're fed", () => {
    for (const n of sizes) for (const chunk of [1000, 77_777, RAW_BLOCK_MAX, 300_000]) {
      const src = content(n);
      const w = new RawFrameWriter(n);
      const out = [w.start()];
      for (let at = 0; at < n; at += chunk) out.push(...w.push(src.subarray(at, Math.min(n, at + chunk))));
      w.finish();
      expect(concat(out).length).toBe(rawFrameSize(n));
      expect(rawFrame(src).length).toBe(rawFrameSize(n));
    }
  });
  test("each block is at most 128 KB, and only the last says so", () => {
    const encoded = rawFrame(content(3 * RAW_BLOCK_MAX + 5));
    let at = 14; const seen: [number, boolean][] = [];
    while (at < encoded.length) {
      const h = encoded[at]! | (encoded[at + 1]! << 8) | (encoded[at + 2]! << 16);
      expect((h >> 1) & 3).toBe(0);
      seen.push([h >> 3, !!(h & 1)]);
      at += 3 + (h >> 3);
    }
    expect(seen).toEqual([[RAW_BLOCK_MAX, false], [RAW_BLOCK_MAX, false], [RAW_BLOCK_MAX, false], [5, true]]);
  });
  test("a writer refuses more or fewer bytes than it promised", () => {
    expect(() => new RawFrameWriter(2).push(new Uint8Array(3))).toThrow();
    const w = new RawFrameWriter(2); w.push(new Uint8Array(1));
    expect(() => w.finish()).toThrow();
  });
  test("real decoders accept them, alone and beside compressed frames", async () => {
    for (const n of sizes) {
      const src = content(n);
      expect(Buffer.from(Bun.zstdDecompressSync(rawFrame(src))).equals(Buffer.from(src))).toBe(true);
      expect(Buffer.from(await decodeWithBunStream(rawFrame(src))).equals(Buffer.from(src))).toBe(true);
      if (zstdCli) expect(Buffer.from(decodeWithCli(rawFrame(src))).equals(Buffer.from(src))).toBe(true);
    }
    const a = content(200_000), b = content(50);
    const mixed = concat([rawFrame(a), Bun.zstdCompressSync(b), rawFrame(new Uint8Array(0)), rawFrame(a)]);
    const expected = Buffer.concat([a, b, a]);
    expect(Buffer.from(await decodeWithBunStream(mixed)).equals(expected)).toBe(true);
    if (zstdCli) expect(Buffer.from(decodeWithCli(mixed)).equals(expected)).toBe(true);
  });
  test("a frame far larger than the default decoder window decodes", () => {
    if (!zstdCli) return;
    // 200 MB of one chunk: past libzstd's default limit if the window had been the frame's size.
    const size = 200 * 1024 * 1024, chunk = new Uint8Array(1024 * 1024).fill(3);
    const dir = mkdtempSync(join(tmpdir(), "raw-frames-"));
    try {
      const file = join(dir, "x.zst");
      const w = new RawFrameWriter(size);
      const sink = Bun.file(file).writer();
      sink.write(w.start());
      for (let i = 0; i < 200; i++) for (const p of w.push(chunk)) sink.write(p);
      w.finish();
      sink.end();
      const r = Bun.spawnSync(["sh", "-c", `${zstdCli} -d -c --no-progress ${file} | wc -c`], { stdout: "pipe", stderr: "pipe" });
      expect(r.stdout.toString().trim()).toBe(String(size));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 30000);
});

describe("Accept-Encoding", () => {
  test("zstd needs naming, with a non-zero weight", () => {
    for (const yes of ["zstd", "ZSTD", "gzip, zstd", "gzip;q=1.0, zstd;q=0.5", "zstd;q=1", "zstd; q=0.001", "zstd;q=1.000", "br, zstd ;q=0.1"]) expect([yes, acceptsZstd(yes)]).toEqual([yes, true]);
    for (const no of [null, "", "gzip", "*", "zstd;q=0", "zstd; q=0.000", "zstd;q=0.0", "zstd;q=nonsense", "zstd;q=2", "xzstd", "gzip, zstd;q=0"]) expect([no, acceptsZstd(no)]).toEqual([no, false]);
  });
});

describe("zstd passthrough", () => {
  const study = () => [
    fakeInstance("1.1.1", EVRLE, 700_000, { compressed: true }),
    fakeInstance("1.1.2", JPEG, 300_000), // Stored without a wrapper, since it wouldn't have saved anything.
    fakeInstance("1.1.3", EVRLE, 1000, { compressed: true }),
    fakeInstance("1.1.4", EVRLE, 132 + 8 + 20),
  ];
  const zstdHeaders = { "Accept-Encoding": "gzip, zstd" };
  const wireOf = async (port: number, headers: Record<string, string>) => {
    const c = rawClient(port, undefined, headers);
    await c.closed;
    return { c, body: concat(c.received) };
  };

  test("a client's decoded response is the identical multipart body, byte for byte", async () => {
    const insts = study();
    const server = await serving(proxyOver(new FakeBackend(insts, { plan: true, chunk: 40_000 })));
    const identity = await wireOf(server.port, {});
    const encoded = await wireOf(server.port, zstdHeaders);
    expect(identity.c.header("content-encoding")).toBeUndefined();
    expect(encoded.c.header("content-encoding")).toBe("zstd");
    expect(encoded.c.header("vary")).toBe("Accept-Encoding");
    expect(identity.c.header("vary")).toBe("Accept-Encoding");
    // Exact length on the wire, computed before anything was opened.
    expect(Number(encoded.c.header("content-length"))).toBe(encoded.body.length);
    expect(encoded.c.header("transfer-encoding")).toBeUndefined();
    // Stored frames go through unchanged, so they're on the wire as they were stored.
    expect(Buffer.from(encoded.body).includes(Buffer.from(insts[0]!.zstd!))).toBe(true);

    // Bun's one-shot decoder.
    expect(Buffer.from(Bun.zstdDecompressSync(encoded.body)).equals(Buffer.from(identity.body))).toBe(true);
    // fetch's streaming decoder, through the real server.
    const viaFetch = await fetch(`http://127.0.0.1:${server.port}/wado/${context()}/studies/${STUDY}`, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: ACCEPT, ...zstdHeaders } });
    expect(Buffer.from(await viaFetch.arrayBuffer()).equals(Buffer.from(identity.body))).toBe(true);
    // The zstd command line.
    if (Bun.which("zstd")) {
      const dir = mkdtempSync(join(tmpdir(), "passthrough-"));
      try {
        writeFileSync(join(dir, "r.zst"), encoded.body);
        const r = Bun.spawnSync(["zstd", "-d", "-c", "--no-progress", join(dir, "r.zst")], { stdout: "pipe", stderr: "pipe" });
        expect(r.exitCode).toBe(0);
        expect(Buffer.from(new Uint8Array(r.stdout)).equals(Buffer.from(identity.body))).toBe(true);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });

  test("every part arrives whole, in order, with the parts of the plan", async () => {
    const insts = study();
    const server = await serving(proxyOver(new FakeBackend(insts, { plan: true })));
    const r = await fetch(`http://127.0.0.1:${server.port}/wado/${context()}/studies/${STUDY}`, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: ACCEPT, ...zstdHeaders } });
    const seen: Uint8Array[][] = []; const headers: Record<string, string>[] = []; let complete = false;
    for await (const e of readMultipart(r.body as any, boundaryOf(r.headers.get("content-type"))!)) {
      if (e.type === "start") { seen.push([]); headers.push(e.headers); }
      else if (e.type === "data") seen.at(-1)!.push(e.bytes);
      else if (e.type === "complete") complete = true;
    }
    expect(complete).toBe(true);
    expect(seen.length).toBe(insts.length);
    insts.forEach((inst, i) => {
      expect(Buffer.from(concat(seen[i]!)).equals(Buffer.from(inst.stored!))).toBe(true);
      expect(headers[i]!["content-length"]).toBe(String(inst.size));
      expect(headers[i]!["content-type"]).toContain(inst.syntax);
    });
  });

  test("the backend is offered passthrough only when the client takes it", async () => {
    const offered = async (headers: Record<string, string>) => {
      const b = new FakeBackend(study(), { plan: true });
      const res = await proxyOver(b).fetch(request(headers));
      await res.arrayBuffer();
      return { options: b.options, encoding: res.headers.get("content-encoding") };
    };
    expect(await offered({ "Accept-Encoding": "gzip" })).toEqual({ options: undefined, encoding: null });
    expect(await offered({ "Accept-Encoding": "zstd;q=0" })).toEqual({ options: undefined, encoding: null });
    expect(await offered({ "Accept-Encoding": "zstd" })).toEqual({ options: { passthroughZstd: true }, encoding: "zstd" });
  });

  test("a part whose decoded size isn't planned goes without a part length, and the total is still exact", async () => {
    const insts = [fakeInstance("1.1.1", EVRLE, 40_000, { compressed: true })];
    const server = await serving(proxyOver(new FakeBackend(insts, { plan: true, dropDecoded: true })));
    const { c, body } = await wireOf(server.port, zstdHeaders);
    expect(Number(c.header("content-length"))).toBe(body.length);
    const text = Buffer.from(Bun.zstdDecompressSync(body)).toString("latin1");
    expect(text).toContain(`transfer-syntax=${EVRLE}\r\n\r\n`);
  });

  test("a failure mid-stream is detectable: short of the length, and no closing boundary", async () => {
    const insts = [fakeInstance("1.1.1", EVRLE, 200_000, { compressed: true }), fakeInstance("1.1.2", EVRLE, 400_000)];
    const b = new FakeBackend(insts, { plan: true, failAtPart: 1 });
    const server = await serving(proxyOver(b));
    const { c, body } = await wireOf(server.port, zstdHeaders);
    expect(c.header("content-encoding")).toBe("zstd");
    expect(body.length).toBeLessThan(Number(c.header("content-length")));
    await expect(fetch(`http://127.0.0.1:${server.port}/wado/${context()}/studies/${STUDY}`, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: ACCEPT, ...zstdHeaders } }).then(r => r.arrayBuffer())).rejects.toThrow();
  });

  test("a truncation between whole frames still gets no closing boundary", async () => {
    const insts = [fakeInstance("1.1.1", EVRLE, 5000, { compressed: true })];
    const server = await serving(proxyOver(new FakeBackend(insts, { plan: true, end: "truncated" })));
    const { c, body } = await wireOf(server.port, zstdHeaders);
    expect(body.length).toBeLessThan(Number(c.header("content-length")));
    const boundary = boundaryOf(c.header("content-type") ?? null)!;
    expect(Buffer.from(Bun.zstdDecompressSync(body)).toString("latin1")).not.toContain(`--${boundary}--`);
  });

  test("backpressure holds in zstd, too, with raw frames and stored ones", async () => {
    const b = new FakeBackend(large(40, 8 * 1024 * 1024), { plan: true });
    const res = await proxyOver(b).fetch(request(zstdHeaders));
    const reader = res.body!.getReader();
    let consumed = 0, worst = 0;
    for (let i = 0; i < 300; i++) { const { value } = await reader.read(); consumed += value!.length; worst = Math.max(worst, b.produced - consumed); }
    expect(worst).toBeLessThanOrEqual(2 * CHUNK);
    await reader.cancel();
  });
});

describe("signing keys over HTTP", () => {
  function fixture(opts: { ttl?: number; cooldown?: number } = {}) {
    const state = { keys: [key] as KeyPair[], hits: 0, down: false, asks: 0, clock: 1_000_000 };
    const jwks = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() { state.hits++; return state.down ? new Response(null, { status: 500 }) : Response.json({ keys: state.keys.map(publicJwk) }); } });
    const pdp = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() { state.asks++; return Response.json({ decision: true, context: { release: "study", max_age_seconds: 0 } }); } });
    cleanups.push(() => { jwks.stop(true); pdp.stop(true); });
    const proxy = createProxy({ publicBase: () => "http://proxy", jwksUrl: `http://127.0.0.1:${jwks.port}/.well-known/jwks.json`, jwksTtlSeconds: opts.ttl ?? 60, jwksCooldownSeconds: opts.cooldown ?? 10, jwksClock: () => state.clock, decisionUrl: `http://127.0.0.1:${pdp.port}/access/v1/evaluation`, serviceSecret: "the-service-secret", backend: () => new FakeBackend([fakeInstance("1.1.1", EVRLE, 300)], { plan: true }) });
    const authz = async (ctx = context()) => { const r = await proxy.fetch(request({}, ctx)); await r.arrayBuffer(); return proxy.events.at(-1)!.authz; };
    return { state, proxy, authz };
  }
  const refresh = (proxy: ReturnType<typeof createProxy>, authorization?: string, method = "POST") => proxy.fetch(new Request("http://proxy/internal/keys/refresh", { method, headers: authorization ? { Authorization: authorization } : {} }));

  test("one fetch serves many requests, within the TTL", async () => {
    const f = fixture();
    expect(await f.authz()).toBe("instant");
    expect(await f.authz()).toBe("instant");
    expect(f.state.hits).toBe(1);
    expect(f.state.asks).toBe(0);
  });

  test("a proxy that isn't told stops trusting a rotated key when its copy expires", async () => {
    const f = fixture({ ttl: 60 });
    const old = context();
    expect(await f.authz(old)).toBe("instant");
    const next = generateEd25519("k2");
    f.state.keys = [next];
    f.state.clock += 59_000;
    expect(await f.authz(old)).toBe("instant"); // Still inside the TTL, and it hasn't heard.
    f.state.clock += 2000;
    expect(await f.authz(old)).toBe("asked"); // Past it: refetched, and the old key is gone.
    expect(f.state.hits).toBe(2);
    expect(await f.authz(context(next))).toBe("instant");
  });

  test("an unknown kid refetches, so a new key works at once and the old one ends", async () => {
    const f = fixture();
    await f.authz();
    f.state.clock += 11_000;
    const next = generateEd25519("k2");
    f.state.keys = [next];
    expect(await f.authz(context(next))).toBe("instant");
    expect(f.state.hits).toBe(2);
    expect(await f.authz()).toBe("asked");
  });

  test("random kids can't drive fetches: at most one for each cooldown", async () => {
    const f = fixture({ cooldown: 10 });
    await f.authz();
    f.state.clock += 11_000;
    for (let i = 0; i < 20; i++) expect(await f.authz(context(generateEd25519(`random-${i}`)))).toBe("asked");
    expect(f.state.hits).toBe(2);
    f.state.clock += 11_000;
    expect(await f.authz(context(generateEd25519("random-again")))).toBe("asked");
    expect(f.state.hits).toBe(3);
  });

  test("with keys unavailable the fast path fails closed, and past that it asks", async () => {
    const f = fixture({ ttl: 60, cooldown: 10 });
    f.state.down = true;
    expect(await f.authz()).toBe("asked");
    expect(f.state.hits).toBe(1);
    // A failure has a cooldown as well.
    expect(await f.authz()).toBe("asked");
    expect(f.state.hits).toBe(1);
    f.state.down = false;
    f.state.clock += 11_000;
    expect(await f.authz()).toBe("instant");
  });

  test("held keys don't outlive the TTL when the JWKS is down", async () => {
    const f = fixture({ ttl: 60 });
    expect(await f.authz()).toBe("instant");
    f.state.down = true;
    f.state.clock += 61_000;
    expect(await f.authz()).toBe("asked");
  });

  test("a malformed JWKS is a failure, and other algorithms in it are ignored", async () => {
    let body: unknown = { nope: true };
    const jwks = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json(body) });
    const pdp = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ decision: true, context: { release: "study", max_age_seconds: 0 } }) });
    cleanups.push(() => { jwks.stop(true); pdp.stop(true); });
    let clock = 0;
    const proxy = createProxy({ publicBase: () => "http://proxy", jwksUrl: `http://127.0.0.1:${jwks.port}/`, jwksClock: () => clock, decisionUrl: `http://127.0.0.1:${pdp.port}/`, serviceSecret: "s", backend: () => new FakeBackend([fakeInstance("1.1.1", EVRLE, 300)], { plan: true }) });
    await (await proxy.fetch(request())).arrayBuffer();
    expect(proxy.events.at(-1)!.authz).toBe("asked");
    clock += 11_000;
    body = { keys: [{ ...publicJwk(key), kty: "RSA" }, { ...publicJwk(key), crv: "Ed448" }] };
    await (await proxy.fetch(request())).arrayBuffer();
    expect(proxy.events.at(-1)!.authz).toBe("asked");
  });

  test("the refresh endpoint needs the service credential, and POST", async () => {
    const f = fixture();
    expect((await refresh(f.proxy)).status).toBe(401);
    expect((await refresh(f.proxy, "Bearer wrong")).status).toBe(401);
    expect((await refresh(f.proxy, "Bearer the-service-secret", "GET")).status).toBe(405);
    expect(f.state.hits).toBe(0);
    expect((await refresh(f.proxy, "Bearer the-service-secret")).status).toBe(204);
    expect(f.state.hits).toBe(1);
  });

  test("being told ends the old key at once, and isn't held back by the cooldown", async () => {
    const f = fixture();
    const old = context();
    expect(await f.authz(old)).toBe("instant");
    f.state.keys = [generateEd25519("k2")];
    expect((await refresh(f.proxy, "Bearer the-service-secret")).status).toBe(204);
    expect(await f.authz(old)).toBe("asked");
    expect((await refresh(f.proxy, "Bearer the-service-secret")).status).toBe(204);
    expect(f.state.hits).toBe(3);
  });

  test("being told while the JWKS is down drops every key", async () => {
    const f = fixture();
    expect(await f.authz()).toBe("instant");
    f.state.down = true;
    expect((await refresh(f.proxy, "Bearer the-service-secret")).status).toBe(503);
    expect(await f.authz()).toBe("asked");
  });

  test("a key map still works, for tests", async () => {
    const proxy = proxyOver(new FakeBackend([fakeInstance("1.1.1", EVRLE, 300)], { plan: true }));
    await (await proxy.fetch(request())).arrayBuffer();
    expect(proxy.events.at(-1)!.authz).toBe("instant");
  });
});

describe("study version", () => {
  const withPdp = (context_: object) => {
    const pdp = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ decision: true, context: { release: "study", max_age_seconds: 30, ...context_ } }) });
    cleanups.push(() => pdp.stop(true));
    const backend = new FakeBackend([fakeInstance("1.1.1", EVRLE, 300)], { plan: true });
    const proxy = createProxy({ publicBase: () => "http://proxy", keys: new Map([[key.kid, key.publicKey]]), decisionUrl: `http://127.0.0.1:${pdp.port}/x`, serviceSecret: "s", backend: () => backend });
    return { proxy, backend };
  };
  const plain = () => new Request(`http://proxy/wado/-/studies/${STUDY}`, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: ACCEPT } });

  test("a signed context's ver reaches the backend's scope", async () => {
    const b = new FakeBackend([fakeInstance("1.1.1", EVRLE, 300)], { plan: true });
    await (await proxyOver(b).fetch(request({}, context(key, { ver: 3 })))).arrayBuffer();
    expect(b.scope!.version).toBe(3);
  });
  test("a can_i answer's version reaches it, and survives the decision cache", async () => {
    const { proxy, backend } = withPdp({ version: 7 });
    await (await proxy.fetch(plain())).arrayBuffer();
    expect(proxy.events.at(-1)!.authz).toBe("asked");
    expect(backend.scope!.version).toBe(7);
    backend.scope = undefined;
    await (await proxy.fetch(plain())).arrayBuffer();
    expect(proxy.events.at(-1)!.authz).toBe("cached");
    expect(backend.scope!.version).toBe(7);
  });
  test("with neither, the scope has no version at all", async () => {
    const b = new FakeBackend([fakeInstance("1.1.1", EVRLE, 300)], { plan: true });
    await (await proxyOver(b).fetch(request())).arrayBuffer();
    expect("version" in b.scope!).toBe(false);
    const { proxy, backend } = withPdp({});
    await (await proxy.fetch(plain())).arrayBuffer();
    expect("version" in backend.scope!).toBe(false);
  });
  test("metadata and bulk see the version too", async () => {
    const b = new FakeBackend([fakeInstance("1.1.1", EVRLE, 300)], { plan: true });
    const proxy = proxyOver(b);
    const ctx = context(key, { ver: 4 });
    await (await proxy.fetch(request({ Accept: "application/dicom+json" }, ctx, "/metadata"))).arrayBuffer();
    expect(b.scope!.version).toBe(4);
    await (await proxy.fetch(request({ Accept: "*/*" }, ctx, "/series/9/instances/8/bulk/7FE00010"))).arrayBuffer();
    expect(b.bulkVersion).toBe(4);
  });
  test("a version that isn't one is refused, and never reaches the backend", async () => {
    const { proxy, backend } = withPdp({ version: "three" });
    expect((await proxy.fetch(plain())).status).toBe(503);
    expect(backend.scope).toBeUndefined();
    // A signed context with a bad version leaves the fast path, and is then decided by asking.
    const signed = await proxy.fetch(request({}, context(key, { ver: -1 })));
    expect(signed.status).toBe(503);
    expect(proxy.events.at(-1)!.authz).toBe("asked");
  });
});

describe("bulk data", () => {
  const PATH = "/series/9/instances/8/bulk/7FE00010";
  const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])];
  /** A backend whose bulk element states `bytes`, and yields `chunks`. */
  const bulkProxy = (bytes: number | undefined, tail?: () => void) => {
    const b = new FakeBackend([], { plan: true });
    b.openBulk = async () => ({ ...(bytes !== undefined ? { bytes } : {}), body: (async function* () { try { yield* chunks; } finally { tail?.(); } })() });
    return proxyOver(b);
  };
  const ask = (proxy: ReturnType<typeof bulkProxy>, accept: string) => proxy.fetch(request({ Accept: accept }, context(), PATH));
  test("multipart by default, with exact lengths at both levels", async () => {
    const r = await ask(bulkProxy(5), "*/*");
    const raw = new Uint8Array(await r.arrayBuffer());
    const boundary = boundaryOf(r.headers.get("content-type"))!;
    expect(r.headers.get("content-type")).toBe(`multipart/related; type="application/octet-stream"; boundary=${boundary}`);
    expect(r.headers.get("content-length")).toBe(String(raw.length));
    expect(new TextDecoder("latin1").decode(raw)).toBe(`--${boundary}\r\nContent-Type: application/octet-stream\r\nContent-Length: 5\r\n\r\n\x01\x02\x03\x04\x05\r\n--${boundary}--\r\n`);
  });
  test("single part when asked, with just the bytes", async () => {
    const r = await ask(bulkProxy(5), "application/octet-stream");
    expect(r.headers.get("content-type")).toBe("application/octet-stream");
    expect(r.headers.get("content-length")).toBe("5");
    expect([...new Uint8Array(await r.arrayBuffer())]).toEqual([1, 2, 3, 4, 5]);
  });
  test("a length nobody knows isn't stated", async () => {
    for (const accept of ["*/*", "application/octet-stream"]) {
      const r = await ask(bulkProxy(undefined), accept);
      expect(r.headers.get("content-length")).toBeNull();
      expect((await r.arrayBuffer()).byteLength).toBeGreaterThanOrEqual(5);
    }
  });
  test("an element that doesn't match its stated length aborts, and a multipart one never closes", async () => {
    for (const bytes of [4, 6]) for (const accept of ["*/*", "application/octet-stream"]) {
      const r = await ask(bulkProxy(bytes), accept);
      expect(r.status).toBe(200);
      expect(r.arrayBuffer()).rejects.toThrow("stated");
    }
  });
  test("nothing acceptable is 406, before the backend opens anything", async () => {
    const b = new FakeBackend([], { plan: true });
    let opened = false;
    b.openBulk = async () => { opened = true; throw new Error("must not open"); };
    for (const accept of ["image/png", "application/dicom", "application/octet-stream;q=0"]) expect((await proxyOver(b).fetch(request({ Accept: accept }, context(), PATH))).status).toBe(406);
    expect(opened).toBe(false);
  });
  test("a client that hangs up closes the element", async () => {
    let closed = false;
    const r = await ask(bulkProxy(5, () => { closed = true; }), "application/octet-stream");
    const reader = r.body!.getReader();
    await reader.read(); // The empty head is skipped, so this is the first chunk.
    await reader.cancel();
    await Bun.sleep(5);
    expect(closed).toBe(true);
  });
});

describe("what the proxy holds", () => {
  const pdpFor = (ageSeconds: number) => {
    const pdp = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ decision: true, context: { release: "study", max_age_seconds: ageSeconds } }) });
    cleanups.push(() => pdp.stop(true));
    return `http://127.0.0.1:${pdp.port}/x`;
  };
  const ask = (token: string) => new Request(`http://proxy/wado/-/studies/${STUDY}`, { headers: { Authorization: `Bearer ${token}`, Accept: ACCEPT } });
  const make = (decisionUrl: string, limits: { maxDecisions?: number; maxEvents?: number }) => createProxy({ publicBase: () => "http://proxy", keys: new Map(), decisionUrl, serviceSecret: "s", backend: () => new FakeBackend([fakeInstance("1.1.1", EVRLE, 300)], { plan: true }), ...limits });

  test("the decision cache stays within its count, dropping the oldest", async () => {
    const proxy = make(pdpFor(300), { maxDecisions: 3 });
    for (let i = 0; i < 6; i++) await (await proxy.fetch(ask(`t${i}`))).arrayBuffer();
    expect(proxy.cachedDecisions).toBe(3);
    await (await proxy.fetch(ask("t5"))).arrayBuffer();
    expect(proxy.events.at(-1)!.authz).toBe("cached");
    await (await proxy.fetch(ask("t0"))).arrayBuffer();
    expect(proxy.events.at(-1)!.authz).toBe("asked");
  });
  test("expired decisions go first, and an expired one found by lookup is removed", async () => {
    const proxy = make(pdpFor(10), { maxDecisions: 3 });
    for (let i = 0; i < 3; i++) await (await proxy.fetch(ask(`t${i}`))).arrayBuffer();
    advance(11);
    await (await proxy.fetch(ask("fresh"))).arrayBuffer();
    expect(proxy.cachedDecisions).toBe(1);
    advance(11);
    await (await proxy.fetch(ask("fresh"))).arrayBuffer();
    expect(proxy.events.at(-1)!.authz).toBe("asked");
    expect(proxy.cachedDecisions).toBe(1);
  });
  test("the event log stays within its count", async () => {
    const proxy = make(pdpFor(0), { maxEvents: 4 });
    for (let i = 0; i < 10; i++) await (await proxy.fetch(ask("t"))).arrayBuffer();
    expect(proxy.events.length).toBe(4);
    expect(proxy.events.at(-1)!.id).toBe(10);
  });
  test("nothing is left behind by retrieving a study", async () => {
    const proxy = proxyOver(new FakeBackend(large(3, 300_000), { plan: true }));
    for (let i = 0; i < 5; i++) await (await proxy.fetch(request())).arrayBuffer();
    expect(proxy.cachedDecisions).toBe(0);
    expect(proxy.events.length).toBe(5);
  });
});

test("a 404 from the backend is a status, on the real server too", async () => {
  const notFound: Backend = { ...new FakeBackend([]), capabilities: () => new FakeBackend([]).capabilities(), listSeries: async () => [], openInstances: async () => { throw new BackendError("NotFound"); }, getMetadata: async () => [], openBulk: async () => { throw new BackendError("NotFound"); } };
  const server = await serving(proxyOver(notFound));
  const r = await fetch(`http://127.0.0.1:${server.port}/wado/${context()}/studies/${STUDY}`, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: ACCEPT } });
  expect(r.status).toBe(404);
  expect((await fetch(`http://127.0.0.1:${server.port}/wado/-/studies/${STUDY}`)).status).toBe(401);
});
