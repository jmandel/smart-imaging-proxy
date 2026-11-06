// Starts the Authorization Server, Imaging Server and proxy as separate HTTP services.
// They talk only over HTTP. The proxy is given a public key and nothing from the others.
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { S3Client } from "bun";
import { createAuthServer } from "./auth-server";
import { createImagingServer } from "./imaging-server";
import { createProxy } from "./proxy";
import { fileSource, s3Source, StoreBackend, withTruncation } from "./backends/store";
import { OrthancBackend } from "./backends/orthanc";
import type { Backend } from "./backends/types";
import { CONFIG, PORTS } from "./config";
import { setTraceSink, tfetch } from "./trace";
import { createCollector } from "./trace-collector";

export type BackendName = "static-files" | "minio" | "orthanc";

export async function startStack(root: string) {
  const manifest = await Bun.file(join(root, "data/manifest.json")).json();
  const serviceSecret = randomBytes(24).toString("base64url");
  const collector = createCollector(root);
  setTraceSink(CONFIG.traceUrl);

  const auth = createAuthServer({ issuer: CONFIG.authUrl, imagingFhirBase: `${CONFIG.imagingUrl}/fhir`, serviceSecret });
  const introspect = async (token: string) => {
    const r = await tfetch("imaging-fhir", "introspect the token", `${CONFIG.authUrl}/introspect`, { method: "POST", headers: { Authorization: `Bearer ${serviceSecret}`, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }) });
    return r.ok ? r.json() : { active: false };
  };
  const imaging = createImagingServer({ base: `${CONFIG.imagingUrl}/fhir`, clinicalFhirBase: `${CONFIG.authUrl}/fhir`, proxyBase: () => CONFIG.proxyUrl, introspect, serviceSecret, manifest });

  let truncateAfter: number | undefined;
  const wrap = (b: Backend) => withTruncation(b, () => truncateAfter);
  const backends: Record<BackendName, Backend> = {
    "static-files": wrap(new StoreBackend(manifest, fileSource(join(root, "data/studies")))),
    minio: wrap(new StoreBackend(manifest, s3Source(new S3Client({ endpoint: CONFIG.minio.endpoint, accessKeyId: CONFIG.minio.accessKey, secretAccessKey: CONFIG.minio.secretKey, bucket: CONFIG.minio.bucket })))),
    orthanc: wrap(new OrthancBackend(CONFIG.orthanc)),
  };
  let current: BackendName = "static-files";

  const proxy = createProxy({ publicBase: () => CONFIG.proxyUrl, keys: imaging.publicKeys, decisionUrl: `${CONFIG.imagingUrl}/access/v1/evaluation`, serviceSecret, backend: () => backends[current] });

  const servers = [
    Bun.serve({ port: PORTS.trace, hostname: "127.0.0.1", fetch: collector.fetch, idleTimeout: 0 }),
    Bun.serve({ port: PORTS.auth, hostname: "127.0.0.1", fetch: auth.fetch, idleTimeout: 120 }),
    Bun.serve({ port: PORTS.imaging, hostname: "127.0.0.1", fetch: imaging.fetch, idleTimeout: 120 }),
    Bun.serve({ port: PORTS.proxy, hostname: "127.0.0.1", fetch: proxy.fetch, idleTimeout: 240 }),
  ];

  /** Checks a backend works and reports what it declares. */
  async function selfTest(name: BackendName) {
    const b = backends[name];
    const study = manifest.studies.find((s: any) => s.id === "xr-wrist-left-2012").uid;
    try {
      const series = await b.listSeries(study);
      return { name, ok: series.length > 0, capabilities: b.capabilities(), detail: `${series.length} series in the fixture study` };
    } catch (e) { return { name, ok: false, capabilities: b.capabilities(), detail: String(e) }; }
  }

  return {
    auth, imaging, proxy, backends, manifest, collector,
    get backend() { return current; },
    setBackend(n: BackendName) { current = n; },
    setTruncateAfter(n: number | undefined) { truncateAfter = n; },
    selfTest,
    stop() { servers.forEach(s => s.stop(true)); },
    resetAll() { auth.reset(); imaging.reset(); proxy.reset(); truncateAfter = undefined; },
  };
}
export type Stack = Awaited<ReturnType<typeof startStack>>;
