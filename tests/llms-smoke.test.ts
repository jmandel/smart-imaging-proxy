// llms.txt's smoke test, run exactly as written against a sandbox here, so the doc can't drift from the code.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createDemoServer } from "../src/demo-server";
import { registerClients } from "../src/flows";
import { CONFIG, PORTS } from "../src/config";
import { startStack, type Stack } from "../src/stack";

setDefaultTimeout(60000);
const root = join(import.meta.dir, "..");
let stack: Stack, demo: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
  stack = await startStack(root);
  demo = Bun.serve({ port: PORTS.demo, hostname: "127.0.0.1", ...createDemoServer(stack, registerClients(stack), root) });
});
afterAll(() => { demo?.stop(true); stack?.stop(); });

test("llms.txt's smoke test runs as written and prints OK", async () => {
  const doc = await Bun.file(join(root, "src", "llms.txt")).text();
  const script = doc.match(/## Smoke test[\s\S]*?```js\n([\s\S]*?)```/)?.[1];
  expect(script).toBeTruthy();
  const { base } = await (await fetch(`${CONFIG.demoUrl}/api/sandboxes`, { method: "POST" })).json() as { base: string };
  const dir = mkdtempSync(join(root, ".run", "smoke-"));
  try {
    writeFileSync(join(dir, "smoke.mjs"), script!);
    const run = Bun.spawn(["node", join(dir, "smoke.mjs")], { env: { ...process.env, SANDBOX: `${CONFIG.demoUrl}${base}` }, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);
    expect({ code, out: out.trim().slice(0, 3), err: err.slice(0, 800) }).toEqual({ code: 0, out: "OK:", err: "" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
