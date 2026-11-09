// Typed events, as the collector keeps them: one per thing core or the Authorization Server did,
// linked by the hashes they share, and never holding a token.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { startStack, type Stack } from "../src/stack";
import { defaultsFor, FLOWS, registerClients, runStep, startFlow } from "../src/flows";
import { createCollector } from "../src/trace-collector";

const ROOT = join(import.meta.dir, "..");
const SPANS = "test-span-credential";
const T = "http://trace.test";
let stack: Stack; let clients: any;
beforeAll(async () => { stack = await startStack(ROOT); clients = registerClients(stack); });
afterAll(() => stack.stop());

test("a flow's sign-in, search and retrieval each record events, linked by the token's hash", async () => {
  const flow = FLOWS.find(f => f.id === "patient-sites")!;
  const c = await startFlow(stack, clients, flow);
  for (const s of ["consent", "search", "retrieve"]) await runStep(c, flow, s, defaultsFor(c, flow, s));
  await Bun.sleep(150);
  const events = stack.collector.store.events({ session: c.session });
  const kinds = events.map(e => e.kind);
  for (const k of ["token.issued", "policy.written", "search.returned", "context.signed", "proxy.fast-path", "stream.done"]) expect(kinds).toContain(k);
  const issued = events.find(e => e.kind === "token.issued")!;
  expect(issued).toMatchObject({ service: "authorization-server", who: "user:josh", outcome: "ok", sandbox: c.sandbox.id });
  const token = issued.links.find(l => l.startsWith("token:"))!;
  // The proxy knows only the token's hash, and the store names its person from the token.
  const stream = events.find(e => e.kind === "stream.done")!;
  expect(stream.links).toContain(token);
  expect(stream.who).toBe("user:josh");
  expect(stack.collector.store.events({ link: token }).length).toBeGreaterThanOrEqual(4);
  expect(JSON.stringify(events)).not.toMatch(/"access_token":"(?!sha256)/);
  // Read through the sandbox's own collector, with filters.
  const listed: any = await (await fetch(`${c.sandbox.urls.trace}/api/events?kind=search.returned`)).json();
  expect(listed.events.length).toBeGreaterThan(0);
  expect(listed.events.every((e: any) => e.kind === "search.returned" && e.sandbox === c.sandbox.id)).toBe(true);
  expect(listed.facets.kinds).toContain("stream.done");
});

test("events come in only with the span credential, and must be well formed", async () => {
  const c = createCollector(ROOT, { mode: "memory" }, SPANS);
  const ev = { session: "s", trace: "a".repeat(32), service: "app", at: 1, kind: "token.issued", outcome: "ok", links: ["token:abc"], data: {}, who: "user:x" };
  const post = (body: unknown, auth = SPANS) => c.fetch(new Request(`${T}/v1/events`, { method: "POST", headers: { authorization: `Bearer ${auth}` }, body: JSON.stringify(body) }));
  const get = async (path: string): Promise<any> => (await c.fetch(new Request(T + path))).json();
  expect((await post([ev], "wrong")).status).toBe(401);
  expect((await post([{ ...ev, outcome: "maybe" }])).status).toBe(400);
  expect((await post([{ ...ev, links: ["has space"] }])).status).toBe(400);
  expect((await post([ev, { ...ev, kind: "stream.done", who: undefined }])).status).toBe(202);
  const got = await get("/api/events?link=token:abc");
  expect(got.events.map((e: any) => [e.kind, e.who])).toEqual([["token.issued", "user:x"], ["stream.done", "user:x"]]);
  expect((await get("/api/events?outcome=ok&kind=stream.done")).events.length).toBe(1);
  await c.fetch(new Request(`${T}/api/sessions`, { method: "DELETE" }));
  expect((await get("/api/events")).events).toEqual([]);
  c.close();
});
