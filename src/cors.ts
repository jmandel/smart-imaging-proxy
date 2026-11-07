// CORS for the services a browser app calls: the Authorization Server, Imaging Server, and proxy.
// Apps send the token in Authorization, with no cookies, so any origin may read the answers.
const HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-expose-headers": "content-type, content-length, content-encoding, retry-after, location, www-authenticate",
};

type Handler = (req: Request, server?: unknown) => Response | Promise<Response>;

export function withCors(handler: Handler): Handler {
  return async (req, server) => {
    if (req.method === "OPTIONS" && req.headers.has("access-control-request-method")) {
      return new Response(null, { status: 204, headers: {
        ...HEADERS,
        "access-control-allow-methods": "GET, POST",
        "access-control-allow-headers": req.headers.get("access-control-request-headers") ?? "",
        // A public https page reaching loopback asks first, under Private Network Access.
        "access-control-allow-private-network": "true",
        "access-control-max-age": "600",
      } });
    }
    const res = await handler(req, server);
    // A response with immutable headers, such as one passed through from fetch, is copied first.
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(HEADERS)) headers.set(k, v);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };
}
