// A world: one Authorization Server, Imaging Server and proxy, with their own policy store, signing
// key, credentials, decision cache and clock. The root world holds the one real policy database. Each
// scope is a world of its own, whose URLs all start with its prefix. Worlds share only the catalog,
// the backends and the trace collector, and reach one another only over HTTP, so nothing one issues
// works in another.
import { randomBytes, type KeyObject } from "node:crypto";
import { createImagingServer, createPolicyClient, createProxy, idOf, ref, withTruncation, type Backend, type CatalogStore, type PolicyOperation, type PolicyStore } from "@smart-imaging-proxy/core";
import { APP_NAMES, createAuthServer, DEMO_BACKEND_SCOPES, PATIENT_NAMES, USERS, type BackendClient } from "./auth-server";
import { patientAttributes } from "./stores";
import { PORTS, urlsFor, type WorldUrls } from "./config";
import { tfetch, traceObserver, type Service } from "./trace";
import type { DemoClock } from "./clock";

export type BackendName = "static-files" | "s3" | "orthanc";

/** What every world reads and none owns. Which backend a world uses is its own choice. */
export interface Shared {
  catalogs: { archive: CatalogStore; orthanc: CatalogStore };
  backends: Record<BackendName, Backend>;
  /** The backend a new world starts on. */
  initialBackend(): BackendName;
  /** The demo's Backend Services clients, the same in every world. */
  clientKeys: Map<string, KeyObject>;
}

/** How each policy API call reads in the trace. */
const POLICY_CALLS: Record<PolicyOperation, string> = {
  "get-document": "read policy at the Imaging Server",
  "set-document": "set policy at the Imaging Server",
  relationships: "look up who is related to whom",
  "put-relationship": "record a relationship at the Imaging Server",
  "remove-relationship": "remove a relationship at the Imaging Server",
  policies: "read the organization's policies at the Imaging Server",
  "put-policy": "set an organization policy at the Imaging Server",
  "replace-policies": "set the organization's policies at the Imaging Server",
  "remove-policy": "remove an organization policy at the Imaging Server",
  shares: "look up shares at the Imaging Server",
  share: "record the share at the Imaging Server",
  "remove-shares": "revoke the share at the Imaging Server",
  approvals: "look up app approvals at the Imaging Server",
  "approve-app": "record the app approval at the Imaging Server",
  "remove-approvals": "revoke the app approval at the Imaging Server",
  access: "look up the user's access",
  explain: "the demo asks for the Imaging Server's view",
  "get-settings": "read the settings at the Imaging Server",
  "set-settings": "change the settings at the Imaging Server",
  reset: "reset policy at the Imaging Server",
  info: "read the policy store's state at the Imaging Server",
};

/** Display names for the reasons decisions give: the demo's people, patients, apps, services and labels. */
const LABEL_NAMES: Record<string, string> = { "confidential-adolescent": "confidential adolescent care" };
export function nameOf(r: string): string {
  const [kind, id = ""] = [r.slice(0, r.indexOf(":")), r.slice(r.indexOf(":") + 1)];
  if (kind === "user") return USERS[id]?.name.split(" ")[0] ?? id;
  if (kind === "patient") return PATIENT_NAMES[id]?.split(" ")[0] ?? id;
  if (kind === "app") return APP_NAMES[id] ? `the ${APP_NAMES[id]}` : id;
  if (kind === "service") return `the ${id.replaceAll("-", " ")}`;
  if (kind === "label") return LABEL_NAMES[id] ?? id.replaceAll("-", " ");
  return r;
}

/**
 * The Imaging Server's policy API at `base`, its loopback address: the one origin doesn't forward the
 * API. Traced as `service`.
 */
export const policyClient = (base: string, policySecret: string, service: Service = "demo") =>
  createPolicyClient({ base, policySecret, fetch: (op, url, init) => tfetch(service, POLICY_CALLS[op], url, init) });

export function createWorld(o: { scope?: string; store: PolicyStore; clock: DemoClock; shared: Shared; serviceSecret?: string; policySecret?: string; jwksTtlSeconds?: number }) {
  const { store, clock, shared } = o;
  // A scope remembers its own choice, with the rest of its state.
  const remembered = o.scope ? store.note("backend") as BackendName | undefined : undefined;
  let current: BackendName = remembered && remembered in shared.backends ? remembered : shared.initialBackend();
  /** Search and decisions read the catalog that describes what this world's backend holds. */
  const catalog = () => current === "orthanc" ? shared.catalogs.orthanc : shared.catalogs.archive;
  const prefix = o.scope ? `/s/${o.scope}` : "";
  const urls: WorldUrls = urlsFor(prefix);
  const local = (port: number) => `http://127.0.0.1:${port}${prefix}`;
  const serviceSecret = o.serviceSecret ?? randomBytes(24).toString("base64url");
  // Only the Authorization Server and the demo hold this one. The proxy never does.
  const policySecret = o.policySecret ?? randomBytes(24).toString("base64url");
  const policy = policyClient(local(PORTS.imaging), policySecret);
  const directoryPolicy = policyClient(local(PORTS.imaging), policySecret, "authorization-server");

  const auth = createAuthServer({
    issuer: urls.auth, imagingFhirBase: `${urls.imaging}/fhir`, serviceSecret, redirectUri: urls.callback, demoClientRedirectUri: `${urls.demo}/`, store: () => store, clock,
    // The Authorization Server's pages, in their own terms, over the policy API's three levels.
    directory: {
      relationships: async () => [
        ...(await directoryPolicy.relationships()).filter(r => r.relation === "guardian_of").map(r => ({ patient: idOf(r.object, "patient")!, delegate: idOf(r.subject, "user")!, relationship: "guardian" })),
        ...(await directoryPolicy.shares()).map(s => ({ patient: idOf(s.patient, "patient")!, delegate: idOf(s.with, "user")!, relationship: s.label })),
      ],
      access: async (user, fhirUser) => {
        const a = await directoryPolicy.access(user, fhirUser);
        return {
          records: a.records.map(r => ({ ...r, via: r.via === "share" ? "delegation" as const : r.via })),
          delegations: a.shares.map(s => ({ patient: idOf(s.patient, "patient")!, delegate: idOf(s.with, "user")!, relationship: s.label, sites: s.sites })),
          apps: a.approvals.map(x => ({ client: idOf(x.app, "app")!, patient: idOf(x.patient, "patient")!, ...(x.sites ? { sites: x.sites } : {}) })),
        };
      },
      recordConsent: async c => {
        const r = await directoryPolicy.approveApp({ by: ref("user", c.user), app: ref("app", c.client), patient: ref("patient", c.patient), fhirUser: c.fhirUser, ...(c.sites ? { sites: c.sites } : {}) });
        return r.ok ? {} : { refused: `${r.refusal.error} (${r.refusal.policy})` };
      },
      delegate: async d => {
        const r = await directoryPolicy.share({ from: ref("user", d.grantedBy), with: ref("user", d.delegate), patient: ref("patient", d.patient), sites: d.sites, label: d.relationship });
        return r.ok ? {} : { refused: `${r.refusal.error} (${r.refusal.policy})` };
      },
      revokeDelegation: async (grantedBy, delegate, patient) => { if (delegate) await directoryPolicy.removeShares({ from: ref("user", grantedBy), with: ref("user", delegate), patient: patient && ref("patient", patient) }); },
      revokeApp: async (client, user, patient) => { if (client) await directoryPolicy.removeApprovals({ by: ref("user", user), app: ref("app", client), patient: patient && ref("patient", patient) }); },
    },
  });
  const clients: Record<string, BackendClient> = {};
  for (const [id, key] of shared.clientKeys) clients[id] = auth.registerBackendClient(id, DEMO_BACKEND_SCOPES, key);

  const introspect = async (token: string) => {
    const r = await tfetch("imaging-fhir", "introspect the token", `${urls.auth}/introspect`, { method: "POST", headers: { Authorization: `Bearer ${serviceSecret}`, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }) });
    return r.ok ? r.json() : { active: false };
  };
  const imaging = createImagingServer({
    base: `${urls.imaging}/fhir`, clinicalFhirBase: urls.clinicalFhir, proxyBase: () => urls.proxy, introspect, patientOf: user => USERS[user]?.patient, patientAttributes, name: nameOf,
    serviceSecret, policySecret, catalog, keyStore: store, store: () => store, observer: traceObserver, clock,
  });

  // Truncation is this world's own fault injection, over the shared backends.
  let truncateAfter: number | undefined;
  const wrapped = new Map<Backend, Backend>();
  const backend = () => { const b = shared.backends[current]; let w = wrapped.get(b); if (!w) wrapped.set(b, w = withTruncation(b, () => truncateAfter)); return w; };
  const proxy = createProxy({ publicBase: () => urls.proxy, jwksUrl: `${urls.imaging}/.well-known/jwks.json`, jwksTtlSeconds: o.jwksTtlSeconds, decisionUrl: `${urls.imaging}/access/v1/evaluation`, serviceSecret, backend, observer: traceObserver, clock });

  const clearRuntime = () => { auth.reset(); imaging.reset(); proxy.reset(); truncateAfter = undefined; };
  return {
    scope: o.scope, prefix, urls, store, clock, auth, imaging, proxy, clients,
    /** The policy API, with this world's policy credential. */
    policy,
    get catalog() { return catalog(); },
    get catalogSource() { return current === "orthanc" ? "orthanc" as const : "archive" as const; },
    get backend() { return current; },
    setBackend(n: BackendName) { current = n; if (o.scope) store.setNote("backend", n); },
    backends: shared.backends,
    setTruncateAfter(n: number | undefined) { truncateAfter = n; },
    /** Replaces the signing key, then tells the proxy over HTTP, so it stops trusting the old one now. A proxy that isn't told learns within its TTL. */
    async rotateSigningKey() {
      const kid = imaging.rotateSigningKey();
      const told = await tfetch("demo", "tell the proxy to refetch signing keys", `${local(PORTS.proxy)}/internal/keys/refresh`, { method: "POST", headers: { Authorization: `Bearer ${serviceSecret}` } }).then(r => r.ok, () => false);
      return { kid, proxyTold: told };
    },
    /** The Imaging Server's view of why a study is or isn't released, asked with the policy credential. */
    explain(q: { client: string; user?: string; fhirUser?: string; patient: string }) {
      return policy.explain(Object.fromEntries(Object.entries(q).filter(e => !!e[1])) as typeof q);
    },
    /** Tokens expire by this world's clock. */
    purgeTokens: () => store.purgeExpiredTokens(clock.now()),
    clearRuntime,
    close() { clearRuntime(); store.close(); },
  };
}
export type World = ReturnType<typeof createWorld>;
