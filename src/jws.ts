import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";

export const b64url = (b: Uint8Array | string) => Buffer.from(b as any).toString("base64url");
export const fromB64url = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));

/** The DPoP `ath` construction: base64url SHA-256 of the access token. */
export const ath = (token: string) => createHash("sha256").update(token).digest("base64url");
export const sha = (s: string) => createHash("sha256").update(s).digest("base64url");

export interface KeyPair { kid: string; privateKey: KeyObject; publicKey: KeyObject; }
export function generateEd25519(kid: string): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { kid, privateKey, publicKey };
}
export const publicJwk = (k: KeyPair) => ({ ...k.publicKey.export({ format: "jwk" }), kid: k.kid, use: "sig", alg: "EdDSA" });
export const importPublicJwk = (jwk: any) => createPublicKey({ key: jwk, format: "jwk" });

export function signJws(k: KeyPair, claims: object): string {
  const head = b64url(JSON.stringify({ alg: "EdDSA", kid: k.kid, typ: "smart-imaging-context+jwt" }));
  const body = b64url(JSON.stringify(claims));
  return `${head}.${body}.${b64url(sign(null, Buffer.from(`${head}.${body}`), k.privateKey))}`;
}

/** The `kid` a context names, before anything has verified it. */
export function kidOf(token: string): string | undefined {
  try {
    const kid = JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString()).kid;
    return typeof kid === "string" ? kid : undefined;
  } catch { return undefined; }
}

/** Returns the claims, or undefined. The algorithm is pinned, whatever the header says. */
export function verifyJws(token: string, keys: Map<string, KeyObject>): any | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const head = JSON.parse(Buffer.from(parts[0]!, "base64url").toString());
    if (head.alg !== "EdDSA" || head.typ !== "smart-imaging-context+jwt") return undefined;
    const key = keys.get(head.kid);
    if (!key) return undefined;
    if (!verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2]!, "base64url"))) return undefined;
    return JSON.parse(Buffer.from(parts[1]!, "base64url").toString());
  } catch { return undefined; }
}
