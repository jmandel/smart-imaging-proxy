// Everything a flow step does goes over HTTP to the real services, and is recorded for display.
import { boundaryOf, readMultipart } from "../multipart";
import { currentContext, startSpan, tfetch, traceparentOf, withSpan, check as traceCheck } from "../trace";
import { accountUrl, buildAuthorization, CLINICAL_FHIR, submitConsent, submitDelegation, submitRevocation, tokenRequestBody } from "./oauth";
import { clientAssertion, type BackendClient } from "../auth-server";
import { CONFIG } from "../config";
import { advance, resetClock } from "../clock";
import type { Rule } from "../imaging-server";
import type { Stack } from "../stack";

export interface Input { id: string; label: string; type: "select" | "multi" | "text"; options?: { value: string; label: string }[]; default?: any; clickDefault?: any; help?: string; }
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
  pendingAuthUrl: string | undefined;
  resolveCallback: ((u: URL) => void) | undefined;
  /** Ends a wait on a browser window, with this as the launch's error. */
  cancelWindow: ((why: string) => void) | undefined;
  /** Who signed in during the last launch, which a person in a window chooses for themselves. */
  signedIn: string | undefined;
  /** The step span waiting on a browser redirect, which can't carry any trace context of its own. */
  callbackContext: ReturnType<typeof currentContext> | undefined;
  exchanges: Exchange[] = [];
  checks: Check[] = [];
  private decisionStart = 0;
  constructor(public stack: Stack, public clients: Record<string, BackendClient>) {}
  get backend() { return this.stack.backend; }
  /** Every study, from the catalog in use. For a flow's own displays and expectations. */
  studies() { return this.stack.catalog.allStudies(); }
  /** One study, with its full series list. */
  study(id: string): any {
    const catalog = this.stack.catalog;
    const row = this.studies().find(s => s.id === id);
    return row && { ...row, series: catalog.hierarchies([row.pk]).get(row.pk)?.series ?? [] };
  }
  /** Every site in the catalog in use. */
  sites() { return [...new Set(this.studies().flatMap(s => s.site ? [s.site] : []))]; }
  siteOf(id: string) { return this.studies().find(s => s.id === id)?.site; }
  /** Set once a person in a window picks an account other than the one a step expects. */
  accountNote: string | undefined;
  check(label: string, ok: boolean, detail?: string) {
    // A failure after someone chose another account reads as the result of that choice.
    if (!ok && this.accountNote && !detail?.includes(this.accountNote)) detail = detail ? `${detail}. ${this.accountNote}` : this.accountNote;
    this.checks.push({ label, ok, detail });
    traceCheck("demo", `expected: ${label}`, ok, { detail });
  }
  private checkAccount(actual: string | undefined, expected: string) {
    const same = actual === expected;
    this.accountNote = same ? undefined : `${actual ?? "No one"} signed in, and this step expected ${expected}`;
    this.check("Signed in with the account this step expects", same, this.accountNote ?? expected);
  }
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
    this.exchanges.push({ title, actor, method: init.method ?? "GET", url: shortUrl(url), requestHeaders: redact(init.headers ?? {}), requestBody: typeof init.body === "string" ? init.body.replace(/(client_assertion=)[^&]+/, "$1…").replace(/(refresh_token=)[^&]+/, "$1…").replace(/(code=)[^&]+/, "$1…").replace(/(code_verifier=)[^&]+/, "$1…") : undefined, status: res.status, responseHeaders: Object.fromEntries(res.headers), body: redactBody(body), ms: Math.round(performance.now() - start) });
    return { status: res.status, body: body as any, headers: res.headers };
  }

  /**
   * A real SMART standalone launch: discovery, authorization request with PKCE, consent, redirect,
   * and code exchange. With `window`, a person approves in a real browser window.
   */
  async launch(user: string, client = "portal-app", opts: { sites?: string[]; window?: boolean; patient?: string } = {}) {
    const actor = client === "portal-app" ? "App" : client;
    const conf = await this.json(actor, "Discover the authorization endpoints", `${CLINICAL_FHIR}/.well-known/smart-configuration`);
    const a = withSpanSync("app", "Generate PKCE verifier, S256 challenge, and state", () => buildAuthorization(conf.body.authorization_endpoint, client, undefined, this.traceFields(), user));
    const shown = a.url.replace(/&demo_[^&]+/g, "");
    const back = opts.window
      ? await this.inWindow(a.url)
      : await withSpan("user", "action", `Browser: ${user} signs in and approves`, { user, sites: opts.sites?.join(", ") }, () => submitConsent(a.url, { user, sites: opts.sites, patient: opts.patient }, browserFetch));
    const redirected = `It redirected back with ${back.searchParams.get("code") ? "a single-use code" : `error ${back.searchParams.get("error")}`}.`;
    const browser: Exchange = { title: "Browser: authorization request, sign-in, and approval", actor: "User's browser", method: "GET", url: shown, requestHeaders: {}, status: back.searchParams.get("code") ? 302 : "denied", responseHeaders: {}, summary: `${opts.window ? "A person used the Authorization Server's pages in a window" : `Authorization Server's pages: ${user} signed in`}. ${redirected}` };
    this.exchanges.push(browser);
    const signedIn = this.stack.auth.signedInFor(a.state);
    this.signedIn = signedIn;
    if (opts.window) {
      if (signedIn) browser.summary = `Authorization Server's pages: ${signedIn} signed in${back.searchParams.get("code") ? " and approved" : ""}. ${redirected}`;
      this.checkAccount(signedIn, user);
    }
    this.check("Redirect's state matches the request", back.searchParams.get("state") === a.state);
    const code = back.searchParams.get("code");
    if (!code) return { error: back.searchParams.get("error") } as any;
    const r = await this.json(actor, "Exchange the code, with the PKCE verifier", conf.body.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: tokenRequestBody(a, code) });
    return r.body;
  }

  /** A person acts in a real browser window on the Authorization Server's own pages. */
  private async inWindow(url: string): Promise<URL> {
    this.pendingAuthUrl = url;
    this.callbackContext = currentContext();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<URL>((resolve, reject) => {
        this.resolveCallback = resolve;
        this.cancelWindow = why => reject(new Error(why));
        timer = setTimeout(() => reject(new Error("timed out waiting for you in the other window")), 300000);
      });
    } finally { clearTimeout(timer); this.pendingAuthUrl = undefined; this.resolveCallback = undefined; this.cancelWindow = undefined; this.callbackContext = undefined; }
  }
  private traceFields() { const x = currentContext(); return x ? { traceparent: traceparentOf(x), session: x.session } : undefined; }

  /** A patient delegates to a related person, on the account page. */
  async delegate(owner: string, delegate: string, relationship: string, sites: string[], opts: { window?: boolean } = {}) {
    const url = accountUrl(owner, this.traceFields());
    if (opts.window) { await this.inWindow(url); this.checkAccount(this.stack.auth.lastAccountSignIn, owner); }
    else await withSpan("user", "action", `Browser: ${owner} signs in and shares with ${delegate}`, { sites: sites.join(", ") }, () => submitDelegation(url, { user: owner, delegate, relationship, sites }, browserFetch));
    this.exchanges.push({ title: "Browser: sign in to the account page, and share", actor: "User's browser", method: "POST", url: url.replace(/[?&]demo_[^&]+/g, ""), requestHeaders: {}, status: 303, responseHeaders: {}, summary: `The delegation is kept at the Imaging Server, not in any token.` });
  }
  async revokeDelegation(owner: string, delegate: string) {
    const url = accountUrl(owner, this.traceFields());
    await withSpan("user", "action", `Browser: ${owner} revokes ${delegate}'s access`, {}, () => submitRevocation(url, { user: owner, delegate }, browserFetch));
  }
  /** SMART Backend Services: discovery, a signed assertion, and client_credentials. */
  async backendToken(clientId: string, scope = "system/ImagingStudy.rs") {
    const c = this.clients[clientId]!;
    const conf = await this.json(clientId, "Discover the token endpoint", `${CLINICAL_FHIR}/.well-known/smart-configuration`);
    const assertion = withSpanSync("app", "Sign a client assertion with the client's private key (ES256)", () => clientAssertion(c, conf.body.token_endpoint), (j: string) => { const [h, b] = j.split("."); return { header: JSON.parse(Buffer.from(h!, "base64url").toString()), claims: JSON.parse(Buffer.from(b!, "base64url").toString()) }; });
    const r = await this.json(clientId, "SMART Backend Services token request", conf.body.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "client_credentials", scope, client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: assertion }).toString() });
    return r.body;
  }
  async refresh(refreshToken: string) {
    const r = await this.json("App", "Refresh the access token", this.stack.auth.tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }).toString() });
    return r.body;
  }
  async search(token: string, query = "patient=josh-example&_include=ImagingStudy:endpoint", actor = "App") {
    const r = await this.json(actor, "Search ImagingStudy", `${CONFIG.imagingUrl}/fhir/ImagingStudy?${query}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/fhir+json" } });
    const last = this.exchanges[this.exchanges.length - 1]!;
    last.body = summarizeBundle(r.body, id => this.siteOf(id));
    const studies: Record<string, { uid: string; base: string; resource: any; claims: any }> = {};
    if (r.status === 200) {
      const byUrl = new Map(r.body.entry.filter((e: any) => e.resource.resourceType === "Endpoint").map((e: any) => [e.fullUrl, e.resource]));
      for (const e of r.body.entry) if (e.resource.resourceType === "ImagingStudy" && e.resource.endpoint) {
        const ep: any = byUrl.get(e.resource.endpoint[0].reference);
        const uid = e.resource.identifier[0].value.replace("urn:oid:", "");
        const ctx = ep.address.split("/wado/")[1];
        studies[e.resource.id] = { uid, base: ep.address, resource: e.resource, claims: JSON.parse(Buffer.from(ctx.split(".")[1], "base64url").toString()) };
      }
    }
    return { status: r.status, studies };
  }
  /** One page of a search, by its URL, shown as it came back. For following `next` links. */
  async searchPage(title: string, token: string, url: string, actor = "App") {
    const r = await this.json(actor, title, url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/fhir+json" } });
    const last = this.exchanges[this.exchanges.length - 1]!;
    last.url = last.url.replace(/_cursor=[^&]+/, "_cursor=…");
    if (r.status === 200) last.body = { ...(summarizeBundle(r.body, id => this.siteOf(id)) as any), next: r.body.link.some((l: any) => l.relation === "next") };
    return { status: r.status, body: r.body, next: r.status === 200 ? r.body.link.find((l: any) => l.relation === "next")?.url as string | undefined : undefined };
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

export const browserFetch = ((url: string, init: any) => tfetch("user", `Browser: ${init?.method === "POST" ? "submit a form" : "open a page"} ${new URL(url).pathname}`, url, init)) as unknown as typeof fetch;
const withSpanSync = <T>(service: "app", name: string, fn: () => T, describe?: (v: T) => Record<string, unknown>): T => { const s = startSpan(service, "internal", name); const v = fn(); s.end("ok", describe?.(v)); return v; };
const actorService = (actor: string) => (actor === "Authorization Server" ? "app" : "app") as "app";
function redactBody(b: any) {
  if (b && typeof b === "object" && !Array.isArray(b)) {
    const o = { ...b };
    for (const k of ["access_token", "refresh_token"]) if (o[k]) o[k] = short(o[k]);
    return o;
  }
  return b;
}
export function summarizeBundle(b: any, siteOf: (id: string) => string | undefined) {
  if (b?.resourceType !== "Bundle") return b;
  return {
    resourceType: "Bundle", total: b.total,
    studies: b.entry.filter((e: any) => e.resource.resourceType === "ImagingStudy").map((e: any) => ({
      id: e.resource.id, site: siteOf(e.resource.id), modality: (e.resource.modality ?? []).map((m: any) => m.code).join(","), numberOfSeries: e.resource.numberOfSeries, numberOfInstances: e.resource.numberOfInstances,
      endpointAddress: shortUrl((b.entry.find((x: any) => x.fullUrl === e.resource.endpoint?.[0].reference)?.resource.address ?? "") + "/").replace(/\/$/, ""),
    })),
  };
}
export const siteOptions = (c: Ctx) => c.sites().map(s => ({ value: s, label: s }));
export const studyOptions = (c: Ctx) => c.studies().map(s => ({ value: s.id, label: `${(s.title ?? s.description ?? s.id).slice(0, 44)} (${s.site ?? "no site"})` }));
export const resetDemo = (stack: Stack) => { stack.resetAll(); resetClock(); };
