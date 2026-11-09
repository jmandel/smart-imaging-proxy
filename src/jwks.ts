// Fetching a client's published keys from the URL it registered. Anyone can register a URL on a public deployment, so
// this refuses anything that isn't plainly a public web server, and says nothing about what it found on the way.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const MOST_BYTES = 256 * 1024, MOST_REDIRECTS = 3, TIMEOUT_MS = 5000, CACHE_MS = 5 * 60_000, UNKNOWN_KID_RETRY_MS = 30_000;
export const JWKS_REFUSED = "that JWKS URL can't be used: it must be a public https address that returns a JSON Web Key Set";

const v4Number = (ip: string) => ip.split(".").reduce((n, part) => n * 256 + Number(part), 0);
const V4_BLOCKED: [string, number][] = [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]];
/** Whether an address is anything but ordinary public internet. An unparseable one counts as blocked. */
export function isBlockedAddress(raw: string): boolean {
  const ip = raw.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(ip) === 4) { const n = v4Number(ip); return V4_BLOCKED.some(([base, bits]) => { const size = 2 ** (32 - bits), start = v4Number(base); return n >= start && n < start + size; }); }
  if (isIP(ip) !== 6) return true;
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mapped) return isBlockedAddress(mapped);
  const hex = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) { const a = parseInt(hex[1]!, 16), b = parseInt(hex[2]!, 16); return isBlockedAddress(`${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`); }
  if (ip === "::" || ip === "::1") return true;
  return /^(f[cd]|fe[89ab]|ff|2001:db8|64:ff9b)/.test(ip);
}

/** Whether a URL could be fetched, on a deployment where anyone can register one. */
export async function isAllowedUrl(raw: string, strict: boolean, resolve: (host: string) => Promise<string[]> = async h => (await lookup(h, { all: true, verbatim: true })).map(a => a.address)): Promise<boolean> {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.username || u.password) return false;
  if (!strict) return u.protocol === "https:" || u.protocol === "http:";
  const port = u.port ? Number(u.port) : 443;
  if (u.protocol !== "https:" || !(port === 443 || port >= 1024)) return false;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return !isBlockedAddress(host);
  if (!host.includes(".") || /(^|\.)(localhost|local|internal|intranet|lan|corp|home|svc|cluster\.local)$/i.test(host)) return false;
  try { const addresses = await resolve(host); return addresses.length > 0 && addresses.every(a => !isBlockedAddress(a)); } catch { return false; }
}

async function readLimited(res: Response): Promise<string | undefined> {
  if (Number(res.headers.get("content-length") ?? 0) > MOST_BYTES || !res.body) return undefined;
  const reader = res.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MOST_BYTES) { await reader.cancel(); return undefined; }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
/** The keys at a URL, each hop checked. Undefined for every kind of failure, so a caller can't probe with it. */
export async function fetchJwks(url: string, strict: boolean): Promise<JsonWebKey[] | undefined> {
  try {
    let at = url;
    for (let hop = 0; hop <= MOST_REDIRECTS; hop++) {
      if (!await isAllowedUrl(at, strict)) return undefined;
      const res = await fetch(at, { redirect: "manual", headers: { accept: "application/jwk-set+json, application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel();
        const next = res.headers.get("location");
        if (!next) return undefined;
        at = new URL(next, at).toString();
        continue;
      }
      if (!res.ok) { await res.body?.cancel(); return undefined; }
      const text = await readLimited(res);
      const keys = text === undefined ? undefined : JSON.parse(text)?.keys;
      return Array.isArray(keys) ? keys.filter(k => typeof k === "object" && k !== null && !("d" in k)) : undefined;
    }
  } catch {}
  return undefined;
}

/** A client's key by kid, from a short cache, refetched when a client has rotated to a kid not seen yet. */
const cache = new Map<string, { keys: JsonWebKey[]; at: number }>();
export async function jwksKey(url: string, kid: string, strict: boolean, now = Date.now()): Promise<JsonWebKey | undefined> {
  const held = cache.get(url), find = (keys: JsonWebKey[]) => keys.find(k => (k as any).kid === kid);
  if (held && now - held.at < CACHE_MS) {
    const key = find(held.keys);
    if (key || now - held.at < UNKNOWN_KID_RETRY_MS) return key;
  }
  const keys = await fetchJwks(url, strict);
  if (!keys) return held && now - held.at < CACHE_MS ? find(held.keys) : undefined;
  cache.delete(url);
  cache.set(url, { keys, at: now });
  // The cache holds only recent URLs, oldest first out, so it can't grow without end.
  while (cache.size > 5000) cache.delete(cache.keys().next().value!);
  return find(keys);
}
export const clearJwksCache = () => cache.clear();
