// A sandbox: one Authorization Server, Imaging Server and proxy, with their own policy store, signing
// key, credentials, decision cache and clock. The root sandbox holds the one real policy database. Each
// sandbox is a sandbox of its own, whose URLs all start with its prefix. Sandboxes share only the catalog,
// the backends and the trace collector, and reach one another only over HTTP, so nothing one issues
// works in another.
import { randomBytes, type KeyObject } from "node:crypto";
import { listClients, restoreGrants } from "./clients";
import { friendlyName } from "./sandbox-names";
import { createImagingServer, createPolicyClient, createProxy, idOf, ref, withTruncation, type Backend, type CatalogStore, type PolicyOperation, type PolicyStore } from "@smart-imaging-proxy/core";
import { APP_NAMES, createAuthServer, DEMO_BACKEND_SCOPES, PATIENT_NAMES, USERS, type BackendClient } from "./auth-server";
import { patientAttributes } from "./stores";
import { ADMIN_SCOPE, derivedKey, SANDBOX_ADMIN, sandboxSeed } from "./sandbox-keys";
import { PORTS, urlsFor, type SandboxUrls } from "./config";
import { tfetch, traceObserver, type Service } from "./trace";
import type { DemoClock } from "./clock";

export type BackendName = "static-files" | "s3" | "orthanc";

/** What every sandbox reads and none owns. Which backend a sandbox uses is its own choice. */
export interface Shared {
  catalogs: { archive: CatalogStore; orthanc: CatalogStore };
  backends: Record<BackendName, Backend>;
  /** The backend a new sandbox starts on. */
  initialBackend(): BackendName;
  /** The demo's Backend Services clients, by id, with the root sandbox's keys. Every other sandbox derives its own. */
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

export type Topology = "separate" | "unified";
/**
 * What a sandbox can be made to do, as faults a check sets: the decision API down, the image store stopping after
 * some instances, and four things the guide lets any server do that an app has to cope with: small search pages,
 * a 503 with Retry-After on a token's first search or a study's first retrieval, and Endpoints in every form.
 */
export interface Faults { decisionOutage: boolean; truncateAfter: number | null; pageSize: number | null; searchRetryAfter: number | null; retrievalRetryAfter: number | null; endpointForms: boolean }
/** An app check's run while it's on here: what the banner on every page says. */
export interface AppCheckOn { run: string; client: string; script: string; staged: string[]; startedAt: string; endsAt: string }
export function createSandbox(o: { id?: string; store: PolicyStore; clock: DemoClock; shared: Shared; serviceSecret?: string; policySecret?: string; jwksTtlSeconds?: number }) {
  const { store, clock, shared } = o;
  // A sandbox remembers its own choice, with the rest of its state.
  const remembered = o.id ? store.note("backend") as BackendName | undefined : undefined;
  let current: BackendName = remembered && remembered in shared.backends ? remembered : shared.initialBackend();
  /** Search and decisions read the catalog that describes what this sandbox's backend holds. */
  const catalog = () => current === "orthanc" ? shared.catalogs.orthanc : shared.catalogs.archive;
  const prefix = o.id ? `/s/${o.id}` : "";
  const urls: SandboxUrls = urlsFor(prefix);
  const local = (port: number) => `http://127.0.0.1:${port}${prefix}`;
  const serviceSecret = o.serviceSecret ?? randomBytes(24).toString("base64url");
  // Only the Authorization Server and the demo hold this one. The proxy never does.
  const policySecret = o.policySecret ?? randomBytes(24).toString("base64url");
  const policy = policyClient(local(PORTS.imaging), policySecret);
  const directoryPolicy = policyClient(local(PORTS.imaging), policySecret, "authorization-server");

  const auth = createAuthServer({
    issuer: urls.auth, imagingFhirBase: `${urls.imaging}/fhir`, serviceSecret, redirectUri: urls.callback, demoClientRedirectUri: `${new URL(urls.demo).origin}/viewer`, unified: () => store.note("topology") === "unified", releasedStudies: async t => { const x: any = await policy.explain({ client: t.client_id, ...(t.sub ? { user: t.sub, fhirUser: t.fhirUser } : {}), patient: t.patient! } as any); const ids = new Set((x.studies ?? []).filter((d: any) => d.release !== "none").map((d: any) => d.id)); return catalog().allStudies().filter(st => ids.has(st.id)); }, imagingFetch: (req: Request) => imaging.fetchAt(req, `${urls.auth}/fhir`), siteNames: () => [...new Set(catalog().allStudies().flatMap(st => st.site ? [st.site] : []))].sort(), ...(o.id ? { registeredClient: (id: string) => listClients(store).find(c => c.id === id) } : {}), store: () => store, clock,
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
          apps: a.approvals.map(x => ({ client: idOf(x.app, "app")!, patient: idOf(x.patient, "patient")!, ...(x.sites ? { sites: x.sites } : {}), ...(x.studies ? { studies: x.studies } : {}) })),
        };
      },
      recordConsent: async c => {
        const r = await directoryPolicy.approveApp({ by: ref("user", c.user), app: ref("app", c.client), patient: ref("patient", c.patient), fhirUser: c.fhirUser, sites: c.sites, ...(c.studies ? { studies: c.studies } : {}) });
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
  // This sandbox's own keys: from its ID, or for the root, the deployment's.
  const keyOf = (id: string) => o.id ? derivedKey(sandboxSeed(o.id), id) : shared.clientKeys.get(id) ?? derivedKey(serviceSecret, id);
  const clients: Record<string, BackendClient> = {};
  for (const id of shared.clientKeys.keys()) clients[id] = auth.registerBackendClient(id, DEMO_BACKEND_SCOPES, keyOf(id));
  const admin = auth.registerBackendClient(SANDBOX_ADMIN, [ADMIN_SCOPE], keyOf(SANDBOX_ADMIN));

  const introspect = async (token: string) => {
    const r = await tfetch("imaging-fhir", "introspect the token", `${urls.auth}/introspect`, { method: "POST", headers: { Authorization: `Bearer ${serviceSecret}`, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }) });
    return r.ok ? r.json() : { active: false };
  };
  const imaging = createImagingServer({
    base: `${urls.imaging}/fhir`, clinicalFhirBase: urls.clinicalFhir, proxyBase: () => urls.proxy, introspect, patientOf: user => USERS[user]?.patient, isUser: user => Object.hasOwn(USERS, user), patientAttributes, name: nameOf,
    serviceSecret, policySecret, catalog, keyStore: store, store: () => store, observer: traceObserver, clock,
  });

  // Truncation is this sandbox's own fault injection, over the shared backends.
  let truncateAfter: number | undefined;
  const wrapped = new Map<Backend, Backend>();
  const backend = () => { const b = shared.backends[current]; let w = wrapped.get(b); if (!w) wrapped.set(b, w = withTruncation(b, () => truncateAfter)); return w; };
  const proxy = createProxy({ publicBase: () => urls.proxy, jwksUrl: `${urls.imaging}/.well-known/jwks.json`, jwksTtlSeconds: o.jwksTtlSeconds, decisionUrl: `${urls.imaging}/access/v1/evaluation`, serviceSecret, backend, observer: traceObserver, clock });

  let appCheck: AppCheckOn | undefined;
  const clearRuntime = () => { auth.reset(); imaging.reset(); proxy.reset(); truncateAfter = undefined; appCheck = undefined; };
  const faults = (): Faults => {
    const s = imaging.staged;
    return { decisionOutage: imaging.outage, truncateAfter: truncateAfter ?? null, pageSize: s.pageSize ?? null, searchRetryAfter: s.retryAfter ?? null, retrievalRetryAfter: proxy.retryAfter ?? null, endpointForms: !!s.endpointForms };
  };
  return {
    id: o.id, prefix, urls, store, clock, auth, imaging, proxy, clients,
    /** This sandbox's admin client, whose token manages it. */
    admin,
    /** The policy API, with this sandbox's policy credential. */
    policy,
    get catalog() { return catalog(); },
    get catalogSource() { return current === "orthanc" ? "orthanc" as const : "archive" as const; },
    get backend() { return current; },
    setBackend(n: BackendName) { current = n; if (o.id) store.setNote("backend", n); },
    /** A sandbox's friendly label, chosen when first asked for. */
    get name(): string | undefined { if (!o.id) return undefined; let n = store.note("name"); if (!n) { n = friendlyName(); store.setNote("name", n); } return n; },
    setName(n: string) { store.setNote("name", n); },
    /** Where discovery says imaging is: on a separate FHIR server, or on the clinical one. */
    get topology(): Topology { return store.note("topology") === "unified" ? "unified" : "separate"; },
    setTopology(t: Topology) { store.setNote("topology", t); },
    /** Back to what's on file, keeping what registered services were granted. */
    async resetPolicy() { await policy.reset(); restoreGrants(store); },
    backends: shared.backends,
    setTruncateAfter(n: number | undefined) { truncateAfter = n; },
    faults,
    /** Sets the faults given, leaving the rest. Staging any of the last four starts it afresh, so first searches and retrievals are first again. */
    setFaults(f: Partial<Faults>) {
      if (f.decisionOutage !== undefined) imaging.setOutage(f.decisionOutage);
      if (f.truncateAfter !== undefined) truncateAfter = f.truncateAfter ?? undefined;
      if (f.pageSize !== undefined || f.searchRetryAfter !== undefined || f.endpointForms !== undefined) {
        const was = faults(), pageSize = f.pageSize !== undefined ? f.pageSize : was.pageSize, retryAfter = f.searchRetryAfter !== undefined ? f.searchRetryAfter : was.searchRetryAfter;
        imaging.setStaged({ ...(pageSize ? { pageSize } : {}), ...(retryAfter ? { retryAfter } : {}), ...((f.endpointForms ?? was.endpointForms) ? { endpointForms: true } : {}) });
      }
      if (f.retrievalRetryAfter !== undefined) proxy.setRetryAfter(f.retrievalRetryAfter ?? undefined);
    },
    /** The app check run that's on here, if one is. */
    get appCheck() { return appCheck; },
    setAppCheck(on: AppCheckOn | undefined) { appCheck = on; },
    /** Replaces the signing key, then tells the proxy over HTTP, so it stops trusting the old one now. A proxy that isn't told learns within its TTL. */
    async rotateSigningKey() {
      const kid = imaging.rotateSigningKey();
      const told = await tfetch("demo", "tell the proxy to refetch signing keys", `${local(PORTS.proxy)}/internal/keys/refresh`, { method: "POST", headers: { Authorization: `Bearer ${serviceSecret}` } }).then(r => r.ok, () => false);
      return { kid, proxyTold: told };
    },
    /** A call to the Imaging Server's policy API, with the policy credential, for a caller the demo has already let in. */
    policyFetch(path: string, init: { method: string; body?: string; contentType?: string }) {
      return tfetch("demo", `policy API: ${init.method} ${path.split("?")[0]}`, `${local(PORTS.imaging)}/policy/v2${path}`, { method: init.method, headers: { Authorization: `Bearer ${policySecret}`, ...(init.contentType ? { "Content-Type": init.contentType } : {}) }, ...(init.body ? { body: init.body } : {}) });
    },
    /** The Imaging Server's view of why a study is or isn't released, asked with the policy credential. */
    explain(q: { client: string; user?: string; fhirUser?: string; patient: string }) {
      return policy.explain(Object.fromEntries(Object.entries(q).filter(e => !!e[1])) as typeof q);
    },
    /** Tokens expire by this sandbox's clock. */
    purgeTokens: () => store.purgeExpiredTokens(clock.now()),
    clearRuntime,
    close() { clearRuntime(); store.close(); },
  };
}
export type Sandbox = ReturnType<typeof createSandbox>;
