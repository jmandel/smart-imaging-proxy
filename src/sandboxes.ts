// Policy sandboxes: scratch sandboxes addressed by the URL. `/s/{sandbox}/` in front of any path reaches that
// sandbox's own services. A sandbox is either a minted id, random and unguessable, which starts from what
// is on file, or an inline seed, `~` and a base64url deflate-raw JSON policy document, which
// builds its sandbox from the document on first use. Sandboxes idle out, and the least recently used go
// first past the cap. Minted sandboxes and seeds are separate pools, each with its own cap, so seeds,
// which anyone can make up, never push out a minted sandbox. An unknown or evicted minted id is gone; an
// evicted seed builds again.
import { randomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { PolicyStore } from "@smart-imaging-proxy/core";
import { accountPatient, ON_FILE, splitPanel, type Panel } from "./stores";
import { createDemoClock } from "./clock";
import { createSandbox, type Shared, type Sandbox } from "./sandbox";


export const SANDBOX_IDLE_MS = 30 * 60 * 1000;
export const MAX_SANDBOXES = 64, MAX_SEEDS = 64;
/** With saved sandboxes, these only bound what's open: closing one loses nothing, and it reopens from its file. */
export const MAX_OPEN_SAVED = 1000;
/** A seed's limits: its encoded length in the URL, and its JSON once inflated. */
export const MAX_SEED_CHARS = 4096, MAX_SEED_BYTES = 64 * 1024;
const MINTED = /^[A-Za-z0-9_-]{22}$/;
const SEEDED = /^~[A-Za-z0-9_-]+$/;

/**
 * A seed: the policy API's document, in all three levels the store holds: relationships, organization
 * policies, shares and app approvals, with the context settings. A part it leaves out is what's on
 * file, or none for choices.
 * Labels are the catalog's, and patient attributes the patient record's.
 */
export type Seed = Panel;
export const encodeSeed = (seed: Seed) => `~${deflateRawSync(Buffer.from(JSON.stringify(seed))).toString("base64url")}`;
export function decodeSeed(segment: string): { seed: Seed } | { error: string } {
  if (!SEEDED.test(segment)) return { error: "a seed is ~ and base64url" };
  if (segment.length - 1 > MAX_SEED_CHARS) return { error: `a seed is at most ${MAX_SEED_CHARS} characters: mint a sandbox for a larger policy` };
  let text: string;
  try { text = inflateRawSync(Buffer.from(segment.slice(1), "base64url"), { maxOutputLength: MAX_SEED_BYTES }).toString("utf8"); }
  catch { return { error: `a seed is deflate-raw JSON of at most ${MAX_SEED_BYTES} bytes` }; }
  let seed: unknown;
  try { seed = JSON.parse(text); } catch { return { error: "a seed's document isn't JSON" }; }
  const { errors } = splitPanel(seed);
  return errors.length ? { error: `the seed isn't a valid policy: ${errors.join("; ")}` } : { seed: seed as Seed };
}

/**
 * With `sandboxesDir`, a sandbox minted with `saved` is a SQLite file there that lasts until its owner deletes
 * it, across restarts. Every other sandbox, such as a tour's or a check's, lives in memory and idles out.
 */
export function createSandboxes(shared: Shared, opts: { idleMs?: number; max?: number; maxSeeds?: number; sandboxesDir?: string } = {}) {
  const saved = opts.sandboxesDir;
  const idleMs = opts.idleMs ?? SANDBOX_IDLE_MS;
  const pathOf = (id: string) => join(saved!, `${id}.sqlite`);
  const hasFile = (id: string) => !!saved && MINTED.test(id) && existsSync(pathOf(id));
  // Insertion order is use order: a use moves its sandbox to the end.
  type Pool = { live: Map<string, { sandbox: Sandbox; usedAt: number; saved: boolean }>; max: number };
  const minted: Pool = { live: new Map(), max: opts.max ?? (saved ? MAX_OPEN_SAVED : MAX_SANDBOXES) }, seeded: Pool = { live: new Map(), max: opts.maxSeeds ?? MAX_SEEDS };
  const poolOf = (id: string) => id.startsWith("~") ? seeded : minted;
  const evict = (id: string) => { const { live } = poolOf(id); const e = live.get(id); if (!e) return; live.delete(id); e.sandbox.close(); };
  const sweep = () => { const cutoff = Date.now() - idleMs; for (const pool of [minted, seeded]) for (const [id, e] of pool.live) if (!e.saved && e.usedAt < cutoff) evict(id); };
  function add(id: string, seed?: Seed, persist = false) {
    // What a seed names is its sandbox's on file, so a reset there puts the seed back. A seed brings its own choices.
    const store = new PolicyStore({ ...(persist ? { mode: "file" as const, path: pathOf(id) } : { mode: "memory" as const }), onFile: { relationships: seed?.relationships ?? ON_FILE.relationships, policies: seed?.policies ?? ON_FILE.policies, approvals: seed ? [] : ON_FILE.approvals }, patientOf: accountPatient });
    if (seed) {
      const { document, settings } = splitPanel(seed);
      if (document.shares || document.approvals) store.setDocument({ ...(document.shares ? { shares: document.shares } : {}), ...(document.approvals ? { approvals: document.approvals } : {}) });
      if (Object.keys(settings).length) store.setSettings(settings);
    }
    const clock = createDemoClock(Number(store.note("clock") ?? 0), offset => { if (persist) store.setNote("clock", String(offset)); });
    const sandbox = createSandbox({ id, store, clock, shared });
    const pool = poolOf(id);
    pool.live.set(id, { sandbox, usedAt: Date.now(), saved: persist });
    // The oldest goes first, but not one with an app check running: closing it would end the run's staging.
    while (pool.live.size > pool.max) { const keys = [...pool.live.keys()]; evict(keys.find(k => k !== id && !pool.live.get(k)!.sandbox.appCheck) ?? keys[0]!); }
    return sandbox;
  }
  return {
    /** A new sandbox, starting from what is on file. */
    mint(o: { saved?: boolean } = {}): Sandbox { sweep(); return add(randomBytes(16).toString("base64url"), undefined, !!o.saved && !!saved); },
    /** The sandbox's sandbox, building a seed's on first use, or why there is none. */
    resolve(id: string): { sandbox: Sandbox } | { status: 400 | 404; error: string } {
      sweep();
      const { live } = poolOf(id), e = live.get(id);
      if (e) { live.delete(id); e.usedAt = Date.now(); live.set(id, e); return { sandbox: e.sandbox }; }
      if (id.startsWith("~")) {
        const d = decodeSeed(id);
        return "error" in d ? { status: 400, error: d.error } : { sandbox: add(id, d.seed) };
      }
      if (hasFile(id)) return { sandbox: add(id, undefined, true) };
      return { status: 404, error: MINTED.test(id) ? "no sandbox has this address: it was deleted, or mistyped. (Only the sandboxes tours and checks make for themselves idle out.) Start a new one with POST /api/sandboxes" : "that isn't a sandbox" };
    },
    has: (id: string) => poolOf(id).live.has(id),
    /** Every live sandbox's sandbox. */
    sandboxes: () => [...minted.live.values(), ...seeded.live.values()].map(e => e.sandbox),
    get size() { return minted.live.size + seeded.live.size; },
    evict,
    /** Ends a sandbox for good: its sandbox, and with saved sandboxes its file. */
    remove(id: string) {
      evict(id);
      if (saved && MINTED.test(id)) for (const ext of ["", "-wal", "-shm"]) rmSync(pathOf(id) + ext, { force: true });
    },
    close() { for (const pool of [minted, seeded]) for (const id of [...pool.live.keys()]) evict(id); },
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
