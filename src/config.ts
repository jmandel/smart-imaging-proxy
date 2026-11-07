// DEMO_PORT_OFFSET lets a second copy of the stack run beside the first. The S3 store and Orthanc are
// shared, unless S3_PORT and ORTHANC_PORT point it at its own.
import { FOREIGN_HOST, serveStreaming } from "@smart-imaging-proxy/core";

const offset = Number(process.env.DEMO_PORT_OFFSET ?? 0);
/** Where everything the demo writes lives by default: archive, SQLite files, backend volumes, and `bun run up`'s log. */
export const STORAGE = process.env.DEMO_STORAGE || "/tmp/smart-imaging-demo";
export const DEFAULT_CATALOG_DB = `${STORAGE}/catalog.sqlite`;
export const DEFAULT_POLICY_DB = `${STORAGE}/policy.sqlite`;
export const PORTS = { demo: 4600 + offset, proxy: 4601 + offset, imaging: 4602 + offset, auth: 4603 + offset, trace: 4604 + offset, gateway: 4605 + offset };
/** Apps see one origin for the auth, imaging, and proxy services, unless DEMO_ONE_ORIGIN=0. See `src/gateway.ts`. */
export const ONE_ORIGIN = process.env.DEMO_ONE_ORIGIN !== "0";

/** This machine on its tailnet, if Tailscale is running. Tests and `DEMO_TAILNET=0` stay on loopback. */
function detectTailnet(): { name: string; ip: string } | undefined {
  if (process.env.DEMO_TAILNET === "0" || process.env.NODE_ENV === "test") return undefined;
  try {
    const r = Bun.spawnSync(["tailscale", "status", "--json"], { stdout: "pipe", stderr: "ignore" });
    if (r.exitCode !== 0) return undefined;
    const s = JSON.parse(r.stdout.toString());
    const name = String(s.Self?.DNSName ?? "").replace(/\.$/, ""), ip = (s.Self?.TailscaleIPs ?? []).find((a: string) => a.includes("."));
    return s.BackendState === "Running" && name && ip ? { name, ip } : undefined;
  } catch { return undefined; }
}
export const TAILNET = detectTailnet();
// The address, not the MagicDNS name: not every machine resolves the name, including sometimes this one.
const host = `http://${TAILNET?.ip ?? "127.0.0.1"}`;
/**
 * Where people and apps reach the one origin when a host in front of it gives it a name, such as
 * https://imaging.example.org. Its host terminates TLS and forwards to the one origin's port, so that
 * port listens on every interface. Without it, the one origin is this machine's port 4605.
 */
const PUBLIC = process.env.DEMO_PUBLIC_URL ? new URL(process.env.DEMO_PUBLIC_URL) : undefined;
if (PUBLIC && (PUBLIC.pathname !== "/" || PUBLIC.search)) throw new Error("DEMO_PUBLIC_URL is an origin, such as https://imaging.example.org, with no path");
if (PUBLIC && !ONE_ORIGIN) throw new Error("DEMO_PUBLIC_URL names the one origin, which DEMO_ONE_ORIGIN=0 turns off");
const origin = PUBLIC?.origin ?? `${host}:${PORTS.gateway}`;
/** The addresses the one origin listens on. */
export const GATEWAY_HOSTS = PUBLIC ? ["0.0.0.0"] : undefined;
/** The address every service listens on. The S3 store and Orthanc stay on loopback: only the proxy reaches them. */
export const LISTEN_HOSTS = ["127.0.0.1", ...(TAILNET ? [TAILNET.ip] : [])];
/** What a client sees of a failed request. The details go to the server's log. */
const hostsAt = (port: number, tailnet = TAILNET) => [`127.0.0.1:${port}`, `localhost:${port}`, ...(tailnet ? [`${tailnet.name}:${port}`, `${tailnet.ip}:${port}`] : [])];
/** A service's own names, which include the one origin's, since that's where apps reach it. */
export const ownHosts = (port: number, tailnet = TAILNET) => [...hostsAt(port, tailnet), ...(ONE_ORIGIN && port !== PORTS.gateway ? hostsAt(PORTS.gateway, tailnet) : []), ...(PUBLIC ? [PUBLIC.host, `${PUBLIC.hostname}:${PORTS.gateway}`] : [])];
/** A DNS rebinding page reaches a service under its own host name. A browser always sends Host, so a request with none isn't such a page. */
export const foreignHost = (host: string | null | undefined, port: number) => host != null && !ownHosts(port).includes(host);
export { FOREIGN_HOST };
const serverError = (err: Error) => { console.error(err); return new Response("Internal Server Error", { status: 500, headers: { "content-type": "text/plain" } }); };
export const serveOn = (port: number, options: Omit<Parameters<typeof Bun.serve>[0], "port" | "hostname">) =>
  LISTEN_HOSTS.map(hostname => Bun.serve({
    ...options, port, hostname, development: false, error: serverError,
    fetch(req: Request, server: unknown) {
      if (foreignHost(req.headers.get("host"), (server as { port: number }).port)) return FOREIGN_HOST();
      // With no Host header, Bun gives a relative URL, and the services read absolute ones.
      const url = new URL(req.url, `http://${hostname}:${port}`);
      if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
      return (options as any).fetch(/^https?:/.test(req.url) ? req : new Request(url, req), server);
    },
  } as any));
/** The streaming server, for a response whose exact Content-Length has to reach the client, on this machine's addresses with their Host check. */
export const serveStreamingOn = (port: number, handler: (req: Request) => Promise<Response> | Response, hosts = LISTEN_HOSTS) => serveStreaming(port, handler, { hosts, foreignHost });
/** The identifier system of the sample studies' accession numbers: the sample data's stand-in hospital. */
export const ACCESSION_SYSTEM = "http://hospital.example.org/accession";
export const CONFIG = {
  demoUrl: ONE_ORIGIN ? origin : `${host}:${PORTS.demo}`,
  proxyUrl: ONE_ORIGIN ? origin : `${host}:${PORTS.proxy}`,
  imagingUrl: ONE_ORIGIN ? `${origin}/imaging` : `${host}:${PORTS.imaging}`,
  authUrl: ONE_ORIGIN ? origin : `${host}:${PORTS.auth}`,
  traceUrl: ONE_ORIGIN ? `${origin}/trace` : `${host}:${PORTS.trace}`,
  /** Where services send spans: the trace service itself, since spans are service-to-service traffic. */
  traceSink: `http://127.0.0.1:${PORTS.trace}`,
  s3: { endpoint: `http://127.0.0.1:${process.env.S3_PORT ?? 4610}`, accessKey: "demo-s3", secretKey: "demo-s3-secret" },
  archive: { dir: process.env.ARCHIVE_DIR ?? `${STORAGE}/archive`, bucket: "smart-imaging-archive" },
  orthanc: { base: `http://127.0.0.1:${process.env.ORTHANC_PORT ?? 4611}`, user: "demo-proxy", password: "demo-orthanc-secret" },
};

/**
 * Where this machine's own processes send a request for a URL it issued: the one origin's public
 * name goes straight to its local port, rather than out through the host in front of it and back.
 */
export function localUrl(url: string): string {
  return ONE_ORIGIN && url.startsWith(origin) && (url.length === origin.length || url[origin.length] === "/") ? `http://127.0.0.1:${PORTS.gateway}${url.slice(origin.length)}` : url;
}
/** The origin people and apps use, for the one origin's own checks. */
export const PUBLIC_ORIGIN = origin;

