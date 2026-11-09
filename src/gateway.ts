// The one origin people and apps use, unless DEMO_ONE_ORIGIN=0: a host may give a machine only
// one public port, and some browser apps send a token only to one origin. It routes by path:
//
//   /imaging/...   Imaging Server, without the prefix
//   /wado/...      proxy
//   /trace/...     live trace, without the prefix
//   /fhir/..., /authorize..., /token, /introspect, /revoke, /account...   Authorization Server,
//                  which also serves the clinical FHIR base
//   anything else  the demo's pages
//
// `/s/{scope}` in front of any of these goes to the same service, which hands it to that scope.
//
// The services keep their own ports, and add their own CORS.
import { PORTS, PUBLIC_DEMO, PUBLIC_ORIGIN } from "./config";
import { splitScope } from "./scopes";

const at = (port: number, path: string) => `http://127.0.0.1:${port}${path}`;
const AUTH = /^\/(fhir|authorize|account)(\/|$)|^\/(token|introspect|revoke)$/;
function target(path: string, prefix: string): string {
  if (path.startsWith("/imaging/")) return at(PORTS.imaging, prefix + path.slice("/imaging".length));
  if (path.startsWith("/wado/")) return at(PORTS.proxy, prefix + path);
  if (path.startsWith("/trace/")) return at(PORTS.trace, prefix + path.slice("/trace".length));
  if (AUTH.test(path)) return at(PORTS.auth, prefix + path);
  return at(PORTS.demo, prefix + path);
}

/** Service-to-service APIs, which callers reach on the services' own loopback ports, never through here. */
const INTERNAL = /^\/imaging\/policy(\/|$)|^\/internal\/|^\/trace\/v1\//;

/** The pages at the root of a public deployment that open a visitor's own scope. The home page does it on Connect. */
const SCOPED_PAGES = new Set(["/tours", "/explore", "/activity", "/account"]);
/**
 * A page that mints a scope and goes there. Only a browser running it mints one, so a crawler
 * following links can't use up the scopes people are in.
 */
const OPEN_A_SCOPE = (path: string) => new Response(`<!doctype html><meta charset="utf-8"><title>SMART Imaging</title><meta name="robots" content="noindex"><p>Opening a sandbox of your own…</p><script>fetch("/api/scopes",{method:"POST"}).then(r=>r.json()).then(b=>location.replace(b.base+${JSON.stringify(path)}+location.search))</script>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });

/** What a public deployment's root world refuses or redirects: everyone shares it, so nobody changes it. */
export function publicRootGate(method: string, path: string): Response | undefined {
  if (method === "GET" || method === "HEAD") return SCOPED_PAGES.has(path) ? OPEN_A_SCOPE(path) : undefined;
  if (method === "OPTIONS" || (method === "POST" && path === "/api/scopes")) return undefined;
  return Response.json({ error: "the shared world is read-only here: POST /api/scopes for a sandbox of your own, and work at its URLs" }, { status: 403 });
}

export async function gatewayFetch(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const { scope, rest: asSent } = splitScope(url.pathname);
  // Collapsed before the checks, since a client's fetch collapses it on the way to the service anyway.
  const rest = asSent.replace(/\/{2,}/g, "/");
  const prefix = scope ? `/s/${scope}` : "";
  if (INTERNAL.test(rest)) return new Response(null, { status: 404 });
  if (PUBLIC_DEMO && !scope) { const gated = publicRootGate(req.method, rest); if (gated) return gated; }
  // The trace's pages use relative links, so its root needs the slash.
  if (rest === "/trace") return new Response(null, { status: 308, headers: { location: `${prefix}/trace/${url.search}` } });
  const to = target(rest, prefix);
  const headers = new Headers(req.headers);
  headers.delete("host");
  // A form on this origin is same-origin to the service behind it, so the service's write guard still holds.
  const from = headers.get("origin");
  if (from === url.origin || from === PUBLIC_ORIGIN) headers.set("origin", new URL(to).origin);
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  let r: Response;
  try {
    r = await fetch(to + url.search, {
      method: req.method, headers, body: hasBody ? await req.arrayBuffer() : undefined,
      // The client sees redirects and stored encodings exactly as the service sent them.
      redirect: "manual", decompress: false,
    } as RequestInit);
  } catch {
    return new Response(null, { status: 502 });
  }
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers: r.headers });
}
