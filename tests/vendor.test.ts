// The viewer-kit download keeps nothing unless the tarball matches its pin and every file its SHA256SUMS,
// and the demo serves only the bytes it checked at startup.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchViewerKit, loadViewerKit, VIEWER_KIT, VIEWER_KIT_FILES } from "../src/vendor";
import { startStack, type Stack } from "../src/stack";
import { registerClients } from "../src/flows";
import { createDemoServer } from "../src/demo-server";
import { CONFIG } from "../src/config";

const ROOT = join(import.meta.dir, "..");

const work = mkdtempSync(join(tmpdir(), "vendor-test-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

/** A release tarball, with one file changed after its SHA256SUMS was written when `tamper` is set. */
function release(name: string, tamper?: string) {
  const dir = join(work, name, "kit");
  mkdirSync(dir, { recursive: true });
  const files = Object.fromEntries(VIEWER_KIT_FILES.map(f => [f, `contents of ${f}`]));
  for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text);
  writeFileSync(join(dir, "SHA256SUMS"), Object.entries(files).map(([f, text]) => `${sha(text)}  ${f}`).join("\n") + "\n");
  if (tamper) writeFileSync(join(dir, tamper), "something else");
  const tar = join(work, name, "kit.tar.gz");
  expect(Bun.spawnSync(["tar", "-czf", tar, "-C", join(work, name), "kit"]).exitCode).toBe(0);
  const bytes = readFileSync(tar);
  return { bytes, sha256: sha(bytes), fetch: (async () => new Response(bytes)) as unknown as typeof fetch };
}

test("a good release unpacks, and a second run keeps it without fetching", async () => {
  const r = release("good");
  const dir = join(work, "out-good");
  await fetchViewerKit({ url: "http://x/kit.tar.gz", sha256: r.sha256, dir, fetch: r.fetch });
  for (const f of VIEWER_KIT_FILES) expect(existsSync(join(dir, f))).toBe(true);
  await fetchViewerKit({ url: "http://x/kit.tar.gz", sha256: r.sha256, dir, fetch: (() => { throw new Error("fetched again"); }) as any });
});

test("a tarball with the wrong hash is refused, and nothing is kept", async () => {
  const r = release("wrong-hash");
  const dir = join(work, "out-wrong-hash");
  await expect(fetchViewerKit({ url: "http://x/kit.tar.gz", sha256: "0".repeat(64), dir, fetch: r.fetch })).rejects.toThrow(/tarball has SHA-256/);
  expect(existsSync(dir)).toBe(false);
});

test("a file that doesn't match SHA256SUMS is refused, and nothing is kept", async () => {
  const r = release("tampered", "viewer-kit.js");
  const dir = join(work, "out-tampered");
  await expect(fetchViewerKit({ url: "http://x/kit.tar.gz", sha256: r.sha256, dir, fetch: r.fetch })).rejects.toThrow(/viewer-kit\.js has SHA-256/);
  expect(existsSync(dir)).toBe(false);
});

test("a release changed on disk is removed before fetching again, and not kept when that fails", async () => {
  const r = release("changed");
  const dir = join(work, "out-changed");
  await fetchViewerKit({ url: "http://x/kit.tar.gz", sha256: r.sha256, dir, fetch: r.fetch });
  expect(loadViewerKit(dir, r.sha256)?.get("viewer-kit.js")).toEqual(new TextEncoder().encode("contents of viewer-kit.js"));
  writeFileSync(join(dir, "viewer-kit.js"), "alert('changed')");
  expect(loadViewerKit(dir, r.sha256)).toBeUndefined();
  await expect(fetchViewerKit({ url: "http://x/kit.tar.gz", sha256: r.sha256, dir, fetch: (async () => { throw new Error("offline"); }) as any })).rejects.toThrow("offline");
  expect(existsSync(dir)).toBe(false);
  // Fetching again with the network back restores it.
  await fetchViewerKit({ url: "http://x/kit.tar.gz", sha256: r.sha256, dir, fetch: r.fetch });
  expect(loadViewerKit(dir, r.sha256)).toBeDefined();
});

test("a release from another pin isn't loaded", async () => {
  const r = release("other-pin");
  const dir = join(work, "out-other-pin");
  await fetchViewerKit({ url: "http://x/kit.tar.gz", sha256: r.sha256, dir, fetch: r.fetch });
  expect(loadViewerKit(dir, "0".repeat(64))).toBeUndefined();
});

describe("the demo serves", () => {
  let stack: Stack;
  beforeAll(async () => { stack = await startStack(ROOT); });
  afterAll(() => stack.stop());
  const get = (demo: ReturnType<typeof createDemoServer>, name: string) => demo.fetch(new Request(`${CONFIG.demoUrl}/vendor/viewer-kit/${name}`, { headers: { host: new URL(CONFIG.demoUrl).host } }));
  test("only the bytes it checked at startup, so a change on disk afterwards isn't served", async () => {
    const r = release("served");
    const dir = join(work, "out-served");
    await fetchViewerKit({ url: "http://x/kit.tar.gz", sha256: r.sha256, dir, fetch: r.fetch });
    // The demo checks against the real pin, so this release stands in for it by its own pin file.
    writeFileSync(join(dir, ".tarball.sha256"), VIEWER_KIT.sha256);
    const demo = createDemoServer(stack, registerClients(stack), ROOT, { viewerKitDir: dir });
    writeFileSync(join(dir, "viewer-kit.js"), "alert('changed')");
    const res = await get(demo, "viewer-kit.js");
    expect([res.status, await res.text()]).toEqual([200, "contents of viewer-kit.js"]);
    expect((await get(demo, "SHA256SUMS")).status).toBe(404);
  });
  test("nothing, when what's on disk doesn't check out, so thumbnails keep their placeholders", async () => {
    const r = release("unchecked");
    const dir = join(work, "out-unchecked");
    await fetchViewerKit({ url: "http://x/kit.tar.gz", sha256: r.sha256, dir, fetch: r.fetch });
    writeFileSync(join(dir, ".tarball.sha256"), VIEWER_KIT.sha256);
    writeFileSync(join(dir, "viewer-kit.js"), "alert('changed')");
    const demo = createDemoServer(stack, registerClients(stack), ROOT, { viewerKitDir: dir });
    for (const f of VIEWER_KIT_FILES) expect([f, (await get(demo, f)).status]).toEqual([f, 404]);
    expect((await get(createDemoServer(stack, registerClients(stack), ROOT, { viewerKitDir: join(work, "nowhere") }), "viewer-kit.js")).status).toBe(404);
  });
});

test("the pin is one tag and one hash", () => {
  expect(VIEWER_KIT.url).toContain(VIEWER_KIT.tag);
  expect(VIEWER_KIT.sha256).toMatch(/^[0-9a-f]{64}$/);
});
