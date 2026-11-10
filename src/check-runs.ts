// Server checks an agent starts for its person: the agent names a server, and gets a link to give them. The page at
// that link runs the check in their browser, pausing for them to sign in, and reports each step back here, where
// the agent reads it. A run lives in memory for a day, and its long random id is the only access to it. A private
// key sent with a run stays here: the page asks this server to sign each assertion, and no answer ever holds it.
import { randomBytes } from "node:crypto";
import { checkServer, type ServerEntry } from "../ui/lib/server-entry";
import { extraField, readJson, refuseHost, refuseWrite } from "./settings-api";

export type RunStatus = "waiting" | "running" | "paused" | "done";
export type StepState = "todo" | "running" | "paused" | "pass" | "fail" | "skip" | "note" | "unreached";
export interface ReportStep { n: number; title: string; state: StepState; result: string; diagnosis?: { cause: string; check?: string }; requests: { request: string; response: string }[] }
interface Run { id: string; server: ServerEntry; status: RunStatus; summary: string | null; steps: ReportStep[]; createdAt: number; updatedAt: number; expiresAt: number; assertions: number }

/** How long a run lasts, how many can be live at once, and how many assertions one run may have signed. */
export const RUN_LIFETIME_MS = 24 * 3600_000, MAX_RUNS = 500, MAX_ASSERTIONS = 50;
const STATUSES: RunStatus[] = ["running", "paused", "done"];
const STATES: StepState[] = ["todo", "running", "paused", "pass", "fail", "skip", "note", "unreached"];
const MAX_REPORT_BYTES = 512 * 1024, MAX_STEPS = 40, MAX_REQUESTS = 20, MAX_TEXT = 8000;

const json = (b: unknown, status = 200) => Response.json(b, { status, headers: { "cache-control": "no-store" } });
const bad = (error: string) => json({ error }, 400);
const iso = (ms: number) => new Date(ms).toISOString();
const b64url = (b: Uint8Array | ArrayBuffer) => Buffer.from(b instanceof ArrayBuffer ? new Uint8Array(b) : b).toString("base64url");

/** The server as anyone holding the id may see it: everything but the private key, and whether there is one. */
const shownServer = ({ jwk, ...rest }: ServerEntry) => ({ ...rest, ...(jwk ? { hasKey: true, kid: jwk.kid } : {}) });
const view = (r: Run) => ({ id: r.id, server: shownServer(r.server), status: r.status, summary: r.summary, steps: r.steps, updatedAt: iso(r.updatedAt), expiresAt: iso(r.expiresAt) });

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

export function createCheckRuns({ now = Date.now }: { now?: () => number } = {}) {
  const runs = new Map<string, Run>();
  const prune = () => { const t = now(); for (const [id, r] of runs) if (r.expiresAt <= t) runs.delete(id); };
  const live = (id: string) => { prune(); return runs.get(id); };
  const missing = () => json({ error: "no such check run: it may have expired" }, 404);

  /** `origin` is the site's public address, which the link a run answers with starts at. */
  async function fetch(req: Request, url: URL, origin: string): Promise<Response> {
    const m = req.method, parts = url.pathname.slice("/api/checks".length).split("/").filter(Boolean);
    const refused = m === "GET" ? refuseHost(req) : refuseWrite(req, url);
    if (refused) return refused;

    if (parts.length === 0 && m === "POST") {
      const b = await readJson(req);
      if (typeof b !== "object" || !b || Array.isArray(b)) return bad("the request body must be a JSON object");
      const extra = extraField(b, ["server"]); if (extra) return bad(extra);
      let server: ServerEntry;
      try { server = checkServer(b.server, "The server"); } catch (e) { return bad((e as Error).message); }
      prune();
      if (runs.size >= MAX_RUNS) return json({ error: "too many check runs are open: try again later" }, 429);
      const t = now(), id = randomBytes(24).toString("base64url");
      const run: Run = { id, server, status: "waiting", summary: null, steps: [], createdAt: t, updatedAt: t, expiresAt: t + RUN_LIFETIME_MS, assertions: 0 };
      runs.set(id, run);
      return json({ id, url: `${origin}/check?run=${id}`, status: run.status, expiresAt: iso(run.expiresAt) }, 201);
    }
    const run = parts[0] ? live(parts[0]) : undefined;
    if (parts.length === 1 && m === "GET") return run ? json(view(run)) : missing();
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
