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
import { resetClock } from "../src/clock";
import type { World } from "../src/world";

const root = join(import.meta.dir, "..");
const ACCEPT = "multipart/related; type=application/dicom; transfer-syntax=*";
const RULE = { id: "r1", when: { client: "c" }, allow: { all: true } };
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
    await a.policy.setRules([RULE]);
    await a.policy.setSettings({ maxSeriesInContext: 3 });
    expect(a.store.rules()).toEqual([RULE]);
    expect(b.store.rules()).toEqual([]);
    expect(stack.store.rules()).toEqual([]);
    await stack.policy.setRules([{ ...RULE, id: "root-rule" }]);
    expect(a.store.rules()).toEqual([RULE]);
    expect(b.store.rules()).toEqual([]);
    expect(stack.scopes.mint().store.rules()).toEqual([]);
    expect(b.store.getSettings().maxSeriesInContext).toBe(12);
    // Sharing on one scope's account page reaches only that scope's policy.
    const t = await scriptedLaunch("josh", "portal-app", { at: a.urls, sites: ["Lakeside Imaging"] });
    expect(t.access_token).toBeTruthy();
    expect(a.store.appGrants().length).toBe(1);
    expect(b.store.appGrants()).toEqual([]);
    expect(stack.store.appGrants()).toEqual([]);
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
      expect((await get(`${a.urls.imaging}/policy/v1/policy`, { headers: { Authorization: "Bearer x" } })).status).toBe(404);
      expect((await get(`${a.urls.proxy}/internal/keys/refresh`, { method: "POST" })).status).toBe(404);
    }
    // On its loopback port, a scope's policy API takes only that scope's credential.
    expect((await fetch(`http://127.0.0.1:${PORTS.imaging}/s/${a.scope}/policy/v1/policy`, { headers: { Authorization: "Bearer x" } })).status).toBe(401);
    expect((await a.policy.getPolicy()).rules).toEqual([]);
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
    const seed = encodeSeed({ rules: [RULE], contextLifetimeSeconds: 120 });
    expect(seed).toMatch(/^~[A-Za-z0-9_-]+$/);
    const first = stack.scopes.resolve(seed);
    expect("world" in first).toBe(true);
    const w = (first as { world: World }).world;
    expect(w.store.rules()).toEqual([RULE]);
    expect(w.store.getSettings().contextLifetimeSeconds).toBe(120);
    expect(w.store.guardians()).toEqual(stack.store.guardians());
    // Over HTTP, the same world.
    const conf: any = await (await get(`${w.urls.clinicalFhir}/.well-known/smart-configuration`)).json();
    expect(conf.issuer).toBe(w.urls.auth);
    expect(new URL(conf.issuer).pathname.startsWith(`/s/${seed}`)).toBe(true);
    await w.policy.setRules([]);
    expect((stack.scopes.resolve(seed) as { world: World }).world).toBe(w);
    expect(w.store.rules()).toEqual([]);
    expect(stack.store.rules()).toEqual([]);
  });
  test("a seed's guardians, when it names them, replace the ones on file", async () => {
    const w = (stack.scopes.resolve(encodeSeed({ guardians: [] })) as { world: World }).world;
    expect(w.store.guardians()).toEqual([]);
  });
  test("a seed that isn't a valid policy, or is too large, gets a 400 naming why", async () => {
    const raw = (doc: unknown) => `~${deflateRawSync(Buffer.from(JSON.stringify(doc))).toString("base64url")}`;
    for (const [seg, why] of [
      [raw({ rules: "nope" }), "rules must be an array"],
      [raw({ rules: [{ id: "x" }] }), "rules[0].when"],
      [raw([1, 2]), "JSON object"],
      [`~${deflateRawSync(Buffer.from("not json")).toString("base64url")}`, "isn't JSON"],
      ["~notdeflate", "deflate-raw"],
      [`~${"A".repeat(MAX_SEED_CHARS + 1)}`, "at most"],
      [raw({ rules: [{ ...RULE, description: "x".repeat(MAX_SEED_BYTES) }] }), `${MAX_SEED_BYTES} bytes`],
    ] as const) {
      const r = stack.scopes.resolve(seg);
      expect([why, "error" in r && r.status, "error" in r && r.error.includes(why)]).toEqual([why, 400, true]);
    }
    const over = await get(`${urlsFor(`/s/${raw({ rules: "nope" })}`).clinicalFhir}/.well-known/smart-configuration`);
    expect(over.status).toBe(400);
    expect(((await over.json()) as any).error).toContain("rules must be an array");
    expect(decodeSeed(encodeSeed({ rules: [RULE] }))).toEqual({ seed: { rules: [RULE] } });
  });
});

describe("scope lifetimes", () => {
  const shared = { catalog: () => createCatalog(), catalogSource: () => "archive" as const, backendName: () => "static-files" as const, backends: {} as any, clientKeys: new Map() };
  test("past the cap, the least recently used go first; an evicted id is gone, and an evicted seed builds again", () => {
    const scopes = createScopes(shared, { max: 2 });
    const a = scopes.mint(), b = scopes.mint();
    expect(scopes.resolve(a.scope!)).toMatchObject({ world: a });
    const c = scopes.mint();
    expect(scopes.size).toBe(2);
    expect(scopes.resolve(b.scope!)).toMatchObject({ status: 404 });
    expect(scopes.resolve(a.scope!)).toMatchObject({ world: a });
    expect(scopes.resolve(c.scope!)).toMatchObject({ world: c });
    const seed = encodeSeed({ rules: [RULE] });
    const s1 = (scopes.resolve(seed) as { world: World }).world;
    s1.store.setPolicy({ rules: [] });
    scopes.mint(); scopes.mint();
    const s2 = (scopes.resolve(seed) as { world: World }).world;
    expect(s2).not.toBe(s1);
    expect(s2.store.rules()).toEqual([RULE]);
    scopes.close();
  });
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
