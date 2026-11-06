// Starts the Authorization Server, Imaging Server and proxy as separate HTTP services.
// They talk only over HTTP. The proxy is given a public key and nothing from the others.
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { S3Client } from "bun";
import { createAuthServer } from "./auth-server";
import { createImagingServer } from "./imaging-server";
import { createProxy } from "./proxy";
import { ArchiveBackend } from "./backends/archive";
import { fileStore, s3Store } from "./archive/sources";
import { withTruncation } from "./backends/truncation";
import { OrthancBackend } from "./backends/orthanc";
import type { Backend } from "./backends/types";
import { CONFIG, PORTS, serveOn } from "./config";
import { setTraceSink, tfetch } from "./trace";
import { createCollector } from "./trace-collector";
import type { TraceStoreConfig } from "./trace-store";
import { createStores, type StoreConfig, type StoreName } from "./policy-store";
import { clockOffset, resetClock, setClockOffset } from "./clock";

export type BackendName = "static-files" | "minio" | "orthanc";

/** With no store config, the saved store is in memory: only src/main.ts reads the POLICY_* settings. */
export async function startStack(root: string, opts: { store?: StoreConfig; traces?: TraceStoreConfig; purgeIntervalMs?: number } = {}) {
  const stores = createStores(opts.store ?? { mode: "memory" });
  const manifest = await Bun.file(join(root, "data/manifest.json")).json();
  const serviceSecret = randomBytes(24).toString("base64url");
  const collector = createCollector(root, opts.traces);
  setTraceSink(CONFIG.traceUrl);

  const policyApi = (name: string, path: string, method = "GET", body?: unknown) => tfetch("authorization-server", name, `${CONFIG.imagingUrl}${path}`, { method, headers: { Authorization: `Bearer ${serviceSecret}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const auth = createAuthServer({
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
  const introspect = async (token: string) => {
    const r = await tfetch("imaging-fhir", "introspect the token", `${CONFIG.authUrl}/introspect`, { method: "POST", headers: { Authorization: `Bearer ${serviceSecret}`, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }) });
    return r.ok ? r.json() : { active: false };
  };
  const imaging = createImagingServer({ base: `${CONFIG.imagingUrl}/fhir`, clinicalFhirBase: `${CONFIG.authUrl}/fhir`, proxyBase: () => CONFIG.proxyUrl, introspect, serviceSecret, manifest, keyStore: stores.saved, store: () => stores.active });

  let truncateAfter: number | undefined;
  const wrap = (b: Backend) => withTruncation(b, () => truncateAfter);
  const backends: Record<BackendName, Backend> = {
    "static-files": wrap(new ArchiveBackend(fileStore(CONFIG.archive.dir))),
    minio: wrap(new ArchiveBackend(s3Store(new S3Client({ endpoint: CONFIG.minio.endpoint, accessKeyId: CONFIG.minio.accessKey, secretAccessKey: CONFIG.minio.secretKey, bucket: CONFIG.archive.bucket })))),
    orthanc: wrap(new OrthancBackend(CONFIG.orthanc)),
  };
  let current: BackendName = "static-files";

  const proxy = createProxy({ publicBase: () => CONFIG.proxyUrl, keys: imaging.publicKeys, decisionUrl: `${CONFIG.imagingUrl}/access/v1/evaluation`, serviceSecret, backend: () => backends[current] });

  const servers = [
    ...serveOn(PORTS.trace, { fetch: collector.fetch, idleTimeout: 0 }),
    ...serveOn(PORTS.auth, { fetch: auth.fetch, idleTimeout: 120 }),
    ...serveOn(PORTS.imaging, { fetch: imaging.fetch, idleTimeout: 120 }),
    ...serveOn(PORTS.proxy, { fetch: proxy.fetch, idleTimeout: 240 }),
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
    stop() { clearInterval(purgeTimer); servers.forEach(s => s.stop(true)); stores.close(); collector.close(); },
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
