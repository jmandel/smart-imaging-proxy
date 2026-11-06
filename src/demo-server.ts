// The demo's own web server: the flow player and admin screen, backed by the real services.
import { join } from "node:path";
import { traced } from "./trace";
import type { BackendName, Stack } from "./stack";
import { FLOWS, flowById, runStep, startFlow } from "./flows";
import type { Ctx } from "./flows/runtime";
import { CONFIG } from "./config";
import { adminApi, readJson, refuseWrite, BACKEND_NAMES } from "./admin-api";
import { PolicyValidationError } from "./policy-store";
import type { BackendClient } from "./auth-server";

const SERVICES = { proxy: CONFIG.proxyUrl, imaging: CONFIG.imagingUrl, authorization: CONFIG.authUrl, "live trace": CONFIG.traceUrl };
const json = (b: unknown, status = 200) => Response.json(b, { status });

export function createDemoServer(stack: Stack, clients: Record<string, BackendClient>, root: string) {
  // What a reload needs to show this flow again, and what stops another tab from disturbing it.
  let session: { flowId: string; ctx: Ctx; completed: Record<string, { inputs: unknown; result: unknown }>; running?: string } | undefined;

  // The redirect URI the demo app registered. Flows check `state` when they receive it. The redirect
  // is a real protocol message with no trace fields, so its span joins the flow waiting on it.
  const callback = traced("app", async req => {
    session?.ctx.resolveCallback?.(new URL(req.url));
    return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Back in the app</title></head><body style="font:15px system-ui;padding:2rem"><p>Back in the app. You can close this window.</p><script>window.close()</script></body></html>`, { headers: { "content-type": "text/html" } });
  }, (_req, url) => `Redirect back to the app: ${url.pathname}`, () => session?.ctx.callbackContext ?? (session ? { session: session.ctx.session } : undefined));

  async function ensureSession(flowId: string, restart: boolean) {
    const flow = flowById(flowId);
    if (!flow) return undefined;
    if (restart || session?.flowId !== flowId) session = { flowId, ctx: await startFlow(stack, clients, flow), completed: {} };
    // A flow's tokens and policy are in the scratch store, wherever the rest of the demo has gone since.
    stack.useStore("scratch");
    return { flow, ctx: session.ctx, session };
  }
  const stepInfo = (flow: any, c: Ctx) => flow.steps.map((s: any) => {
    let inputs: unknown[] = [];
    try { inputs = s.inputs?.(c) ?? []; } catch { inputs = []; }
    return { id: s.id, title: s.title, actor: s.actor, doc: s.doc, inputs };
  });
  const storeStatus = () => ({ active: stack.stores.activeName, label: stack.stores.activeLabel });
  const file = (name: string) => new Response(Bun.file(join(root, "web", name)));

  async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;
    if (p === "/" || p === "/index.html") return file("index.html");
    if (p === "/app.js") return file("app.js");
    if (p === "/styles.css") return file("styles.css");
    if (p === "/admin") return file("admin.html");
    if (p === "/admin.js") return file("admin.js");
    if (p === "/oauth/callback") return callback(req);
    if (p.startsWith("/api/admin/")) return adminApi(stack, req, url, { forgetFlow: () => { session = undefined; } });
    if (p === "/api/pending-authorization") return json({ url: session?.ctx.pendingAuthUrl ?? null });
    if (p === "/api/session") return json({ session: session?.ctx.session ?? null, flow: session?.flowId ?? null, traceUrl: CONFIG.traceUrl });
    if (p === "/api/store") return json(storeStatus());
    if (p === "/api/flow-state") {
      const flow = session && flowById(session.flowId);
      if (!session || !flow) return json({ store: storeStatus(), flow: null });
      return json({ store: storeStatus(), flow: session.flowId, running: session.running ?? null, steps: stepInfo(flow, session.ctx), completed: session.completed, policy: stack.stores.scratch.getPolicy() });
    }
    if (p === "/api/flows") return json({ services: SERVICES, backend: stack.backend, store: storeStatus(), flows: FLOWS.map(f => ({ id: f.id, number: f.number, group: f.group, title: f.title, summary: f.summary, shows: f.shows, steps: f.steps.length })) });
    if (p === "/api/backends") return json({ current: stack.backend, backends: await Promise.all(BACKEND_NAMES.map(n => stack.selfTest(n))) });
    if ((p === "/api/backend" || p.startsWith("/api/flows/")) && req.method === "POST") {
      const refused = refuseWrite(req, url);
      if (refused) return refused;
    }
    if (p === "/api/backend" && req.method === "POST") {
      const b = await readJson(req);
      if (b === undefined || !BACKEND_NAMES.includes(b?.backend)) return json({ error: "unknown backend" }, 400);
      stack.setBackend(b.backend as BackendName);
      return json({ backend: stack.backend });
    }
    if (p === "/api/policy" && req.method === "GET") return json(stack.imaging.getPolicy());
    if (p === "/api/policy" && req.method === "PUT") {
      const refused = refuseWrite(req, url);
      if (refused) return refused;
      const b = await readJson(req);
      if (b === undefined) return json({ error: "the request body must be valid JSON" }, 400);
      try {
        stack.imaging.setPolicy(b);
      } catch (e) {
        if (e instanceof PolicyValidationError) return json({ error: e.message, errors: e.errors }, 400);
        throw e;
      }
      return json(stack.imaging.getPolicy());
    }
    const start = p.match(/^\/api\/flows\/([^/]+)\/start$/);
    if (start && req.method === "POST") {
      const s = await ensureSession(start[1]!, true);
      if (!s) return json({ error: "unknown flow" }, 404);
      return json({ steps: stepInfo(s.flow, s.ctx), policy: stack.imaging.getPolicy(), session: s.ctx.session, store: storeStatus() });
    }
    const step = p.match(/^\/api\/flows\/([^/]+)\/steps\/([^/]+)$/);
    if (step && req.method === "POST") {
      const b: any = await req.json().catch(() => ({}));
      if (session && session.flowId !== step[1]) return json({ error: "another flow has started since this page loaded: reload to see it" }, 409);
      if (session?.running) return json({ error: `the step "${session.running}" is still running` }, 409);
      if (session?.completed[step[2]!]) return json({ error: "this step has already run: reload to see its result" }, 409);
      if (session) session.running = step[2]!; // Set before anything can yield, so a second tab sees it.
      const s = await ensureSession(step[1]!, false);
      if (!s) return json({ error: "unknown flow" }, 404);
      s.session.running = step[2]!;
      try {
        const result = await runStep(s.ctx, s.flow, step[2]!, b.inputs ?? {});
        s.session.completed[step[2]!] = { inputs: b.inputs ?? {}, result };
        return json({ result, steps: stepInfo(s.flow, s.ctx), policy: stack.imaging.getPolicy(), events: stack.proxy.events.slice(-12), store: storeStatus() });
      } catch (e) { return json({ error: String((e as Error).message ?? e) }, 500); }
      finally { s.session.running = undefined; }
    }
    return new Response("not found", { status: 404 });
  }
  return { fetch };
}
