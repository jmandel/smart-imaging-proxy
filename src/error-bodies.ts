// Every refusal says why. The services answer many 4xx with no body, which leaves a client, or an agent, guessing;
// the gateway fills those in on the way out: an OperationOutcome on a FHIR path, `{error, hint}` elsewhere. A body
// a service sent is never touched, since it knows the reason best.

type Kind = "fhir" | "wado" | "other";
const kindOf = (path: string): Kind => /^\/wado\//.test(path) ? "wado" : /(^|\/)fhir(\/|$)/.test(path) ? "fhir" : "other";

/** Why, by status and where, with what usually fixes it. */
function reasonFor(status: number, kind: Kind, authenticate: string | null): { error: string; hint?: string } {
  const invalid = /error="invalid_token"/.test(authenticate ?? ""), scope = /error="insufficient_scope"/.test(authenticate ?? "");
  switch (status) {
    case 400: return kind === "wado"
      ? { error: "the path isn't a well-formed retrieval", hint: "Retrieve from the study's Endpoint.address, as given. A study's UID is its identifier with system urn:dicom:uid, without the urn:oid: prefix." }
      : { error: "the request isn't well formed" };
    case 401: return invalid
      ? { error: "the bearer token isn't active: expired, revoked, or not one this sandbox issued", hint: "Get a new token. A sandbox's tokens expire by its demo clock." }
      : { error: "no bearer token", hint: "Send authorization: Bearer <access_token>." };
    case 403: return scope
      ? { error: "the token's scopes don't cover this request" }
      : { error: "this token may not read this" };
    case 404: return kind === "wado"
      ? { error: "no such study, series or instance released to this token", hint: "Use the Endpoint.address that search returned with the study. /frames, /rendered and /thumbnail aren't served here." }
      : { error: "not found" };
    case 405: return { error: "this method isn't allowed here" };
    case 406: return kind === "wado"
      ? { error: "none of the accepted types can be served", hint: "Ask for accept: multipart/related; type=\"application/dicom\"; transfer-syntax=*, or application/dicom+json for metadata." }
      : { error: "none of the accepted types can be served" };
    case 502: return { error: "a service behind this address didn't answer" };
    default: return { error: `HTTP ${status}` };
  }
}

/** The response, with a body saying why when a refusal came without one. */
export async function withReason(r: Response, path: string, method: string): Promise<Response> {
  if (r.status < 400 || method === "HEAD" || r.headers.get("content-type")) return r;
  const body = r.body ? await r.arrayBuffer() : new ArrayBuffer(0);
  if (body.byteLength) return new Response(body, { status: r.status, statusText: r.statusText, headers: r.headers });
  const kind = kindOf(path), why = reasonFor(r.status, kind, r.headers.get("www-authenticate"));
  const headers = new Headers(r.headers);
  headers.delete("content-length");
  if (kind === "fhir") {
    headers.set("content-type", "application/fhir+json");
    const code = r.status === 401 ? "login" : r.status === 403 ? "forbidden" : r.status === 404 ? "not-found" : "processing";
    return new Response(JSON.stringify({ resourceType: "OperationOutcome", issue: [{ severity: "error", code, diagnostics: why.hint ? `${why.error}. ${why.hint}` : why.error }] }), { status: r.status, statusText: r.statusText, headers });
  }
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(why), { status: r.status, statusText: r.statusText, headers });
}
