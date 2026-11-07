// Runs some of the services in this process, for a deployment that splits them. They find each other
// through CONFIG, and act together only over HTTP.
import { randomBytes } from "node:crypto";
import { createProxy, DEFAULT_JWKS_TTL_SECONDS } from "@smart-imaging-proxy/core";
import { CONFIG, DEFAULT_CATALOG_DB, GATEWAY_HOSTS, ONE_ORIGIN, PORTS, serveOn, serveStreamingOn } from "./config";
import { DEMO_BACKEND_CLIENTS, DEMO_BACKEND_SCOPES, derivedBackendClient } from "./auth-server";
import { createStores, storeConfigFromEnv } from "./stores";
import { buildAuthServer, buildBackend, buildImagingServer, openCatalogs, proxyLinks, type BackendName } from "./stack";
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
  setTraceSink(CONFIG.traceSink);

  const stops: (() => void)[] = [];
  if (has("trace")) {
    const collector = createCollector(root, traceStoreConfigFromEnv(env));
    const servers = serveOn(PORTS.trace, { fetch: collector.fetch, idleTimeout: 0 });
    stops.push(() => { servers.forEach(s => s.stop(true)); collector.close(); });
  }
  if (has("imaging") || has("auth")) {
    const stores = createStores(storeConfigFromEnv(env));
    if (has("auth")) {
      const auth = buildAuthServer(stores, serviceSecret, policySecret!);
      for (const id of DEMO_BACKEND_CLIENTS) auth.registerBackendClient(id, DEMO_BACKEND_SCOPES, derivedBackendClient(id, serviceSecret).privateKey);
      // The one origin runs with the Authorization Server, whose base is its root.
      const servers = serveOn(PORTS.auth, { fetch: withCors(auth.fetch), idleTimeout: 120 });
      stops.push(() => servers.forEach(s => s.stop(true)));
    }
    if (has("imaging")) {
      const catalogs = await openCatalogs(root, env.CATALOG_DB || DEFAULT_CATALOG_DB);
      const catalog = env.PROXY_BACKEND === "orthanc" ? catalogs.orthanc : catalogs.archive;
      const imaging = buildImagingServer(stores, serviceSecret, policySecret!, () => catalog);
      const servers = serveOn(PORTS.imaging, { fetch: withCors(imaging.fetch), idleTimeout: 120 });
      stops.push(() => { servers.forEach(s => s.stop(true)); catalogs.archive.close(); catalogs.orthanc.close(); });
    }
    stops.push(() => stores.close());
  }
  if (has("proxy")) {
    const name = (env.PROXY_BACKEND ?? "static-files") as BackendName;
    if (!BACKENDS.includes(name)) throw new Error(`PROXY_BACKEND must be one of ${BACKENDS.join(", ")}, not "${name}"`);
    const backend = buildBackend(name);
    const proxy = createProxy({ ...proxyLinks, jwksTtlSeconds: Number(env.JWKS_TTL_SECONDS ?? DEFAULT_JWKS_TTL_SECONDS), serviceSecret, backend: () => backend });
    const server = await serveStreamingOn(PORTS.proxy, withCors(proxy.fetch));
    stops.push(() => server.stop());
  }
  if (has("gateway")) {
    if (!ONE_ORIGIN) throw new Error("--role gateway serves the one origin, which DEMO_ONE_ORIGIN=0 turns off");
    const server = await serveStreamingOn(PORTS.gateway, gatewayFetch, GATEWAY_HOSTS);
    stops.push(() => server.stop());
  }
  return { stop() { flushTraces(); for (const stop of stops.reverse()) stop(); } };
}
