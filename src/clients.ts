// Apps a person registers in their own sandbox, so anyone can try the demo with their own app: public apps,
// confidential apps that sign a key-based assertion, and backend services. Kept with the sandbox, so they last until its
// owner starts over, and starting over leaves them alone. A service has no one to approve it, so registering one grants its access.
import { randomBytes } from "node:crypto";
import type { PolicyStore, ServiceAccessPolicy } from "@smart-imaging-proxy/core";
import { JWKS_REFUSED } from "./jwks";

export type ClientType = "public" | "confidential" | "backend";
export interface RegisteredClient {
  id: string; name: string; type: ClientType; redirectUris: string[];
  /** The public key a confidential app or a service signs with. */
  /** The first registered key. Kept for clients saved before `jwks`; read keys with `keysOf`. */
  jwk?: JsonWebKey & { kid: string };
  /** Every public key registered, each with its own kid: an assertion is checked with the one its header names. */
  jwks?: (JsonWebKey & { kid: string })[];
  /** Or where it publishes its keys, so it can rotate them. */
  jwksUrl?: string;
  /** Which patients a service may reach: any, or one. */
  patients?: string;
}
const KEY = "clients", TYPES: ClientType[] = ["public", "confidential", "backend"];
/** What a service is granted. Only what its policy then releases is reachable. */
export const BACKEND_SCOPES = ["system/ImagingStudy.rs"];
const KNOWN_PATIENTS = ["josh-example", "sam-example", "riley-example", "robin-example"];

export const listClients = (store: PolicyStore): RegisteredClient[] => (JSON.parse(store.note(KEY) ?? "[]") as RegisteredClient[]).map(c => ({ ...c, type: c.type ?? "public" }));
const save = (store: PolicyStore, clients: RegisteredClient[]) => store.setNote(KEY, JSON.stringify(clients));

/** Why a redirect URI can't be registered, if it can't: https, or http only on this machine, and no fragment. */
function redirectProblem(uri: unknown): string | undefined {
  let u: URL;
  try { u = new URL(String(uri)); } catch { return "a redirect URI must be an absolute URL"; }
  if (u.hash) return "a redirect URI can't have a fragment";
  if (u.protocol === "https:") return undefined;
  if (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) return undefined;
  return "a redirect URI must use https, or http on loopback: localhost, 127.0.0.1 or [::1]";
}
/** A client's registered public keys: all of them, or the one a client saved before there could be several had. */
export const keysOf = (c: { jwk?: JsonWebKey & { kid: string }; jwks?: (JsonWebKey & { kid: string })[] }) => c.jwks ?? (c.jwk ? [c.jwk] : []);
/** Every public key in a JWK or a JWKS, each for ES256, ES384 or RS384 with a kid of its own, or why not. */
export function publicKeysOf(input: any): (JsonWebKey & { kid: string })[] | { error: string } {
  const list: unknown[] = Array.isArray(input?.keys) ? input.keys : [input];
  if (!list.length || list.length > 10) return { error: "give between 1 and 10 public keys" };
  const out: (JsonWebKey & { kid: string })[] = [];
  for (const [i, k] of list.entries()) {
    const key = publicKeyOf(k);
    if ("error" in key) return { error: list.length > 1 ? `key ${i + 1} (${(k as any)?.kid ?? "no kid"}): ${key.error}` : key.error };
    if (out.some(o => o.kid === key.kid)) return { error: `two keys have the kid ${key.kid}: each needs its own, so an assertion's kid names one` };
    out.push(key);
  }
  return out;
}
/** One public key for ES256, ES384 or RS384, or why not. A private key is refused rather than stored. */
export function publicKeyOf(k: any): (JsonWebKey & { kid: string }) | { error: string } {
  if (typeof k !== "object" || k === null) return { error: "give a public key as a JWK" };
  if ("d" in k) return { error: "that's a private key: give only the public part" };
  if (typeof k.kid !== "string" || !k.kid) return { error: "the key needs a kid" };
  if (k.kty === "EC" && (k.crv === "P-256" || k.crv === "P-384") && typeof k.x === "string" && typeof k.y === "string") return { kty: k.kty, crv: k.crv, x: k.x, y: k.y, kid: k.kid };
  if (k.kty === "RSA" && typeof k.n === "string" && typeof k.e === "string" && Buffer.from(k.n, "base64url").length >= 256) return { kty: k.kty, n: k.n, e: k.e, kid: k.kid };
  return { error: "the key must be EC P-256, EC P-384, or RSA of at least 2048 bits" };
}

const grantId = (id: string) => `service-grant-${id}`;
function grant(store: PolicyStore, c: RegisteredClient) {
  const policy: ServiceAccessPolicy = { id: grantId(c.id), type: "service-access", description: `What ${c.name} was registered to reach`, service: `service:${c.id}`, patients: c.patients === "any" || !c.patients ? "any" : `patient:${c.patients}`, allow: { all: true } };
  store.putPolicy(policy);
}
/** Puts back what registered services were granted, after something resets policy. */
export function restoreGrants(store: PolicyStore) { for (const c of listClients(store)) if (c.type === "backend") grant(store, c); }

export function addClient(store: PolicyStore, input: { name?: unknown; type?: unknown; redirectUris?: unknown; jwk?: unknown; jwksUrl?: unknown; patients?: unknown }, check: { jwksReachable?: (url: string) => boolean } = {}): RegisteredClient | { error: string } {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 80) return { error: "give the app a name of at most 80 characters" };
  const type = (input.type ?? "public") as ClientType;
  if (!TYPES.includes(type)) return { error: "type must be public, confidential or backend" };
  const client: RegisteredClient = { id: `app-${randomBytes(6).toString("hex")}`, name, type, redirectUris: [] };
  if (type !== "backend") {
    const uris = input.redirectUris;
    if (!Array.isArray(uris) || !uris.length || uris.length > 10) return { error: 'give between 1 and 10 redirect URIs, or ["*"] to allow any redirect URI' };
    if (uris.includes("*")) {
      if (uris.length > 1) return { error: 'a redirect URI of "*" allows any redirect URI, so give ["*"] on its own, or list specific redirect URIs' };
      client.redirectUris = ["*"];
    } else {
      for (const uri of uris) { const problem = redirectProblem(uri); if (problem) return { error: problem }; }
      client.redirectUris = [...new Set(uris.map(String))];
    }
  }
  if (type !== "public") {
    if (typeof input.jwksUrl === "string" && input.jwksUrl) {
      if (input.jwk) return { error: "give a public key or a JWKS URL, not both" };
      if (check.jwksReachable && !check.jwksReachable(input.jwksUrl)) return { error: JWKS_REFUSED };
      client.jwksUrl = input.jwksUrl;
    } else {
      const keys = publicKeysOf(input.jwk);
      if ("error" in keys) return keys;
      client.jwk = keys[0];
      client.jwks = keys;
    }
  }
  if (type === "backend") {
    const patients = input.patients ?? "any";
    if (patients !== "any" && !KNOWN_PATIENTS.includes(String(patients))) return { error: `patients must be any, or one of ${KNOWN_PATIENTS.join(", ")}` };
    client.patients = String(patients);
    grant(store, client);
  }
  save(store, [...listClients(store), client]);
  return client;
}

export function removeClient(store: PolicyStore, id: string): boolean {
  const clients = listClients(store), target = clients.find(c => c.id === id);
  if (!target) return false;
  if (target.type === "backend") store.removePolicy(grantId(id));
  // An approval or a token for an app that's gone means nothing, and would linger in the policy and the log.
  for (const by of new Set(store.approvals().filter(x => x.app === `app:${id}`).map(x => x.by))) store.removeApprovals({ by, app: `app:${id}` });
  store.deleteTokensOf([id]);
  save(store, clients.filter(c => c.id !== id));
  return true;
}

/** Client metadata, as RFC 7591 names it, with one extension: `patients`, which patients a backend service may
 *  reach (`any`, or one patient's id), since a service has no one to approve it. */
export interface ClientMetadata {
  client_name?: string; redirect_uris?: string[]; grant_types?: string[]; response_types?: string[];
  token_endpoint_auth_method?: "none" | "private_key_jwt"; token_endpoint_auth_signing_alg?: string;
  jwks?: { keys: JsonWebKey[] }; jwks_uri?: string; scope?: string; patients?: string;
}
/** An RFC 7591 error: `invalid_redirect_uri` or `invalid_client_metadata`, with what's wrong. */
export interface RegistrationError { error: "invalid_redirect_uri" | "invalid_client_metadata"; error_description: string }

/** What a registered app is, as RFC 7591 client metadata, with its id: the answer to registering it. */
export function metadataOf(c: RegisteredClient): ClientMetadata & { client_id: string } {
  const signs = c.type !== "public";
  return {
    client_id: c.id, client_name: c.name,
    ...(c.type === "backend" ? {} : { redirect_uris: c.redirectUris, response_types: ["code"] }),
    // A refresh token comes with online_access or offline_access, for any app that signs in.
    grant_types: c.type === "backend" ? ["client_credentials"] : ["authorization_code", "refresh_token"],
    token_endpoint_auth_method: signs ? "private_key_jwt" : "none",
    ...(keysOf(c).length ? { jwks: { keys: keysOf(c) } } : {}), ...(c.jwksUrl ? { jwks_uri: c.jwksUrl } : {}),
    scope: c.type === "backend" ? BACKEND_SCOPES.join(" ") : "launch/patient patient/*.rs",
    ...(c.type === "backend" ? { patients: c.patients } : {}),
  };
}

/** Registers an app from RFC 7591 client metadata: its kind follows from how it authenticates and its grant. */
export function register(store: PolicyStore, m: ClientMetadata, check: { jwksReachable?: (url: string) => boolean } = {}): RegisteredClient | RegistrationError {
  const bad = (d: string): RegistrationError => ({ error: "invalid_client_metadata", error_description: d });
  if (typeof m !== "object" || m === null || Array.isArray(m)) return bad("the body must be a JSON object of client metadata");
  const method = m.token_endpoint_auth_method ?? "none", grants = m.grant_types ?? ["authorization_code"];
  if (method !== "none" && method !== "private_key_jwt") return bad("token_endpoint_auth_method must be none or private_key_jwt");
  const backend = grants.length === 1 && grants[0] === "client_credentials";
  if (!backend && !(grants.includes("authorization_code") && grants.every(g => g === "authorization_code" || g === "refresh_token"))) return bad("grant_types must be [\"authorization_code\"] (optionally with refresh_token), or [\"client_credentials\"]");
  if (backend && method !== "private_key_jwt") return bad("a client_credentials client authenticates with private_key_jwt");
  if (m.response_types && (backend || m.response_types.join() !== "code")) return bad("response_types must be [\"code\"], and only for authorization_code");
  if (m.jwks && m.jwks_uri) return bad("give jwks or jwks_uri, not both");
  if (method === "none" && (m.jwks || m.jwks_uri)) return bad("a client with token_endpoint_auth_method none has no keys");
  // A service has no one to approve it, so what it may reach is said when it's registered, never assumed.
  if (backend && m.patients === undefined) return bad(`a client_credentials client names "patients": "any", or one patient's id (one of ${KNOWN_PATIENTS.join(", ")}), since no one signs in to approve it`);
  const type: ClientType = backend ? "backend" : method === "private_key_jwt" ? "confidential" : "public";
  const made = addClient(store, { name: m.client_name ?? "Unnamed app", type, redirectUris: m.redirect_uris, jwk: m.jwks, jwksUrl: m.jwks_uri, patients: m.patients }, check);
  if (!("error" in made)) return made;
  return { error: /redirect URI/.test(made.error) ? "invalid_redirect_uri" : "invalid_client_metadata", error_description: made.error };
}
