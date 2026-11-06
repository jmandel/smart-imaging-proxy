// Web demo: the flow player, backed by the real services.
import { join } from "node:path";
import { startStack, type BackendName } from "./stack";
import { FLOWS, flowById, registerClients, runStep, startFlow } from "./flows";
import type { Ctx } from "./flows/runtime";
import { CONFIG, PORTS } from "./config";

const root = join(import.meta.dir, "..");
const stack = await startStack(root);
const clients = registerClients(stack);
let session: { flowId: string; ctx: Ctx } | undefined;

const json = (b: unknown, status = 200) => Response.json(b, { status });
const SERVICES = { proxy: CONFIG.proxyUrl, imaging: CONFIG.imagingUrl, authorization: CONFIG.authUrl, "live trace": CONFIG.traceUrl };

async function ensureSession(flowId: string, restart: boolean) {
  const flow = flowById(flowId);
  if (!flow) return undefined;
  if (restart || session?.flowId !== flowId) session = { flowId, ctx: await startFlow(stack, clients, flow) };
  return { flow, ctx: session.ctx };
}
const stepInfo = (flow: any, c: Ctx) => flow.steps.map((s: any) => {
  let inputs: unknown[] = [];
  try { inputs = s.inputs?.(c) ?? []; } catch { inputs = []; }
  return { id: s.id, title: s.title, actor: s.actor, doc: s.doc, inputs };
});

const server = Bun.serve({
  port: PORTS.demo, hostname: "127.0.0.1", idleTimeout: 240,
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (p === "/" || p === "/index.html") return new Response(Bun.file(join(root, "web/index.html")));
    if (p === "/app.js") return new Response(Bun.file(join(root, "web/app.js")));
    if (p === "/styles.css") return new Response(Bun.file(join(root, "web/styles.css")));
    if (p === "/api/session") return json({ session: session?.ctx.session ?? null, flow: session?.flowId ?? null, traceUrl: CONFIG.traceUrl });
    if (p === "/api/flows") return json({ services: SERVICES, backend: stack.backend, flows: FLOWS.map(f => ({ id: f.id, number: f.number, group: f.group, title: f.title, summary: f.summary, shows: f.shows, steps: f.steps.length })) });
    if (p === "/api/backends") return json({ current: stack.backend, backends: await Promise.all((["static-files", "minio", "orthanc"] as BackendName[]).map(n => stack.selfTest(n))) });
    if (p === "/api/backend" && req.method === "POST") {
      const b: any = await req.json();
      if (!["static-files", "minio", "orthanc"].includes(b.backend)) return json({ error: "unknown backend" }, 400);
      stack.setBackend(b.backend);
      return json({ backend: stack.backend });
    }
    if (p === "/api/policy" && req.method === "GET") return json(stack.imaging.getPolicy());
    if (p === "/api/policy" && req.method === "PUT") {
      const b: any = await req.json();
      if (!Array.isArray(b.rules)) return json({ error: "rules must be an array" }, 400);
      stack.imaging.setPolicy(b);
      return json(stack.imaging.getPolicy());
    }
    const start = p.match(/^\/api\/flows\/([^/]+)\/start$/);
    if (start && req.method === "POST") {
      const s = await ensureSession(start[1]!, true);
      if (!s) return json({ error: "unknown flow" }, 404);
      return json({ steps: stepInfo(s.flow, s.ctx), policy: stack.imaging.getPolicy(), session: s.ctx.session });
    }
    const step = p.match(/^\/api\/flows\/([^/]+)\/steps\/([^/]+)$/);
    if (step && req.method === "POST") {
      const s = await ensureSession(step[1]!, false);
      if (!s) return json({ error: "unknown flow" }, 404);
      const b: any = await req.json().catch(() => ({}));
      try {
        const result = await runStep(s.ctx, s.flow, step[2]!, b.inputs ?? {});
        return json({ result, steps: stepInfo(s.flow, s.ctx), policy: stack.imaging.getPolicy(), events: stack.proxy.events.slice(-12) });
      } catch (e) { return json({ error: String((e as Error).message ?? e) }, 500); }
    }
    return new Response("not found", { status: 404 });
  },
});
console.log(`SMART Imaging proxy demo: http://127.0.0.1:${server.port}`);
console.log(`Live trace: ${CONFIG.traceUrl}`);
