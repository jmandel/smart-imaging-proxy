// The viewer's public keys, hosted for servers that only take a jwks_uri. Nothing is stored: the address holds
// the key, as base64url of its JSON, and answers with a JWKS of that one key. A new key is a new address.

/** The fields of an ES256 public key, and nothing else: a private key, or anything that isn't one, gets no address. */
interface PublicKey { kty: "EC"; crv: "P-256"; x: string; y: string; kid: string }
const B64 = /^[A-Za-z0-9_-]{43}$/, KID = /^[A-Za-z0-9._-]{1,100}$/;

function publicKeyOf(k: any): PublicKey | undefined {
  if (!k || typeof k !== "object" || "d" in k || k.kty !== "EC" || k.crv !== "P-256") return;
  if (typeof k.x !== "string" || !B64.test(k.x) || typeof k.y !== "string" || !B64.test(k.y) || typeof k.kid !== "string" || !KID.test(k.kid)) return;
  return { kty: "EC", crv: "P-256", x: k.x, y: k.y, kid: k.kid };
}

const toB64 = (s: string) => Buffer.from(s).toString("base64url");

/** Where a public key's JWKS is served, or undefined for anything that isn't an ES256 public key. */
export function jwksPath(key: unknown): string | undefined {
  const k = publicKeyOf(key);
  return k && `/jwks/${toB64(JSON.stringify({ crv: k.crv, x: k.x, y: k.y, kid: k.kid }))}`;
}

/** GET /jwks/{key}: the JWKS of the key the address holds. */
export function serveJwks(path: string): Response | undefined {
  const m = /^\/jwks\/([A-Za-z0-9_-]{1,400})$/.exec(path);
  if (!m) return;
  let k: unknown;
  try { k = JSON.parse(Buffer.from(m[1]!, "base64url").toString()); } catch {}
  const key = publicKeyOf(k && typeof k === "object" ? { kty: "EC", ...k } : k);
  if (!key) return Response.json({ error: "this address doesn't hold an ES256 public key" }, { status: 404, headers: { "access-control-allow-origin": "*" } });
  return Response.json({ keys: [{ ...key, use: "sig", alg: "ES256" }] }, {
    headers: { "access-control-allow-origin": "*", "cache-control": "public, max-age=86400, immutable" },
  });
}
