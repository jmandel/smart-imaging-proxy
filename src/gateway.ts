// One origin in front of the Authorization Server, Imaging Server, and proxy, when DEMO_ONE_ORIGIN=1.
// Some browser apps send a token only to the origins they were given, so they won't follow an
// Endpoint to a proxy on another port. `/imaging/` goes to the Imaging Server, `/wado/` to the
// proxy, and everything else to the Authorization Server, which also serves the clinical FHIR base.
// It adds CORS, so a page on another origin can call it. The services behind it don't change.
import { PORTS } from "./config";

const at = (port: number, path: string) => `http://127.0.0.1:${port}${path}`;
function target(path: string): string {
  if (path.startsWith("/imaging/")) return at(PORTS.imaging, path.slice("/imaging".length));
  if (path.startsWith("/wado/") || path === "/internal/keys/refresh") return at(PORTS.proxy, path);
  return at(PORTS.auth, path);
}

// No credentials: apps send the token in Authorization, so any origin may read the answers.
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-expose-headers": "content-type, content-length, content-encoding, retry-after, location, www-authenticate",
};

export async function gatewayFetch(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === "OPTIONS" && req.headers.has("access-control-request-method")) {
    return new Response(null, { status: 204, headers: {
      ...CORS,
      "access-control-allow-methods": "GET, POST",
      "access-control-allow-headers": req.headers.get("access-control-request-headers") ?? "",
      // A public https page reaching loopback asks first, under Private Network Access.
      "access-control-allow-private-network": "true",
      "access-control-max-age": "600",
    } });
  }
  const to = target(url.pathname);
  const headers = new Headers(req.headers);
  headers.delete("host");
  // A form on this origin is same-origin to the service behind it, so the service's write guard still holds.
  if (headers.get("origin") === url.origin) headers.set("origin", new URL(to).origin);
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const r = await fetch(to + url.search, {
    method: req.method, headers, body: hasBody ? await req.arrayBuffer() : undefined,
    // The client sees redirects and stored encodings exactly as the service sent them.
    redirect: "manual", decompress: false,
  } as RequestInit);
  const out = new Headers(r.headers);
  for (const [k, v] of Object.entries(CORS)) out.set(k, v);
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers: out });
}
