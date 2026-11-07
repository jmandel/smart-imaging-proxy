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
import { PORTS, PUBLIC_ORIGIN } from "./config";
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

export async function gatewayFetch(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const { scope, rest } = splitScope(url.pathname);
  const prefix = scope ? `/s/${scope}` : "";
  if (INTERNAL.test(rest)) return new Response(null, { status: 404 });
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
