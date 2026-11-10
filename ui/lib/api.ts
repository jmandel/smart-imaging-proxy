// The sandbox a page is in, and calls to it. The management API, under /api/sandbox, takes the sandbox's admin
// token, which the page gets itself, with the sandbox's own admin key, as SMART Backend Services.

/**
 * The sandbox the page shown is in, if any: every request it makes stays there. "" is the site's root. It follows
 * the address as the app moves between pages, so read it when it's used, never into a constant at load.
 */
export let BASE = location.pathname.match(/^\/s\/[^/]+/)?.[0] ?? "";
/** Set by the app as each page's route is drawn. */
export const setBase = (base: string) => { BASE = base; };

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/** A call to a sandbox, with any headers of the page's own. Gives the JSON answer, or throws what went wrong. */
export async function api<T = any>(method: string, path: string, body?: unknown, base = BASE, headers: Record<string, string> = {}): Promise<T> {
  const managed = path.startsWith("/api/sandbox");
  const send = async () => fetch(`${base}${path}`, {
    method,
    headers: { ...headers, ...(managed ? { authorization: `Bearer ${await adminToken(base)}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let r = await send();
  // A token revoked, or expired by the demo clock: get a fresh one, once.
  if (r.status === 401 && managed) { adminTokens.delete(base); r = await send(); }
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(b.error ?? `HTTP ${r.status}`, r.status);
  return b;
}

// Signing, for SMART's asymmetric client authentication: the sandbox's admin key here, and apps' keys elsewhere.
export const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const jsonPart = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
export const ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
export type PrivateJwk = JsonWebKey & { kid: string };

/** A client assertion for `tokenEndpoint`, signed here with the client's private ES256 key, expiring by the sandbox's clock when given. */
export async function signAssertion(jwk: PrivateJwk, clientId: string, tokenEndpoint: string, now = Math.floor(Date.now() / 1000)) {
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const jti = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const head = `${jsonPart({ alg: "ES256", kid: jwk.kid, typ: "JWT" })}.${jsonPart({ iss: clientId, sub: clientId, aud: tokenEndpoint, exp: now + 240, jti })}`;
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(head)));
  return `${head}.${b64url(signature)}`;
}

export interface ServiceKey { client_id: string; jwk: PrivateJwk; scope: string; name?: string }
export interface SandboxKeys { why: string; tokenEndpoint: string; now: number; admin: ServiceKey; services: ServiceKey[] }

/** A sandbox's sample keys, its admin client's and its services', and its time now. Anyone with the sandbox's URL may have them. */
export async function keysOf(base = BASE): Promise<SandboxKeys> {
  const r = await fetch(`${base}/api/sandbox/keys-shared-on-purpose`);
  if (!r.ok) throw new ApiError((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`, r.status);
  return r.json();
}

export interface TokenResponse { access_token: string; expires_in: number; scope?: string; patient?: string; refresh_token?: string; [k: string]: unknown }

/** A token from a Backend Services client's key: client_credentials with a signed assertion, plus any extra fields and headers. */
export async function backendToken(client: ServiceKey | { client_id: string; jwk: PrivateJwk }, tokenEndpoint: string, fields: Record<string, string>, now?: number, headers: Record<string, string> = {}): Promise<TokenResponse> {
  const r = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_assertion_type: ASSERTION_TYPE, client_assertion: await signAssertion(client.jwk, client.client_id, tokenEndpoint, now), ...fields }),
  });
  const t = await r.json().catch(() => ({}));
  if (!t.access_token) throw new Error(`The token endpoint refused ${client.client_id}: ${t.error ?? `HTTP ${r.status}`}`);
  return t;
}

/** The sandbox's admin token, for its management API, held until shortly before it expires. */
const adminTokens = new Map<string, { token: string; until: number }>();
export async function adminToken(base = BASE) {
  const held = adminTokens.get(base);
  if (held && held.until > Date.now()) return held.token;
  const keys = await keysOf(base);
  const t = await backendToken(keys.admin, keys.tokenEndpoint, { scope: keys.admin.scope }, keys.now);
  adminTokens.set(base, { token: t.access_token, until: Date.now() + (t.expires_in - 30) * 1000 });
  return t.access_token;
}

/** A sandbox's name: `null` when the server says it's gone, and `undefined` when it couldn't be asked. */
export async function sandboxName(base: string): Promise<string | null | undefined> {
  try { return (await api<{ name: string }>("GET", "/api/sandbox", undefined, base)).name; } catch (e) { return e instanceof ApiError && e.status === 404 ? null : undefined; }
}
