// Starts the Authorization Server, Imaging Server and proxy as separate HTTP services in one
// process. They talk only over HTTP, so src/roles.ts can run the same services in separate processes.
// The proxy fetches the Imaging Server's public keys, and is given nothing else from the others.
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { S3Client } from "bun";
import {
  ArchiveBackend, catalogFromOrthanc, createCatalog, createImagingServer, createPolicyClient, createProxy, fileStore, orthancCatalogPath, OrthancBackend,
  rebuildFromArchive, s3Store, seedPatientLinks, withTruncation, type Backend, type CatalogStore, type PolicyOperation, type StoreConfig,
} from "@smart-imaging-proxy/core";
import { createAuthServer, USERS } from "./auth-server";
import { ACCESSION_SYSTEM, CONFIG, GATEWAY_HOSTS, ONE_ORIGIN, PORTS, serveOn, serveStreamingOn } from "./config";
import { gatewayFetch } from "./gateway";
import { withCors } from "./cors";
import { setTraceSink, tfetch, traceObserver, type Service } from "./trace";
import { createCollector } from "./trace-collector";
import type { TraceStoreConfig } from "./trace-store";
import { createStores, type Stores, type StoreName } from "./stores";
import { clockOffset, demoClock, resetClock, setClockOffset } from "./clock";

export type BackendName = "static-files" | "s3" | "orthanc";

/** The archive's catalog and Orthanc's. Each is derived, so an empty one is built from its source. */
export async function openCatalogs(root: string, path = ":memory:") {
  const catalogs = { archive: createCatalog(path, { accessionSystem: ACCESSION_SYSTEM }), orthanc: createCatalog(orthancCatalogPath(path), { accessionSystem: ACCESSION_SYSTEM }) };
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
  if (name === "s3") return new ArchiveBackend(s3Store(new S3Client({ endpoint: CONFIG.s3.endpoint, accessKeyId: CONFIG.s3.accessKey, secretAccessKey: CONFIG.s3.secretKey, bucket: CONFIG.archive.bucket })));
  return new OrthancBackend(CONFIG.orthanc, { observer: traceObserver });
}

/** How each policy API call reads in the trace. */
const POLICY_CALLS: Record<PolicyOperation, string> = {
  relationships: "look up who is related to whom",
  access: "look up the user's access",
  explain: "the demo asks for the Imaging Server's view",
  delegate: "record the delegation at the Imaging Server",
  "remove-delegations": "revoke the delegation at the Imaging Server",
  "grant-app": "record the app authorization at the Imaging Server",
  "remove-app-grants": "revoke the app authorization at the Imaging Server",
  "get-policy": "read policy at the Imaging Server",
  "set-policy": "set policy at the Imaging Server",
  "set-guardians": "set the guardians on file at the Imaging Server",
  "set-rules": "set the rules at the Imaging Server",
  "update-rule": "change a rule at the Imaging Server",
  "get-settings": "read the settings at the Imaging Server",
  "set-settings": "change the settings at the Imaging Server",
  reset: "reset policy at the Imaging Server",
  info: "read the policy store's state at the Imaging Server",
};
/**
 * The Imaging Server's policy API, called with the policy credential on its own loopback port: the
 * one origin doesn't forward the API. Traced as `service`.
 */
export const policyClient = (policySecret: string, service: Service = "demo") =>
  createPolicyClient({ base: `http://127.0.0.1:${PORTS.imaging}`, policySecret, fetch: (op, url, init) => tfetch(service, POLICY_CALLS[op], url, init) });

/** The Authorization Server. Its directory of who may see what is the Imaging Server, over HTTP. */
export function buildAuthServer(stores: Stores, serviceSecret: string, policySecret: string) {
  const policy = policyClient(policySecret, "authorization-server");
  return createAuthServer({
    issuer: CONFIG.authUrl, imagingFhirBase: `${CONFIG.imagingUrl}/fhir`, serviceSecret, redirectUri: `${CONFIG.demoUrl}/oauth/callback`,
    store: () => stores.active, storeLabel: () => stores.activeLabel,
    directory: {
      relationships: () => policy.relationships(),
      access: (user, fhirUser) => policy.access(user, fhirUser),
      recordConsent: async c => { await policy.grantApp(c); },
      delegate: async d => { await policy.delegate(d); },
      revokeDelegation: async (grantedBy, delegate, patient) => { if (delegate) await policy.removeDelegations({ grantedBy, delegate, patient }); },
      revokeApp: async (client, user, patient) => { if (client) await policy.removeAppGrants({ client, user, patient }); },
    },
  });
}

/** The Imaging Server. It checks tokens at the Authorization Server, over HTTP. */
export function buildImagingServer(stores: Stores, serviceSecret: string, policySecret: string, catalog: () => CatalogStore) {
  const introspect = async (token: string) => {
    const r = await tfetch("imaging-fhir", "introspect the token", `${CONFIG.authUrl}/introspect`, { method: "POST", headers: { Authorization: `Bearer ${serviceSecret}`, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }) });
    return r.ok ? r.json() : { active: false };
  };
  return createImagingServer({ base: `${CONFIG.imagingUrl}/fhir`, clinicalFhirBase: `${CONFIG.authUrl}/fhir`, proxyBase: () => CONFIG.proxyUrl, introspect, patientOf: user => USERS[user]?.patient, serviceSecret, policySecret, catalog, keyStore: stores.saved, store: () => stores.active, namedStore: name => stores.named(name), observer: traceObserver, clock: demoClock });
}

/** All a proxy gets from the other services: where its keys and its decisions are, and the demo's tracing and clock. */
export const proxyLinks = { publicBase: () => CONFIG.proxyUrl, jwksUrl: `${CONFIG.imagingUrl}/.well-known/jwks.json`, decisionUrl: `${CONFIG.imagingUrl}/access/v1/evaluation`, observer: traceObserver, clock: demoClock };

/**
 * With no store config, the saved store is in memory, and with no catalog path, so are the catalogs:
 * only src/main.ts reads the POLICY_* and CATALOG_DB settings.
 */
export async function startStack(root: string, opts: { store?: StoreConfig; traces?: TraceStoreConfig; purgeIntervalMs?: number; catalog?: string } = {}) {
  const stores = createStores(opts.store ?? { mode: "memory" });
  const catalogs = await openCatalogs(root, opts.catalog);
  const serviceSecret = randomBytes(24).toString("base64url");
  // Only the Authorization Server and the demo hold this one. The proxy never does.
  const policySecret = randomBytes(24).toString("base64url");
  const collector = createCollector(root, opts.traces);
  setTraceSink(CONFIG.traceSink);

  const auth = buildAuthServer(stores, serviceSecret, policySecret);
  const policy = policyClient(policySecret);
  const imaging = buildImagingServer(stores, serviceSecret, policySecret, () => catalogFor(current));

  let truncateAfter: number | undefined;
  const wrap = (b: Backend) => withTruncation(b, () => truncateAfter);
  const backends: Record<BackendName, Backend> = {
    "static-files": wrap(buildBackend("static-files")),
    s3: wrap(buildBackend("s3")),
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
  const proxyServer = await serveStreamingOn(PORTS.proxy, withCors(proxy.fetch));
  // The streaming server, so the proxy's exact Content-Length reaches the client.
  const gatewayServer = ONE_ORIGIN ? await serveStreamingOn(PORTS.gateway, gatewayFetch, GATEWAY_HOSTS) : undefined;

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
    /** The policy API, on the store in use. `policy.withStore("saved")` names one. */
    policy,
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
      const told = await tfetch("demo", "tell the proxy to refetch signing keys", `http://127.0.0.1:${PORTS.proxy}/internal/keys/refresh`, { method: "POST", headers: { Authorization: `Bearer ${serviceSecret}` } }).then(r => r.ok, () => false);
      return { kid, proxyTold: told };
    },
    /** The Imaging Server's view of why a study is or isn't released, asked with the service credential. */
    explain(q: { client: string; user?: string; fhirUser?: string; patient: string }) {
      return policy.explain(Object.fromEntries(Object.entries(q).filter(e => !!e[1])) as typeof q);
    },
    useStore,
    purgeTokens,
    /** Resets the scratch store. The saved store isn't touched, and the active store doesn't change. */
    async resetScratch() {
      await policy.withStore("scratch").reset({ tokens: true });
      offsets.scratch = 0;
      if (stores.activeName === "scratch") { resetClock(); clearRuntime(); }
    },
    /** Resets saved policy to the guardians on file. Saved tokens and the signing key stay. */
    async resetSaved() { await policy.withStore("saved").reset(); },
    /** Where every flow starts: the scratch store, holding only the guardians on file, with the clock at zero. */
    async resetAll() { useStore("scratch"); await policy.withStore("scratch").reset({ tokens: true }); resetClock(); clearRuntime(); },
  };
}
export type Stack = Awaited<ReturnType<typeof startStack>>;
