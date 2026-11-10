// What a failed request most likely means, in words a server developer can act on: the cause, and a way to check
// it from a terminal. The viewer and the server check both say it beside the request that failed.
export type Hop = "discover" | "authorize" | "token" | "backend-token" | "patient" | "clinical" | "imaging" | "wado";
export interface Diagnosis { cause: string; check?: string }

const where = (url: string) => { try { return new URL(url).host; } catch { return url; } };

/**
 * A request that got no readable answer (`error`), one answered with `status`, or one answered when it shouldn't
 * have been, or with the wrong thing (`wrong`).
 */
export function diagnose(hop: Hop, url: string, failure: { error?: unknown; status?: number; wrong?: "open" | "not-dicom" | "not-bundle" }): Diagnosis {
  const host = where(url), origin = location.origin;
  if (failure.wrong === "open") return {
    cause: `${host} sent the image with no access token. Anyone with a study's address could read it: the image server has to check the token from the patient's sign-in on every retrieval.`,
    check: `curl -i "${url}"   # expect 401 or 403`,
  };
  if (failure.wrong === "not-dicom") return { cause: `${host} answered, but not with a DICOM instance in a multipart/related response, as WADO-RS sends it. The response's content-type and first bytes say what it sent instead.` };
  if (failure.wrong === "not-bundle") return { cause: `${host} answered, but not with a FHIR Bundle. A search answers with a Bundle of type searchset, even when it finds nothing.` };
  if (failure.error !== undefined) return {
    cause: `The browser couldn't read the answer from ${host}. Usually the server sends no access-control-allow-origin for ${origin} (CORS), the address is wrong, or the server can't be reached from the internet.`,
    check: `curl -i "${url}" -H "origin: ${origin}"   # a 200 with no access-control-allow-origin means CORS`,
  };
  const status = failure.status ?? 0;
  if (hop === "discover" && status === 404) return { cause: `${host} has no .well-known/smart-configuration at this address. The FHIR base is the address that /metadata is under.`, check: `curl -i "${url}"` };
  if ((hop === "token" || hop === "backend-token") && status === 400) return { cause: "The token endpoint refused the request. Its error says why: often a redirect URI, client ID, or PKCE verifier that doesn't match what was registered, or an assertion whose key, audience or expiry it won't accept." };
  if ((hop === "token" || hop === "backend-token") && status === 401) return { cause: "The token endpoint didn't accept this client's credentials: check the client ID, and for a signed assertion, the registered public key and its kid." };
  if (status === 401) return { cause: `${host} refused the access token. A SMART Imaging server accepts the token from the patient's sign-in at every one of its endpoints, including this one.` };
  if (status === 403) return { cause: `${host} accepted the token but refused this request: check the scopes the token granted, and the server's policy for this patient.` };
  if (status === 404) return { cause: `${host} has nothing at this address. For a study's images, the address comes from its Endpoint: check Endpoint.address is the WADO-RS base.`, check: `curl -i "${url}"` };
  if (hop === "wado" && status === 406) return { cause: `${host} can't send this image in a form the viewer accepts: it asks for multipart/related with any transfer syntax, falling back to uncompressed.` };
  if (status >= 500) return { cause: `${host} failed on its side (HTTP ${status}). Its logs will say why.` };
  return { cause: `${host} answered HTTP ${status}.` };
}
