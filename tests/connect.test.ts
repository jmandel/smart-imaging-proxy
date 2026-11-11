// Apps registered in a sandbox: they work there, only there, and starting over leaves them alone.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { addClient, listClients, removeClient } from "../src/clients";
import { createDemoServer } from "../src/demo-server";
import { registerClients } from "../src/flows";
import { CONFIG } from "../src/config";
import { startStack, type Stack } from "../src/stack";
import { adminFor } from "./admin-token";

let stack: Stack, demo: ReturnType<typeof createDemoServer>;
beforeAll(async () => { stack = await startStack(join(import.meta.dir, "..")); demo = createDemoServer(stack, registerClients(stack), join(import.meta.dir, "..")); });
afterAll(() => stack.stop());
const call = async (method: string, path: string, body?: unknown) => demo.fetch(new Request(`${CONFIG.demoUrl}${path}`, { method, headers: { ...(await adminFor(demo, path)), ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
const REDIRECT = "https://app.example/callback";
const authorize = (w: ReturnType<Stack["scopes"]["mint"]>, client: string, redirect = REDIRECT) => {
  const u = new URL(`${w.urls.auth}/authorize`);
  Object.entries({ client_id: client, redirect_uri: redirect, response_type: "code", state: "s", code_challenge: "c", code_challenge_method: "S256", aud: `${w.urls.auth}/fhir`, scope: "launch/patient patient/*.rs" }).forEach(([k, v]) => u.searchParams.set(k, v));
  return fetch(u, { redirect: "manual" });
};

test("redirect URIs and names are checked", () => {
  const w = stack.sandboxes.mint();
  for (const redirectUris of [["http://app.example/cb"], ["https://app.example/cb#x"], ["not a url"], [], ["*", REDIRECT]]) expect(addClient(w.store, { name: "A", redirectUris })).toHaveProperty("error");
  expect(addClient(w.store, { name: "", redirectUris: [REDIRECT] })).toHaveProperty("error");
  expect(addClient(w.store, { name: "Local", redirectUris: ["http://localhost:3000/cb"] })).toHaveProperty("id");
  expect(addClient(w.store, { name: "Open", redirectUris: ["*"] })).toHaveProperty("redirectUris", ["*"]);
});
test("a registered app can register multiple redirect URIs, and sign in with any of them", async () => {
  const w = stack.sandboxes.mint(), other = stack.sandboxes.mint();
  const second = "http://localhost:3000/callback";
  const r = await call("POST", `${w.prefix}/register`, { client_name: "My app", redirect_uris: [REDIRECT, second, REDIRECT] });
  expect(r.status).toBe(201);
  const { client_id: id, redirect_uris } = await r.json() as any;
  expect(redirect_uris).toEqual([REDIRECT, second]);
  expect((await authorize(w, id, REDIRECT)).status).toBe(200);
  expect((await authorize(w, id, second)).status).toBe(200);
  expect((await authorize(w, id, "https://evil.example/cb")).status).toBe(400);
  expect((await authorize(other, id)).status).toBe(400);
  expect((await (await call("GET", `${w.prefix}/api/sandbox/clients`)).json() as any).clients.map((c: any) => c.id)).toEqual([id]);
});
test("an app registered with redirect_uris [\"*\"] accepts any safe redirect URI at /authorize, and still binds the code at /token", async () => {
  const w = stack.sandboxes.mint(), S = w.urls.auth;
  const badMix = await call("POST", `${w.prefix}/register`, { client_name: "Mixed", redirect_uris: ["*", REDIRECT] });
  expect([badMix.status, ((await badMix.json()) as any).error]).toEqual([400, "invalid_redirect_uri"]);
  const made = await call("POST", `${w.prefix}/register`, { client_name: "Open dev app", redirect_uris: ["*"] });
  expect(made.status).toBe(201);
  const { client_id: id, redirect_uris } = await made.json() as any;
  expect(redirect_uris).toEqual(["*"]);
  for (const ok of ["https://anywhere.example/cb", "http://192.168.1.50:5173/cb", "myapp://callback", "com.example.app:/oauth2redirect"]) {
    expect((await authorize(w, id, ok)).status).toBe(200);
  }
  for (const unsafe of ["javascript:alert(1)", "JAVASCRIPT:alert(1)", "data:text/html,hi", "blob:https://app.example/1", "file:///etc/passwd", "about:blank", "https://anywhere.example/cb#frag", "myapp://callback#frag", "/relative", ""]) {
    const res = await authorize(w, id, unsafe);
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  }
  // Full PKCE code flow with a custom-scheme redirect URI: /token still checks redirect_uri matches /authorize.
  const customRedirect = "com.example.app:/oauth2redirect";
  const verifier = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64url");
  const challenge = require("node:crypto").createHash("sha256").update(verifier).digest("base64url");
  const url = new URL(`${S}/authorize`);
  Object.entries({ response_type: "code", client_id: id, redirect_uri: customRedirect, scope: "launch/patient patient/*.rs", aud: `${S}/fhir`, state: "st", code_challenge: challenge, code_challenge_method: "S256" }).forEach(([k, v]) => url.searchParams.set(k, v));
  const act = (html: string, base: string) => new URL(html.match(/<form[^>]*action="([^"]+)"/)![1]!.replace(/&amp;/g, "&"), base).toString();
  const post = (to: string, o: Record<string, string>) => fetch(to, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o).toString(), redirect: "manual" });
  const signedIn = await post(act(await (await fetch(url)).text(), url.toString()), { username: "josh" });
  const consentUrl = new URL(signedIn.headers.get("location")!, S).toString();
  const consentHtml = await (await fetch(consentUrl)).text();
  expect(consentHtml).toContain("com.example.app:/oauth2redirect");
  expect(consentHtml).toContain("redirect URI checking turned off");
  const back = await post(act(consentHtml, consentUrl), { decision: "approve", patient: "josh-example" });
  const returned = new URL(back.headers.get("location")!);
  expect(`${returned.protocol}${returned.pathname}`).toBe(customRedirect);
  // Wrong redirect_uri at /token fails; matching redirect_uri on a fresh code succeeds.
  expect((await post(`${S}/token`, { grant_type: "authorization_code", code: returned.searchParams.get("code")!, redirect_uri: "https://other.example/cb", client_id: id, code_verifier: verifier })).status).toBe(400);
  const signedIn2 = await post(act(await (await fetch(url)).text(), url.toString()), { username: "josh" });
  const consentUrl2 = new URL(signedIn2.headers.get("location")!, S).toString();
  const back2 = await post(act(await (await fetch(consentUrl2)).text(), consentUrl2), { decision: "approve", patient: "josh-example" });
  const code2 = new URL(back2.headers.get("location")!).searchParams.get("code")!;
  const tok = await post(`${S}/token`, { grant_type: "authorization_code", code: code2, redirect_uri: customRedirect, client_id: id, code_verifier: verifier });
  expect(tok.status).toBe(200);
  expect(((await tok.json()) as any).patient).toBe("josh-example");
});
test("starting over leaves registrations alone, and removal ends them", async () => {
  const w = stack.sandboxes.mint();
  const c = addClient(w.store, { name: "Kept", redirectUris: [REDIRECT] }) as any;
  await w.resetPolicy();
  expect(listClients(w.store).map(x => x.id)).toEqual([c.id]);
  expect(removeClient(w.store, c.id)).toBe(true);
  expect((await authorize(w, c.id)).status).toBe(400);
});
test("apps can be removed by a name prefix, and only those, and never with an empty one", async () => {
  const w = stack.sandboxes.mint();
  for (const name of ["probe one", "probe two", "Keep me"]) expect((await call("POST", `${w.prefix}/register`, { client_name: name, redirect_uris: ["https://example.org/cb"] })).status).toBe(201);
  expect((await call("DELETE", `${w.prefix}/api/sandbox/clients?name-prefix=`)).status).toBe(400);
  const r = await call("DELETE", `${w.prefix}/api/sandbox/clients?name-prefix=probe`);
  expect(((await r.json()) as any).removed.length).toBe(2);
  expect(((await (await call("GET", `${w.prefix}/api/sandbox/clients`)).json()) as any).clients.map((c: any) => c.name)).toEqual(["Keep me"]);
});
test("removing an app removes its approvals and its tokens too", async () => {
  const w = stack.sandboxes.mint();
  const made: any = await (await call("POST", `${w.prefix}/register`, { client_name: "Leaves nothing", redirect_uris: ["https://example.org/cb"] })).json();
  made.id = made.client_id;
  w.store.upsertApproval({ by: "user:josh", app: `app:${made.id}`, patient: "patient:josh-example" } as any);
  expect(w.store.approvals().some(a => a.app === `app:${made.id}`)).toBe(true);
  expect((await call("DELETE", `${w.prefix}/api/sandbox/clients/${made.id}`)).status).toBe(200);
  expect(w.store.approvals().some(a => a.app === `app:${made.id}`)).toBe(false);
});
test("apps register by RFC 7591: discovery names the endpoint, the admin token is the initial access token, and errors are RFC 7591's", async () => {
  const w = stack.sandboxes.mint(), send = (body: unknown, headers: Record<string, string> = {}) => demo.fetch(new Request(`${CONFIG.demoUrl}${w.prefix}/register`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
  const conf: any = await (await fetch(`${w.urls.auth}/fhir/.well-known/smart-configuration`)).json();
  expect(conf.registration_endpoint).toBe(`${w.urls.auth}/register`);
  const open = await send({ client_name: "No token", redirect_uris: [REDIRECT] });
  expect([open.status, ((await open.json()) as any).error]).toEqual([401, "invalid_token"]);
  const err = async (body: unknown) => { const r = await call("POST", `${w.prefix}/register`, body); return [r.status, ((await r.json()) as any).error]; };
  expect(await err({ client_name: "Bad", redirect_uris: ["http://example.org/cb"] })).toEqual([400, "invalid_redirect_uri"]);
  expect(await err({ client_name: "Bad", token_endpoint_auth_method: "client_secret_basic", redirect_uris: [REDIRECT] })).toEqual([400, "invalid_client_metadata"]);
  expect(await err({ client_name: "Bad", grant_types: ["client_credentials"], token_endpoint_auth_method: "none" })).toEqual([400, "invalid_client_metadata"]);
  // A service names whose studies it may reach: nothing is assumed.
  expect(await err({ client_name: "Bad", grant_types: ["client_credentials"], token_endpoint_auth_method: "private_key_jwt", jwks: { keys: [{ kty: "EC", crv: "P-256", x: "x", y: "y", kid: "k" }] } })).toEqual([400, "invalid_client_metadata"]);
  const key = { kty: "EC", crv: "P-256", x: "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU", y: "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0", kid: "k1" };
  const made = await call("POST", `${w.prefix}/register`, { client_name: "Confidential", token_endpoint_auth_method: "private_key_jwt", redirect_uris: [REDIRECT], jwks: { keys: [key] } });
  const m: any = await made.json();
  expect([made.status, m.token_endpoint_auth_method, m.grant_types, m.redirect_uris, m.jwks.keys[0].kid, typeof m.client_id_issued_at]).toEqual([201, "private_key_jwt", ["authorization_code", "refresh_token"], [REDIRECT], "k1", "number"]);
  // A browser app can register itself from its own origin: preflight, then the answer, both readable.
  const pre = await demo.fetch(new Request(`${CONFIG.demoUrl}${w.prefix}/register`, { method: "OPTIONS", headers: { origin: "https://app.example", "access-control-request-method": "POST", "access-control-request-headers": "authorization, content-type" } }));
  expect([pre.status, pre.headers.get("access-control-allow-origin"), pre.headers.get("access-control-allow-headers")]).toEqual([204, "*", "authorization, content-type"]);
  const cross = await demo.fetch(new Request(`${CONFIG.demoUrl}${w.prefix}/register`, { method: "POST", headers: { ...(await adminFor(demo, `${w.prefix}/register`)), "content-type": "application/json", origin: "https://app.example" }, body: JSON.stringify({ client_name: "From a page", redirect_uris: [REDIRECT] }) }));
  expect([cross.status, cross.headers.get("access-control-allow-origin")]).toEqual([201, "*"]);
  // One way to register: the management API lists and removes apps, and no longer makes them.
  expect((await call("POST", `${w.prefix}/api/sandbox/clients`, { name: "Old way", redirectUris: [REDIRECT] })).status).toBe(404);
  const root: any = await (await fetch(`${stack.root.urls.auth}/fhir/.well-known/smart-configuration`)).json();
  expect(root.registration_endpoint).toBeUndefined();
});
test("the shared root has no registrations", async () => expect((await call("GET", "/api/sandbox/clients")).status).toBe(409));

test("named studies add to an approval's sites, and only what the person can see counts", async () => {
  const w = stack.sandboxes.mint();
  const by = "user:josh", app = "app:demo-client", patient = "patient:josh-example";
  const all = w.catalog.allStudies().filter(st => st.patient === "josh-example");
  const site = all.find(st => all.filter(x => x.site === st.site).length > 1)!.site!;
  const [kept] = all.filter(st => st.site === site);
  const r = await w.policy.approveApp({ by, app, patient, fhirUser: "Patient/josh-example", sites: [], studies: [kept!.id, "not-a-study"] });
  expect(r.ok).toBe(true);
  const stored = w.store.approvals().find(a => a.app === app)!;
  expect(stored.studies).toEqual([kept!.id]);
  expect(stored.sites).toEqual([]);
  const released = await w.explain({ client: "demo-client", user: "josh", fhirUser: "Patient/josh-example", patient: "josh-example" }) as any;
  const open = (released.studies ?? released.decisions ?? []).filter((d: any) => d.release !== "none" && d.released !== false).map((d: any) => d.id ?? d.study);
  expect(open).toEqual([kept!.id]);
});
test("a sandbox has a friendly name it keeps, and can be renamed", async () => {
  const w = stack.sandboxes.mint();
  const first = (await (await call("GET", `${w.prefix}/api/sandbox`)).json() as any).name;
  expect(first).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
  expect((await (await call("GET", `${w.prefix}/api/sandbox`)).json() as any).name).toBe(first);
  expect((await call("PATCH", `${w.prefix}/api/sandbox`, { name: "Josh's demo" })).status).toBe(200);
  expect((await (await call("GET", `${w.prefix}/api/sandbox`)).json() as any).name).toBe("Josh's demo");
  expect((await call("PATCH", `${w.prefix}/api/sandbox`, { name: "x".repeat(41) })).status).toBe(400);
  expect((await (await call("GET", "/api/sandbox")).json() as any).name).toBeNull();
});

test("a sandbox can advertise imaging on its clinical server instead of a separate one", async () => {
  const w = stack.sandboxes.mint();
  const config = async () => (await fetch(`${w.urls.auth}/fhir/.well-known/smart-configuration`)).json() as any;
  const before = await config();
  expect(before.associated_endpoints[0].url).toBe(`${w.urls.imaging}/fhir`);
  expect(before.capabilities).not.toContain("smart-imaging-access");
  expect((await fetch(`${w.urls.auth}/fhir/ImagingStudy?patient=josh-example`)).status).toBe(404);
  const set = await call("PATCH", `${w.prefix}/api/sandbox`, { topology: "unified" });
  expect(set.status).toBe(200);
  expect((await set.json() as any).topology.current).toBe("unified");
  const after = await config();
  expect(after.associated_endpoints).toBeUndefined();
  expect(after.capabilities).toContain("smart-imaging-access");
  expect(after.capabilities.some((c: string) => c.startsWith("http://fhir.org/argonaut"))).toBe(false);
  expect((await fetch(`${w.urls.auth}/fhir/ImagingStudy?patient=josh-example`)).status).toBe(401);
  expect((await call("PATCH", `${w.prefix}/api/sandbox`, { topology: "nope" })).status).toBe(400);
  expect((await call("PATCH", "/api/sandbox", { topology: "unified" })).status).toBe(400);
});

// Non-public clients.
import { createPrivateKey, generateKeyPairSync, randomBytes as rb, sign as ecSign } from "node:crypto";
const pair = () => { const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" }); return { privateKey, jwk: { ...publicKey.export({ format: "jwk" }), kid: `k-${rb(3).toString("hex")}` } as any }; };
const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const assertion = (key: any, kid: string, id: string, aud: string, o: { jti?: string } = {}) => {
  const head = `${b({ alg: "ES256", kid, typ: "JWT" })}.${b({ iss: id, sub: id, aud, exp: Math.floor(Date.now() / 1000) + 200, jti: o.jti ?? rb(8).toString("hex") })}`;
  return `${head}.${ecSign("sha256", Buffer.from(head), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
};
const FORM = { "content-type": "application/x-www-form-urlencoded" };
const tokenCall = (w: any, id: string, jwt: string) => fetch(`${w.urls.auth}/token`, { method: "POST", headers: FORM, body: new URLSearchParams({ grant_type: "client_credentials", scope: "system/ImagingStudy.rs", client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: jwt }).toString() });

test("keys are public ES256 JWKs with a kid, and private ones are refused", () => {
  const w = stack.sandboxes.mint(), { privateKey, jwk } = pair();
  expect(addClient(w.store, { name: "S", type: "backend", jwk: privateKey.export({ format: "jwk" }) })).toHaveProperty("error");
  expect(addClient(w.store, { name: "S", type: "backend", jwk: { ...jwk, kid: undefined } })).toHaveProperty("error");
  expect(addClient(w.store, { name: "S", type: "backend", jwk: { keys: [jwk] } })).toHaveProperty("id");
  expect(addClient(w.store, { name: "S", type: "backend", jwk, patients: "nobody" })).toHaveProperty("error");
  expect(addClient(w.store, { name: "S", type: "nope" as any })).toHaveProperty("error");
});
test("a backend service reaches only what it was granted, and its grant outlasts starting over", async () => {
  const w = stack.sandboxes.mint(), { privateKey, jwk } = pair();
  const c = addClient(w.store, { name: "Svc", type: "backend", jwk, patients: "josh-example" }) as any;
  const search = (t: string, p: string) => fetch(`${w.urls.imaging}/fhir/ImagingStudy?patient=${p}&_include=ImagingStudy:endpoint`, { headers: { authorization: `Bearer ${t}` } });
  const jwt = () => assertion(privateKey, jwk.kid, c.id, `${w.urls.auth}/token`);
  const t: any = await (await tokenCall(w, c.id, jwt())).json();
  expect(t.scope).toBe("system/ImagingStudy.rs");
  expect(((await (await search(t.access_token, "josh-example")).json()) as any).entry.filter((e: any) => e.resource.resourceType === "ImagingStudy").length).toBe(6);
  expect((await search(t.access_token, "sam-example")).status).toBe(403);
  await w.resetPolicy();
  const again: any = await (await tokenCall(w, c.id, jwt())).json();
  expect((await search(again.access_token, "josh-example")).status).toBe(200);
  await call("DELETE", `${w.prefix}/api/sandbox/clients/${c.id}`);
  expect((await tokenCall(w, c.id, jwt())).status).toBe(401);
});
test("a bad assertion gets nothing: wrong key, wrong audience, or used twice", async () => {
  const w = stack.sandboxes.mint(), { privateKey, jwk } = pair(), other = pair();
  const c = addClient(w.store, { name: "Svc", type: "backend", jwk }) as any, aud = `${w.urls.auth}/token`;
  expect((await tokenCall(w, c.id, assertion(other.privateKey, jwk.kid, c.id, aud))).status).toBe(401);
  expect((await tokenCall(w, c.id, assertion(privateKey, jwk.kid, c.id, "https://elsewhere.example/token"))).status).toBe(401);
  const once = assertion(privateKey, jwk.kid, c.id, aud, { jti: "same" });
  expect((await tokenCall(w, c.id, once)).status).toBe(200);
  expect((await tokenCall(w, c.id, once)).status).toBe(401);
});
test("a confidential app can't get a backend token, and needs its key to use a code or a refresh token", async () => {
  const w = stack.sandboxes.mint(), { privateKey, jwk } = pair(), S = w.urls.auth, aud = `${S}/token`;
  const c = addClient(w.store, { name: "Conf", type: "confidential", redirectUris: [REDIRECT], jwk }) as any;
  expect((await tokenCall(w, c.id, assertion(privateKey, jwk.kid, c.id, aud))).status).toBe(400);
  const verifier = rb(32).toString("base64url"), challenge = require("node:crypto").createHash("sha256").update(verifier).digest("base64url");
  const url = new URL(`${S}/authorize`);
  Object.entries({ response_type: "code", client_id: c.id, redirect_uri: REDIRECT, scope: "launch/patient patient/*.rs", aud: `${S}/fhir`, state: "x", code_challenge: challenge, code_challenge_method: "S256" }).forEach(([k, v]) => url.searchParams.set(k, v));
  const act = (html: string, base: string) => new URL(html.match(/<form[^>]*action="([^"]+)"/)![1]!.replace(/&amp;/g, "&"), base).toString();
  const post = (to: string, o: Record<string, string>) => fetch(to, { method: "POST", headers: FORM, body: new URLSearchParams(o).toString(), redirect: "manual" });
  const code = async () => {
    const signedIn = await post(act(await (await fetch(url)).text(), url.toString()), { username: "josh" });
    const consent = new URL(signedIn.headers.get("location")!, S).toString();
    const back = await post(act(await (await fetch(consent)).text(), consent), { decision: "approve", patient: "josh-example" });
    return new URL(back.headers.get("location")!).searchParams.get("code")!;
  };
  const exchange = { grant_type: "authorization_code", redirect_uri: REDIRECT, client_id: c.id, code_verifier: verifier };
  expect((await post(aud, { ...exchange, code: await code() })).status).toBe(401);
  const ok = await post(aud, { ...exchange, code: await code(), client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: assertion(privateKey, jwk.kid, c.id, aud) });
  expect(ok.status).toBe(200);
  expect(((await ok.json()) as any).patient).toBe("josh-example");
  // Refreshing takes the key too: the refresh token alone isn't enough, and a refused try doesn't spend it.
  url.searchParams.set("scope", "launch/patient patient/*.rs offline_access");
  const t: any = await (await post(aud, { ...exchange, code: await code(), client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: assertion(privateKey, jwk.kid, c.id, aud) })).json();
  expect(t.refresh_token).toBeString();
  expect((await post(aud, { grant_type: "refresh_token", client_id: c.id, refresh_token: t.refresh_token })).status).toBe(401);
  expect((await post(aud, { grant_type: "refresh_token", client_id: c.id, refresh_token: t.refresh_token, client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: assertion(privateKey, jwk.kid, c.id, aud) })).status).toBe(200);
});

// Clients that publish their keys, and what a public deployment refuses to fetch.
import { clearJwksCache, fetchJwks, isAllowedUrl, isBlockedAddress } from "../src/jwks";
test("internal addresses are blocked, however they're written", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "not an ip"]) expect(isBlockedAddress(ip)).toBe(true);
  for (const ip of ["8.8.8.8", "140.82.112.3", "2606:4700::1111"]) expect(isBlockedAddress(ip)).toBe(false);
});
test("a public deployment accepts only public https URLs", async () => {
  const resolve = (map: Record<string, string[]>) => async (h: string) => { if (!map[h]) throw new Error("no such host"); return map[h]!; };
  const dns = resolve({ "keys.example.org": ["93.184.216.34"], "sneaky.example.org": ["93.184.216.34", "10.0.0.5"], "meta.example.org": ["169.254.169.254"] });
  expect(await isAllowedUrl("https://keys.example.org/jwks.json", true, dns)).toBe(true);
  expect(await isAllowedUrl("https://keys.example.org:8443/jwks.json", true, dns)).toBe(true);
  for (const bad of ["http://keys.example.org/jwks", "https://sneaky.example.org/j", "https://meta.example.org/j", "https://127.0.0.1/j", "https://2130706433/j", "https://0x7f.0.0.1/j", "https://[::1]/j", "https://localhost/j", "https://orthanc.svc/j", "https://user:p@keys.example.org/j", "https://keys.example.org:22/j", "file:///etc/passwd", "https://nowhere.example.org/j", "nonsense"]) expect(await isAllowedUrl(bad, true, dns)).toBe(false);
});
test("a JWKS URL works for ES384 and RS384, follows rotation, and a key it stops publishing stops working", async () => {
  clearJwksCache();
  const w = stack.sandboxes.mint();
  const es = generateKeyPairSync("ec", { namedCurve: "P-384" }), rs = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pub = (k: any, kid: string) => ({ ...k.export({ format: "jwk" }), kid });
  let published: any[] = [pub(es.publicKey, "es")];
  let hits = 0;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => { hits++; return Response.json({ keys: published }); } });
  try {
    const made = await call("POST", `${w.prefix}/register`, { client_name: "Rotating", grant_types: ["client_credentials"], token_endpoint_auth_method: "private_key_jwt", patients: "any", jwks_uri: `http://127.0.0.1:${server.port}/jwks` });
    expect(made.status).toBe(201);
    const m = await made.json() as any, c = { id: m.client_id as string }, aud = `${w.urls.auth}/token`;
    const jwt = (alg: string, hash: string, key: any, kid: string, ieee: boolean) => {
      const head = `${b({ alg, kid, typ: "JWT" })}.${b({ iss: c.id, sub: c.id, aud, exp: Math.floor(Date.now() / 1000) + 200, jti: rb(8).toString("hex") })}`;
      return `${head}.${ecSign(hash, Buffer.from(head), { key, ...(ieee ? { dsaEncoding: "ieee-p1363" as const } : {}) }).toString("base64url")}`;
    };
    expect((await tokenCall(w, c.id, jwt("ES384", "sha384", es.privateKey, "es", true))).status).toBe(200);
    expect((await tokenCall(w, c.id, jwt("RS384", "sha384", rs.privateKey, "rs", false))).status).toBe(401);
    expect((await tokenCall(w, c.id, jwt("ES256", "sha256", es.privateKey, "es", true))).status).toBe(401);
    const before = hits;
    expect((await tokenCall(w, c.id, jwt("ES384", "sha384", es.privateKey, "es", true))).status).toBe(200);
    expect(hits).toBe(before);
    published = [pub(rs.publicKey, "rs")];
    clearJwksCache();
    expect((await tokenCall(w, c.id, jwt("RS384", "sha384", rs.privateKey, "rs", false))).status).toBe(200);
    expect((await tokenCall(w, c.id, jwt("ES384", "sha384", es.privateKey, "es", true))).status).toBe(401);
  } finally { server.stop(true); clearJwksCache(); }
});
test("what can't be fetched gives the same answer as what isn't there", async () => {
  const w = stack.sandboxes.mint();
  const r = await call("POST", `${w.prefix}/register`, { client_name: "Nope", grant_types: ["client_credentials"], token_endpoint_auth_method: "private_key_jwt", patients: "any", jwks_uri: "http://127.0.0.1:1/jwks" });
  expect(r.status).toBe(400);
  expect(await fetchJwks("http://127.0.0.1:1/jwks", true)).toBeUndefined();
});

test("a client registered with a JWKS of several keys can sign with any of them, and each is recognized by its kid", async () => {
  const w = stack.sandboxes.mint(), a = pair(), b = pair(), aud = `${w.urls.auth}/token`;
  const made = await call("POST", `${w.prefix}/register`, { client_name: "Two keys", grant_types: ["client_credentials"], token_endpoint_auth_method: "private_key_jwt", patients: "josh-example", jwks: { keys: [a.jwk, b.jwk] } });
  const m: any = await made.json();
  expect([made.status, m.jwks.keys.map((k: any) => k.kid)]).toEqual([201, [a.jwk.kid, b.jwk.kid]]);
  for (const k of [a, b]) expect((await tokenCall(w, m.client_id, assertion(k.privateKey, k.jwk.kid, m.client_id, aud))).status).toBe(200);
  // A kid that isn't registered, or a key signing under another's kid, is refused.
  expect((await tokenCall(w, m.client_id, assertion(a.privateKey, "nope", m.client_id, aud))).status).toBe(401);
  expect((await tokenCall(w, m.client_id, assertion(a.privateKey, b.jwk.kid, m.client_id, aud))).status).toBe(401);
  const dup = await call("POST", `${w.prefix}/register`, { client_name: "Same kid", grant_types: ["client_credentials"], token_endpoint_auth_method: "private_key_jwt", patients: "any", jwks: { keys: [a.jwk, { ...b.jwk, kid: a.jwk.kid }] } });
  expect([dup.status, ((await dup.json()) as any).error_description]).toEqual([400, expect.stringContaining("two keys have the kid")]);
});
