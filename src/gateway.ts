// One origin in front of the Authorization Server, Imaging Server, and proxy, which is what the
// stack gives apps unless DEMO_ONE_ORIGIN=0. `/imaging/` goes to the Imaging Server, `/wado/` to
// the proxy, and everything else to the Authorization Server, which also serves the clinical FHIR
// base. The services keep their own ports, and add their own CORS.
import { PORTS } from "./config";

const at = (port: number, path: string) => `http://127.0.0.1:${port}${path}`;
function target(path: string): string {
  if (path.startsWith("/imaging/")) return at(PORTS.imaging, path.slice("/imaging".length));
  if (path.startsWith("/wado/") || path === "/internal/keys/refresh") return at(PORTS.proxy, path);
  return at(PORTS.auth, path);
}

export async function gatewayFetch(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const to = target(url.pathname);
  const headers = new Headers(req.headers);
  headers.delete("host");
  // A form on this origin is same-origin to the service behind it, so the service's write guard still holds.
  if (headers.get("origin") === url.origin) headers.set("origin", new URL(to).origin);
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
