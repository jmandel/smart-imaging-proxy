// The one-origin front: routing, CORS, and the write guard it keeps. DEMO_ONE_ORIGIN changes the
// URLs the whole stack issues, so those are checked in a fresh process.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { startStack, type Stack } from "../src/stack";
import { CONFIG, PORTS } from "../src/config";
import { gatewayFetch } from "../src/gateway";

let stack: Stack;
beforeAll(async () => { stack = await startStack(join(import.meta.dir, "..")); });
afterAll(() => stack.stop());

const G = `http://127.0.0.1:${PORTS.gateway}`;
const via = (path: string, init: RequestInit = {}) => gatewayFetch(new Request(G + path, init));
const SHARE = "https://shlink-dicom.exe.xyz";

test("with DEMO_ONE_ORIGIN=1, every URL an app is given is on one origin", () => {
  const r = Bun.spawnSync(["bun", "-e", `const { CONFIG } = await import("./src/config.ts"); console.log(JSON.stringify([CONFIG.authUrl, CONFIG.imagingUrl, CONFIG.proxyUrl]))`], { cwd: join(import.meta.dir, ".."), env: { ...process.env, DEMO_ONE_ORIGIN: "1", DEMO_TAILNET: "0" } });
  const [auth, imaging, proxy] = JSON.parse(r.stdout.toString()) as string[];
  const port = PORTS.gateway;
  expect([auth, imaging, proxy]).toEqual([`http://127.0.0.1:${port}`, `http://127.0.0.1:${port}/imaging`, `http://127.0.0.1:${port}`]);
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
  const pre = await via("/token", { method: "OPTIONS", headers: { origin: SHARE, "access-control-request-method": "POST", "access-control-request-headers": "content-type", "access-control-request-private-network": "true" } });
  expect(pre.status).toBe(204);
  expect(pre.headers.get("access-control-allow-origin")).toBe("*");
  expect(pre.headers.get("access-control-allow-headers")).toBe("content-type");
  expect(pre.headers.get("access-control-allow-private-network")).toBe("true");
  const token = await via("/token", { method: "POST", headers: { origin: SHARE, "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=authorization_code&code=nope" });
  expect(token.status).toBe(400);
  expect(token.headers.get("access-control-allow-origin")).toBe("*");
});

test("the share page's client and callback are registered", async () => {
  const q = new URLSearchParams({ response_type: "code", client_id: "shlink-dicom-share", redirect_uri: `${SHARE}/share/smart-callback/`, scope: "launch/patient patient/ImagingStudy.rs", state: "s", aud: `${CONFIG.authUrl}/fhir`, code_challenge: "c".repeat(43), code_challenge_method: "S256" });
  const res = await via(`/authorize?${q}`);
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("SHLink DICOM Share");
});

test("a form on the front's own origin passes the write guard, and one from elsewhere doesn't", async () => {
  const form = { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "username=josh" };
  const own = await via("/account/signin", { ...form, headers: { ...form.headers, origin: G } });
  expect(own.status).not.toBe(403);
  const foreign = await via("/account/signin", { ...form, headers: { ...form.headers, origin: SHARE } });
  expect(foreign.status).toBe(403);
});
