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
import { FOREIGN_HOST, foreignHost, LISTEN_HOSTS } from "./config";

export interface StreamingServer { port: number; stop(): void; }

async function send(req: IncomingMessage, res: ServerResponse, handler: (req: Request) => Promise<Response> | Response, stallMs: number) {
  req.resume(); // No route here reads a request body.
  let response: Response;
  try {
    if (foreignHost(req.headers.host, req.socket.localPort ?? 0)) response = FOREIGN_HOST();
    else if (req.url === "/favicon.ico") response = new Response(null, { status: 204 });
    else {
    const headers = new Headers();
    for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i]!, req.rawHeaders[i + 1]!);
    response = await handler(new Request(`http://${req.headers.host ?? "localhost"}${req.url}`, { method: req.method, headers }));
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

export async function serveStreaming(port: number, handler: (req: Request) => Promise<Response> | Response, opts: { hosts?: string[]; stallSeconds?: number } = {}): Promise<StreamingServer> {
  const stallMs = (opts.stallSeconds ?? 240) * 1000;
  const servers: Server[] = await Promise.all((opts.hosts ?? LISTEN_HOSTS).map(host => new Promise<Server>((resolve, reject) => {
    const server = createServer((req, res) => { send(req, res, handler, stallMs).catch(() => res.destroy()); });
    server.keepAliveTimeout = 60000;
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  })));
  return { port: (servers[0]!.address() as { port: number }).port, stop() { for (const s of servers) { s.closeAllConnections(); s.close(); } } };
}
