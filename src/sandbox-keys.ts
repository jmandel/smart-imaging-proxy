// Each sandbox's Backend Services keys: its admin client's, and each demo service's. They're derived from
// the sandbox's ID, which is already the sandbox's access, so a key gives no one more than the sandbox's URL
// does, and every sandbox's keys differ. The root sandbox has no ID, and derives them from a secret instead.
import { createECDH, createPrivateKey, hkdfSync, type KeyObject } from "node:crypto";

/** The sandbox's admin client: it manages the sandbox, and can get a token as any person for any app. */
export const SANDBOX_ADMIN = "sandbox-admin";
/** The scope that lets a token use the sandbox's management API. */
export const ADMIN_SCOPE = "sandbox/admin";

/** A P-256 private key from `seed`, the same every time for the same seed and client. */
export function derivedKey(seed: string, client_id: string): KeyObject {
  const d = Buffer.from(hkdfSync("sha256", seed, "", `smart-imaging-demo backend client ${client_id}`, 32));
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(d);
  const point = ecdh.getPublicKey();
  return createPrivateKey({ key: { kty: "EC", crv: "P-256", d: d.toString("base64url"), x: point.subarray(1, 33).toString("base64url"), y: point.subarray(33).toString("base64url") }, format: "jwk" });
}
/** A sandbox's seed: its ID, which every key of a sandbox is derived from. */
export const sandboxSeed = (id: string) => `sandbox ${id}`;
