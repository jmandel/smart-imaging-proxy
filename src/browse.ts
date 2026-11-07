// The Browse page's server side. Picking someone runs a real launch or Backend Services token request
// and a real FHIR search, here in the demo server, as an app's own server would. The token stays in
// this file's session map: `view` builds everything the page receives, field by field.
import { randomBytes } from "node:crypto";
import { APP_NAMES, PATIENT_NAMES, roleOf, USERS, type BackendClient } from "./auth-server";
import { refuseWrite, readJson } from "./admin-api";
import { ruleSetFor } from "./rule-presets";
import { CONFIG } from "./config";
import { accountUrl, submitDelegation } from "./flows/oauth";
import { ACCEPT_ANY, browserFetch, Ctx } from "./flows/runtime";
import { boundaryOf, readMultipart } from "./multipart";
import type { Stack } from "./stack";
import { flushTraces, runInSession, tfetch, withSpan } from "./trace";

export const PAGE_SIZES = [2, 5, 20];
const MAX_SESSIONS = 20;
const COOKIE = "browse_session";
/** Who a one-click share reaches, and as what. */
const RELATIONSHIPS: Record<string, string> = { "sam-caregiver": "caregiver", "alex-neighbor": "neighbor" };
const SHARED_BY = "josh";
/** What a one-click share starts with ticked. It leaves one site out, so narrowing shows. */
const DEFAULT_SHARED_SITES = ["Lakeside Imaging", "Riverside Hospital"];
const AUTHZ: Record<string, string> = {
  instant: "Instant: the signed context covered it, with no call to the Imaging Server",
  cached: "Cached: the proxy reused a recent decision from the Imaging Server",
  asked: "Asked: the proxy sent an AuthZEN evaluation to the Imaging Server",
};

type Status = "signing-in" | "waiting-for-you" | "results" | "denied" | "forbidden" | "token-rejected" | "failed";
interface Start { user?: string; client: string; patient?: string; mode: "scripted" | "window"; count: number; sites?: string[]; share?: { delegate: string; sites: string[] }; }
interface RetrievalView {
  study: string; mode: "zstd" | "identity"; running: boolean; status?: number; authz?: string; authzPlain?: string; denial?: string; note?: string; error?: string;
  parts: number; syntaxes: string[]; wireBytes: number; decodedBytes: number; dicomBytes: number; encoding?: string; contentLength?: number; complete: boolean; ms?: number; traceUrl?: string;
}
interface Session {
  id: string; name: string; start: Start; switchedStore: boolean; c: Ctx; launching: boolean;
  token?: string; signedIn?: string; patient?: string; fhirUser?: string;
  status: Status; headline?: string; detail?: string; steps: { title: string; status: string | number; ms?: number }[];
  pages: { url: string; offset: number }[]; pageIndex: number; nextUrl?: string; count: number; total?: number;
  bundle?: unknown; studies: any[]; explain?: any; explainError?: string; endpoints: Map<string, { address: string; uid: string }>;
  searching: boolean; retrievals: Map<string, RetrievalView>; retrieving: boolean; abort: AbortController; lastTrace?: string; accountLinks: Map<string, { label: string; url: string }>;
}

const hex = (n: number) => randomBytes(n).toString("hex");
const firstName = (user: string) => USERS[user]?.name.split(" ")[0] ?? user;
const patientFirst = (patient: string) => (PATIENT_NAMES[patient] ?? patient).split(" ")[0]!;
const appName = (client: string) => APP_NAMES[client] ?? client;
const list = (items: string[]) => items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
/** The Imaging Server's reasons name accounts and clients by ID. */
function plainWords(text: string) {
  let out = text;
  for (const id of Object.keys(USERS).sort((a, b) => b.length - a.length)) out = out.replaceAll(id, firstName(id));
  for (const id of Object.keys(APP_NAMES)) out = out.replaceAll(id, `the ${appName(id)}`);
  for (const id of Object.keys(PATIENT_NAMES)) out = out.replaceAll(id, PATIENT_NAMES[id]!);
  return out;
}
const releaseLabel = (r: any, seriesCount: number) => r === "none" ? "Not released" : r === "study" ? "Released: whole study" : `Released: ${r.series.length} of ${seriesCount} series`;

/** The chain behind a list, from the rows that decide it. */
function plainChain(x: any) {
  if (x.level === "system") return x.rule ? `${x.client} is pre-authorized for ${PATIENT_NAMES[x.patient] ?? x.patient} by the rule "${x.rule.description ?? x.rule.id}"` : `No rule in saved policy pre-authorizes ${x.client} for ${PATIENT_NAMES[x.patient] ?? x.patient}`;
  const who = firstName(x.user), links: string[] = [];
  if (x.fhirUser === `Patient/${x.patient}`) links.push(`${who} is the patient`);
  else if (x.delegation) links.push(`${firstName(x.delegation.grantedBy)} shared ${x.delegation.sites.length ? list(x.delegation.sites) : "no sites"} with ${who}`);
  else return `${patientFirst(x.patient)} hasn't shared anything with ${who}`;
  if (x.appGrant) links.push(`${who} gave the ${appName(x.client)} ${x.appGrant.sites ? (x.appGrant.sites.length ? list(x.appGrant.sites) : "no sites") : `everything ${who} can see`}`);
  else links.push(`${who} hasn't authorized the ${appName(x.client)}`);
  if (x.rule) links.push(`the rule "${x.rule.description ?? x.rule.id}" also applies`);
  return links.join("; ");
}

/** The context form, read from the signed URL's claims the way anyone holding it could. */
function contextForm(address: string) {
  try {
    const claims = JSON.parse(Buffer.from(address.split("/wado/")[1]!.split(".")[1]!, "base64url").toString());
    if (claims.restricted) return { form: "restricted", plain: "Restricted: the signed URL releases nothing by itself, so the proxy asks the Imaging Server" };
    if (claims.series) return { form: "series list", plain: `Series list: the signed URL names the ${claims.series.length} released series, so the proxy answers on its own` };
    return { form: "whole study", plain: "Whole study: the signed URL covers every series, so the proxy answers on its own" };
  } catch { return { form: "unknown", plain: "This URL has no signed context the demo can read" }; }
}

export function createBrowse(stack: Stack, clients: Record<string, BackendClient>, hooks: { flowRunning: () => string | undefined }) {
  const sessions = new Map<string, Session>();
  const json = (b: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(b, { status, headers });
  const storeStatus = () => ({ active: stack.stores.activeName, label: stack.stores.activeLabel });
  const liveUrl = (name: string) => `${CONFIG.traceUrl}/?session=${encodeURIComponent(name)}`;
  const logUrl = (name: string, trace: string) => `${CONFIG.traceUrl}/log.html?session=${encodeURIComponent(name)}&trace=${trace}`;
  /** The account page, for that account. Its traffic joins this session's trace. */
  const accountLink = (s: Session, user: string) => {
    let link = s.accountLinks.get(user);
    if (!link) {
      const url = new URL(accountUrl(user, { traceparent: `00-${hex(16)}-0000000000000000-01`, session: s.name }));
      url.searchParams.delete("return"); // This opens in its own tab, and the Browse page stays open.
      link = { label: `${firstName(user)}'s account page`, url: url.toString() };
      s.accountLinks.set(user, link);
    }
    return link;
  };
  /** Moves the requests a step has made so far onto the list the page shows. */
  const drainSteps = (s: Session) => {
    for (const x of s.c.exchanges) s.steps.push({ title: x.title ?? x.url, status: x.status, ms: x.ms });
    s.c.exchanges = [];
  };

  const act = async <T>(s: Session, name: string, attrs: Record<string, unknown>, fn: () => Promise<T>): Promise<T> => {
    const trace = hex(16);
    s.lastTrace = trace;
    s.c.beginStep();
    try {
      return await runInSession(s.name, () => withSpan("user", "action", name, { backend: stack.backend, ...attrs }, fn, { session: s.name, trace }));
    } finally {
      drainSteps(s);
      flushTraces();
    }
  };

  // Everyone a person holds, by the saved store: what a Browse sign-in will use.
  const recordsOf = (id: string) => {
    const u = USERS[id]!;
    const out: { patient: string; name: string; via: "self" | "delegation"; relationship?: string; sites: string[] }[] = [];
    if (u.patient) out.push({ patient: u.patient, name: PATIENT_NAMES[u.patient] ?? u.patient, via: "self", sites: stack.catalog.sitesFor(u.patient) });
    for (const d of stack.stores.saved.delegations()) if (d.delegate === id) out.push({ patient: d.patient, name: PATIENT_NAMES[d.patient] ?? d.patient, via: "delegation", relationship: d.relationship, sites: d.sites });
    return out;
  };
  function options() {
    const rules = stack.stores.saved.rules();
    const held = stack.catalog.allStudies();
    return {
      people: Object.entries(USERS).map(([id, u]) => {
        const records = recordsOf(id);
        const own = u.patient ? held.filter(s => s.patient === u.patient).length : undefined;
        return { id, name: u.name, first: firstName(id), fhirUser: u.fhirUser, role: roleOf(u, records.filter(r => r.via === "delegation")), detail: own === undefined ? "" : own ? `${own} ${own === 1 ? "study" : "studies"} on file` : "No studies on file", records: records.map(r => ({ patient: r.patient, name: r.name, via: r.via, relationship: r.relationship })) };
      }),
      clients: Object.keys(clients).map(id => {
        const mine = rules.filter(r => r.when.client === id);
        return { id, role: mine.length ? `Pre-authorized by ${list(mine.map(r => `rule ${r.id}`))}` : "Backend client, with no pre-authorization in saved policy" };
      }),
      apps: Object.entries(APP_NAMES).map(([id, name]) => ({ id, name })),
      patients: stack.catalog.linkedPatients().map(id => ({ id, name: PATIENT_NAMES[id] ?? id })),
      pageSizes: PAGE_SIZES, traceUrl: CONFIG.traceUrl, store: storeStatus(), backend: stack.backend,
    };
  }

  /** How to pre-authorize a backend client, in the admin screen's own terms. */
  function ruleHelp(client: string, patient: string) {
    const set = ruleSetFor(client, patient, stack.catalog);
    return set
      ? { url: `/admin?rule-set=${set.id}#h-rules`, text: `To pre-authorize this client, go to Rules on the admin screen with saved policy active, choose "${set.label}", and select Apply rule set. That replaces the rules saved now.` }
      : { url: "/admin#h-rules", text: "No named rule set pre-authorizes this client for this patient. Rules on the admin screen lists the rule sets there are." };
  }

  function view(s: Session) {
    const who = s.signedIn ?? s.start.user;
    const held = who ? recordsOf(who).find(r => r.patient === (s.patient ?? s.start.patient)) : undefined;
    const related = !!who && !USERS[who]?.patient;
    const empty = s.status === "denied" || (s.status === "results" && s.total === 0);
    const delegates = related && empty ? (who === "alex-neighbor" ? ["alex-neighbor", "sam-caregiver"] : who && RELATIONSHIPS[who] ? [who] : []) : [];
    const page = s.pages[s.pageIndex];
    return {
      name: s.name, liveUrl: liveUrl(s.name), status: s.status === "signing-in" && s.c.pendingAuthUrl ? "waiting-for-you" as Status : s.status, running: s.launching, searching: s.searching, headline: s.headline, detail: s.detail, switchedStore: s.switchedStore,
      authUrl: s.c.pendingAuthUrl ?? null, mode: s.start.mode,
      start: { user: s.start.user, client: s.start.client, patient: s.start.patient, count: s.count },
      who: who ? { id: who, name: USERS[who]?.name ?? who, first: firstName(who), app: appName(s.start.client), asked: s.start.user } : { id: s.start.client, name: s.start.client, app: s.start.client, patient: s.start.patient },
      patient: s.patient ?? s.start.patient,
      steps: s.steps,
      page: { studies: s.studies, total: s.total, count: s.count, number: s.pageIndex + 1, first: page && s.studies.length ? page.offset + 1 : 0, last: page ? page.offset + s.studies.length : 0, hasNext: !!s.nextUrl, hasPrevious: s.pageIndex > 0 },
      explain: s.explain, explainError: s.explainError,
      appSites: held && s.status === "results" ? { sites: held.sites, granted: s.explain?.appGrant?.sites ?? held.sites } : undefined,
      share: delegates.length ? { from: firstName(SHARED_BY), sites: stack.catalog.sitesFor(USERS[SHARED_BY]!.patient!).map(name => ({ name, ticked: DEFAULT_SHARED_SITES.includes(name) })), offers: delegates.map(d => ({ delegate: d, label: `Have ${firstName(SHARED_BY)} share with ${firstName(d)}` })) } : undefined,
      accounts: who ? [accountLink(s, who), ...(related ? [accountLink(s, SHARED_BY)] : [])] : [],
      retrievals: [...s.retrievals.values()], retrieving: s.retrieving, hasBundle: !!s.bundle,
      ruleHelp: s.status === "forbidden" && !who ? ruleHelp(s.start.client, s.patient ?? s.start.patient!) : undefined,
    };
  }

  /** One real search page. `url` is either the first search, or a link the Bundle gave. */
  async function searchPage(s: Session, url: string, offset: number, index: number) {
    const r = await s.c.searchPage("Search ImagingStudy", s.token!, url, s.start.user ? "App" : s.start.client);
    s.pages = [...s.pages.slice(0, index), { url, offset }];
    s.pageIndex = index;
    s.studies = []; s.total = undefined; s.nextUrl = undefined; s.bundle = undefined;
    const patient = s.patient ?? s.start.patient!;
    if (r.status === 401) {
      s.status = "token-rejected";
      s.headline = "The Imaging Server answered 401: this token no longer works";
      s.detail = stack.stores.activeName === "saved" ? "The token has expired or was revoked. Sign in again to get a new one." : "A flow moved the demo to flow scratch, and this token belongs to saved policy. Signing in again goes back to saved policy.";
      s.explain = undefined; s.endpoints.clear();
      return;
    }
    await explainFor(s, patient);
    if (r.status === 403) {
      s.status = "forbidden";
      s.headline = "The Imaging Server answered 403 Forbidden";
      const why = String(r.body?.issue?.[0]?.diagnostics ?? "access is forbidden");
      s.detail = `${why[0]!.toUpperCase()}${why.slice(1)}.`;
      return;
    }
    if (r.status !== 200) {
      s.status = "failed";
      s.headline = `The Imaging Server answered ${r.status}`;
      s.detail = r.body?.issue?.[0]?.diagnostics;
      return;
    }
    s.bundle = r.body;
    s.total = r.body.total;
    s.nextUrl = r.next;
    const entries: any[] = r.body.entry;
    const byUrl = new Map(entries.filter(e => e.resource.resourceType === "Endpoint").map(e => [e.fullUrl, e.resource]));
    const rows = new Map<string, any>((s.explain?.studies ?? []).map((x: any) => [x.id, x]));
    s.studies = entries.filter(e => e.resource.resourceType === "ImagingStudy").map(e => {
      const st = e.resource, row = rows.get(st.id);
      const ep: any = st.endpoint && byUrl.get(st.endpoint[0].reference);
      const uid = st.identifier?.[0]?.value?.replace("urn:oid:", "");
      if (ep) s.endpoints.set(st.id, { address: ep.address, uid });
      return {
        id: st.id, description: st.description, title: row?.title, site: row?.site, date: st.started, status: st.status,
        modalities: (st.modality ?? []).map((m: any) => m.code), series: st.numberOfSeries, instances: st.numberOfInstances,
        seriesList: (st.series ?? []).map((x: any) => ({ number: x.number, modality: x.modality?.code, instances: x.numberOfInstances, description: x.description })),
        withheld: row?.withheldSeries ?? [], context: ep ? contextForm(ep.address) : undefined, retrievable: !!ep,
      };
    });
    s.status = "results";
    const who = s.signedIn ?? s.start.user;
    if (s.total === 0) {
      if (s.explain?.studies?.length === 0) {
        s.headline = `${patientFirst(patient)} has no studies`;
        s.detail = `The search returned 200 with a total of 0. No study in the catalog links to ${PATIENT_NAMES[patient] ?? patient}.`;
      } else {
        s.headline = "The search returned no studies";
        s.detail = "The search returned 200 with a total of 0. The Imaging Server's view below gives the reason for each study.";
      }
    } else {
      s.headline = `${s.total} ${s.total === 1 ? "study" : "studies"} ${who ? `${firstName(who)} and the ${appName(s.start.client)} can see` : `${s.start.client} can see`}`;
      s.detail = undefined;
    }
  }
  async function explainFor(s: Session, patient: string) {
    const who = s.signedIn ?? s.start.user;
    drainSteps(s);
    try {
      const x = await stack.explain({ client: s.start.client, patient, ...(who ? { user: who, fhirUser: USERS[who]?.fhirUser ?? "" } : {}) });
      s.explain = {
        patient, patientName: PATIENT_NAMES[patient] ?? patient, chain: plainChain(x), level: x.level,
        appGrant: x.appGrant,
        studies: x.studies.map((row: any) => ({ ...row, released: row.release !== "none", releaseLabel: releaseLabel(row.release, row.seriesCount), reason: plainWords(row.reason), chain: row.chain.map(plainWords) })),
      };
      s.explainError = undefined;
      s.steps.push({ title: "The demo asks for the Imaging Server's view", status: 200 });
    } catch (e) { s.explain = undefined; s.explainError = String((e as Error).message ?? e); }
  }

  /** Everything picking someone does: any sharing, then sign-in, then the first search. */
  async function run(s: Session) {
    const { user, client, patient, share, mode, sites } = s.start;
    try {
      await act(s, user ? `Browse: ${firstName(user)} signs in to the ${appName(client)}` : `Browse: ${client} gets a token and searches`, { user, client, patient, mode }, async () => {
        if (share) {
          const url = accountUrl(SHARED_BY, undefined);
          const res = await withSpan("user", "action", `Browser: ${firstName(SHARED_BY)} signs in and shares with ${firstName(share.delegate)}`, { sites: share.sites.join(", ") }, () => submitDelegation(url, { user: SHARED_BY, delegate: share.delegate, relationship: RELATIONSHIPS[share.delegate]!, sites: share.sites }, browserFetch));
          s.steps.push({ title: `${firstName(SHARED_BY)} shares on the account page: ${list(share.sites)}`, status: res.status });
          if (res.status !== 303) throw new Error(`the account page answered ${res.status}`);
        }
        if (!user) {
          const t = await s.c.backendToken(client);
          if (!t.access_token) throw new Error(`the token request failed: ${t.error ?? "no token"}`);
          s.token = t.access_token;
          s.patient = patient;
        } else {
          const t = await s.c.launch(user, client, { window: mode === "window", sites, patient });
          s.signedIn = s.c.signedIn ?? (mode === "window" ? undefined : user);
          if (!t.access_token) {
            s.status = t.error === "access_denied" ? "denied" : "failed";
            const who = s.signedIn ?? user;
            const holds = recordsOf(who).length > 0;
            s.headline = t.error === "access_denied" ? `${firstName(who)}'s sign-in ended in access_denied` : `The sign-in ended in ${t.error ?? "an error"}`;
            s.detail = `The Authorization Server redirected back with error=${t.error ?? "unknown"} and issued no token, so no search ran. ${holds ? `${firstName(who)} chose not to approve the app.` : `No patient has shared records with ${firstName(who)}.`}`;
            await explainFor(s, patient ?? recordsOf(who)[0]?.patient ?? stack.catalog.allStudies()[0]?.patient ?? "josh-example");
            return;
          }
          s.token = t.access_token;
          const grant = stack.auth.grantOf(t.access_token);
          s.signedIn = grant?.sub ?? s.signedIn;
          s.patient = t.patient;
        }
        const q = new URLSearchParams({ patient: s.patient!, _include: "ImagingStudy:endpoint", _count: String(s.count) });
        await searchPage(s, `${CONFIG.imagingUrl}/fhir/ImagingStudy?${q}`, 0, 0);
      });
    } catch (e) {
      s.status = "failed";
      s.headline = "This didn't finish";
      s.detail = String((e as Error).message ?? e);
    } finally { s.launching = false; }
  }

  function begin(body: any) {
    const running = hooks.flowRunning();
    if (running) return { error: `The flow step "${running}" is still running. Try again when it finishes.`, status: 409 };
    const user = typeof body.user === "string" ? body.user : undefined;
    const client = String(body.client ?? "");
    const count = Number(body.count ?? 5);
    if (!PAGE_SIZES.includes(count)) return { error: `the page size must be one of ${PAGE_SIZES.join(", ")}`, status: 400 };
    if (user !== undefined && !Object.hasOwn(USERS, user)) return { error: "that isn't one of the demo accounts", status: 400 };
    if (user !== undefined && !Object.hasOwn(APP_NAMES, client)) return { error: "that isn't a registered app", status: 400 };
    if (user === undefined && !Object.hasOwn(clients, client)) return { error: "that isn't a registered backend client", status: 400 };
    const patients = stack.catalog.linkedPatients();
    if (body.patient !== undefined && !patients.includes(body.patient)) return { error: "that patient isn't in the catalog's links", status: 400 };
    if (user === undefined && body.patient === undefined) return { error: "a backend client needs a patient", status: 400 };
    const mode = body.mode === "window" && user !== undefined ? "window" : "scripted";
    const strings = (v: unknown) => Array.isArray(v) && v.every(x => typeof x === "string");
    if (body.sites !== undefined && !strings(body.sites)) return { error: "sites must be a list", status: 400 };
    if (body.share !== undefined && (!Object.hasOwn(RELATIONSHIPS, body.share?.delegate) || !strings(body.share?.sites) || body.share.delegate !== user)) return { error: "that share isn't one this page offers", status: 400 };

    // Nothing above has yielded, so no flow step can have started since the check.
    const switchedStore = stack.stores.activeName !== "saved";
    stack.useStore("saved");
    const id = randomBytes(24).toString("base64url");
    const c = new Ctx(stack, clients);
    const name = `browse-${user ?? client}-${hex(3)}`;
    c.session = name;
    const s: Session = {
      id, name, c, switchedStore, launching: true, status: "signing-in", steps: [], pages: [], pageIndex: 0, count, studies: [], endpoints: new Map(), searching: false, retrievals: new Map(), retrieving: false, abort: new AbortController(), accountLinks: new Map(),
      start: { user, client, patient: body.patient, mode, count, ...(body.sites ? { sites: body.sites } : {}), ...(body.share ? { share: body.share } : {}) },
    };
    sessions.set(id, s);
    for (const k of sessions.keys()) { if (sessions.size <= MAX_SESSIONS) break; const old = sessions.get(k)!; if (old.launching) continue; old.abort.abort(); sessions.delete(k); }
    run(s);
    return { session: s };
  }

  /** Counts the whole response as it goes by, holding one chunk at a time. */
  async function retrieve(s: Session, study: string, zstd: boolean, r: RetrievalView) {
    const ep = s.endpoints.get(study)!;
    const url = `${ep.address}/studies/${ep.uid}`;
    const started = performance.now();
    try {
      await act(s, `Browse: retrieve ${study}, ${zstd ? "as a client that accepts zstd" : "as a client without zstd"}`, { study, accept_encoding: zstd ? "zstd" : "identity" }, async () => {
        r.traceUrl = logUrl(s.name, s.lastTrace!);
        const res = await tfetch("app", "GET WADO-RS", url, { headers: { Authorization: `Bearer ${s.token}`, Accept: ACCEPT_ANY, "Accept-Encoding": zstd ? "zstd" : "identity" }, decompress: false, signal: s.abort.signal } as any, { study });
        r.status = res.status;
        const ev = stack.proxy.events.findLast(e => e.path === new URL(url).pathname);
        r.authz = ev?.authz; r.authzPlain = ev?.authz ? AUTHZ[ev.authz] ?? ev.authz : undefined; r.denial = ev?.denial; r.note = ev?.note;
        r.encoding = res.headers.get("content-encoding") ?? "identity";
        const length = res.headers.get("content-length");
        if (length !== null) r.contentLength = Number(length);
        const boundary = boundaryOf(res.headers.get("content-type"));
        if (!res.ok || !boundary || !res.body) { await res.body?.cancel(); return; }
        const syntaxes = new Set<string>();
        const wire = res.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, out) { r.wireBytes += chunk.length; out.enqueue(chunk); } }));
        const decoded: ReadableStream<Uint8Array> = r.encoding === "zstd" ? wire.pipeThrough(new DecompressionStream("zstd" as any) as any) : wire;
        const counted = (async function* () { for await (const chunk of decoded as any) { r.decodedBytes += chunk.length; yield chunk as Uint8Array; } })();
        for await (const e of readMultipart(counted, boundary)) {
          if (e.type === "start") {
            r.parts++;
            const syntax = e.headers["content-type"]?.match(/transfer-syntax=([^;\s]+)/)?.[1];
            if (syntax && !syntaxes.has(syntax)) { syntaxes.add(syntax); r.syntaxes = [...syntaxes]; }
          } else if (e.type === "data") r.dicomBytes += e.bytes.length;
          else if (e.type === "complete") r.complete = true;
        }
        if (!r.complete) r.error = "the response ended without its closing boundary";
      });
    } catch (e) { r.error = String((e as Error).message ?? e); }
    finally {
      r.ms = Math.round(performance.now() - started);
      r.running = false;
      s.retrieving = false;
    }
  }

  const sessionOf = (req: Request) => sessions.get(req.headers.get("cookie")?.match(new RegExp(`(?:^|; )${COOKIE}=([^;]+)`))?.[1] ?? "");
  const gone = () => json({ error: "This Browse session has ended. Pick someone to start again." }, 404);
  const waiting = (url: URL) => {
    const state = url.searchParams.get("state");
    if (!state) return undefined;
    for (const s of sessions.values()) if (s.c.pendingAuthUrl && new URL(s.c.pendingAuthUrl).searchParams.get("state") === state) return s;
    return undefined;
  };

  return {
    /** A redirect back from the Authorization Server, if a Browse sign-in is waiting for it. */
    receiveCallback(url: URL) { const s = waiting(url); s?.c.resolveCallback?.(url); return !!s; },
    callbackContext(url: URL) { return waiting(url)?.c.callbackContext; },
    /**
     * Called before something moves the demo off saved policy. A sign-in waiting on a person ends now,
     * and one already running holds the move back for the moment it takes, by returning why.
     */
    holdStore(): string | undefined {
      for (const s of sessions.values()) {
        if (!s.launching) continue;
        if (s.c.pendingAuthUrl) s.c.cancelWindow?.("A flow or the admin screen moved the demo off saved policy, so this sign-in stopped. Sign in again to go back to saved policy.");
        else return "A Browse sign-in is running. Try again in a moment.";
      }
      return undefined;
    },
    async fetch(req: Request, url: URL): Promise<Response> {
      const p = url.pathname.slice("/api/browse".length);
      if (req.method === "GET") {
        if (p === "/options") return json(options());
        const s = sessionOf(req);
        if (p === "/session") return json({ session: s ? view(s) : null, store: storeStatus(), backend: stack.backend });
        if (p === "/bundle") return s?.bundle ? new Response(JSON.stringify(s.bundle, null, 2), { headers: { "content-type": "application/json" } }) : gone();
        if (p === "/metadata") {
          const ep = s?.endpoints.get(url.searchParams.get("study") ?? "");
          if (!s || !ep) return gone();
          return act(s, `Browse: read metadata for ${url.searchParams.get("study")}`, {}, async () => {
            const r = await tfetch("app", "GET WADO-RS metadata", `${ep.address}/studies/${ep.uid}/metadata`, { headers: { Authorization: `Bearer ${s.token}`, Accept: "application/dicom+json", "Accept-Encoding": "identity" } });
            if (!r.ok) { await r.body?.cancel(); return json({ error: `The proxy answered ${r.status}` }, r.status); }
            return new Response(r.body, { headers: { "content-type": "application/json" } });
          });
        }
        return new Response("not found", { status: 404 });
      }
      if (req.method !== "POST") return new Response("not found", { status: 404 });
      const refused = refuseWrite(req, url);
      if (refused) return refused;
      const body = await readJson(req);
      if (body === undefined || body === null || typeof body !== "object" || Array.isArray(body)) return json({ error: "the request body must be a JSON object" }, 400);

      if (p === "/start") {
        const r = begin(body);
        if ("error" in r) return json({ error: r.error }, r.status);
        return json({ session: view(r.session), store: storeStatus(), backend: stack.backend }, 202, { "Set-Cookie": `${COOKIE}=${r.session.id}; HttpOnly; SameSite=Strict; Path=/api/browse` });
      }
      const s = sessionOf(req);
      if (!s) return gone();
      if (p === "/cancel") { s.c.cancelWindow?.("The sign-in window closed before it finished."); return json({ session: view(s) }); }
      if (p === "/page") {
        if (!s.token) return json({ error: "this session has no token: pick someone to sign in" }, 409);
        if (s.searching) return json({ error: "a search is still running" }, 409);
        s.searching = true;
        try {
          const size = body.count === undefined ? undefined : Number(body.count);
          if (size !== undefined && !PAGE_SIZES.includes(size)) return json({ error: `the page size must be one of ${PAGE_SIZES.join(", ")}` }, 400);
          const to = size !== undefined ? "first" : body.to;
          if (size !== undefined) s.count = size;
          await act(s, `Browse: ${to === "next" ? "follow the next link" : to === "previous" ? "go back a page" : to === "again" ? "search again" : "search from the first page"}`, { to, count: s.count }, async () => {
            s.steps = [];
            const first = () => `${CONFIG.imagingUrl}/fhir/ImagingStudy?${new URLSearchParams({ patient: s.patient!, _include: "ImagingStudy:endpoint", _count: String(s.count) })}`;
            if (to === "next" && s.nextUrl) await searchPage(s, s.nextUrl, s.pages[s.pageIndex]!.offset + s.studies.length, s.pageIndex + 1);
            else if (to === "previous" && s.pageIndex > 0) await searchPage(s, s.pages[s.pageIndex - 1]!.url, s.pages[s.pageIndex - 1]!.offset, s.pageIndex - 1);
            else if (to === "again" && s.pages[s.pageIndex]) await searchPage(s, s.pages[s.pageIndex]!.url, s.pages[s.pageIndex]!.offset, s.pageIndex);
            else await searchPage(s, first(), 0, 0);
          });
        } finally { s.searching = false; }
        return json({ session: view(s), store: storeStatus(), backend: stack.backend });
      }
      if (p === "/retrieve") {
        const study = String(body.study ?? "");
        if (!s.token || !s.endpoints.has(study)) return json({ error: "this study has no Endpoint in the search results" }, 400);
        if (s.retrieving) return json({ error: "a retrieval is still running" }, 409);
        const mode = body.zstd ? "zstd" : "identity";
        const r: RetrievalView = { study, mode, running: true, parts: 0, syntaxes: [], wireBytes: 0, decodedBytes: 0, dicomBytes: 0, complete: false };
        s.retrievals.set(`${study}|${mode}`, r);
        s.retrieving = true;
        retrieve(s, study, !!body.zstd, r);
        return json({ session: view(s) }, 202);
      }
      return new Response("not found", { status: 404 });
    },
  };
}
