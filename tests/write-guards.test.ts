// Writes outside the admin API stay on rails too, and refused requests have no side effects.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { startStack, type Stack } from "../src/stack";
import { registerClients } from "../src/flows";
import { createDemoServer } from "../src/demo-server";
import { accountUrl, submitDelegation } from "../src/flows/oauth";
import { CONFIG, PORTS } from "../src/config";
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

test("a refused store switch changes nothing", async () => {
  const before = stack.stores.activeName;
  const send = (body: string) => fetch(`${CONFIG.demoUrl}/api/admin/store/activate`, { method: "POST", headers: { "content-type": "application/json" }, body });
  expect((await send('{"store":"elsewhere"}')).status).toBe(400);
  expect((await send("not json")).status).toBe(400);
  expect(stack.stores.activeName).toBe(before);
});
