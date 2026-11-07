// Starts the Authorization Server, Imaging Server and proxy as separate HTTP services in one process,
// for the root world and every scope. They talk only over HTTP, so src/roles.ts can run the root's in
// separate processes. Each service's listener sends `/s/{scope}/...` to that scope's own instance of
// the same service, with the prefix taken off, and everything else to the root's.
import { join } from "node:path";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { S3Client } from "bun";
import { ArchiveBackend, catalogFromOrthanc, createCatalog, fileStore, orthancCatalogPath, OrthancBackend, rebuildFromArchive, s3Store, seedPatientLinks, type Backend, type CatalogStore, type StoreConfig } from "@smart-imaging-proxy/core";
import { DEMO_BACKEND_CLIENTS } from "./auth-server";
import { ACCESSION_SYSTEM, CONFIG, GATEWAY_HOSTS, ONE_ORIGIN, PORTS, serveOn, serveStreamingOn } from "./config";
import { gatewayFetch } from "./gateway";
import { withCors } from "./cors";
import { inScope, setTraceSink, traceObserver } from "./trace";
import { createCollector } from "./trace-collector";
import type { TraceStoreConfig } from "./trace-store";
import { openRootStore } from "./stores";
import { demoClock } from "./clock";
import { createWorld, type BackendName, type Shared, type World } from "./world";
import { createScopes, splitScope, type Scopes } from "./scopes";

export type { BackendName } from "./world";

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

const notFound = (error: string, status = 404) => Response.json({ error }, { status });
/**
 * A listener for one service across worlds: `serviceOf(world)` answers for the world the path names,
 * with the prefix taken off, and in that scope's trace context. No world ever answers for another.
 */
export function scopedHandler(root: World, scopes: Scopes, serviceOf: (w: World) => (req: Request) => Promise<Response> | Response) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const { scope, rest, nested } = splitScope(url.pathname);
    if (!scope) return serviceOf(root)(req);
    if (nested) return notFound("a scope can't hold another scope");
    const found = scopes.resolve(scope);
    if (!("world" in found)) return notFound(found.error, found.status);
    // Set as a path, never reparsed as a URL, so a rest of `//host/...` stays a path on this origin.
    const u = new URL(url);
    u.pathname = rest;
    const inner = new Request(u, req);
    return inScope(scope, () => serviceOf(found.world)(inner));
  };
}

/**
 * With no store config, the root's store is in memory, and with no catalog path, so are the catalogs:
 * only src/main.ts reads the POLICY_* and CATALOG_DB settings.
 */
export async function startStack(root: string, opts: { store?: StoreConfig; traces?: TraceStoreConfig; purgeIntervalMs?: number; catalog?: string; scopes?: { idleMs?: number; max?: number } } = {}) {
  const store = openRootStore(opts.store);
  const catalogs = await openCatalogs(root, opts.catalog);
  const collector = createCollector(root, opts.traces);
  setTraceSink(CONFIG.traceSink);

  const backends: Record<BackendName, Backend> = { "static-files": buildBackend("static-files"), s3: buildBackend("s3"), orthanc: buildBackend("orthanc") };
  const catalogFor = (b: BackendName): CatalogStore => b === "orthanc" ? catalogs.orthanc : catalogs.archive;
  const clientKeys = new Map<string, KeyObject>(DEMO_BACKEND_CLIENTS.map(id => [id, generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey]));
  // A new scope starts on the root's backend, and then picks its own.
  let rootWorld!: World;
  const shared: Shared = { catalogs, backends, clientKeys, initialBackend: () => (rootWorld as World | undefined)?.backend ?? "static-files" };
  rootWorld = createWorld({ store, clock: demoClock, shared });
  const scopes = createScopes(shared, opts.scopes);
  const route = (serviceOf: (w: World) => (req: Request) => Promise<Response> | Response) => scopedHandler(rootWorld, scopes, serviceOf);

  const servers = [
    ...serveOn(PORTS.trace, { fetch: route(w => req => collector.fetch(req, w.scope)), idleTimeout: 0 }),
    ...serveOn(PORTS.auth, { fetch: withCors(route(w => w.auth.fetch)), idleTimeout: 120 }),
    ...serveOn(PORTS.imaging, { fetch: withCors(route(w => w.imaging.fetch)), idleTimeout: 120 }),
  ];
  // The streaming server, so the proxy's exact Content-Length reaches the client.
  const proxyServer = await serveStreamingOn(PORTS.proxy, withCors(route(w => w.proxy.fetch)));
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

  /** Each world's tokens expire by its own clock. */
  const purgeTokens = () => [rootWorld, ...scopes.worlds()].reduce((n, w) => n + w.purgeTokens(), 0);
  purgeTokens();
  const purgeTimer = setInterval(purgeTokens, opts.purgeIntervalMs ?? 60000);
  purgeTimer.unref();

  return {
    /** The root world, which holds the one real policy database. */
    root: rootWorld, scopes, store, backends, collector, catalogs, clientKeys,
    auth: rootWorld.auth, imaging: rootWorld.imaging, proxy: rootWorld.proxy, policy: rootWorld.policy,
    /** The listener a scope-aware service port uses, for the demo's own pages. */
    route,
    /** The root's catalog in use. Its `allStudies` is for the demo's displays and tests. */
    get catalog() { return rootWorld.catalog; },
    get catalogSource() { return rootWorld.catalogSource; },
    /** The root's backend. Each scope has its own. */
    get backend() { return rootWorld.backend; },
    setBackend(n: BackendName) { rootWorld.setBackend(n); },
    setTruncateAfter: rootWorld.setTruncateAfter,
    selfTest,
    stop() { clearInterval(purgeTimer); servers.forEach(s => s.stop(true)); proxyServer.stop(); gatewayServer?.stop(); scopes.close(); store.close(); collector.close(); catalogs.archive.close(); catalogs.orthanc.close(); },
    rotateSigningKey: rootWorld.rotateSigningKey,
    explain: rootWorld.explain,
    purgeTokens,
    /** Resets the root's policy to the guardians on file. Its tokens and signing key stay. */
    async resetSaved() { await rootWorld.policy.reset(); },
    /** Clears the root's in-memory state: sign-ins in progress, decisions, and the proxy's cache and log. */
    clearRuntime: rootWorld.clearRuntime,
    /** The root as it starts: the guardians on file, no tokens, the clock at zero, nothing in memory. The signing key stays. */
    async resetAll() { await rootWorld.policy.reset({ tokens: true }); demoClock.reset(); rootWorld.clearRuntime(); },
  };
}
export type Stack = Awaited<ReturnType<typeof startStack>>;
