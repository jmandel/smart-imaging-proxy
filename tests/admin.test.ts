// Each sandbox's own keys, and the admin token that its management API takes.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { createDemoServer } from "../src/demo-server";
import { registerClients } from "../src/flows";
import { CONFIG } from "../src/config";
import { startStack, type Stack } from "../src/stack";
import { adminToken, assertion, keysOf } from "./admin-token";

const root = join(import.meta.dir, "..");
let stack: Stack, demo: ReturnType<typeof createDemoServer>;
beforeAll(async () => { stack = await startStack(root); demo = createDemoServer(stack, registerClients(stack), root); });
afterAll(() => stack.stop());
const call = (prefix: string, path: string, init: RequestInit = {}) => demo.fetch(new Request(`${CONFIG.demoUrl}${prefix}${path}`, init));
const form = (o: Record<string, string>) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o).toString() });
const ASSERTION = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

test("each sandbox has its own keys, the same each time they're asked for", async () => {
  const a = stack.sandboxes.mint(), b = stack.sandboxes.mint();
  const [ka, ka2, kb] = await Promise.all([keysOf(demo, a.prefix), keysOf(demo, a.prefix), keysOf(demo, b.prefix)]);
  expect(ka.admin.client_id).toBe("sandbox-admin");
  expect(ka.services.map(s => s.client_id).sort()).toEqual(["hand-referral-service", "outside-release-service", "research-donation"]);
  expect(ka.admin.jwk.d).toBe(ka2.admin.jwk.d);
  expect(ka.admin.jwk.d).not.toBe(kb.admin.jwk.d);
  expect(ka.services[0]!.jwk.d).not.toBe(kb.services[0]!.jwk.d);
});

test("the management API takes only this sandbox's admin token", async () => {
  const a = stack.sandboxes.mint(), b = stack.sandboxes.mint();
  expect((await call(a.prefix, "/api/sandbox")).status).toBe(401);
  const mine = await adminToken(demo, a.prefix), theirs = await adminToken(demo, b.prefix);
  expect((await call(a.prefix, "/api/sandbox", { headers: { authorization: `Bearer ${mine}` } })).status).toBe(200);
  expect((await call(a.prefix, "/api/sandbox", { headers: { authorization: `Bearer ${theirs}` } })).status).toBe(401);
  // A person's token isn't an admin token, even one the admin got.
  const josh = await adminToken(demo, a.prefix, { user: "josh", patient: "josh-example" });
  expect((await call(a.prefix, "/api/sandbox", { headers: { authorization: `Bearer ${josh}` } })).status).toBe(401);
});

test("the policy API is behind it, for reads and writes", async () => {
  const a = stack.sandboxes.mint();
  const auth = { authorization: `Bearer ${await adminToken(demo, a.prefix)}` };
  const before: any = await (await call(a.prefix, "/api/sandbox/policy/shares", { headers: auth })).json();
  const made = await call(a.prefix, "/api/sandbox/policy/shares", { method: "POST", headers: { ...auth, "content-type": "application/json", origin: new URL(CONFIG.demoUrl).origin }, body: JSON.stringify({ from: "user:josh", with: "user:sam-caregiver", patient: "patient:josh-example", sites: ["Lakeside Imaging"], label: "caregiver" }) });
  expect(made.status).toBe(200);
  const after: any = await (await call(a.prefix, "/api/sandbox/policy/shares", { headers: auth })).json();
  expect(after.shares.length).toBe(before.shares.length + 1);
  expect((await call(a.prefix, "/api/sandbox/policy/shares")).status).toBe(401);
});

test("the admin gets a token as a person, which reads only what policy releases to that person's app", async () => {
  const a = stack.sandboxes.mint();
  const josh = await adminToken(demo, a.prefix, { user: "josh", patient: "josh-example" });
  const r = await fetch(`${a.urls.imaging}/fhir/ImagingStudy?patient=josh-example`, { headers: { authorization: `Bearer ${josh}` } });
  expect(r.status).toBe(200);
  const alex = await adminToken(demo, a.prefix, { user: "alex-neighbor", patient: "josh-example" });
  const none: any = await (await fetch(`${a.urls.imaging}/fhir/ImagingStudy?patient=josh-example`, { headers: { authorization: `Bearer ${alex}` } })).json();
  expect((none.entry ?? []).filter((e: any) => e.resource.resourceType === "ImagingStudy")).toEqual([]);
  await expect(adminToken(demo, a.prefix, { user: "nobody", patient: "josh-example" })).rejects.toThrow("invalid_request");
});

test("a service signs with its own sandbox's key, and another sandbox's key gets nothing", async () => {
  const a = stack.sandboxes.mint(), b = stack.sandboxes.mint();
  const [ka, kb] = await Promise.all([keysOf(demo, a.prefix), keysOf(demo, b.prefix)]);
  const svc = ka.services.find(s => s.client_id === "hand-referral-service")!, wrong = kb.services.find(s => s.client_id === "hand-referral-service")!;
  const ok: any = await (await fetch(ka.tokenEndpoint, form({ grant_type: "client_credentials", scope: svc.scope, client_assertion_type: ASSERTION, client_assertion: assertion(svc.client_id, svc.jwk, ka.tokenEndpoint) }))).json();
  expect(ok.access_token).toBeString();
  const refused = await fetch(ka.tokenEndpoint, form({ grant_type: "client_credentials", scope: svc.scope, client_assertion_type: ASSERTION, client_assertion: assertion(wrong.client_id, wrong.jwk, ka.tokenEndpoint) }));
  expect(refused.status).toBe(401);
});
