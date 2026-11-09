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
// `/s/{sandbox}` in front of any of these goes to the same service, which hands it to that sandbox.
//
// The services keep their own ports, and add their own CORS.
import { PORTS, PUBLIC_DEMO, PUBLIC_ORIGIN } from "./config";
import { splitSandbox } from "./sandboxes";

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

/** Pages that only make sense inside a sandbox. At the root of a public deployment they go to the list of sandboxes. */
const SCOPED_PAGES = new Set(["/tours", "/explore", "/activity", "/account", "/connect", "/build", "/servers"]);
/** What a public deployment's root sandbox refuses or redirects: everyone shares it, so nobody changes it. */
export function publicRootGate(method: string, path: string): Response | undefined {
  if (method === "GET" || method === "HEAD") return SCOPED_PAGES.has(path) ? new Response(null, { status: 302, headers: { location: "/" } }) : undefined;
  if (method === "OPTIONS" || (method === "POST" && path === "/api/sandboxes")) return undefined;
  return Response.json({ error: "the shared sandbox is read-only here: POST /api/sandboxes for a sandbox of your own, and work at its URLs" }, { status: 403 });
}

/** Each new sandbox is a file, so one address can't make them without end. Normal use never comes close. */
const MINTS_PER_HOUR = 120, recentMints = new Map<string, number[]>();
export function allowMint(address: string, now = Date.now()): boolean {
  const hourAgo = now - 3600_000, recent = (recentMints.get(address) ?? []).filter(t => t > hourAgo);
  if (recent.length >= MINTS_PER_HOUR) { recentMints.set(address, recent); return false; }
  recent.push(now);
  recentMints.set(address, recent);
  for (const [a, times] of recentMints) if (times.every(t => t <= hourAgo)) recentMints.delete(a);
  return true;
}

export async function gatewayFetch(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const { sandbox, rest: asSent } = splitSandbox(url.pathname);
  // Collapsed before the checks, since a client's fetch collapses it on the way to the service anyway.
  const rest = asSent.replace(/\/{2,}/g, "/");
  const prefix = sandbox ? `/s/${sandbox}` : "";
  if (INTERNAL.test(rest)) return new Response(null, { status: 404 });
  if (PUBLIC_DEMO && !sandbox) { const gated = publicRootGate(req.method, rest); if (gated) return gated; }
  if (PUBLIC_DEMO && !sandbox && req.method === "POST" && rest === "/api/sandboxes" && !allowMint(req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "direct")) return Response.json({ error: "too many sandboxes from this address: try again in a while" }, { status: 429 });
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
