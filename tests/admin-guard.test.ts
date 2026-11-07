// The admin screen can only choose between fixed options. These tests read the source, and send every
// write route the kinds of input it must never act on.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStack, type Stack } from "../src/stack";
import { registerClients } from "../src/flows";
import { createDemoServer } from "../src/demo-server";
import { createCollector } from "../src/trace-collector";
import { resetClock } from "../src/clock";
import { CONFIG } from "../src/config";
import { CLOCK_CHOICES, SETTING_CHOICES } from "../src/admin-api";

const root = join(import.meta.dir, "..");

const FORBIDDEN: [string, RegExp][] = [
  ["a file system import", /(from\s*|import\s*|import\(\s*|require\(\s*)["'](node:)?fs(\/promises)?["']/],
  ["a process import", /(from\s*|import\s*|import\(\s*|require\(\s*)["'](node:)?child_process["']/],
  ["Bun.spawn", /Bun\s*\.\s*spawn/],
  ["Bun.write", /Bun\s*\.\s*write/],
  ["Bun.file", /Bun\s*\.\s*file/],
  ["Bun.$", /Bun\s*\.\s*\$/],
  ["eval", /\beval\s*\(/],
  ["new Function", /new\s+Function\b/],
  ["a dynamic import", /\bimport\s*\(/],
  ["require", /\brequire\s*\(/],
  ["a path-like field in a request body", /\b(b|body)(\.|\[["'])(path|file|filename|dir|directory|folder|db|dbPath|database|command|cmd)\b/],
  ["a path-like query field", /searchParams\.get\(["'](path|file|filename|dir|directory|folder|db|dbPath|database|command|cmd)["']\)/],
];
const violations = (source: string) => FORBIDDEN.filter(([, pattern]) => pattern.test(source)).map(([name]) => name);
const IMPORTS = /^\s*(?:(?:import|export)\s[^;]*?from\s+|import\s+)["']([^"']+)["']/gm;
const importsOf = (source: string) => [...source.matchAll(IMPORTS)].map(m => m[1]!);

describe("the admin API's source", () => {
  for (const file of ["src/admin-api.ts", "src/rule-presets.ts"]) {
    const source = readFileSync(join(root, file), "utf8");
    test(`${file} has no file, process, or code-running access`, () => { expect(violations(source)).toEqual([]); });
    test(`${file} imports only a short list of the demo's own modules`, () => {
      expect(importsOf(source).length).toBeGreaterThan(0);
      for (const name of importsOf(source)) expect(["./stack", "./policy-store", "./clock", "./config", "./rule-presets", "./archive/types"]).toContain(name);
    });
  }
  test("the guard catches each thing it looks for", () => {
    for (const bad of [
      'import { readFileSync } from "node:fs";', 'import fs from "fs";', 'import { rm } from "node:fs/promises";', 'import { spawn } from "child_process";', 'import { spawn } from "node:child_process";',
      "Bun.spawn(['ls']);", "Bun.spawnSync(['ls']);", "Bun.write(p, x);", "Bun.file(p);", "Bun.$`ls`;", "eval(x);", 'new Function("return 1");', 'await import("node:fs");', 'require("fs");',
      "open(b.path);", "open(body.file);", 'open(b["path"]);', 'url.searchParams.get("path");',
    ]) expect(violations(bad)).not.toEqual([]);
    expect(importsOf('import { readFileSync } from "node:fs";\nimport type { Stack } from "./stack";\nimport "fs";\nexport { x } from "./y";')).toEqual(["node:fs", "./stack", "fs", "./y"]);
  });
  test("reading the URL's own path isn't mistaken for a path in a request", () => {
    expect(violations('const p = url.pathname.slice(1); const saved = stores.saved.info(); x.path;')).toEqual([]);
  });
});

describe("over HTTP", () => {
  let stack: Stack; let demo: ReturnType<typeof createDemoServer>; let dir: string; let canary: string; let bait: string;
  const RULE = { id: "keep", when: { client: "c" }, allow: { all: true } };
  const DELEGATION = { patient: "josh-example", grantedBy: "josh", delegate: "sam-caregiver", relationship: "caregiver", sites: ["Lakeside Imaging"] };
  const GRANT = { client: "portal-app", user: "josh", patient: "josh-example" };
  const fingerprint = () => JSON.stringify({ saved: stack.stores.saved.getPolicy(), settings: stack.stores.saved.getSettings(), scratch: stack.stores.scratch.getPolicy(), active: stack.stores.activeName, backend: stack.backend, outage: stack.imaging.outage, kid: stack.imaging.signingKid });

  beforeAll(async () => {
    stack = await startStack(root);
    demo = createDemoServer(stack, registerClients(stack), root);
    dir = mkdtempSync(join(tmpdir(), "admin-guard-"));
    canary = join(dir, "canary.txt");
    bait = join(dir, "must-not-appear.sqlite");
    writeFileSync(canary, "untouched");
  });
  afterAll(() => { stack.stop(); rmSync(dir, { recursive: true, force: true }); });
  beforeEach(() => {
    stack.useStore("saved");
    stack.resetSaved();
    stack.stores.saved.setPolicy({ rules: [RULE], delegations: [DELEGATION], appGrants: [GRANT] });
    stack.imaging.setOutage(false);
    resetClock();
    stack.setBackend("static-files");
  });

  const send = (method: string, path: string, body?: unknown) =>
    demo.fetch(new Request(`${CONFIG.demoUrl}${path}`, { method, headers: { "content-type": "application/json", host: new URL(CONFIG.demoUrl).host }, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) }));
  const hostile = () => [canary, bait, "../../../etc/passwd", "/etc/passwd", "file:///etc/passwd", "'; DROP TABLE rules; --", "x' OR '1'='1", "$(rm -rf /)", 1e12, -1, true, null, [], {}];
  const stillIntact = () => {
    expect(readFileSync(canary, "utf8")).toBe("untouched");
    expect(existsSync(bait)).toBe(false);
    expect(stack.stores.saved.rules()).toEqual([RULE]);
  };

  /** Every write route that takes a field: where it lives, the field, and a value that's a real choice. */
  const FIELDS: [string, string, string, unknown][] = [
    ["POST", "/api/admin/store/activate", "store", "saved"],
    ["POST", "/api/admin/store/reset-saved", "confirm", undefined],
    ["POST", "/api/admin/rule-set", "id", "no-extra-rules"],
    ...Object.entries(SETTING_CHOICES).map(([k, v]) => ["PUT", "/api/admin/settings", k, v[0]!.value] as [string, string, string, unknown]),
    ["POST", "/api/admin/clock", "advanceSeconds", CLOCK_CHOICES[0]!.value],
    ["POST", "/api/admin/backend", "backend", "static-files"],
    ["POST", "/api/admin/outage", "on", false],
  ];
  // These fields have some values that are real choices, which the list of hostile values holds too.
  const allowedHostile: Record<string, unknown[]> = { on: [true], confirm: [true] };

  for (const [method, path, field, good] of FIELDS) {
    test(`${method} ${path} (${field}) rejects anything outside its choices`, async () => {
      const before = fingerprint();
      for (const value of hostile()) {
        if (allowedHostile[field]?.includes(value)) continue;
        const r = await send(method, path, { [field]: value });
        expect(`${JSON.stringify(value)}: ${r.status}`).toBe(`${JSON.stringify(value)}: 400`);
      }
      for (const body of ["{not json", "[]", "null", '"/etc/passwd"', "1"]) expect((await send(method, path, body)).status).toBe(400);
      expect(fingerprint()).toBe(before);
      stillIntact();
      if (good !== undefined) {
        for (const extra of [{ path: bait }, { file: canary }, { db: bait }, { command: "rm -rf /" }, { rules: [] }]) expect((await send(method, path, { [field]: good, ...extra })).status).toBe(400);
        expect((await send(method, `${path}?path=${encodeURIComponent(bait)}`, { [field]: good })).status).toBe(400);
        expect(fingerprint()).toBe(before);
      }
      stillIntact();
    });
  }
  test("reset saved takes only confirm: true", async () => {
    const before = fingerprint();
    expect((await send("POST", "/api/admin/store/reset-saved", { confirm: true, path: bait })).status).toBe(400);
    expect((await send("POST", `/api/admin/store/reset-saved?path=${encodeURIComponent(bait)}`, { confirm: true })).status).toBe(400);
    expect(fingerprint()).toBe(before);
  });
  test("the clock takes only one named action", async () => {
    for (const body of [{ reset: true, advanceSeconds: 60 }, { reset: true, path: bait }, { advanceSeconds: 61 }, {}]) expect((await send("POST", "/api/admin/clock", body)).status).toBe(400);
    expect(stack.imaging.getPolicy() && (await (await send("GET", "/api/admin/status")).json() as any).clock.offsetSeconds).toBe(0);
  });
  for (const path of ["/store/reset-scratch", "/tokens/revoke-all", "/proxy/flush", "/signing-key/rotate"]) {
    test(`POST /api/admin${path} takes no input at all`, async () => {
      const before = fingerprint();
      for (const body of [{ path: bait }, { file: canary }, { store: "'; DROP TABLE rules; --" }, "../../etc/passwd", "[1]"]) expect((await send("POST", `/api/admin${path}`, body)).status).toBe(400);
      expect((await send("POST", `/api/admin${path}?path=${encodeURIComponent(bait)}`)).status).toBe(400);
      expect(fingerprint()).toBe(before);
      stillIntact();
    });
  }
  test("a delete identifies an existing row, and nothing else", async () => {
    const before = fingerprint();
    const d = "/api/admin/delegations", g = "/api/admin/app-grants";
    const q = (o: Record<string, string>) => `?${new URLSearchParams(o)}`;
    for (const sql of ["'; DROP TABLE delegations; --", "x' OR '1'='1", "%", "../../etc/passwd", canary]) {
      expect((await send("DELETE", d + q({ patient: sql, delegate: sql }))).status).toBe(404);
      expect((await send("DELETE", g + q({ client: sql, user: sql, patient: sql }))).status).toBe(404);
    }
    expect((await send("DELETE", d + q({ patient: DELEGATION.patient, delegate: DELEGATION.delegate, path: bait }))).status).toBe(400);
    expect((await send("DELETE", g + q({ ...GRANT, file: canary }))).status).toBe(400);
    expect((await send("DELETE", `${d}${q({ patient: DELEGATION.patient, delegate: DELEGATION.delegate })}&delegate=other`)).status).toBe(400);
    expect((await send("DELETE", d + q({ patient: DELEGATION.patient, delegate: DELEGATION.delegate }), { path: bait })).status).toBe(400);
    expect(fingerprint()).toBe(before);
    stillIntact();
  });
  test("no route accepts a path, and the replaced routes are gone", async () => {
    for (const [method, path] of [["PUT", "/api/admin/rules"], ["POST", "/api/admin/rules"], ["PUT", "/api/admin/rule-set"], ["POST", "/api/admin/settings"], ["PUT", "/api/admin/clock"], ["POST", "/api/admin/store/path"], ["PUT", "/api/admin/store"], ["POST", "/api/admin/store/open"], ["POST", "/api/admin/catalog"], ["POST", "/api/admin/export"], ["POST", "/api/admin/import"], ["POST", "/api/admin/../../etc/passwd"]] as const) {
      expect((await send(method, path, { path: bait, rules: [] })).status).toBe(404);
    }
    stillIntact();
  });
  test("the status shows store and catalog paths, read-only", async () => {
    const s: any = await (await send("GET", "/api/admin/status")).json();
    expect(s.store.saved.path).toBe(":memory:");
    expect(s.store.scratch.path).toBe(":memory:");
    expect(s.catalog.path).toBe(":memory:");
    const js = await (await send("GET", "/admin.js")).text();
    expect(js).toContain('row("Path", x => x.path)');
    expect(js).not.toMatch(/call\("(POST|PUT|DELETE)"[^)]*\bpath\b/);
  });
  test("the status is refused under another Host, before it shows anything", async () => {
    const status = (host: string) => demo.fetch(new Request(`${CONFIG.demoUrl}/api/admin/status`, { headers: { host } }));
    const r = await status("evil.example");
    expect(r.status).toBe(403);
    expect(await r.text()).not.toContain("store");
    expect((await status(new URL(CONFIG.demoUrl).host)).status).toBe(200);
  });
  test("/api/backend takes a backend name, and nothing else", async () => {
    for (const body of [{ backend: canary }, { backend: "'; DROP TABLE rules; --" }, { backend: "s3", path: bait }, "[]"]) expect((await send("POST", "/api/backend", body)).status).toBe(400);
    expect(stack.backend).toBe("static-files");
    stillIntact();
  });
  test("/api/policy is refused while saved policy is active, whatever it holds", async () => {
    for (const body of [{ rules: [] }, { path: bait }, "'; DROP TABLE rules; --"]) expect((await send("PUT", "/api/policy", body)).status).toBe(409);
    stillIntact();
  });
  test("/api/policy on flow scratch keeps strict validation, with no path-like field", async () => {
    stack.useStore("scratch");
    for (const body of [{ path: bait }, { rules: [], file: canary }, { rules: [{ id: "a", when: {}, allow: {}, path: bait }] }]) expect((await send("PUT", "/api/policy", body)).status).toBe(400);
    stillIntact();
  });
});

describe("the trace collector's clear and export", () => {
  let collector: ReturnType<typeof createCollector>; let dir: string; let canary: string;
  const T = "http://collector.test";
  const span = (session: string) => ({ session, trace: "t".repeat(32), span: "s1", service: "demo", kind: "check", name: "n", start: 1, end: 2, attrs: {} });
  beforeAll(() => {
    collector = createCollector(root);
    dir = mkdtempSync(join(tmpdir(), "trace-guard-"));
    canary = join(dir, "canary.txt");
    writeFileSync(canary, "untouched");
  });
  afterAll(() => { collector.close(); rmSync(dir, { recursive: true, force: true }); });
  const get = (path: string) => collector.fetch(new Request(`${T}${path}`));

  test("the source reads only its fixed list of pages", () => {
    const source = readFileSync(join(root, "src/trace-collector.ts"), "utf8");
    expect(source.match(/Bun\.file\(/g)?.length).toBe(1);
    expect(source).toContain('const page = (file: string) => new Response(Bun.file(join(root, file))');
    expect(source.match(/\bpage\(/g)?.length).toBe(2);
    expect(source).toContain('page("web/live.html")');
    expect(source).toContain("page(PAGES[p]!)");
    for (const pattern of [/Bun\s*\.\s*(spawn|write|\$)/, /["'](node:)?(child_process|fs)["']/, /\beval\s*\(/, /new\s+Function\b/]) expect(source).not.toMatch(pattern);
  });
  test("a session id only looks up a row: one that climbs out of a directory finds nothing", async () => {
    for (const id of ["..%2F..%2F..%2Fetc%2Fpasswd", "%2Fetc%2Fpasswd", encodeURIComponent(canary), "%27%3B%20DROP%20TABLE%20spans%3B%20--"]) {
      const r = await get(`/api/sessions/${id}/export`);
      expect(r.status).toBe(404);
      expect(await r.text()).not.toContain("untouched");
      const spans = await get(`/api/sessions/${id}/spans`);
      expect(await spans.text()).toBe("[]");
    }
    expect(readFileSync(canary, "utf8")).toBe("untouched");
  });
  test("a page's name can't reach past the list", async () => {
    for (const path of ["/etc/passwd", "/..%2F..%2Fetc%2Fpasswd", "/web/live.js", "/src/main.ts"]) expect((await get(path)).status).toBe(404);
  });
  test("a stored session named like a path exports as a plain file name", async () => {
    const id = "../../etc/passwd";
    await collector.fetch(new Request(`${T}/v1/spans`, { method: "POST", body: JSON.stringify([span(id)]) }));
    const r = await get(`/api/sessions/${encodeURIComponent(id)}/export`);
    expect(r.status).toBe(200);
    const name = r.headers.get("content-disposition")!.match(/filename="([^"]+)"/)![1]!;
    expect(name).not.toContain("/");
    expect(name).toBe("trace-.._.._etc_passwd.json");
    expect((await r.json() as any).session.id).toBe(id);
  });
  test("clear takes no path: it empties the store, and nothing else", async () => {
    await collector.fetch(new Request(`${T}/v1/spans`, { method: "POST", body: JSON.stringify([span("to-clear")]) }));
    const r = await collector.fetch(new Request(`${T}/api/sessions?path=${encodeURIComponent(canary)}`, { method: "DELETE", body: JSON.stringify({ path: canary }) }));
    expect(r.status).toBe(204);
    expect(collector.list()).toEqual([]);
    expect(readFileSync(canary, "utf8")).toBe("untouched");
  });
});
