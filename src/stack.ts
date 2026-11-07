// Starts the Authorization Server, Imaging Server and proxy as separate HTTP services in one
// process. They talk only over HTTP, so src/roles.ts can run the same services in separate processes.
// The proxy fetches the Imaging Server's public keys, and is given nothing else from the others.
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { S3Client } from "bun";
import { createAuthServer, USERS } from "./auth-server";
import { createImagingServer } from "./imaging-server";
import { createProxy } from "./proxy";
import { ArchiveBackend } from "./backends/archive";
import { fileStore, s3Store } from "./archive/sources";
import { withTruncation } from "./backends/truncation";
import { OrthancBackend } from "./backends/orthanc";
import type { Backend } from "./backends/types";
import { CONFIG, ONE_ORIGIN, PORTS, serveOn } from "./config";
import { gatewayFetch } from "./gateway";
import { withCors } from "./cors";
import { setTraceSink, tfetch } from "./trace";
import { createCollector } from "./trace-collector";
import type { TraceStoreConfig } from "./trace-store";
import { createStores, type Stores, type StoreConfig, type StoreName } from "./policy-store";
import { clockOffset, resetClock, setClockOffset } from "./clock";
import type { CatalogStore } from "./archive/types";
import { createCatalog, orthancCatalogPath, seedPatientLinks } from "./catalog";
import { rebuildFromArchive } from "./catalog-archive";
import { catalogFromOrthanc } from "./catalog-orthanc";
import { serveStreaming } from "./serve-streaming";

export type BackendName = "static-files" | "minio" | "orthanc";

/** The archive's catalog and Orthanc's. Each is derived, so an empty one is built from its source. */
export async function openCatalogs(root: string, path = ":memory:") {
  const catalogs = { archive: createCatalog(path), orthanc: createCatalog(orthancCatalogPath(path)) };
  const patients = await Bun.file(join(root, "data/patient.json")).json();
  seedPatientLinks(catalogs.archive, patients);
  seedPatientLinks(catalogs.orthanc, patients);
  if (catalogs.archive.stats().studies === 0) {
    const report = await rebuildFromArchive(fileStore(CONFIG.archive.dir), catalogs.archive);
    for (const u of report.unlinked) console.warn(`Skipped study ${u.study}: Patient ID ${u.sourcePatientId ?? "(none)"} isn't linked to a patient`);
  }
  // Fronting Orthanc needs only its query API. If it's down, its catalog stays empty until the next start.
  if (catalogs.orthanc.stats().studies === 0) {
    try { await catalogFromOrthanc(catalogs.orthanc, CONFIG.orthanc, await Bun.file(join(root, "data/orthanc-catalog.json")).json()); }
    catch (e) { console.warn(`The Orthanc catalog wasn't built: ${String(e)}`); }
  }
  return catalogs;
}

export function buildBackend(name: BackendName): Backend {
  if (name === "static-files") return new ArchiveBackend(fileStore(CONFIG.archive.dir));
  if (name === "minio") return new ArchiveBackend(s3Store(new S3Client({ endpoint: CONFIG.minio.endpoint, accessKeyId: CONFIG.minio.accessKey, secretAccessKey: CONFIG.minio.secretKey, bucket: CONFIG.archive.bucket })));
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
      revokeDelegation: async (grantedBy, delegate, patient) => { await policyApi("revoke the delegation at the Imaging Server", `/internal/delegations?${new URLSearchParams({ grantedBy, delegate, ...(patient ? { patient } : {}) })}`, "DELETE"); },
      revokeApp: async (client, user, patient) => { await policyApi("revoke the app authorization at the Imaging Server", `/internal/consents?${new URLSearchParams({ client, user, ...(patient ? { patient } : {}) })}`, "DELETE"); },
    },
  });
}

/** The Imaging Server. It checks tokens at the Authorization Server, over HTTP. */
export function buildImagingServer(stores: Stores, serviceSecret: string, catalog: () => CatalogStore) {
  const introspect = async (token: string) => {
    const r = await tfetch("imaging-fhir", "introspect the token", `${CONFIG.authUrl}/introspect`, { method: "POST", headers: { Authorization: `Bearer ${serviceSecret}`, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }) });
    return r.ok ? r.json() : { active: false };
  };
  return createImagingServer({ base: `${CONFIG.imagingUrl}/fhir`, clinicalFhirBase: `${CONFIG.authUrl}/fhir`, proxyBase: () => CONFIG.proxyUrl, introspect, patientOf: user => USERS[user]?.patient, serviceSecret, catalog, keyStore: stores.saved, store: () => stores.active });
}

/** All a proxy gets from the other services: where its keys and its decisions are. */
export const proxyLinks = { publicBase: () => CONFIG.proxyUrl, jwksUrl: `${CONFIG.imagingUrl}/.well-known/jwks.json`, decisionUrl: `${CONFIG.imagingUrl}/access/v1/evaluation` };

/**
 * With no store config, the saved store is in memory, and with no catalog path, so are the catalogs:
 * only src/main.ts reads the POLICY_* and CATALOG_DB settings.
 */
export async function startStack(root: string, opts: { store?: StoreConfig; traces?: TraceStoreConfig; purgeIntervalMs?: number; catalog?: string } = {}) {
  const stores = createStores(opts.store ?? { mode: "memory" });
  const catalogs = await openCatalogs(root, opts.catalog);
  const serviceSecret = randomBytes(24).toString("base64url");
  const collector = createCollector(root, opts.traces);
  setTraceSink(CONFIG.traceUrl);

  const auth = buildAuthServer(stores, serviceSecret);
  const imaging = buildImagingServer(stores, serviceSecret, () => catalogFor(current));

  let truncateAfter: number | undefined;
  const wrap = (b: Backend) => withTruncation(b, () => truncateAfter);
  const backends: Record<BackendName, Backend> = {
    "static-files": wrap(buildBackend("static-files")),
    minio: wrap(buildBackend("minio")),
    orthanc: wrap(buildBackend("orthanc")),
  };
  let current: BackendName = "static-files";
  /** Search and decisions read the catalog that describes what the selected backend holds. */
  function catalogFor(b: BackendName): CatalogStore { return b === "orthanc" ? catalogs.orthanc : catalogs.archive; }

  const proxy = createProxy({ ...proxyLinks, serviceSecret, backend: () => backends[current] });

  const servers = [
    ...serveOn(PORTS.trace, { fetch: collector.fetch, idleTimeout: 0 }),
    ...serveOn(PORTS.auth, { fetch: withCors(auth.fetch), idleTimeout: 120 }),
    ...serveOn(PORTS.imaging, { fetch: withCors(imaging.fetch), idleTimeout: 120 }),
  ];
  const proxyServer = await serveStreaming(PORTS.proxy, withCors(proxy.fetch));
  // The streaming server, so the proxy's exact Content-Length reaches the client.
  const gatewayServer = ONE_ORIGIN ? await serveStreaming(PORTS.gateway, gatewayFetch) : undefined;

  /** Checks a backend works and reports what it declares. */
  async function selfTest(name: BackendName) {
    const b = backends[name];
    const held = catalogFor(name).allStudies();
    const study = (held.find(s => s.id === "xr-wrist-left-2012") ?? held[0])?.uid;
    if (!study) return { name, ok: false, capabilities: b.capabilities(), detail: "no studies in this backend's catalog" };
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
    auth, imaging, proxy, backends, collector, stores, catalogs,
    /** The catalog in use. Its `allStudies` is for the demo's displays and tests. */
    get catalog() { return catalogFor(current); },
    get catalogSource() { return current === "orthanc" ? "orthanc" as const : "archive" as const; },
    get backend() { return current; },
    setBackend(n: BackendName) { current = n; },
    setTruncateAfter(n: number | undefined) { truncateAfter = n; },
    selfTest,
    stop() { clearInterval(purgeTimer); servers.forEach(s => s.stop(true)); proxyServer.stop(); gatewayServer?.stop(); stores.close(); collector.close(); catalogs.archive.close(); catalogs.orthanc.close(); },
    /** Replaces the signing key, then tells the proxy over HTTP, so it stops trusting the old one now. A proxy that isn't told learns within its TTL. */
    async rotateSigningKey() {
      const kid = imaging.rotateSigningKey();
      const told = await tfetch("demo", "tell the proxy to refetch signing keys", `${CONFIG.proxyUrl}/internal/keys/refresh`, { method: "POST", headers: { Authorization: `Bearer ${serviceSecret}` } }).then(r => r.ok, () => false);
      return { kid, proxyTold: told };
    },
    /** The Imaging Server's view of why a study is or isn't released, asked with the service credential. */
    async explain(q: { client: string; user?: string; fhirUser?: string; patient: string }) {
      const query = new URLSearchParams(Object.entries(q).filter((e): e is [string, string] => !!e[1]));
      const r = await tfetch("demo", "the demo asks for the Imaging Server's view", `${CONFIG.imagingUrl}/internal/explain?${query}`, { headers: { Authorization: `Bearer ${serviceSecret}` } });
      if (!r.ok) { await r.body?.cancel(); throw new Error(`the Imaging Server answered ${r.status}`); }
      return r.json() as Promise<any>;
    },
    useStore,
    purgeTokens,
    /** Resets the scratch store. The saved store isn't touched, and the active store doesn't change. */
    resetScratch() {
      stores.scratch.resetAll();
      offsets.scratch = 0;
      if (stores.activeName === "scratch") { resetClock(); clearRuntime(); }
    },
    /** Resets saved policy to the guardians on file. Saved tokens and the signing key stay. */
    resetSaved() { stores.saved.resetPolicy(); },
    /** Where every flow starts: the scratch store, holding only the guardians on file, with the clock at zero. */
    resetAll() { useStore("scratch"); stores.scratch.resetAll(); resetClock(); clearRuntime(); },
  };
}
export type Stack = Awaited<ReturnType<typeof startStack>>;
