// What a server entry must hold, checked the same way wherever one arrives: the Your servers form, a pasted list,
// and an agent's request to check a server (src/check-runs.ts). Nothing here needs a browser.
import type { PrivateJwk } from "./api";

export interface ServerEntry {
  label: string;
  /** The FHIR base. */
  iss: string;
  clientId: string;
  scope?: string;
  /** The imaging FHIR server, when discovery doesn't name it. */
  imaging?: string;
  mode?: "backend";
  auth?: "private_key_jwt";
  jwk?: PrivateJwk;
  /** For a backend service: the patient's FHIR id it searches for. */
  patient?: string;
  /** For a sandbox: its base path. */
  sandbox?: string;
}

/** Whether an entry proves its identity with a signed assertion: a confidential app, or a backend service. */
export const signsIn = (s: Pick<ServerEntry, "auth" | "mode">) => s.auth === "private_key_jwt" || s.mode === "backend";

const isLocal = (host: string) => ["localhost", "127.0.0.1"].includes(host);
/** One entry as given, checked. Gives the entry, or throws saying what's wrong. */
export function checkServer(s: any, where = "This server"): ServerEntry {
  for (const [k, name] of [["label", "a name"], ["iss", "a FHIR base URL"], ["clientId", "a client ID"]] as const) if (typeof s?.[k] !== "string" || !s[k].trim()) throw new Error(`${where} needs ${name} ("${k}").`);
  for (const k of ["iss", "imaging"] as const) if (s[k] !== undefined) {
    let u: URL; try { u = new URL(s[k]); } catch { throw new Error(`${where}: "${k}" isn't a URL.`); }
    if (u.protocol !== "https:" && !isLocal(u.hostname)) throw new Error(`${where}: "${k}" must use https.`);
  }
  if (s.scope !== undefined && typeof s.scope !== "string") throw new Error(`${where}: "scope" must be text.`);
  if (s.mode !== undefined && !["launch", "backend"].includes(s.mode)) throw new Error(`${where}: "mode" must be launch or backend.`);
  if (s.auth !== undefined && !["public", "private_key_jwt"].includes(s.auth)) throw new Error(`${where}: "auth" must be public or private_key_jwt.`);
  const signs = s.auth === "private_key_jwt" || s.mode === "backend";
  if (signs && (typeof s.jwk !== "object" || !s.jwk?.d || !s.jwk?.kid)) throw new Error(`${where} needs a "jwk": a private ES256 JWK with a kid.`);
  if (s.mode === "backend" && (typeof s.patient !== "string" || !s.patient)) throw new Error(`${where} needs a "patient": the patient's FHIR id.`);
  return {
    label: s.label.trim(), iss: s.iss.trim().replace(/\/$/, ""), clientId: s.clientId.trim(),
    ...(s.scope?.trim() ? { scope: s.scope.trim() } : {}), ...(s.imaging ? { imaging: s.imaging.trim().replace(/\/$/, "") } : {}),
    ...(s.mode === "backend" ? { mode: "backend" as const } : {}), ...(s.auth === "private_key_jwt" ? { auth: "private_key_jwt" as const } : {}),
    ...(signs ? { jwk: s.jwk } : {}), ...(s.mode === "backend" ? { patient: s.patient } : {}),
  };
}
