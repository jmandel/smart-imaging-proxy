// Writes outside the admin API stay on rails too, and refused requests have no side effects.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { join } from "node:path";
import { startStack, type Stack } from "../src/stack";
import { registerClients } from "../src/flows";
import { createDemoServer } from "../src/demo-server";
import { accountUrl, buildAuthorization, scriptedLaunch, submitDelegation } from "../src/flows/oauth";
import { CONFIG, PORTS } from "../src/config";
import { ownHosts } from "../src/settings-api";
import { createCollector } from "../src/trace-collector";

let stack: Stack; let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
  stack = await startStack(join(import.meta.dir, ".."));
  server = Bun.serve({ port: PORTS.demo, hostname: "127.0.0.1", ...createDemoServer(stack, registerClients(stack), join(import.meta.dir, "..")) });
});
afterAll(() => { server.stop(true); stack.stop(); });

const span = JSON.stringify([{ session: "guard-test", trace: "a".repeat(32), span: "b".repeat(16), service: "demo", kind: "check", name: "planted", start: 1, attrs: {} }]);
// The trace service's own port: these are its Host checks.
const raw = (path: string, method: string, headers: Record<string, string>, body?: string) => fetch(`http://127.0.0.1:${PORTS.trace}${path}`, { method, headers, body });

test("spans are refused from a browser, under another host name, or without the services' credential", async () => {
  expect((await raw("/v1/spans", "POST", { origin: "https://evil.example" }, span)).status).toBe(403);
  expect((await raw("/v1/spans", "POST", { host: "evil.example" }, span)).status).toBe(403);
  expect(stack.collector.list().some(s => s.id === "guard-test")).toBe(false);
  expect((await raw("/v1/spans", "POST", {}, span)).status).toBe(401);
  expect(stack.collector.list().some(s => s.id === "guard-test")).toBe(false);
  expect((await raw("/v1/spans", "POST", { authorization: `Bearer ${stack.spanSecret}` }, span)).status).toBe(202);
});

test("traces can't be cleared from another origin or host name", async () => {
  expect((await raw("/api/sessions", "DELETE", { origin: "https://evil.example" })).status).toBe(403);
  expect((await raw("/api/sessions", "DELETE", { host: "evil.example" })).status).toBe(403);
});

const READS = ["/api/stats", "/api/sessions", "/api/sessions/guard-test/spans", `/api/sessions/guard-test/spans/${"b".repeat(16)}`, "/api/sessions/guard-test/http", "/api/sessions/guard-test/export", "/stream"];

test("traces can't be read under another host name", async () => {
  for (const path of READS) {
    const res = await raw(path, "GET", { host: "evil.example" });
    expect([path, res.status]).toEqual([path, 403]);
    expect(await res.text()).not.toContain("guard-test");
  }
  expect((await raw("/api/sessions", "GET", { host: `evil.example:${PORTS.trace}` })).status).toBe(403);
  expect((await raw("/api/sessions", "GET", { host: `127.0.0.1:${PORTS.trace + 2}` })).status).toBe(403);
});

test("traces can be read at this service's own addresses, its old page goes to the demo's, and a request with no Host is fine", async () => {
  for (const host of [`127.0.0.1:${PORTS.trace}`, `localhost:${PORTS.trace}`]) {
    for (const path of ["/api/stats", "/api/sessions"]) expect([host, path, (await raw(path, "GET", { host })).status]).toEqual([host, path, 200]);
    expect((await fetch(`http://127.0.0.1:${PORTS.trace}/`, { headers: { host }, redirect: "manual" })).status).toBe(302);
    const stream = await raw("/stream", "GET", { host });
    expect(stream.status).toBe(200);
    await stream.body!.cancel();
  }
  const c = createCollector(join(import.meta.dir, ".."));
  expect((await c.fetch(new Request("http://trace.test/api/sessions"))).status).toBe(200);
  c.close();
});

test("a share takes only an offered relationship", async () => {
  await stack.resetAll();
  const r = await submitDelegation(accountUrl("josh"), { user: "josh", delegate: "sam-caregiver", relationship: "<script>x</script>", sites: ["Lakeside Imaging"] });
  expect(r.status).toBe(400);
  expect(stack.store.shares()).toEqual([]);
  expect((await submitDelegation(accountUrl("josh"), { user: "josh", delegate: "sam-caregiver", relationship: "spouse", sites: ["Lakeside Imaging"] })).status).toBe(303);
});

describe("the Authorization Server's forms", () => {
  const FORM = { "content-type": "application/x-www-form-urlencoded" };
  const own = new URL(CONFIG.authUrl);
  const form = (path: string, headers: Record<string, string>, body: string) => fetch(`${CONFIG.authUrl}${path}`, { method: "POST", headers: { ...FORM, ...headers }, body, redirect: "manual" });
  const FOREIGN: Record<string, string>[] = [{ host: "evil.example", origin: "http://evil.example" }, { host: "evil.example" }, { host: `127.0.0.1:${PORTS.demo}` }, { host: own.host, origin: "http://evil.example" }, { host: own.host, origin: "null" }];
  const signedIn = async () => (await form("/account/signin", {}, "username=josh")).headers.get("set-cookie")!.split(";")[0]!;
  const delegation = "delegate=sam-caregiver&relationship=spouse&sites_shown=1&sites=Lakeside+Imaging";
  test("every account_session cookie is tried, so a stale one sent first doesn't sign the person out", async () => {
    const cookie = await signedIn();
    const page = (c: string) => fetch(`${CONFIG.authUrl}/account`, { headers: { cookie: c } }).then(r => r.text());
    expect(await page(`account_session=stale-from-a-dropped-sandbox; ${cookie}`)).toContain("Sign out");
    expect(await page(`x${cookie}`)).not.toContain("Sign out");
  });
  const newTxn = async () => {
    const page = await (await fetch(buildAuthorization(`${CONFIG.authUrl}/authorize`, "portal-app").url)).text();
    return page.match(/txn=([^&"]+)/)![1]!;
  };

  test("signing in to the account page under another Host or origin is refused, with no session", async () => {
    for (const headers of FOREIGN) {
      const r = await form("/account/signin", headers, "username=josh");
      expect(r.status).toBe(403);
      expect(r.headers.get("set-cookie")).toBeNull();
    }
  });
  test("no account write acts under another Host or origin, even with a real session", async () => {
    await stack.resetAll();
    const cookie = await signedIn();
    expect((await form("/account/delegations", { cookie }, delegation)).status).toBe(303);
    const before = JSON.stringify(stack.store.snapshot());
    for (const headers of FOREIGN) {
      for (const [path, body] of [["/account/delegations", "delegate=alex-neighbor&relationship=neighbor&sites=Lakeside+Imaging"], ["/account/delegations/revoke", "delegate=sam-caregiver"], ["/account/apps/revoke", "client=portal-app"], ["/account/signout", ""]] as const) {
        expect((await form(path, { ...headers, cookie }, body)).status).toBe(403);
      }
    }
    expect(JSON.stringify(stack.store.snapshot())).toBe(before);
    // The session outlived the refused sign-outs.
    expect((await form("/account/delegations", { cookie }, delegation)).status).toBe(303);
  });
  test("the authorization forms are refused under another Host or origin, and leave the request usable", async () => {
    await stack.resetAll();
    const txn = await newTxn();
    for (const headers of FOREIGN) expect((await form(`/authorize/signin?txn=${txn}`, headers, "username=josh")).status).toBe(403);
    expect((await fetch(`${CONFIG.authUrl}/authorize/consent?txn=${txn}`)).status).toBe(401);
    expect((await form(`/authorize/signin?txn=${txn}`, {}, "username=josh")).status).toBe(303);
    for (const headers of FOREIGN) expect((await form(`/authorize/decision?txn=${txn}`, headers, "decision=approve")).status).toBe(403);
    const decided = await form(`/authorize/decision?txn=${txn}`, {}, "decision=approve");
    expect(decided.status).toBe(302);
    expect(new URL(decided.headers.get("location")!).searchParams.get("code")).toBeTruthy();
  });
  test("every address of the service works, and so does a request with no Host", async () => {
    // The service's own port, not the one origin apps are given.
    const direct = (headers: Record<string, string>) => fetch(`http://127.0.0.1:${PORTS.auth}/account/signin`, { method: "POST", headers: { ...FORM, ...headers }, body: "username=josh", redirect: "manual" });
    for (const host of [`127.0.0.1:${PORTS.auth}`, `localhost:${PORTS.auth}`]) {
      expect((await direct({ host })).status).toBe(303);
      expect((await direct({ host, origin: `http://${host}` })).status).toBe(303);
    }
    const body = "username=josh";
    const reply = await new Promise<string>((resolve, reject) => {
      let text = "";
      Bun.connect({ hostname: "127.0.0.1", port: PORTS.auth, socket: { open(c) { c.write(`POST /account/signin HTTP/1.0\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: ${body.length}\r\n\r\n${body}`); }, data(_c, d) { text += d.toString(); }, close() { resolve(text); }, error(_c, e) { reject(e); } } }).catch(reject);
    });
    expect(reply).toStartWith("HTTP/1.1 303");
    const noHost = await stack.auth.fetch(new Request(`${CONFIG.authUrl}/account/signin`, { method: "POST", headers: FORM, body: "username=josh" }));
    expect(noHost.status).toBe(303);
  });
  test("the tailnet address and name count as the service's own, on the port in use", () => {
    const hosts = ownHosts(PORTS.auth, { name: "box.example.ts.net", ip: "100.64.0.7" });
    expect(hosts).toContain(`100.64.0.7:${PORTS.auth}`);
    expect(hosts).toContain(`box.example.ts.net:${PORTS.auth}`);
    expect(hosts).not.toContain(`100.64.0.7:${PORTS.auth + 1}`);
    expect(ownHosts(PORTS.auth)).not.toContain("100.64.0.7:4603");
  });
});

test("a refused sandbox mint makes no sandbox", async () => {
  const before = stack.sandboxes.size;
  const send = (body: string, headers: Record<string, string> = {}) => fetch(`${CONFIG.demoUrl}/api/sandboxes`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
  expect((await send('{"store":"elsewhere"}')).status).toBe(400);
  expect((await send("{}", { origin: "https://evil.example" })).status).toBe(403);
  expect(stack.sandboxes.size).toBe(before);
});

test("the demo's pages and read APIs answer only at its own addresses", async () => {
  const demo = (path: string, headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${PORTS.demo}${path}`, { headers });
  for (const path of ["/", "/explore", "/activity", "/api/activity", "/api/activity/summary", "/api/sandbox/policy", "/api/sandbox/storage", "/api/sandbox/explore/cast", "/api/sandbox", "/api/sandbox/keys-shared-on-purpose"]) {
    expect((await demo(path, { host: "evil.example" })).status).toBe(403);
    // The management API wants the admin token, and refuses before anything else.
    expect([path, (await demo(path)).status]).toEqual([path, path.startsWith("/api/sandbox") && path !== "/api/sandbox/keys-shared-on-purpose" ? 401 : 200]);
  }
});

test("the pages' fonts come with the page, never from another site: the stylesheet carries them, or names them on this origin", async () => {
  const base = `http://127.0.0.1:${PORTS.demo}`;
  const html = await (await fetch(`${base}/`)).text();
  const css = (await Promise.all([...html.matchAll(/<link rel="stylesheet"[^>]*href="([^"]+)"/g)].map(async m => (await fetch(new URL(m[1]!, base))).text()))).join("\n");
  const fonts = [...css.matchAll(/@font-face\s*\{[^}]*?url\(["']?([^)"']+)["']?\)/g)].map(m => m[1]!);
  expect(fonts.length).toBe(2);
  for (const font of fonts) {
    // Bun may carry a font in the stylesheet itself, as a data address, or serve it as a file of its own.
    const data = font.startsWith("data:");
    if (!data) expect(new URL(font, base).origin).toBe(base);
    const bytes = data ? Uint8Array.from(atob(font.split(",")[1]!), c => c.charCodeAt(0)) : new Uint8Array(await (await fetch(new URL(font, base))).arrayBuffer());
    expect(bytes.slice(0, 4)).toEqual(new Uint8Array([0x77, 0x4f, 0x46, 0x32]));
  }
});

test("every service refuses another host name, and a Host that doesn't parse gets no 500", async () => {
  for (const base of [CONFIG.authUrl, CONFIG.imagingUrl, CONFIG.proxyUrl]) for (const host of ["evil.example", "127.0.0.1:99999", "127.0.0.1:1.evil.example"]) {
    expect([base, host, (await fetch(`${base}/account`, { headers: { host } })).status]).toEqual([base, host, 403]);
  }
  expect((await fetch(`${CONFIG.imagingUrl}/.well-known/authzen-configuration`, { headers: { host: "evil.example" } })).status).toBe(403);
  expect((await fetch(`${CONFIG.proxyUrl}/favicon.ico`)).status).toBe(204);
});

test("the Bearer scheme is case-insensitive on the Clinical FHIR Server, and an empty search has no empty entry array", async () => {
  const { access_token: token } = await scriptedLaunch("josh", "portal-app", { scope: "launch/patient patient/*.rs" });
  for (const scheme of ["Bearer", "bearer", "BEARER"]) expect((await fetch(`${CONFIG.authUrl}/fhir/Patient/josh-example`, { headers: { Authorization: `${scheme} ${token}` } })).status).toBe(200);
  const empty: any = await (await fetch(`${CONFIG.imagingUrl}/fhir/ImagingStudy?patient=josh-example&identifier=nothing`, { headers: { Authorization: `Bearer ${token}` } })).json();
  expect(empty.total).toBe(0);
  expect("entry" in empty).toBe(false);
});

test("the proxy answers odd Hosts and request targets without a 500", async () => {
  const { port, hostname } = new URL(`http://127.0.0.1:${PORTS.proxy}`);
  const raw = (head: string) => new Promise<string>((resolve, reject) => {
    let out = "";
    const s = connect(Number(port), hostname, () => s.write(head));
    s.on("data", d => { out += d; }); s.on("end", () => resolve(out)); s.on("error", reject);
  });
  const own = `${hostname}:${port}`;
  const status = (r: string) => Number(r.split(" ")[1]);
  for (const target of ["//", "///", "//[", "//:x", "/\\\\"]) expect([target, status(await raw(`GET ${target} HTTP/1.1\r\nHost: ${own}\r\nConnection: close\r\n\r\n`))]).toEqual([target, 404]);
  expect(status(await raw(`GET http://evil.example/wado/-/studies/1 HTTP/1.1\r\nHost: ${own}\r\nConnection: close\r\n\r\n`))).toBe(401);
  expect(status(await raw("GET / HTTP/1.1\r\nHost:\r\nConnection: close\r\n\r\n"))).toBe(403);
  expect(status(await raw(`GET / HTTP/1.1\r\nHost: ${own}\r\nHost: evil.example\r\nConnection: close\r\n\r\n`))).toBeLessThan(500);
  expect(status(await raw(`GET /wado/-/studies/1 HTTP/1.1\r\nHost: ${own}\r\nHost: evil.example\r\nConnection: close\r\n\r\n`))).not.toBe(401);
});

