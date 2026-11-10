// What a server needs to register our viewer, as client metadata with the names RFC 7591 (dynamic client
// registration) gives them: a common model, whether a server takes it as JSON or in an admin form. Each field
// copies on its own, in the one column, and the whole copies as JSON.
import { useState } from "react";
import type { PrivateJwk } from "../lib/api";
import { CopyButton } from "../lib/format";
import { VIEWER_URL } from "../lib/servers";

export type ClientType = "public" | "confidential" | "backend";
export const CLIENT_TYPES: [ClientType, string, string][] = [
  ["public", "Public app", "A person signs in. Authorization code with PKCE (S256), and no key."],
  ["confidential", "Confidential app", "A person signs in, and the viewer proves who it is with a signed assertion (private_key_jwt)."],
  ["backend", "Backend service", "No one signs in. A signed assertion gets a token (client_credentials), and the viewer names the patient."],
];
export const SCOPES: Record<ClientType, string> = { public: "launch/patient patient/*.rs", confidential: "launch/patient patient/*.rs", backend: "system/ImagingStudy.rs" };
export const publicHalf = (jwk: PrivateJwk) => ({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, kid: jwk.kid, use: "sig", alg: "ES256" });

/** Where this site serves a public key's JWKS: the address holds the key, so nothing is stored (src/viewer-jwks.ts). */
export function jwksUri(key: PrivateJwk): string {
  const json = JSON.stringify({ crv: key.crv, x: key.x, y: key.y, kid: key.kid });
  return `${location.origin}/jwks/${btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

/** How the server finds the public key: in the metadata itself, or at an address this site serves. */
export type KeyBy = "jwks_uri" | "jwks";

/** The viewer's client metadata for a way of connecting, with its public key when it signs. */
export function clientMetadata(type: ClientType, key?: PrivateJwk | null, scope = SCOPES[type], by: KeyBy = "jwks_uri"): Record<string, unknown> {
  const signs = type !== "public";
  return {
    client_name: "SMART Imaging viewer",
    ...(type === "backend" ? {} : { redirect_uris: [VIEWER_URL] }),
    grant_types: type === "backend" ? ["client_credentials"] : ["authorization_code"],
    ...(type === "backend" ? {} : { response_types: ["code"] }),
    token_endpoint_auth_method: signs ? "private_key_jwt" : "none",
    ...(signs ? { token_endpoint_auth_signing_alg: "ES256" } : {}),
    ...(signs && key ? by === "jwks" ? { jwks: { keys: [publicHalf(key)] } } : { jwks_uri: jwksUri(key) } : {}),
    scope,
  };
}

/** What a field's own copy button gives: its text, the one string of a one-item list, or its JSON. */
const copyOf = (v: unknown) => typeof v === "string" ? v : Array.isArray(v) && v.length === 1 && typeof v[0] === "string" ? v[0] : JSON.stringify(v);

export function ClientMetadata({ type, keyPair, scope }: { type: ClientType; keyPair?: PrivateJwk | null; scope?: string }) {
  const [by, setBy] = useState<KeyBy>("jwks_uri");
  const meta = clientMetadata(type, keyPair, scope || undefined, by), entries = Object.entries(meta), whole = JSON.stringify(meta, null, 2);
  const waiting = type !== "public" && !keyPair;
  return (
    <figure className="client-meta" id="register-facts" aria-label="The viewer's client metadata">
      <figcaption>
        <span>Client metadata, in <a href="https://www.rfc-editor.org/rfc/rfc7591#section-2">RFC 7591</a> names</span>
        <CopyButton label="Copy JSON" value={whole} aria="Copy the client metadata as JSON" />
      </figcaption>
      <ol className="meta-lines">
        <li aria-hidden="true"><code>{"{"}</code></li>
        {entries.map(([k, v], i) => (
          <li key={k} data-field={k}>
            <code><span className="meta-key">"{k}":</span> <span className="meta-value">{JSON.stringify(v)}{i < entries.length - 1 ? "," : ""}</span></code>
            <CopyButton label="Copy" value={copyOf(v)} aria={`Copy ${k}`} />
          </li>
        ))}
        <li aria-hidden="true"><code>{"}"}</code></li>
      </ol>
      {waiting && <p className="note meta-waiting">The public key joins the metadata once there's a key pair.</p>}
      {type !== "public" && keyPair && <fieldset className="key-by"><legend>The public key, as</legend>
        <label><input type="radio" name="key-by" checked={by === "jwks_uri"} onChange={() => setBy("jwks_uri")} /> <code>jwks_uri</code> <span>an address this site serves it at</span></label>
        <label><input type="radio" name="key-by" checked={by === "jwks"} onChange={() => setBy("jwks")} /> <code>jwks</code> <span>the key itself, in the metadata</span></label>
      </fieldset>}
    </figure>
  );
}
