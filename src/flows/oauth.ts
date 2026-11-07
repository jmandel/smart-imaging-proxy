// A SMART App Launch client: standalone launch, authorization code, PKCE S256, public client.
// The submit functions do what a browser does on the Authorization Server's pages.
import { createHash, randomBytes } from "node:crypto";
import { CONFIG } from "../config";

export const CALLBACK = `${CONFIG.demoUrl}/oauth/callback`;
export const CLINICAL_FHIR = `${CONFIG.authUrl}/fhir`;
export const DEFAULT_SCOPE = "launch/patient patient/ImagingStudy.rs online_access";
const FORM = { "content-type": "application/x-www-form-urlencoded" };

export interface AuthorizationRequest { url: string; state: string; verifier: string; client: string; redirectUri: string; }
type Trace = { traceparent: string; session: string };
const addTrace = (q: URLSearchParams, trace?: Trace) => { if (trace) { q.set("demo_traceparent", trace.traceparent); q.set("demo_session", trace.session); } };

/** Builds the authorization request. The trace fields are demo-only, so the live trace can follow a browser. */
export function buildAuthorization(authorizationEndpoint: string, client: string, scope = DEFAULT_SCOPE, trace?: Trace, loginHint?: string): AuthorizationRequest {
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(16).toString("base64url");
  const q = new URLSearchParams({
    response_type: "code", client_id: client, redirect_uri: CALLBACK, scope, state, aud: CLINICAL_FHIR,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
  });
  if (loginHint) q.set("login_hint", loginHint);
  addTrace(q, trace);
  return { url: `${authorizationEndpoint}?${q}`, state, verifier, client, redirectUri: CALLBACK };
}
export const tokenRequestBody = (a: AuthorizationRequest, code: string) => new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: a.redirectUri, client_id: a.client, code_verifier: a.verifier }).toString();

export function accountUrl(user: string, trace?: Trace) {
  const q = new URLSearchParams({ login_hint: user, return: CALLBACK, return_state: randomBytes(16).toString("base64url") });
  addTrace(q, trace);
  return `${CONFIG.authUrl}/account?${q}`;
}

const formAction = (html: string, base: string) => {
  const action = html.match(/<form[^>]*action="([^"]+)"/)?.[1]?.replaceAll("&amp;", "&");
  if (!action) throw new Error("no form on the page");
  return new URL(action, base).toString();
};
const post = (doFetch: typeof fetch, url: string, form: URLSearchParams, headers: Record<string, string> = {}) =>
  doFetch(url, { method: "POST", headers: { ...FORM, ...headers }, body: form.toString(), redirect: "manual" });

/** Sign in, then approve or deny. Returns where the Authorization Server redirected the browser. */
export async function submitConsent(authorizeUrl: string, d: { user: string; approve?: boolean; sites?: string[]; patient?: string }, doFetch: typeof fetch = fetch) {
  const signInPage = await doFetch(authorizeUrl, { redirect: "manual" });
  if (signInPage.status === 302) return new URL(signInPage.headers.get("location")!);
  const signedIn = await post(doFetch, formAction(await signInPage.text(), authorizeUrl), new URLSearchParams({ username: d.user }));
  if (signedIn.status !== 303) throw new Error(`sign-in failed (HTTP ${signedIn.status})`);
  const consentUrl = new URL(signedIn.headers.get("location")!, authorizeUrl).toString();
  const consent = await doFetch(consentUrl, { redirect: "manual" });
  const form = new URLSearchParams({ decision: d.approve === false ? "deny" : "approve" });
  if (d.patient) form.set("patient", d.patient);
  if (d.sites) { form.set("sites_shown", "1"); for (const s of d.sites) form.append("sites", s); }
  const res = await post(doFetch, formAction(await consent.text(), consentUrl), form);
  const location = res.headers.get("location");
  if (!location) throw new Error(`no redirect (HTTP ${res.status})`);
  return new URL(location);
}

/** Signs in to the account page. Returns the session cookie, which goes on the account forms. */
async function accountSignIn(url: string, user: string, doFetch: typeof fetch) {
  const page = await doFetch(url, { redirect: "manual" });
  const res = await post(doFetch, formAction(await page.text(), url), new URLSearchParams({ username: user }));
  if (res.status !== 303) throw new Error(`sign-in failed (HTTP ${res.status})`);
  return { cookie: res.headers.get("set-cookie")!.split(";")[0]!, query: new URL(url).search };
}
export async function submitDelegation(url: string, d: { user: string; delegate: string; relationship: string; sites: string[] }, doFetch: typeof fetch = fetch) {
  const { cookie, query } = await accountSignIn(url, d.user, doFetch);
  const form = new URLSearchParams({ delegate: d.delegate, relationship: d.relationship, sites_shown: "1" });
  for (const s of d.sites) form.append("sites", s);
  return post(doFetch, `${CONFIG.authUrl}/account/delegations${query}`, form, { cookie });
}
export async function submitRevocation(url: string, d: { user: string; delegate: string }, doFetch: typeof fetch = fetch) {
  const { cookie, query } = await accountSignIn(url, d.user, doFetch);
  return post(doFetch, `${CONFIG.authUrl}/account/delegations/revoke${query}`, new URLSearchParams({ delegate: d.delegate }), { cookie });
}

/** A complete scripted launch. */
export async function scriptedLaunch(user: string, client = "portal-app", opts: { scope?: string; sites?: string[] } = {}) {
  const config: any = await (await fetch(`${CLINICAL_FHIR}/.well-known/smart-configuration`)).json();
  const a = buildAuthorization(config.authorization_endpoint, client, opts.scope, undefined, user);
  const back = await submitConsent(a.url, { user, sites: opts.sites });
  if (back.searchParams.get("state") !== a.state) throw new Error("state mismatch");
  if (!back.searchParams.get("code")) return { error: back.searchParams.get("error") } as any;
  const res = await fetch(config.token_endpoint, { method: "POST", headers: FORM, body: tokenRequestBody(a, back.searchParams.get("code")!) });
  return res.json() as Promise<any>;
}
