// The live trace has to show a request's whole journey, correlated across services.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { startStack, type Stack } from "../src/stack";
import { defaultsFor, FLOWS, registerClients, runStep, startFlow } from "../src/flows";

let stack: Stack; let clients: any;
beforeAll(async () => { stack = await startStack(join(import.meta.dir, "..")); clients = registerClients(stack); });
afterAll(() => stack.stop());

async function run(id: string) {
  const flow = FLOWS.find(f => f.id === id)!;
  const c = await startFlow(stack, clients, flow);
  for (const s of flow.steps) await runStep(c, flow, s.id, defaultsFor(c, flow, s.id));
  await Bun.sleep(150);
  return [...stack.collector.sessions.get(c.session)!.spans.values()];
}

test("the fast path appears as in-memory checks, with no decision call", async () => {
  const spans = await run("token-refresh");
  const trace = spans.find(s => s.kind === "action" && s.attrs.step === "start")!.trace;
  const inTrace = spans.filter(s => s.trace === trace);
  expect(inTrace.some(s => s.name === "fast path: token hash matches ath" && s.status === "ok")).toBe(true);
  expect(inTrace.some(s => s.name.startsWith("can_i"))).toBe(false);
});

test("a decision call is correlated across proxy, policy, and Authorization Server", async () => {
  const spans = await run("token-refresh");
  const trace = spans.find(s => s.kind === "action" && s.attrs.step === "refresh")!.trace;
  const inTrace = spans.filter(s => s.trace === trace);
  const services = new Set(inTrace.map(s => s.service));
  for (const svc of ["user", "app", "dicomweb-proxy", "policy", "authorization-server", "backend"]) expect(services.has(svc as any)).toBe(true);
  expect(inTrace.some(s => s.name === "fast path: token hash matches ath" && s.status === "denied")).toBe(true);
  const call = inTrace.find(s => s.name.startsWith("can_i"))!;
  const server = inTrace.find(s => s.parent === call.span)!;
  expect(server.service).toBe("policy");
  expect(inTrace.some(s => s.name.startsWith("policy evaluation:") && s.attrs.why)).toBe(true);
  expect(inTrace.some(s => s.name.startsWith("decision:"))).toBe(true);
});

test("every span has a parent in its trace, except the root", async () => {
  const spans = await run("backend-referral");
  const ids = new Set(spans.map(s => s.span));
  const orphans = spans.filter(s => s.parent && !ids.has(s.parent));
  expect(orphans.map(s => s.name)).toEqual([]);
  expect(spans.every(s => s.end !== undefined)).toBe(true);
});

test("no token or client assertion is ever recorded", async () => {
  const spans = await run("backend-referral");
  const text = JSON.stringify(spans);
  expect(text).not.toMatch(/access_token/);
  expect(text).not.toMatch(/client_assertion=/);
});
