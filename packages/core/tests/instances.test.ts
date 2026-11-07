// Two deployments in one process, sharing only the catalog: each has its own policy store, tokens,
// signing key, base URLs, clock and observer, and neither sees the other's.
import { afterAll, describe, expect, test } from "bun:test";
import { BackendError, createCatalog, createImagingServer, createPolicyClient, createProxy, PolicyStore, publicJwk, type Backend } from "../src";
import { manualClock, put, recordingObserver } from "./support";

const SECRET = "service-secret";
const catalog = createCatalog();
put(catalog, "1.1", {}, "p1");
const STUDY = "1.1";

function deployment(name: string, clock: ReturnType<typeof manualClock>) {
  const store = new PolicyStore({ mode: "memory" });
  const recorder = recordingObserver();
  const base = `https://host.example/s/${name}`;
  const introspect = async (token: string) => { const t = store.getToken(token, "access"); return t && !t.revoked ? { active: true, ...t } : { active: false }; };
  const imaging = createImagingServer({
    base: `${base}/imaging/fhir`, clinicalFhirBase: `${base}/fhir`, proxyBase: () => `${base}/proxy`, introspect, patientOf: u => u === "pat" ? "p1" : undefined,
    serviceSecret: SECRET, policySecret: `${SECRET}-policy`, catalog: () => catalog, keyStore: store, store: () => store, observer: recorder.observer, clock,
  });
  const http = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: imaging.fetch });
  const local = `http://127.0.0.1:${http.port}`;
  const backend: Backend = { capabilities: () => ({ name: "none", selection: "one-per-request", hasManifest: false, enforcesHierarchy: true, notes: [] }), listSeries: async () => [], openInstances: async () => { throw new BackendError("NotFound"); }, getMetadata: async () => [], openBulk: async () => { throw new BackendError("NotFound"); } } as unknown as Backend;
  const proxy = createProxy({ publicBase: () => `${base}/proxy`, keys: imaging.publicKeys, decisionUrl: `${local}/access/v1/evaluation`, serviceSecret: SECRET, backend: () => backend, observer: recorder.observer, clock });
  const policy = createPolicyClient({ base: local, policySecret: `${SECRET}-policy` });
  return { name, base, store, imaging, proxy, policy, recorder, stop: () => http.stop(true) };
}

const clockA = manualClock(), clockB = manualClock();
const a = deployment("a", clockA), b = deployment("b", clockB);
afterAll(() => { a.stop(); b.stop(); a.store.close(); b.store.close(); catalog.close(); });

const TOKEN = "token-for-a";
a.store.putToken(TOKEN, "access", { client_id: "app", scope: "patient/ImagingStudy.rs", patient: "p1", sub: "pat", fhirUser: "Patient/p1" }, clockA.now() + 3600);
// A service answers at its own root, whatever base it issues URLs under.
const search = (d: typeof a) => d.imaging.fetch(new Request("http://imaging/fhir/ImagingStudy?patient=p1", { headers: { Authorization: `Bearer ${TOKEN}` } }));

describe("two deployments side by side", () => {
  test("policy set through one's API isn't the other's", async () => {
    await a.policy.putPolicy({ id: "only-a", type: "service-access", service: "service:app", patients: "any", allow: { all: true } });
    await a.policy.setSettings({ contextLifetimeSeconds: 60 });
    expect((await a.policy.approveApp({ by: "user:pat", app: "app:app", fhirUser: "Patient/p1", patient: "patient:p1" })).ok).toBe(true);
    expect((await a.policy.policies()).map(r => r.id)).toEqual(["only-a"]);
    expect(await a.policy.approvals()).toEqual([{ by: "user:pat", app: "app:app", patient: "patient:p1" }]);
    expect(await b.policy.policies()).toEqual([]);
    expect(await b.policy.approvals()).toEqual([]);
    expect((await b.policy.getSettings()).contextLifetimeSeconds).toBe(300);
  });
  test("tokens are each store's own", async () => {
    expect(a.store.getToken(TOKEN, "access")).toBeDefined();
    expect(b.store.getToken(TOKEN, "access")).toBeUndefined();
    expect((await search(a)).status).toBe(200);
    expect((await search(b)).status).toBe(401);
  });
  test("each signs with its own key, and issues only its own URLs", async () => {
    expect(a.imaging.signingKid).not.toBe(b.imaging.signingKid);
    expect(a.imaging.jwks()).toEqual({ keys: [publicJwk(a.store.currentSigningKey())] });
    const bundle: any = await (await search(a)).json();
    expect(bundle.link[0].url.startsWith(`${a.base}/imaging/fhir/`)).toBe(true);
    const study = bundle.entry.find((e: any) => e.resource.resourceType === "ImagingStudy");
    const endpoint = bundle.entry.find((e: any) => e.resource.resourceType === "Endpoint");
    expect(study.fullUrl).toBe(`${a.base}/imaging/fhir/ImagingStudy/study-1.1`);
    expect(study.resource.subject.reference).toBe(`${a.base}/fhir/Patient/p1`);
    expect(endpoint.resource.address.startsWith(`${a.base}/proxy/wado/`)).toBe(true);
    expect(JSON.stringify(bundle)).not.toContain("/s/b/");

    // A's signed URL is instant at A's proxy, and B's proxy neither trusts the key nor knows the token.
    const ctx = endpoint.resource.address.split("/wado/")[1];
    const retrieve = (d: typeof a) => d.proxy.fetch(new Request(`http://proxy/wado/${ctx}/studies/${STUDY}`, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: "multipart/related; type=application/dicom; transfer-syntax=*" } }));
    expect((await retrieve(a)).status).toBe(404);
    expect(a.proxy.events.at(-1)!.authz).toBe("instant");
    expect((await retrieve(b)).status).toBe(401);
    expect(b.proxy.events.at(-1)!.authz).toBe("asked");
  });
  test("rotating one's key leaves the other's alone", () => {
    const before = b.imaging.signingKid;
    a.imaging.rotateSigningKey();
    expect(b.imaging.signingKid).toBe(before);
    expect(b.store.retiredPublicKeys().size).toBe(0);
  });
  test("each runs on its own clock", async () => {
    clockB.advance(10_000);
    const claims = async () => {
      const bundle: any = await (await search(a)).json();
      const address = bundle.entry.find((e: any) => e.resource.resourceType === "Endpoint").resource.address as string;
      return JSON.parse(Buffer.from(address.split("/wado/")[1]!.split(".")[1]!, "base64url").toString());
    };
    expect((await claims()).exp).toBe(clockA.now() + 60);
    clockA.advance(5);
    expect((await claims()).exp).toBe(clockA.now() + 60);
  });
  test("each reports to its own observer", () => {
    expect(a.recorder.spans.some(s => s.name.startsWith("sign study context"))).toBe(true);
    expect(b.recorder.spans.some(s => s.name.startsWith("sign study context"))).toBe(false);
    expect(b.recorder.named("token is active").every(s => s.status === "denied")).toBe(true);
  });
});
