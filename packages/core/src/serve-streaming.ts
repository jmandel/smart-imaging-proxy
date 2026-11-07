// Serves a fetch handler over node:http. Bun.serve replaces a declared Content-Length with chunked
// framing whenever the body is a stream, and a total Content-Length is what lets a client detect a
// truncated study most simply, so the proxy can't use it. This keeps the fetch shape, and follows
// the response's own headers.
//
// The body is read only after the socket has drained, which is what makes the handler's stream
// pull at the client's pace. A failed body destroys the socket without ending the message, so the
// client sees a short body or a missing final chunk. A client that hangs up cancels the body, and
// so does one that accepts nothing for `stallSeconds`.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
export interface StreamingServer { port: number; stop(): void; }

/** What a request under a host name that isn't the server's own gets. */
export const FOREIGN_HOST = () => Response.json({ error: "this server answers only at its own addresses and port" }, { status: 403 });

/** Enough for a sign-in form or a token request, which are the only bodies the one origin passes on. */
const MAX_REQUEST_BODY = 64 * 1024;

async function bodyOf(req: IncomingMessage): Promise<Uint8Array | undefined> {
  if (req.method === "GET" || req.method === "HEAD") { req.resume(); return undefined; }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_REQUEST_BODY) throw new Error("request body too large");
    chunks.push(c as Buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

type ForeignHost = (host: string | undefined, port: number) => boolean;

async function send(req: IncomingMessage, res: ServerResponse, handler: (req: Request) => Promise<Response> | Response, stallMs: number, foreignHost: ForeignHost) {
  let response: Response;
  try {
    const hosts = req.rawHeaders.filter((_, i) => i % 2 === 0 && req.rawHeaders[i]!.toLowerCase() === "host").length;
    if (hosts > 1 || foreignHost(req.headers.host, req.socket.localPort ?? 0)) { req.resume(); response = FOREIGN_HOST(); }
    else if (req.url === "/favicon.ico") { req.resume(); response = new Response(null, { status: 204 }); }
    else {
    const headers = new Headers();
    for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i]!, req.rawHeaders[i + 1]!);
    const body = await bodyOf(req);
    response = await handler(new Request(`http://${req.headers.host ?? "localhost"}${(req.url ?? "/").replace(/^[a-z]+:\/\/[^/]*/i, "") || "/"}`, { method: req.method, headers, body }));
    }
  } catch {
    res.writeHead(500).end();
    return;
  }
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) { res.end(); return; }
  const reader = response.body.getReader();
  let gone = false;
  let wake: (() => void) | undefined;
  res.on("close", () => {
    if (!res.writableFinished && !gone) { gone = true; reader.cancel(new Error("client disconnected")).catch(() => {}); }
    wake?.();
  });
  const drained = () => new Promise<void>(resolve => {
    if (gone || res.destroyed) { resolve(); return; }
    const stalled = setTimeout(() => res.destroy(new Error("client stalled")), stallMs);
    wake = () => { clearTimeout(stalled); wake = undefined; resolve(); };
    res.once("drain", () => wake?.());
  });
  try {
    while (!gone) {
      const { done, value } = await reader.read();
      if (gone) return;
      if (done) { res.end(); return; }
      if (!res.write(value)) await drained();
    }
  } catch (e) {
    res.destroy(e as Error);
  }
}

/**
 * `hosts` are the addresses to listen on, loopback by default. `foreignHost` says whether a Host header
 * names something other than this server, which gets a 403. Without it, any Host is served.
 */
export async function serveStreaming(port: number, handler: (req: Request) => Promise<Response> | Response, opts: { hosts?: string[]; stallSeconds?: number; foreignHost?: ForeignHost } = {}): Promise<StreamingServer> {
  const stallMs = (opts.stallSeconds ?? 240) * 1000;
  const foreignHost = opts.foreignHost ?? (() => false);
  const servers: Server[] = await Promise.all((opts.hosts ?? ["127.0.0.1"]).map(host => new Promise<Server>((resolve, reject) => {
    const server = createServer((req, res) => { send(req, res, handler, stallMs, foreignHost).catch(() => res.destroy()); });
    server.keepAliveTimeout = 60000;
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  })));
  return { port: (servers[0]!.address() as { port: number }).port, stop() { for (const s of servers) { s.closeAllConnections(); s.close(); } } };
}
