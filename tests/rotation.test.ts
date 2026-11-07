// What revocation controls really do to retrieval, on every backend. An old URL means one signed
// before a rotation. Each case reads the whole response, and reports how the proxy authorized it.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStack, type BackendName, type Stack } from "../src/stack";
import { registerClients } from "../src/flows";
import { createDemoServer } from "../src/demo-server";
import { scriptedLaunch } from "../src/flows/oauth";
import { CONFIG } from "../src/config";
import { boundaryOf, readMultipart } from "../src/multipart";
import { resetClock } from "../src/clock";
import { createProxy } from "../src/proxy";

const root = join(import.meta.dir, "..");
const BACKENDS: BackendName[] = (process.env.BACKENDS?.split(",") as BackendName[]) ?? ["static-files", "minio", "orthanc"];
const ACCEPT = "multipart/related; type=application/dicom; transfer-syntax=*";
const WRIST = "xr-wrist-left-2012";
let stack: Stack; let demo: ReturnType<typeof createDemoServer>;
beforeAll(async () => { stack = await startStack(root); demo = createDemoServer(stack, registerClients(stack), root); });
afterAll(() => stack.stop());
beforeEach(() => { stack.useStore("saved"); stack.resetSaved(); stack.stores.saved.revokeAllTokens(); stack.proxy.reset(); resetClock(); });

const admin = async (path: string) => {
  const r = await demo.fetch(new Request(`${CONFIG.demoUrl}/api/admin${path}`, { method: "POST", headers: { host: new URL(CONFIG.demoUrl).host } }));
  expect(r.status).toBe(200);
};
async function get(url: string, token: string) {
  const before = stack.proxy.events.length;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: ACCEPT } });
  let parts = 0;
  const boundary = boundaryOf(r.headers.get("content-type"));
  if (r.ok && boundary) { for await (const e of readMultipart(r.body as any, boundary)) if (e.type === "start") parts++; }
  else await r.body?.cancel();
  return { status: r.status, parts, authz: stack.proxy.events.slice(before).at(-1)?.authz };
}
async function launchAndSearch() {
  const t = await scriptedLaunch("josh");
  const bundle: any = await (await fetch(`${CONFIG.imagingUrl}/fhir/ImagingStudy?patient=josh-example&_include=ImagingStudy:endpoint`, { headers: { Authorization: `Bearer ${t.access_token}` } })).json();
  return { t, bundle, ...studyIn(bundle) };
}
function studyIn(bundle: any) {
  const res = bundle.entry.find((e: any) => e.resource.id === WRIST).resource;
  const uid = res.identifier[0].value.replace("urn:oid:", "");
  const base = bundle.entry.find((e: any) => e.fullUrl === res.endpoint[0].reference).resource.address;
  return { uid, url: `${base}/studies/${uid}` };
}
const refreshed = async (refreshToken: string) => {
  const r = await fetch(stack.auth.tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: "portal-app" }).toString() });
  return { status: r.status, body: await r.json() as any };
};
const search = (token: string) => fetch(`${CONFIG.imagingUrl}/fhir/ImagingStudy?patient=josh-example&_include=ImagingStudy:endpoint`, { headers: { Authorization: `Bearer ${token}` } });

for (const backend of BACKENDS) {
  describe(`rotation on ${backend}`, () => {
    beforeEach(() => stack.setBackend(backend));

    test("an old URL with a valid, authorized token loses the instant path, and still gets data", async () => {
      const { t, url } = await launchAndSearch();
      const before = await get(url, t.access_token);
      expect(before).toMatchObject({ status: 200, authz: "instant" });
      expect(before.parts).toBeGreaterThan(0);

      const oldKid = stack.imaging.signingKid;
      await admin("/signing-key/rotate");
      expect(stack.imaging.signingKid).not.toBe(oldKid);
      expect(stack.imaging.publicKeys.has(oldKid)).toBe(false);

      const decisions = stack.imaging.decisions.length;
      const after = await get(url, t.access_token);
      expect(after).toEqual({ status: 200, parts: before.parts, authz: "asked" });
      expect(stack.imaging.decisions.length).toBe(decisions + 1);
      expect(stack.imaging.decisions.at(-1).response.decision).toBe(true);
    });

    test("an old URL follows current policy, and stays bound to its own study", async () => {
      const { t, url } = await launchAndSearch();
      await admin("/signing-key/rotate");
      stack.imaging.setPolicy({ rules: [{ id: "none", when: { client: "portal-app" }, allow: { studies: [] } }] });
      expect(await get(url, t.access_token)).toEqual({ status: 404, parts: 0, authz: "asked" });
      stack.imaging.setPolicy({ rules: [] });
      const other = stack.catalog.allStudies().find(s => !url.endsWith(s.uid) && url.split("/studies/")[1] !== s.uid)!.uid;
      const base = url.split("/studies/")[0];
      expect(await get(`${base}/studies/${other}`, t.access_token)).toEqual({ status: 404, parts: 0, authz: "asked" });
    });

    test("a context no key signed is still refused", async () => {
      const { t, url } = await launchAndSearch();
      await admin("/signing-key/rotate");
      const [before, after] = url.split("/wado/");
      const [ctx, ...rest] = after!.split("/");
      const parts = ctx!.split(".");
      const forged = `${before}/wado/${parts[0]}.${parts[1]}.${"A".repeat(parts[2]!.length)}/${rest.join("/")}`;
      expect((await get(forged, t.access_token)).status).toBe(404);
    });

    test("that token still gets data by searching again, or from a plain URL", async () => {
      const { t, uid } = await launchAndSearch();
      await admin("/signing-key/rotate");
      const fresh = studyIn(await (await search(t.access_token)).json());
      const again = await get(fresh.url, t.access_token);
      expect(again).toMatchObject({ status: 200, authz: "instant" });
      expect(again.parts).toBeGreaterThan(0);
      const plain = await get(`${CONFIG.proxyUrl}/wado/-/studies/${uid}`, t.access_token);
      expect(plain).toMatchObject({ status: 200, authz: "asked" });
      expect(plain.parts).toBe(again.parts);
    });

    test("an old URL with a revoked token returns no data", async () => {
      const { t, url } = await launchAndSearch();
      await admin("/signing-key/rotate");
      await admin("/tokens/revoke-all");
      expect(await get(url, t.access_token)).toEqual({ status: 401, parts: 0, authz: "asked" });
    });

    test("a decision cached for an old URL isn't used after rotation", async () => {
      const { t, url } = await launchAndSearch();
      const next = await refreshed(t.refresh_token);
      expect(await get(url, next.body.access_token)).toMatchObject({ status: 200, authz: "asked" });
      expect(await get(url, next.body.access_token)).toMatchObject({ status: 200, authz: "cached" });
      await admin("/signing-key/rotate");
      expect(await get(url, next.body.access_token)).toMatchObject({ status: 200, authz: "asked" });
    });

    test("each control alone leaves a path open, and the three together end access at once", async () => {
      const { t, uid, url } = await launchAndSearch();
      const plain = `${CONFIG.proxyUrl}/wado/-/studies/${uid}`;
      const next = await refreshed(t.refresh_token);
      const newer = next.body.access_token;
      // Three ways to get data right now: the fast path, and two cached decisions.
      expect(await get(url, t.access_token)).toMatchObject({ status: 200, authz: "instant" });
      expect(await get(url, newer)).toMatchObject({ status: 200, authz: "asked" });
      expect(await get(plain, newer)).toMatchObject({ status: 200, authz: "asked" });
      expect(await get(url, newer)).toMatchObject({ status: 200, authz: "cached" });
      expect(await get(plain, newer)).toMatchObject({ status: 200, authz: "cached" });

      // Revoking alone: the fast path and the cache both keep serving.
      await admin("/tokens/revoke-all");
      expect(await get(url, t.access_token)).toMatchObject({ status: 200, authz: "instant" });
      expect(await get(url, newer)).toMatchObject({ status: 200, authz: "cached" });
      expect(await get(plain, newer)).toMatchObject({ status: 200, authz: "cached" });

      // Flushing as well: decisions are gone, and the fast path still serves.
      await admin("/proxy/flush");
      expect(stack.proxy.cachedDecisions).toBe(0);
      expect(await get(url, t.access_token)).toMatchObject({ status: 200, authz: "instant" });
      expect(await get(url, newer)).toEqual({ status: 401, parts: 0, authz: "asked" });
      expect(await get(plain, newer)).toEqual({ status: 401, parts: 0, authz: "asked" });

      // Rotating as well: nothing is left.
      await admin("/signing-key/rotate");
      for (const [u, token] of [[url, t.access_token], [url, newer], [plain, t.access_token], [plain, newer]] as const) {
        expect(await get(u, token)).toEqual({ status: 401, parts: 0, authz: "asked" });
      }
      expect((await search(t.access_token)).status).toBe(401);
      expect((await search(newer)).status).toBe(401);
      expect((await refreshed(next.body.refresh_token)).status).toBe(400);
    });

    test("revoke and rotate without a flush leave a plain URL's cached decision until it's flushed", async () => {
      const { t, uid } = await launchAndSearch();
      const plain = `${CONFIG.proxyUrl}/wado/-/studies/${uid}`;
      await get(plain, t.access_token);
      expect(await get(plain, t.access_token)).toMatchObject({ status: 200, authz: "cached" });
      await admin("/tokens/revoke-all");
      await admin("/signing-key/rotate");
      expect(await get(plain, t.access_token)).toMatchObject({ status: 200, authz: "cached" });
      await admin("/proxy/flush");
      expect(await get(plain, t.access_token)).toEqual({ status: 401, parts: 0, authz: "asked" });
    });
  });
}

describe("rotation", () => {
  test("flush keeps the proxy's event log, and is counted in the status", async () => {
    stack.setBackend("static-files");
    const { t, uid } = await launchAndSearch();
    await get(`${CONFIG.proxyUrl}/wado/-/studies/${uid}`, t.access_token);
    expect(stack.proxy.cachedDecisions).toBeGreaterThan(0);
    const events = stack.proxy.events.length;
    await admin("/proxy/flush");
    expect(stack.proxy.cachedDecisions).toBe(0);
    expect(stack.proxy.events.length).toBe(events);
  });
  test("the JWKS changes, and a URL signed during a flow loses the instant path the same way", async () => {
    stack.setBackend("static-files");
    const jwks = async () => (await fetch(`${CONFIG.imagingUrl}/.well-known/jwks.json`)).json() as Promise<any>;
    const before = await jwks();
    stack.resetAll();
    const { t, url } = await launchAndSearch();
    await admin("/signing-key/rotate");
    expect((await jwks()).keys[0].kid).not.toBe(before.keys[0].kid);
    expect((await jwks()).keys.length).toBe(1);
    expect(await get(url, t.access_token)).toMatchObject({ status: 200, authz: "asked" });
    expect(stack.stores.saved.info().counts.retiredSigningKeys).toBeGreaterThan(0);
    expect(stack.stores.scratch.info().counts.signingKeys).toBe(0);
  });
});

test("a proxy that isn't told keeps a rotated key until its TTL, and no longer", async () => {
  stack.setBackend("static-files");
  stack.useStore("saved");
  const { t, url } = await launchAndSearch();
  // A second proxy on the real JWKS, which the admin action knows nothing about. It only needs to
  // show which way it would decide, so its decision service is one that always allows.
  const pdp = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ decision: true, context: { release: "study", max_age_seconds: 0 } }) });
  let clock = 1_000_000;
  const untold = createProxy({ publicBase: () => CONFIG.proxyUrl, jwksUrl: `${CONFIG.imagingUrl}/.well-known/jwks.json`, jwksTtlSeconds: 60, jwksClock: () => clock, decisionUrl: `http://127.0.0.1:${pdp.port}/x`, serviceSecret: "unused", backend: () => stack.backends["static-files"] });
  const authz = async () => {
    const r = await untold.fetch(new Request(url, { headers: { Authorization: `Bearer ${t.access_token}`, Accept: ACCEPT } }));
    await r.arrayBuffer();
    expect(r.status).toBe(200);
    return untold.events.at(-1)!.authz;
  };
  try {
    expect(await authz()).toBe("instant");
    await admin("/signing-key/rotate");
    // The proxy that was told has moved on, and this one hasn't heard.
    expect(await get(url, t.access_token)).toMatchObject({ status: 200, authz: "asked" });
    clock += 59_000;
    expect(await authz()).toBe("instant");
    clock += 2000;
    expect(await authz()).toBe("asked");
  } finally { pdp.stop(true); }
});

test("the admin action reports whether the proxy was told", async () => {
  const r = await demo.fetch(new Request(`${CONFIG.demoUrl}/api/admin/signing-key/rotate`, { method: "POST", headers: { host: new URL(CONFIG.demoUrl).host } }));
  expect((await r.json() as any).rotation).toEqual({ proxyTold: true });
});

test("a rotation survives a restart: the old key stays retired, with its private half erased", async () => {
  stack.stop();
  const dir = mkdtempSync(join(tmpdir(), "rotation-test-"));
  const store = { mode: "file" as const, path: join(dir, "policy.sqlite") };
  try {
    const first = await startStack(root, { store });
    stack = first;
    const { t, url } = await launchAndSearch();
    const oldKid = first.imaging.signingKid;
    const newKid = first.imaging.rotateSigningKey();
    first.stop();

    const second = await startStack(root, { store });
    stack = second;
    expect(second.imaging.signingKid).toBe(newKid);
    expect(second.imaging.publicKeys.has(oldKid)).toBe(false);
    expect(second.stores.saved.db.query("SELECT private_key FROM signing_keys WHERE kid = ?").get(oldKid)).toEqual({ private_key: "" });
    expect((await get(url, t.access_token)).authz).toBe("asked");
    second.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
    stack = await startStack(root);
    demo = createDemoServer(stack, registerClients(stack), root);
  }
});
