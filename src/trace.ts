// Tracing for the demo. A session groups everything in one flow run. A trace is one user
// action. Spans carry W3C traceparent across HTTP, and a baggage entry carries the session.
// HTTP exchanges are captured for the viewer. Secrets are never recorded: tokens, codes, and
// other credentials appear as hash prefixes, and passwords not at all.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";

export const SERVICES = ["user", "app", "authorization-server", "imaging-fhir", "policy", "dicomweb-proxy", "backend", "demo"] as const;
export const KINDS = ["action", "server", "client", "internal", "check"] as const;
export const STATUSES = ["ok", "error", "denied"] as const;
export type Service = typeof SERVICES[number];
export type Kind = typeof KINDS[number];

export interface SpanRecord {
  session: string; trace: string; span: string; parent?: string;
  service: Service; kind: Kind; name: string; start: number; end?: number;
  status?: typeof STATUSES[number]; attrs: Record<string, unknown>; seq?: number; http?: HttpCapture;
}
export interface CapturedMessage { headers: Record<string, string>; body?: string; encoding?: "text" | "hex"; bytes?: number; truncated?: boolean; }
export interface HttpCapture { method: string; url: string; status?: number; request: CapturedMessage; response?: CapturedMessage; }
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
const emit = (s: SpanRecord) => { buffer.push({ ...s, attrs: { ...s.attrs }, http: s.http && { ...s.http } }); timer ??= setTimeout(flush, 25); };
export const flushTraces = () => { if (timer) clearTimeout(timer); flush(); };

const hex = (n: number) => randomBytes(n).toString("hex");

let TEXT_CAP = 256 * 1024, BINARY_CAP = 2048;
/** For tests: lets a body cross the capture limit without needing a huge study. */
export const setCaptureLimitsForTest = (text = 256 * 1024, binary = 2048) => { TEXT_CAP = text; BINARY_CAP = binary; };
const hashed = (s: string) => `sha256:${createHash("sha256").update(s).digest("base64url").slice(0, 10)}…`;
const SECRET_PARAMS = new Set(["token", "access_token", "refresh_token", "code", "code_verifier", "x-amz-signature", "x-amz-credential", "x-amz-security-token"]);

function redactHeaders(h: Headers | Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(h as any).forEach((v, k) => {
    if (k === "authorization") { const [scheme, ...rest] = v.split(" "); out[k] = `${scheme} ${hashed(rest.join(" "))}`; }
    else if (k === "cookie" || k === "set-cookie") out[k] = "(session cookie, not recorded)";
    else if (k === "location") out[k] = redactUrl(v);
    else out[k] = v;
  });
  return out;
}
export function redactUrl(raw: string): string {
  try {
    // A redirect's Location can be relative, and it gets the same treatment.
    const relative = !/^[a-z][a-z0-9+.-]*:/i.test(raw);
    const u = new URL(raw, "http://relative.invalid");
    for (const k of [...u.searchParams.keys()]) if (SECRET_PARAMS.has(k.toLowerCase())) u.searchParams.set(k, hashed(u.searchParams.get(k)!));
    return relative ? u.pathname + u.search + u.hash : u.toString();
  } catch { return raw; }
}
export function redactBody(text: string, contentType: string): string {
  if (contentType.includes("x-www-form-urlencoded")) {
    const f = new URLSearchParams(text);
    for (const k of [...f.keys()]) {
      if (k === "password") f.set(k, "(not recorded)");
      else if (k === "client_assertion") { const [h, b] = f.get(k)!.split("."); f.set(k, `${h}.${b}.(signature)`); }
      else if (SECRET_PARAMS.has(k)) f.set(k, hashed(f.get(k)!));
    }
    return f.toString();
  }
  // The closing quote is optional, so a body cut off by the capture limit can't leak a partial token.
  return text.replace(/"(access_token|refresh_token)"\s*:\s*"([^"]*)"?/g, (_m, k, v) => `"${k}":"${hashed(v)}"`);
}
const isText = (ct: string) => /json|text\/|xml|x-www-form-urlencoded|javascript/.test(ct) && !ct.includes("multipart/");

/** Passes a response through untouched, while keeping its size and a capped copy of its start. */
function captureResponse(res: Response, done: (m: CapturedMessage) => void): Response {
  const contentType = res.headers.get("content-type") ?? "";
  const headers = redactHeaders(res.headers);
  if (!res.body) { done({ headers, bytes: 0 }); return res; }
  const text = isText(contentType), cap = text ? TEXT_CAP : BINARY_CAP;
  const reader = res.body.getReader();
  const kept: Uint8Array[] = [];
  let bytes = 0, held = 0, finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    const raw = Buffer.concat(kept);
    const message: CapturedMessage = { headers, bytes, truncated: bytes > raw.length };
    if (raw.length) { message.encoding = text ? "text" : "hex"; message.body = text ? redactBody(raw.toString("utf8"), contentType) : raw.toString("hex"); }
    done(message);
  };
  const body = new ReadableStream({
    async pull(c) {
      try {
        const { done: end, value } = await reader.read();
        if (end) { finish(); c.close(); return; }
        bytes += value.length;
        if (held < cap) { const piece = value.subarray(0, cap - held); kept.push(piece.slice()); held += piece.length; }
        c.enqueue(value);
      } catch (e) { finish(); c.error(e); }
    },
    cancel(reason) { finish(); return reader.cancel(reason); },
  }, { highWaterMark: 0 });
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}
const nowMs = () => performance.timeOrigin + performance.now();

export interface SpanHandle { record: SpanRecord; ctx: Current; end(status?: SpanRecord["status"], attrs?: Record<string, unknown>): void; set(attrs: Record<string, unknown>): void; update(): void; }

export function startSpan(service: Service, kind: Kind, name: string, attrs: Record<string, unknown> = {}, ctx?: Partial<Current>): SpanHandle {
  const p = ctx ?? als.getStore();
  const record: SpanRecord = { session: p?.session ?? "unattributed", trace: p?.trace ?? hex(16), span: hex(8), parent: p?.span, service, kind, name, start: nowMs(), attrs };
  emit(record);
  return {
    record, ctx: { session: record.session, trace: record.trace, span: record.span },
    set(a) { Object.assign(record.attrs, a); },
    update() { emit(record); },
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
/** Runs `fn` as part of a span, for work a stream does long after its handler returned. */
export const inSpan = <T>(ctx: Current, fn: () => T) => als.run(ctx, fn);

export const traceparentOf = (c: { trace: string; span: string }) => `00-${c.trace}-${c.span || "0000000000000000"}-01`;
const headersFor = (c: Current | undefined): Record<string, string> =>
  c ? { traceparent: `00-${c.trace}-${c.span || "0000000000000000"}-01`, baggage: `demo.session=${encodeURIComponent(c.session)}` } : {};

/** fetch that propagates the trace, and records a client span. */
export async function tfetch(service: Service, name: string, url: string, init: RequestInit & { headers?: Record<string, string> } = {}, attrs: Record<string, unknown> = {}): Promise<Response> {
  const s = startSpan(service, "client", name, { method: init.method ?? "GET", url: redactUrl(url).replace(/\/wado\/[^/]+/, "/wado/{ctx}"), ...attrs });
  try {
    const sent = { ...init.headers, ...headersFor(s.ctx) };
    const contentType = new Headers(sent).get("content-type") ?? "";
    const request: CapturedMessage = { headers: redactHeaders(sent) };
    const text = typeof init.body === "string" ? init.body : init.body instanceof URLSearchParams ? init.body.toString() : undefined;
    if (text !== undefined) { request.body = redactBody(text, contentType); request.encoding = "text"; request.bytes = text.length; }
    s.record.http = { method: init.method ?? "GET", url: redactUrl(url), request };
    const res = await fetch(url, { ...init, headers: sent, redirect: init.redirect ?? "manual" });
    s.record.http.status = res.status;
    s.end(res.status >= 500 ? "error" : res.status >= 400 ? "denied" : "ok", { status: res.status });
    return captureResponse(res, m => { s.record.http!.response = m; s.update(); });
  } catch (e) { s.end("error", { error: String((e as Error).message ?? e) }); throw e; }
}

/** The session a request's baggage names. Anyone can send baggage, so an undecodable one names none. */
const baggageSession = (baggage: string | null) => {
  try { return decodeURIComponent(baggage?.match(/demo\.session=([^,;]+)/)?.[1] ?? "unattributed"); } catch { return "unattributed"; }
};

/** Wraps an HTTP service: continues the caller's trace, and records a server span. */
export function traced(service: Service, handler: (req: Request, span: SpanHandle) => Promise<Response> | Response, nameOf?: (req: Request, url: URL) => string, contextFor?: (req: Request, url: URL) => Partial<Current> | undefined) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    // A browser redirect can't carry trace headers, so the demo passes them as query parameters.
    const tp = (req.headers.get("traceparent") ?? url.searchParams.get("demo_traceparent"))?.match(/^00-([0-9a-f]{32})-([0-9a-f]{16})-/);
    const session = url.searchParams.get("demo_session") || baggageSession(req.headers.get("baggage"));
    // A request that carries no context can belong to whatever its service knows is waiting for it.
    const known = tp ? undefined : contextFor?.(req, url);
    const parent = tp ? { session, trace: tp[1]!, span: tp[2]! } : { session: known?.session ?? session, trace: known?.trace ?? hex(16), span: known?.span ?? (undefined as unknown as string) };
    const path = url.pathname.replace(/\/wado\/[^/]+/, "/wado/{ctx}");
    const s = startSpan(service, "server", nameOf?.(req, url) ?? `${req.method} ${path}`, { path }, parent);
    try {
      const contentType = req.headers.get("content-type") ?? "";
      const request: CapturedMessage = { headers: redactHeaders(req.headers) };
      if (req.method !== "GET" && req.method !== "HEAD" && req.body) {
        const text = await req.clone().text();
        request.bytes = text.length;
        if (text) { request.encoding = "text"; request.body = redactBody(text.slice(0, TEXT_CAP), contentType); request.truncated = text.length > TEXT_CAP; }
      }
      s.record.http = { method: req.method, url: redactUrl(req.url), request };
      const res = await als.run(s.ctx, () => handler(req, s));
      s.record.http.status = res.status;
      // A streaming response ends its own span, once the stream has finished.
      if (!(s.record.attrs.streaming === true)) s.end(res.status >= 500 ? "error" : res.status >= 400 ? "denied" : "ok", { status: res.status });
      else s.set({ status: res.status });
      return captureResponse(res, m => { s.record.http!.response = m; s.update(); });
    } catch (e) { s.end("error", { error: String(e) }); throw e; }
  };
}
