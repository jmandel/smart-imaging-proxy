// Authorization Server: user sign-in, the account page where patients and guardians delegate to related people
// and users manage apps, SMART App Launch (authorization code with PKCE), Backend Services
// (signed client assertions), refresh, revocation, introspection, and SMART discovery.
import { createECDH, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, hkdfSync, randomBytes, sign, verify, type KeyObject } from "node:crypto";
import { ath, b64url, sameSecret, type Clock, type PolicyStore } from "@smart-imaging-proxy/core";
import { demoClock } from "./clock";
import { refuseWrite } from "./settings-api";
import { PORTS } from "./config";
import { check, recordEvent, traced } from "./trace";
import { clinicalSearch, demographics, isClinicalType } from "./clinical";

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
  "sam-caregiver": { name: "Sam Example", fhirUser: "Patient/sam-example", patient: "sam-example" },
  "alex-neighbor": { name: "Alex Neighbor", fhirUser: "RelatedPerson/alex-neighbor" },
});
const userOf = (name: string): DemoUser | undefined => Object.hasOwn(USERS, name) ? USERS[name] : undefined;
export const PATIENT_NAMES = table<string>({ "josh-example": "Josh Example", "robin-example": "Robin Example", "sam-example": "Sam Example", "riley-example": "Riley Example" });
export const APP_NAMES = table<string>({ "portal-app": "Health Records App", "separate-viewer": "Separate Image Viewer", "demo-client": "SMART Imaging Demo" });

/**
 * Public clients beyond the demo's own, from DEMO_APP_CLIENTS: comma-separated
 * `client_id=redirect_uri` pairs, with an id repeated for each of its redirect URIs. None by default.
 */
export function appClientsFromEnv(value = process.env.DEMO_APP_CLIENTS ?? ""): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const pair of value.split(",").map(s => s.trim()).filter(Boolean)) {
    const at = pair.indexOf("=");
    const id = pair.slice(0, at).trim(), uri = pair.slice(at + 1).trim();
    if (at < 1 || !/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`DEMO_APP_CLIENTS: "${pair}" isn't client_id=redirect_uri`);
    const u = URL.canParse(uri) ? new URL(uri) : undefined;
    if (!u || !/^https?:$/.test(u.protocol) || u.hash) throw new Error(`DEMO_APP_CLIENTS: ${id}'s redirect URI "${uri}" isn't an absolute http(s) URL without a fragment`);
    if (APP_NAMES[id]) throw new Error(`DEMO_APP_CLIENTS: ${id} is one of the demo's own clients`);
    out.set(id, [...(out.get(id) ?? []), uri]);
  }
  return out;
}
/** Describes an account by what's in place now: "Patient", the delegations it holds, or neither. */
export const RELATIONSHIPS = ["caregiver", "spouse", "adult child", "neighbor"];

export function roleOf(u: DemoUser, held: { patient: string; relationship?: string }[]) {
  const line = held.map(r => `${r.relationship ?? "related person"} for ${PATIENT_NAMES[r.patient] ?? r.patient}`).join(", ");
  if (u.patient) return line ? `Patient, and ${line}` : "Patient";
  if (!held.length) return "Related person, nothing shared yet";
  return line[0]!.toUpperCase() + line.slice(1);
}

export interface AccessSummary {
  records: { patient: string; via: "self" | "guardian" | "delegation"; relationship?: string; sites: string[]; studies?: { id: string; site?: string; description?: string; date?: string }[] }[];
  delegations: { patient: string; delegate: string; relationship: string; sites: string[] }[];
  apps: { client: string; patient: string; sites?: string[]; studies?: string[] }[];
}
/** The Imaging Server holds delegations and app authorizations, so policy stays in one place. */
export interface Directory {
  relationships(): Promise<{ patient: string; delegate: string; relationship: string }[]>;
  access(user: string, fhirUser: string): Promise<AccessSummary>;
  /** Records an app approval, or says why organization policy refused it. */
  recordConsent(c: { client: string; user: string; fhirUser: string; patient: string; sites?: string[]; studies?: string[] }): Promise<{ refused?: string }>;
  /** Records a share, or says why organization policy refused it, naming the policy. */
  delegate(d: { patient: string; grantedBy: string; fhirUser: string; delegate: string; relationship: string; sites: string[] }): Promise<{ refused?: string }>;
  revokeDelegation(grantedBy: string, delegate: string, patient?: string): Promise<void>;
  revokeApp(client: string, user: string, patient?: string): Promise<void>;
}

const PAGE_CSS = `
:root{color-scheme:light dark;--bg:#e9f0f5;--panel:#fbfdfe;--ink:#13242f;--muted:#4f6675;--line:#cfdbe3;--accent:#0a6a9c;--accent-soft:#d9e9f2;--bad:#ad2f28;--bad-soft:#f8e2df;--warn:#845800;--warn-soft:#f6ebcd;--code:#e3ebf0}
@media (prefers-color-scheme:dark){:root{--bg:#0a1822;--panel:#10232f;--ink:#e4edf2;--muted:#9ab0bd;--line:#27404f;--accent:#6cbfe8;--accent-soft:#17384c;--bad:#ff9d92;--bad-soft:#42201d;--warn:#f2c55c;--warn-soft:#3a2f10;--code:#1b3241}}
*{box-sizing:border-box}
body{margin:0;padding:1.5rem 1rem 2rem;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
.brand{max-width:560px;margin:0 auto;color:var(--muted);font-size:.8rem}
.brand{margin-bottom:.5rem;font-weight:600;letter-spacing:.02em}
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
.site-row{padding:.1rem 0}
.site-row details{margin:0 0 .25rem 1.65rem;font-size:.92rem}
.site-row summary{cursor:pointer;color:var(--accent);min-height:1.8rem}
.site-row details label{padding:.3rem 0;overflow-wrap:anywhere}
.site-row:has(> label input:not(:checked)) details{display:none}
.legend{font-weight:600;margin:.6rem 0 .1rem}
label.field{display:block;padding:.25rem 0;font-weight:600;font-size:.9rem}
select{display:block;width:100%;font:inherit;font-weight:400;color:inherit;background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:.4rem .5rem;margin-top:.15rem}
.tag{display:inline-block;font-size:.76rem;font-weight:700;border-radius:4px;padding:.02rem .4rem;background:var(--code);white-space:nowrap}
.tag.self{background:var(--accent-soft);color:var(--accent)}
.people-group{color:var(--muted);font-size:.85rem;font-weight:600;margin:.5rem 0 .3rem}
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
@media (max-width:480px){body{padding:.75rem 0 1.5rem}.brand{padding:0 1rem}main{border-radius:0;border-width:1px 0;padding:1.1rem 1rem}}
`;

/**
 * Every URL it issues starts at `issuer`, including the paths in its own pages and redirects, so it can
 * be served under a prefix. It answers requests with the prefix already taken off.
 */
export function createAuthServer(opts: { issuer: string; imagingFhirBase: string; serviceSecret: string; redirectUri: string; demoClientRedirectUri: string; registeredClient?: (id: string) => { name: string; redirectUris: string[] } | undefined; directory: Directory; store: () => PolicyStore; clock?: Clock }) {
  const clock = opts.clock ?? demoClock;
  const now = () => clock.now();
  /** The path the issuer adds, which every path this server writes into a page or a redirect starts with. */
  const P = new URL(opts.issuer).pathname.replace(/\/$/, "");
  const PUBLIC_CLIENTS = table<{ name: string; redirectUris: string[] }>({
    "portal-app": { name: APP_NAMES["portal-app"]!, redirectUris: [opts.redirectUri] },
    "separate-viewer": { name: APP_NAMES["separate-viewer"]!, redirectUris: [opts.redirectUri] },
    "demo-client": { name: APP_NAMES["demo-client"]!, redirectUris: [opts.demoClientRedirectUri] },
    ...Object.fromEntries([...appClientsFromEnv()].map(([id, redirectUris]) => [id, { name: id, redirectUris }])),
  });
  const clientOf = (id: string) => PUBLIC_CLIENTS[id] ?? opts.registeredClient?.(id);
  const txns = new Map<string, { client_id: string; redirect_uri: string; state: string; scope: string; code_challenge: string; exp: number; user?: string; login_hint?: string; patient_hint?: string }>();
  const accountSessions = new Map<string, string>();
  const decidedBy = new Map<string, string>();
  let lastAccountSignIn: string | undefined;
  const usedJti = new Set<string>();
  const codes = new Map<string, { grant: Grant; client_id: string; redirect_uri: string; code_challenge: string; exp: number }>();
  const backendKeys = new Map<string, { kid: string; publicKey: KeyObject; scopes: string[] }>();

  const issue = (given: Grant, withRefresh: boolean, grantType: string) => {
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
    recordEvent("authorization-server", { kind: "token.issued", grant: grantType, client: g.client_id, ...(g.sub ? { user: g.sub } : {}), ...(g.patient ? { patient: g.patient } : {}), scope: g.scope, tokenHash: ath(access_token).slice(0, 10), expiresIn: tokenLifetime, exp, refresh: withRefresh });
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

  const page = (title: string, body: string, status = 200) => new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>${PAGE_CSS}</style></head><body><p class="brand">Authorization Server</p><main>${body}</main></body></html>`, { status, headers: { "content-type": "text/html; charset=utf-8" } });
  const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

  const demoQuery = (url: URL) => { const q = new URLSearchParams(); for (const k of ["demo_traceparent", "demo_session", "return", "return_state", "preselect", "suggest_delegate"]) if (url.searchParams.get(k)) q.set(k, url.searchParams.get(k)!); const s = q.toString(); return s ? `&${s}` : ""; };
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
  /** `field` keeps one person's site choices apart from another's on a form offering several. */
  const siteBoxes = (sites: string[], checked: string[] = sites, field = "sites", below?: (site: string) => string) => `<input type="hidden" name="${esc(field === "sites" ? "sites_shown" : `sites_shown@${field.slice("sites@".length)}`)}" value="1">${sites.map(s => { const box = `<label><input type="checkbox" name="${esc(field)}" value="${esc(s)}" ${checked.includes(s) ? "checked" : ""}> ${esc(s)}</label>`; return below ? `<div class="site-row">${box}${below(s)}</div>` : box; }).join("")}`;
  const nameOf = (patient: string) => PATIENT_NAMES[patient] ?? patient;
  type Held = AccessSummary["records"][number];
  const whoseTag = (r: Held) => r.via === "self" ? `<span class="tag self">You</span>` : r.via === "guardian" ? `<span class="tag">${esc(((r.relationship ?? "guardian")[0] ?? "").toUpperCase() + (r.relationship ?? "guardian").slice(1))}</span>` : `<span class="tag">Shared with you</span>`;
  const whoseWords = (r: Held) => r.via === "self" ? "your own records" : r.via === "guardian" ? `you're their ${esc(r.relationship ?? "guardian")}, on file with the Imaging Server` : `shared with you as ${esc(r.relationship ?? "a related person")}`;
  /** One radio for each person, with the signed-in person apart from the others. */
  const whoseRadios = (records: Held[], selected: string) => {
    const card = (r: Held) => `<label class="account"><input type="radio" name="patient" value="${esc(r.patient)}" ${r.patient === selected ? "checked" : ""}><span class="avatar" aria-hidden="true">${esc(initials(nameOf(r.patient)))}</span><span class="account-text"><b>${esc(nameOf(r.patient))}</b><span class="role">${whoseWords(r)}</span></span></label>`;
    const own = records.filter(r => r.via === "self"), others = records.filter(r => r.via !== "self");
    if (!own.length || !others.length) return records.map(card).join("");
    return `<p class="people-group">You</p>${own.map(card).join("")}<p class="people-group">People you hold records for</p>${others.map(card).join("")}`;
  };
  /**
   * Each person's sites, with only the chosen person's on show. A browser without :has shows them all,
   * and each still says whose it is. Their fields are named for the person, so only the chosen person's count.
   */
  const whoseSites = (records: Held[], legend: (r: Held) => string, checked: (r: Held) => string[], note: (r: Held) => string, below?: (r: Held, field: string) => (site: string) => string) => records.map(r => {
    const several = records.length > 1, field = several ? `sites@${r.patient}` : "sites";
    const body = r.sites.length ? `<fieldset data-sites-for="${esc(r.patient)}"><legend>${legend(r)}</legend>${siteBoxes(r.sites, checked(r), field, below?.(r, several ? `study@${r.patient}` : "study"))}<p class="note">${note(r)}</p></fieldset>` : `<p class="note" data-sites-for="${esc(r.patient)}">No imaging studies are on file for ${esc(nameOf(r.patient))}, so there's nothing to choose.</p>`;
    return `${several ? `<style>form:has(input[name=patient][value="${esc(r.patient)}"]:not(:checked)) [data-sites-for="${esc(r.patient)}"]{display:none}</style>` : ""}${body}`;
  }).join("");
  const chosenSites = (f: URLSearchParams, patient: string) => ({ shown: !!(f.get("sites_shown") || f.get(`sites_shown@${patient}`)), sites: [...f.getAll("sites"), ...f.getAll(`sites@${patient}`)] });

  async function authorize(url: URL): Promise<Response> {
    const q = url.searchParams;
    const client = clientOf(q.get("client_id") ?? "");
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
    txns.set(id, { client_id: q.get("client_id")!, redirect_uri: q.get("redirect_uri")!, state: q.get("state")!, scope, code_challenge: q.get("code_challenge")!, exp: now() + 600, login_hint: q.get("login_hint") ?? undefined, patient_hint: q.get("demo_patient") ?? undefined });
    return page("Sign in", `<h1>Sign in to continue to ${esc(client!.name)}</h1><p class="who">This page belongs to the Authorization Server, not the app.</p>${await signInForm(`${P}/authorize/signin?txn=${id}${demoQuery(url)}`, q.get("login_hint") ?? "")}`);
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
    const client = clientOf(t.txn.client_id)!;
    if (!user) return page("Sign in", `<h1>Sign in to continue to ${esc(client.name)}</h1>${await signInForm(`${P}/authorize/signin?txn=${t.id}${demoQuery(url)}`, t.txn.login_hint ?? "", NOT_AN_ACCOUNT)}`, 401);
    t.txn.user = user;
    return redirectTo(`${P}/authorize/consent?txn=${t.id}${demoQuery(url)}`);
  }

  async function consentPage(url: URL): Promise<Response> {
    const t = txnOf(url);
    if (!t) return expired();
    if (!check("authorization-server", "user has signed in", !!t.txn.user)) return page("Authorization error", "<h1>Sign in first</h1>", 401);
    const user = USERS[t.txn.user!]!;
    const client = clientOf(t.txn.client_id)!;
    const access = await opts.directory.access(t.txn.user!, user.fhirUser);
    const action = `${P}/authorize/decision?txn=${t.id}${demoQuery(url)}`;
    if (!access.records.length) return page("No records", `<h1>No records are shared with you</h1><p>${esc(user.name)} is signed in, but no patient has delegated access to this account, so there's nothing to share with ${esc(client.name)}.</p><form method="post" action="${esc(action)}"><div class="buttons"><button name="decision" value="deny">Return to the app</button></div></form>`, 200);
    const selected = access.records.find(r => r.patient === t.txn.patient_hint)?.patient ?? access.records[0]!.patient;
    const grantFor = (r: Held) => access.apps.find(a => a.client === t.txn.client_id && a.patient === r.patient);
    const sites = whoseSites(access.records, r => `Sites this app can see in ${esc(nameOf(r.patient))}'s records`, r => { const g = grantFor(r); return g?.sites ? [...new Set([...g.sites, ...(r.studies ?? []).filter(st => g.studies?.includes(st.id)).map(st => st.site ?? "")])] : r.sites; }, r => `${r.via === "delegation" ? "You can share only what was shared with you. " : ""}SMART scopes can't express this choice. It's kept as Imaging Server policy, and the token's scope doesn't change.`, (r, field) => site => {
      const here = (r.studies ?? []).filter(st => st.site === site), g = grantFor(r);
      if (!here.length) return "";
      const when = (d?: string) => d && /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d;
      return `<input type="hidden" name="${esc(field)}_listed" value="${esc(site)}"><details><summary>${here.length === 1 ? "1 study" : `${here.length} studies`}</summary>${here.map(st => `<label><input type="checkbox" name="${esc(field)}" value="${esc(st.id)}" ${!g?.sites || g.sites.includes(site) || g.studies?.includes(st.id) ? "checked" : ""}> ${esc([when(st.date), st.description ?? st.id].filter(Boolean).join(" · "))}</label>`).join("")}</details>`;
    });
    return page("Authorize app", `<h1>Let ${esc(client.name)} access imaging records?</h1>
      <p class="who">Signed in as ${esc(user.name)} (<code>${esc(user.fhirUser)}</code>).</p>
      ${opts.registeredClient?.(t.txn.client_id) ? `<p class="who">Approving sends you to <strong>${esc(new URL(t.txn.redirect_uri).host)}</strong>. This app was registered by someone using this sandbox.</p>` : ""}
      <form method="post" action="${esc(action)}">
        <fieldset class="accounts"><legend>Whose records</legend>${whoseRadios(access.records, selected)}${access.records.length > 1 ? `<p class="note">This app gets one person's records. Choosing someone else later is a new authorization, with its own approval.</p>` : ""}</fieldset>
        <fieldset><legend>Requested permissions</legend><ul class="scopes">${t.txn.scope.split(" ").map(s => `<li><code>${esc(s)}</code></li>`).join("")}</ul></fieldset>
        ${sites}
        <div class="buttons"><button class="primary" name="decision" value="approve">Approve</button><button name="decision" value="deny">Deny</button></div>
      </form>`, 200);
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
    const chosen = chosenSites(f, record!.patient);
    // A site with every study ticked is approved as the site, so it covers later studies there. Otherwise only the ticked studies are.
    const ticked = new Set([...f.getAll("study"), ...f.getAll(`study@${record!.patient}`)]), listed = new Set([...f.getAll("study_listed"), ...f.getAll(`study@${record!.patient}_listed`)]), approvedSites: string[] = [], approvedStudies: string[] = [];
    for (const site of chosen.sites) {
      const here = (record!.studies ?? []).filter(st => st.site === site), kept = here.filter(st => ticked.has(st.id));
      // A client that never showed the studies chose the whole site.
      if (!listed.has(site) || kept.length === here.length) approvedSites.push(site); else approvedStudies.push(...kept.map(st => st.id));
    }
    const approved = await opts.directory.recordConsent({ client: txn.client_id, user: txn.user!, fhirUser: user.fhirUser, patient: record!.patient, ...(chosen.shown ? { sites: approvedSites, ...(approvedStudies.length ? { studies: approvedStudies } : {}) } : {}) });
    if (!check("authorization-server", "the Imaging Server recorded the approval", !approved.refused, { refused: approved.refused })) return deny();
    const grant: Grant = { client_id: txn.client_id, scope: txn.scope, sub: txn.user!, fhirUser: user.fhirUser };
    if (/(^| )launch\/patient( |$)/.test(txn.scope)) grant.patient = record!.patient;
    const code = randomBytes(24).toString("base64url");
    codes.set(code, { grant, client_id: txn.client_id, redirect_uri: txn.redirect_uri, code_challenge: txn.code_challenge, exp: now() + 60 });
    check("authorization-server", "issue single-use authorization code", true, { lifetime_seconds: 60, patient: grant.patient, user: grant.sub, sites: chosen.sites.join(", ") || undefined });
    back.searchParams.set("code", code);
    return new Response(null, { status: 302, headers: { Location: back.toString() } });
  }

  // Every account_session cookie the browser sends: a scope's and the root's can both reach a scope's
  // path, and a stale one from a dropped scope can come first. This world uses the one it knows.
  const sessionIds = (req: Request) => [...(req.headers.get("cookie") ?? "").matchAll(/(?:^|;\s*)account_session=([^;]*)/g)].map(m => m[1]!);
  const accountUser = (req: Request) => sessionIds(req).map(id => accountSessions.get(id)).find(Boolean);
  const appName = (id: string) => clientOf(id)?.name ?? id;

  async function account(url: URL, req: Request): Promise<Response> {
    const hint = url.searchParams.get("login_hint") ?? "";
    // A link meant for another account asks for that account, rather than showing the one signed in.
    const signedIn = accountUser(req);
    const name = hint && signedIn !== hint ? undefined : signedIn;
    const q = demoQuery(url).replace(/^&/, "?");
    const returnTo = url.searchParams.get("return") === opts.redirectUri ? opts.redirectUri : undefined;
    if (!name) return page("Sign in", `<h1>Sign in to your account</h1>${await signInForm(`${P}/account/signin${q}${hint ? `${q ? "&" : "?"}login_hint=${encodeURIComponent(hint)}` : ""}`, hint || (url.searchParams.get("preselect") ?? ""))}`);
    const user = USERS[name]!;
    const access = await opts.directory.access(name, user.fhirUser);
    const others = Object.entries(USERS).filter(([id]) => id !== name);
    const held = (r: Held) => r.sites.length ? r.sites.join(", ") : r.via === "delegation" ? "No sites" : "No imaging studies on file";
    const records = access.records.length ? `<ul class="rows">${access.records.map(r => `<li data-record="${esc(r.patient)}"><span>${whoseTag(r)} <b>${esc(nameOf(r.patient))}</b>: ${whoseWords(r)}. ${esc(held(r))}.</span></li>`).join("")}</ul>` : `<p class="note">Nothing yet. A patient has to delegate access to this account.</p>`;
    // A person can pass on their own record and one they're guardian for. What was shared with them stops at them.
    const shareable = access.records.filter(r => r.via !== "delegation");
    const canShare = shareable.filter(r => r.sites.length);
    const passedOn = access.records.filter(r => r.via === "delegation");
    const shareForm = canShare.length ? `<form method="post" action="${P}/account/delegations${q}">
        <fieldset><legend>Share with a related person</legend>
          ${canShare.length > 1 ? `<fieldset class="accounts"><legend>Whose records</legend>${whoseRadios(canShare, canShare[0]!.patient)}</fieldset>` : `<input type="hidden" name="patient" value="${esc(canShare[0]!.patient)}">`}
          <label class="field">Person <select name="delegate">${others.map(([id, u]) => `<option value="${esc(id)}" ${id === url.searchParams.get("suggest_delegate") ? "selected" : ""}>${esc(u.name)}</option>`).join("")}</select></label>
          <label class="field">Relationship <select name="relationship">${RELATIONSHIPS.map(r => `<option>${esc(r)}</option>`).join("")}</select></label>
          ${whoseSites(canShare, r => `Sites they can see in ${esc(nameOf(r.patient))}'s records`, r => r.sites, () => "They can see no more than this, and can give an app no more than they see.")}
          <div class="buttons"><button class="primary">Share</button></div>
        </fieldset>
      </form>` : `<p class="note">You have no imaging studies on file, so there's nothing to share yet.</p>`;
    const whoseShare = (patient: string) => access.records.length > 1 ? `, ${esc(nameOf(patient))}'s records` : "";
    const people = shareable.length ? `<section><h2>People who can sign in and see ${shareable.length > 1 ? "records you hold" : "your records"}</h2>
      ${access.delegations.length ? `<ul class="rows">${access.delegations.map(d => `<li><span><b>${esc(USERS[d.delegate]?.name ?? d.delegate)}</b> (${esc(d.relationship)})${whoseShare(d.patient)}: ${esc(d.sites.join(", ") || "no sites")}</span><form class="inline" method="post" action="${P}/account/delegations/revoke${q}"><input type="hidden" name="delegate" value="${esc(d.delegate)}"><input type="hidden" name="patient" value="${esc(d.patient)}"><button>Revoke</button></form></li>`).join("")}</ul>` : `<p class="note">No one yet.</p>`}
      ${shareForm}${passedOn.length ? `<p class="note">${esc(passedOn.map(r => nameOf(r.patient)).join(" and "))} shared with you, so you can give an app part of that, and can't pass it on to another person.</p>` : ""}</section>` : "";
    const apps = access.apps.length ? `<ul class="rows">${access.apps.map(a => `<li><span><b>${esc(appName(a.client))}</b>, ${esc(nameOf(a.patient))}'s records: ${esc((a.sites && (a.sites.join(", ") || "no sites")) ?? "everything you can see")}</span><form class="inline" method="post" action="${P}/account/apps/revoke${q}"><input type="hidden" name="client" value="${esc(a.client)}"><input type="hidden" name="patient" value="${esc(a.patient)}"><button>Revoke</button></form></li>`).join("")}</ul>` : `<p class="note">None yet. An app appears here after you approve it during its sign-in.</p>`;
    return page("Your account", `<div class="profile"><span class="avatar" aria-hidden="true">${esc(initials(user.name))}</span><div><h1>${esc(user.name)}</h1><p class="who">${esc(roleOf(user, access.records.filter(r => r.via !== "self")))}. Signed in as <code>${esc(name)}</code>, <code>${esc(user.fhirUser)}</code>.</p></div></div>
      <section><h2>Records you can access</h2>${records}</section>
      ${people}
      <section><h2>Apps you've authorized</h2>${apps}<p class="note">Anyone with access can authorize an app, for one person's records at a time, and can give it only part of what they hold.</p></section>
      <div class="buttons">${returnTo ? `<a class="button" href="${esc(returnTo)}?account=done&amp;state=${encodeURIComponent(url.searchParams.get("return_state") ?? "")}">Done, back to the demo</a>` : ""}<form class="inline" method="post" action="${P}/account/signout${q}"><button>Sign out</button></form></div>`, 200);
  }

  async function accountPost(url: URL, req: Request): Promise<Response> {
    const q = demoQuery(url).replace(/^&/, "?");
    const f = new URLSearchParams(await req.text());
    if (url.pathname === "/account/signin") {
      const name = signIn(f);
      if (!name) return page("Sign in", `<h1>Sign in to your account</h1>${await signInForm(`${P}/account/signin${q}`, url.searchParams.get("login_hint") ?? "", NOT_AN_ACCOUNT)}`, 401);
      const id = randomBytes(24).toString("base64url");
      accountSessions.set(id, name);
      lastAccountSignIn = name;
      return new Response(null, { status: 303, headers: { Location: `${P}/account${q}`, "Set-Cookie": `account_session=${id}; HttpOnly; SameSite=Lax; Path=${P || "/"}` } });
    }
    if (url.pathname === "/account/signout") {
      for (const id of sessionIds(req)) accountSessions.delete(id);
      return new Response(null, { status: 303, headers: { Location: `${P}/account${url.search}`, "Set-Cookie": `account_session=; Max-Age=0; Path=${P || "/"}` } });
    }
    const name = accountUser(req);
    if (!check("authorization-server", "account session is signed in", !!name)) return page("Sign in", "<h1>Sign in first</h1>", 401);
    const user = USERS[name!]!;
    if (url.pathname === "/account/delegations") {
      const delegate = f.get("delegate") ?? "";
      if (!check("authorization-server", "relationship is one of the offered choices", RELATIONSHIPS.includes(f.get("relationship") ?? ""), { relationship: f.get("relationship") })) return page("Not allowed", "<h1>Pick a relationship from the list</h1>", 400);
      const patient = f.get("patient") || user.patient || "";
      const record = (await opts.directory.access(name!, user.fhirUser)).records.find(r => r.patient === patient);
      if (!check("authorization-server", "user can delegate: they're the patient or the guardian, and the delegate has an account", !!record && record.via !== "delegation" && !!userOf(delegate) && delegate !== name, { user: name, delegate, patient, via: record?.via })) return page("Not allowed", "<h1>Only a patient or their guardian can delegate their records</h1>", 403);
      const shared = await opts.directory.delegate({ patient, grantedBy: name!, fhirUser: user.fhirUser, delegate, relationship: f.get("relationship") || "related person", sites: chosenSites(f, patient).sites });
      if (shared.refused) return page("Not allowed", `<h1>The organization's policy doesn't allow this share</h1><p>${esc(shared.refused)}</p>`, 403);
    } else if (url.pathname === "/account/delegations/revoke") await opts.directory.revokeDelegation(name!, f.get("delegate") ?? "", f.get("patient") ?? undefined);
    else if (url.pathname === "/account/apps/revoke") await opts.directory.revokeApp(f.get("client") ?? "", name!, f.get("patient") ?? undefined);
    else return new Response("not found", { status: 404 });
    return redirectTo(`${P}/account${q}`);
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
        scopes_supported: ["patient/ImagingStudy.rs", "patient/Patient.rs", "patient/AllergyIntolerance.rs", "patient/Condition.rs", "patient/MedicationRequest.rs", "patient/*.rs", "system/ImagingStudy.rs", "launch/patient", "online_access"],
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
        return tokenResponse(issue({ client_id: reg.client_id, scope: asked.join(" ") }, false, "client_credentials"));
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
        return tokenResponse(issue(c!.grant, /(^| )(online|offline)_access( |$)/.test(c!.grant.scope), "authorization_code"));
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
        return tokenResponse(issue(g, true, "refresh_token"));
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
      if (!sameSecret(req.headers.get("authorization")?.match(/^bearer +(.+)$/i)?.[1], opts.serviceSecret)) return new Response(null, { status: 401 });
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
      const bearer = req.headers.get("authorization")?.match(/^Bearer (.+)$/i)?.[1];
      const t = bearer ? opts.store().getToken(bearer, "access") : undefined;
      if (!check("authorization-server", "patient read has a live access token", !!t && !t.revoked && t.exp! > now(), { token_hash: bearer && ath(bearer).slice(0, 10) })) return new Response(null, { status: 401, headers: { "WWW-Authenticate": bearer ? 'Bearer error="invalid_token"' : "Bearer" } });
      if (!check("authorization-server", "the token's patient context is this patient", t!.patient === id, { patient: id, patient_context: t!.patient })) return new Response(null, { status: 403, headers: { "WWW-Authenticate": 'Bearer error="insufficient_scope"' } });
      if (!Object.hasOwn(PATIENT_NAMES, id)) return new Response(null, { status: 404 });
      return Response.json({ resourceType: "Patient", id, name: [{ family: "Example", given: [PATIENT_NAMES[id]!.split(" ")[0]] }], ...demographics(id) });
    }
    const clinicalType = url.pathname.match(/^\/fhir\/([A-Za-z]+)$/)?.[1];
    if (clinicalType && isClinicalType(clinicalType) && req.method === "GET") {
      const bearer = req.headers.get("authorization")?.match(/^Bearer (.+)$/i)?.[1];
      const t = bearer ? opts.store().getToken(bearer, "access") : undefined;
      if (!check("authorization-server", "clinical search has a live access token", !!t && !t.revoked && t.exp! > now(), { type: clinicalType })) return new Response(null, { status: 401, headers: { "WWW-Authenticate": bearer ? 'Bearer error="invalid_token"' : "Bearer" } });
      const found = clinicalSearch(clinicalType, url.searchParams, t!, `${opts.issuer}/fhir`);
      return Response.json(found.body, { status: found.status, headers: { "content-type": "application/fhir+json" } });
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

/** Signed by `clock`, which is the clock of the deployment it goes to. */
export function clientAssertion(c: BackendClient, aud: string, clock: Clock = demoClock): string {
  const head = b64url(JSON.stringify({ alg: "ES256", kid: c.kid, typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: c.client_id, sub: c.client_id, aud, jti: randomBytes(8).toString("hex"), exp: clock.now() + 300 }));
  const sig = sign("sha256", Buffer.from(`${head}.${claims}`), { key: c.privateKey, dsaEncoding: "ieee-p1363" });
  return `${head}.${claims}.${b64url(sig)}`;
}
