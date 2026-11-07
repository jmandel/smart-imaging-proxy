// viewer-kit, the browser's DICOM decoder, which draws the film sheets' thumbnails. A pinned release of
// github.com/jmandel/shlink-dicom (Apache-2.0), downloaded once into $DEMO_STORAGE/vendor by
// scripts/viewer-kit.ts and served at /vendor/viewer-kit/. It's never committed.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { STORAGE } from "./config";

export const VIEWER_KIT = {
  tag: "viewer-kit-cfb08f3",
  url: "https://github.com/jmandel/shlink-dicom/releases/download/viewer-kit-cfb08f3/shlink-dicom-viewer-kit-cfb08f3.tar.gz",
  sha256: "e1cfcd12556dd00b746b4a9a83110c7883415545bbb29e6e72ef61f795cffa35",
};
export const VIEWER_KIT_DIR = `${STORAGE}/vendor/${VIEWER_KIT.tag}`;
/** What the pages load. Each is checked against the release's SHA256SUMS when it's unpacked. */
export const VIEWER_KIT_FILES = ["viewer-kit.js", "decoder-worker.js", "shl_dicom_decode.wasm", "shl_dicom_decode_jxl.wasm", "LICENSE"];

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Checks every file SHA256SUMS lists, and that it lists every file the pages load. Throws on any mismatch. */
export function verifySums(dir: string) {
  const sums = readFileSync(join(dir, "SHA256SUMS"), "utf8").trim().split("\n").map(l => l.match(/^([0-9a-f]{64})\s+\*?(.+)$/)).map(m => { if (!m) throw new Error("viewer-kit: SHA256SUMS has a line that isn't a hash and a name"); return { sha: m[1]!, name: m[2]! }; });
  for (const f of VIEWER_KIT_FILES) if (!sums.some(s => s.name === f)) throw new Error(`viewer-kit: SHA256SUMS doesn't list ${f}`);
  for (const { sha, name } of sums) {
    if (name.includes("/") || name.startsWith(".")) throw new Error(`viewer-kit: SHA256SUMS names ${name}, outside the release`);
    const path = join(dir, name);
    if (!existsSync(path)) throw new Error(`viewer-kit: ${name} is missing`);
    const got = sha256(readFileSync(path));
    if (got !== sha) throw new Error(`viewer-kit: ${name} has SHA-256 ${got}, and SHA256SUMS says ${sha}`);
  }
}

/**
 * Downloads and unpacks the release into `dir`, unless it's there and checks out. The tarball has to
 * match its pinned hash and every file its SHA256SUMS, or nothing is kept, and this throws.
 */
export async function fetchViewerKit(o: { url?: string; sha256?: string; dir?: string; fetch?: typeof fetch } = {}) {
  const url = o.url ?? VIEWER_KIT.url, sha = o.sha256 ?? VIEWER_KIT.sha256, dir = o.dir ?? VIEWER_KIT_DIR;
  if (existsSync(join(dir, "SHA256SUMS")) && existsSync(join(dir, ".tarball.sha256")) && readFileSync(join(dir, ".tarball.sha256"), "utf8") === sha) {
    try { verifySums(dir); return dir; } catch { /* Fetch it again. */ }
  }
  const res = await (o.fetch ?? fetch)(url);
  if (!res.ok) throw new Error(`viewer-kit: ${url}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const got = sha256(bytes);
  if (got !== sha) throw new Error(`viewer-kit: the tarball has SHA-256 ${got}, expected ${sha}`);
  mkdirSync(join(dir, ".."), { recursive: true });
  const work = mkdtempSync(join(dir, "..", ".viewer-kit-"));
  try {
    await Bun.write(join(work, "release.tar.gz"), bytes);
    const tar = Bun.spawnSync(["tar", "-xzf", join(work, "release.tar.gz"), "-C", work, "--no-same-owner"], { stderr: "pipe" });
    if (tar.exitCode !== 0) throw new Error(`viewer-kit: tar failed: ${tar.stderr}`);
    // The release unpacks into one directory, named for its tag.
    const top = [...new Bun.Glob("*/SHA256SUMS").scanSync(work)][0];
    if (!top) throw new Error("viewer-kit: the tarball holds no SHA256SUMS");
    const unpacked = join(work, top, "..");
    verifySums(unpacked);
    await Bun.write(join(unpacked, ".tarball.sha256"), sha);
    rmSync(dir, { recursive: true, force: true });
    renameSync(unpacked, dir);
  } finally { rmSync(work, { recursive: true, force: true }); }
  return dir;
}
