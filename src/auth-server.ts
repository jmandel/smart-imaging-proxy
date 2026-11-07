// Authorization Server: user sign-in, the account page where patients delegate to related people
// and users manage apps, SMART App Launch (authorization code with PKCE), Backend Services
// (signed client assertions), refresh, revocation, introspection, and SMART discovery.
import { createECDH, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, hkdfSync, randomBytes, sign, verify, type KeyObject } from "node:crypto";
import { ath, b64url } from "./jws";
import type { PolicyStore } from "./policy-store";
import { now } from "./clock";
import { refuseWrite } from "./admin-api";
import { PORTS } from "./config";
import { check, traced } from "./trace";

export interface Grant { client_id: string; scope: string; patient?: string; sub?: string; fhirUser?: string; family?: string; }

export interface BackendClient { client_id: string; kid: string; privateKey: KeyObject; }
export const DEMO_BACKEND_CLIENTS = ["hand-referral-service", "outside-release-service", "research-donation"];
export const DEMO_BACKEND_SCOPES = ["system/ImagingStudy.rs"];
const kidOf = (client_id: string) => `${client_id}-key`;
/**
 * A demo client with its key derived from SERVICE_SECRET, for a deployment split across processes,
 * where a generated key would have no way to reach the client. Holding the secret means being able to act as these clients.
 */
export function derivedBackendClient(client_id: string, serviceSecret: string): BackendClient {
  const d = Buffer.from(hkdfSync("sha256", serviceSecret, "", `smart-imaging-demo backend client ${client_id}`, 32));
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(d);
  const point = ecdh.getPublicKey();
  const jwk = { kty: "EC", crv: "P-256", d: d.toString("base64url"), x: point.subarray(1, 33).toString("base64url"), y: point.subarray(33).toString("base64url") };
  return { client_id, kid: kidOf(client_id), privateKey: createPrivateKey({ key: jwk, format: "jwk" }) };
}

/** A table looked up by request input. It has no inherited keys, such as "constructor", to find. */
const table = <T>(rows: Record<string, T>): Record<string, T> => Object.assign(Object.create(null), rows);

// Demo accounts. A deployment's identity provider would hold these.
export interface DemoUser { name: string; fhirUser: string; patient?: string; }
export const USERS = table<DemoUser>({
  josh: { name: "Josh Example", fhirUser: "Patient/josh-example", patient: "josh-example" },
  robin: { name: "Robin Example", fhirUser: "Patient/robin-example", patient: "robin-example" },
  "sam-caregiver": { name: "Sam Example", fhirUser: "RelatedPerson/sam-caregiver" },
  "alex-neighbor": { name: "Alex Neighbor", fhirUser: "RelatedPerson/alex-neighbor" },
});
const userOf = (name: string): DemoUser | undefined => Object.hasOwn(USERS, name) ? USERS[name] : undefined;
export const PATIENT_NAMES = table<string>({ "josh-example": "Josh Example", "robin-example": "Robin Example" });
export const APP_NAMES = table<string>({ "portal-app": "Health Records App", "separate-viewer": "Separate Image Viewer" });
/** Describes an account by what's in place now: "Patient", the delegations it holds, or neither. */
export const RELATIONSHIPS = ["caregiver", "spouse", "adult child", "neighbor"];

export function roleOf(u: DemoUser, held: { patient: string; relationship?: string }[]) {
  if (u.patient) return "Patient";
  if (!held.length) return "Related person, nothing shared yet";
  const line = held.map(r => `${r.relationship ?? "related person"} for ${PATIENT_NAMES[r.patient] ?? r.patient}`).join(", ");
  return line[0]!.toUpperCase() + line.slice(1);
}

export interface AccessSummary {
  records: { patient: string; via: "self" | "delegation"; relationship?: string; sites: string[] }[];
  delegations: { patient: string; delegate: string; relationship: string; sites: string[] }[];
  apps: { client: string; patient: string; sites?: string[] }[];
}
/** The Imaging Server holds delegations and app authorizations, so policy stays in one place. */
export interface Directory {
  relationships(): Promise<{ patient: string; delegate: string; relationship: string }[]>;
  access(user: string, fhirUser: string): Promise<AccessSummary>;
  recordConsent(c: { client: string; user: string; fhirUser: string; patient: string; sites?: string[] }): Promise<void>;
  delegate(d: { patient: string; grantedBy: string; fhirUser: string; delegate: string; relationship: string; sites: string[] }): Promise<void>;
  revokeDelegation(grantedBy: string, delegate: string): Promise<void>;
  revokeApp(client: string, user: string): Promise<void>;
}

const PAGE_CSS = `
:root{color-scheme:light dark;--bg:#e9f0f5;--panel:#fbfdfe;--ink:#13242f;--muted:#4f6675;--line:#cfdbe3;--accent:#0a6a9c;--accent-soft:#d9e9f2;--bad:#ad2f28;--bad-soft:#f8e2df;--warn:#845800;--warn-soft:#f6ebcd;--code:#e3ebf0}
@media (prefers-color-scheme:dark){:root{--bg:#0a1822;--panel:#10232f;--ink:#e4edf2;--muted:#9ab0bd;--line:#27404f;--accent:#6cbfe8;--accent-soft:#17384c;--bad:#ff9d92;--bad-soft:#42201d;--warn:#f2c55c;--warn-soft:#3a2f10;--code:#1b3241}}
*{box-sizing:border-box}
body{margin:0;padding:1.5rem 1rem 2rem;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
.brand,.store-line{max-width:560px;margin:0 auto;color:var(--muted);font-size:.8rem}
.brand{margin-bottom:.5rem;font-weight:600;letter-spacing:.02em}
.store-line{margin-top:.6rem}
main{max-width:560px;margin:0 auto;padding:1.4rem 1.5rem;background:var(--panel);border:1px solid var(--line);border-radius:10px}
h1{font-size:1.25rem;line-height:1.3;margin:0 0 .35rem}
h2{font-size:.98rem;margin:0 0 .4rem}
section{margin-top:1.4rem;padding-top:1.1rem;border-top:1px solid var(--line)}
p{margin:.3rem 0 .6rem}
code{background:var(--code);padding:.05em .3em;border-radius:4px;font:.86em ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
.who{color:var(--muted);font-size:.9rem}
.note{color:var(--muted);font-size:.85rem}
.error{color:var(--bad);background:var(--bad-soft);font-weight:600;padding:.5rem .7rem;border-radius:6px}
.demo-note{background:var(--warn-soft);color:var(--warn);font-size:.88rem;font-weight:600;padding:.45rem .7rem;border-radius:6px;margin:.8rem 0}
fieldset{border:1px solid var(--line);border-radius:8px;margin:.9rem 0;padding:.55rem .85rem .7rem;min-width:0}
legend{font-weight:600;padding:0 .3rem}
fieldset label{display:block;padding:.2rem 0}
.legend{font-weight:600;margin:.6rem 0 .1rem}
label.field{display:block;padding:.25rem 0;font-weight:600;font-size:.9rem}
select{display:block;width:100%;font:inherit;font-weight:400;color:inherit;background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:.4rem .5rem;margin-top:.15rem}
.scopes{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:.3rem .5rem}
.accounts{border:0;padding:0;margin:0}
.accounts legend{padding:0;margin-bottom:.45rem}
label.account{display:flex;align-items:center;gap:.8rem;padding:.65rem .8rem;margin:0 0 .5rem;border:1px solid var(--line);border-radius:8px;cursor:pointer}
label.account:hover{background:var(--code)}
label.account:has(input:checked){border-color:var(--accent);background:var(--accent-soft);box-shadow:inset 0 0 0 1px var(--accent)}
label.account input{order:3;margin:0 0 0 auto;width:1.1rem;height:1.1rem;flex:none;accent-color:var(--accent)}
.avatar{flex:none;display:inline-flex;align-items:center;justify-content:center;width:2.6rem;height:2.6rem;border-radius:50%;background:var(--accent);color:var(--panel);font-weight:700;font-size:.92rem}
.account-text{display:flex;flex-direction:column;min-width:0;line-height:1.35}
.account-text .role{color:var(--muted);font-size:.88rem}
.account-text code{align-self:flex-start;margin-top:.15rem;font-size:.78rem}
.profile{display:flex;gap:.8rem;align-items:center}
.profile h1{margin:0}
.profile .who{margin:.1rem 0 0}
.rows{list-style:none;margin:.3rem 0 .6rem;padding:0}
.rows li{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:.3rem .8rem;padding:.45rem 0;border-bottom:1px solid var(--line)}
.rows li:last-child{border-bottom:0}
.rows li>span{min-width:0;flex:1 1 14rem}
.buttons{display:flex;flex-wrap:wrap;gap:.6rem;align-items:center;margin-top:1rem}
button,.button{font:inherit;padding:.45rem 1rem;border-radius:6px;cursor:pointer;border:1px solid var(--line);background:var(--panel);color:var(--ink);text-decoration:none;display:inline-block}
button:hover{background:var(--code)}
button.primary,.button{background:var(--accent);border-color:var(--accent);color:var(--panel);font-weight:600}
button.primary:hover{background:var(--accent);filter:brightness(1.1)}
form.inline{display:inline}
.rows form.inline button{padding:.15rem .6rem;font-size:.84rem}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
@media (max-width:480px){body{padding:.75rem 0 1.5rem}.brand,.store-line{padding:0 1rem}main{border-radius:0;border-width:1px 0;padding:1.1rem 1rem}}
`;

export function createAuthServer(opts: { issuer: string; imagingFhirBase: string; serviceSecret: string; redirectUri: string; directory: Directory; store: () => PolicyStore; storeLabel: () => string }) {
  const PUBLIC_CLIENTS = table<{ name: string; redirectUris: string[] }>({
    "portal-app": { name: APP_NAMES["portal-app"]!, redirectUris: [opts.redirectUri] },
    "separate-viewer": { name: APP_NAMES["separate-viewer"]!, redirectUris: [opts.redirectUri] },
  });
  const txns = new Map<string, { client_id: string; redirect_uri: string; state: string; scope: string; code_challenge: string; exp: number; user?: string; login_hint?: string }>();
  const accountSessions = new Map<string, string>();
  const decidedBy = new Map<string, string>();
  let lastAccountSignIn: string | undefined;
  const usedJti = new Set<string>();
  const codes = new Map<string, { grant: Grant; client_id: string; redirect_uri: string; code_challenge: string; exp: number }>();
  const backendKeys = new Map<string, { kid: string; publicKey: KeyObject; scopes: string[] }>();

  const issue = (given: Grant, withRefresh: boolean) => {
    // Tokens from one refresh chain share a family, so replaying a used one can revoke the others.
    const g = withRefresh ? { ...given, family: given.family ?? randomBytes(16).toString("base64url") } : given;
    const access_token = randomBytes(32).toString("base64url");
    const tokenLifetime = opts.store().getSettings().tokenLifetimeSeconds;
    const exp = now() + tokenLifetime;
    opts.store().putToken(access_token, "access", g, exp);
    check("authorization-server", "issue access token", true, { client: g.client_id, scope: g.scope, patient_context: g.patient, user: g.sub, token_hash: ath(access_token).slice(0, 10), expires_in: tokenLifetime });
    const res: any = { access_token, token_type: "Bearer", expires_in: tokenLifetime, scope: g.scope };
    if (g.patient) res.patient = g.patient;
    if (withRefresh) { const r = randomBytes(32).toString("base64url"); opts.store().putToken(r, "refresh", g, now() + opts.store().getSettings().refreshTokenLifetimeSeconds); res.refresh_token = r; }
    return res;
  };
  const tokenResponse = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store", Pragma: "no-cache" } });
  const oauthError = (error: string, status = 400) => tokenResponse({ error }, status);

  /** A JWT part's JSON object, or undefined for anything else. */
  const jwtPart = (part: string | undefined): any => {
    try { const o = JSON.parse(Buffer.from(part ?? "", "base64url").toString()); return typeof o === "object" && o !== null ? o : undefined; }
    catch { return undefined; }
  };

  function verifyAssertion(jwt: string, tokenUrl: string) {
    const [h, b, s] = jwt.split(".");
    const head = jwtPart(h), claims = jwtPart(b);
    if (!check("authorization-server", "client assertion is a three-part JWT", !!(head && claims && s))) return undefined;
    const reg = backendKeys.get(claims.iss);
    if (!check("authorization-server", "client is registered, with its public key on file", !!reg && head.kid === reg.kid, { client: claims.iss, kid: head.kid, registered_scopes: reg?.scopes.join(" ") })) return undefined;
    if (!check("authorization-server", "assertion is ES256, and iss equals sub", head.alg === "ES256" && claims.sub === claims.iss, { alg: head.alg, iss: claims.iss, sub: claims.sub })) return undefined;
    if (!check("authorization-server", "assertion's aud is this token endpoint", claims.aud === tokenUrl, { aud: claims.aud })) return undefined;
    if (!check("authorization-server", "assertion hasn't expired", Number.isInteger(claims.exp) && claims.exp >= now(), { exp: claims.exp, now: now() })) return undefined;
    if (!check("authorization-server", "assertion's exp is no more than five minutes ahead", claims.exp <= now() + 300, { exp: claims.exp, now: now() })) return undefined;
    if (!check("authorization-server", "assertion's jti hasn't been used", typeof claims.jti === "string" && !!claims.jti && !usedJti.has(claims.jti), { jti: claims.jti })) return undefined;
    const ok = verify("sha256", Buffer.from(`${h}.${b}`), { key: reg!.publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s!, "base64url"));
    check("authorization-server", "client assertion signature verifies", ok, { client: claims.iss, kid: head.kid, alg: head.alg });
    if (ok) usedJti.add(claims.jti);
    return ok ? { client_id: claims.iss as string, scopes: reg!.scopes } : undefined;
  }

  const page = (title: string, body: string, status = 200, showStore = false) => new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>${PAGE_CSS}</style></head><body><p class="brand">Authorization Server</p><main>${body}</main>${showStore ? `<p class="store-line">Policy in use: ${esc(opts.storeLabel())}</p>` : ""}</body></html>`, { status, headers: { "content-type": "text/html; charset=utf-8" } });
  const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

  const demoQuery = (url: URL) => { const q = new URLSearchParams(); for (const k of ["demo_traceparent", "demo_session", "return", "return_state"]) if (url.searchParams.get(k)) q.set(k, url.searchParams.get(k)!); const s = q.toString(); return s ? `&${s}` : ""; };
  const redirectTo = (location: string) => new Response(null, { status: 303, headers: { Location: location } });
  const initials = (name: string) => name.split(/\s+/).map(w => w[0]).join("").slice(0, 2).toUpperCase();
  /** The account picker. It's a plain form, so it works with no script. */
  const signInForm = async (action: string, hint = "", error = "") => {
    const relationships = await opts.directory.relationships();
    return `
    ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}
    <p class="demo-note">This is a demo: picking an account stands in for real authentication.</p>
    <form method="post" action="${esc(action)}">
      <fieldset class="accounts"><legend>Choose an account</legend>
        ${Object.entries(USERS).map(([id, u]) => `<label class="account"><input type="radio" name="username" value="${esc(id)}" ${id === hint ? "checked" : ""} required><span class="avatar" aria-hidden="true">${esc(initials(u.name))}</span><span class="account-text"><b>${esc(u.name)}</b><span class="role">${esc(roleOf(u, relationships.filter(r => r.delegate === id)))}</span><code>${esc(u.fhirUser)}</code></span></label>`).join("")}
      </fieldset>
      <div class="buttons"><button class="primary">Continue</button></div>
    </form>`;
  };
  const signIn = (f: URLSearchParams) => {
    const name = f.get("username") ?? "";
    return check("authorization-server", "demo sign-in: account selected, no credential checked", !!userOf(name), { user: name }) ? name : undefined;
  };
  const NOT_AN_ACCOUNT = "That isn't one of the demo accounts. Choose one below.";
  const siteBoxes = (sites: string[], checked: string[] = sites) => `<input type="hidden" name="sites_shown" value="1">${sites.map(s => `<label><input type="checkbox" name="sites" value="${esc(s)}" ${checked.includes(s) ? "checked" : ""}> ${esc(s)}</label>`).join("")}`;

  async function authorize(url: URL): Promise<Response> {
    const q = url.searchParams;
    const client = PUBLIC_CLIENTS[q.get("client_id") ?? ""];
    // Client and redirect URI errors must not redirect, since the target can't be trusted.
    if (!check("authorization-server", "client is registered", !!client, { client: q.get("client_id") })) return page("Authorization error", "<h1>Unknown client</h1>", 400);
    if (!check("authorization-server", "redirect_uri exactly matches registration", client!.redirectUris.includes(q.get("redirect_uri") ?? ""), { redirect_uri: q.get("redirect_uri") })) return page("Authorization error", "<h1>Unregistered redirect URI</h1>", 400);
    const back = (error: string) => { const u = new URL(q.get("redirect_uri")!); u.searchParams.set("error", error); if (q.get("state")) u.searchParams.set("state", q.get("state")!); return new Response(null, { status: 302, headers: { Location: u.toString() } }); };
    if (!check("authorization-server", "response_type is code", q.get("response_type") === "code")) return back("unsupported_response_type");
    if (!check("authorization-server", "state is present", !!q.get("state"))) return back("invalid_request");
    if (!check("authorization-server", "PKCE: S256 challenge is present", q.get("code_challenge_method") === "S256" && !!q.get("code_challenge"), { method: q.get("code_challenge_method") })) return back("invalid_request");
    if (!check("authorization-server", "aud is a FHIR server this deployment authorizes", q.get("aud") === `${opts.issuer}/fhir` || q.get("aud") === opts.imagingFhirBase, { aud: q.get("aud") })) return back("invalid_scope");
    const scope = q.get("scope") ?? "";
    if (!check("authorization-server", "scope is requested", scope.length > 0, { scope })) return back("invalid_scope");
    if (!check("authorization-server", "scope has no system-level access, which only Backend Services clients get", !scope.split(" ").some(s => s.startsWith("system/")), { scope })) return back("invalid_scope");
    const id = randomBytes(16).toString("base64url");
    txns.set(id, { client_id: q.get("client_id")!, redirect_uri: q.get("redirect_uri")!, state: q.get("state")!, scope, code_challenge: q.get("code_challenge")!, exp: now() + 600, login_hint: q.get("login_hint") ?? undefined });
    return page("Sign in", `<h1>Sign in to continue to ${esc(client!.name)}</h1><p class="who">This page belongs to the Authorization Server, not the app.</p>${await signInForm(`/authorize/signin?txn=${id}${demoQuery(url)}`, q.get("login_hint") ?? "")}`);
  }

  const txnOf = (url: URL) => {
    const id = url.searchParams.get("txn") ?? "";
    const txn = txns.get(id);
    return check("authorization-server", "authorization request is known and unexpired", !!txn && txn.exp > now()) ? { id, txn: txn! } : undefined;
  };
  const expired = () => page("Authorization error", "<h1>This request has expired</h1>", 400);

  async function authorizeSignIn(url: URL, req: Request): Promise<Response> {
    const t = txnOf(url);
    if (!t) return expired();
    const user = signIn(new URLSearchParams(await req.text()));
    const client = PUBLIC_CLIENTS[t.txn.client_id]!;
    if (!user) return page("Sign in", `<h1>Sign in to continue to ${esc(client.name)}</h1>${await signInForm(`/authorize/signin?txn=${t.id}${demoQuery(url)}`, t.txn.login_hint ?? "", NOT_AN_ACCOUNT)}`, 401);
    t.txn.user = user;
    return redirectTo(`/authorize/consent?txn=${t.id}${demoQuery(url)}`);
  }

  async function consentPage(url: URL): Promise<Response> {
    const t = txnOf(url);
    if (!t) return expired();
    if (!check("authorization-server", "user has signed in", !!t.txn.user)) return page("Authorization error", "<h1>Sign in first</h1>", 401);
    const user = USERS[t.txn.user!]!;
    const client = PUBLIC_CLIENTS[t.txn.client_id]!;
    const access = await opts.directory.access(t.txn.user!, user.fhirUser);
    const action = `/authorize/decision?txn=${t.id}${demoQuery(url)}`;
    if (!access.records.length) return page("No records", `<h1>No records are shared with you</h1><p>${esc(user.name)} is signed in, but no patient has delegated access to this account, so there's nothing to share with ${esc(client.name)}.</p><form method="post" action="${esc(action)}"><div class="buttons"><button name="decision" value="deny">Return to the app</button></div></form>`, 200, true);
    const record = access.records[0]!;
    const existing = access.apps.find(a => a.client === t.txn.client_id && a.patient === record.patient);
    const describe = (r: AccessSummary["records"][number]) => r.via === "self" ? `${esc(PATIENT_NAMES[r.patient] ?? r.patient)}: your own records` : `${esc(PATIENT_NAMES[r.patient] ?? r.patient)}: shared with you as ${esc(r.relationship ?? "a related person")}`;
    const choosable = [...new Set(access.records.flatMap(r => r.sites))];
    const sites = choosable.length
      ? `<fieldset><legend>Sites this app can see</legend>${siteBoxes(choosable, existing?.sites ?? choosable)}<p class="note">${record.via === "delegation" ? "You can share only what was shared with you. " : ""}SMART scopes can't express this choice. It's kept as Imaging Server policy, and the token's scope doesn't change.</p></fieldset>`
      : `<p class="note">No imaging studies are on file for you, so this app will find none.</p>`;
    return page("Authorize app", `<h1>Let ${esc(client.name)} access imaging records?</h1>
      <p class="who">Signed in as ${esc(user.name)} (<code>${esc(user.fhirUser)}</code>).</p>
      <form method="post" action="${esc(action)}">
        <fieldset><legend>Whose records</legend>${access.records.map((r, i) => `<label><input type="radio" name="patient" value="${esc(r.patient)}" ${i === 0 ? "checked" : ""}> ${describe(r)}</label>`).join("")}</fieldset>
        <fieldset><legend>Requested permissions</legend><ul class="scopes">${t.txn.scope.split(" ").map(s => `<li><code>${esc(s)}</code></li>`).join("")}</ul></fieldset>
        ${sites}
        <div class="buttons"><button class="primary" name="decision" value="approve">Approve</button><button name="decision" value="deny">Deny</button></div>
      </form>`, 200, true);
  }

  async function decide(url: URL, req: Request): Promise<Response> {
    const t = txnOf(url);
    if (!t) return expired();
    if (!check("authorization-server", "user has signed in", !!t.txn.user)) return page("Authorization error", "<h1>Sign in first</h1>", 401);
    const txn = t.txn;
    txns.delete(t.id);
    decidedBy.set(txn.state, txn.user!);
    const f = new URLSearchParams(await req.text());
    const back = new URL(txn.redirect_uri);
    back.searchParams.set("state", txn.state);
    const deny = () => { back.searchParams.set("error", "access_denied"); return new Response(null, { status: 302, headers: { Location: back.toString() } }); };
    if (!check("authorization-server", "user approves", f.get("decision") === "approve", { user: txn.user, decision: f.get("decision") })) return deny();
    const user = USERS[txn.user!]!;
    const access = await opts.directory.access(txn.user!, user.fhirUser);
    const record = access.records.find(r => r.patient === (f.get("patient") ?? access.records[0]?.patient));
    if (!check("authorization-server", "user has access to the chosen patient", !!record, { user: txn.user, patient: f.get("patient"), via: record?.via })) return deny();
    await opts.directory.recordConsent({ client: txn.client_id, user: txn.user!, fhirUser: user.fhirUser, patient: record!.patient, ...(f.get("sites_shown") ? { sites: f.getAll("sites") } : {}) });
    const grant: Grant = { client_id: txn.client_id, scope: txn.scope, sub: txn.user!, fhirUser: user.fhirUser };
    if (/(^| )launch\/patient( |$)/.test(txn.scope)) grant.patient = record!.patient;
    const code = randomBytes(24).toString("base64url");
    codes.set(code, { grant, client_id: txn.client_id, redirect_uri: txn.redirect_uri, code_challenge: txn.code_challenge, exp: now() + 60 });
    check("authorization-server", "issue single-use authorization code", true, { lifetime_seconds: 60, patient: grant.patient, user: grant.sub, sites: f.getAll("sites").join(", ") || undefined });
    back.searchParams.set("code", code);
    return new Response(null, { status: 302, headers: { Location: back.toString() } });
  }

  const accountUser = (req: Request) => accountSessions.get(req.headers.get("cookie")?.match(/account_session=([^;]+)/)?.[1] ?? "");
  const appName = (id: string) => PUBLIC_CLIENTS[id]?.name ?? id;

  async function account(url: URL, req: Request): Promise<Response> {
    const hint = url.searchParams.get("login_hint") ?? "";
    // A link meant for another account asks for that account, rather than showing the one signed in.
    const signedIn = accountUser(req);
    const name = hint && signedIn !== hint ? undefined : signedIn;
    const q = demoQuery(url).replace(/^&/, "?");
    const returnTo = url.searchParams.get("return") === opts.redirectUri ? opts.redirectUri : undefined;
    if (!name) return page("Sign in", `<h1>Sign in to your account</h1>${await signInForm(`/account/signin${q}${hint ? `${q ? "&" : "?"}login_hint=${encodeURIComponent(hint)}` : ""}`, hint)}`);
    const user = USERS[name]!;
    const access = await opts.directory.access(name, user.fhirUser);
    const others = Object.entries(USERS).filter(([id]) => id !== name);
    const held = (r: AccessSummary["records"][number]) => r.sites.length ? r.sites.join(", ") : r.via === "self" ? "No imaging studies on file" : "No sites";
    const records = access.records.length ? `<ul class="rows">${access.records.map(r => `<li><span><b>${esc(PATIENT_NAMES[r.patient] ?? r.patient)}</b>: ${r.via === "self" ? "your own records" : `shared with you as ${esc(r.relationship ?? "a related person")}`}. ${esc(held(r))}.</span></li>`).join("")}</ul>` : `<p class="note">Nothing yet. A patient has to delegate access to this account.</p>`;
    const ownSites = access.records.find(r => r.via === "self")?.sites ?? [];
    const shareForm = ownSites.length ? `<form method="post" action="/account/delegations${q}">
        <fieldset><legend>Share with a related person</legend>
          <label class="field">Person <select name="delegate">${others.map(([id, u]) => `<option value="${esc(id)}">${esc(u.name)}</option>`).join("")}</select></label>
          <label class="field">Relationship <select name="relationship">${RELATIONSHIPS.map(r => `<option>${esc(r)}</option>`).join("")}</select></label>
          <p class="legend">Sites they can see</p>${siteBoxes(ownSites)}
          <div class="buttons"><button class="primary">Share</button></div>
        </fieldset>
      </form>` : `<p class="note">You have no imaging studies on file, so there's nothing to share yet.</p>`;
    const people = user.patient ? `<section><h2>People who can sign in and see your records</h2>
      ${access.delegations.length ? `<ul class="rows">${access.delegations.map(d => `<li><span><b>${esc(USERS[d.delegate]?.name ?? d.delegate)}</b> (${esc(d.relationship)}): ${esc(d.sites.join(", ") || "no sites")}</span><form class="inline" method="post" action="/account/delegations/revoke${q}"><input type="hidden" name="delegate" value="${esc(d.delegate)}"><button>Revoke</button></form></li>`).join("")}</ul>` : `<p class="note">No one yet.</p>`}
      ${shareForm}</section>` : "";
    const apps = access.apps.length ? `<ul class="rows">${access.apps.map(a => `<li><span><b>${esc(appName(a.client))}</b>: ${esc(a.sites?.join(", ") ?? "everything you can see")}</span><form class="inline" method="post" action="/account/apps/revoke${q}"><input type="hidden" name="client" value="${esc(a.client)}"><button>Revoke</button></form></li>`).join("")}</ul>` : `<p class="note">None yet. An app appears here after you approve it during its sign-in.</p>`;
    return page("Your account", `<div class="profile"><span class="avatar" aria-hidden="true">${esc(initials(user.name))}</span><div><h1>${esc(user.name)}</h1><p class="who">${esc(roleOf(user, access.records.filter(r => r.via === "delegation")))}. Signed in as <code>${esc(name)}</code>, <code>${esc(user.fhirUser)}</code>.</p></div></div>
      <section><h2>Records you can access</h2>${records}</section>
      ${people}
      <section><h2>Apps you've authorized</h2>${apps}<p class="note">Anyone with access can authorize an app, and can give it only part of what they hold.</p></section>
      <div class="buttons">${returnTo ? `<a class="button" href="${esc(returnTo)}?account=done&amp;state=${encodeURIComponent(url.searchParams.get("return_state") ?? "")}">Done, back to the demo</a>` : ""}<form class="inline" method="post" action="/account/signout"><button>Sign out</button></form></div>`, 200, true);
  }

  async function accountPost(url: URL, req: Request): Promise<Response> {
    const q = demoQuery(url).replace(/^&/, "?");
    const f = new URLSearchParams(await req.text());
    if (url.pathname === "/account/signin") {
      const name = signIn(f);
      if (!name) return page("Sign in", `<h1>Sign in to your account</h1>${await signInForm(`/account/signin${q}`, url.searchParams.get("login_hint") ?? "", NOT_AN_ACCOUNT)}`, 401);
      const id = randomBytes(24).toString("base64url");
      accountSessions.set(id, name);
      lastAccountSignIn = name;
      return new Response(null, { status: 303, headers: { Location: `/account${q}`, "Set-Cookie": `account_session=${id}; HttpOnly; SameSite=Lax; Path=/` } });
    }
    if (url.pathname === "/account/signout") {
      accountSessions.delete(req.headers.get("cookie")?.match(/account_session=([^;]+)/)?.[1] ?? "");
      return new Response(null, { status: 303, headers: { Location: "/account", "Set-Cookie": "account_session=; Max-Age=0; Path=/" } });
    }
    const name = accountUser(req);
    if (!check("authorization-server", "account session is signed in", !!name)) return page("Sign in", "<h1>Sign in first</h1>", 401);
    const user = USERS[name!]!;
    if (url.pathname === "/account/delegations") {
      const delegate = f.get("delegate") ?? "";
      if (!check("authorization-server", "relationship is one of the offered choices", RELATIONSHIPS.includes(f.get("relationship") ?? ""), { relationship: f.get("relationship") })) return page("Not allowed", "<h1>Pick a relationship from the list</h1>", 400);
      if (!check("authorization-server", "user can delegate: they're the patient, and the delegate has an account", !!user.patient && !!userOf(delegate) && delegate !== name, { user: name, delegate })) return page("Not allowed", "<h1>Only a patient can delegate their records</h1>", 403);
      await opts.directory.delegate({ patient: user.patient!, grantedBy: name!, fhirUser: user.fhirUser, delegate, relationship: f.get("relationship") || "related person", sites: f.getAll("sites") });
    } else if (url.pathname === "/account/delegations/revoke") await opts.directory.revokeDelegation(name!, f.get("delegate") ?? "");
    else if (url.pathname === "/account/apps/revoke") await opts.directory.revokeApp(f.get("client") ?? "", name!);
    else return new Response("not found", { status: 404 });
    return redirectTo(`/account${q}`);
  }

  const fetchHandler = traced("authorization-server", async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const tokenUrl = `${opts.issuer}/token`;
    const browserForm = req.method === "POST" && (url.pathname === "/authorize/signin" || url.pathname === "/authorize/decision" || url.pathname.startsWith("/account/"));
    if (browserForm) { const refused = refuseWrite(req, url, PORTS.auth); if (refused) return refused; }
    if (url.pathname === "/fhir/.well-known/smart-configuration") {
      return Response.json({
        issuer: opts.issuer, authorization_endpoint: `${opts.issuer}/authorize`, token_endpoint: tokenUrl,
        introspection_endpoint: `${opts.issuer}/introspect`, revocation_endpoint: `${opts.issuer}/revoke`,
        grant_types_supported: ["authorization_code", "client_credentials", "refresh_token"],
        response_types_supported: ["code"], code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["private_key_jwt"], token_endpoint_auth_signing_alg_values_supported: ["ES256"],
        scopes_supported: ["patient/ImagingStudy.rs", "system/ImagingStudy.rs", "launch/patient", "online_access"],
        capabilities: ["launch-standalone", "client-public", "client-confidential-asymmetric", "permission-v2", "context-standalone-patient"],
        associated_endpoints: [{ url: opts.imagingFhirBase, capabilities: ["smart-imaging-access", "http://fhir.org/argonaut/smart-imaging/capabilities/app-launch", "http://fhir.org/argonaut/smart-imaging/capabilities/backend-services"] }],
      });
    }
    if (url.pathname === "/token" && req.method === "POST") {
      const f = new URLSearchParams(await req.text());
      const grant = f.get("grant_type");
      if (grant === "client_credentials") {
        if (!check("authorization-server", "client authenticates with private_key_jwt", f.get("client_assertion_type") === "urn:ietf:params:oauth:client-assertion-type:jwt-bearer")) return oauthError("invalid_client", 401);
        const reg = verifyAssertion(f.get("client_assertion") ?? "", tokenUrl);
        if (!reg) return oauthError("invalid_client", 401);
        const asked = (f.get("scope") ?? "").split(" ").filter(s => reg.scopes.includes(s));
        if (!check("authorization-server", "requested scope is within the client's registration", asked.length > 0, { requested: f.get("scope"), granted: asked.join(" ") })) return oauthError("invalid_scope");
        return tokenResponse(issue({ client_id: reg.client_id, scope: asked.join(" ") }, false));
      }
      if (grant === "authorization_code") {
        const code = f.get("code") ?? "";
        const c = codes.get(code);
        if (!check("authorization-server", "authorization code is known and unused", !!c, { client: f.get("client_id") })) return oauthError("invalid_grant");
        codes.delete(code); // Single use, even if a later check fails.
        if (!check("authorization-server", "authorization code hasn't expired", c!.exp > now())) return oauthError("invalid_grant");
        if (!check("authorization-server", "client_id and redirect_uri match the authorization request", c!.client_id === f.get("client_id") && c!.redirect_uri === f.get("redirect_uri"))) return oauthError("invalid_grant");
        const verifier = f.get("code_verifier") ?? "";
        const computed = createHash("sha256").update(verifier).digest("base64url");
        if (!check("authorization-server", "PKCE: S256 of code_verifier equals code_challenge", computed === c!.code_challenge, { computed: computed.slice(0, 10), challenge: c!.code_challenge.slice(0, 10) })) return oauthError("invalid_grant");
        return tokenResponse(issue(c!.grant, /(^| )(online|offline)_access( |$)/.test(c!.grant.scope)));
      }
      if (grant === "refresh_token") {
        const presented = f.get("refresh_token") ?? "";
        const held = opts.store().getToken(presented, "refresh");
        if (!held) return oauthError("invalid_grant");
        if (!check("authorization-server", "refresh token was issued to this client", held.client_id === f.get("client_id"), { client: f.get("client_id"), issued_to: held.client_id })) return oauthError("invalid_grant");
        // A used token stays on file, marked revoked, until it expires. Seeing it again means the chain has leaked.
        if (!check("authorization-server", "refresh token hasn't been used or revoked", !held.revoked, { client: held.client_id, family_revoked: held.revoked ? !!held.family : undefined })) {
          if (held.family) opts.store().revokeTokenFamily(held.family);
          return oauthError("invalid_grant");
        }
        if (!check("authorization-server", "refresh token hasn't expired", held.exp === undefined || held.exp > now(), { exp: held.exp, now: now() })) {
          opts.store().deleteToken(presented);
          return oauthError("invalid_grant");
        }
        opts.store().revokeToken(presented);
        const { revoked: _revoked, exp: _exp, ...g } = held;
        return tokenResponse(issue(g, true));
      }
      return oauthError("unsupported_grant_type");
    }
    if (url.pathname === "/authorize" && req.method === "GET") return authorize(url);
    if (url.pathname === "/authorize/signin" && req.method === "POST") return authorizeSignIn(url, req);
    if (url.pathname === "/authorize/consent" && req.method === "GET") return consentPage(url);
    if (url.pathname === "/authorize/decision" && req.method === "POST") return decide(url, req);
    if (url.pathname === "/account" && req.method === "GET") return account(url, req);
    if (url.pathname.startsWith("/account/") && req.method === "POST") return accountPost(url, req);
    if (url.pathname === "/introspect" && req.method === "POST") {
      if (req.headers.get("authorization") !== `Bearer ${opts.serviceSecret}`) return new Response(null, { status: 401 });
      const f = new URLSearchParams(await req.text());
      const t = opts.store().getToken(f.get("token") ?? "", "access");
      check("authorization-server", "introspect token", !!t && !t.revoked && t.exp! > now(), { token_hash: ath(f.get("token") ?? "").slice(0, 10), client: t?.client_id, revoked: t?.revoked, expired: !!t && t.exp! <= now() });
      if (!t || t.revoked || t.exp! <= now()) return Response.json({ active: false });
      const { revoked, family, ...rest } = t;
      return Response.json({ active: true, iss: opts.issuer, ...rest });
    }
    if (url.pathname === "/revoke" && req.method === "POST") {
      const f = new URLSearchParams(await req.text());
      opts.store().revokeToken(f.get("token") ?? "");
      return new Response(null, { status: 200 });
    }
    if (url.pathname.startsWith("/fhir/Patient/")) {
      const id = url.pathname.slice("/fhir/Patient/".length);
      const bearer = req.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
      const t = bearer ? opts.store().getToken(bearer, "access") : undefined;
      if (!check("authorization-server", "patient read has a live access token", !!t && !t.revoked && t.exp! > now(), { token_hash: bearer && ath(bearer).slice(0, 10) })) return new Response(null, { status: 401, headers: { "WWW-Authenticate": bearer ? 'Bearer error="invalid_token"' : "Bearer" } });
      if (!check("authorization-server", "the token's patient context is this patient", t!.patient === id, { patient: id, patient_context: t!.patient })) return new Response(null, { status: 403, headers: { "WWW-Authenticate": 'Bearer error="insufficient_scope"' } });
      if (id !== "josh-example" && id !== "robin-example") return new Response(null, { status: 404 });
      return Response.json({ resourceType: "Patient", id, name: [{ family: "Example", given: [id === "josh-example" ? "Josh" : "Robin"] }] });
    }
    return new Response("not found", { status: 404 });
  });

  return {
    fetch: fetchHandler,
    registerBackendClient(client_id: string, scopes: string[], privateKey: KeyObject = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey): BackendClient {
      const kid = kidOf(client_id);
      backendKeys.set(client_id, { kid, publicKey: createPublicKey(privateKey), scopes });
      return { client_id, kid, privateKey };
    },
    tokenUrl: `${opts.issuer}/token`,
    /** What was granted to this access token, including who signed in. For the demo's own reporting. */
    grantOf(token: string): Grant | undefined { return opts.store().getToken(token, "access"); },
    /** Who signed in for the authorization request with this `state`. For the demo's own reporting. */
    signedInFor(state: string) { return decidedBy.get(state); },
    /** Who last signed in on the account page. For the demo's own reporting. */
    get lastAccountSignIn() { return lastAccountSignIn; },
    /** Clears in-flight sign-ins and account sessions. Token records belong to the stores. */
    reset() { txns.clear(); codes.clear(); accountSessions.clear(); usedJti.clear(); decidedBy.clear(); lastAccountSignIn = undefined; },
  };
}

export function clientAssertion(c: BackendClient, aud: string): string {
  const head = b64url(JSON.stringify({ alg: "ES256", kid: c.kid, typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: c.client_id, sub: c.client_id, aud, jti: randomBytes(8).toString("hex"), exp: now() + 300 }));
  const sig = sign("sha256", Buffer.from(`${head}.${claims}`), { key: c.privateKey, dsaEncoding: "ieee-p1363" });
  return `${head}.${claims}.${b64url(sig)}`;
}
