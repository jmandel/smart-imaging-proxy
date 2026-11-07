// The demo's own web server: the flow player and admin screen, backed by the real services.
import { join } from "node:path";
import { traced } from "./trace";
import type { BackendName, Stack } from "./stack";
import { FLOWS, flowById, runStep, startFlow, BadStepInput } from "./flows";
import { StepStopped, type Ctx } from "./flows/runtime";
import { CONFIG } from "./config";
import { adminApi, extraField, readJson, refuseHost, refuseWrite, BACKEND_NAMES } from "./admin-api";
import { PolicyValidationError } from "./policy-store";
import type { BackendClient } from "./auth-server";
import { createBrowse } from "./browse";

const SERVICES = { proxy: CONFIG.proxyUrl, imaging: CONFIG.imagingUrl, authorization: CONFIG.authUrl, "live trace": CONFIG.traceUrl };
const json = (b: unknown, status = 200) => Response.json(b, { status });

export function createDemoServer(stack: Stack, clients: Record<string, BackendClient>, root: string) {
  // What a reload needs to show this flow again, and what stops another tab from disturbing it.
  let session: { flowId: string; ctx: Ctx; completed: Record<string, { inputs: unknown; result: unknown }>; running?: string } | undefined;

  // The redirect URI the demo app registered. Whoever is waiting takes only its own redirect, by `state`.
  // The redirect is a real protocol message with no trace fields, so its span joins the flow waiting on it.
  const browse = createBrowse(stack, clients, { flowRunning: () => session?.running });
  const callback = traced("app", async req => {
    const back = new URL(req.url);
    if (!browse.receiveCallback(back) && !session?.ctx.receiveCallback(back)) return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Not expected</title></head><body style="font:15px system-ui;padding:2rem"><p>This redirect doesn't match a sign-in the app is waiting for, so the app ignored it.</p></body></html>`, { status: 400, headers: { "content-type": "text/html" } });
    return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Back in the app</title></head><body style="font:15px system-ui;padding:2rem"><p>Back in the app. You can close this window.</p><script>window.close()</script></body></html>`, { headers: { "content-type": "text/html" } });
  }, (_req, url) => `Redirect back to the app: ${url.pathname}`, (_req, url) => browse.callbackContext(url) ?? session?.ctx.callbackContext ?? (session ? { session: session.ctx.session } : undefined));

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
    const foreign = refuseHost(req);
    if (foreign) return foreign;
    if (p === "/" || p === "/index.html") return file("index.html");
    if (p === "/app.js") return file("app.js");
    if (p === "/styles.css") return file("styles.css");
    if (p === "/fonts/atkinson-next.woff2" || p === "/fonts/atkinson-mono.woff2") return file(p.slice(1));
    if (p === "/admin") return file("admin.html");
    if (p === "/admin.js") return file("admin.js");
    if (p === "/browse") return file("browse.html");
    if (p === "/browse.js") return file("browse.js");
    if (p.startsWith("/api/browse/")) return browse.fetch(req, url);
    if (p === "/oauth/callback") return callback(req);
    // Leaving saved policy would end a Browse sign-in partway through.
    if (p === "/api/admin/store/activate" && req.method === "POST") {
      // Only a request the admin API would accept can cost someone their sign-in.
      const asked = await req.clone().json().catch(() => undefined) as any;
      const valid = !refuseWrite(req, url) && !url.search && Object.keys(asked ?? {}).length === 1 && (asked?.store === "saved" || asked?.store === "scratch");
      const held = valid ? browse.holdStore() : undefined;
      if (held) return json({ error: held }, 409);
    }
    if (p.startsWith("/api/admin/")) return adminApi(stack, req, url, { forgetFlow: () => { session = undefined; } });
    if (p === "/api/pending-authorization") return json({ url: session?.ctx.pendingAuthUrl ?? null });
    if (p === "/api/pending-authorization/cancel" && req.method === "POST") {
      const refused = refuseWrite(req, url);
      if (refused) return refused;
      session?.ctx.cancelWindow?.("The sign-in window closed before it finished. Run the step again.");
      return json({ ok: true });
    }
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
      const extra = extraField(b, ["backend"]);
      if (extra) return json({ error: extra }, 400);
      stack.setBackend(b.backend as BackendName);
      return json({ backend: stack.backend });
    }
    if (p === "/api/policy" && req.method === "GET") return json(stack.imaging.getPolicy());
    if (p === "/api/policy" && req.method === "PUT") {
      const refused = refuseWrite(req, url);
      if (refused) return refused;
      if (stack.stores.activeName !== "scratch") return json({ error: "Saved policy is active, and this panel changes only flow scratch. Saved rules change through the named rule sets on the admin screen." }, 409);
      const b = await readJson(req);
      if (b === undefined) return json({ error: "the request body must be valid JSON" }, 400);
      try {
        stack.stores.scratch.setPolicy(b);
      } catch (e) {
        if (e instanceof PolicyValidationError) return json({ error: e.message, errors: e.errors }, 400);
        throw e;
      }
      return json(stack.stores.scratch.getPolicy());
    }
    const start = p.match(/^\/api\/flows\/([^/]+)\/start$/);
    if (start && req.method === "POST") {
      const held = browse.holdStore();
      if (held) return json({ error: held }, 409);
      const s = await ensureSession(start[1]!, true);
      if (!s) return json({ error: "unknown flow" }, 404);
      return json({ steps: stepInfo(s.flow, s.ctx), policy: stack.imaging.getPolicy(), session: s.ctx.session, store: storeStatus() });
    }
    const step = p.match(/^\/api\/flows\/([^/]+)\/steps\/([^/]+)$/);
    if (step && req.method === "POST") {
      const text = await req.text();
      let b: any = {};
      if (text.trim()) { try { b = JSON.parse(text) ?? {}; } catch { return json({ error: "the request body isn't JSON" }, 400); } }
      if (b.inputs !== undefined && (typeof b.inputs !== "object" || b.inputs === null || Array.isArray(b.inputs))) return json({ error: "inputs must be an object" }, 400);
      if (session && session.flowId !== step[1]) return json({ error: "another flow has started since this page loaded: reload to see it" }, 409);
      if (session?.running) return json({ error: `the step "${session.running}" is still running` }, 409);
      if (session && Object.hasOwn(session.completed, step[2]!)) return json({ error: "this step has already run: reload to see its result" }, 409);
      const held = browse.holdStore();
      if (held) return json({ error: held }, 409);
      if (session) session.running = step[2]!; // Set before anything can yield, so a second tab sees it.
      const s = await ensureSession(step[1]!, false);
      if (!s) return json({ error: "unknown flow" }, 404);
      s.session.running = step[2]!;
      try {
        const result = await runStep(s.ctx, s.flow, step[2]!, b.inputs ?? {});
        s.session.completed[step[2]!] = { inputs: b.inputs ?? {}, result };
        return json({ result, steps: stepInfo(s.flow, s.ctx), policy: stack.imaging.getPolicy(), events: stack.proxy.events.slice(-12), store: storeStatus() });
      } catch (e) { return json({ error: String((e as Error).message ?? e) }, e instanceof StepStopped ? 409 : e instanceof BadStepInput ? 400 : /^no step /.test((e as Error).message) ? 404 : 500); }
      finally { s.session.running = undefined; }
    }
    return new Response("not found", { status: 404 });
  }
  return { fetch };
}
