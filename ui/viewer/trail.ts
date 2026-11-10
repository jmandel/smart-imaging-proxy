// The steps the viewer took, as the protocol panel shows them. Every request goes through `traced`, which keeps
// what it sent and what came back, with no secret in full.
import { useSyncExternalStore } from "react";
import { patientFetch } from "../lib/smart-imaging";
import { save } from "./session";

export type StepKind = "discover" | "authorize" | "token" | "backend-token" | "patient" | "clinical" | "imaging" | "wado";
export interface Step {
  id: string; kind: StepKind; title: string;
  request?: string; response?: string; status?: string; failed?: boolean; ms?: number; curl?: string;
  /** What the app took from the answer, shown as tiles on its stage. */
  facts?: Record<string, string | number>;
}
/** A failed answer, with its status, so a page can tell a 401 or a 404 from the rest. */
export class HttpError extends Error { constructor(message: string, readonly status: number) { super(message); } }

/** What the panel shows of a body: no secret in full, and only the start of a long one. */
const preview = (text: string) => {
  const masked = String(text).replace(/("(?:access_token|refresh_token|id_token)"\s*:\s*")[^"]+/g, "$1…").replace(/((?:code|code_verifier|client_assertion)=)[^&\s]+/g, "$1…").replace(/[A-Za-z0-9_.~-]{72,}/g, m => `${m.slice(0, 16)}…${m.slice(-8)}`);
  return masked.length > 1600 ? `${masked.slice(0, 1600)}\n… ${masked.length - 1600} more characters` : masked;
};
const pretty = (text: string) => { try { return JSON.stringify(JSON.parse(text), null, 1); } catch { return text; } };
export const requestLine = (method: string, url: string, headers?: HeadersInit) => [`${method} ${preview(url)}`, ...Object.entries(headers ?? {}).map(([k, v]) => `${k}: ${/^authorization$/i.test(k) ? "Bearer …" : v}`)].join("\n");
/** The same GET from a terminal. The token stays a variable, so the panel never holds it. */
export const curlOf = (url: string, headers?: Record<string, string>) => `curl "${url}" \\\n${Object.entries(headers ?? {}).map(([k, v]) => `  -H "${k}: ${/^authorization$/i.test(k) ? "Bearer $TOKEN" : v.replace(/"/g, '\\"')}"`).join(" \\\n")}`;

/** One connection's steps, kept in this tab. Ended, it records nothing more, so a late answer can't bring it back. */
export class Trail {
  private listeners = new Set<() => void>();
  private ended = false;
  constructor(public steps: Step[] = []) {}
  subscribe = (f: () => void) => { this.listeners.add(f); return () => { this.listeners.delete(f); }; };
  private changed() { save({ trail: this.steps }); for (const f of this.listeners) f(); }
  clear() { if (this.ended) return; this.steps = []; this.changed(); }
  end() { this.ended = true; }
  add(step: Step) {
    if (this.ended) return;
    const at = this.steps.findIndex(s => s.id === step.id);
    this.steps = at >= 0 ? this.steps.map((s, i) => i === at ? step : s) : [...this.steps, step];
    this.changed();
  }
  /** One request, recorded as a step, with what the app took from the answer. A failed status is thrown. */
  async traced<T = any>(step: Pick<Step, "id" | "kind" | "title">, url: string, init: RequestInit & { headers?: Record<string, string> } = {}, learned: (body: any) => Step["facts"] = () => ({})): Promise<T> {
    const started = performance.now(), method = init.method ?? "GET";
    const request = requestLine(method, url, init.headers) + (init.body ? `\n\n${preview(String(init.body))}` : "");
    let res: Response, text: string;
    try {
      res = await patientFetch(url, init, seconds => this.add({ ...step, request, status: "503", response: `HTTP 503\nretry-after: ${seconds}\n\nThe server is assembling this. Waiting ${seconds} s, then asking again.` }));
      text = await res.text();
    } catch (e) { this.add({ ...step, request, failed: true, response: String(e) }); throw e; }
    let facts: Step["facts"] = {};
    if (res.ok) { try { facts = learned(JSON.parse(text)); } catch {} }
    this.add({ ...step, request, facts, status: `${res.status}`, curl: method === "GET" ? curlOf(url, init.headers) : undefined, ms: Math.round(performance.now() - started), failed: !res.ok, response: `HTTP ${res.status}\n\n${preview(pretty(text))}` });
    if (!res.ok) throw new HttpError(`${step.title}: HTTP ${res.status}`, res.status);
    return JSON.parse(text);
  }
}
/** A trail's steps, kept current. */
export const useSteps = (trail: Trail) => useSyncExternalStore(trail.subscribe, () => trail.steps);
