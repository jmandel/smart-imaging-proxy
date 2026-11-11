// Saved sandboxes: a sandbox's file outlasts its process, and only its owner ends it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSandboxes } from "../src/sandboxes";
import { allowMint } from "../src/gateway";
import { startStack, type Stack } from "../src/stack";
import { createDemoServer } from "../src/demo-server";
import { registerClients } from "../src/flows";
import { CONFIG } from "../src/config";
import { adminFor } from "./admin-token";

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
test("faults survive a restart, and an app check a restart cut off puts the sandbox back as it was before the run", () => {
  const first = sandboxes();
  const w = first.mint({ saved: true }), id = w.id!;
  w.setFaults({ decisionOutage: true, pageSize: 2 });
  first.close();
  const back = sandbox(sandboxes(), id);
  expect(back.faults()).toMatchObject({ decisionOutage: true, pageSize: 2, searchRetryAfter: null });
  // A run stages its conditions over what was there; the restart ends it, and only the run's staging goes.
  const before = back.faults();
  back.setAppCheck({ run: "r1", client: "app-x", script: "s", staged: [], startedAt: "", endsAt: "" }, { pageSize: before.pageSize, searchRetryAfter: null, retrievalRetryAfter: null, endpointForms: false });
  back.setFaults({ pageSize: 1, searchRetryAfter: 1, retrievalRetryAfter: 1, endpointForms: true });
  back.close();
  const again = sandbox(sandboxes(), id);
  expect(again.appCheck).toBeUndefined();
  expect(again.faults()).toEqual({ decisionOutage: true, truncateAfter: null, pageSize: 2, searchRetryAfter: null, retrievalRetryAfter: null, endpointForms: false });
  again.clearRuntime();
  again.close();
  expect(sandbox(sandboxes(), id).faults()).toMatchObject({ decisionOutage: false, pageSize: null });
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
test("a check's sandbox leaves no file, and idles out", () => {
  const s = sandboxes({ idleMs: 0 });
  const kept = s.mint({ saved: true }).id!, temporary = s.mint().id!;
  expect(existsSync(join(dir, `${temporary}.sqlite`))).toBe(false);
  Bun.sleepSync(2);
  s.mint();
  expect(s.has(temporary)).toBe(false);
  expect(s.has(kept)).toBe(true);
  s.close();
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
