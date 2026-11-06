// The god-mode collector. It stores spans by session and streams them live over SSE.
import { join } from "node:path";
import type { SpanRecord } from "./trace";

const MAX_PER_SESSION = 20000, MAX_SESSIONS = 100;

export function createCollector(root: string) {
  const sessions = new Map<string, { id: string; startedAt: number; lastAt: number; spans: Map<string, SpanRecord> }>();
  const clients = new Set<{ session?: string; send: (s: string) => void }>();
  let seq = 0;

  function ingest(records: SpanRecord[]) {
    for (const r of records) {
      let s = sessions.get(r.session);
      if (!s) {
        s = { id: r.session, startedAt: r.start, lastAt: r.start, spans: new Map() };
        sessions.set(r.session, s);
        if (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
        for (const c of clients) c.send(`event: session\ndata: ${JSON.stringify({ id: s.id, startedAt: s.startedAt })}\n\n`);
      }
      r.seq = ++seq;
      s.lastAt = Math.max(s.lastAt, r.end ?? r.start);
      if (s.spans.size < MAX_PER_SESSION || s.spans.has(r.span)) s.spans.set(r.span, r);
      for (const c of clients) if (!c.session || c.session === r.session) c.send(`event: span\ndata: ${JSON.stringify(r)}\n\n`);
    }
  }
  const list = () => [...sessions.values()].map(s => ({ id: s.id, startedAt: s.startedAt, lastAt: s.lastAt, spans: s.spans.size })).sort((a, b) => b.lastAt - a.lastAt);

  const fetchHandler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const p = url.pathname;
    if (p === "/v1/spans" && req.method === "POST") { ingest(await req.json() as SpanRecord[]); return new Response(null, { status: 202 }); }
    if (p === "/" || p === "/live") return new Response(Bun.file(join(root, "web/live.html")));
    if (p === "/live.js") return new Response(Bun.file(join(root, "web/live.js")));
    if (p === "/live.css") return new Response(Bun.file(join(root, "web/live.css")));
    if (p === "/api/sessions") return Response.json(list());
    const m = p.match(/^\/api\/sessions\/([^/]+)\/spans$/);
    if (m) {
      const s = sessions.get(decodeURIComponent(m[1]!));
      return Response.json(s ? [...s.spans.values()].sort((a, b) => a.start - b.start) : []);
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
  return { fetch: fetchHandler, sessions, list };
}
