// Apps registered in a world: they work there, only there, and a tour leaves them alone.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { addClient, listClients, removeClient } from "../src/clients";
import { createDemoServer } from "../src/demo-server";
import { registerClients } from "../src/flows";
import { CONFIG } from "../src/config";
import { startStack, type Stack } from "../src/stack";

let stack: Stack, demo: ReturnType<typeof createDemoServer>;
beforeAll(async () => { stack = await startStack(join(import.meta.dir, "..")); demo = createDemoServer(stack, registerClients(stack), join(import.meta.dir, "..")); });
afterAll(() => stack.stop());
const call = (method: string, path: string, body?: unknown) => demo.fetch(new Request(`${CONFIG.demoUrl}${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) }));
const REDIRECT = "https://app.example/callback";
const authorize = (w: ReturnType<Stack["scopes"]["mint"]>, client: string, redirect = REDIRECT) => {
  const u = new URL(`${w.urls.auth}/authorize`);
  Object.entries({ client_id: client, redirect_uri: redirect, response_type: "code", state: "s", code_challenge: "c", code_challenge_method: "S256", aud: `${w.urls.auth}/fhir`, scope: "launch/patient patient/*.rs" }).forEach(([k, v]) => u.searchParams.set(k, v));
  return fetch(u, { redirect: "manual" });
};

test("redirect URIs and names are checked", () => {
  const w = stack.scopes.mint();
  for (const redirectUris of [["http://app.example/cb"], ["https://app.example/cb#x"], ["not a url"], []]) expect(addClient(w.store, { name: "A", redirectUris })).toHaveProperty("error");
  expect(addClient(w.store, { name: "", redirectUris: [REDIRECT] })).toHaveProperty("error");
  expect(addClient(w.store, { name: "Local", redirectUris: ["http://localhost:3000/cb"] })).toHaveProperty("id");
});
test("a registered app can start sign-in in its own world, and only with its own redirect", async () => {
  const w = stack.scopes.mint(), other = stack.scopes.mint();
  const r = await call("POST", `${w.prefix}/api/clients`, { name: "My app", redirectUris: [REDIRECT] });
  expect(r.status).toBe(201);
  const { id } = await r.json() as any;
  expect((await authorize(w, id)).status).toBe(200);
  expect((await authorize(w, id, "https://evil.example/cb")).status).toBe(400);
  expect((await authorize(other, id)).status).toBe(400);
  expect((await (await call("GET", `${w.prefix}/api/clients`)).json() as any).clients.map((c: any) => c.id)).toEqual([id]);
});
test("a tour leaves registrations alone, and removal ends them", async () => {
  const w = stack.scopes.mint();
  const c = addClient(w.store, { name: "Kept", redirectUris: [REDIRECT] }) as any;
  expect((await call("POST", `${w.prefix}/api/tours/own/start`, {})).status).toBe(201);
  expect(listClients(w.store).map(x => x.id)).toEqual([c.id]);
  expect(removeClient(w.store, c.id)).toBe(true);
  expect((await authorize(w, c.id)).status).toBe(400);
});
test("the shared root has no registrations", async () => expect((await call("GET", "/api/clients")).status).toBe(409));

test("named studies add to an approval's sites, and only what the person can see counts", async () => {
  const w = stack.scopes.mint();
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
test("a store saved before named studies keeps working", () => {
  const { Database } = require("bun:sqlite");
  const { PolicyStore } = require("@smart-imaging-proxy/core");
  const path = join(require("node:os").tmpdir(), `old-${Date.now()}.sqlite`);
  const fresh = new PolicyStore({ mode: "file", path }); fresh.close();
  const db = new Database(path); db.exec("ALTER TABLE approvals DROP COLUMN studies; PRAGMA user_version = 8"); db.close();
  const up = new PolicyStore({ mode: "file", path });
  expect(up.approvals()).toEqual([]);
  up.close(); require("node:fs").rmSync(path, { force: true });
});

test("a sandbox has a friendly name it keeps, and can be renamed", async () => {
  const w = stack.scopes.mint();
  const first = (await (await call("GET", `${w.prefix}/api/world`)).json() as any).name;
  expect(first).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
  expect((await (await call("GET", `${w.prefix}/api/world`)).json() as any).name).toBe(first);
  expect((await call("POST", `${w.prefix}/api/world`, { name: "Josh's demo" })).status).toBe(200);
  expect((await (await call("GET", `${w.prefix}/api/world`)).json() as any).name).toBe("Josh's demo");
  expect((await call("POST", `${w.prefix}/api/world`, { name: "x".repeat(41) })).status).toBe(400);
  expect((await call("GET", "/api/world")).status).toBe(409);
});

test("a sandbox can advertise imaging on its clinical server instead of a separate one", async () => {
  const w = stack.scopes.mint();
  const config = async () => (await fetch(`${w.urls.auth}/fhir/.well-known/smart-configuration`)).json() as any;
  const before = await config();
  expect(before.associated_endpoints[0].url).toBe(`${w.urls.imaging}/fhir`);
  expect(before.capabilities).not.toContain("smart-imaging-access");
  expect((await fetch(`${w.urls.auth}/fhir/ImagingStudy?patient=josh-example`)).status).toBe(404);
  const set = await call("POST", `${w.prefix}/api/settings/topology`, { topology: "unified" });
  expect(set.status).toBe(200);
  expect((await set.json() as any).topology.current).toBe("unified");
  const after = await config();
  expect(after.associated_endpoints).toBeUndefined();
  expect(after.capabilities).toEqual(expect.arrayContaining(["smart-imaging-access", "http://fhir.org/argonaut/smart-imaging/capabilities/app-launch"]));
  expect((await fetch(`${w.urls.auth}/fhir/ImagingStudy?patient=josh-example`)).status).toBe(401);
  expect((await call("POST", `${w.prefix}/api/settings/topology`, { topology: "nope" })).status).toBe(400);
  expect((await call("POST", "/api/settings/topology", { topology: "unified" })).status).toBe(400);
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
  const w = stack.scopes.mint(), { privateKey, jwk } = pair();
  expect(addClient(w.store, { name: "S", type: "backend", jwk: privateKey.export({ format: "jwk" }) })).toHaveProperty("error");
  expect(addClient(w.store, { name: "S", type: "backend", jwk: { ...jwk, kid: undefined } })).toHaveProperty("error");
  expect(addClient(w.store, { name: "S", type: "backend", jwk: { keys: [jwk] } })).toHaveProperty("id");
  expect(addClient(w.store, { name: "S", type: "backend", jwk, patients: "nobody" })).toHaveProperty("error");
  expect(addClient(w.store, { name: "S", type: "nope" as any })).toHaveProperty("error");
});
test("a backend service reaches only what it was granted, and its grant outlasts a tour", async () => {
  const w = stack.scopes.mint(), { privateKey, jwk } = pair();
  const c = addClient(w.store, { name: "Svc", type: "backend", jwk, patients: "josh-example" }) as any;
  const search = (t: string, p: string) => fetch(`${w.urls.imaging}/fhir/ImagingStudy?patient=${p}&_include=ImagingStudy:endpoint`, { headers: { authorization: `Bearer ${t}` } });
  const jwt = () => assertion(privateKey, jwk.kid, c.id, `${w.urls.auth}/token`);
  const t: any = await (await tokenCall(w, c.id, jwt())).json();
  expect(t.scope).toBe("system/ImagingStudy.rs");
  expect(((await (await search(t.access_token, "josh-example")).json()) as any).entry.filter((e: any) => e.resource.resourceType === "ImagingStudy").length).toBe(6);
  expect((await search(t.access_token, "sam-example")).status).toBe(403);
  await call("POST", `${w.prefix}/api/tours/own/start`, {});
  const again: any = await (await tokenCall(w, c.id, jwt())).json();
  expect((await search(again.access_token, "josh-example")).status).toBe(200);
  await call("DELETE", `${w.prefix}/api/clients/${c.id}`);
  expect((await tokenCall(w, c.id, jwt())).status).toBe(401);
});
test("a bad assertion gets nothing: wrong key, wrong audience, or used twice", async () => {
  const w = stack.scopes.mint(), { privateKey, jwk } = pair(), other = pair();
  const c = addClient(w.store, { name: "Svc", type: "backend", jwk }) as any, aud = `${w.urls.auth}/token`;
  expect((await tokenCall(w, c.id, assertion(other.privateKey, jwk.kid, c.id, aud))).status).toBe(401);
  expect((await tokenCall(w, c.id, assertion(privateKey, jwk.kid, c.id, "https://elsewhere.example/token"))).status).toBe(401);
  const once = assertion(privateKey, jwk.kid, c.id, aud, { jti: "same" });
  expect((await tokenCall(w, c.id, once)).status).toBe(200);
  expect((await tokenCall(w, c.id, once)).status).toBe(401);
});
test("a confidential app can't get a backend token, and needs its key to use a code", async () => {
  const w = stack.scopes.mint(), { privateKey, jwk } = pair(), S = w.urls.auth, aud = `${S}/token`;
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
});
