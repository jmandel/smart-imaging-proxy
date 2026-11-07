// Where the proxy gets the Imaging Server's public keys. It holds them for a TTL, and it refuses to
// use them past that: with no current keys, the fast path fails closed and the request is decided by
// `can_i` instead. A kid it doesn't know can mean a rotation, so that refetches, with a cooldown so
// a stream of random kids can't turn into a stream of fetches.
import type { KeyObject } from "node:crypto";
import { importPublicJwk } from "./jws";

export interface KeySource {
  /** The keys usable right now, having refetched if they're stale or `kid` is unknown. */
  keysFor(kid: string | undefined): Promise<Map<string, KeyObject>>;
  /** Refetches at once. If that fails, every held key is dropped. */
  refresh(): Promise<boolean>;
}

export const staticKeys = (keys: Map<string, KeyObject>): KeySource => ({ keysFor: async () => keys, refresh: async () => true });

export const DEFAULT_JWKS_TTL_SECONDS = 60;

/** `fetch` makes the request, which by default is the platform's own. */
export function jwksKeys(opts: { url: string; ttlSeconds?: number; cooldownSeconds?: number; timeoutMs?: number; clock?: () => number; fetch?: (url: string, init: RequestInit) => Promise<Response> }): KeySource {
  const ttl = (opts.ttlSeconds ?? DEFAULT_JWKS_TTL_SECONDS) * 1000;
  const cooldown = (opts.cooldownSeconds ?? 10) * 1000;
  const clock = opts.clock ?? Date.now;
  const get = opts.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
  let keys = new Map<string, KeyObject>();
  let fetchedAt: number | undefined;
  let attemptedAt: number | undefined;
  let failedAt: number | undefined;
  let inflight: Promise<boolean> | undefined;

  const within = (at: number | undefined, ms: number) => at !== undefined && clock() - at < ms;
  const drop = () => { keys = new Map(); fetchedAt = undefined; };

  async function load(): Promise<boolean> {
    attemptedAt = clock();
    try {
      const r = await get(opts.url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 2000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body: any = await r.json();
      if (!Array.isArray(body?.keys)) throw new Error("no keys array");
      const next = new Map<string, KeyObject>();
      // Only the one algorithm verification accepts. Anything else in the set is ignored.
      for (const jwk of body.keys) if (typeof jwk?.kid === "string" && jwk.kty === "OKP" && jwk.crv === "Ed25519") next.set(jwk.kid, importPublicJwk(jwk));
      keys = next;
      fetchedAt = clock();
      failedAt = undefined;
      return true;
    } catch {
      failedAt = clock();
      return false;
    }
  }
  const once = () => inflight ??= load().finally(() => { inflight = undefined; });

  return {
    async keysFor(kid) {
      if (!within(fetchedAt, ttl)) {
        drop();
        if (!within(failedAt, cooldown)) await once();
      } else if (kid !== undefined && !keys.has(kid) && !within(attemptedAt, cooldown)) await once();
      return keys;
    },
    async refresh() {
      // A fetch already under way may have read the set from before the change being announced.
      if (inflight) await inflight;
      const ok = await once();
      if (!ok) drop();
      return ok;
    },
  };
}
