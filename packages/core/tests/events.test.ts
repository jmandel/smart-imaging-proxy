// Typed events: each kind with its fixed fields, from search, signing, decisions, the proxy and the
// policy API, and never a token, only its hash.
import { afterAll, describe, expect, test } from "bun:test";
import { ath, createCatalog, createImagingServer, createPolicyClient, createProxy, PolicyStore, shortHash, CORE_EVENT_KINDS } from "../src";
import { ACCEPT, EVRLE, FakeBackend, fakeInstance } from "./fake-backend";
import { manualClock, put, recordingObserver } from "./support";

const SECRET = "service-secret", POLICY = "policy-secret", TOKEN = "events-token", SERVICE_TOKEN = "service-token", FRIEND_TOKEN = "friend-token";
const clock = manualClock();
const catalog = createCatalog();
put(catalog, "1.2.3", { site: "Site A" }, "p1");
put(catalog, "1.2.4", { site: "Site B" }, "p1");
const store = new PolicyStore({ mode: "memory" });
const rec = recordingObserver();
const introspect = async (token: string) => { const t = store.getToken(token, "access"); return t && !t.revoked ? { active: true, ...t } : { active: false }; };
const imaging = createImagingServer({
  base: "http://imaging.test/fhir", clinicalFhirBase: "http://clinical.test/fhir", proxyBase: () => "http://proxy.test", introspect, patientOf: u => u === "pat" ? "p1" : undefined,
  serviceSecret: SECRET, policySecret: POLICY, catalog: () => catalog, keyStore: store, store: () => store, observer: rec.observer, clock,
});
const http = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: imaging.fetch });
const local = `http://127.0.0.1:${http.port}`;
const policy = createPolicyClient({ base: local, policySecret: POLICY });
const backend = new FakeBackend([fakeInstance("1.2.3.1.0", EVRLE, 4000), fakeInstance("1.2.3.1.1", EVRLE, 4000)], { plan: true });
const proxy = createProxy({ publicBase: () => "http://proxy.test", keys: imaging.publicKeys, decisionUrl: `${local}/access/v1/evaluation`, serviceSecret: SECRET, backend: () => backend, observer: rec.observer, clock });
afterAll(() => { http.stop(true); store.close(); catalog.close(); });

store.putToken(TOKEN, "access", { client_id: "app", scope: "patient/ImagingStudy.rs", patient: "p1", sub: "pat", fhirUser: "Patient/p1" }, clock.now() + 3600);
store.putToken(SERVICE_TOKEN, "access", { client_id: "svc", scope: "system/ImagingStudy.rs" }, clock.now() + 3600);
store.putToken(FRIEND_TOKEN, "access", { client_id: "app", scope: "patient/ImagingStudy.rs", patient: "p1", sub: "friend", fhirUser: "RelatedPerson/friend" }, clock.now() + 3600);
const search = (token: string, q = "patient=p1") => imaging.fetch(new Request(`http://imaging/fhir/ImagingStudy?${q}`, { headers: { Authorization: `Bearer ${token}` } }));
const hash = ath(TOKEN).slice(0, 10);
const drain = async (res: Response) => { const r = res.body!.getReader(); while (!(await r.read()).done); };

describe("typed events", () => {
  test("every kind is listed, and no event holds a token", async () => {
    expect(CORE_EVENT_KINDS).toContain("search.returned");
    await policy.approveApp({ by: "user:pat", app: "app:app", patient: "patient:p1", fhirUser: "Patient/p1", sites: ["Site A"] });
    await search(TOKEN).then(r => r.text());
    expect(JSON.stringify(rec.events)).not.toContain(TOKEN);
  });
  test("a policy write is one policy.written event, with its level and revision", () => {
    const [w] = rec.kinds("policy.written");
    expect(w).toMatchObject({ operation: "POST /app-approvals", level: "choice", status: 200, patient: "p1", service: "policy" });
    expect(w.revision.patient).toBeGreaterThan(0);
  });
  test("search reports what it found, what it withheld and why, and signs one context per study found", () => {
    const s = rec.kinds("search.returned").at(-1);
    expect(s).toMatchObject({ status: 200, client: "app", user: "pat", patient: "p1", tokenHash: hash, found: ["study-1.2.3"], total: 1 });
    // The patient reaches Site B's study, and the app isn't approved for it.
    expect(s.withheld).toEqual([{ study: "study-1.2.4", why: expect.stringContaining("Site B") }]);
    expect(s.unreached).toEqual([]);
    const signed = rec.kinds("context.signed");
    expect(signed.map(c => c.study)).toEqual(["study-1.2.3"]);
    expect(signed[0]).toMatchObject({ studyUid: "1.2.3", form: "whole study", tokenHash: hash, kid: imaging.signingKid });
  });
  test("what no route of the user's reaches is unreached, apart from what the app isn't released", async () => {
    await policy.putPolicy({ id: "patients-share", type: "sharing", allowedFrom: ["patient"] });
    store.putShare({ from: "user:pat", with: "user:friend", patient: "patient:p1", sites: ["Site A"], label: "friend", basis: "self" });
    await policy.approveApp({ by: "user:friend", app: "app:app", patient: "patient:p1", fhirUser: "RelatedPerson/friend" });
    await search(FRIEND_TOKEN).then(r => r.text());
    const s = rec.kinds("search.returned").at(-1);
    expect(s).toMatchObject({ status: 200, user: "friend", found: ["study-1.2.3"], withheld: [] });
    expect(s.unreached).toEqual([{ study: "study-1.2.4", why: expect.stringContaining("Site B") }]);
  });
  test("a refused search says why", async () => {
    await search(SERVICE_TOKEN);
    expect(rec.kinds("search.returned").at(-1)).toMatchObject({ status: 403, client: "svc", patient: "p1", reason: "this patient is outside the client's authorized access" });
    await search("not-a-token");
    expect(rec.kinds("search.returned").at(-1)).toMatchObject({ status: 401, reason: "the token is not active" });
  });
  test("a signed URL takes the fast path, and the stream reports its parts, bytes and encoding", async () => {
    const bundle: any = await (await search(TOKEN)).json();
    const address = bundle.entry.find((e: any) => e.resource.resourceType === "Endpoint").resource.address;
    const ctx = address.split("/wado/")[1];
    const res = await proxy.fetch(new Request(`http://proxy/wado/${ctx}/studies/1.2.3`, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: ACCEPT } }));
    await drain(res);
    expect(rec.kinds("proxy.fast-path").at(-1)).toEqual(expect.objectContaining({ studyUid: "1.2.3", tokenHash: hash, contextHash: shortHash(ctx), taken: true }));
    const done = rec.kinds("stream.done").at(-1);
    expect(done).toMatchObject({ studyUid: "1.2.3", resource: "study", status: 200, authz: "instant", parts: 2, encoding: "identity", complete: true, contextHash: shortHash(ctx) });
    expect(done.bytes).toBeGreaterThan(8000);
    expect(rec.kinds("context.signed").some(c => c.contextHash === shortHash(ctx))).toBe(true);
  });
  test("a plain URL asks: the decision is answered with its AuthZEN request and response, and a refusal says so", async () => {
    const res = await proxy.fetch(new Request("http://proxy/wado/-/studies/1.2.4", { headers: { Authorization: `Bearer ${TOKEN}`, Accept: ACCEPT } }));
    expect(res.status).toBe(404);
    expect(rec.kinds("proxy.fast-path").at(-1)).toMatchObject({ taken: false, failed: "URL carries a signed context" });
    const d = rec.kinds("decision.answered").at(-1);
    expect(d).toMatchObject({ decision: false, study: "study-1.2.4", studyUid: "1.2.4", client: "app", user: "pat", patient: "p1", tokenHash: hash, service: "policy" });
    expect(d.request.subject.properties.access_token).toBe(`sha256:${hash}…`);
    expect(d.response.context.denial).toBe("not_released");
    expect(rec.kinds("proxy.decision").at(-1)).toMatchObject({ via: "asked", allowed: false, denial: "not_released" });
    expect(rec.kinds("retrieval.answered").at(-1)).toMatchObject({ studyUid: "1.2.4", resource: "study", status: 404, authz: "asked" });
  });
  test("a decision on an expired signed context holds the context and the token only as short hashes", async () => {
    const bundle: any = await (await search(TOKEN)).json();
    const ctx = bundle.entry.find((e: any) => e.resource.resourceType === "Endpoint").resource.address.split("/wado/")[1];
    clock.advance(store.getSettings().contextLifetimeSeconds + 1);
    await drain(await proxy.fetch(new Request(`http://proxy/wado/${ctx}/studies/1.2.3`, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: ACCEPT } })));
    const d = rec.kinds("decision.answered").at(-1);
    expect(d).toMatchObject({ decision: true, contextHash: shortHash(ctx), tokenHash: hash });
    expect(d.request.context.signed_context).toBe(`sha256:${shortHash(ctx)}…`);
    expect(d.request.subject.id).toBe(`sha256:${hash}…`);
    const all = JSON.stringify(rec.events);
    for (const secret of [ctx, ath(TOKEN), TOKEN, FRIEND_TOKEN, SERVICE_TOKEN]) expect([secret, all.includes(secret)]).toEqual([secret, false]);
  });
  test("events run in the span of the request that made them", () => {
    const s = rec.kinds("search.returned").at(-1);
    expect(rec.spans.find(x => x.id === s.span)?.kind).toBe("server");
  });
});
