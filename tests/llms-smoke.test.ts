// llms.txt's smoke test, as the site serves it, against a sandbox here: as a new sandbox answers, and with every
// condition an app check stages. llms.txt shows the same file, so the doc can't drift from the code.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createDemoServer } from "../src/demo-server";
import { registerClients } from "../src/flows";
import { CONFIG, PORTS } from "../src/config";
import { startStack, type Stack } from "../src/stack";
import { adminHeaders } from "./admin-token";

setDefaultTimeout(90000);
const root = join(import.meta.dir, "..");
let stack: Stack, demo: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
  stack = await startStack(root);
  demo = Bun.serve({ port: PORTS.demo, hostname: "127.0.0.1", ...createDemoServer(stack, registerClients(stack), root) });
});
afterAll(() => { demo?.stop(true); stack?.stop(); });

/** Runs the served smoke.mjs against a new sandbox, after `stage` has set it up. */
async function smoke(stage?: (base: string) => Promise<void>) {
  const { base } = await (await fetch(`${CONFIG.demoUrl}/api/sandboxes`, { method: "POST" })).json() as { base: string };
  await stage?.(base);
  const dir = mkdtempSync(join(root, ".run", "smoke-"));
  try {
    writeFileSync(join(dir, "smoke.mjs"), await (await fetch(`${CONFIG.demoUrl}${base}/smoke.mjs`)).text());
    const run = Bun.spawn(["node", join(dir, "smoke.mjs")], { env: { ...process.env, SANDBOX: `${CONFIG.demoUrl}${base}` }, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);
    return { code, out: out.trim(), err: err.slice(0, 800) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("llms.txt shows the smoke test the site serves, as is", async () => {
  const { base } = await (await fetch(`${CONFIG.demoUrl}/api/sandboxes`, { method: "POST" })).json() as { base: string };
  const [doc, file] = await Promise.all([fetch(`${CONFIG.demoUrl}${base}/llms.txt`).then(r => r.text()), fetch(`${CONFIG.demoUrl}${base}/smoke.mjs`).then(r => r.text())]);
  expect(doc).toContain(`\`\`\`js\n${file}\`\`\``);
});
test("the smoke test runs as served and prints OK, retrieving from every study", async () => {
  const r = await smoke();
  expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: "" });
  expect(r.out).toMatch(/^OK: 6 studies, an image from each \(\d+ bytes\), 6 reports$/);
});
test("and with every condition an app check stages: small pages, 503s, and Endpoints in all three forms", async () => {
  const r = await smoke(async base => {
    const res = await fetch(`${CONFIG.demoUrl}${base}/api/sandbox/faults`, { method: "POST", headers: { ...await adminHeaders({ fetch: q => fetch(q) }, base), "content-type": "application/json" }, body: JSON.stringify({ pageSize: 2, endpointForms: true, searchRetryAfter: 1, retrievalRetryAfter: 1 }) });
    expect(res.status).toBe(200);
  });
  expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: "" });
  expect(r.out).toMatch(/^OK: 6 studies, an image from each/);
});
