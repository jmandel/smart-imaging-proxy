// Saved sandboxes: a sandbox's file outlasts its process, and only its owner ends it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptOldDirectory, createSandboxes } from "../src/sandboxes";
import { allowMint } from "../src/gateway";
import { startStack, type Stack } from "../src/stack";
import { createDemoServer } from "../src/demo-server";
import { registerClients } from "../src/flows";
import { CONFIG } from "../src/config";
import { APPROVALS_ON_FILE } from "../src/stores";

const dir = mkdtempSync(join(tmpdir(), "sandboxes-"));
let stack: Stack;
beforeAll(async () => { stack = await startStack(join(import.meta.dir, "..")); });
afterAll(() => { stack.stop(); rmSync(dir, { recursive: true, force: true }); });
const sandboxes = (extra = {}) => createSandboxes(stack.shared, { sandboxesDir: dir, ...extra });
const sandbox = (s: ReturnType<typeof sandboxes>, id: string) => { const r = s.resolve(id); if (!("sandbox" in r)) throw new Error(r.error); return r.sandbox; };

test("a sandbox comes back after a restart, with its clock, backend, and policy", () => {
  const first = sandboxes();
  const w = first.mint({ saved: true }), id = w.id!;
  w.clock.advance(3600);
  w.setBackend("s3");
  w.store.setNote("marker", "kept");
  first.close();
  expect(existsSync(join(dir, `${id}.sqlite`))).toBe(true);
  const back = sandbox(sandboxes(), id);
  expect(back.clock.offset()).toBe(3600);
  expect(back.backend).toBe("s3");
  expect(back.store.note("marker")).toBe("kept");
  back.close();
});
test("past the open limit, a closed sandbox reopens from its file", () => {
  const s = sandboxes({ max: 1 });
  const a = s.mint({ saved: true }), id = a.id!;
  a.setBackend("orthanc");
  s.mint();
  expect(s.has(id)).toBe(false);
  expect(sandbox(s, id).backend).toBe("orthanc");
  s.close();
});
test("a tour's or a check's sandbox leaves no file, and idles out", () => {
  const s = sandboxes({ idleMs: 0 });
  const kept = s.mint({ saved: true }).id!, temporary = s.mint().id!;
  expect(existsSync(join(dir, `${temporary}.sqlite`))).toBe(false);
  Bun.sleepSync(2);
  s.mint();
  expect(s.has(temporary)).toBe(false);
  expect(s.has(kept)).toBe(true);
  s.close();
});
test("a tour started in someone's sandbox resets it and stays there", async () => {
  const demo = createDemoServer(stack, registerClients(stack), join(import.meta.dir, ".."));
  const w = stack.sandboxes.mint();
  w.clock.advance(7200);
  w.store.setNote("mine", "kept");
  const before = stack.sandboxes.size;
  const r = await demo.fetch(new Request(`${CONFIG.demoUrl}${w.prefix}/api/tours/own/start`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } }));
  expect(r.status).toBe(201);
  expect((await r.json() as any).sandbox.base).toBe(w.prefix);
  expect(stack.sandboxes.size).toBe(before);
  expect(w.clock.offset()).toBe(0);
});
test("a tour leaves other apps' tokens and approvals alone, and resets its own", async () => {
  const demo = createDemoServer(stack, registerClients(stack), join(import.meta.dir, ".."));
  const w = stack.sandboxes.mint();
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
  // The other app's approval stays, and the tour's own app is back to what's on file, with no one's choice of sites.
  const rows = (xs: { app: string; by: string; patient: string; sites?: string[] }[]) => xs.map(a => [a.app, a.by, a.patient, a.sites ?? null].join(" ")).sort();
  expect(rows(w.store.approvals())).toEqual(rows([{ app: "app:my-own-app", by: "user:josh", patient: "patient:josh-example" }, ...APPROVALS_ON_FILE]));
});
test("sandboxes saved under the directory's old name are kept", () => {
  const home = mkdtempSync(join(tmpdir(), "rename-"));
  mkdirSync(join(home, "worlds"));
  writeFileSync(join(home, "worlds", "kept.sqlite"), "x");
  const now = join(home, "sandboxes");
  adoptOldDirectory(now);
  expect(existsSync(join(now, "kept.sqlite"))).toBe(true);
  expect(existsSync(join(home, "worlds"))).toBe(false);
  adoptOldDirectory(now);
  expect(existsSync(join(now, "kept.sqlite"))).toBe(true);
  rmSync(home, { recursive: true, force: true });
});
test("only removal ends one, and it leaves no file", () => {
  const s = sandboxes();
  const id = s.mint({ saved: true }).id!;
  s.remove(id);
  expect(existsSync(join(dir, `${id}.sqlite`))).toBe(false);
  expect(s.resolve(id)).toMatchObject({ status: 404 });
  s.close();
});
test("an id can't reach outside the directory", () => expect(sandboxes().resolve("../../etc/passwd")).toMatchObject({ status: 404 }));
test("one address can't create sandboxes without end", () => {
  const t = 1_000_000_000_000;
  for (let i = 0; i < 120; i++) expect(allowMint("9.9.9.9", t)).toBe(true);
  expect(allowMint("9.9.9.9", t)).toBe(false);
  expect(allowMint("8.8.8.8", t)).toBe(true);
  expect(allowMint("9.9.9.9", t + 3601_000)).toBe(true);
});
