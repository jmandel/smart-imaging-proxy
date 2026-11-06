// Runs some of the services in this process, for a deployment that splits them. They find each other
// through CONFIG, and act together only over HTTP.
import { randomBytes } from "node:crypto";
import { CONFIG, PORTS, serveOn } from "./config";
import { createProxy } from "./proxy";
import { DEFAULT_JWKS_TTL_SECONDS } from "./jwks";
import { createStores, storeConfigFromEnv } from "./policy-store";
import { serveStreaming } from "./serve-streaming";
import { buildAuthServer, buildBackend, buildImagingServer, proxyLinks, readManifest, type BackendName } from "./stack";
import { flushTraces, setTraceSink } from "./trace";
import { createCollector } from "./trace-collector";
import { traceStoreConfigFromEnv } from "./trace-store";

export type Role = "proxy" | "imaging" | "auth" | "trace";
export const ROLES: Role[] = ["proxy", "imaging", "auth", "trace"];
const BACKENDS: BackendName[] = ["static-files", "minio", "orthanc"];

export async function startRoles(root: string, roles: Role[], env: Record<string, string | undefined> = process.env) {
  const has = (r: Role) => roles.includes(r);
  const needsCredential = has("proxy") || has("imaging") || has("auth");
  // Each service in the deployment has to hold the same one, so it can't be made up here.
  const serviceSecret = env.SERVICE_SECRET ?? (needsCredential ? undefined : randomBytes(24).toString("base64url"));
  if (!serviceSecret) throw new Error(`--role ${roles.join(",")} needs SERVICE_SECRET, the credential the services share`);
  setTraceSink(CONFIG.traceUrl);

  const stops: (() => void)[] = [];
  if (has("trace")) {
    const collector = createCollector(root, traceStoreConfigFromEnv(env));
    const servers = serveOn(PORTS.trace, { fetch: collector.fetch, idleTimeout: 0 });
    stops.push(() => { servers.forEach(s => s.stop(true)); collector.close(); });
  }
  if (has("imaging") || has("auth")) {
    const stores = createStores(storeConfigFromEnv(env));
    if (has("auth")) {
      const auth = buildAuthServer(stores, serviceSecret);
      const servers = serveOn(PORTS.auth, { fetch: auth.fetch, idleTimeout: 120 });
      stops.push(() => servers.forEach(s => s.stop(true)));
    }
    if (has("imaging")) {
      const imaging = buildImagingServer(stores, serviceSecret, await readManifest(root));
      const servers = serveOn(PORTS.imaging, { fetch: imaging.fetch, idleTimeout: 120 });
      stops.push(() => servers.forEach(s => s.stop(true)));
    }
    stops.push(() => stores.close());
  }
  if (has("proxy")) {
    const name = (env.PROXY_BACKEND ?? "static-files") as BackendName;
    if (!BACKENDS.includes(name)) throw new Error(`PROXY_BACKEND must be one of ${BACKENDS.join(", ")}, not "${name}"`);
    const backend = buildBackend(root, name === "orthanc" ? undefined : await readManifest(root), name);
    const proxy = createProxy({ ...proxyLinks, jwksTtlSeconds: Number(env.JWKS_TTL_SECONDS ?? DEFAULT_JWKS_TTL_SECONDS), serviceSecret, backend: () => backend });
    const server = await serveStreaming(PORTS.proxy, proxy.fetch);
    stops.push(() => server.stop());
  }
  return { stop() { flushTraces(); for (const stop of stops.reverse()) stop(); } };
}
