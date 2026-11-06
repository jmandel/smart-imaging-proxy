// Starts the Authorization Server, Imaging Server and proxy as separate HTTP services in one
// process. They talk only over HTTP, so src/roles.ts can run the same services in separate processes.
// The proxy fetches the Imaging Server's public keys, and is given nothing else from the others.
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { S3Client } from "bun";
import { createAuthServer } from "./auth-server";
import { createImagingServer } from "./imaging-server";
import { createProxy } from "./proxy";
import { fileSource, s3Source, StoreBackend, withTruncation } from "./backends/store";
import { OrthancBackend } from "./backends/orthanc";
import type { Backend } from "./backends/types";
import { CONFIG, PORTS, serveOn } from "./config";
import { setTraceSink, tfetch } from "./trace";
import { createCollector } from "./trace-collector";
import type { TraceStoreConfig } from "./trace-store";
import { createStores, type Stores, type StoreConfig, type StoreName } from "./policy-store";
import { clockOffset, resetClock, setClockOffset } from "./clock";
import { serveStreaming } from "./serve-streaming";

export type BackendName = "static-files" | "minio" | "orthanc";

export const readManifest = (root: string) => Bun.file(join(root, "data/manifest.json")).json();

export function buildBackend(root: string, manifest: any, name: BackendName): Backend {
  if (name === "static-files") return new StoreBackend(manifest, fileSource(join(root, "data/studies")));
  if (name === "minio") return new StoreBackend(manifest, s3Source(new S3Client({ endpoint: CONFIG.minio.endpoint, accessKeyId: CONFIG.minio.accessKey, secretAccessKey: CONFIG.minio.secretKey, bucket: CONFIG.minio.bucket })));
  return new OrthancBackend(CONFIG.orthanc);
}

/** The Authorization Server. Its directory of who may see what is the Imaging Server, over HTTP. */
export function buildAuthServer(stores: Stores, serviceSecret: string) {
  const policyApi = (name: string, path: string, method = "GET", body?: unknown) => tfetch("authorization-server", name, `${CONFIG.imagingUrl}${path}`, { method, headers: { Authorization: `Bearer ${serviceSecret}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return createAuthServer({
    issuer: CONFIG.authUrl, imagingFhirBase: `${CONFIG.imagingUrl}/fhir`, serviceSecret, redirectUri: `${CONFIG.demoUrl}/oauth/callback`,
    store: () => stores.active, storeLabel: () => stores.activeLabel,
    directory: {
      relationships: async () => (await policyApi("look up who is related to whom", "/internal/relationships")).json() as any,
      access: async (user, fhirUser) => (await policyApi("look up the user's access", `/internal/access?user=${encodeURIComponent(user)}&fhirUser=${encodeURIComponent(fhirUser)}`)).json() as any,
      recordConsent: async c => { await policyApi("record the app authorization at the Imaging Server", "/internal/consents", "POST", c); },
      delegate: async d => { await policyApi("record the delegation at the Imaging Server", "/internal/delegations", "POST", d); },
      revokeDelegation: async (grantedBy, delegate) => { await policyApi("revoke the delegation at the Imaging Server", `/internal/delegations?grantedBy=${encodeURIComponent(grantedBy)}&delegate=${encodeURIComponent(delegate)}`, "DELETE"); },
      revokeApp: async (client, user) => { await policyApi("revoke the app authorization at the Imaging Server", `/internal/consents?client=${encodeURIComponent(client)}&user=${encodeURIComponent(user)}`, "DELETE"); },
    },
  });
}

/** The Imaging Server. It checks tokens at the Authorization Server, over HTTP. */
export function buildImagingServer(stores: Stores, serviceSecret: string, manifest: any) {
  const introspect = async (token: string) => {
    const r = await tfetch("imaging-fhir", "introspect the token", `${CONFIG.authUrl}/introspect`, { method: "POST", headers: { Authorization: `Bearer ${serviceSecret}`, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }) });
    return r.ok ? r.json() : { active: false };
  };
  return createImagingServer({ base: `${CONFIG.imagingUrl}/fhir`, clinicalFhirBase: `${CONFIG.authUrl}/fhir`, proxyBase: () => CONFIG.proxyUrl, introspect, serviceSecret, manifest, keyStore: stores.saved, store: () => stores.active });
}

/** All a proxy gets from the other services: where its keys and its decisions are. */
export const proxyLinks = { publicBase: () => CONFIG.proxyUrl, jwksUrl: `${CONFIG.imagingUrl}/.well-known/jwks.json`, decisionUrl: `${CONFIG.imagingUrl}/access/v1/evaluation` };

/** With no store config, the saved store is in memory: only src/main.ts reads the POLICY_* settings. */
export async function startStack(root: string, opts: { store?: StoreConfig; traces?: TraceStoreConfig; purgeIntervalMs?: number } = {}) {
  const stores = createStores(opts.store ?? { mode: "memory" });
  const manifest = await readManifest(root);
  const serviceSecret = randomBytes(24).toString("base64url");
  const collector = createCollector(root, opts.traces);
  setTraceSink(CONFIG.traceUrl);

  const auth = buildAuthServer(stores, serviceSecret);
  const imaging = buildImagingServer(stores, serviceSecret, manifest);

  let truncateAfter: number | undefined;
  const wrap = (b: Backend) => withTruncation(b, () => truncateAfter);
  const backends: Record<BackendName, Backend> = {
    "static-files": wrap(buildBackend(root, manifest, "static-files")),
    minio: wrap(buildBackend(root, manifest, "minio")),
    orthanc: wrap(buildBackend(root, manifest, "orthanc")),
  };
  let current: BackendName = "static-files";

  const proxy = createProxy({ ...proxyLinks, serviceSecret, backend: () => backends[current] });

  const servers = [
    ...serveOn(PORTS.trace, { fetch: collector.fetch, idleTimeout: 0 }),
    ...serveOn(PORTS.auth, { fetch: auth.fetch, idleTimeout: 120 }),
    ...serveOn(PORTS.imaging, { fetch: imaging.fetch, idleTimeout: 120 }),
  ];
  const proxyServer = await serveStreaming(PORTS.proxy, proxy.fetch);

  /** Checks a backend works and reports what it declares. */
  async function selfTest(name: BackendName) {
    const b = backends[name];
    const study = manifest.studies.find((s: any) => s.id === "xr-wrist-left-2012").uid;
    try {
      const series = await b.listSeries(study);
      return { name, ok: series.length > 0, capabilities: b.capabilities(), detail: `${series.length} series in the fixture study` };
    } catch (e) { return { name, ok: false, capabilities: b.capabilities(), detail: String(e) }; }
  }

  // In-memory state that belongs to one store's world, cleared when moving between them or resetting.
  const clearRuntime = () => { auth.reset(); imaging.reset(); proxy.reset(); truncateAfter = undefined; };
  // A flow moves the demo clock, so each store keeps its own offset.
  const offsets: Record<StoreName, number> = { saved: 0, scratch: 0 };
  function useStore(name: StoreName) {
    if (name === stores.activeName) return;
    offsets[stores.activeName] = clockOffset();
    stores.activate(name);
    setClockOffset(offsets[name]);
    clearRuntime();
  }

  /** Each store's tokens expire by that store's own demo clock. */
  function purgeTokens() {
    const offsetOf = (name: StoreName) => name === stores.activeName ? clockOffset() : offsets[name];
    const real = Math.floor(Date.now() / 1000);
    return stores.saved.purgeExpiredTokens(real + offsetOf("saved")) + stores.scratch.purgeExpiredTokens(real + offsetOf("scratch"));
  }
  purgeTokens();
  const purgeTimer = setInterval(purgeTokens, opts.purgeIntervalMs ?? 60000);
  purgeTimer.unref();

  return {
    auth, imaging, proxy, backends, manifest, collector, stores,
    get backend() { return current; },
    setBackend(n: BackendName) { current = n; },
    setTruncateAfter(n: number | undefined) { truncateAfter = n; },
    selfTest,
    stop() { clearInterval(purgeTimer); servers.forEach(s => s.stop(true)); proxyServer.stop(); stores.close(); collector.close(); },
    /** Replaces the signing key, then tells the proxy over HTTP, so it stops trusting the old one now. A proxy that isn't told learns within its TTL. */
    async rotateSigningKey() {
      const kid = imaging.rotateSigningKey();
      const told = await tfetch("demo", "tell the proxy to refetch signing keys", `${CONFIG.proxyUrl}/internal/keys/refresh`, { method: "POST", headers: { Authorization: `Bearer ${serviceSecret}` } }).then(r => r.ok, () => false);
      return { kid, proxyTold: told };
    },
    useStore,
    purgeTokens,
    /** Empties the scratch store. The saved store isn't touched, and the active store doesn't change. */
    resetScratch() {
      stores.scratch.resetAll();
      offsets.scratch = 0;
      if (stores.activeName === "scratch") { resetClock(); clearRuntime(); }
    },
    /** Clears saved policy. Saved tokens and the signing key stay. */
    resetSaved() { stores.saved.resetPolicy(); },
    /** Where every flow starts: the scratch store, empty, with the clock at zero. */
    resetAll() { useStore("scratch"); stores.scratch.resetAll(); resetClock(); clearRuntime(); },
  };
}
export type Stack = Awaited<ReturnType<typeof startStack>>;
