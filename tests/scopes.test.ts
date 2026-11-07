// Policy scopes: `/s/{scope}/` in front of any path is a world of its own. Nothing one world issues
// works in another, and every URL a scope issues stays in it. These run in either layout: the one
// origin, or DEMO_ONE_ORIGIN=0 with each service on its own port.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { createCatalog } from "@smart-imaging-proxy/core";
import { startStack, type Stack } from "../src/stack";
import { registerClients } from "../src/flows";
import { createDemoServer } from "../src/demo-server";
import { buildAuthorization, scriptedLaunch, submitConsent, tokenRequestBody } from "../src/flows/oauth";
import { CONFIG, localUrl, ONE_ORIGIN, PORTS, urlsFor } from "../src/config";
import { createScopes, decodeSeed, encodeSeed, MAX_SEED_BYTES, MAX_SEED_CHARS, splitScope } from "../src/scopes";
import { flushTraces } from "../src/trace";
import { TraceStore } from "../src/trace-store";
import { resetClock } from "../src/clock";
import type { World } from "../src/world";

const root = join(import.meta.dir, "..");
const ACCEPT = "multipart/related; type=application/dicom; transfer-syntax=*";
/** A relationship as a fact, without the ids and times its world gave it. */
const fact = ({ id: _, recordedAt: __, ...r }: any) => r;
const RULE = { id: "r1", type: "service-access" as const, service: "service:c", patients: "any" as const, allow: { all: true } };
const services = (store: { policiesOf(type: "service-access"): unknown[] }) => store.policiesOf("service-access");
let stack: Stack; let demo: Bun.Server;
beforeAll(async () => {
  stack = await startStack(root);
  demo = Bun.serve({ port: PORTS.demo, hostname: "127.0.0.1", fetch: createDemoServer(stack, registerClients(stack), root).fetch });
});
afterAll(() => { demo.stop(true); stack.stop(); });
beforeEach(async () => { await stack.resetAll(); resetClock(); stack.setBackend("static-files"); });

const get = (url: string, init: RequestInit = {}) => fetch(localUrl(url), { redirect: "manual", ...init });
const searchIn = async (w: { urls: World["urls"] }, token: string) => get(`${w.urls.imaging}/fhir/ImagingStudy?patient=josh-example&_include=ImagingStudy:endpoint&_count=2`, { headers: { Authorization: `Bearer ${token}` } });
const rootWorld = () => stack.root;

describe("isolation", () => {
  test("a token from one scope works in no other scope, and not at the root", async () => {
    const a = stack.scopes.mint(), b = stack.scopes.mint();
    const t = await scriptedLaunch("josh", "portal-app", { at: a.urls });
    expect((await searchIn(a, t.access_token)).status).toBe(200);
    expect((await searchIn(b, t.access_token)).status).toBe(401);
    expect((await searchIn(rootWorld(), t.access_token)).status).toBe(401);
    // And the root's works only at the root.
    const r = await scriptedLaunch("josh");
    expect((await searchIn(rootWorld(), r.access_token)).status).toBe(200);
    expect((await searchIn(a, r.access_token)).status).toBe(401);
  });
  test("an authorization code from one scope can't be redeemed in another", async () => {
    const a = stack.scopes.mint(), b = stack.scopes.mint();
    const conf: any = await (await get(`${a.urls.clinicalFhir}/.well-known/smart-configuration`)).json();
    const auth = buildAuthorization(conf.authorization_endpoint, "portal-app", undefined, undefined, "josh", undefined, a.urls);
    const back = await submitConsent(auth.url, { user: "josh" });
    const code = back.searchParams.get("code")!;
    expect(code).toBeTruthy();
    for (const w of [b, rootWorld()]) {
      const r = await get(w.auth.tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: tokenRequestBody(auth, code) });
      expect(r.status).toBe(400);
      expect(((await r.json()) as any).error).toBe("invalid_grant");
    }
    const ok = await get(a.auth.tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: tokenRequestBody(auth, code) });
    expect(ok.status).toBe(200);
  });
  test("a signed URL from one scope is instant there, and nothing elsewhere, even moved to another scope's prefix", async () => {
    const a = stack.scopes.mint(), b = stack.scopes.mint();
    const t = await scriptedLaunch("josh", "portal-app", { at: a.urls });
    const bundle: any = await (await searchIn(a, t.access_token)).json();
    const study = bundle.entry.find((e: any) => e.resource.resourceType === "ImagingStudy").resource;
    const address: string = bundle.entry.find((e: any) => e.fullUrl === study.endpoint[0].reference).resource.address;
    const uid = study.identifier[0].value.replace("urn:oid:", "");
    expect(address.startsWith(`${a.urls.proxy}/wado/`)).toBe(true);
    const retrieve = (url: string) => get(`${url}/studies/${uid}`, { headers: { Authorization: `Bearer ${t.access_token}`, Accept: ACCEPT } });
    const ok = await retrieve(address);
    expect(ok.status).toBe(200);
    await ok.body?.cancel();
    expect(a.proxy.events.at(-1)!.authz).toBe("instant");
    const ctx = address.split("/wado/")[1];
    for (const w of [b, rootWorld()]) {
      const r = await retrieve(`${w.urls.proxy}/wado/${ctx}`);
      expect(r.status).toBe(401);
      await r.body?.cancel();
      expect(w.proxy.events.at(-1)!.authz).toBe("asked");
    }
  });
  test("a policy change in one scope is invisible in another and at the root, and the root's in every scope", async () => {
    const a = stack.scopes.mint(), b = stack.scopes.mint();
    await a.policy.replacePolicies("service-access", [RULE]);
    await a.policy.setSettings({ maxSeriesInContext: 3 });
    expect(services(a.store)).toEqual([RULE]);
    expect(services(b.store)).toEqual([]);
    expect(services(stack.store)).toEqual([]);
    await stack.policy.replacePolicies("service-access", [{ ...RULE, id: "root-rule" }]);
    expect(services(a.store)).toEqual([RULE]);
    expect(services(b.store)).toEqual([]);
    expect(services(stack.scopes.mint().store)).toEqual([]);
    expect(b.store.getSettings().maxSeriesInContext).toBe(12);
    // Sharing on one scope's account page reaches only that scope's policy.
    const t = await scriptedLaunch("josh", "portal-app", { at: a.urls, sites: ["Lakeside Imaging"] });
    expect(t.access_token).toBeTruthy();
    expect(a.store.approvals().length).toBe(1);
    expect(b.store.approvals()).toEqual([]);
    expect(stack.store.approvals()).toEqual([]);
  });
  test("each scope signs with a key of its own, and serves only its own JWKS", async () => {
    const a = stack.scopes.mint(), b = stack.scopes.mint();
    const jwks = async (w: World) => ((await (await get(`${w.urls.imaging}/.well-known/jwks.json`)).json()) as any).keys.map((k: any) => k.kid);
    expect(await jwks(a)).toEqual([a.imaging.signingKid]);
    expect(await jwks(b)).toEqual([b.imaging.signingKid]);
    expect(await jwks(rootWorld())).toEqual([stack.imaging.signingKid]);
    expect(new Set([a.imaging.signingKid, b.imaging.signingKid, stack.imaging.signingKid]).size).toBe(3);
  });
  test("a scope can't hold another, and the internal APIs stay off the one origin in a scope too", async () => {
    const a = stack.scopes.mint(), b = stack.scopes.mint();
    expect((await get(`${a.urls.auth}/s/${b.scope}/fhir/.well-known/smart-configuration`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${PORTS.auth}/s/${a.scope}/s/${b.scope}/fhir/.well-known/smart-configuration`)).status).toBe(404);
    if (ONE_ORIGIN) {
      expect((await get(`${a.urls.imaging}/policy/v2/document`, { headers: { Authorization: "Bearer x" } })).status).toBe(404);
      expect((await get(`${a.urls.proxy}/internal/keys/refresh`, { method: "POST" })).status).toBe(404);
    }
    // On its loopback port, a scope's policy API takes only that scope's credential.
    expect((await fetch(`http://127.0.0.1:${PORTS.imaging}/s/${a.scope}/policy/v2/document`, { headers: { Authorization: "Bearer x" } })).status).toBe(401);
    expect((await a.policy.policies("service-access"))).toEqual([]);
  });
});

describe("the backend", () => {
  test("a scope picks its own, the root's stays as it was, and a new scope starts on the root's", async () => {
    const w = stack.scopes.mint();
    const pick = (base: string, backend: string) => get(`${base}/api/backend`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ backend }) });
    expect((await pick(w.urls.demo, "orthanc")).status).toBe(200);
    expect([w.backend, w.catalogSource]).toEqual(["orthanc", "orthanc"]);
    expect([stack.backend, stack.catalogSource, stack.root.backend]).toEqual(["static-files", "archive", "static-files"]);
    expect(((await (await get(`${w.urls.demo}/api/backends`)).json()) as any).current).toBe("orthanc");
    expect(((await (await get(`${CONFIG.demoUrl}/api/backends`)).json()) as any).current).toBe("static-files");
    expect(((await (await get(`${w.urls.demo}/api/flows`)).json()) as any).backend).toBe("orthanc");
    stack.setBackend("s3");
    expect(stack.scopes.mint().backend).toBe("s3");
    expect(w.backend).toBe("orthanc");
  });
});

describe("a scope's rest of path", () => {
  test("is never read as another origin, so the write guard and the internal-path block still hold", async () => {
    const a = stack.scopes.mint();
    const evil = { method: "POST", headers: { origin: "http://evil.example", "content-type": "application/json" }, body: "{}" };
    expect((await get(`${CONFIG.demoUrl}/api/scopes`, evil)).status).toBe(403);
    const before = stack.scopes.size;
    const sneaky = await get(`${urlsFor(`/s/${a.scope}`).demo}//evil.example/api/scopes`, evil);
    expect([403, 404]).toContain(sneaky.status);
    expect(stack.scopes.size).toBe(before);
    for (const path of ["//h/policy/v2/document", "//127.0.0.1/policy/v2/document"]) {
      expect([path, (await get(`${a.urls.imaging}${path}`, { headers: { Authorization: "Bearer x" } })).status]).toEqual([path, 404]);
      expect([path, (await get(`${CONFIG.imagingUrl}${path}`, { headers: { Authorization: "Bearer x" } })).status]).toEqual([path, 404]);
    }
    // On a service's own port, too.
    expect((await fetch(`http://127.0.0.1:${PORTS.imaging}/s/${a.scope}//h/policy/v2/document`, { headers: { Authorization: "Bearer x" } })).status).toBe(404);
  });
});

describe("every URL a scope issues carries its prefix", () => {
  test("discovery, the authorize redirects, a search Bundle and its Endpoint.address, and a next link", async () => {
    const w = stack.scopes.mint();
    const prefix = `/s/${w.scope}`;
    const conf: any = await (await get(`${w.urls.clinicalFhir}/.well-known/smart-configuration`)).json();
    for (const k of ["issuer", "authorization_endpoint", "token_endpoint", "introspection_endpoint", "revocation_endpoint"]) expect([k, new URL(conf[k]).pathname.startsWith(prefix)]).toEqual([k, true]);
    expect(conf.associated_endpoints[0].url).toBe(`${w.urls.imaging}/fhir`);
    const meta: any = await (await get(`${w.urls.imaging}/fhir/metadata`)).json();
    expect(meta.implementation.url).toBe(`${w.urls.imaging}/fhir`);
    const authz: any = await (await get(`${w.urls.imaging}/.well-known/authzen-configuration`)).json();
    expect(authz.access_evaluation_endpoint).toBe(`${w.urls.imaging}/access/v1/evaluation`);

    // Each redirect and form on the way, through the sign-in and consent pages.
    const a = buildAuthorization(conf.authorization_endpoint, "portal-app", undefined, undefined, "josh", undefined, w.urls);
    const signIn = await get(a.url);
    const html = await signIn.text();
    const actions = [...html.matchAll(/action="([^"]+)"/g)].map(m => m[1]!);
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) expect(action.startsWith(`${prefix}/`)).toBe(true);
    const back = await submitConsent(a.url, { user: "josh" });
    expect(back.toString().startsWith(`${w.urls.callback}?`)).toBe(true);
    const signed = await get(new URL(actions[0]!.replaceAll("&amp;", "&"), a.url).toString(), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "username=josh" });
    expect(signed.status).toBe(303);
    expect(signed.headers.get("location")!.startsWith(`${prefix}/authorize/consent`)).toBe(true);
    const account = await get(`${w.urls.auth}/account/signin`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "username=josh" });
    expect(account.headers.get("location")!.startsWith(`${prefix}/account`)).toBe(true);
    expect(account.headers.get("set-cookie")).toContain(`Path=${prefix}`);

    const t = await scriptedLaunch("josh", "portal-app", { at: w.urls });
    const bundle: any = await (await searchIn(w, t.access_token)).json();
    for (const l of bundle.link) expect([l.relation, l.url.startsWith(`${w.urls.imaging}/fhir/ImagingStudy?`)]).toEqual([l.relation, true]);
    expect(bundle.link.some((l: any) => l.relation === "next")).toBe(true);
    for (const e of bundle.entry) {
      if (e.resource.resourceType === "ImagingStudy") {
        expect(e.fullUrl.startsWith(`${w.urls.imaging}/fhir/ImagingStudy/`)).toBe(true);
        expect(e.resource.subject.reference).toBe(`${w.urls.clinicalFhir}/Patient/josh-example`);
      } else expect(e.resource.address.startsWith(`${w.urls.proxy}/wado/`)).toBe(true);
    }
    const next: any = await (await get(bundle.link.find((l: any) => l.relation === "next").url, { headers: { Authorization: `Bearer ${t.access_token}` } })).json();
    expect(next.entry.length).toBeGreaterThan(0);
    expect(JSON.stringify([conf, bundle, next])).not.toMatch(new RegExp(`${CONFIG.authUrl.replace(/[.:/]/g, "\\$&")}/(fhir|authorize|token)`));
  });
  test("metadata's bulk links go through the scope's proxy", async () => {
    const w = stack.scopes.mint();
    const t = await scriptedLaunch("josh", "portal-app", { at: w.urls });
    const bundle: any = await (await get(`${w.urls.imaging}/fhir/ImagingStudy?patient=josh-example&_include=ImagingStudy:endpoint`, { headers: { Authorization: `Bearer ${t.access_token}` } })).json();
    const study = bundle.entry.find((e: any) => e.resource.id === "xr-wrist-left-2012").resource;
    const address = bundle.entry.find((e: any) => e.fullUrl === study.endpoint[0].reference).resource.address;
    const uid = study.identifier[0].value.replace("urn:oid:", "");
    const meta: any[] = await (await get(`${address}/studies/${uid}/metadata`, { headers: { Authorization: `Bearer ${t.access_token}` } })).json();
    const uris = JSON.stringify(meta).match(/"BulkDataURI":"([^"]+)"/g) ?? [];
    expect(uris.length).toBeGreaterThan(0);
    for (const u of uris) expect(u).toContain(`${w.urls.proxy}/wado/`);
  });
});

describe("inline seeds", () => {
  test("a seed builds its world on first use, the same one after, and its changes stay there", async () => {
    const seed = encodeSeed({ policies: [RULE], contextLifetimeSeconds: 120 });
    expect(seed).toMatch(/^~[A-Za-z0-9_-]+$/);
    const first = stack.scopes.resolve(seed);
    expect("world" in first).toBe(true);
    const w = (first as { world: World }).world;
    expect(services(w.store)).toEqual([RULE]);
    expect(w.store.getSettings().contextLifetimeSeconds).toBe(120);
    expect(w.store.relationships().map(fact)).toEqual(stack.store.relationships().map(fact));
    expect(w.store.policies()).toEqual([RULE]);
    // Over HTTP, the same world.
    const conf: any = await (await get(`${w.urls.clinicalFhir}/.well-known/smart-configuration`)).json();
    expect(conf.issuer).toBe(w.urls.auth);
    expect(new URL(conf.issuer).pathname.startsWith(`/s/${seed}`)).toBe(true);
    await w.policy.replacePolicies("service-access", []);
    expect((stack.scopes.resolve(seed) as { world: World }).world).toBe(w);
    expect(services(w.store)).toEqual([]);
    expect(services(stack.store)).toEqual([]);
  });
  test("a seed's relationships and policies, when it names them, replace the ones on file, and its choices go in beside them", async () => {
    const share = { from: "user:josh", with: "user:alex-neighbor", patient: "patient:josh-example", sites: ["Lakeside Imaging"], label: "friend" };
    const w = (stack.scopes.resolve(encodeSeed({ relationships: [], shares: [share] })) as { world: World }).world;
    expect(w.store.relationships()).toEqual([]);
    expect(w.store.policies()).toEqual(stack.store.policies());
    expect(w.store.shares()).toMatchObject([{ ...share, basis: "self" }]);
    // A reset there puts the seed's facts back, and clears its choices.
    w.store.putRelationship({ subject: "user:sam-caregiver", relation: "guardian_of", object: "patient:riley-example" });
    w.store.resetPolicy();
    expect([w.store.relationships(), w.store.shares()]).toEqual([[], []]);
    const g = (stack.scopes.resolve(encodeSeed({ policies: [] })) as { world: World }).world;
    expect([g.store.policies(), g.store.relationships().map(fact)]).toEqual([[], stack.store.relationships().map(fact)]);
  });
  test("a seed that isn't a valid policy, or is too large, gets a 400 naming why", async () => {
    const raw = (doc: unknown) => `~${deflateRawSync(Buffer.from(JSON.stringify(doc))).toString("base64url")}`;
    for (const [seg, why] of [
      [raw({ policies: "nope" }), "policies must be an array"],
      [raw({ policies: [{ id: "x" }] }), "policies[0]"],
      [raw({ rules: [RULE] }), 'unknown field "rules"'],
      [raw({ contextLifetimeSeconds: "soon" }), "contextLifetimeSeconds"],
      [raw([1, 2]), "JSON object"],
      [`~${deflateRawSync(Buffer.from("not json")).toString("base64url")}`, "isn't JSON"],
      ["~notdeflate", "deflate-raw"],
      [`~${"A".repeat(MAX_SEED_CHARS + 1)}`, "at most"],
      [raw({ policies: [{ ...RULE, description: "x".repeat(MAX_SEED_BYTES) }] }), `${MAX_SEED_BYTES} bytes`],
    ] as const) {
      const r = stack.scopes.resolve(seg);
      expect([why, "error" in r && r.status, "error" in r && r.error.includes(why)]).toEqual([why, 400, true]);
    }
    const over = await get(`${urlsFor(`/s/${raw({ policies: "nope" })}`).clinicalFhir}/.well-known/smart-configuration`);
    expect(over.status).toBe(400);
    expect(((await over.json()) as any).error).toContain("policies must be an array");
    expect(decodeSeed(encodeSeed({ policies: [RULE] }))).toEqual({ seed: { policies: [RULE] } });
  });
});

describe("scope lifetimes", () => {
  const catalog = createCatalog();
  const shared = { catalogs: { archive: catalog, orthanc: catalog }, backends: {} as any, clientKeys: new Map(), initialBackend: () => "static-files" as const };
  test("past the cap, the least recently used go first; an evicted id is gone, and an evicted seed builds again", () => {
    const scopes = createScopes(shared, { max: 2, maxSeeds: 1 });
    const a = scopes.mint(), b = scopes.mint();
    expect(scopes.resolve(a.scope!)).toMatchObject({ world: a });
    const c = scopes.mint();
    expect(scopes.size).toBe(2);
    expect(scopes.resolve(b.scope!)).toMatchObject({ status: 404 });
    expect(scopes.resolve(a.scope!)).toMatchObject({ world: a });
    expect(scopes.resolve(c.scope!)).toMatchObject({ world: c });
    const seed = encodeSeed({ policies: [RULE] });
    const s1 = (scopes.resolve(seed) as { world: World }).world;
    s1.store.setDocument({ policies: [] });
    scopes.resolve(encodeSeed({ policies: [] }));
    const s2 = (scopes.resolve(seed) as { world: World }).world;
    expect(s2).not.toBe(s1);
    expect(services(s2.store)).toEqual([RULE]);
    scopes.close();
  });
  test("seeds have a pool of their own, so any number of them never evicts a minted scope", () => {
    const scopes = createScopes(shared, { max: 2, maxSeeds: 2 });
    const a = scopes.mint(), b = scopes.mint();
    for (let i = 0; i < 10; i++) expect("world" in scopes.resolve(encodeSeed({ contextLifetimeSeconds: 60 + i }))).toBe(true);
    expect(scopes.resolve(a.scope!)).toMatchObject({ world: a });
    expect(scopes.resolve(b.scope!)).toMatchObject({ world: b });
    expect(scopes.size).toBe(4);
    // The seeds' own cap still holds, least recently used first, and a dropped one builds again.
    const kept = encodeSeed({ contextLifetimeSeconds: 69 });
    const w = (scopes.resolve(kept) as { world: World }).world;
    expect((scopes.resolve(kept) as { world: World }).world).toBe(w);
    scopes.resolve(encodeSeed({ contextLifetimeSeconds: 1 })); scopes.resolve(encodeSeed({ contextLifetimeSeconds: 2 }));
    expect((scopes.resolve(kept) as { world: World }).world).not.toBe(w);
    scopes.close();
  });
  test("a flow run survives a page full of seeds", async () => {
    const r = await get(`${CONFIG.demoUrl}/api/flows/patient-sites/start`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const { scope } = (await r.json()) as any;
    for (let i = 0; i < 70; i++) expect(await get(`${urlsFor(`/s/${encodeSeed({ contextLifetimeSeconds: 100 + i })}`).clinicalFhir}/.well-known/smart-configuration`).then(x => x.status)).toBe(200);
    expect(((await (await get(`${CONFIG.demoUrl}${scope.base}/api/flow-state`)).json()) as any).flow).toBe("patient-sites");
  }, 60000);
  test("an idle scope is dropped", async () => {
    const scopes = createScopes(shared, { idleMs: 40 });
    const a = scopes.mint(), b = scopes.mint();
    await Bun.sleep(25);
    scopes.resolve(b.scope!);
    await Bun.sleep(25);
    expect(scopes.resolve(a.scope!)).toMatchObject({ status: 404 });
    expect(scopes.resolve(b.scope!)).toMatchObject({ world: b });
    scopes.close();
  });
  test("an unknown scope gets a clear 404 at every service", async () => {
    const id = "B".repeat(22);
    const w = urlsFor(`/s/${id}`);
    for (const u of [`${w.clinicalFhir}/.well-known/smart-configuration`, `${w.demo}/api/flow-state`, `${w.imaging}/fhir/metadata`, `${w.proxy}/wado/-/studies/1.2`, `${w.trace}/api/sessions`, `http://127.0.0.1:${PORTS.imaging}/s/${id}/fhir/metadata`]) {
      const r = await get(u);
      expect([u, r.status]).toEqual([u, 404]);
      expect(((await r.json()) as any).error).toContain("doesn't exist");
    }
    expect(splitScope("/s/x/a")).toEqual({ scope: "x", rest: "/a" });
    expect(splitScope("/s/x")).toEqual({ scope: "x", rest: "/" });
    expect(splitScope("/a/s/x")).toEqual({ rest: "/a/s/x" });
  });
});

describe("trace sessions belong to the world that recorded them", () => {
  const settle = async () => { flushTraces(); await Bun.sleep(150); };
  test("each scope has its own unattributed bucket, and the root's stays the root's", async () => {
    const w = stack.scopes.mint();
    await get(`${CONFIG.imagingUrl}/fhir/metadata`);
    await get(`${w.urls.imaging}/fhir/metadata`);
    await settle();
    expect(stack.collector.scopeOf("unattributed")).toBeUndefined();
    const listed = ((await (await get(`${urlsFor(`/s/${w.scope}`).trace}/api/sessions`)).json()) as any[]).map(x => x.id);
    expect(listed).not.toContain("unattributed");
    expect(listed.length).toBe(1);
    expect(stack.collector.scopeOf(listed[0])).toBe(w.scope);
    expect([...stack.collector.sessions.get(listed[0])!.spans.values()].every(x => x.scope === w.scope)).toBe(true);
  });
  test("baggage naming a root session, sent to a scope, can't move that session into the scope", async () => {
    const w = stack.scopes.mint();
    const victim = `victim-${Date.now()}`;
    const baggage = { baggage: `demo.session=${victim}` };
    await get(`${CONFIG.imagingUrl}/fhir/metadata`, { headers: baggage });
    await get(`${w.urls.imaging}/fhir/metadata`, { headers: baggage });
    await settle();
    expect(stack.collector.scopeOf(victim)).toBeUndefined();
    expect([...stack.collector.sessions.get(victim)!.spans.values()].every(x => !x.scope)).toBe(true);
    const listed = ((await (await get(`${urlsFor(`/s/${w.scope}`).trace}/api/sessions`)).json()) as any[]).map(x => x.id);
    expect(listed).not.toContain(victim);
  });
  test("spans are taken only from the services, and never through the one origin", async () => {
    const forged = JSON.stringify([{ session: "unattributed", scope: "x", trace: "t".repeat(32), span: "f".repeat(16), service: "demo", kind: "check", name: "forged", start: 1, end: 2, attrs: {} }]);
    expect((await fetch(`http://127.0.0.1:${PORTS.trace}/v1/spans`, { method: "POST", headers: { "content-type": "application/json" }, body: forged })).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${PORTS.trace}/v1/spans`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer guess" }, body: forged })).status).toBe(401);
    if (ONE_ORIGIN) expect((await get(`${CONFIG.traceUrl}/v1/spans`, { method: "POST", headers: { "content-type": "application/json" }, body: forged })).status).toBe(404);
    await settle();
    expect([...(stack.collector.sessions.get("unattributed")?.spans.values() ?? [])].some(x => x.name === "forged")).toBe(false);
  });
  test("the root keeps its own budget of sessions, whatever the scopes do", () => {
    const store = new TraceStore({ mode: "memory", maxSessions: 2, flushMs: 1 });
    const span = (session: string, start: number, scope?: string) => { const r = { session, trace: "t".repeat(32), span: `s${start}`, service: "demo" as const, kind: "check" as const, name: "n", start, end: start, attrs: {}, ...(scope ? { scope } : {}) }; store.put(r, JSON.stringify(r)); store.flush(); };
    span("root-1", 1); span("root-2", 2);
    for (let i = 0; i < 5; i++) span(`busy-${i}@S`, 10 + i, "S");
    const ids = store.sessions().map(x => x.id);
    expect(ids).toContain("root-1");
    expect(ids).toContain("root-2");
    expect(ids.filter(id => id.endsWith("@S")).length).toBe(2);
    span("root-3", 30);
    expect(store.sessions().map(x => x.id).filter(id => !id.includes("@")).sort()).toEqual(["root-2", "root-3"]);
    store.close();
  });
});

describe("the trace, filtered to a scope", () => {
  test("a scope's live trace lists only its sessions, and won't show another's", async () => {
    const r = await get(`${CONFIG.demoUrl}/api/flows/patient-sites/start`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const { scope, session } = (await r.json()) as any;
    const other = stack.scopes.mint();
    await scriptedLaunch("josh", "portal-app", { at: other.urls });
    await scriptedLaunch("josh");
    flushTraces();
    await Bun.sleep(150);
    const traceOf = (prefix: string) => urlsFor(prefix).trace;
    const listed = async (prefix: string) => ((await (await get(`${traceOf(prefix)}/api/sessions`)).json()) as any[]).map(s => s.id);
    const mine = await listed(scope.base);
    expect(mine).toContain(session);
    for (const id of mine) expect(stack.collector.scopeOf(id)).toBe(scope.id);
    expect(await listed(`/s/${other.scope}`)).not.toContain(session);
    expect((await listed("")).length).toBeGreaterThan(mine.length);
    expect((await get(`${traceOf(`/s/${other.scope}`)}/api/sessions/${encodeURIComponent(session)}/spans`)).status).toBe(404);
    expect((await get(`${traceOf(scope.base)}/api/sessions/${encodeURIComponent(session)}/spans`)).status).toBe(200);
    expect((await get(`${traceOf(scope.base)}/v1/spans`, { method: "POST", body: "[]" })).status).toBe(404);
    expect((await get(`${traceOf(scope.base)}/`)).status).toBe(200);
  });
});
