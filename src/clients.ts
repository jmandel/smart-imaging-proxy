// Apps a person registers in their own sandbox, so anyone can try the demo with their own app: public apps,
// confidential apps that sign a key-based assertion, and backend services. Kept with the sandbox, so they last until its
// owner starts over and a tour leaves them alone. A service has no one to approve it, so registering one grants its access.
import { randomBytes } from "node:crypto";
import type { PolicyStore, ServiceAccessPolicy } from "@smart-imaging-proxy/core";
import { JWKS_REFUSED } from "./jwks";

export type ClientType = "public" | "confidential" | "backend";
export interface RegisteredClient {
  id: string; name: string; type: ClientType; redirectUris: string[];
  /** The public key a confidential app or a service signs with. */
  jwk?: JsonWebKey & { kid: string };
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
/** A public key for ES256, ES384 or RS384, as one JWK or a JWKS of one, or why not. A private key is refused rather than stored. */
export function publicKeyOf(input: any): (JsonWebKey & { kid: string }) | { error: string } {
  const k = Array.isArray(input?.keys) ? input.keys[0] : input;
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
    if (!Array.isArray(uris) || !uris.length || uris.length > 10) return { error: "give between 1 and 10 redirect URIs" };
    for (const uri of uris) { const problem = redirectProblem(uri); if (problem) return { error: problem }; }
    client.redirectUris = uris.map(String);
  }
  if (type !== "public") {
    if (typeof input.jwksUrl === "string" && input.jwksUrl) {
      if (input.jwk) return { error: "give a public key or a JWKS URL, not both" };
      if (check.jwksReachable && !check.jwksReachable(input.jwksUrl)) return { error: JWKS_REFUSED };
      client.jwksUrl = input.jwksUrl;
    } else {
      const key = publicKeyOf(input.jwk);
      if ("error" in key) return key;
      client.jwk = key;
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
  save(store, clients.filter(c => c.id !== id));
  return true;
}
