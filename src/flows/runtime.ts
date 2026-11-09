// Everything a flow step does goes over HTTP to the real services, and is recorded for display.
import { boundaryOf, createModel, readMultipart, ref, type AppApproval, type ServiceAccessPolicy, type Share } from "@smart-imaging-proxy/core";
import { currentContext, startSpan, tfetch, traceparentOf, withSpan, check as traceCheck } from "../trace";
import { accountUrl, buildAuthorization, submitConsent, submitDelegation, submitRevocation, tokenRequestBody } from "./oauth";
import { clientAssertion, PATIENT_NAMES, USERS, type BackendClient } from "../auth-server";
import { nameOf, type Sandbox } from "../sandbox";
import { patientAttributes } from "../stores";

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

/** Ends a step, with this as the explanation. An earlier step's outcome left this one nothing to work with. */
export class StepStopped extends Error {}

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
  /** A flow acts in one sandbox: its own, or for Browse, whichever sandbox the page is in. */
  constructor(public sandbox: Sandbox, public clients: Record<string, BackendClient>) {}
  get urls() { return this.sandbox.urls; }
  get backend() { return this.sandbox.backend; }
  /** One patient's studies, Josh's unless named, from the catalog in use. For a flow's own displays and expectations. */
  studies(patient = "josh-example") { return this.sandbox.catalog.allStudies().filter(s => s.patient === patient); }
  /** One study, with its full series list. */
  study(id: string): any {
    const catalog = this.sandbox.catalog;
    const row = catalog.allStudies().find(s => s.id === id);
    return row && { ...row, series: catalog.hierarchies([row.pk]).get(row.pk)?.series ?? [] };
  }
  /** One patient's sites, Josh's unless named, in the catalog in use. */
  sites(patient = "josh-example") { return [...new Set(this.studies(patient).flatMap(s => s.site ? [s.site] : []))]; }
  siteOf(id: string) { return this.sandbox.catalog.allStudies().find(s => s.id === id)?.site; }
  /** The patient the last launch asked for, if it named one. */
  private askedPatient: string | undefined;
  /** Set once a person in a window picks an account other than the one a step expects. */
  accountNote: string | undefined;
  /** Why no token is held, for any step that goes on to need one. */
  private noToken = "An earlier step has to get a token first";
  /** What an earlier step should have left. Without it, this step ends here and sends nothing more. */
  need<T>(value: T | null | undefined, why: string): T {
    if (value === undefined || value === null) throw new StepStopped(why);
    return value;
  }
  token(token: string | undefined) { return this.need(token, this.noToken); }
  /** A study an earlier search returned. */
  found(id: string) { return this.need<any>(this.state.studies?.[id], `An earlier search has to return ${id} first`); }
  /** The token a launch ended with. Without one, the step ends here, saying why. */
  launched(t: { access_token?: string; error?: string }) {
    if (!t.access_token) this.noToken = this.whyNoToken(t.error);
    return this.token(t.access_token);
  }
  private whyNoToken(error: string | undefined) {
    if (error === "state_mismatch") return "The redirect's state didn't match the request, so the app stopped there and has no token";
    const who = this.signedIn;
    if (error !== "access_denied" || !who) return `The launch ended in ${error ?? "an error"}, so the app has no token`;
    const name = USERS[who]?.name.split(" ")[0] ?? who;
    const mine = this.sandbox.store.personSnapshot(ref("user", who));
    const held = [...(USERS[who]?.patient ? [USERS[who]!.patient!] : []), ...mine.relationships.filter(r => r.relation === "guardian_of").map(r => r.object.replace(/^patient:/, "")), ...mine.shares.filter(s => s.with === ref("user", who)).map(s => s.patient.replace(/^patient:/, ""))];
    if (!held.length) return `No patient has shared records with ${name}, so the app has no token`;
    if (this.askedPatient && !held.includes(this.askedPatient)) return `${(PATIENT_NAMES[this.askedPatient] ?? this.askedPatient).split(" ")[0]} hasn't shared records with ${name}, so the app has no token`;
    return `${name} chose not to approve the app, so it has no token`;
  }
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
  /** Replaces this sandbox's service-access policies. */
  async setServicePolicies(policies: ServiceAccessPolicy[]) { await this.sandbox.policy.replacePolicies("service-access", policies); }
  /** A user's approval of an app, for one patient if named. */
  approvalOf(user: string, client: string, patient?: string): AppApproval | undefined { return this.sandbox.store.approvals().find(a => a.by === ref("user", user) && a.app === ref("app", client) && (!patient || a.patient === ref("patient", patient))); }
  /** The patients a user has approved an app for. */
  approvedPatients(user: string, client: string) { return this.sandbox.store.approvals().filter(a => a.by === ref("user", user) && a.app === ref("app", client)).map(a => a.patient.replace(/^patient:/, "")); }
  /** The share a user holds of a patient's records, if any. */
  shareWith(user: string, patient?: string): Share | undefined { return this.sandbox.store.shares().find(s => s.with === ref("user", user) && (!patient || s.patient === ref("patient", patient))); }
  /** A patient's studies a guardian doesn't see, by the organization's policy for the patient's age and the studies' labels. */
  hiddenFrom(user: string, patient: string): string[] {
    const model = createModel({ patientOf: u => USERS[u]?.patient, attributesOf: patientAttributes, now: () => this.sandbox.clock.now(), name: nameOf });
    const snap = this.sandbox.store.patientSnapshot(ref("patient", patient));
    if (!model.guardianOf(snap, ref("user", user), ref("patient", patient))) return [];
    return this.studies(patient).filter(st => !model.baseline(snap, ref("user", user), ref("patient", patient), st).ok).map(st => st.id);
  }
  advanceClock(seconds: number) { this.sandbox.clock.advance(seconds); }
  beginStep() { this.exchanges = []; this.checks = []; this.decisionStart = this.sandbox.imaging.decisions.length; }
  endStep(narrative?: string): StepResult {
    return { narrative, exchanges: this.exchanges, checks: this.checks, decisions: this.sandbox.imaging.decisions.slice(this.decisionStart) };
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
   * and code exchange. With `window`, a person approves in a real browser window, and `patient` is
   * only what the consent page preselects for them.
   */
  async launch(user: string, client = "portal-app", opts: { sites?: string[]; window?: boolean; patient?: string } = {}) {
    const actor = client === "portal-app" ? "App" : client;
    this.askedPatient = opts.patient;
    const conf = await this.json(actor, "Discover the authorization endpoints", `${this.urls.clinicalFhir}/.well-known/smart-configuration`);
    const a = withSpanSync("app", "Generate PKCE verifier, S256 challenge, and state", () => buildAuthorization(conf.body.authorization_endpoint, client, undefined, this.traceFields(), user, opts.patient, this.urls));
    const shown = a.url.replace(/&demo_[^&]+/g, "");
    const back = opts.window
      ? await this.inWindow(a.url)
      : await withSpan("user", "action", `Browser: ${user} signs in and approves`, { user, sites: opts.sites?.join(", ") }, () => submitConsent(a.url, { user, sites: opts.sites, patient: opts.patient }, browserFetch));
    const redirected = `It redirected back with ${back.searchParams.get("code") ? "a single-use code" : `error ${back.searchParams.get("error")}`}.`;
    const browser: Exchange = { title: "Browser: authorization request, sign-in, and approval", actor: "User's browser", method: "GET", url: shown, requestHeaders: {}, status: back.searchParams.get("code") ? 302 : "denied", responseHeaders: {}, summary: `${opts.window ? "A person used the Authorization Server's pages in a window" : `Authorization Server's pages: ${user} signed in`}. ${redirected}` };
    this.exchanges.push(browser);
    const signedIn = this.sandbox.auth.signedInFor(a.state);
    this.signedIn = signedIn;
    if (opts.window) {
      if (signedIn) browser.summary = `Authorization Server's pages: ${signedIn} signed in${back.searchParams.get("code") ? " and approved" : ""}. ${redirected}`;
      this.checkAccount(signedIn, user);
    }
    const stateMatches = back.searchParams.get("state") === a.state;
    this.check("Redirect's state matches the request", stateMatches);
    if (!stateMatches) return { error: "state_mismatch" } as any;
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
        this.cancelWindow = why => reject(new StepStopped(why));
        timer = setTimeout(() => reject(new StepStopped("Timed out waiting for you in the other window. Run the step again.")), 300000);
      });
    } finally { clearTimeout(timer); this.pendingAuthUrl = undefined; this.resolveCallback = undefined; this.cancelWindow = undefined; this.callbackContext = undefined; }
  }
  /**
   * A redirect for the wait in progress ends it. It has to carry the `state` of that sign-in or account
   * page, so a forged redirect goes nowhere and the wait carries on.
   */
  receiveCallback(back: URL) {
    if (!this.pendingAuthUrl || !this.resolveCallback) return false;
    const waiting = new URL(this.pendingAuthUrl).searchParams;
    const state = waiting.get("state") ?? waiting.get("return_state");
    if (!state || back.searchParams.get("state") !== state) return false;
    this.resolveCallback(back);
    return true;
  }
  private traceFields() { const x = currentContext(); return x ? { traceparent: traceparentOf(x), session: x.session } : undefined; }

  /** A patient or their guardian delegates to a related person, on the account page. A refused share reports its status. */
  async delegate(owner: string, delegate: string, relationship: string, sites: string[], opts: { window?: boolean; patient?: string } = {}) {
    const url = accountUrl(owner, this.traceFields(), delegate, this.urls);
    let status = 303;
    if (opts.window) { await this.inWindow(url); this.checkAccount(this.sandbox.auth.lastAccountSignIn, owner); }
    else status = (await withSpan("user", "action", `Browser: ${owner} signs in and shares with ${delegate}`, { sites: sites.join(", "), patient: opts.patient }, () => submitDelegation(url, { user: owner, delegate, relationship, sites, patient: opts.patient }, browserFetch))).status;
    this.exchanges.push({ title: "Browser: sign in to the account page, and share", actor: "User's browser", method: "POST", url: url.replace(/[?&]demo_[^&]+/g, ""), requestHeaders: {}, status, responseHeaders: {}, summary: status === 303 ? `The share is kept at the Imaging Server, not in any token.` : `The account page refused to record this.` });
    return status;
  }
  async revokeDelegation(owner: string, delegate: string) {
    const url = accountUrl(owner, this.traceFields(), undefined, this.urls);
    await withSpan("user", "action", `Browser: ${owner} revokes ${delegate}'s access`, {}, () => submitRevocation(url, { user: owner, delegate }, browserFetch));
  }
  /** SMART Backend Services: discovery, a signed assertion, and client_credentials. */
  async backendToken(clientId: string, scope = "system/ImagingStudy.rs") {
    const c = this.clients[clientId]!;
    const conf = await this.json(clientId, "Discover the token endpoint", `${this.urls.clinicalFhir}/.well-known/smart-configuration`);
    const assertion = withSpanSync("app", "Sign a client assertion with the client's private key (ES256)", () => clientAssertion(c, conf.body.token_endpoint, this.sandbox.clock), (j: string) => { const [h, b] = j.split("."); return { header: JSON.parse(Buffer.from(h!, "base64url").toString()), claims: JSON.parse(Buffer.from(b!, "base64url").toString()) }; });
    const r = await this.json(clientId, "SMART Backend Services token request", conf.body.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "client_credentials", scope, client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: assertion }).toString() });
    return r.body;
  }
  async refresh(refreshToken: string | undefined, client = "portal-app") {
    this.need(refreshToken, this.noToken);
    const r = await this.json("App", "Refresh the access token", this.sandbox.auth.tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: client }).toString() });
    return r.body;
  }
  async search(token: string | undefined, query = "patient=josh-example&_include=ImagingStudy:endpoint", actor = "App") {
    this.token(token);
    const r = await this.json(actor, "Search ImagingStudy", `${this.urls.imaging}/fhir/ImagingStudy?${query}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/fhir+json" } });
    const last = this.exchanges[this.exchanges.length - 1]!;
    last.body = summarizeBundle(r.body, id => this.siteOf(id));
    const studies: Record<string, { uid: string; base: string; resource: any; claims: any }> = {};
    if (r.status === 200) {
      const entries = r.body.entry ?? [];
      const byUrl = new Map(entries.filter((e: any) => e.resource.resourceType === "Endpoint").map((e: any) => [e.fullUrl, e.resource]));
      for (const e of entries) if (e.resource.resourceType === "ImagingStudy" && e.resource.endpoint) {
        const ep: any = byUrl.get(e.resource.endpoint[0].reference);
        const uid = e.resource.identifier[0].value.replace("urn:oid:", "");
        const ctx = ep.address.split("/wado/")[1];
        studies[e.resource.id] = { uid, base: ep.address, resource: e.resource, claims: JSON.parse(Buffer.from(ctx.split(".")[1], "base64url").toString()) };
      }
    }
    return { status: r.status, studies };
  }
  /** One page of a search, by its URL, shown as it came back. For following `next` links. */
  async searchPage(title: string, token: string | undefined, url: string, actor = "App") {
    this.token(token);
    const r = await this.json(actor, title, url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/fhir+json" } });
    const last = this.exchanges[this.exchanges.length - 1]!;
    last.url = last.url.replace(/_cursor=[^&]+/, "_cursor=…");
    if (r.status === 200) last.body = { ...(summarizeBundle(r.body, id => this.siteOf(id)) as any), next: r.body.link.some((l: any) => l.relation === "next") };
    return { status: r.status, body: r.body, next: r.status === 200 ? r.body.link.find((l: any) => l.relation === "next")?.url as string | undefined : undefined };
  }
  plainBase() { return `${this.urls.proxy}/wado/-`; }

  /** A WADO-RS retrieval that reads the whole multipart body, as a careful client would. `null` sends no token on purpose. */
  async retrieve(actor: string, title: string, url: string, token: string | null | undefined, accept: string | undefined = ACCEPT_ANY): Promise<Retrieval> {
    if (token === undefined) this.token(token);
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
    const ev = this.sandbox.proxy.events[this.sandbox.proxy.events.length - 1];
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
    studies: (b.entry ?? []).filter((e: any) => e.resource.resourceType === "ImagingStudy").map((e: any) => ({
      id: e.resource.id, site: siteOf(e.resource.id), modality: (e.resource.modality ?? []).map((m: any) => m.code).join(","), numberOfSeries: e.resource.numberOfSeries, numberOfInstances: e.resource.numberOfInstances,
      endpointAddress: shortUrl((b.entry.find((x: any) => x.fullUrl === e.resource.endpoint?.[0].reference)?.resource.address ?? "") + "/").replace(/\/$/, ""),
    })),
  };
}
export const siteOptions = (c: Ctx, patient?: string) => c.sites(patient).map(s => ({ value: s, label: s }));
export const studyOptions = (c: Ctx, patient?: string) => c.studies(patient).map(s => ({ value: s.id, label: `${(s.title ?? s.description ?? s.id).slice(0, 44)} (${s.site ?? "no site"})` }));
