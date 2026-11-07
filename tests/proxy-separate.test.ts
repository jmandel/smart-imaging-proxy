// The services as their own operating system processes, reaching each other only over HTTP: a real
// launch, search and retrieval across them, then a clean shutdown.
import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CATALOG_DB } from "../src/catalog";
import { CONFIG, PORTS } from "../src/config";
import { scriptedLaunch } from "../src/flows/oauth";
import { boundaryOf, readMultipart } from "../src/multipart";

const root = join(import.meta.dir, "..");
const ACCEPT = "multipart/related; type=application/dicom; transfer-syntax=*";
const running = new Set<ReturnType<typeof Bun.spawn>>();
// The archive this run reads, and a catalog of the run's own unless it was given one, so a child never opens the default files.
const scratch = mkdtempSync(join(tmpdir(), "proxy-separate-"));
const catalogDb = process.env.CATALOG_DB || join(scratch, "catalog.sqlite");
afterAll(() => { for (const p of running) p.kill("SIGKILL"); rmSync(scratch, { recursive: true, force: true }); });

function start(role: string, secret: string | undefined, extra: Record<string, string> = {}) {
  // Only what a process needs, plus PATH and HOME, so it can't be leaning on anything else from here.
  const env: Record<string, string> = { PATH: process.env.PATH!, HOME: process.env.HOME!, DEMO_PORT_OFFSET: process.env.DEMO_PORT_OFFSET ?? "0", DEMO_TAILNET: "0", POLICY_STORE: "memory", TRACE_STORE: "memory", ARCHIVE_DIR: CONFIG.archive.dir, CATALOG_DB: catalogDb, ...extra };
  if (secret) env.SERVICE_SECRET = secret;
  const p = Bun.spawn(["bun", join(root, "src/main.ts"), "--role", role], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
  running.add(p);
  return p;
}
const reachable = (url: string) => fetch(url, { signal: AbortSignal.timeout(500) }).then(() => true, () => false);
async function waitFor(urls: string[], ms = 30000) {
  const end = Date.now() + ms;
  for (const u of urls) while (!await reachable(u)) { if (Date.now() > end) throw new Error(`${u} never came up`); await Bun.sleep(50); }
}
async function stop(p: ReturnType<typeof Bun.spawn>) {
  p.kill("SIGTERM");
  expect(await p.exited).toBe(0);
  running.delete(p);
}
async function retrieve(url: string, token: string) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: ACCEPT } });
  let parts = 0, complete = false;
  const b = boundaryOf(r.headers.get("content-type"));
  if (r.ok && b) { for await (const e of readMultipart(r.body as any, b)) { if (e.type === "start") parts++; if (e.type === "complete") complete = true; } }
  else await r.body?.cancel();
  return { status: r.status, parts, complete };
}
const SERVICE_URLS = [`${CONFIG.authUrl}/fhir/.well-known/smart-configuration`, `${CONFIG.imagingUrl}/.well-known/jwks.json`, CONFIG.traceUrl];

for (const others of [["imaging,auth,trace"], ["imaging", "auth", "trace"]]) {
  describe(`a proxy process, with ${others.join(" + ")}`, () => {
    test("launch, search and retrieval work across processes, the proxy needs nothing else, and all stop cleanly", async () => {
      const secret = randomBytes(24).toString("base64url");
      const rest = others.map(role => start(role, secret));
      const proxy = start("proxy", secret, { PROXY_BACKEND: "static-files" });
      await waitFor([...SERVICE_URLS, `${CONFIG.proxyUrl}/wado/-/studies/1.2`]);
      expect(catalogDb).not.toBe(DEFAULT_CATALOG_DB);
      expect(existsSync(catalogDb)).toBe(true);

      const t = await scriptedLaunch("josh");
      expect(t.access_token).toBeTruthy();
      const bundle: any = await (await fetch(`${CONFIG.imagingUrl}/fhir/ImagingStudy?patient=josh-example&_include=ImagingStudy:endpoint`, { headers: { Authorization: `Bearer ${t.access_token}` } })).json();
      const study = bundle.entry.find((e: any) => e.resource.id === "xr-wrist-left-2012").resource;
      const uid = study.identifier[0].value.replace("urn:oid:", "");
      const base = bundle.entry.find((e: any) => e.fullUrl === study.endpoint[0].reference).resource.address;
      expect(base).toStartWith(`${CONFIG.proxyUrl}/wado/`);

      // The signed URL, which needs the keys the proxy fetched over HTTP.
      const signed = `${base}/studies/${uid}`;
      expect(await retrieve(signed, t.access_token)).toEqual({ status: 200, parts: study.numberOfInstances, complete: true });
      // A plain URL, which needs the decision API.
      const plain = `${CONFIG.proxyUrl}/wado/-/studies/${uid}`;
      expect(await retrieve(plain, t.access_token)).toEqual({ status: 200, parts: study.numberOfInstances, complete: true });
      expect((await retrieve(plain, "not-a-real-token")).status).toBe(401);

      // The refresh endpoint knows the credential from the environment.
      const refresh = (auth?: string) => fetch(`${CONFIG.proxyUrl}/internal/keys/refresh`, { method: "POST", headers: auth ? { Authorization: auth } : {} }).then(r => r.status);
      expect(await refresh()).toBe(401);
      expect(await refresh(`Bearer ${secret}`)).toBe(204);

      // With the others gone, a signed URL is still decided by the proxy's own copy of the keys.
      for (const p of rest) await stop(p);
      expect(await reachable(SERVICE_URLS[1]!)).toBe(false);
      expect(await retrieve(signed, t.access_token)).toEqual({ status: 200, parts: study.numberOfInstances, complete: true });
      expect((await retrieve(`${CONFIG.proxyUrl}/wado/-/studies/${uid}`, "another-token")).status).toBe(503);

      await stop(proxy);
      expect(await reachable(`${CONFIG.proxyUrl}/wado/-/studies/1.2`)).toBe(false);
    }, 60000);
  });
}

describe("starting a role", () => {
  test("without SERVICE_SECRET, or with an unknown role, it stops with a clear message", async () => {
    for (const [role, secret, wanted] of [["proxy", undefined, "SERVICE_SECRET"], ["imaging", undefined, "SERVICE_SECRET"], ["nonsense", "x", "--role takes"], ["all,proxy", "x", "--role takes"]] as const) {
      const p = start(role, secret);
      expect(await p.exited).not.toBe(0);
      running.delete(p);
      expect(await new Response(p.stderr as any).text()).toContain(wanted);
    }
    expect(PORTS.proxy).toBeGreaterThan(0);
  });
  test("a bad PROXY_BACKEND stops it too", async () => {
    const p = start("proxy", "x", { PROXY_BACKEND: "nope" });
    expect(await p.exited).not.toBe(0);
    running.delete(p);
    expect(await new Response(p.stderr as any).text()).toContain("PROXY_BACKEND");
  });
});
