// The god-mode collector. It takes spans from the services, streams them live over SSE, and keeps
// them in a TraceStore. The stream doesn't depend on the store, so a storage problem can't stop it.
// Its pages are the demo's: this service serves only data, and sends its old page addresses there.
import { LISTEN_HOSTS, PORTS, TAILNET, urlsFor } from "./config";
import { sameSecret } from "@smart-imaging-proxy/core";
import { KINDS, OUTCOMES, sandboxOfSession, SERVICES, STATUSES, type EventRecord, type SpanRecord } from "./trace";
import { summaryOf, TraceStore, type EventQuery, type TraceStoreConfig } from "./trace-store";

/** The pages this service once served, and where each is now, under the demo's `/trace/`. */
const MOVED: Record<string, string> = { "/": "/", "/live": "/", "/span.html": "/span", "/log.html": "/log" };

const json = (text: string) => new Response(text, { headers: { "content-type": "application/json;charset=utf-8" } });
const publicSession = ({ id, startedAt, lastAt, spans }: { id: string; startedAt: number; lastAt: number; spans: number }) => ({ id, startedAt, lastAt, spans });
/** Traces are read and changed only through this service's own addresses, so a rebinding page can do neither. */
const ownHosts = () => [...LISTEN_HOSTS.map(h => `${h}:${PORTS.trace}`), `localhost:${PORTS.trace}`, ...(TAILNET ? [`${TAILNET.name}:${PORTS.trace}`] : [])];
// A browser always sends Host, so only a rebinding page's own name has to be refused.
const ownHost = (req: Request) => { const h = req.headers.get("host"); return !h || ownHosts().includes(h); };
const sameOrigin = (req: Request, url: URL) => { const o = req.headers.get("origin"); return !o || o === url.origin; };

/** Well above what a service sends at once: its bodies are capped at capture, and it sends every 25 ms. */
export const MAX_SPANS_BODY = 32 * 1024 * 1024;
const bad = (why: string, status = 400) => new Response(why, { status });
const isObject = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown) => typeof v === "string" && v.length > 0;
const isTime = (v: unknown) => typeof v === "number" && Number.isFinite(v);
const messageProblem = (m: unknown) => isObject(m) && isObject(m.headers) ? undefined : "must have headers";
function httpProblem(h: unknown) {
  if (!isObject(h)) return "http must be an object";
  if (!isText(h.method) || !isText(h.url)) return "http needs a method and a url";
  if (h.status !== undefined && !isTime(h.status)) return "http.status must be a number";
  if (messageProblem(h.request)) return `http.request ${messageProblem(h.request)}`;
  if (h.response !== undefined && messageProblem(h.response)) return `http.response ${messageProblem(h.response)}`;
}
/** Why the store couldn't keep this as a span, if so. */
function spanProblem(r: unknown) {
  if (!isObject(r)) return "a span must be an object";
  for (const k of ["session", "trace", "span", "name"]) if (!isText(r[k])) return `${k} must be a non-empty string`;
  if (!SERVICES.includes(r.service)) return "service isn't one of the demo's services";
  if (!KINDS.includes(r.kind)) return `kind must be one of ${KINDS.join(", ")}`;
  if (!isTime(r.start)) return "start must be a number";
  if (r.end !== undefined && !isTime(r.end)) return "end must be a number";
  if (r.parent !== undefined && typeof r.parent !== "string") return "parent must be a string";
  if (r.status !== undefined && !STATUSES.includes(r.status)) return `status must be one of ${STATUSES.join(", ")}`;
  if (!isObject(r.attrs)) return "attrs must be an object";
  if (r.sandbox !== undefined && !isText(r.sandbox)) return "sandbox must be a non-empty string";
  if (sandboxOfSession(r.session) !== r.sandbox) return "the session must be its sandbox's own";
  if (r.http !== undefined) return httpProblem(r.http);
}
/** Why the store couldn't keep this as an event, if so. */
function eventProblem(r: unknown) {
  if (!isObject(r)) return "an event must be an object";
  for (const k of ["session", "trace", "kind"]) if (!isText(r[k])) return `${k} must be a non-empty string`;
  if (!SERVICES.includes(r.service)) return "service isn't one of the demo's services";
  if (!OUTCOMES.includes(r.outcome)) return `outcome must be one of ${OUTCOMES.join(", ")}`;
  if (!isTime(r.at)) return "at must be a number";
  if (!Array.isArray(r.links) || !r.links.every((l: unknown) => isText(l) && !/\s/.test(l as string))) return "links must be a list of values without spaces";
  if (!isObject(r.data)) return "data must be an object";
  for (const k of ["span", "who", "sandbox"]) if (r[k] !== undefined && !isText(r[k])) return `${k} must be a non-empty string`;
  if (sandboxOfSession(r.session) !== r.sandbox) return "the session must be its sandbox's own";
}
/** The filters `/api/events` takes. */
export function eventQueryOf(url: URL): EventQuery {
  const q: EventQuery = {};
  for (const k of ["session", "kind", "outcome", "who", "trace", "link"] as const) { const v = url.searchParams.get(k); if (v) q[k] = v; }
  // `-` is the root's alone.
  const sandbox = url.searchParams.get("sandbox");
  if (sandbox) q.sandbox = sandbox === "-" ? "" : sandbox;
  for (const k of ["after", "before", "limit"] as const) { const v = Number(url.searchParams.get(k)); if (url.searchParams.has(k) && Number.isInteger(v)) q[k] = v; }
  return q;
}
const decodable = (path: string) => { try { decodeURIComponent(path); return true; } catch { return false; } };

/**
 * With no store config, traces are in memory: only src/main.ts reads the TRACE_* settings. Spans come in
 * only with `spanSecret`, which the services hold, and none at all without one. Served for a sandbox, it
 * shows only that sandbox's sessions, and takes no spans. It reads no files, so `_root` goes unused.
 */
export function createCollector(_root: string, config: TraceStoreConfig = { mode: "memory" }, spanSecret?: string) {
  const store = new TraceStore(config);
  const clients = new Set<{ session?: string; sandbox?: string; send: (s: string) => void }>();
  const sandboxOf = sandboxOfSession;
  let seq = store.maxSeq();
  const broadcast = (event: string, data: unknown, session?: string) => { for (const c of clients) if (!c.sandbox || (session !== undefined && sandboxOf(session) === c.sandbox)) c.send(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  store.onRemoved = ids => broadcast("removed", ids);

  function ingest(records: SpanRecord[]) {
    for (const r of records) {
      if (!store.knows(r.session)) broadcast("session", { id: r.session, startedAt: r.start, lastAt: r.start, spans: 0 }, r.session);
      r.seq = ++seq;
      const summary = JSON.stringify(summaryOf(r));
      store.put(r, summary);
      for (const c of clients) if ((!c.session || c.session === r.session) && (!c.sandbox || sandboxOf(r.session) === c.sandbox)) c.send(`event: span\ndata: ${summary}\n\n`);
    }
  }
  const list = (sandbox?: string) => store.sessions().filter(s => !sandbox || sandboxOf(s.id) === sandbox).map(publicSession);

  const fetchHandler = async (req: Request, sandbox?: string): Promise<Response> => {
    const url = new URL(req.url);
    const p = url.pathname;
    if (!ownHost(req)) return new Response("this service answers only at its own addresses", { status: 403 });
    // A sandbox's view reads only its own sessions, and changes nothing.
    if (sandbox && (p === "/v1/spans" || p === "/v1/events" || req.method !== "GET")) return new Response("not found", { status: 404 });
    if (p === "/v1/events" && req.method === "POST") {
      if (req.headers.get("origin")) return new Response(null, { status: 403 });
      if (!sameSecret(req.headers.get("authorization")?.match(/^bearer +(.+)$/i)?.[1], spanSecret)) return new Response(null, { status: 401 });
      const text = await req.text();
      if (text.length > MAX_SPANS_BODY) return bad("too many events at once", 413);
      let records: unknown;
      try { records = JSON.parse(text); } catch { return bad("the request body must be valid JSON"); }
      if (!Array.isArray(records)) return bad("the request body must be a JSON array of events");
      for (const [i, r] of records.entries()) { const problem = eventProblem(r); if (problem) return bad(`event ${i}: ${problem}`); }
      store.putEvents(records as EventRecord[]);
      for (const r of records as EventRecord[]) for (const c of clients) if ((!c.session || c.session === r.session) && (!c.sandbox || r.sandbox === c.sandbox)) c.send(`event: event\ndata: ${JSON.stringify(r)}\n\n`);
      return new Response(null, { status: 202 });
    }
    // A sandbox's view lists only its own events.
    if (p === "/api/events") { const q = eventQueryOf(url); return Response.json({ events: store.events(sandbox ? { ...q, sandbox } : q), facets: store.eventFacets(sandbox) }); }
    const session = p.match(/^\/api\/sessions\/([^/]+)\//)?.[1];
    if (sandbox && session && decodable(session) && sandboxOf(decodeURIComponent(session)) !== sandbox) return new Response("not found", { status: 404 });
    if (p === "/v1/spans" && req.method === "POST") {
      // Services send spans. A browser always names an origin, and has no reason to send any.
      if (req.headers.get("origin")) return new Response(null, { status: 403 });
      if (!sameSecret(req.headers.get("authorization")?.match(/^bearer +(.+)$/i)?.[1], spanSecret)) return new Response(null, { status: 401 });
      if (Number(req.headers.get("content-length") ?? 0) > MAX_SPANS_BODY) return bad("too many spans at once", 413);
      const text = await req.text();
      if (text.length > MAX_SPANS_BODY) return bad("too many spans at once", 413);
      let records: unknown;
      try { records = JSON.parse(text); } catch { return bad("the request body must be valid JSON"); }
      if (!Array.isArray(records)) return bad("the request body must be a JSON array of spans");
      for (const [i, r] of records.entries()) { const problem = spanProblem(r); if (problem) return bad(`span ${i}: ${problem}`); }
      ingest(records);
      return new Response(null, { status: 202 });
    }
    const moved = MOVED[p];
    if (moved) return new Response(null, { status: 302, headers: { location: `${urlsFor(sandbox ? `/s/${sandbox}` : "").demo}/trace${moved}${url.search}` } });
    if (p === "/api/stats") return Response.json(store.stats());
    if (p === "/api/sessions" && req.method === "DELETE") {
      if (!sameOrigin(req, url)) return new Response("cross-origin requests can't clear traces", { status: 403 });
      store.clear();
      broadcast("cleared", {});
      return new Response(null, { status: 204 });
    }
    if (p === "/api/sessions") return Response.json(list(sandbox));
    if (p.startsWith("/api/sessions/") && !decodable(p)) return bad("that session name isn't valid percent-encoding");
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
      let client: { session?: string; sandbox?: string; send: (s: string) => void };
      let ping: ReturnType<typeof setInterval>;
      const body = new ReadableStream({
        start(c) {
          const enc = new TextEncoder();
          client = { session, sandbox, send: s => { try { c.enqueue(enc.encode(s)); } catch { clients.delete(client); } } };
          clients.add(client);
          client.send(`event: hello\ndata: ${JSON.stringify(list(sandbox))}\n\n`);
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
  return { fetch: fetchHandler, sessions, list, sandboxOf, store, close: () => store.close() };
}
