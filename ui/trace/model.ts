// What the trace service sends, and the small readings every trace page shares: sizes, durations, decoded JWTs, and
// the parsed bodies of a captured exchange.
import { BASE } from "../lib/api";

export interface Message { headers: Record<string, string>; body?: string; encoding?: "text" | "hex"; bytes?: number; truncated?: boolean }
/** One HTTP call. A summary, as the stream and a session's list send it, has no request or response, only their type and size. */
export interface Http { method: string; url: string; status?: number; request?: Message; response?: Message; contentType?: string; bytes?: number }
export type Kind = "action" | "server" | "client" | "internal" | "check";
export type Status = "ok" | "error" | "denied";
export interface Span {
  session: string; trace: string; span: string; parent?: string;
  service: string; kind: Kind; name: string; start: number; end?: number;
  status?: Status; attrs: Record<string, any>; seq?: number; http?: Http; sandbox?: string;
}
export interface SessionInfo { id: string; startedAt: number; lastAt: number; spans: number }
export interface Stats {
  mode: "file" | "memory"; path?: string; sessions: number; spans: number; bytes: number; lastError?: string;
  limits: { sessions: number; bytes: number; spansPerSession: number };
}

/** The trace service's data, for the sandbox the page is in. Read at call time: the base follows the route. */
export const traceApi = (path: string) => `${BASE}/trace/api${path}`;
export const sessionApi = (session: string, rest = "") => traceApi(`/sessions/${encodeURIComponent(session)}${rest}`);
export const streamUrl = () => `${BASE}/trace/stream`;
/** The full exchange of one span, and the HTTP log of one trace: the trace's own pages, in this sandbox. */
export const fullHref = (s: Pick<Span, "session" | "span">) => `${BASE}/trace/span?session=${encodeURIComponent(s.session)}&span=${encodeURIComponent(s.span)}`;
export const logHref = (s: Pick<Span, "session" | "trace">) => `${BASE}/trace/log?session=${encodeURIComponent(s.session)}&trace=${encodeURIComponent(s.trace)}`;

export const fmtBytes = (n: number | undefined) => n === undefined ? "" : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
export const fmtMs = (ms: number | undefined) => ms === undefined ? "…" : ms < 10 ? `${ms.toFixed(1)} ms` : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
export const fmtEpoch = (e: unknown) => typeof e === "number" ? new Date(e * 1000).toISOString().replace(".000", "") : e;
export const shortUid = (u: string | undefined) => u && u.length > 24 ? `${u.slice(0, 10)}…${u.slice(-8)}` : u;
/** Long DICOM UIDs in running text, shortened so a name still fits its row. */
export const shortUids = (s: unknown) => String(s ?? "").replace(/\b\d+(?:\.\d+){2,}\b/g, u => shortUid(u)!);
export const yesNo = (v: unknown) => v === undefined ? undefined : v ? "yes" : "no";

export interface Jwt { header: Record<string, any>; claims: Record<string, any> }
export function decodeJwt(jwt: string | undefined | null): Jwt | undefined {
  try {
    const [h, b] = jwt!.split(".");
    const dec = (x: string) => JSON.parse(atob(x.replace(/-/g, "+").replace(/_/g, "/")));
    return { header: dec(h!), claims: dec(b!) };
  } catch { return undefined; }
}
/** The signed context a retrieval URL carries in its path, decoded. */
export const contextOf = (url: string | undefined) => { const m = url?.match(/\/wado\/([^/?]+)/); return m ? decodeJwt(m[1]) : undefined; };
export const urlOf = (h: Http) => { try { return new URL(h.url); } catch { return undefined; } };
export const parseJson = (m: Message | undefined): any => { try { return m?.body && m.encoding === "text" ? JSON.parse(m.body) : undefined; } catch { return undefined; } };
export const parseForm = (m: Message | undefined) => m?.body && (m.headers?.["content-type"] ?? "").includes("form-urlencoded") ? new URLSearchParams(m.body) : undefined;
/** A captured HTML page, parsed only to read what it showed: a heading, the choices offered. */
export const parsePage = (m: Message | undefined) => m?.body && m.encoding === "text" && (m.headers?.["content-type"] ?? "").includes("html") ? new DOMParser().parseFromString(m.body, "text/html") : undefined;
export const pageTexts = (doc: ParentNode | undefined, selector: string) => doc ? [...doc.querySelectorAll(selector)].map(e => (e.textContent ?? "").trim().replace(/\s+/g, " ")).filter(Boolean) : [];
export const pageValues = (doc: ParentNode | undefined, selector: string) => doc ? [...doc.querySelectorAll<HTMLInputElement>(selector)].map(e => e.value).filter(Boolean) : [];
export const queryText = (u: URL) => [...u.searchParams].filter(([k]) => !k.startsWith("demo_")).map(([k, v]) => `${k}=${v}`).join("&");
export const displayPath = (u: URL) => shortUids(u.pathname.replace(/\/wado\/[^/]+/, "/wado/{ctx}"));

/** A body as text to read: JSON indented, a form one field a line. */
export function pretty(m: Message) {
  const json = parseJson(m);
  if (json !== undefined) return JSON.stringify(json, null, 2);
  const form = parseForm(m);
  if (form) return [...form.entries()].map(([k, v]) => `${k} = ${v}`).join("\n");
  return m.body ?? "";
}
export function hexDump(hex: string, limit = Infinity) {
  const out: string[] = [];
  const n = Math.min(hex.length / 2, limit);
  for (let i = 0; i < n; i += 16) {
    const bytes: number[] = [];
    for (let j = i; j < Math.min(i + 16, n); j++) bytes.push(parseInt(hex.substr(j * 2, 2), 16));
    out.push(`${i.toString(16).padStart(6, "0")}  ${bytes.map(b => b.toString(16).padStart(2, "0")).join(" ").padEnd(47)}  ${bytes.map(b => b >= 32 && b < 127 ? String.fromCharCode(b) : ".").join("")}`);
  }
  return out.join("\n");
}
