// Core stands alone: nothing in it imports from outside the package, apart from the runtime's own
// modules and the dependencies its package.json declares.
import { describe, expect, test } from "bun:test";
import { dirname, join, relative, resolve, sep } from "node:path";

const root = resolve(import.meta.dir, "..");
const pkg = await Bun.file(join(root, "package.json")).json();
const declared = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]);
const SPECIFIERS = [
  /^\s*(?:import|export)\s[^;]*?\sfrom\s+["']([^"']+)["']/gm,
  /^\s*import\s+["']([^"']+)["']/gm,
  /\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
  /\brequire\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
];
const specifiersOf = (source: string) => SPECIFIERS.flatMap(re => [...source.matchAll(re)].map(m => m[1]!));
/** Why an import from this file reaches outside core, if it does. */
function outside(file: string, spec: string): string | undefined {
  if (spec.startsWith("node:") || spec.startsWith("bun:") || spec === "bun") return undefined;
  if (spec.startsWith(".") || spec.startsWith("/")) {
    const target = resolve(dirname(file), spec);
    return target === root || target.startsWith(root + sep) ? undefined : `reaches ${relative(root, target)}`;
  }
  const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!;
  return declared.has(name) ? undefined : `isn't a declared dependency`;
}

describe("core's imports", () => {
  test("stay inside the package", async () => {
    const found: string[] = [];
    let files = 0;
    for await (const f of new Bun.Glob("**/*.{ts,js,mjs,json}").scan({ cwd: root })) {
      if (f.startsWith("node_modules/") || f.endsWith(".json")) continue;
      files++;
      const path = join(root, f);
      for (const spec of specifiersOf(await Bun.file(path).text())) {
        const why = outside(path, spec);
        if (why) found.push(`${f}: "${spec}" ${why}`);
      }
    }
    expect(files).toBeGreaterThan(20);
    expect(found).toEqual([]);
  });
  test("the check catches what it looks for", () => {
    const file = join(root, "src", "x.ts");
    const imports = (source: string) => specifiersOf(source).map(s => outside(file, s)).filter(Boolean);
    expect(imports('import { CONFIG } from "../../../src/config";')).toHaveLength(1);
    expect(imports('import people from "../../data/patient.json";')).toHaveLength(1);
    // Split, so the scan of this file doesn't find it.
    expect(imports(`const m = await ${"import"}("../../../src/trace");`)).toHaveLength(1);
    expect(imports('export * from "../../../src/stack";')).toHaveLength(1);
    expect(imports('import "left-pad";')).toHaveLength(1);
    expect(imports('import { x } from "./proxy";\nimport { Database } from "bun:sqlite";\nimport { S3Client } from "bun";\nimport { join } from "node:path";')).toEqual([]);
  });
});
