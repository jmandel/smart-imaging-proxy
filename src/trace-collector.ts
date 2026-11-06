// The god-mode collector. It takes spans from the services, streams them live over SSE, and keeps
// them in a TraceStore. The stream doesn't depend on the store, so a storage problem can't stop it.
import { join } from "node:path";
import type { SpanRecord } from "./trace";
import { summaryOf, TraceStore, type TraceStoreConfig } from "./trace-store";

const PAGES: Record<string, string> = { "/live.js": "web/live.js", "/live.css": "web/live.css", "/trace-view.js": "web/trace-view.js", "/span.html": "web/span.html", "/span.js": "web/span.js", "/log.html": "web/log.html", "/log.js": "web/log.js" };

const json = (text: string) => new Response(text, { headers: { "content-type": "application/json;charset=utf-8" } });
const publicSession = ({ id, startedAt, lastAt, spans }: { id: string; startedAt: number; lastAt: number; spans: number }) => ({ id, startedAt, lastAt, spans });
/** A cross-site page can't clear traces. */
const sameOrigin = (req: Request, url: URL) => { const o = req.headers.get("origin"); return !o || o === url.origin; };

/** With no store config, traces are in memory: only src/main.ts reads the TRACE_* settings. */
export function createCollector(root: string, config: TraceStoreConfig = { mode: "memory" }) {
  const store = new TraceStore(config);
  const clients = new Set<{ session?: string; send: (s: string) => void }>();
  let seq = store.maxSeq();
  const broadcast = (event: string, data: unknown) => { for (const c of clients) c.send(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  store.onRemoved = ids => broadcast("removed", ids);

  function ingest(records: SpanRecord[]) {
    for (const r of records) {
      if (!store.knows(r.session)) broadcast("session", { id: r.session, startedAt: r.start, lastAt: r.start, spans: 0 });
      r.seq = ++seq;
      const summary = JSON.stringify(summaryOf(r));
      store.put(r, summary);
      for (const c of clients) if (!c.session || c.session === r.session) c.send(`event: span\ndata: ${summary}\n\n`);
    }
  }
  const list = () => store.sessions().map(publicSession);

  const page = (file: string) => new Response(Bun.file(join(root, file)), { headers: { "cache-control": "no-cache" } });
  const fetchHandler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const p = url.pathname;
    if (p === "/v1/spans" && req.method === "POST") { ingest(await req.json() as SpanRecord[]); return new Response(null, { status: 202 }); }
    if (p === "/" || p === "/live") return page("web/live.html");
    if (PAGES[p]) return page(PAGES[p]!);
    if (p === "/api/stats") return Response.json(store.stats());
    if (p === "/api/sessions" && req.method === "DELETE") {
      if (!sameOrigin(req, url)) return new Response("cross-origin requests can't clear traces", { status: 403 });
      store.clear();
      broadcast("cleared", {});
      return new Response(null, { status: 204 });
    }
    if (p === "/api/sessions") return Response.json(list());
    const m = p.match(/^\/api\/sessions\/([^/]+)\/spans$/);
    if (m) return json(store.summariesJson(decodeURIComponent(m[1]!)));
    const log = p.match(/^\/api\/sessions\/([^/]+)\/http$/);
    if (log) return Response.json(store.httpLog(decodeURIComponent(log[1]!), url.searchParams.get("trace") ?? undefined));
    const one = p.match(/^\/api\/sessions\/([^/]+)\/spans\/([^/]+)$/);
    if (one) {
      const r = store.span(decodeURIComponent(one[1]!), one[2]!);
      return r ? Response.json(r) : new Response("not found", { status: 404 });
    }
    const exported = p.match(/^\/api\/sessions\/([^/]+)\/export$/);
    if (exported) {
      const id = decodeURIComponent(exported[1]!);
      const info = store.session(id);
      if (!info) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify({ session: publicSession(info), exportedAt: new Date().toISOString(), spans: store.fullSession(id) }, null, 1), {
        headers: { "content-type": "application/json;charset=utf-8", "content-disposition": `attachment; filename="trace-${id.replace(/[^A-Za-z0-9._-]/g, "_")}.json"` },
      });
    }
    if (p === "/stream") {
      const session = url.searchParams.get("session") ?? undefined;
      let client: { session?: string; send: (s: string) => void };
      let ping: ReturnType<typeof setInterval>;
      const body = new ReadableStream({
        start(c) {
          const enc = new TextEncoder();
          client = { session, send: s => { try { c.enqueue(enc.encode(s)); } catch { clients.delete(client); } } };
          clients.add(client);
          client.send(`event: hello\ndata: ${JSON.stringify(list())}\n\n`);
          ping = setInterval(() => client.send(": ping\n\n"), 15000);
        },
        cancel() { clients.delete(client); clearInterval(ping); },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
    }
    return new Response("not found", { status: 404 });
  };
  /** Whole sessions as maps, read from the store. Tests read spans this way. */
  const sessions = {
    get(id: string) {
      const info = store.session(id);
      return info && { ...info, spans: new Map(store.fullSession(id).map(r => [r.span, r])) };
    },
    has: (id: string) => !!store.session(id),
  };
  return { fetch: fetchHandler, sessions, list, store, close: () => store.close() };
}
