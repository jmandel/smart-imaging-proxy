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
// The services keep their own ports, and add their own CORS.
import { PORTS, PUBLIC_ORIGIN } from "./config";

const at = (port: number, path: string) => `http://127.0.0.1:${port}${path}`;
const AUTH = /^\/(fhir|authorize|account)(\/|$)|^\/(token|introspect|revoke)$/;
function target(path: string): string {
  if (path.startsWith("/imaging/")) return at(PORTS.imaging, path.slice("/imaging".length));
  if (path.startsWith("/wado/")) return at(PORTS.proxy, path);
  if (path.startsWith("/trace/")) return at(PORTS.trace, path.slice("/trace".length));
  if (AUTH.test(path)) return at(PORTS.auth, path);
  return at(PORTS.demo, path);
}

/** Service-to-service APIs, which callers reach on the services' own loopback ports, never through here. */
const INTERNAL = /^\/imaging\/policy(\/|$)|^\/internal\//;

export async function gatewayFetch(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (INTERNAL.test(url.pathname)) return new Response(null, { status: 404 });
  // The trace's pages use relative links, so its root needs the slash.
  if (url.pathname === "/trace") return new Response(null, { status: 308, headers: { location: `/trace/${url.search}` } });
  const to = target(url.pathname);
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
