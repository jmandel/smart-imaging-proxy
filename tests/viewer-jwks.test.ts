// The viewer's public keys, served for servers that only take a jwks_uri: the address holds the key, so any
// server can fetch it with nothing stored here, and nothing but an ES256 public key gets an address.
import { describe, expect, test } from "bun:test";
import { jwksPath, serveJwks } from "../src/viewer-jwks";

async function keyPair() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const priv = { ...await crypto.subtle.exportKey("jwk", pair.privateKey), kid: crypto.randomUUID() } as any;
  return { priv, pub: { kty: priv.kty, crv: priv.crv, x: priv.x, y: priv.y, kid: priv.kid }, verifyKey: pair.publicKey };
}
/** The page's own encoding (ui/components/ClientMetadata.tsx), which must land on the same address. */
const pageAddress = (k: any) => `/jwks/${btoa(JSON.stringify({ crv: k.crv, x: k.x, y: k.y, kid: k.kid })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;

describe("the viewer's JWKS", () => {
  test("serves the key its address holds, as a JWKS a server can verify the viewer's assertions with", async () => {
    const { priv, pub } = await keyPair();
    const path = jwksPath(pub)!;
    expect(path).toBe(pageAddress(pub));
    const res = serveJwks(path)!;
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const jwks = await res.json() as any;
    expect(jwks).toEqual({ keys: [{ ...pub, use: "sig", alg: "ES256" }] });
    // An assertion the viewer signs with the private half checks out against the served key.
    const signer = await crypto.subtle.importKey("jwk", priv, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    const verifier = await crypto.subtle.importKey("jwk", jwks.keys[0], { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const data = new TextEncoder().encode("header.payload");
    const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signer, data);
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, verifier, sig, data)).toBe(true);
  });
  test("never serves or addresses a private key, or anything that isn't an ES256 public key", async () => {
    const { priv, pub } = await keyPair();
    expect(jwksPath(priv)).toBeUndefined();
    expect(jwksPath({ ...pub, crv: "P-384" })).toBeUndefined();
    expect(jwksPath({ ...pub, kid: "<script>" })).toBeUndefined();
    const enc = (o: unknown) => `/jwks/${Buffer.from(JSON.stringify(o)).toString("base64url")}`;
    expect(serveJwks(enc({ crv: priv.crv, x: priv.x, y: priv.y, kid: priv.kid, d: priv.d }))!.status).toBe(404);
    expect(serveJwks(enc({ hello: "world" }))!.status).toBe(404);
    expect(serveJwks("/jwks/not-base64-json")!.status).toBe(404);
    expect(serveJwks("/jwks/a/b")).toBeUndefined();
  });
});
