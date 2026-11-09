// Apps a person registers in their own world, so anyone can try the demo with their own app. Public
// clients only, kept with the world, so they last until its owner starts over and a tour leaves them alone.
import { randomBytes } from "node:crypto";
import type { PolicyStore } from "@smart-imaging-proxy/core";

export interface RegisteredClient { id: string; name: string; redirectUris: string[]; }
const KEY = "clients";

export const listClients = (store: PolicyStore): RegisteredClient[] => JSON.parse(store.note(KEY) ?? "[]");
const save = (store: PolicyStore, clients: RegisteredClient[]) => store.setNote(KEY, JSON.stringify(clients));

/** Why a redirect URI can't be registered, if it can't: https, or http only on this machine, and no fragment. */
function redirectProblem(uri: unknown): string | undefined {
  let u: URL;
  try { u = new URL(String(uri)); } catch { return "a redirect URI must be an absolute URL"; }
  if (u.hash) return "a redirect URI can't have a fragment";
  if (u.protocol === "https:") return undefined;
  if (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) return undefined;
  return "a redirect URI must use https, or http on localhost";
}

export function addClient(store: PolicyStore, input: { name?: unknown; redirectUris?: unknown }): RegisteredClient | { error: string } {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 80) return { error: "give the app a name of at most 80 characters" };
  const uris = input.redirectUris;
  if (!Array.isArray(uris) || !uris.length || uris.length > 10) return { error: "give between 1 and 10 redirect URIs" };
  for (const uri of uris) { const problem = redirectProblem(uri); if (problem) return { error: problem }; }
  const client = { id: `app-${randomBytes(6).toString("hex")}`, name, redirectUris: uris.map(String) };
  save(store, [...listClients(store), client]);
  return client;
}

export function removeClient(store: PolicyStore, id: string): boolean {
  const clients = listClients(store), rest = clients.filter(c => c.id !== id);
  if (rest.length === clients.length) return false;
  save(store, rest);
  return true;
}
