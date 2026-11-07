// What the demo's live trace records of the proxy's streams: core's spans through traceObserver.
import { afterEach, describe, expect, test } from "bun:test";
import { createProxy, type Backend } from "@smart-imaging-proxy/core";
import { demoClock } from "../src/clock";
import { flushTraces, setTraceSink, traceObserver, type SpanRecord } from "../src/trace";
import { EVRLE, FakeBackend, fakeInstance, key, large, request, sleep, until } from "../packages/core/tests/fake-backend";

const proxyOver = (backend: Backend) => createProxy({ publicBase: () => "http://proxy", keys: new Map([[key.kid, key.publicKey]]), decisionUrl: "http://127.0.0.1:1/none", serviceSecret: "s", backend: () => backend, observer: traceObserver, clock: demoClock });
const cleanups: (() => void)[] = [];
afterEach(() => { for (const c of cleanups.splice(0)) c(); });

describe("spans measure delivery", () => {
  /** The latest version of each span the proxy reported, from a real trace sink. */
  async function collecting(run: () => Promise<void>) {
    const seen = new Map<string, SpanRecord>();
    const sink = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) { if (new URL(req.url).pathname === "/v1/spans") for (const r of await req.json() as SpanRecord[]) seen.set(r.span, r); return new Response(null, { status: 204 }); } });
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
