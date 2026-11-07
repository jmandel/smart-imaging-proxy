// The viewer-kit download keeps nothing unless the tarball matches its pin and every file its SHA256SUMS.
import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchViewerKit, VIEWER_KIT, VIEWER_KIT_FILES } from "../src/vendor";

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

test("the pin is one tag and one hash", () => {
  expect(VIEWER_KIT.url).toContain(VIEWER_KIT.tag);
  expect(VIEWER_KIT.sha256).toMatch(/^[0-9a-f]{64}$/);
});
