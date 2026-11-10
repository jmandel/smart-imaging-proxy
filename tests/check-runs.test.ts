// Server checks an agent starts: made by API, read by anyone holding the id, reported to only by a page on this
// origin, gone after a day, capped in number, and never giving out the private key sent with one.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createCheckRuns, MAX_ASSERTIONS, MAX_RUNS, RUN_LIFETIME_MS } from "../src/check-runs";
import { createDemoServer } from "../src/demo-server";
import { registerClients } from "../src/flows";
import { publicRootGate } from "../src/gateway";
import { CONFIG } from "../src/config";
import { startStack, type Stack } from "../src/stack";

const SITE = "http://127.0.0.1:7000", ORIGIN = "https://imaging.example";
const server = { label: "Acme", iss: "https://fhir.acme.example/r4", clientId: "acme-check" };
function runs() {
  let t = Date.parse("2026-11-10T12:00:00Z");
  const r = createCheckRuns({ now: () => t });
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const req = new Request(`${SITE}${path}`, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
    const res = await r.fetch(req, new URL(req.url), ORIGIN);
    return { status: res.status, body: await res.json().catch(() => undefined) as any };
  };
  return { call, r, later: (ms: number) => { t += ms; } };
}
async function privateKey() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return { jwk: { ...await crypto.subtle.exportKey("jwk", pair.privateKey), kid: "k1" }, pub: pair.publicKey };
}
const report = (status = "running", steps: unknown[] = [{ n: 1, title: "Discovery is readable from this page", state: "pass", result: "Read from fhir.acme.example", requests: [{ request: "GET …", response: "HTTP 200" }] }]) => ({ status, summary: "Running step 2 of 12…", steps });

describe("check runs", () => {
  test("a run is made with a long random id and a link, and read back as waiting", async () => {
    const { call } = runs();
    const made = await call("POST", "/api/checks", { server });
    expect(made.status).toBe(201);
    expect(made.body.id).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(made.body.url).toBe(`${ORIGIN}/check?run=${made.body.id}`);
    expect(made.body.status).toBe("waiting");
    expect(made.body.expiresAt).toBe("2026-11-11T12:00:00.000Z");
    const read = await call("GET", `/api/checks/${made.body.id}`);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ id: made.body.id, server, status: "waiting", summary: null, steps: [] });
    const other = await call("POST", "/api/checks", { server });
    expect(other.body.id).not.toBe(made.body.id);
    expect((await call("GET", "/api/checks/not-a-run")).status).toBe(404);
  });

  test("the server is checked as Your servers checks one", async () => {
    const { call } = runs();
    const refused = async (body: unknown) => { const r = await call("POST", "/api/checks", body); expect(r.status).toBe(400); return r.body.error as string; };
    expect(await refused({ server: { ...server, label: "" } })).toBe('The server needs a name ("label").');
    expect(await refused({ server: { ...server, iss: "http://fhir.acme.example/r4" } })).toBe('The server: "iss" must use https.');
    expect(await refused({ server: { ...server, mode: "backend" } })).toContain('needs a "jwk"');
    expect(await refused({ server: { ...server, auth: "private_key_jwt", jwk: { kty: "EC" } } })).toContain('needs a "jwk"');
    expect(await refused({ server, extra: 1 })).toBe("this request accepts only server");
    expect(await refused("not json")).toBe("the request body must be a JSON object");
    expect(await refused([server])).toBe("the request body must be a JSON object");
    // Only the fields an entry has are kept.
    const made = await call("POST", "/api/checks", { server: { ...server, iss: `${server.iss}/`, sandbox: "/s/x", color: "red" } });
    expect((await call("GET", `/api/checks/${made.body.id}`)).body.server).toEqual(server);
  });

  test("only a page on this origin reports, with steps of the right shape, and the agent reads them", async () => {
    const { call } = runs();
    const { id } = (await call("POST", "/api/checks", { server })).body;
    expect((await call("PUT", `/api/checks/${id}/report`, report(), { origin: "https://evil.example" })).status).toBe(403);
    expect((await call("GET", `/api/checks/${id}`)).body.status).toBe("waiting");
    expect((await call("PUT", `/api/checks/${id}/report`, report(), { origin: SITE })).status).toBe(200);
    const read = (await call("GET", `/api/checks/${id}`)).body;
    expect(read.status).toBe("running");
    expect(read.summary).toBe("Running step 2 of 12…");
    expect(read.steps).toEqual(report().steps);
    for (const [bad, error] of [
      [{ ...report(), status: "waiting" }, "status is one of running, paused, done"],
      [{ ...report(), summary: 3 }, "summary is the line saying how far the check got"],
      [report("done", [{ n: 1, title: "x", state: "great", result: "y" }]), "each step has n, title, state and result"],
      [report("done", Array(41).fill({ n: 1, title: "x", state: "pass", result: "y" })), "steps is a list of at most 40"],
      [{ ...report(), token: "x" }, "this request accepts only status, summary, steps"],
    ] as const) {
      const r = await call("PUT", `/api/checks/${id}/report`, bad, { origin: SITE });
      expect([r.status, r.body.error]).toEqual([400, error]);
    }
    expect((await call("PUT", `/api/checks/${id}/report`, "x".repeat(600 * 1024), { origin: SITE })).status).toBe(413);
    expect((await call("PUT", "/api/checks/nope/report", report(), { origin: SITE })).status).toBe(404);
    // Refused under another host name, as every service here is.
    expect((await call("GET", `/api/checks/${id}`, undefined, { host: "evil.example" })).status).toBe(403);
  });

  test("a run lasts a day", async () => {
    const { call, later } = runs();
    const { id } = (await call("POST", "/api/checks", { server })).body;
    later(RUN_LIFETIME_MS - 1000);
    expect((await call("GET", `/api/checks/${id}`)).status).toBe(200);
    later(1000);
    expect((await call("GET", `/api/checks/${id}`)).status).toBe(404);
    expect((await call("PUT", `/api/checks/${id}/report`, report(), { origin: SITE })).status).toBe(404);
  });

  test("only so many runs are open at once, and expired ones make room", async () => {
    const { call, r, later } = runs();
    for (let i = 0; i < MAX_RUNS; i++) expect((await call("POST", "/api/checks", { server })).status).toBe(201);
    expect(r.size()).toBe(MAX_RUNS);
    const full = await call("POST", "/api/checks", { server });
    expect([full.status, full.body.error]).toEqual([429, "too many check runs are open: try again later"]);
    later(RUN_LIFETIME_MS);
    expect((await call("POST", "/api/checks", { server })).status).toBe(201);
    expect(r.size()).toBe(1);
  });

  test("a private key sent with a run is never read back, and signs assertions only for its run", async () => {
    const { call } = runs();
    const { jwk, pub } = await privateKey();
    const { id } = (await call("POST", "/api/checks", { server: { ...server, auth: "private_key_jwt", jwk } })).body;
    const read = await call("GET", `/api/checks/${id}`);
    expect(read.body.server).toEqual({ ...server, auth: "private_key_jwt", hasKey: true, kid: "k1" });
    expect(JSON.stringify(read.body)).not.toContain(jwk.d!);
    // The page asks for an assertion, and gets one this key signed, for that audience, and no key.
    const aud = "https://auth.acme.example/token";
    const signed = await call("POST", `/api/checks/${id}/assertion`, { aud }, { origin: SITE });
    expect(signed.status).toBe(200);
    expect(JSON.stringify(signed.body)).not.toContain(jwk.d!);
    const [head, body, sig] = (signed.body.assertion as string).split(".");
    const claims = JSON.parse(Buffer.from(body!, "base64url").toString());
    expect(JSON.parse(Buffer.from(head!, "base64url").toString())).toEqual({ alg: "ES256", kid: "k1", typ: "JWT" });
    expect(claims).toMatchObject({ iss: "acme-check", sub: "acme-check", aud });
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, Buffer.from(sig!, "base64url"), new TextEncoder().encode(`${head}.${body}`))).toBe(true);
    expect((await call("POST", `/api/checks/${id}/assertion`, { aud }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await call("POST", `/api/checks/${id}/assertion`, { aud: "http://auth.acme.example/token" }, { origin: SITE })).status).toBe(400);
    for (let i = 1; i < MAX_ASSERTIONS; i++) await call("POST", `/api/checks/${id}/assertion`, { aud }, { origin: SITE });
    expect((await call("POST", `/api/checks/${id}/assertion`, { aud }, { origin: SITE })).status).toBe(429);
    // A run with no key signs nothing.
    const plain = (await call("POST", "/api/checks", { server })).body.id;
    expect((await call("POST", `/api/checks/${plain}/assertion`, { aud }, { origin: SITE })).status).toBe(409);
    // A report can't carry the key back out either: only the step fields are kept.
    await call("PUT", `/api/checks/${id}/report`, report("done", [{ n: 1, title: "x", state: "pass", result: "y", jwk, requests: [] }]), { origin: SITE });
    expect(JSON.stringify((await call("GET", `/api/checks/${id}`)).body)).not.toContain(jwk.d!);
  });
});

describe("check runs on the site", () => {
  let stack: Stack, demo: ReturnType<typeof createDemoServer>;
  beforeAll(async () => { const root = join(import.meta.dir, ".."); stack = await startStack(root); demo = createDemoServer(stack, registerClients(stack), root); });
  afterAll(() => stack.stop());
  const at = (path: string, init?: RequestInit) => demo.fetch(new Request(`${CONFIG.demoUrl}${path}`, init));

  test("are at the site's root only, with links to the site's public address", async () => {
    const made = await at("/api/checks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ server }) });
    expect(made.status).toBe(201);
    const { id, url } = await made.json() as any;
    expect(url).toBe(`${new URL(CONFIG.demoUrl).origin}/check?run=${id}`);
    expect((await at(`/api/checks/${id}`)).status).toBe(200);
    const w = stack.sandboxes.mint();
    expect((await at(`${w.prefix}/api/checks/${id}`)).status).toBe(404);
    expect((await at(`${w.prefix}/api/checks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ server }) })).status).toBe(404);
  });

  test("the Conformance page's old address opens the server check on its sandbox", async () => {
    const w = stack.sandboxes.mint();
    const r = await at(`${w.prefix}/checks`, { redirect: "manual" });
    expect([r.status, r.headers.get("location")]).toEqual([308, `/check?sandbox=${encodeURIComponent(w.prefix)}`]);
  });

  test("a public deployment's read-only root still takes a run and its reports", () => {
    expect(publicRootGate("POST", "/api/checks")).toBeUndefined();
    expect(publicRootGate("PUT", "/api/checks/abc/report")).toBeUndefined();
    expect(publicRootGate("POST", "/api/checks/abc/assertion")).toBeUndefined();
    expect(publicRootGate("DELETE", "/api/checks/abc")?.status).toBe(403);
    expect(publicRootGate("PUT", "/api/checks/abc/other")?.status).toBe(403);
  });
});
