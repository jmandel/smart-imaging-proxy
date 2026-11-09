// Saved worlds: a world's file outlasts its process, and only its owner ends it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScopes } from "../src/scopes";
import { allowMint } from "../src/gateway";
import { startStack, type Stack } from "../src/stack";
import { createDemoServer } from "../src/demo-server";
import { registerClients } from "../src/flows";
import { CONFIG } from "../src/config";

const dir = mkdtempSync(join(tmpdir(), "worlds-"));
let stack: Stack;
beforeAll(async () => { stack = await startStack(join(import.meta.dir, "..")); });
afterAll(() => { stack.stop(); rmSync(dir, { recursive: true, force: true }); });
const scopes = (extra = {}) => createScopes(stack.shared, { worldsDir: dir, ...extra });
const world = (s: ReturnType<typeof scopes>, id: string) => { const r = s.resolve(id); if (!("world" in r)) throw new Error(r.error); return r.world; };

test("a world comes back after a restart, with its clock, backend, and policy", () => {
  const first = scopes();
  const w = first.mint({ saved: true }), id = w.scope!;
  w.clock.advance(3600);
  w.setBackend("s3");
  w.store.setNote("marker", "kept");
  first.close();
  expect(existsSync(join(dir, `${id}.sqlite`))).toBe(true);
  const back = world(scopes(), id);
  expect(back.clock.offset()).toBe(3600);
  expect(back.backend).toBe("s3");
  expect(back.store.note("marker")).toBe("kept");
  back.close();
});
test("past the open limit, a closed world reopens from its file", () => {
  const s = scopes({ max: 1 });
  const a = s.mint({ saved: true }), id = a.scope!;
  a.setBackend("orthanc");
  s.mint();
  expect(s.has(id)).toBe(false);
  expect(world(s, id).backend).toBe("orthanc");
  s.close();
});
test("a tour's or a check's world leaves no file, and idles out", () => {
  const s = scopes({ idleMs: 0 });
  const kept = s.mint({ saved: true }).scope!, temporary = s.mint().scope!;
  expect(existsSync(join(dir, `${temporary}.sqlite`))).toBe(false);
  Bun.sleepSync(2);
  s.mint();
  expect(s.has(temporary)).toBe(false);
  expect(s.has(kept)).toBe(true);
  s.close();
});
test("a tour started in someone's world resets it and stays there", async () => {
  const demo = createDemoServer(stack, registerClients(stack), join(import.meta.dir, ".."));
  const w = stack.scopes.mint();
  w.clock.advance(7200);
  w.store.setNote("mine", "kept");
  const before = stack.scopes.size;
  const r = await demo.fetch(new Request(`${CONFIG.demoUrl}${w.prefix}/api/tours/own/start`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } }));
  expect(r.status).toBe(201);
  expect((await r.json() as any).scope.base).toBe(w.prefix);
  expect(stack.scopes.size).toBe(before);
  expect(w.clock.offset()).toBe(0);
});
test("a tour leaves other apps' tokens and approvals alone, and resets its own", async () => {
  const demo = createDemoServer(stack, registerClients(stack), join(import.meta.dir, ".."));
  const w = stack.scopes.mint();
  const approval = (app: string) => ({ by: "user:josh", app, patient: "patient:josh-example" });
  w.store.putApproval(approval("app:my-own-app"));
  w.store.putApproval(approval("app:portal-app"));
  const exp = w.clock.now() + 3600;
  w.store.putToken("mine", "access", { client_id: "my-own-app", scope: "patient/*.rs", patient: "josh-example" } as any, exp);
  w.store.putToken("tours", "access", { client_id: "portal-app", scope: "patient/*.rs", patient: "josh-example" } as any, exp);
  const r = await demo.fetch(new Request(`${CONFIG.demoUrl}${w.prefix}/api/tours/own/start`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } }));
  expect(r.status).toBe(201);
  expect(w.store.getToken("mine", "access")).toBeDefined();
  expect(w.store.getToken("tours", "access")).toBeUndefined();
  expect(w.store.approvals().map(a => a.app)).toEqual(["app:my-own-app"]);
});
test("only removal ends one, and it leaves no file", () => {
  const s = scopes();
  const id = s.mint({ saved: true }).scope!;
  s.remove(id);
  expect(existsSync(join(dir, `${id}.sqlite`))).toBe(false);
  expect(s.resolve(id)).toMatchObject({ status: 404 });
  s.close();
});
test("an id can't reach outside the directory", () => expect(scopes().resolve("../../etc/passwd")).toMatchObject({ status: 404 }));
test("one address can't create worlds without end", () => {
  const t = 1_000_000_000_000;
  for (let i = 0; i < 120; i++) expect(allowMint("9.9.9.9", t)).toBe(true);
  expect(allowMint("9.9.9.9", t)).toBe(false);
  expect(allowMint("8.8.8.8", t)).toBe(true);
  expect(allowMint("9.9.9.9", t + 3601_000)).toBe(true);
});
