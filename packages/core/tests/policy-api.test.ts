// The policy API, through its client and as raw HTTP, against one Imaging Server and its store.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createCatalog, createImagingServer, createPolicyClient, PolicyApiError, PolicyStore, type Guardian } from "../src";
import { put, recordingObserver } from "./support";

const SECRET = "s3cret";
const POLICY_SECRET = "p0licy";
const GUARDIAN: Guardian = { patient: "kid", guardian: "parent", relationship: "guardian", excludedStudies: ["study-3.1"] };
const catalog = createCatalog();
put(catalog, "1.1", { site: "Site A" }, "pat");
put(catalog, "2.1", { site: "Site B" }, "pat");
put(catalog, "3.1", { site: "Site C" }, "kid");
put(catalog, "4.1", { site: "Site D" }, "kid");
const main = new PolicyStore({ mode: "memory", guardians: [GUARDIAN] });
const other = new PolicyStore({ mode: "memory", guardians: [] });
const recorder = recordingObserver();
const imaging = createImagingServer({
  base: "http://imaging.test/fhir", clinicalFhirBase: "http://clinical.test/fhir", proxyBase: () => "http://proxy.test", introspect: async () => ({ active: false }),
  patientOf: u => ({ pat: "pat", kid: "kid" } as Record<string, string>)[u], serviceSecret: SECRET, policySecret: POLICY_SECRET, catalog: () => catalog, keyStore: main, store: () => main,
  observer: recorder.observer,
});
const http = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: imaging.fetch });
const base = `http://127.0.0.1:${http.port}`;
const policy = createPolicyClient({ base, policySecret: POLICY_SECRET });
const raw = (path: string, init: RequestInit = {}, secret = POLICY_SECRET) => fetch(`${base}/policy/v1${path}`, { ...init, headers: { Authorization: `Bearer ${secret}`, "content-type": "application/json", ...init.headers } });
afterAll(() => { http.stop(true); main.close(); other.close(); catalog.close(); });
beforeEach(() => { main.resetAll(); other.resetAll(); });

describe("the policy API", () => {
  test("needs the policy credential on every call, and refuses the proxy's service credential", async () => {
    for (const [path, method] of [["/policy", "GET"], ["/rules", "PUT"], ["/delegations", "POST"], ["/reset", "POST"], ["/nothing", "GET"]]) {
      expect((await raw(path!, { method }, "wrong")).status).toBe(401);
      expect((await raw(path!, { method }, SECRET)).status).toBe(401);
      expect((await fetch(`${base}/policy/v1${path}`, { method })).status).toBe(401);
    }
    expect(recorder.spans.filter(s => s.kind === "server" && s.name.startsWith("GET /policy/v1")).every(s => s.service === "policy")).toBe(true);
  });
  test("an empty filter from the client means no filter", async () => {
    const sent: string[] = [];
    const client = createPolicyClient({ base, policySecret: POLICY_SECRET, fetch: (_op, url, init) => { sent.push(url); return fetch(url, init); } });
    await client.removeDelegations({ grantedBy: "pat", delegate: "kid", patient: "" }).catch(() => {});
    expect(new URL(sent[0]!).searchParams.has("patient")).toBe(false);
  });
  test("acts on the one store it was given, whatever the query names", async () => {
    await policy.setRules([{ id: "r", when: { client: "c" }, allow: { all: true } }]);
    expect(main.rules().map(r => r.id)).toEqual(["r"]);
    expect(other.rules()).toEqual([]);
    expect((await (await raw("/policy?store=other")).json()).rules.map((r: any) => r.id)).toEqual(["r"]);
    expect((await policy.info()).counts.rules).toBe(1);
  });
  test("refuses a bad policy whole, naming each problem", async () => {
    const e = await policy.setPolicy({ rules: [{ id: "" } as any], contextLifetimeSeconds: 0 }).catch(x => x);
    expect(e).toBeInstanceOf(PolicyApiError);
    expect(e.status).toBe(400);
    expect(e.errors).toEqual(expect.arrayContaining(["rules[0].id must be a non-empty string", "contextLifetimeSeconds must be a whole number from 1 to 86400"]));
    expect((await raw("/policy", { method: "PUT", body: "{not json" })).status).toBe(400);
    expect((await raw("/rules", { method: "PUT", body: "{}" })).status).toBe(400);
    expect(main.getPolicy().rules).toEqual([]);
  });
  test("rules, settings and guardians", async () => {
    await policy.setRules([{ id: "a", when: { client: "c" }, allow: { all: true } }]);
    expect(await policy.updateRule("a", { withdrawn: true })).toBe(true);
    expect(await policy.updateRule("missing", { withdrawn: true })).toBe(false);
    expect(main.rules()).toEqual([{ id: "a", when: { client: "c" }, allow: { all: true }, withdrawn: true }]);
    await policy.setSettings({ maxSeriesInContext: 0, tokenLifetimeSeconds: 300 });
    expect(await policy.getSettings()).toMatchObject({ maxSeriesInContext: 0, tokenLifetimeSeconds: 300, contextLifetimeSeconds: 300 });
    await expect(policy.setSettings({ maxSeriesInContext: -1 })).rejects.toThrow("maxSeriesInContext");
    await policy.setGuardians([]);
    expect(main.guardians()).toEqual([]);
    await policy.reset();
    expect(main.guardians()).toEqual([GUARDIAN]);
    expect(main.rules()).toEqual([]);
  });
  test("a share comes only from the patient or a guardian, and only of sites they can give", async () => {
    expect(await policy.delegate({ patient: "pat", grantedBy: "pat", fhirUser: "Patient/pat", delegate: "friend", relationship: "friend", sites: ["Site A", "Site Z"] })).toBe(true);
    expect(await policy.delegate({ patient: "pat", grantedBy: "friend", fhirUser: "Patient/friend", delegate: "other", relationship: "friend", sites: ["Site A"] })).toBe(false);
    // The guardian can't share the site only a study confidential from them is at.
    expect(await policy.delegate({ patient: "kid", grantedBy: "parent", fhirUser: "RelatedPerson/parent", delegate: "sitter", relationship: "sitter", sites: ["Site C", "Site D"] })).toBe(true);
    expect(main.delegations()).toEqual([
      { patient: "pat", grantedBy: "pat", delegate: "friend", relationship: "friend", sites: ["Site A"] },
      { patient: "kid", grantedBy: "parent", delegate: "sitter", relationship: "sitter", sites: ["Site D"], asGuardian: true },
    ]);
    expect(await policy.relationships()).toEqual(expect.arrayContaining([{ patient: "kid", delegate: "parent", relationship: "guardian" }, { patient: "pat", delegate: "friend", relationship: "friend" }]));
    expect((await policy.access("friend", "RelatedPerson/friend")).records).toEqual([{ patient: "pat", via: "delegation", relationship: "friend", sites: ["Site A"] }]);
    expect(await policy.removeDelegations({ grantedBy: "pat", delegate: "friend" })).toBe(true);
    expect(await policy.removeDelegations({ grantedBy: "pat", delegate: "friend" })).toBe(false);
    expect((await raw("/delegations?delegate=sitter", { method: "DELETE" })).status).toBe(400);
  });
  test("an app grant narrows to what the user holds, and all of it is no limit", async () => {
    expect(await policy.grantApp({ client: "app", user: "pat", fhirUser: "Patient/pat", patient: "pat", sites: ["Site A", "Site Z"] })).toBe(true);
    expect(main.appGrants()).toEqual([{ client: "app", user: "pat", patient: "pat", sites: ["Site A"] }]);
    expect(await policy.grantApp({ client: "app", user: "pat", fhirUser: "Patient/pat", patient: "pat", sites: ["Site A", "Site B"] })).toBe(true);
    expect(main.appGrants()).toEqual([{ client: "app", user: "pat", patient: "pat" }]);
    expect(await policy.grantApp({ client: "app", user: "stranger", fhirUser: "Patient/stranger", patient: "pat" })).toBe(false);
    expect(await policy.removeAppGrants({ client: "app", user: "pat", patient: "pat" })).toBe(true);
    expect(await policy.removeAppGrants({ client: "app", user: "pat" })).toBe(false);
  });
  test("explains each study's release for a client and a user", async () => {
    await policy.grantApp({ client: "app", user: "pat", fhirUser: "Patient/pat", patient: "pat", sites: ["Site B"] });
    const x = await policy.explain({ client: "app", user: "pat", fhirUser: "Patient/pat", patient: "pat" });
    expect(Object.fromEntries(x.studies.map((s: any) => [s.id, s.release]))).toEqual({ "study-1.1": "none", "study-2.1": "study" });
    await expect(policy.explain({ client: "app", patient: "" })).rejects.toThrow("client and patient are required");
  });
  test("a reset with tokens clears token records too", async () => {
    main.putToken("t", "access", { client_id: "c", scope: "s" });
    await policy.reset();
    expect(main.getToken("t", "access")).toBeDefined();
    await policy.reset({ tokens: true });
    expect(main.getToken("t", "access")).toBeUndefined();
    expect((await raw("/reset", { method: "POST", body: JSON.stringify({ everything: true }) })).status).toBe(400);
  });
});
