// Policy sandboxes: scratch sandboxes addressed by the URL. `/s/{sandbox}/` in front of any path reaches that
// sandbox's own services. A sandbox is a minted id, random and unguessable, which starts from what is on file;
// its policy changes go through its management API, one way for everything. Unsaved sandboxes (a tour's, a
// check's) idle out, and the least recently used go first past the cap. An unknown or evicted unsaved id is gone.
import { randomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PolicyStore } from "@smart-imaging-proxy/core";
import { accountPatient, ON_FILE } from "./stores";
import { createDemoClock } from "./clock";
import { createSandbox, type Shared, type Sandbox } from "./sandbox";

export const SANDBOX_IDLE_MS = 30 * 60 * 1000;
export const MAX_SANDBOXES = 64;
/** With saved sandboxes, these only bound what's open: closing one loses nothing, and it reopens from its file. */
export const MAX_OPEN_SAVED = 1000;
const MINTED = /^[A-Za-z0-9_-]{22}$/;

/**
 * With `sandboxesDir`, a sandbox minted with `saved` is a SQLite file there that lasts until its owner deletes
 * it, across restarts. Every other sandbox, such as a tour's or a check's, lives in memory and idles out.
 */
export function createSandboxes(shared: Shared, opts: { idleMs?: number; max?: number; sandboxesDir?: string } = {}) {
  const saved = opts.sandboxesDir;
  const idleMs = opts.idleMs ?? SANDBOX_IDLE_MS;
  const pathOf = (id: string) => join(saved!, `${id}.sqlite`);
  const hasFile = (id: string) => !!saved && MINTED.test(id) && existsSync(pathOf(id));
  // Insertion order is use order: a use moves its sandbox to the end.
  const live = new Map<string, { sandbox: Sandbox; usedAt: number; saved: boolean }>(), max = opts.max ?? (saved ? MAX_OPEN_SAVED : MAX_SANDBOXES);
  const evict = (id: string) => { const e = live.get(id); if (!e) return; live.delete(id); e.sandbox.close(); };
  const sweep = () => { const cutoff = Date.now() - idleMs; for (const [id, e] of live) if (!e.saved && e.usedAt < cutoff) evict(id); };
  function add(id: string, persist = false) {
    const store = new PolicyStore({ ...(persist ? { mode: "file" as const, path: pathOf(id) } : { mode: "memory" as const }), onFile: { relationships: ON_FILE.relationships, policies: ON_FILE.policies, approvals: ON_FILE.approvals }, patientOf: accountPatient });
    const clock = createDemoClock(Number(store.note("clock") ?? 0), offset => { if (persist) store.setNote("clock", String(offset)); });
    const sandbox = createSandbox({ id, store, clock, shared });
    live.set(id, { sandbox, usedAt: Date.now(), saved: persist });
    // The oldest goes first, but not one with an app check running: closing it would end the run's staging.
    while (live.size > max) { const keys = [...live.keys()]; evict(keys.find(k => k !== id && !live.get(k)!.sandbox.appCheck) ?? keys[0]!); }
    return sandbox;
  }
  return {
    /** A new sandbox, starting from what is on file. */
    mint(o: { saved?: boolean } = {}): Sandbox { sweep(); return add(randomBytes(16).toString("base64url"), !!o.saved && !!saved); },
    /** The sandbox with this id, opening a saved one from its file, or why there is none. */
    resolve(id: string): { sandbox: Sandbox } | { status: 400 | 404; error: string } {
      sweep();
      const e = live.get(id);
      if (e) { live.delete(id); e.usedAt = Date.now(); live.set(id, e); return { sandbox: e.sandbox }; }
      if (hasFile(id)) return { sandbox: add(id, true) };
      return { status: 404, error: MINTED.test(id) ? "no sandbox has this address: it was deleted, or mistyped. (Only the sandboxes tours and checks make for themselves idle out.) Start a new one with POST /api/sandboxes" : "that isn't a sandbox: a sandbox's id is the 22 characters POST /api/sandboxes gave" };
    },
    has: (id: string) => live.has(id),
    /** Every live sandbox. */
    sandboxes: () => [...live.values()].map(e => e.sandbox),
    get size() { return live.size; },
    evict,
    /** Ends a sandbox for good: it, and with saved sandboxes its file. */
    remove(id: string) {
      evict(id);
      if (saved && MINTED.test(id)) for (const ext of ["", "-wal", "-shm"]) rmSync(pathOf(id) + ext, { force: true });
    },
    close() { for (const id of [...live.keys()]) evict(id); },
  };
}
export type Sandboxes = ReturnType<typeof createSandboxes>;

/** A path's sandbox and the rest of it, or none for the root. A sandbox inside a sandbox is refused. */
export function splitSandbox(path: string): { sandbox?: string; rest: string; nested?: boolean } {
  const m = path.match(/^\/s\/([^/]+)(\/.*)?$/);
  if (!m) return { rest: path };
  const rest = m[2] ?? "/";
  return { sandbox: m[1]!, rest, ...(/^\/s(\/|$)/.test(rest) ? { nested: true } : {}) };
}
