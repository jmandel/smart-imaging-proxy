// Tracing for the demo. A session groups everything in one flow run. A trace is one user
// action. Spans carry W3C traceparent across HTTP, and a baggage entry carries the session.
// Secrets are never recorded: attributes hold token hash prefixes only.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

export type Service = "user" | "app" | "authorization-server" | "imaging-fhir" | "policy" | "dicomweb-proxy" | "backend" | "demo";
export type Kind = "action" | "server" | "client" | "internal" | "check";

export interface SpanRecord {
  session: string; trace: string; span: string; parent?: string;
  service: Service; kind: Kind; name: string; start: number; end?: number;
  status?: "ok" | "error" | "denied"; attrs: Record<string, unknown>; seq?: number;
}
interface Current { session: string; trace: string; span: string; }
const als = new AsyncLocalStorage<Current>();

let buffer: SpanRecord[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
let sinkUrl: string | undefined;
export const setTraceSink = (url: string) => { sinkUrl = url; };
const flush = () => {
  timer = undefined;
  if (!sinkUrl || !buffer.length) { buffer = []; return; }
  const body = JSON.stringify(buffer);
  buffer = [];
  fetch(`${sinkUrl}/v1/spans`, { method: "POST", headers: { "content-type": "application/json" }, body }).catch(() => {});
};
const emit = (s: SpanRecord) => { buffer.push({ ...s, attrs: { ...s.attrs } }); timer ??= setTimeout(flush, 25); };
export const flushTraces = () => { if (timer) clearTimeout(timer); flush(); };

const hex = (n: number) => randomBytes(n).toString("hex");
const nowMs = () => performance.timeOrigin + performance.now();

export interface SpanHandle { record: SpanRecord; ctx: Current; end(status?: SpanRecord["status"], attrs?: Record<string, unknown>): void; set(attrs: Record<string, unknown>): void; }

export function startSpan(service: Service, kind: Kind, name: string, attrs: Record<string, unknown> = {}, ctx?: Partial<Current>): SpanHandle {
  const p = ctx ?? als.getStore();
  const record: SpanRecord = { session: p?.session ?? "unattributed", trace: p?.trace ?? hex(16), span: hex(8), parent: p?.span, service, kind, name, start: nowMs(), attrs };
  emit(record);
  return {
    record, ctx: { session: record.session, trace: record.trace, span: record.span },
    set(a) { Object.assign(record.attrs, a); },
    end(status = "ok", a) { if (record.end) return; record.end = nowMs(); record.status = status; if (a) Object.assign(record.attrs, a); emit(record); },
  };
}

export async function withSpan<T>(service: Service, kind: Kind, name: string, attrs: Record<string, unknown>, fn: (s: SpanHandle) => Promise<T> | T, ctx?: Partial<Current>): Promise<T> {
  const s = startSpan(service, kind, name, attrs, ctx);
  try {
    const out = await als.run(s.ctx, () => fn(s));
    s.end(s.record.status ?? "ok");
    return out;
  } catch (e) { s.end("error", { error: String((e as Error).message ?? e) }); throw e; }
}

/** A point-in-time, in-memory check: one line in the trace, with its outcome. */
export function check(service: Service, name: string, ok: boolean, attrs: Record<string, unknown> = {}): boolean {
  const s = startSpan(service, "check", name, attrs);
  s.end(ok ? "ok" : "denied");
  return ok;
}

export const runInSession = <T>(session: string, fn: () => T) => als.run({ session, trace: hex(16), span: "" }, fn);
export const currentContext = () => als.getStore();

const headersFor = (c: Current | undefined): Record<string, string> =>
  c ? { traceparent: `00-${c.trace}-${c.span || "0000000000000000"}-01`, baggage: `demo.session=${encodeURIComponent(c.session)}` } : {};

/** fetch that propagates the trace, and records a client span. */
export async function tfetch(service: Service, name: string, url: string, init: RequestInit & { headers?: Record<string, string> } = {}, attrs: Record<string, unknown> = {}): Promise<Response> {
  const s = startSpan(service, "client", name, { method: init.method ?? "GET", url: url.replace(/\/wado\/[^/]+/, "/wado/{ctx}"), ...attrs });
  try {
    const res = await fetch(url, { ...init, headers: { ...init.headers, ...headersFor(s.ctx) } });
    s.end(res.status >= 400 ? "error" : "ok", { status: res.status });
    return res;
  } catch (e) { s.end("error", { error: String((e as Error).message ?? e) }); throw e; }
}

/** Wraps an HTTP service: continues the caller's trace, and records a server span. */
export function traced(service: Service, handler: (req: Request, span: SpanHandle) => Promise<Response> | Response, nameOf?: (req: Request, url: URL) => string) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const tp = req.headers.get("traceparent")?.match(/^00-([0-9a-f]{32})-([0-9a-f]{16})-/);
    const session = decodeURIComponent(req.headers.get("baggage")?.match(/demo\.session=([^,;]+)/)?.[1] ?? "unattributed");
    const parent = tp ? { session, trace: tp[1]!, span: tp[2]! } : { session, trace: hex(16), span: undefined as unknown as string };
    const path = url.pathname.replace(/\/wado\/[^/]+/, "/wado/{ctx}");
    const s = startSpan(service, "server", nameOf?.(req, url) ?? `${req.method} ${path}`, { path }, parent);
    try {
      const res = await als.run(s.ctx, () => handler(req, s));
      // A streaming response ends its own span, once the stream has finished.
      if (!(s.record.attrs.streaming === true)) s.end(res.status >= 500 ? "error" : res.status >= 400 ? "denied" : "ok", { status: res.status });
      else s.set({ status: res.status });
      return res;
    } catch (e) { s.end("error", { error: String(e) }); throw e; }
  };
}
