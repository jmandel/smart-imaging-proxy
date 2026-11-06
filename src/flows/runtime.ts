// Everything a flow step does goes over HTTP to the real services, and is recorded for display.
import { boundaryOf, readMultipart } from "../multipart";
import { startSpan, tfetch, withSpan, check as traceCheck } from "../trace";
import { clientAssertion, type BackendClient } from "../auth-server";
import { CONFIG } from "../config";
import { advance, resetClock } from "../clock";
import { SITES, type Rule } from "../imaging-server";
import type { Stack } from "../stack";

export interface Input { id: string; label: string; type: "select" | "multi" | "text"; options?: { value: string; label: string }[]; default?: any; help?: string; }
export interface Check { label: string; ok: boolean; detail?: string; }
export interface Exchange {
  title?: string; actor: string; method: string; url: string; requestHeaders: Record<string, string>; requestBody?: string;
  status: number | string; responseHeaders: Record<string, string>; body?: unknown; summary?: string;
  authz?: string; denial?: string; ms?: number; note?: string;
}
export interface StepResult { narrative?: string; exchanges: Exchange[]; checks: Check[]; decisions: any[]; data?: unknown; }
export interface Step { id: string; title: string; actor: string; doc: string; inputs?: (c: Ctx) => Input[]; run: (c: Ctx, inputs: Record<string, any>) => Promise<string | void>; }
export interface Flow { id: string; number: number; group: "policy" | "protocol"; title: string; summary: string; shows: string; steps: Step[]; setup?: (c: Ctx) => void | Promise<void>; }

export const ACCEPT_ANY = "multipart/related; type=application/dicom; transfer-syntax=*";
const short = (t?: string) => t ? `${t.slice(0, 8)}…` : "";
const redact = (h: Record<string, string>) => {
  const o: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) o[k] = k.toLowerCase() === "authorization" ? `Bearer ${short(v.replace(/^Bearer /, ""))}` : v;
  return o;
};
const shortUrl = (u: string) => u.replace(/\/wado\/([^/]{16})[^/]*\//, "/wado/$1…/");

export interface Retrieval { status: number; complete: boolean; parts: { syntax?: string; bytes: number }[]; failed: boolean; authz?: string; denial?: string; contentType: string | null; }

export class Ctx {
  state: Record<string, any> = {};
  session = "unattributed";
  exchanges: Exchange[] = [];
  checks: Check[] = [];
  private decisionStart = 0;
  constructor(public stack: Stack, public clients: Record<string, BackendClient>) {}
  get manifest() { return this.stack.manifest; }
  get backend() { return this.stack.backend; }
  study(id: string) { return this.manifest.studies.find((s: any) => s.id === id); }
  check(label: string, ok: boolean, detail?: string) { this.checks.push({ label, ok, detail }); traceCheck("demo", `expected: ${label}`, ok, { detail }); }
  setRules(rules: Rule[]) { this.stack.imaging.setPolicy({ rules }); }
  advanceClock(seconds: number) { advance(seconds); }
  beginStep() { this.exchanges = []; this.checks = []; this.decisionStart = this.stack.imaging.decisions.length; }
  endStep(narrative?: string): StepResult {
    return { narrative, exchanges: this.exchanges, checks: this.checks, decisions: this.stack.imaging.decisions.slice(this.decisionStart) };
  }

  async json(actor: string, title: string, url: string, init: RequestInit & { headers?: Record<string, string> } = {}) {
    const start = performance.now();
    const res = await tfetch(actorService(actor), title, url, init, { actor });
    const text = await res.text();
    let body: unknown = text;
    try { body = text ? JSON.parse(text) : undefined; } catch {}
    this.exchanges.push({ title, actor, method: init.method ?? "GET", url: shortUrl(url), requestHeaders: redact(init.headers ?? {}), requestBody: typeof init.body === "string" ? init.body.replace(/(client_assertion=)[^&]+/, "$1…").replace(/(refresh_token=)[^&]+/, "$1…") : undefined, status: res.status, responseHeaders: Object.fromEntries(res.headers), body: redactBody(body), ms: Math.round(performance.now() - start) });
    return { status: res.status, body: body as any, headers: res.headers };
  }

  /** Simulated App Launch: the user has signed in and approved. */
  async launch(user: string, client = "portal-app", patient = "josh-example") {
    const r = await this.json("Authorization Server", `App Launch completes for ${user}`, `${CONFIG.authUrl}/_demo/consent`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_id: client, user, patient, fhirUser: `Patient/${user}`, scope: "launch/patient patient/ImagingStudy.rs online_access" }) });
    return r.body;
  }
  async backendToken(clientId: string, scope = "system/ImagingStudy.rs") {
    const c = this.clients[clientId]!;
    const r = await this.json(clientId, "SMART Backend Services token request", this.stack.auth.tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "client_credentials", scope, client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: clientAssertion(c, this.stack.auth.tokenUrl) }).toString() });
    return r.body;
  }
  async refresh(refreshToken: string) {
    const r = await this.json("App", "Refresh the access token", this.stack.auth.tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }).toString() });
    return r.body;
  }
  async search(token: string, query = "patient=josh-example&_include=ImagingStudy:endpoint", actor = "App") {
    const r = await this.json(actor, "Search ImagingStudy", `${CONFIG.imagingUrl}/fhir/ImagingStudy?${query}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/fhir+json" } });
    const last = this.exchanges[this.exchanges.length - 1]!;
    last.body = summarizeBundle(r.body);
    const studies: Record<string, { uid: string; base: string; resource: any; claims: any }> = {};
    if (r.status === 200) {
      const byUrl = new Map(r.body.entry.filter((e: any) => e.resource.resourceType === "Endpoint").map((e: any) => [e.fullUrl, e.resource]));
      for (const e of r.body.entry) if (e.resource.resourceType === "ImagingStudy") {
        const ep: any = byUrl.get(e.resource.endpoint[0].reference);
        const uid = e.resource.identifier[0].value.replace("urn:oid:", "");
        const ctx = ep.address.split("/wado/")[1];
        studies[e.resource.id] = { uid, base: ep.address, resource: e.resource, claims: JSON.parse(Buffer.from(ctx.split(".")[1], "base64url").toString()) };
      }
    }
    return { status: r.status, studies };
  }
  plainBase() { return `${CONFIG.proxyUrl}/wado/-`; }

  /** A WADO-RS retrieval that reads the whole multipart body, as a careful client would. */
  async retrieve(actor: string, title: string, url: string, token: string | undefined, accept: string | undefined = ACCEPT_ANY): Promise<Retrieval> {
    const headers: Record<string, string> = {};
    if (accept !== undefined) headers.Accept = accept;
    if (token) headers.Authorization = `Bearer ${token}`;
    const start = performance.now();
    let res: Response;
    const span = startSpan("app", "client", title, { actor, url: url.replace(/\/wado\/[^/]+/, "/wado/{ctx}"), accept });
    try {
      res = await withSpan("app", "internal", "send request", {}, () => tfetch("app", "GET WADO-RS", url, { headers }), span.ctx);
    }
    catch (e) { span.end("error", { error: String(e) }); this.exchanges.push({ title, actor, method: "GET", url: shortUrl(url), requestHeaders: redact(headers), status: "connection failed", responseHeaders: {}, note: String(e) }); return { status: 0, complete: false, parts: [], failed: true, contentType: null }; }
    const parts: { syntax?: string; bytes: number }[] = [];
    let complete = false, failed = false;
    const ct = res.headers.get("content-type");
    const boundary = boundaryOf(ct);
    if (res.ok && boundary && res.body) {
      let current: { syntax?: string; bytes: number } | undefined;
      for await (const e of readMultipart(res.body as any, boundary)) {
        if (e.type === "start") { current = { syntax: e.headers["content-type"]?.match(/transfer-syntax=([^;\s]+)/)?.[1], bytes: 0 }; parts.push(current); }
        else if (e.type === "data" && current) current.bytes += e.bytes.length;
        else if (e.type === "complete") complete = true;
        else if (e.type === "truncated") failed = true;
      }
    } else await res.body?.cancel();
    span.end(res.ok && complete || !res.ok ? (res.ok ? "ok" : "denied") : "error", { status: res.status, parts: parts.length, closing_boundary: complete, failed });
    const ev = this.stack.proxy.events[this.stack.proxy.events.length - 1];
    const syn = [...new Set(parts.map(p => p.syntax))].join(", ");
    const bytes = parts.reduce((n, p) => n + p.bytes, 0);
    this.exchanges.push({
      title, actor, method: "GET", url: shortUrl(url), requestHeaders: redact(headers), status: res.status,
      responseHeaders: Object.fromEntries(res.headers), authz: ev?.authz, denial: ev?.denial, ms: Math.round(performance.now() - start), note: ev?.note,
      summary: res.ok ? `${parts.length} parts, ${(bytes / 1e6).toFixed(1)} MB, syntax: ${syn || "none"}${complete ? "; closing boundary received" : "; RESPONSE ENDED WITHOUT A CLOSING BOUNDARY"}` : undefined,
    });
    return { status: res.status, complete, parts, failed, authz: ev?.authz, denial: ev?.denial, contentType: ct };
  }
  studyUrl(base: string, uid: string, rest = "") { return `${base}/studies/${uid}${rest}`; }
}

const actorService = (actor: string) => (actor === "Authorization Server" ? "app" : "app") as "app";
function redactBody(b: any) {
  if (b && typeof b === "object" && !Array.isArray(b)) {
    const o = { ...b };
    for (const k of ["access_token", "refresh_token"]) if (o[k]) o[k] = short(o[k]);
    return o;
  }
  return b;
}
export function summarizeBundle(b: any) {
  if (b?.resourceType !== "Bundle") return b;
  return {
    resourceType: "Bundle", total: b.total,
    studies: b.entry.filter((e: any) => e.resource.resourceType === "ImagingStudy").map((e: any) => ({
      id: e.resource.id, site: SITES[e.resource.id], modality: e.resource.modality.map((m: any) => m.code).join(","), numberOfSeries: e.resource.numberOfSeries, numberOfInstances: e.resource.numberOfInstances,
      endpointAddress: shortUrl((b.entry.find((x: any) => x.fullUrl === e.resource.endpoint[0].reference)?.resource.address ?? "") + "/").replace(/\/$/, ""),
    })),
  };
}
export const siteOptions = () => [...new Set(Object.values(SITES))].map(s => ({ value: s, label: s }));
export const studyOptions = (c: Ctx) => c.manifest.studies.map((s: any) => ({ value: s.id, label: `${s.title.slice(0, 44)} (${SITES[s.id]})` }));
export const resetDemo = (stack: Stack) => { stack.resetAll(); resetClock(); };
