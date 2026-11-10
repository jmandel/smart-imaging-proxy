// Checks an agent starts for its person: the agent names a server, or an app, and gets a link to give them. A server
// check's page runs the check in their browser, pausing for them to sign in, and reports each step back here, where
// the agent reads it. An app check puts the person's sandbox into a staged mode while they run their own app
// against it, then grades the app from the sandbox's log (src/app-check.ts). A run lives in memory for a day, and
// its long random id is the only access to it. A private key sent with a run stays here: the page asks this server
// to sign each assertion, and no answer ever holds it.
import { randomBytes } from "node:crypto";
import { checkServer, type ServerEntry } from "../ui/lib/server-entry";
import { extraField, readJson, refuseHost, refuseWrite } from "./settings-api";
import { listClients } from "./clients";
import { CONDITIONS, faultsFor, grade, progressOf, SCRIPTS, scriptById, STAGED_FAULTS, type Evidence, type GradedStep, type Note } from "./app-check";
import type { Faults, Sandbox } from "./sandbox";

export type RunStatus = "waiting" | "running" | "paused" | "done";
export type StepState = "todo" | "running" | "paused" | "pass" | "fail" | "skip" | "note" | "unreached";
export interface ReportStep { n: number; title: string; state: StepState; result: string; diagnosis?: { cause: string; check?: string }; requests: { request: string; response: string }[] }
interface ServerRun { kind: "server"; id: string; server: ServerEntry; status: RunStatus; summary: string | null; steps: ReportStep[]; createdAt: number; updatedAt: number; expiresAt: number; assertions: number }
/** The app an app check grades: a client registered in a sandbox, the script its person follows, and what's staged. */
export interface CheckApp { sandbox: string; clientId: string; script: string; conditions: string[] }
interface AppRun {
  kind: "app"; id: string; app: CheckApp & { name: string; type: string }; origin: string;
  status: Exclude<RunStatus, "paused">; summary: string | null; steps: GradedStep[]; notes: Note[];
  createdAt: number; updatedAt: number; expiresAt: number;
  /** While it runs: when it began and must end, the last event before it, and the faults to put back. */
  startedAt?: number; endsAt?: number; endedAt?: number; ended?: "graded" | "abandoned" | "expired"; since?: number; before?: Partial<Faults>; timer?: ReturnType<typeof setTimeout>;
}
type Run = ServerRun | AppRun;

/** What an app check needs of the site: a sandbox by its id, and its log. */
export interface AppCheckSite {
  sandbox(id: string): Sandbox | undefined;
  /** The newest event's number in a sandbox, once everything sent before now is in the log. */
  mark(sandbox: string): Promise<number>;
  /** A sandbox's events after `after`, of these kinds, naming any of these links, oldest first. */
  events(q: { sandbox: string; after?: number; kinds: string[]; anyLink?: string[] }): EventRecordLike[];
}
type EventRecordLike = Evidence["events"][number];

/** How long a run lasts, how many can be live at once, and how many assertions one run may have signed. */
export const RUN_LIFETIME_MS = 24 * 3600_000, MAX_RUNS = 500, MAX_ASSERTIONS = 50;
/** How long an app check's staged mode stays on before it ends itself, and is graded. */
export const APP_WINDOW_MS = 2 * 3600_000;
const SANDBOX_BASE = /^\/s\/([A-Za-z0-9_-]+)$/;
const STATUSES: RunStatus[] = ["running", "paused", "done"];
const STATES: StepState[] = ["todo", "running", "paused", "pass", "fail", "skip", "note", "unreached"];
const MAX_REPORT_BYTES = 512 * 1024, MAX_STEPS = 40, MAX_REQUESTS = 20, MAX_TEXT = 8000;

const json = (b: unknown, status = 200) => Response.json(b, { status, headers: { "cache-control": "no-store" } });
const bad = (error: string) => json({ error }, 400);
const iso = (ms: number) => new Date(ms).toISOString();
const b64url = (b: Uint8Array | ArrayBuffer) => Buffer.from(b instanceof ArrayBuffer ? new Uint8Array(b) : b).toString("base64url");

/** The server as anyone holding the id may see it: everything but the private key, and whether there is one. */
const shownServer = ({ jwk, ...rest }: ServerEntry) => ({ ...rest, ...(jwk ? { hasKey: true, kid: jwk.kid } : {}) });
const view = (r: ServerRun) => ({ id: r.id, server: shownServer(r.server), status: r.status, summary: r.summary, steps: r.steps, updatedAt: iso(r.updatedAt), expiresAt: iso(r.expiresAt) });
const scriptOf = (r: AppRun) => scriptById(r.app.script)!;
const appView = (r: AppRun, progress?: ReturnType<typeof progressOf>) => ({
  id: r.id, app: r.app, status: r.status, summary: r.summary,
  script: { id: scriptOf(r).id, title: scriptOf(r).title, steps: scriptOf(r).steps },
  staged: CONDITIONS.filter(c => r.app.conditions.includes(c.id)).map(c => ({ id: c.id, text: c.text })),
  fhirBase: `${r.origin}${r.app.sandbox}/fhir`,
  ...(r.startedAt ? { startedAt: iso(r.startedAt) } : {}), ...(r.endsAt && r.status === "running" ? { endsAt: iso(r.endsAt) } : {}),
  ...(r.endedAt ? { endedAt: iso(r.endedAt), ended: r.ended } : {}), ...(progress ? { progress } : {}),
  steps: r.steps, notes: r.notes, updatedAt: iso(r.updatedAt), expiresAt: iso(r.expiresAt),
});

/** A client assertion for `aud`, signed with the run's ES256 key, as the page would sign it with a key it held. */
async function signAssertion(server: ServerEntry, aud: string, nowSeconds: number) {
  const jwk = server.jwk!;
  const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const part = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const head = `${part({ alg: "ES256", kid: jwk.kid, typ: "JWT" })}.${part({ iss: server.clientId, sub: server.clientId, aud, exp: nowSeconds + 240, jti: randomBytes(16).toString("base64url") })}`;
  return `${head}.${b64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(head)))}`;
}

const text = (v: unknown, limit = MAX_TEXT) => typeof v === "string" ? v.slice(0, limit) : undefined;
/** A report's steps, as the page sends them, or why they can't be taken. Only the known fields are kept. */
function stepsOf(list: unknown): ReportStep[] | string {
  if (!Array.isArray(list) || list.length > MAX_STEPS) return `steps is a list of at most ${MAX_STEPS}`;
  const out: ReportStep[] = [];
  for (const s of list as any[]) {
    if (typeof s !== "object" || !s || !Number.isInteger(s.n) || typeof s.title !== "string" || !STATES.includes(s.state) || typeof s.result !== "string") return "each step has n, title, state and result";
    if (s.requests !== undefined && (!Array.isArray(s.requests) || s.requests.length > MAX_REQUESTS)) return `a step's requests are a list of at most ${MAX_REQUESTS}`;
    const diagnosis = s.diagnosis && typeof s.diagnosis.cause === "string" ? { cause: text(s.diagnosis.cause)!, ...(typeof s.diagnosis.check === "string" ? { check: text(s.diagnosis.check)! } : {}) } : undefined;
    out.push({
      n: s.n, title: text(s.title, 200)!, state: s.state, result: text(s.result, 1000)!, ...(diagnosis ? { diagnosis } : {}),
      requests: (s.requests ?? []).map((q: any) => ({ request: text(q?.request) ?? "", response: text(q?.response) ?? "" })),
    });
  }
  return out;
}

/** The app named for a run, or why it can't be checked. */
function appOf(b: any, site: AppCheckSite): { app: AppRun["app"] } | { error: string } {
  if (typeof b !== "object" || !b || Array.isArray(b)) return { error: "app is an object: sandbox, clientId, and optionally script and conditions" };
  const extra = extraField(b, ["sandbox", "clientId", "script", "conditions"]); if (extra) return { error: `app: ${extra}` };
  let base = typeof b.sandbox === "string" ? b.sandbox.trim().replace(/\/$/, "") : "";
  try { if (/^https?:/.test(base)) base = new URL(base).pathname.replace(/\/(fhir|llms\.txt)?$/, "").replace(/\/$/, ""); } catch { /* checked below */ }
  const id = base.match(SANDBOX_BASE)?.[1];
  const sandbox = id ? site.sandbox(id) : undefined;
  if (!sandbox) return { error: "app.sandbox is a sandbox's base, /s/{id}, or its URL: an app check runs in the sandbox the app is registered in" };
  const client = typeof b.clientId === "string" ? listClients(sandbox.store).find(c => c.id === b.clientId) : undefined;
  if (!client) return { error: "app.clientId is the client ID of an app registered in that sandbox" };
  const script = scriptById(b.script ?? (client.type === "backend" ? "service" : "josh"));
  if (!script) return { error: `app.script is one of ${SCRIPTS.map(s => s.id).join(", ")}` };
  if ((script.kind === "backend") !== (client.type === "backend")) return { error: client.type === "backend" ? "a backend service has no one to sign in: use the script service" : "the script service is for a backend service: choose one of josh, riley or robin" };
  const conditions = b.conditions ?? CONDITIONS.map(c => c.id);
  if (!Array.isArray(conditions) || conditions.some(c => !CONDITIONS.some(x => x.id === c))) return { error: `app.conditions is a list of ${CONDITIONS.map(c => c.id).join(", ")}` };
  return { app: { sandbox: base, clientId: client.id, script: script.id, conditions: CONDITIONS.map(c => c.id).filter(c => conditions.includes(c)), name: client.name, type: client.type } };
}

export function createCheckRuns({ now = Date.now, site }: { now?: () => number; site?: AppCheckSite } = {}) {
  const runs = new Map<string, Run>();
  const prune = () => {
    const t = now();
    for (const [id, r] of runs) if (r.expiresAt <= t) { if (r.kind === "app" && r.status === "running") void finish(r, "expired"); runs.delete(id); }
  };
  const live = (id: string) => { prune(); return runs.get(id); };
  const missing = () => json({ error: "no such check run: it may have expired" }, 404);
  const sandboxIdOf = (r: AppRun) => r.app.sandbox.match(SANDBOX_BASE)![1]!;

  /** Everything the log holds of an app's run: its tokens, whenever issued, the addresses issued to them, and the run's events. */
  function evidence(r: AppRun): Evidence {
    const sandbox = sandboxIdOf(r);
    const tokens = site!.events({ sandbox, kinds: ["token.issued"] }).filter(e => e.data.client === r.app.clientId);
    const links = tokens.map(e => `token:${e.data.tokenHash}`);
    return {
      tokens,
      contexts: links.length ? site!.events({ sandbox, kinds: ["context.signed"], anyLink: links }) : [],
      events: site!.events({ sandbox, after: r.since, kinds: ["token.issued", "search.returned", "stream.done", "retrieval.answered"] }),
    };
  }
  const graded = (r: AppRun) => {
    const sandbox = site!.sandbox(sandboxIdOf(r));
    const urls = sandbox?.urls;
    return grade({
      client: r.app.clientId, script: scriptOf(r), conditions: r.app.conditions, evidence: evidence(r),
      imaging: urls ? `${urls.imaging}/fhir` : `${r.origin}${r.app.sandbox}/imaging/fhir`, proxy: urls?.proxy ?? `${r.origin}${r.app.sandbox}`,
      log: (token, seq) => `${r.origin}${r.app.sandbox}/activity?${new URLSearchParams({ ...(token ? { link: `token:${token}` } : {}), ...(seq ? { event: String(seq) } : {}) })}`,
    });
  };
  /** Puts the sandbox back as it was before the run, if the run is the one on there. */
  const restore = (r: AppRun) => {
    clearTimeout(r.timer);
    const sandbox = site?.sandbox(sandboxIdOf(r));
    if (sandbox?.appCheck?.run !== r.id) return;
    sandbox.setFaults(r.before ?? {});
    sandbox.setAppCheck(undefined);
  };
  /** Ends a run: graded when its person ends it or its time runs out, and not when abandoned. */
  async function finish(r: AppRun, how: NonNullable<AppRun["ended"]>) {
    if (r.status !== "running" && !(how === "abandoned" && r.status === "waiting")) return;
    const wasRunning = r.status === "running";
    restore(r);
    Object.assign(r, { status: "done", ended: how, endedAt: now(), updatedAt: now() });
    if (how === "abandoned" || !wasRunning) { r.summary = "Abandoned, so not graded. The sandbox is as it was before the run."; return; }
    await site!.mark(sandboxIdOf(r)).catch(() => 0);
    const g = graded(r);
    Object.assign(r, { steps: g.steps, notes: g.notes, summary: how === "expired" ? `Ended when its ${APP_WINDOW_MS / 3600_000} hours were up. ${g.summary}` : g.summary, updatedAt: now() });
  }
  async function start(r: AppRun): Promise<Response> {
    if (r.status !== "waiting") return json({ error: r.status === "running" ? "this run has started" : "this run has ended: start a new one" }, 409);
    const id = sandboxIdOf(r), sandbox = site!.sandbox(id);
    if (!sandbox) return json({ error: "the sandbox this run is for is gone" }, 409);
    if (sandbox.appCheck) return json({ error: "an app check is already running in this sandbox: end it first", run: sandbox.appCheck.run }, 409);
    if (!listClients(sandbox.store).some(c => c.id === r.app.clientId)) return json({ error: "the app is no longer registered in this sandbox" }, 409);
    const t = now();
    // Claimed before anything is awaited, so two starts can't both take the sandbox.
    sandbox.setAppCheck({ run: r.id, client: r.app.clientId, script: r.app.script, staged: CONDITIONS.filter(c => r.app.conditions.includes(c.id)).map(c => c.text), startedAt: iso(t), endsAt: iso(t + APP_WINDOW_MS) });
    const was = sandbox.faults();
    r.before = Object.fromEntries(STAGED_FAULTS.map(k => [k, was[k]]));
    r.since = await site!.mark(id);
    sandbox.setFaults(faultsFor(r.app.conditions));
    Object.assign(r, { status: "running", startedAt: t, endsAt: t + APP_WINDOW_MS, updatedAt: t });
    r.timer = setTimeout(() => void finish(r, "expired"), APP_WINDOW_MS);
    (r.timer as { unref?: () => void }).unref?.();
    return json(appView(r));
  }

  /** `origin` is the site's public address, which the link a run answers with starts at. */
  async function fetch(req: Request, url: URL, origin: string): Promise<Response> {
    const m = req.method, parts = url.pathname.slice("/api/checks".length).split("/").filter(Boolean);
    const refused = m === "GET" ? refuseHost(req) : refuseWrite(req, url);
    if (refused) return refused;

    if (parts.length === 0 && m === "POST") {
      const b = await readJson(req);
      if (typeof b !== "object" || !b || Array.isArray(b)) return bad("the request body must be a JSON object");
      const extra = extraField(b, site ? ["server", "app"] : ["server"]); if (extra) return bad(extra);
      if (b.app !== undefined) {
        if (b.server !== undefined) return bad("send a server or an app, not both");
        const named = appOf(b.app, site!);
        if ("error" in named) return bad(named.error);
        prune();
        if (runs.size >= MAX_RUNS) return json({ error: "too many check runs are open: try again later" }, 429);
        const t = now(), id = randomBytes(24).toString("base64url");
        const run: AppRun = { kind: "app", id, app: named.app, origin, status: "waiting", summary: null, steps: [], notes: [], createdAt: t, updatedAt: t, expiresAt: t + RUN_LIFETIME_MS };
        runs.set(id, run);
        return json({ id, url: `${origin}${named.app.sandbox}/app-check?run=${id}`, status: run.status, expiresAt: iso(run.expiresAt) }, 201);
      }
      let server: ServerEntry;
      try { server = checkServer(b.server, "The server"); } catch (e) { return bad((e as Error).message); }
      prune();
      if (runs.size >= MAX_RUNS) return json({ error: "too many check runs are open: try again later" }, 429);
      const t = now(), id = randomBytes(24).toString("base64url");
      const run: ServerRun = { kind: "server", id, server, status: "waiting", summary: null, steps: [], createdAt: t, updatedAt: t, expiresAt: t + RUN_LIFETIME_MS, assertions: 0 };
      runs.set(id, run);
      return json({ id, url: `${origin}/check?run=${id}`, status: run.status, expiresAt: iso(run.expiresAt) }, 201);
    }
    const found = parts[0] ? live(parts[0]) : undefined;
    // Past its window, a run ends and is graded when it's next asked about, if its timer hasn't already.
    if (found?.kind === "app" && found.status === "running" && found.endsAt! <= now()) await finish(found, "expired");
    if (parts.length === 1 && m === "GET") {
      if (!found) return missing();
      if (found.kind === "server") return json(view(found));
      if (found.status !== "running") return json(appView(found));
      await site!.mark(sandboxIdOf(found)).catch(() => 0);
      return json(appView(found, progressOf({ client: found.app.clientId, evidence: evidence(found) })));
    }
    if (found?.kind === "app" && parts.length === 2 && m === "POST" && ["start", "end", "abandon"].includes(parts[1]!)) {
      if (["", "{}"].indexOf((await req.text()).trim()) < 0) return bad("this action takes no input");
      if (parts[1] === "start") return start(found);
      if (parts[1] === "end" && found.status !== "running") return json({ error: found.status === "waiting" ? "this run hasn't started" : "this run has ended" }, 409);
      if (parts[1] === "abandon" && found.status === "done") return json({ error: "this run has ended" }, 409);
      await finish(found, parts[1] === "end" ? "graded" : "abandoned");
      return json(appView(found));
    }
    if (found?.kind === "app" && parts.length === 2) return json({ error: "an app check takes start, end and abandon" }, 404);
    const run = found as ServerRun | undefined;
    if (parts.length === 2 && parts[1] === "report" && m === "PUT") {
      if (!run) return missing();
      const raw = await req.text();
      if (raw.length > MAX_REPORT_BYTES) return json({ error: "the report is too large" }, 413);
      let b: any; try { b = JSON.parse(raw); } catch { return bad("the request body must be a JSON object"); }
      if (typeof b !== "object" || !b || Array.isArray(b)) return bad("the request body must be a JSON object");
      const extra = extraField(b, ["status", "summary", "steps"]); if (extra) return bad(extra);
      if (!STATUSES.includes(b.status)) return bad(`status is one of ${STATUSES.join(", ")}`);
      if (typeof b.summary !== "string") return bad("summary is the line saying how far the check got");
      const steps = stepsOf(b.steps);
      if (typeof steps === "string") return bad(steps);
      Object.assign(run, { status: b.status, summary: text(b.summary, 1000), steps, updatedAt: now() });
      return json(view(run));
    }
    // The page's sign-in, or its backend token, needs an assertion signed with the key the agent sent.
    if (parts.length === 2 && parts[1] === "assertion" && m === "POST") {
      if (!run) return missing();
      if (!run.server.jwk) return json({ error: "this run has no key" }, 409);
      const b = await readJson(req);
      if (typeof b !== "object" || !b || extraField(b, ["aud"])) return bad("send aud, the token endpoint");
      let aud: URL; try { aud = new URL(b.aud); } catch { return bad("aud is the token endpoint's URL"); }
      if (aud.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(aud.hostname)) return bad("aud must use https");
      if (run.assertions >= MAX_ASSERTIONS) return json({ error: "this run has had all the assertions it may" }, 429);
      run.assertions++;
      return json({ assertion: await signAssertion(run.server, b.aud, Math.floor(now() / 1000)) });
    }
    return new Response("not found", { status: 404 });
  }
  return { fetch, size: () => { prune(); return runs.size; } };
}
