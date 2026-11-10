// What this browser remembers: the sandboxes it has made or joined, the one it was last in, and the viewer's
// choice of server. Every read and write survives storage being unavailable, as in a private window.
import { useSyncExternalStore } from "react";
import { api, BASE, sandboxName } from "./api";

export const stored = (key: string): string | null => { try { return localStorage.getItem(key); } catch { return null; } };
export const store = (key: string, value: string | null) => { try { value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch {} };
export const session = {
  get: (key: string): string | null => { try { return sessionStorage.getItem(key); } catch { return null; } },
  set: (key: string, value: string | null) => { try { value === null ? sessionStorage.removeItem(key) : sessionStorage.setItem(key, value); } catch {} },
};

export interface KnownSandbox { base: string; name?: string; joined: boolean }

const SANDBOXES_KEY = "smart-imaging-client:sandboxes", CURRENT_KEY = "smart-imaging-client:current";
const listeners = new Set<() => void>();
let snapshot: { raw: string | null; list: KnownSandbox[] } = { raw: null, list: [] };

/** The sandboxes this browser knows, as one list that every part of every open tab sees change. */
export function knownSandboxes(): KnownSandbox[] {
  const raw = stored(SANDBOXES_KEY);
  if (raw !== snapshot.raw) { let list: KnownSandbox[] = []; try { list = JSON.parse(raw ?? "[]"); } catch {} snapshot = { raw, list }; }
  return snapshot.list;
}
export function saveSandboxes(list: KnownSandbox[]) {
  store(SANDBOXES_KEY, JSON.stringify(list));
  for (const f of listeners) f();
}
const subscribe = (f: () => void) => {
  listeners.add(f);
  const other = (e: StorageEvent) => { if (e.key === SANDBOXES_KEY || e.key === CURRENT_KEY) f(); };
  addEventListener("storage", other);
  return () => { listeners.delete(f); removeEventListener("storage", other); };
};
/** The known sandboxes, kept current: a rename, here or in another tab, shows everywhere at once. */
export const useSandboxes = () => useSyncExternalStore(subscribe, knownSandboxes);

/** A sandbox's name as the server gave it, remembered, if this browser knows the sandbox. */
export function rememberName(base: string, name: string | null | undefined) {
  const list = knownSandboxes();
  if (name && list.some(w => w.base === base && w.name !== name)) saveSandboxes(list.map(w => w.base === base ? { ...w, name } : w));
}

/** Makes `base` the sandbox you're working in: the one links outside a sandbox go to, here and in every tab. */
export function chooseSandbox(base: string) {
  if (stored(CURRENT_KEY) === base) return;
  store(CURRENT_KEY, base);
  for (const f of listeners) f();
}
/** Marks the page's sandbox as the one you're working in. */
export function enterSandbox() { if (BASE) chooseSandbox(BASE); }
/** The sandbox that links outside one go to: the one you were last in, or the newest you know. */
export function linkedSandbox(list = knownSandboxes()): KnownSandbox | undefined {
  const current = stored(CURRENT_KEY);
  return list.find(w => w.base === current) ?? list.at(-1);
}
/** The sandbox you're working in, kept current as it's chosen, here or in another tab. */
export const useLinkedSandbox = () => useSyncExternalStore(subscribe, () => linkedSandbox());

/** Makes a sandbox, remembered in this browser. Gives its base path. */
export async function createSandbox(): Promise<string> {
  const r = await fetch("/api/sandboxes", { method: "POST" });
  if (!r.ok) throw new Error(r.status === 429 ? "Too many sandboxes from this address. Try again in a while." : `The sandbox couldn't be created (HTTP ${r.status})`);
  const { base } = await r.json();
  saveSandboxes([...knownSandboxes(), { base, joined: false }]);
  // Its name, as soon as the server says it, so lists show it before anyone visits the sandbox.
  sandboxName(base).then(name => rememberName(base, name));
  return base;
}

/** Renames this page's sandbox at the server, and here. */
export async function renameSandbox(base: string, name: string) {
  await api("PATCH", "/api/sandbox", { name }, base);
  rememberName(base, name);
}
