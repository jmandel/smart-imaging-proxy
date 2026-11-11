// Starts the Authorization Server, Imaging Server and proxy as separate HTTP services in one process,
// for the root sandbox and every sandbox. They talk only over HTTP, so src/roles.ts can run the root's in
// separate processes. Each service's listener sends `/s/{sandbox}/...` to that sandbox's own instance of
// the same service, with the prefix taken off, and everything else to the root's.
import { dirname, join } from "node:path";
import { generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import { S3Client } from "bun";
import { ArchiveBackend, catalogFromOrthanc, createCatalog, fileStore, orthancCatalogPath, OrthancBackend, rebuildFromArchive, s3Store, seedPatientLinks, type Backend, type CatalogStore, type StoreConfig } from "@smart-imaging-proxy/core";
import { DEMO_BACKEND_CLIENTS } from "./auth-server";
import { ACCESSION_SYSTEM, CONFIG, GATEWAY_HOSTS, ONE_ORIGIN, PORTS, serveOn, serveStreamingOn } from "./config";
import { gatewayFetch } from "./gateway";
import { withCors } from "./cors";
import { inSandbox, setTraceSink, traceObserver } from "./trace";
import { createCollector } from "./trace-collector";
import type { TraceStoreConfig } from "./trace-store";
import { openRootStore } from "./stores";
import { demoClock } from "./clock";
import { createSandbox, type BackendName, type Shared, type Sandbox } from "./sandbox";
import { createSandboxes, splitSandbox, type Sandboxes } from "./sandboxes";

export type { BackendName } from "./sandbox";

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
 * A listener for one service across sandboxes: `serviceOf(sandbox)` answers for the sandbox the path names,
 * with the prefix taken off, and in that sandbox's trace context. No sandbox ever answers for another.
 */
export function sandboxHandler(root: Sandbox, sandboxes: Sandboxes, serviceOf: (w: Sandbox) => (req: Request) => Promise<Response> | Response) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const { sandbox, rest, nested } = splitSandbox(url.pathname);
    if (!sandbox) return serviceOf(root)(req);
    if (nested) return notFound("a sandbox can't hold another sandbox");
    const found = sandboxes.resolve(sandbox);
    if (!("sandbox" in found)) return notFound(found.error, found.status);
    // Set as a path, never reparsed as a URL, so a rest of `//host/...` stays a path on this origin.
    const u = new URL(url);
    u.pathname = rest;
    const inner = new Request(u, req);
    return inSandbox(sandbox, () => serviceOf(found.sandbox)(inner));
  };
}

/**
 * With no store config, the root's store is in memory, and with no catalog path, so are the catalogs:
 * only src/main.ts reads the POLICY_* and CATALOG_DB settings.
 */
export async function startStack(root: string, opts: { store?: StoreConfig; traces?: TraceStoreConfig; purgeIntervalMs?: number; catalog?: string; sandboxes?: { idleMs?: number; max?: number } } = {}) {
  const store = openRootStore(opts.store);
  const catalogs = await openCatalogs(root, opts.catalog);
  // Only the services send spans: the one origin doesn't forward the route, and it takes this credential.
  const spanSecret = randomBytes(24).toString("base64url");
  const collector = createCollector(root, opts.traces, spanSecret);
  setTraceSink(CONFIG.traceSink, spanSecret);

  const backends: Record<BackendName, Backend> = { "static-files": buildBackend("static-files"), s3: buildBackend("s3"), orthanc: buildBackend("orthanc") };
  const catalogFor = (b: BackendName): CatalogStore => b === "orthanc" ? catalogs.orthanc : catalogs.archive;
  const clientKeys = new Map<string, KeyObject>(DEMO_BACKEND_CLIENTS.map(id => [id, generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey]));
  // A new sandbox starts on the root's backend, and then picks its own.
  let rootSandbox!: Sandbox;
  const shared: Shared = { catalogs, backends, clientKeys, initialBackend: () => (rootSandbox as Sandbox | undefined)?.backend ?? "static-files" };
  rootSandbox = createSandbox({ store, clock: demoClock, shared });
  const sandboxes = createSandboxes(shared, { ...(opts.store?.mode === "file" ? { sandboxesDir: join(dirname(opts.store.path!), "sandboxes") } : {}), ...opts.sandboxes });
  const route = (serviceOf: (w: Sandbox) => (req: Request) => Promise<Response> | Response) => sandboxHandler(rootSandbox, sandboxes, serviceOf);

  const servers = [
    ...serveOn(PORTS.trace, { fetch: route(w => req => collector.fetch(req, w.id)), idleTimeout: 0 }),
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

  /** Each sandbox's tokens expire by its own clock. */
  const purgeTokens = () => [rootSandbox, ...sandboxes.sandboxes()].reduce((n, w) => n + w.purgeTokens(), 0);
  purgeTokens();
  const purgeTimer = setInterval(purgeTokens, opts.purgeIntervalMs ?? 60000);
  purgeTimer.unref();

  return {
    /** The root sandbox, which holds the one real policy database. */
    root: rootSandbox, sandboxes, store, backends, collector, catalogs, clientKeys,
    /** The collector's credential for spans, which only the services hold. */
    spanSecret,
    auth: rootSandbox.auth, imaging: rootSandbox.imaging, proxy: rootSandbox.proxy, policy: rootSandbox.policy,
    /** The listener a sandbox-aware service port uses, for the demo's own pages. */
    route,
    shared,
    /** The root's catalog in use. Its `allStudies` is for the demo's displays and tests. */
    get catalog() { return rootSandbox.catalog; },
    get catalogSource() { return rootSandbox.catalogSource; },
    /** The root's backend. Each sandbox has its own. */
    get backend() { return rootSandbox.backend; },
    setBackend(n: BackendName) { rootSandbox.setBackend(n); },
    setTruncateAfter: rootSandbox.setTruncateAfter,
    selfTest,
    stop() { clearInterval(purgeTimer); servers.forEach(s => s.stop(true)); proxyServer.stop(); gatewayServer?.stop(); sandboxes.close(); store.close(); collector.close(); catalogs.archive.close(); catalogs.orthanc.close(); },
    rotateSigningKey: rootSandbox.rotateSigningKey,
    explain: rootSandbox.explain,
    purgeTokens,
    /** Resets the root's policy to the guardians on file. Its tokens and signing key stay. */
    async resetSaved() { await rootSandbox.policy.reset(); },
    /** Clears the root's in-memory state: sign-ins in progress, decisions, and the proxy's cache and log. */
    clearRuntime: rootSandbox.clearRuntime,
    /** The root as it starts: the guardians on file, no tokens, the clock at zero, nothing in memory. The signing key stays. */
    async resetAll() { await rootSandbox.policy.reset({ tokens: true }); demoClock.reset(); rootSandbox.clearRuntime(); },
  };
}
export type Stack = Awaited<ReturnType<typeof startStack>>;
