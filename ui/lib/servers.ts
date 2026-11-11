// The servers the viewer can connect to: your sandboxes, and servers of your own kept in this browser. Your
// servers writes them and the viewer reads them, so both agree on what an entry must hold.
import { subtle } from "./api";
import type { PrivateJwk } from "./api";
import { checkServer, type ServerEntry } from "./server-entry";
import { store, stored, useSandboxes } from "./store";

export { checkServer, signsIn, type ServerEntry } from "./server-entry";

const SERVERS_KEY = "smart-imaging-client:servers";
export const CHOICE_KEY = "smart-imaging-client:choice";
/** The viewer's session in this tab: its token, and the steps it took. */
export const VIEWER_SESSION = "smart-imaging-viewer";
/** The viewer's address, and so the redirect URI it signs in with, the same for every server. */
export const VIEWER_URL = `${location.origin}/viewer`;
/** Every sandbox's built-in public client, whose one redirect URI is the viewer. */
export const SANDBOX_CLIENT = "demo-client";

/** A pasted list. Gives the servers, or throws saying what's wrong. */
export function parseServers(text: string): ServerEntry[] {
  const list = JSON.parse(text);
  if (!Array.isArray(list)) throw new Error("Expected a JSON array of servers.");
  return list.map((s, i) => checkServer(s, `Server ${i + 1}`));
}
/** The servers this browser has added. */
export function savedServers(): ServerEntry[] {
  try { const text = stored(SERVERS_KEY); if (text) return parseServers(text); } catch {}
  return [];
}
export const saveServers = (list: ServerEntry[]) => store(SERVERS_KEY, list.length ? JSON.stringify(list) : null);
export const serverKey = (s: Pick<ServerEntry, "iss" | "clientId">) => `${s.iss}|${s.clientId}`;
/** Adds a server, or replaces the one with the same address and client. */
export function putServer(entry: ServerEntry, replacing = serverKey(entry)) {
  const list = savedServers(), at = list.findIndex(s => serverKey(s) === replacing);
  if (at >= 0) list[at] = entry; else list.push(entry);
  saveServers(list);
}

/** A sandbox as a server in the viewer's list. */
export const sandboxServer = (base: string, name?: string): ServerEntry => ({ label: name ?? "Sandbox", iss: `${location.origin}${base}/fhir`, clientId: SANDBOX_CLIENT, sandbox: base });
/** The sandbox a server is, when it's a sandbox's own FHIR base with its built-in client. */
export function sandboxOfServer(s: Pick<ServerEntry, "iss" | "clientId">): string | undefined {
  const m = s.clientId === SANDBOX_CLIENT && s.iss.startsWith(location.origin) ? s.iss.slice(location.origin.length).match(/^(\/s\/[A-Za-z0-9_-]+)?\/fhir$/) : null;
  return m ? m[1] ?? "" : undefined;
}
/** The query that names a server to the viewer or the server check: a sandbox by its base, which anyone with the
 *  link can open, and a server of your own by its key in this browser's list. */
export const serverQuery = (s: Pick<ServerEntry, "iss" | "clientId">) => { const base = sandboxOfServer(s); return base !== undefined ? new URLSearchParams({ sandbox: base }) : new URLSearchParams({ server: serverKey(s) }); };

/** A server as a list offers it: its key, and a line saying what it is. */
export interface ServerChoice extends ServerEntry { id: string; detail: string }
/** The servers the viewer and the server check offer: your sandboxes, then the servers you added. One you added by hand stands in for the sandbox it names. */
export function useServers(): ServerChoice[] {
  const sandboxes = useSandboxes();
  const added = savedServers().map(s => ({ ...s, id: serverKey(s), detail: new URL(s.iss).host })), ids = new Set(added.map(s => s.id));
  const yours = sandboxes.map(w => sandboxServer(w.base, w.name)).map(s => ({ ...s, id: serverKey(s), detail: "Your sandbox of sample patients" }));
  return [...yours.filter(s => !ids.has(s.id)), ...added];
}

export const IMAGING = "smart-imaging-access";
/** The two ways of connecting. Discovery says which work by SMART's own metadata: the grant each needs. */
export const APP_LAUNCH = "app-launch", BACKEND_CAPABILITY = "backend-services";
export type Mode = typeof APP_LAUNCH | typeof BACKEND_CAPABILITY;
export const GRANT_FOR: Record<Mode, string> = { "app-launch": "authorization_code", "backend-services": "client_credentials" };
/** Where discovery says imaging is, for a way of connecting: on this FHIR server, or an associated one, when the
 *  server's grant_types_supported has that way's grant. */
export function imagingOf(config: any, iss: string, mode: Mode = APP_LAUNCH): { url: string; unified: boolean } | undefined {
  if (!(config.grant_types_supported ?? []).includes(GRANT_FOR[mode])) return undefined;
  const offers = (caps?: string[]) => !!caps?.includes(IMAGING);
  if (offers(config.capabilities)) return { url: iss, unified: true };
  const associated = (config.associated_endpoints ?? []).find((e: any) => offers(e.capabilities));
  return associated && { url: associated.url.replace(/\/$/, ""), unified: false };
}
/** A fresh ES256 pair, made here, so the server only ever sees the public half. */
export async function generateKey(): Promise<{ priv: PrivateJwk; pub: JsonWebKey & { kid: string } }> {
  const pair = await subtle().generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const kid = crypto.randomUUID(), [priv, pub] = await Promise.all([subtle().exportKey("jwk", pair.privateKey), subtle().exportKey("jwk", pair.publicKey)]);
  return { priv: { ...priv, kid }, pub: { kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y, kid } };
}
