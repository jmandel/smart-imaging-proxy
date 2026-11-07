// Runs some of the root world's services in this process, for a deployment that splits them. They find
// each other through CONFIG, and act together only over HTTP. Scopes are the whole demo's, not a split one's.
import { createHash, randomBytes } from "node:crypto";
import { createCatalog, DEFAULT_JWKS_TTL_SECONDS, PolicyStore } from "@smart-imaging-proxy/core";
import { CONFIG, DEFAULT_CATALOG_DB, GATEWAY_HOSTS, ONE_ORIGIN, PORTS, serveOn, serveStreamingOn } from "./config";
import { DEMO_BACKEND_CLIENTS, derivedBackendClient } from "./auth-server";
import { openRootStore, storeConfigFromEnv } from "./stores";
import { buildBackend, openCatalogs, type BackendName } from "./stack";
import { createWorld } from "./world";
import { demoClock } from "./clock";
import { flushTraces, setTraceSink } from "./trace";
import { createCollector } from "./trace-collector";
import { traceStoreConfigFromEnv } from "./trace-store";
import { withCors } from "./cors";
import { gatewayFetch } from "./gateway";

/** `gateway` is the one origin apps are given, which sits in front of the others like a load balancer. */
export type Role = "proxy" | "imaging" | "auth" | "trace" | "gateway";
export const ROLES: Role[] = ["proxy", "imaging", "auth", "trace", "gateway"];
const BACKENDS: BackendName[] = ["static-files", "s3", "orthanc"];

export async function startRoles(root: string, roles: Role[], env: Record<string, string | undefined> = process.env) {
  const has = (r: Role) => roles.includes(r);
  const needsCredential = has("proxy") || has("imaging") || has("auth");
  // Each service in the deployment has to hold the same one, so it can't be made up here.
  const serviceSecret = env.SERVICE_SECRET ?? (needsCredential ? undefined : randomBytes(24).toString("base64url"));
  if (!serviceSecret) throw new Error(`--role ${roles.join(",")} needs SERVICE_SECRET, the credential the services share`);
  // The policy API's credential, which the Imaging Server and the Authorization Server share, and the proxy never gets.
  const policySecret = env.POLICY_SECRET;
  if ((has("imaging") || has("auth")) && !policySecret) throw new Error(`--role ${roles.join(",")} needs POLICY_SECRET, the policy API's credential, which only the Imaging Server and the Authorization Server hold`);
  // The services send spans with a credential derived from the one they share.
  const spanSecret = createHash("sha256").update(`smart-imaging-demo trace spans ${serviceSecret}`).digest("base64url");
  setTraceSink(CONFIG.traceSink, spanSecret);

  const stops: (() => void)[] = [];
  if (has("trace")) {
    const collector = createCollector(root, traceStoreConfigFromEnv(env), spanSecret);
    const servers = serveOn(PORTS.trace, { fetch: collector.fetch, idleTimeout: 0 });
    stops.push(() => { servers.forEach(s => s.stop(true)); collector.close(); });
  }
  const name = (env.PROXY_BACKEND ?? "static-files") as BackendName;
  if (has("proxy") && !BACKENDS.includes(name)) throw new Error(`PROXY_BACKEND must be one of ${BACKENDS.join(", ")}, not "${name}"`);
  const catalogs = has("imaging") ? await openCatalogs(root, env.CATALOG_DB || DEFAULT_CATALOG_DB) : undefined;
  const catalog = catalogs ? (name === "orthanc" ? catalogs.orthanc : catalogs.archive) : createCatalog();
  const backends = has("proxy") ? Object.fromEntries(BACKENDS.map(b => [b, buildBackend(b)])) as Record<BackendName, ReturnType<typeof buildBackend>> : {} as Record<BackendName, ReturnType<typeof buildBackend>>;
  const store = has("imaging") || has("auth") ? openRootStore(storeConfigFromEnv(env)) : new PolicyStore({ mode: "memory" });
  // The demo's Backend Services clients get keys derived from SERVICE_SECRET, so every process agrees on them.
  const clientKeys = new Map(DEMO_BACKEND_CLIENTS.map(id => [id, derivedBackendClient(id, serviceSecret).privateKey]));
  const world = createWorld({
    store, clock: demoClock, serviceSecret, policySecret: policySecret ?? randomBytes(24).toString("base64url"), jwksTtlSeconds: Number(env.JWKS_TTL_SECONDS ?? DEFAULT_JWKS_TTL_SECONDS),
    shared: { catalogs: { archive: catalog, orthanc: catalog }, backends, clientKeys, initialBackend: () => name },
  });
  if (has("auth")) {
    // The one origin runs with the Authorization Server, whose base is its root.
    const servers = serveOn(PORTS.auth, { fetch: withCors(world.auth.fetch), idleTimeout: 120 });
    stops.push(() => servers.forEach(s => s.stop(true)));
  }
  if (has("imaging")) {
    const servers = serveOn(PORTS.imaging, { fetch: withCors(world.imaging.fetch), idleTimeout: 120 });
    stops.push(() => servers.forEach(s => s.stop(true)));
  }
  if (has("proxy")) {
    const server = await serveStreamingOn(PORTS.proxy, withCors(world.proxy.fetch));
    stops.push(() => server.stop());
  }
  stops.push(() => { store.close(); catalogs?.archive.close(); catalogs?.orthanc.close(); });
  if (has("gateway")) {
    if (!ONE_ORIGIN) throw new Error("--role gateway serves the one origin, which DEMO_ONE_ORIGIN=0 turns off");
    const server = await serveStreamingOn(PORTS.gateway, gatewayFetch, GATEWAY_HOSTS);
    stops.push(() => server.stop());
  }
  return { stop() { flushTraces(); for (const stop of stops.reverse()) stop(); } };
}
