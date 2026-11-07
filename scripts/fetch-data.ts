// Downloads the sources listed in data/studies.source.json, verifying each pinned SHA-256.
// Archives are unpacked into their own directories under data/sources/unpacked.
import { mkdir, exists } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const def = await Bun.file(join(root, "data/studies.source.json")).json();
const sources: any[] = def.sources;
const dir = join(root, "data/sources");

async function fetchOne(src: any) {
  const name = src.archive ?? src.file;
  const dest = join(dir, "raw", name);
  await mkdir(join(dest, ".."), { recursive: true });
  if (await exists(dest)) {
    const have = createHash("sha256").update(new Uint8Array(await Bun.file(dest).arrayBuffer())).digest("hex");
    if (have === src.sha256) return dest;
  }
  const res = await fetch(src.url);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const have = createHash("sha256").update(bytes).digest("hex");
  if (have !== src.sha256) throw new Error(`${name}: checksum mismatch`);
  await Bun.write(dest, bytes);
  return dest;
}

let done = 0;
const queue = [...sources];
await Promise.all(Array.from({ length: 6 }, async () => {
  while (queue.length) {
    const src = queue.shift()!;
    const dest = await fetchOne(src);
    if (src.archive?.endsWith(".tgz")) {
      const out = join(dir, "unpacked", src.archive.replace(/\.tgz$/, ""));
      await mkdir(out, { recursive: true });
      const p = Bun.spawn(["tar", "-xzf", dest, "-C", out, "--no-same-owner", "--no-same-permissions"]);
      if ((await p.exited) !== 0) throw new Error(`tar failed: ${src.archive}`);
    }
    done++;
    if (done % 5 === 0 || done === sources.length) console.log(`${done}/${sources.length}`);
  }
}));
console.log("fetched", sources.length);
