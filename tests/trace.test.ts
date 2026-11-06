// The live trace has to show a request's whole journey, correlated across services.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStack, type Stack } from "../src/stack";
import { CONFIG, PORTS } from "../src/config";
import { createDemoServer } from "../src/demo-server";
import { submitConsent } from "../src/flows/oauth";
import { defaultsFor, FLOWS, registerClients, runStep, startFlow } from "../src/flows";
import { createCollector } from "../src/trace-collector";
import { DEFAULT_TRACE_DB, traceStoreConfigFromEnv } from "../src/trace-store";
import { redactUrl, setCaptureLimitsForTest, type SpanRecord } from "../src/trace";

let stack: Stack; let clients: any;
beforeAll(async () => { stack = await startStack(join(import.meta.dir, "..")); clients = registerClients(stack); });
afterAll(() => stack.stop());

async function run(id: string) {
  const flow = FLOWS.find(f => f.id === id)!;
  const c = await startFlow(stack, clients, flow);
  for (const s of flow.steps) await runStep(c, flow, s.id, defaultsFor(c, flow, s.id));
  await Bun.sleep(150);
  return [...stack.collector.sessions.get(c.session)!.spans.values()];
}

test("the fast path appears as in-memory checks, with no decision call", async () => {
  const spans = await run("token-refresh");
  const trace = spans.find(s => s.kind === "action" && s.attrs.step === "start")!.trace;
  const inTrace = spans.filter(s => s.trace === trace);
  expect(inTrace.some(s => s.name === "fast path: token hash matches ath" && s.status === "ok")).toBe(true);
  expect(inTrace.some(s => s.name.startsWith("can_i"))).toBe(false);
});

test("a decision call is correlated across proxy, policy, and Authorization Server", async () => {
  const spans = await run("token-refresh");
  const trace = spans.find(s => s.kind === "action" && s.attrs.step === "refresh")!.trace;
  const inTrace = spans.filter(s => s.trace === trace);
  const services = new Set(inTrace.map(s => s.service));
  for (const svc of ["user", "app", "dicomweb-proxy", "policy", "authorization-server", "backend"]) expect(services.has(svc as any)).toBe(true);
  expect(inTrace.some(s => s.name === "fast path: token hash matches ath" && s.status === "denied")).toBe(true);
  const call = inTrace.find(s => s.name.startsWith("can_i"))!;
  const server = inTrace.find(s => s.parent === call.span)!;
  expect(server.service).toBe("policy");
  expect(inTrace.some(s => s.name.startsWith("policy evaluation:") && s.attrs.why)).toBe(true);
  expect(inTrace.some(s => s.name.startsWith("decision:"))).toBe(true);
});

test("every span has a parent in its trace, except the root", async () => {
  const spans = await run("backend-referral");
  const ids = new Set(spans.map(s => s.span));
  const orphans = spans.filter(s => s.parent && !ids.has(s.parent));
  expect(orphans.map(s => s.name)).toEqual([]);
  expect(spans.every(s => s.end !== undefined)).toBe(true);
});

test("no token or client assertion is ever recorded", async () => {
  const spans = await run("backend-referral");
  const text = JSON.stringify(spans);
  // The field names appear in captured exchanges. Their values appear only as hashes.
  expect(text).not.toMatch(/\\"access_token\\":\\"(?!sha256:)/);
  expect(text).toContain("client_assertion=");
  expect(text).not.toMatch(/client_assertion=[^.&"]+\.[^.&"]+\.(?!%28signature%29)/);
});

test("exchanges are captured in full, and hold no secrets", async () => {
  const flow = FLOWS.find(f => f.id === "patient-sites")!;
  const c = await startFlow(stack, clients, flow);
  await runStep(c, flow, "consent", defaultsFor(c, flow, "consent"));
  const token = c.state.token as string;
  await runStep(c, flow, "search", defaultsFor(c, flow, "search"));
  await Bun.sleep(200);
  const session = stack.collector.sessions.get(c.session)!;
  const spans = [...session.spans.values()];
  const tokenCall = spans.find(s => s.kind === "server" && s.http?.url.endsWith("/token"))!;
  expect(tokenCall.http!.request.body).toContain("grant_type=authorization_code");
  expect(tokenCall.http!.request.body).toContain("code_verifier=sha256");
  expect(tokenCall.http!.response!.body).toContain('"access_token":"sha256:');
  const search = spans.find(s => s.kind === "server" && s.http?.url.includes("/ImagingStudy"))!;
  expect(search.http!.response!.body).toContain("Bundle");
  expect(search.http!.request.headers.authorization).toStartWith("Bearer sha256:");
  const signIn = spans.find(s => s.http?.url.includes("/authorize/signin"))!;
  expect(signIn.http!.request.body).toBe("username=josh");
  expect(spans.some(s => s.name === "demo sign-in: account selected, no credential checked" && s.status === "ok")).toBe(true);
  const all = JSON.stringify(spans);
  expect(all).not.toContain(token);
  expect(all).not.toMatch(/code_verifier=(?!sha256)/);
  expect(all).not.toMatch(/[?&]code=(?!sha256)[A-Za-z0-9_-]{20}/);
});

test("the stream carries summaries, and the full exchange loads on demand", async () => {
  const flow = FLOWS.find(f => f.id === "patient-sites")!;
  const c = await startFlow(stack, clients, flow);
  await runStep(c, flow, "consent", defaultsFor(c, flow, "consent"));
  await Bun.sleep(200);
  const base = CONFIG.traceUrl;
  const list: any[] = await (await fetch(`${base}/api/sessions/${c.session}/spans`)).json();
  const one = list.find(s => s.http?.url.endsWith("/token") && s.kind === "server");
  expect(one.http.request).toBeUndefined();
  expect(one.http.status).toBe(200);
  const full: any = await (await fetch(`${base}/api/sessions/${c.session}/spans/${one.span}`)).json();
  expect(full.http.response.body).toContain("access_token");
  const log: any[] = await (await fetch(`${base}/api/sessions/${c.session}/http?trace=${one.trace}`)).json();
  expect(log.some(s => s.span === one.span)).toBe(true);
  for (const page of ["/span.html", "/log.html", "/trace-view.js", "/span.js", "/log.js"]) expect((await fetch(base + page)).status).toBe(200);
});

test("a window's redirect back to the app joins the flow waiting on it, with nothing added to the redirect", async () => {
  const demo = createDemoServer(stack, clients, join(import.meta.dir, ".."));
  const server = Bun.serve({ port: PORTS.demo, hostname: "127.0.0.1", fetch: demo.fetch, idleTimeout: 60 });
  try {
    const post = (path: string, body: unknown = {}) => fetch(`${CONFIG.demoUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const started: any = await (await post("/api/flows/patient-sites/start")).json();
    const stepping = post("/api/flows/patient-sites/steps/consent", { inputs: { mode: "window", sites: [] } });
    let url: string | null = null;
    while (!url) { url = ((await (await fetch(`${CONFIG.demoUrl}/api/pending-authorization`)).json()) as any).url; await Bun.sleep(5); }
    const back = await submitConsent(url, { user: "josh" });
    expect([...back.searchParams.keys()].sort()).toEqual(["code", "state"]);
    const before = stack.collector.sessions.get("unattributed")?.spans.size ?? 0;
    expect((await fetch(back)).status).toBe(200);
    expect((await stepping).status).toBe(200);
    await Bun.sleep(200);
    const spans = [...stack.collector.sessions.get(started.session)!.spans.values()];
    const callback = spans.find(s => s.name === "Redirect back to the app: /oauth/callback")!;
    expect(callback).toBeDefined();
    const step = spans.find(s => s.kind === "action" && s.attrs.step === "consent")!;
    expect(callback.trace).toBe(step.trace);
    expect(callback.parent).toBe(step.span);
    const stray = [...(stack.collector.sessions.get("unattributed")?.spans.values() ?? [])].filter(s => s.name.startsWith("Redirect back"));
    expect(stray).toEqual([]);
    expect(stack.collector.sessions.get("unattributed")?.spans.size ?? 0).toBe(before);
  } finally { server.stop(true); }
});

test("everything a flow does appears in its session", async () => {
  await Bun.sleep(200);
  for (const flow of FLOWS) {
    const before = stack.collector.sessions.get("unattributed")?.spans.size ?? 0;
    const c = await startFlow(stack, clients, flow);
    for (const s of flow.steps) await runStep(c, flow, s.id, defaultsFor(c, flow, s.id));
    await Bun.sleep(150);
    const all = [...(stack.collector.sessions.get("unattributed")?.spans.values() ?? [])];
    expect(all.slice(before).map(s => `${flow.id}: ${s.name}`)).toEqual([]);
  }
}, 120000);

// Everything the stack really sends, so a scan can look for the values themselves rather than for patterns.
function recordRawSecrets() {
  const raw = new Set<string>();
  const add = (v?: string | null) => { if (v && v.length >= 8 && !v.startsWith("sha256:")) raw.add(v); };
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = String(input?.url ?? input);
    const headers = new Headers(init.headers ?? {});
    add(headers.get("authorization")?.split(" ").slice(1).join(" "));
    add(headers.get("cookie")?.split("=").slice(1).join("="));
    const body = typeof init.body === "string" ? init.body : init.body instanceof URLSearchParams ? init.body.toString() : "";
    if ((headers.get("content-type") ?? "").includes("form")) {
      const f = new URLSearchParams(body);
      for (const k of ["code", "code_verifier", "refresh_token", "token"]) add(f.get(k));
      add(f.get("client_assertion")?.split(".")[2]);
    }
    add(new URL(url).searchParams.get("code"));
    const res = await real(input, init);
    const location = res.headers.get("location");
    if (location) add(new URL(location, url).searchParams.get("code"));
    for (const c of res.headers.getSetCookie()) add(c.split(";")[0]!.split("=").slice(1).join("="));
    if (url.endsWith("/token") && res.ok) { const j: any = await res.clone().json().catch(() => ({})); add(j.access_token); add(j.refresh_token); }
    return res;
  }) as any;
  return { raw, restore() { globalThis.fetch = real; } };
}
const exported = async (session: string) => (await fetch(`${CONFIG.traceUrl}/api/sessions/${encodeURIComponent(session)}/export`)).text();

test("no raw secret reaches a span, including a code that only ever travels in a browser redirect", async () => {
  const rec = recordRawSecrets();
  const demo = createDemoServer(stack, clients, join(import.meta.dir, ".."));
  const server = Bun.serve({ port: PORTS.demo, hostname: "127.0.0.1", fetch: demo.fetch, idleTimeout: 60 });
  try {
    const post = (path: string, body: unknown = {}) => fetch(`${CONFIG.demoUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const started: any = await (await post("/api/flows/patient-sites/start")).json();
    const stepping = post("/api/flows/patient-sites/steps/consent", { inputs: { mode: "window", sites: [] } });
    let url: string | null = null;
    while (!url) { url = ((await (await fetch(`${CONFIG.demoUrl}/api/pending-authorization`)).json()) as any).url; await Bun.sleep(5); }
    const back = await submitConsent(url, { user: "josh" });
    const code = back.searchParams.get("code")!, state = back.searchParams.get("state")!;
    expect(code.length).toBeGreaterThan(20);
    expect((await fetch(back)).status).toBe(200);
    expect((await stepping).status).toBe(200);
    await post(`/api/flows/patient-sites/steps/search`, { inputs: {} });
    await Bun.sleep(250);
    const text = await exported(started.session);
    const callback = stack.collector.sessions.get(started.session)!.spans;
    const hop = [...callback.values()].find(s => s.name === "Redirect back to the app: /oauth/callback")!;
    expect(hop.http!.url).toContain("code=sha256");
    expect(text).not.toContain(code);
    expect(text).not.toContain(encodeURIComponent(code));
    // state protects the redirect from forgery, and isn't a credential: it stays readable so it can be compared.
    expect(text).toContain(state);

    // A decision call, a backend client's assertion, and a related person's cookie.
    const sessions = [started.session as string];
    for (const id of ["token-refresh", "backend-referral", "caregiver"]) sessions.push((await run(id))[0]!.session);
    await Bun.sleep(250);
    const all = (await Promise.all(sessions.map(exported))).join("\n");
    expect(rec.raw.size).toBeGreaterThan(10);
    const leaked = [...rec.raw].filter(v => all.includes(v) || all.includes(encodeURIComponent(v)));
    expect(leaked.map(v => `${v.slice(0, 6)}… (${v.length})`)).toEqual([]);
    // The same values do appear as hashes, so the scan was looking in the right place.
    expect(all).toMatch(/Bearer sha256:/);

    const can = stack.collector.sessions.get(sessions[1]!)!;
    const evaluation = [...can.spans.values()].find(s => s.kind === "client" && s.name.startsWith("can_i"))!;
    const body = JSON.parse(evaluation.http!.request.body!);
    expect(body.subject.properties.access_token).toStartWith("sha256:");
    expect(all).not.toMatch(/"access_token\\*":\s*\\*"(?!sha256:)/);
    expect(all).not.toMatch(/"refresh_token\\*":\s*\\*"(?!sha256:)/);
    expect(all).not.toMatch(/code_verifier=(?!sha256)/);
    expect(all).not.toMatch(/[?&]code=(?!sha256)[A-Za-z0-9_-]{20}/);
    expect(all).not.toMatch(/client_assertion=[^.&"]+\.[^.&"]+\.(?!%28signature%29)/);
    expect(all).not.toMatch(/"(set-)?cookie\\*":\s*\\*"(?!\(session cookie)/);
  } finally { rec.restore(); server.stop(true); }
}, 60000);

test("a relative redirect is redacted like an absolute one", () => {
  expect(redactUrl("/cb?code=abcdefghijklmnop&state=x")).toStartWith("/cb?code=sha256");
  expect(redactUrl("/cb?code=abcdefghijklmnop&state=x")).not.toContain("abcdefghijklmnop");
  expect(redactUrl("https://a.example/cb?code=abcdefghijklmnop")).toStartWith("https://a.example/cb?code=sha256");
});

test("a body over the capture limit is cut, flagged, and still redacted", async () => {
  setCaptureLimitsForTest(4096);
  try {
    const flow = FLOWS.find(f => f.id === "patient-sites")!;
    const c = await startFlow(stack, clients, flow);
    await runStep(c, flow, "consent", defaultsFor(c, flow, "consent"));
    await runStep(c, flow, "search", defaultsFor(c, flow, "search"));
    await Bun.sleep(200);
    const search = [...stack.collector.sessions.get(c.session)!.spans.values()].find(s => s.kind === "server" && s.http?.url.includes("/ImagingStudy"))!;
    expect(search.http!.response!.truncated).toBe(true);
    expect(search.http!.response!.body!.length).toBeLessThanOrEqual(4096);
    expect(search.http!.response!.bytes!).toBeGreaterThan(4096);
  } finally { setCaptureLimitsForTest(); }
});

// Storage. These use a temp directory, and call the collector directly.
const ROOT = join(import.meta.dir, "..");
const dirs: string[] = [];
const tempDb = () => { const d = mkdtempSync(join(tmpdir(), "trace-store-")); dirs.push(d); return join(d, "nested", "traces.sqlite"); };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const T = "http://trace.test";
const span = (session: string, id: string, extra: Partial<SpanRecord> = {}): SpanRecord => ({ session, trace: "a".repeat(32), span: id, service: "app", kind: "internal", name: id, start: 1000, end: 1001, status: "ok", attrs: {}, ...extra });
const withHttp = (session: string, id: string, body = "the body", extra: Partial<SpanRecord> = {}) => span(session, id, {
  kind: "client", name: `call ${id}`,
  http: { method: "POST", url: "http://x.test/y", status: 200, request: { headers: { accept: "*/*" }, body: "asked", encoding: "text", bytes: 5 }, response: { headers: { "content-type": "text/plain" }, body, encoding: "text", bytes: body.length } },
  ...extra,
});
const send = (c: { fetch: (r: Request) => Promise<Response> }, records: SpanRecord[]) => c.fetch(new Request(`${T}/v1/spans`, { method: "POST", body: JSON.stringify(records) }));
const getJson = async (c: { fetch: (r: Request) => Promise<Response> }, path: string): Promise<any> => (await c.fetch(new Request(T + path))).json();

test("traces survive closing and reopening, a later emit updates a span, and lists carry no bodies", async () => {
  const path = tempDb();
  let c = createCollector(ROOT, { mode: "file", path });
  await send(c, [withHttp("s1", "one", "first", { end: undefined, status: undefined })]);
  await send(c, [withHttp("s1", "one", "final body", { end: 1500 })]);
  await send(c, [span("s1", "two"), withHttp("s2", "other", "elsewhere", { trace: "b".repeat(32), start: 2000, end: 2001 })]);
  const before = await getJson(c, "/api/sessions/s1/spans");
  expect(before.map((s: any) => s.span).sort()).toEqual(["one", "two"]);
  const listed = before.find((s: any) => s.span === "one");
  expect(listed.end).toBe(1500);
  expect(listed.http.request).toBeUndefined();
  expect(listed.http.response).toBeUndefined();
  expect(listed.http.bytes).toBe(10);
  expect((await getJson(c, "/api/sessions/s1/spans/one")).http.response.body).toBe("final body");
  const sessions = await getJson(c, "/api/sessions");
  expect(sessions.map((s: any) => s.id)).toEqual(["s2", "s1"]);
  expect(sessions.find((s: any) => s.id === "s1").spans).toBe(2);
  const seqBefore = listed.seq;
  for (const f of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(f)) expect(statSync(f).mode & 0o777).toBe(0o600);
  c.close();

  c = createCollector(ROOT, { mode: "file", path });
  expect(c.store.stats().mode).toBe("file");
  expect((await getJson(c, "/api/sessions")).map((s: any) => s.id)).toEqual(["s2", "s1"]);
  expect((await getJson(c, "/api/sessions/s1/spans/one")).http.response.body).toBe("final body");
  const log = await getJson(c, `/api/sessions/s1/http?trace=${"a".repeat(32)}`);
  expect(log.map((s: any) => s.span)).toEqual(["one"]);
  expect(log[0].http.request.body).toBe("asked");
  await send(c, [span("s1", "three", { start: 1100, end: 1101 })]);
  const later = (await getJson(c, "/api/sessions/s1/spans")).find((s: any) => s.span === "three");
  expect(later.seq).toBeGreaterThan(seqBefore);
  c.close();
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

test("a span the last run never finished stops reading as running after a restart", async () => {
  const path = tempDb();
  let c = createCollector(ROOT, { mode: "file", path });
  await send(c, [span("s", "cut", { end: undefined, status: undefined }), span("s", "done")]);
  c.close();
  c = createCollector(ROOT, { mode: "file", path });
  const cut = await getJson(c, "/api/sessions/s/spans/cut");
  expect(cut.end).toBeDefined();
  expect(cut.status).toBe("error");
  expect(cut.attrs.error).toContain("stopped before");
  expect((await getJson(c, "/api/sessions/s/spans/done")).status).toBe("ok");
  c.close();
});

test("the live stream carries sessions and spans without bodies, whatever the store does", async () => {
  const c = createCollector(ROOT);
  const res = await c.fetch(new Request(`${T}/stream`));
  const reader = res.body!.getReader();
  const next = async () => new TextDecoder().decode((await reader.read()).value);
  expect(await next()).toContain("event: hello");
  await send(c, [withHttp("live", "a", "a secret-looking body")]);
  let text = "";
  while (!text.includes("event: span")) text += await next();
  expect(text).toContain("event: session");
  expect(text).not.toContain("secret-looking");
  // A broken database doesn't reach the sender, and the stream keeps going.
  c.store.flush();
  (c.store as any).db.exec("DROP TABLE bodies");
  expect((await send(c, [withHttp("live", "b", "another")])).status).toBe(202);
  text = "";
  while (!text.includes('"span":"b"')) text += await next();
  const stats = c.store.stats();
  expect(stats.failures).toBeGreaterThan(0);
  expect(stats.lastError).toContain("bodies");
  expect(stats.pending).toBe(1);
  await reader.cancel();
  c.close();
});

test("an unusable path falls back to memory, and tracing carries on", async () => {
  const warn = console.warn; console.warn = () => {};
  try {
    const c = createCollector(ROOT, { mode: "file", path: "/proc/nope/traces.sqlite" });
    expect((await send(c, [span("s", "a")])).status).toBe(202);
    const stats = await getJson(c, "/api/stats");
    expect(stats.mode).toBe("memory");
    expect(stats.spans).toBe(1);
    c.close();
  } finally { console.warn = warn; }
});

test("retention keeps to the session, per-session, and size limits, dropping the oldest", async () => {
  const c = createCollector(ROOT, { mode: "memory", maxSessions: 2, maxSpansPerSession: 2 });
  const res = await c.fetch(new Request(`${T}/stream`));
  const reader = res.body!.getReader();
  await send(c, [span("old", "a", { start: 1, end: 2 })]);
  await send(c, [span("mid", "a", { start: 3, end: 4 })]);
  await send(c, [span("new", "a", { start: 5, end: 6 }), span("new", "b", { start: 5, end: 6 }), span("new", "c", { start: 5, end: 6 })]);
  expect((await getJson(c, "/api/sessions")).map((s: any) => s.id)).toEqual(["new", "mid"]);
  expect((await getJson(c, "/api/sessions/new/spans")).length).toBe(2);
  // Past the limit, a new span is dropped, but one already stored still updates.
  await send(c, [span("new", "a", { start: 5, end: 9, name: "updated" })]);
  expect((await getJson(c, "/api/sessions/new/spans/a")).name).toBe("updated");
  expect((await getJson(c, "/api/stats")).droppedOverLimit).toBe(1);
  expect(await (await c.fetch(new Request(`${T}/api/sessions/old/spans/a`))).status).toBe(404);
  let text = ""; while (!text.includes("event: removed")) text += new TextDecoder().decode((await reader.read()).value);
  expect(text).toContain('["old"]');
  await reader.cancel(); c.close();

  const small = createCollector(ROOT, { mode: "memory", maxBytes: 3000 });
  await send(small, [withHttp("big-old", "a", "x".repeat(2500), { start: 1, end: 2 })]);
  await send(small, [withHttp("big-new", "a", "y".repeat(2500), { start: 5, end: 6 })]);
  const left = await getJson(small, "/api/sessions");
  expect(left.map((s: any) => s.id)).toEqual(["big-new"]);
  const st = await getJson(small, "/api/stats");
  expect(st.sessions).toBe(1);
  // The newest session stays even when it alone is over the limit.
  await send(small, [withHttp("big-new", "b", "z".repeat(5000), { start: 7, end: 8 })]);
  expect((await getJson(small, "/api/sessions")).map((s: any) => s.id)).toEqual(["big-new"]);
  small.close();
});

test("stats, export, and clear work, and a cross-site page can't clear", async () => {
  const path = tempDb();
  const c = createCollector(ROOT, { mode: "file", path });
  await send(c, [withHttp("flow 1/x", "a", "full body here")]);
  const stats = await getJson(c, "/api/stats");
  expect(stats).toMatchObject({ mode: "file", path, sessions: 1, spans: 1, limits: { sessions: 100, spansPerSession: 20000 } });
  expect(stats.bytes).toBeGreaterThan(0);
  expect(stats.fileBytes).toBeGreaterThan(0);
  const res = await c.fetch(new Request(`${T}/api/sessions/${encodeURIComponent("flow 1/x")}/export`));
  expect(res.headers.get("content-disposition")).toBe('attachment; filename="trace-flow_1_x.json"');
  const dump: any = await res.json();
  expect(dump.session.id).toBe("flow 1/x");
  expect(dump.spans[0].http.response.body).toBe("full body here");
  expect((await c.fetch(new Request(`${T}/api/sessions/none/export`))).status).toBe(404);
  const clear = (origin?: string) => c.fetch(new Request(`${T}/api/sessions`, { method: "DELETE", headers: origin ? { origin } : {} }));
  expect((await clear("http://evil.example")).status).toBe(403);
  expect((await getJson(c, "/api/stats")).sessions).toBe(1);
  expect((await clear(T)).status).toBe(204);
  expect(await getJson(c, "/api/sessions")).toEqual([]);
  expect((await getJson(c, "/api/stats")).spans).toBe(0);
  await send(c, [span("after", "a")]);
  expect((await getJson(c, "/api/sessions")).map((s: any) => s.id)).toEqual(["after"]);
  c.close();
});

test("settings come from the environment, and a test stack never touches the trace file", () => {
  expect(traceStoreConfigFromEnv({})).toEqual({ mode: "file", path: DEFAULT_TRACE_DB });
  expect(traceStoreConfigFromEnv({ TRACE_STORE: "memory" }).mode).toBe("memory");
  expect(traceStoreConfigFromEnv({ TRACE_DB: "/x/y.sqlite", TRACE_MAX_BYTES: "1000" })).toEqual({ mode: "file", path: "/x/y.sqlite", maxBytes: 1000 });
  expect(() => traceStoreConfigFromEnv({ TRACE_STORE: "disk" })).toThrow("TRACE_STORE");
  expect(() => traceStoreConfigFromEnv({ TRACE_MAX_BYTES: "lots" })).toThrow("TRACE_MAX_BYTES");
  expect(stack.collector.store.mode).toBe("memory");
  expect(stack.collector.store.path).toBeUndefined();
});
