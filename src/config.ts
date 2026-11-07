// DEMO_PORT_OFFSET lets a second copy of the stack run beside the first. MinIO and Orthanc are shared.
const offset = Number(process.env.DEMO_PORT_OFFSET ?? 0);
export const PORTS = { demo: 4600 + offset, proxy: 4601 + offset, imaging: 4602 + offset, auth: 4603 + offset, trace: 4604 + offset };

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
/** The address every service listens on. MinIO and Orthanc stay on loopback: only the proxy reaches them. */
export const LISTEN_HOSTS = ["127.0.0.1", ...(TAILNET ? [TAILNET.ip] : [])];
/** What a client sees of a failed request. The details go to the server's log. */
const serverError = (err: Error) => { console.error(err); return new Response("Internal Server Error", { status: 500, headers: { "content-type": "text/plain" } }); };
export const serveOn = (port: number, options: Omit<Parameters<typeof Bun.serve>[0], "port" | "hostname">) =>
  LISTEN_HOSTS.map(hostname => Bun.serve({
    ...options, port, hostname, development: false, error: serverError,
    fetch(req: Request, server: unknown) {
      // With no Host header, Bun gives a relative URL, and the services read absolute ones.
      const url = new URL(req.url, `http://${hostname}:${port}`);
      if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
      return (options as any).fetch(/^https?:/.test(req.url) ? req : new Request(url, req), server);
    },
  } as any));
export const CONFIG = {
  demoUrl: `${host}:${PORTS.demo}`,
  proxyUrl: `${host}:${PORTS.proxy}`,
  imagingUrl: `${host}:${PORTS.imaging}`,
  authUrl: `${host}:${PORTS.auth}`,
  traceUrl: `${host}:${PORTS.trace}`,
  minio: { endpoint: "http://127.0.0.1:4610", accessKey: "demo-minio", secretKey: "demo-minio-secret" },
  archive: { dir: process.env.ARCHIVE_DIR ?? "/tmp/smart-imaging-demo/archive", bucket: "smart-imaging-archive" },
  orthanc: { base: "http://127.0.0.1:4611", user: "demo-proxy", password: "demo-orthanc-secret" },
};
