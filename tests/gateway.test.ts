// The one origin apps are given: routing, the services' CORS through it, and the write guard it
// keeps. DEMO_ONE_ORIGIN changes the URLs the whole stack issues, so those are checked in fresh processes.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { startStack, type Stack } from "../src/stack";
import { CONFIG, PORTS } from "../src/config";
import { gatewayFetch } from "../src/gateway";
import { appClientsFromEnv } from "../src/auth-server";

const SHARE = "https://share.example";

let stack: Stack;
const APP = `${SHARE}/share/smart-callback/`;
beforeAll(async () => {
  process.env.DEMO_APP_CLIENTS = `share-app=${APP}`;
  stack = await startStack(join(import.meta.dir, ".."));
});
afterAll(() => { stack.stop(); delete process.env.DEMO_APP_CLIENTS; });

const G = `http://127.0.0.1:${PORTS.gateway}`;
const via = (path: string, init: RequestInit = {}) => gatewayFetch(new Request(G + path, init));

const configWith = (one: string) => {
  const r = Bun.spawnSync(["bun", "-e", `const { CONFIG } = await import("./src/config.ts"); console.log(JSON.stringify([CONFIG.authUrl, CONFIG.imagingUrl, CONFIG.proxyUrl]))`], { cwd: join(import.meta.dir, ".."), env: { ...process.env, DEMO_ONE_ORIGIN: one, DEMO_TAILNET: "0" } });
  return JSON.parse(r.stdout.toString()) as string[];
};

test("by default, every URL an app is given is on one origin, and DEMO_ONE_ORIGIN=0 gives each service its own", () => {
  const h = "http://127.0.0.1";
  expect(configWith("")).toEqual([`${h}:${PORTS.gateway}`, `${h}:${PORTS.gateway}/imaging`, `${h}:${PORTS.gateway}`]);
  expect(configWith("0")).toEqual([`${h}:${PORTS.auth}`, `${h}:${PORTS.imaging}`, `${h}:${PORTS.proxy}`]);
});

test("each path reaches its service", async () => {
  const smart = await via("/fhir/.well-known/smart-configuration");
  expect(smart.status).toBe(200);
  expect((await smart.json()).code_challenge_methods_supported).toContain("S256");
  const search = await via("/imaging/fhir/ImagingStudy?patient=josh-example");
  expect(search.status).toBe(401);
  expect((await via("/imaging/.well-known/jwks.json")).status).toBe(200);
  expect((await via(`/wado/${"x".repeat(40)}/studies/1.2.3`)).status).not.toBe(200);
});

test("a page on another origin can call it, including from a public page to loopback", async () => {
  // The services answer CORS themselves, so this holds on their own ports too.
  const pre = await via("/token", { method: "OPTIONS", headers: { origin: SHARE, "access-control-request-method": "POST", "access-control-request-headers": "content-type", "access-control-request-private-network": "true" } });
  expect(pre.status).toBe(204);
  expect(pre.headers.get("access-control-allow-origin")).toBe("*");
  expect(pre.headers.get("access-control-allow-headers")).toBe("content-type");
  expect(pre.headers.get("access-control-allow-private-network")).toBe("true");
  const token = await via("/token", { method: "POST", headers: { origin: SHARE, "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=authorization_code&code=nope" });
  expect(token.status).toBe(400);
  expect(token.headers.get("access-control-allow-origin")).toBe("*");
});

test("an app client from DEMO_APP_CLIENTS is registered with its callback", async () => {
  const q = new URLSearchParams({ response_type: "code", client_id: "share-app", redirect_uri: APP, scope: "launch/patient patient/ImagingStudy.rs", state: "s", aud: `${CONFIG.authUrl}/fhir`, code_challenge: "c".repeat(43), code_challenge_method: "S256" });
  const res = await via(`/authorize?${q}`);
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("share-app");
});

test("DEMO_APP_CLIENTS lists client_id=redirect_uri pairs, and adds none by default", () => {
  expect(appClientsFromEnv("")).toEqual(new Map());
  expect(appClientsFromEnv("a=https://x.example/cb, a=http://localhost:3000/cb,b=https://y.example/")).toEqual(new Map([["a", ["https://x.example/cb", "http://localhost:3000/cb"]], ["b", ["https://y.example/"]]]));
  expect(() => appClientsFromEnv("https://x.example/cb")).toThrow("client_id=redirect_uri");
  expect(() => appClientsFromEnv("a=/cb")).toThrow("absolute");
  expect(() => appClientsFromEnv("a=https://x.example/cb#f")).toThrow("fragment");
  expect(() => appClientsFromEnv("portal-app=https://x.example/cb")).toThrow("demo's own");
});

test("a form on the front's own origin passes the write guard, and one from elsewhere doesn't", async () => {
  const form = { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "username=josh" };
  const own = await via("/account/signin", { ...form, headers: { ...form.headers, origin: G } });
  expect(own.status).not.toBe(403);
  const foreign = await via("/account/signin", { ...form, headers: { ...form.headers, origin: SHARE } });
  expect(foreign.status).toBe(403);
});

test("each service answers CORS on its own port", async () => {
  for (const url of [`http://127.0.0.1:${PORTS.auth}/fhir/.well-known/smart-configuration`, `http://127.0.0.1:${PORTS.imaging}/fhir/ImagingStudy`, `http://127.0.0.1:${PORTS.proxy}/wado/x/studies/1.2.3`]) {
    const res = await fetch(url, { headers: { origin: SHARE } });
    expect([url, res.headers.get("access-control-allow-origin")]).toEqual([url, "*"]);
  }
});
