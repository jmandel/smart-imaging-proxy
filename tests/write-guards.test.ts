// Writes outside the admin API stay on rails too, and refused requests have no side effects.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { startStack, type Stack } from "../src/stack";
import { registerClients } from "../src/flows";
import { createDemoServer } from "../src/demo-server";
import { accountUrl, buildAuthorization, scriptedLaunch, submitDelegation } from "../src/flows/oauth";
import { CONFIG, PORTS } from "../src/config";
import { ownHosts } from "../src/admin-api";
import { createCollector } from "../src/trace-collector";

let stack: Stack; let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
  stack = await startStack(join(import.meta.dir, ".."));
  server = Bun.serve({ port: PORTS.demo, hostname: "127.0.0.1", fetch: createDemoServer(stack, registerClients(stack), join(import.meta.dir, "..")).fetch });
});
afterAll(() => { server.stop(true); stack.stop(); });

const span = JSON.stringify([{ session: "guard-test", trace: "a".repeat(32), span: "b".repeat(16), service: "demo", kind: "check", name: "planted", start: 1, attrs: {} }]);
const raw = (path: string, method: string, headers: Record<string, string>, body?: string) => fetch(`${CONFIG.traceUrl}${path}`, { method, headers, body });

test("spans are refused from a browser or under another host name", async () => {
  expect((await raw("/v1/spans", "POST", { origin: "https://evil.example" }, span)).status).toBe(403);
  expect((await raw("/v1/spans", "POST", { host: "evil.example" }, span)).status).toBe(403);
  expect(stack.collector.list().some(s => s.id === "guard-test")).toBe(false);
  expect((await raw("/v1/spans", "POST", {}, span)).status).toBe(202);
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
  expect((await raw("/api/sessions", "GET", { host: `127.0.0.1:${PORTS.trace + 1}` })).status).toBe(403);
});

test("traces can be read at this service's own addresses, the viewer's pages load, and a request with no Host is fine", async () => {
  for (const host of [`127.0.0.1:${PORTS.trace}`, `localhost:${PORTS.trace}`]) {
    for (const path of ["/", "/api/stats", "/api/sessions", "/live.js"]) expect([host, path, (await raw(path, "GET", { host })).status]).toEqual([host, path, 200]);
    const stream = await raw("/stream", "GET", { host });
    expect(stream.status).toBe(200);
    await stream.body!.cancel();
  }
  const c = createCollector(join(import.meta.dir, ".."));
  expect((await c.fetch(new Request("http://trace.test/api/sessions"))).status).toBe(200);
  c.close();
});

test("a delegation takes only an offered relationship", async () => {
  stack.resetAll();
  const r = await submitDelegation(accountUrl("josh"), { user: "josh", delegate: "sam-caregiver", relationship: "<script>x</script>", sites: ["Lakeside Imaging"] });
  expect(r.status).toBe(400);
  expect(stack.stores.active.delegations()).toEqual([]);
  expect((await submitDelegation(accountUrl("josh"), { user: "josh", delegate: "sam-caregiver", relationship: "spouse", sites: ["Lakeside Imaging"] })).status).toBe(303);
});

describe("the Authorization Server's forms", () => {
  const FORM = { "content-type": "application/x-www-form-urlencoded" };
  const own = new URL(CONFIG.authUrl);
  const form = (path: string, headers: Record<string, string>, body: string) => fetch(`${CONFIG.authUrl}${path}`, { method: "POST", headers: { ...FORM, ...headers }, body, redirect: "manual" });
  const FOREIGN: Record<string, string>[] = [{ host: "evil.example", origin: "http://evil.example" }, { host: "evil.example" }, { host: `127.0.0.1:${PORTS.demo}` }, { host: own.host, origin: "http://evil.example" }, { host: own.host, origin: "null" }];
  const signedIn = async () => (await form("/account/signin", {}, "username=josh")).headers.get("set-cookie")!.split(";")[0]!;
  const delegation = "delegate=sam-caregiver&relationship=spouse&sites_shown=1&sites=Lakeside+Imaging";
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
    stack.resetAll();
    const cookie = await signedIn();
    expect((await form("/account/delegations", { cookie }, delegation)).status).toBe(303);
    const before = JSON.stringify(stack.stores.active.getPolicy());
    for (const headers of FOREIGN) {
      for (const [path, body] of [["/account/delegations", "delegate=alex-neighbor&relationship=neighbor&sites=Lakeside+Imaging"], ["/account/delegations/revoke", "delegate=sam-caregiver"], ["/account/apps/revoke", "client=portal-app"], ["/account/signout", ""]] as const) {
        expect((await form(path, { ...headers, cookie }, body)).status).toBe(403);
      }
    }
    expect(JSON.stringify(stack.stores.active.getPolicy())).toBe(before);
    // The session outlived the refused sign-outs.
    expect((await form("/account/delegations", { cookie }, delegation)).status).toBe(303);
  });
  test("the authorization forms are refused under another Host or origin, and leave the request usable", async () => {
    stack.resetAll();
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
    for (const host of [`127.0.0.1:${PORTS.auth}`, `localhost:${PORTS.auth}`]) {
      expect((await form("/account/signin", { host }, "username=josh")).status).toBe(303);
      expect((await form("/account/signin", { host, origin: `http://${host}` }, "username=josh")).status).toBe(303);
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
    const hosts = ownHosts(PORTS.auth, { name: "box.example.ts.net", ip: "100.79.84.61" });
    expect(hosts).toContain(`100.79.84.61:${PORTS.auth}`);
    expect(hosts).toContain(`box.example.ts.net:${PORTS.auth}`);
    expect(hosts).not.toContain(`100.79.84.61:${PORTS.auth + 1}`);
    expect(ownHosts(PORTS.auth)).not.toContain("100.79.84.61:4603");
  });
});

test("a refused store switch changes nothing", async () => {
  const before = stack.stores.activeName;
  const send = (body: string) => fetch(`${CONFIG.demoUrl}/api/admin/store/activate`, { method: "POST", headers: { "content-type": "application/json" }, body });
  expect((await send('{"store":"elsewhere"}')).status).toBe(400);
  expect((await send("not json")).status).toBe(400);
  expect(stack.stores.activeName).toBe(before);
});

test("the demo's pages and read APIs answer only at its own addresses", async () => {
  const demo = (path: string, headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${PORTS.demo}${path}`, { headers });
  for (const path of ["/", "/browse", "/api/policy", "/api/backends", "/api/flows"]) {
    expect((await demo(path, { host: "evil.example" })).status).toBe(403);
    expect((await demo(path)).status).toBe(200);
  }
});

test("the pages' fonts are served locally, by the demo and by the trace viewer", async () => {
  for (const base of [`http://127.0.0.1:${PORTS.demo}`, CONFIG.traceUrl]) for (const font of ["atkinson-next", "atkinson-mono"]) {
    const r = await fetch(`${base}/fonts/${font}.woff2`);
    expect(r.status).toBe(200);
    expect(new Uint8Array(await r.arrayBuffer()).slice(0, 4)).toEqual(new Uint8Array([0x77, 0x4f, 0x46, 0x32]));
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
  const { access_token: token } = await scriptedLaunch("josh");
  for (const scheme of ["Bearer", "bearer", "BEARER"]) expect((await fetch(`${CONFIG.authUrl}/fhir/Patient/josh-example`, { headers: { Authorization: `${scheme} ${token}` } })).status).toBe(200);
  const empty: any = await (await fetch(`${CONFIG.imagingUrl}/fhir/ImagingStudy?patient=josh-example&identifier=nothing`, { headers: { Authorization: `Bearer ${token}` } })).json();
  expect(empty.total).toBe(0);
  expect("entry" in empty).toBe(false);
});

test("a malformed step request isn't a server error", async () => {
  const step = (name: string, body: string) => fetch(`http://127.0.0.1:${PORTS.demo}/api/flows/patient-sites/steps/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body });
  expect((await step("constructor", "{}")).status).toBe(404);
  const nulled = await step("consent", "null");
  expect(nulled.status).toBeLessThan(500);
});
