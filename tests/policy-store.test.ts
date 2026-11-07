// Saved policy has to survive a restart, and a flow, in its own scope, must never disturb it. Everything here runs
// against memory stores, or a file in its own temporary directory. The store itself is tested in core.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boundaryOf, type Delegation, PolicyStore, readMultipart, type Rule } from "@smart-imaging-proxy/core";
import { startStack } from "../src/stack";
import { defaultsFor, FLOWS, registerClients, runStep, startFlow } from "../src/flows";
import { accountUrl, scriptedLaunch, submitDelegation } from "../src/flows/oauth";
import { CONFIG, DEFAULT_POLICY_DB } from "../src/config";
import { storeConfigFromEnv } from "../src/stores";
import { resetClock, now, advance } from "../src/clock";

const root = join(import.meta.dir, "..");
const dirs: string[] = [];
const tempPath = () => { const d = mkdtempSync(join(tmpdir(), "policy-store-test-")); dirs.push(d); return join(d, "nested", "policy.sqlite"); };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); resetClock(); });

const RULE: Rule = { id: "r1", description: "a rule", when: { client: "c1", patient: "josh-example" }, allow: { sites: ["Lakeside Imaging"], since: "2020-01-01" }, withholdSeries: ["1.2.3"], contextForm: "restricted" };
const DELEGATION: Delegation = { patient: "josh-example", grantedBy: "josh", delegate: "sam-caregiver", relationship: "caregiver", sites: ["Lakeside Imaging"] };
const GRANT = { client: "portal-app", user: "josh", patient: "josh-example", sites: ["Riverside Hospital"] };

describe("configuration", () => {
  test("the configuration comes from the environment, and bad values stop startup", () => {
    expect(storeConfigFromEnv({})).toEqual({ mode: "file", path: DEFAULT_POLICY_DB, durability: "normal" });
    expect(DEFAULT_POLICY_DB).toBe("/tmp/smart-imaging-demo/policy.sqlite");
    expect(storeConfigFromEnv({ POLICY_STORE: "memory", POLICY_DB: "/x", POLICY_DURABILITY: "full" })).toEqual({ mode: "memory", path: "/x", durability: "full" });
    expect(() => storeConfigFromEnv({ POLICY_STORE: "cloud" })).toThrow("POLICY_STORE");
    expect(() => storeConfigFromEnv({ POLICY_DURABILITY: "extra" })).toThrow("POLICY_DURABILITY");
    expect(() => storeConfigFromEnv({ POLICY_DURABILITY: "constructor" })).toThrow("POLICY_DURABILITY");
  });
});

describe("the root and scopes", () => {
  test("with no configuration, the root's store is in memory, and so is every scope's", async () => {
    const stack = await startStack(root);
    expect(stack.store.info().mode).toBe("memory");
    expect(stack.scopes.mint().store.info().mode).toBe("memory");
    stack.stop();
  });

  test("starting and running a flow leaves the root's store untouched", async () => {
    const path = tempPath();
    const stack = await startStack(root, { store: { mode: "file", path, durability: "normal" } });
    try {
      const clients = registerClients(stack);
      stack.store.setPolicy({ rules: [RULE], delegations: [DELEGATION], appGrants: [GRANT], contextLifetimeSeconds: 77 });
      stack.store.setSettings({ tokenLifetimeSeconds: 111 });
      const savedToken = await scriptedLaunch("josh", "portal-app");
      expect(savedToken.expires_in).toBe(111);
      const dump = () => JSON.stringify({ tables: ["delegations", "app_grants", "rules", "settings", "signing_keys", "tokens"].map(t => stack.store.db.query(`SELECT * FROM ${t} ORDER BY 1, 2`).all()) });
      const before = dump();

      const flow = FLOWS.find(f => f.id === "caregiver")!;
      const c = await startFlow(stack, clients, flow);
      expect(c.world.store).not.toBe(stack.store);
      expect(c.world.store.getPolicy().rules).toEqual([]);
      expect(c.world.store.getPolicy().delegations).toEqual([]);
      expect(c.world.store.getPolicy().contextLifetimeSeconds).toBe(300);
      expect(c.world.store.guardians()).toEqual(stack.store.guardians());
      for (const s of flow.steps) {
        const r = await runStep(c, flow, s.id, defaultsFor(c, flow, s.id));
        expect(r.checks.filter(k => !k.ok)).toEqual([]);
      }
      expect(c.world.store.getPolicy().appGrants.length).toBeGreaterThan(0);
      expect(dump()).toBe(before);

      // A second flow gets a scope of its own, which starts empty.
      const second = await startFlow(stack, clients, FLOWS.find(f => f.id === "backend-referral")!);
      expect(second.world.scope).not.toBe(c.world.scope);
      expect(second.world.store.getPolicy().appGrants).toEqual([]);
      expect(second.world.store.info().counts.accessTokens).toBe(0);
      expect(c.world.store.getPolicy().appGrants.length).toBeGreaterThan(0);
      expect(dump()).toBe(before);

      expect(stack.store.getPolicy().rules).toEqual([RULE]);
      expect(stack.store.getPolicy().contextLifetimeSeconds).toBe(77);
    } finally { stack.stop(); }
  }, 60000);

  test("a token lives in the world that issued it", async () => {
    const stack = await startStack(root);
    try {
      const a = stack.scopes.mint(), b = stack.scopes.mint();
      const atRoot = await scriptedLaunch("josh");
      const inA = await scriptedLaunch("josh", "portal-app", { at: a.urls });
      expect(stack.auth.grantOf(atRoot.access_token)!.sub).toBe("josh");
      expect(stack.auth.grantOf(inA.access_token)).toBeUndefined();
      expect(a.auth.grantOf(inA.access_token)!.sub).toBe("josh");
      expect(a.auth.grantOf(atRoot.access_token)).toBeUndefined();
      expect(b.auth.grantOf(inA.access_token)).toBeUndefined();
    } finally { stack.stop(); }
  });

  test("each world keeps its own clock", async () => {
    const stack = await startStack(root);
    try {
      const real = () => Math.floor(Date.now() / 1000);
      const a = stack.scopes.mint(), b = stack.scopes.mint();
      a.clock.advance(4000);
      expect(a.clock.now()).toBeGreaterThanOrEqual(real() + 3990);
      expect(b.clock.now()).toBeLessThan(real() + 10);
      expect(now()).toBeLessThan(real() + 10);
      advance(100);
      expect(b.clock.now()).toBeLessThan(real() + 10);
      expect(now()).toBeGreaterThanOrEqual(real() + 99);
    } finally { stack.stop(); }
  });
});

describe("a restart", () => {
  test("keeps policy, the live session, its refresh token, and signed URLs working", async () => {
    const path = tempPath();
    const config = { mode: "file" as const, path, durability: "normal" as const };
    const first = await startStack(root, { store: config });
    let token: any, base: string, uid: string, publicKeyBefore: string;
    try {
      await submitDelegation(accountUrl("josh"), { user: "josh", delegate: "sam-caregiver", relationship: "caregiver", sites: ["Lakeside Imaging"] });
      token = await scriptedLaunch("josh", "portal-app", { sites: ["Riverside Hospital"] });
      const bundle: any = await (await fetch(`${CONFIG.imagingUrl}/fhir/ImagingStudy?patient=josh-example&_include=ImagingStudy:endpoint`, { headers: { Authorization: `Bearer ${token.access_token}` } })).json();
      expect(bundle.total).toBe(4);
      const study = bundle.entry.find((e: any) => e.resource.resourceType === "ImagingStudy").resource;
      base = bundle.entry.find((e: any) => e.fullUrl === study.endpoint[0].reference).resource.address;
      uid = study.identifier[0].value.replace("urn:oid:", "");
      publicKeyBefore = JSON.stringify(first.imaging.jwks());
    } finally { first.stop(); }

    const second = await startStack(root, { store: config });
    try {
      expect(JSON.stringify(second.imaging.jwks())).toBe(publicKeyBefore);
      expect(second.store.getPolicy().delegations.map(d => d.delegate)).toEqual(["sam-caregiver"]);
      expect(second.store.getPolicy().appGrants[0]!.sites).toEqual(["Riverside Hospital"]);

      const search = await fetch(`${CONFIG.imagingUrl}/fhir/ImagingStudy?patient=josh-example`, { headers: { Authorization: `Bearer ${token.access_token}` } });
      expect(search.status).toBe(200);
      expect(((await search.json()) as any).total).toBe(4);

      const r = await fetch(`${base}/studies/${uid}`, { headers: { Authorization: `Bearer ${token.access_token}`, Accept: "multipart/related; type=application/dicom; transfer-syntax=*" } });
      expect(r.status).toBe(200);
      let complete = false;
      for await (const e of readMultipart(r.body as any, boundaryOf(r.headers.get("content-type"))!)) if (e.type === "complete") complete = true;
      expect(complete).toBe(true);
      expect(second.proxy.events[second.proxy.events.length - 1]!.authz).toBe("instant");

      const refreshed = await fetch(second.auth.tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token.refresh_token, client_id: "portal-app" }).toString() });
      expect(refreshed.status).toBe(200);
      expect(((await refreshed.json()) as any).patient).toBe("josh-example");
    } finally { second.stop(); }
  }, 60000);
});

describe("token lifecycle", () => {
  const refresh = (url: string, token: string) => fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token, client_id: "portal-app" }).toString() });

  test("refresh tokens last 30 days by default, and an expired one gets invalid_grant", async () => {
    const stack = await startStack(root);
    try {
      const t = await scriptedLaunch("josh");
      const record = stack.store.getToken(t.refresh_token, "refresh")!;
      expect(record.exp! - now()).toBeGreaterThan(30 * 86400 - 5);
      expect(record.exp! - now()).toBeLessThanOrEqual(30 * 86400);
      advance(30 * 86400 - 60);
      const r = await refresh(stack.auth.tokenUrl, t.refresh_token);
      expect(r.status).toBe(200);
      const next: any = await r.json();
      // Refreshing starts a new period.
      advance(30 * 86400 - 60);
      const again = await refresh(stack.auth.tokenUrl, next.refresh_token);
      expect(again.status).toBe(200);
      const last: any = await again.json();
      advance(30 * 86400 + 1);
      const expired = await refresh(stack.auth.tokenUrl, last.refresh_token);
      expect(expired.status).toBe(400);
      expect(await expired.json()).toEqual({ error: "invalid_grant" });
    } finally { stack.stop(); }
  });

  test("the configured lifetime applies to new refresh tokens", async () => {
    const stack = await startStack(root);
    try {
      stack.store.setSettings({ refreshTokenLifetimeSeconds: 100 });
      const t = await scriptedLaunch("josh");
      advance(101);
      expect((await refresh(stack.auth.tokenUrl, t.refresh_token)).status).toBe(400);
    } finally { stack.stop(); }
  });

  test("purging removes expired access and refresh tokens, by the store's clock, and leaves the rest", async () => {
    const stack = await startStack(root);
    try {
      stack.store.setSettings({ tokenLifetimeSeconds: 100, refreshTokenLifetimeSeconds: 200 });
      const t = await scriptedLaunch("josh");
      const active = stack.store;
      advance(50);
      expect(stack.purgeTokens()).toBe(0);
      advance(51);
      expect(stack.purgeTokens()).toBe(1);
      expect(active.getToken(t.access_token, "access")).toBeUndefined();
      expect(active.getToken(t.refresh_token, "refresh")).toBeDefined();
      advance(100);
      expect(stack.purgeTokens()).toBe(1);
      expect(active.getToken(t.refresh_token, "refresh")).toBeUndefined();
      // Moving the clock back can't bring a purged token back.
      resetClock();
      expect(stack.auth.grantOf(t.access_token)).toBeUndefined();
    } finally { stack.stop(); }
  });

  test("each world's tokens expire by its own clock", async () => {
    const stack = await startStack(root);
    try {
      const scope = stack.scopes.mint();
      const atRoot = await scriptedLaunch("josh");
      const inScope = await scriptedLaunch("josh", "portal-app", { at: scope.urls });
      advance(100000);
      stack.purgeTokens();
      expect(stack.store.getToken(atRoot.access_token, "access")).toBeUndefined();
      expect(scope.store.getToken(inScope.access_token, "access")).toBeDefined();
      scope.clock.advance(100000);
      stack.purgeTokens();
      expect(scope.store.getToken(inScope.access_token, "access")).toBeUndefined();
    } finally { stack.stop(); }
  });

  test("purging runs periodically while the stack runs", async () => {
    const stack = await startStack(root, { purgeIntervalMs: 20 });
    try {
      stack.store.setSettings({ tokenLifetimeSeconds: 100, refreshTokenLifetimeSeconds: 100 });
      const t = await scriptedLaunch("josh");
      await Bun.sleep(60);
      expect(stack.store.getToken(t.access_token, "access")).toBeDefined();
      advance(101);
      await Bun.sleep(80);
      expect(stack.store.getToken(t.access_token, "access")).toBeUndefined();
      expect(stack.store.getToken(t.refresh_token, "refresh")).toBeUndefined();
    } finally { stack.stop(); }
  });

  test("purging runs at startup", async () => {
    const path = tempPath();
    const config = { mode: "file" as const, path };
    const s = new PolicyStore(config);
    const past = Math.floor(Date.now() / 1000) - 10;
    s.putToken("old-access", "access", { client_id: "c", scope: "s" }, past);
    s.putToken("old-refresh", "refresh", { client_id: "c", scope: "s" }, past);
    s.putToken("live-refresh", "refresh", { client_id: "c", scope: "s" }, past + 10000);
    s.close();
    const stack = await startStack(root, { store: config });
    try {
      expect(stack.store.getToken("old-access", "access")).toBeUndefined();
      expect(stack.store.getToken("old-refresh", "refresh")).toBeUndefined();
      expect(stack.store.getToken("live-refresh", "refresh")).toBeDefined();
    } finally { stack.stop(); }
  });
});
