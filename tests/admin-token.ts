// A sandbox's admin token, got as any client would: its key from the sandbox, a signed assertion, and
// client_credentials at its token endpoint. For tests that call the management API.
import { createPrivateKey, randomBytes, sign } from "node:crypto";
import { CONFIG } from "../src/config";

type Demo = { fetch(req: Request): Promise<Response> | Response };
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

/** A client assertion signed with a private JWK, for `aud`. */
export function assertion(client_id: string, jwk: any, aud: string, now = Math.floor(Date.now() / 1000)) {
  const head = `${b64({ alg: "ES256", kid: jwk.kid, typ: "JWT" })}.${b64({ iss: client_id, sub: client_id, aud, jti: randomBytes(8).toString("hex"), exp: now + 240 })}`;
  return `${head}.${sign("sha256", Buffer.from(head), { key: createPrivateKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}
/** A sandbox's sample keys, from its management API's one open call. */
export async function keysOf(demo: Demo, prefix: string) {
  const r = await demo.fetch(new Request(`${CONFIG.demoUrl}${prefix}/api/sandbox/keys-shared-on-purpose`));
  if (!r.ok) throw new Error(`keys: HTTP ${r.status}`);
  return r.json() as Promise<{ tokenEndpoint: string; now: number; admin: { client_id: string; jwk: any; scope: string }; services: { client_id: string; jwk: any; scope: string }[] }>;
}
/** A token from a sandbox's admin key: for its management API, or with `as`, as a person for an app. */
export async function adminToken(demo: Demo, prefix: string, as?: { user: string; patient: string; app?: string }, now?: number, headers: Record<string, string> = {}): Promise<string> {
  const k = await keysOf(demo, prefix);
  const form = new URLSearchParams({ grant_type: "client_credentials", client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: assertion(k.admin.client_id, k.admin.jwk, k.tokenEndpoint, now ?? k.now), ...(as ? { user: as.user, patient: as.patient, ...(as.app ? { app: as.app } : {}) } : { scope: k.admin.scope }) });
  const r = await fetch(k.tokenEndpoint, { method: "POST", headers: { ...headers, "content-type": "application/x-www-form-urlencoded" }, body: form });
  const t: any = await r.json();
  if (!t.access_token) throw new Error(`admin token: ${JSON.stringify(t)}`);
  return t.access_token;
}
/** Headers that carry a sandbox's admin token. */
export const adminHeaders = async (demo: Demo, prefix: string) => ({ authorization: `Bearer ${await adminToken(demo, prefix)}` });
/** Headers with the admin token of the sandbox a path is in, for a path that's on the management API; none otherwise. */
export async function adminFor(demo: Demo, path: string): Promise<Record<string, string>> {
  const at = new URL(path, CONFIG.demoUrl).pathname;
  if (!/^(\/s\/[^/]+)?\/api\/sandbox(\/|$|\?)/.test(at) || /\/api\/sandbox\/keys-shared-on-purpose$/.test(at)) return {};
  return adminHeaders(demo, at.match(/^\/s\/[^/]+/)?.[0] ?? "");
}
