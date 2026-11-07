// The demo's own web server: Explore, Tours and the activity view, backed by the real services, and the
// flow API the checks and tests run flows through. `/s/{scope}/...` is that scope's own: its Explore,
// its tour, its activity, its settings and its redirects. Starting a tour or a flow mints a scope for it.
import { join } from "node:path";
import { PolicyApiError } from "@smart-imaging-proxy/core";
import { traced } from "./trace";
import type { BackendName, Stack } from "./stack";
import { FLOWS, flowById, runStep, startFlowIn, BadStepInput } from "./flows";
import { StepStopped, type Ctx } from "./flows/runtime";
import { extraField, readJson, refuseHost, refuseWrite, settingsApi, BACKEND_NAMES } from "./settings-api";
import type { BackendClient } from "./auth-server";
import { createExplore } from "./explore";
import { createTours } from "./tours";
import { eventQueryOf } from "./trace-collector";
import { scopeOfSession } from "./trace";
import { VIEWER_KIT_DIR, VIEWER_KIT_FILES } from "./vendor";
import { panelOf, splitPanel } from "./stores";
import type { World } from "./world";

const json = (b: unknown, status = 200) => Response.json(b, { status });

export function createDemoServer(stack: Stack, clients: Record<string, BackendClient>, root: string) {
  const perWorld = new WeakMap<World, ReturnType<typeof worldServer>>();
  const serverOf = (w: World) => { let s = perWorld.get(w); if (!s) perWorld.set(w, s = worldServer(w)); return s; };
  const file = (name: string) => new Response(Bun.file(join(root, "web", name)));
  const scopeOf = (w: World) => w.scope ? { id: w.scope, base: w.prefix } : null;

  /** Mints a scope and starts `flowId` there. */
  async function startRun(flowId: string) {
    const flow = flowById(flowId);
    if (!flow) return undefined;
    const world = stack.scopes.mint();
    const run = await serverOf(world).start(flow.id);
    return { world, run: run! };
  }

  function worldServer(world: World) {
    const services = { proxy: world.urls.proxy, imaging: world.urls.imaging, authorization: world.urls.auth, "live trace": world.urls.trace };
    // What a reload needs to show this world's flow run again, and what stops another tab from disturbing it.
    let session: { flowId: string; ctx: Ctx; completed: Record<string, { inputs: unknown; result: unknown }>; running?: string } | undefined;

    // The redirect URI the demo app registered. Whoever is waiting takes only its own redirect, by `state`.
    // The redirect is a real protocol message with no trace fields, so its span joins the flow waiting on it.
    const explore = createExplore(world, clients, stack);
    const tours = createTours(world, clients, stack);
    const callback = traced("app", async req => {
      const back = new URL(req.url);
      if (!explore.receiveCallback(back) && !tours.receiveCallback(back) && !session?.ctx.receiveCallback(back)) return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Not expected</title></head><body style="font:15px system-ui;padding:2rem"><p>This redirect doesn't match a sign-in the app is waiting for, so the app ignored it.</p></body></html>`, { status: 400, headers: { "content-type": "text/html" } });
      return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Back in the app</title></head><body style="font:15px system-ui;padding:2rem"><p>Back in the app. You can close this window.</p><script>window.close()</script></body></html>`, { headers: { "content-type": "text/html" } });
    }, (_req, url) => `Redirect back to the app: ${url.pathname}`, (_req, url) => explore.callbackContext(url) ?? tours.callbackContext() ?? session?.ctx.callbackContext ?? (session ? { session: session.ctx.session } : undefined));

    const stepInfo = (flow: any, c: Ctx) => flow.steps.map((s: any) => {
      let inputs: unknown[] = [];
      try { inputs = s.inputs?.(c) ?? []; } catch { inputs = []; }
      return { id: s.id, title: s.title, actor: s.actor, doc: s.doc, inputs };
    });

    async function start(flowId: string) {
      const flow = flowById(flowId);
      if (!flow) return undefined;
      session = { flowId, ctx: await startFlowIn(world, clients, flow), completed: {} };
      return { flow, ctx: session.ctx, session };
    }

    async function fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const p = url.pathname;
      if (p === "/" || p === "/index.html") return file("index.html");
      if (p === "/tours") return file("tours.html");
      if (p === "/activity") return file("activity.html");
      if (p.startsWith("/api/explore/")) return explore.fetch(req, url);
      if (p === "/api/tours" || p.startsWith("/api/tours/") || p.startsWith("/api/checks/")) {
        if (req.method === "POST") { const refused = refuseWrite(req, url); if (refused) return refused; }
        return tours.fetch(req, url);
      }
      if (p.startsWith("/api/settings/")) return settingsApi(stack, world, req, url);
      if (p === "/api/activity" && req.method === "GET") {
        // A scope's activity is its own. The root's covers every world, and filters by scope.
        const q = eventQueryOf(url);
        if (world.scope) q.scope = world.scope;
        return json({ events: stack.collector.store.events(q), facets: stack.collector.store.eventFacets(world.scope), traceUrl: world.urls.trace });
      }
      if (p === "/api/activity/span" && req.method === "GET") {
        const session = url.searchParams.get("session") ?? "", span = url.searchParams.get("span") ?? "";
        if (world.scope && scopeOfSession(session) !== world.scope) return json({ error: "not found" }, 404);
        const r = stack.collector.store.span(session, span);
        return r ? json(r) : json({ error: "not found" }, 404);
      }
      if (p === "/oauth/callback") return callback(req);
      if (p === "/api/pending-authorization") return json({ url: session?.ctx.pendingAuthUrl ?? null });
      if (p === "/api/pending-authorization/cancel" && req.method === "POST") {
        const refused = refuseWrite(req, url);
        if (refused) return refused;
        session?.ctx.cancelWindow?.("The sign-in window closed before it finished. Run the step again.");
        return json({ ok: true });
      }
      if (p === "/api/session") return json({ session: session?.ctx.session ?? null, flow: session?.flowId ?? null, traceUrl: world.urls.trace, scope: scopeOf(world) });
      if (p === "/api/flow-state") {
        const flow = session && flowById(session.flowId);
        if (!session || !flow) return json({ scope: scopeOf(world), flow: null });
        return json({ scope: scopeOf(world), flow: session.flowId, running: session.running ?? null, steps: stepInfo(flow, session.ctx), completed: session.completed, policy: panelOf(world.store) });
      }
      if (p === "/api/flows") return json({ services, backend: world.backend, scope: scopeOf(world), flows: FLOWS.map(f => ({ id: f.id, number: f.number, group: f.group, title: f.title, summary: f.summary, shows: f.shows, steps: f.steps.length })) });
      if (p === "/api/backends") return json({ current: world.backend, backends: await Promise.all(BACKEND_NAMES.map(n => stack.selfTest(n))) });
      if ((p === "/api/backend" || p === "/api/scopes" || p.startsWith("/api/flows/")) && req.method === "POST") {
        const refused = refuseWrite(req, url);
        if (refused) return refused;
      }
      if (p === "/api/backend" && req.method === "POST") {
        const b = await readJson(req);
        if (b === undefined || !BACKEND_NAMES.includes(b?.backend)) return json({ error: "unknown backend" }, 400);
        const extra = extraField(b, ["backend"]);
        if (extra) return json({ error: extra }, 400);
        world.setBackend(b.backend as BackendName);
        return json({ backend: world.backend });
      }
      // A new scope, seeded from the guardians on file, for anyone to use by its URLs.
      if (p === "/api/scopes" && req.method === "POST") {
        const unwanted = (await req.text()).trim();
        if (unwanted && unwanted !== "{}") return json({ error: "this action takes no input" }, 400);
        const w = stack.scopes.mint();
        return json({ scope: w.scope, base: w.prefix, urls: w.urls }, 201);
      }
      if (p === "/api/policy" && req.method === "GET") return json(panelOf(world.store));
      if (p === "/api/policy" && req.method === "PUT") {
        const refused = refuseWrite(req, url);
        if (refused) return refused;
        if (!world.scope) return json({ error: "This panel changes only a flow's own scope. The root's rules change through the named rule sets on the admin screen." }, 409);
        const b = await readJson(req);
        if (b === undefined) return json({ error: "the request body must be valid JSON" }, 400);
        const { document, settings, errors } = splitPanel(b);
        if (errors.length) return json({ error: errors.join("; "), errors }, 400);
        try {
          if (Object.keys(document).length) await world.policy.setDocument(document);
          if (Object.keys(settings).length) await world.policy.setSettings(settings);
        } catch (e) {
          if (e instanceof PolicyApiError && e.status === 400) return json({ error: e.message, errors: e.errors }, 400);
          throw e;
        }
        return json(panelOf(world.store));
      }
      const started = p.match(/^\/api\/flows\/([^/]+)\/start$/);
      if (started && req.method === "POST") {
        const r = await startRun(started[1]!);
        if (!r) return json({ error: "unknown flow" }, 404);
        return json({ scope: scopeOf(r.world), steps: stepInfo(r.run.flow, r.run.ctx), policy: panelOf(r.world.store), session: r.run.ctx.session });
      }
      const step = p.match(/^\/api\/flows\/([^/]+)\/steps\/([^/]+)$/);
      if (step && req.method === "POST") {
        if (!world.scope) return json({ error: "a flow runs in its own scope: start it, and run its steps at that scope's URLs" }, 409);
        const text = await req.text();
        let b: any = {};
        if (text.trim()) { try { b = JSON.parse(text) ?? {}; } catch { return json({ error: "the request body isn't JSON" }, 400); } }
        if (b.inputs !== undefined && (typeof b.inputs !== "object" || b.inputs === null || Array.isArray(b.inputs))) return json({ error: "inputs must be an object" }, 400);
        if (session && session.flowId !== step[1]) return json({ error: "this scope runs another flow: start this one to get its own scope" }, 409);
        if (session?.running) return json({ error: `the step "${session.running}" is still running` }, 409);
        if (session && Object.hasOwn(session.completed, step[2]!)) return json({ error: "this step has already run: reload to see its result" }, 409);
        if (session) session.running = step[2]!; // Set before anything can yield, so a second tab sees it.
        // A scope minted with no run takes the first flow asked of it.
        const s = session ? { flow: flowById(session.flowId)!, ctx: session.ctx, session } : await start(step[1]!);
        if (!s) return json({ error: "unknown flow" }, 404);
        s.session.running = step[2]!;
        try {
          const result = await runStep(s.ctx, s.flow, step[2]!, b.inputs ?? {});
          s.session.completed[step[2]!] = { inputs: b.inputs ?? {}, result };
          return json({ result, steps: stepInfo(s.flow, s.ctx), policy: panelOf(world.store), events: world.proxy.events.slice(-12), scope: scopeOf(world) });
        } catch (e) { return json({ error: String((e as Error).message ?? e) }, e instanceof StepStopped ? 409 : e instanceof BadStepInput ? 400 : /^no step /.test((e as Error).message) ? 404 : 500); }
        finally { s.session.running = undefined; }
      }
      return new Response("not found", { status: 404 });
    }
    return { fetch, start };
  }

  // The same files in every world: the pages work out their scope from their own URL.
  const STATIC: Record<string, string> = Object.fromEntries(["styles.css", "page.js", "cards.js", "explore.js", "tours.js", "activity.js", "thumbs.js", "fonts/atkinson-next.woff2", "fonts/atkinson-mono.woff2"].map(f => [`/${f}`, f]));
  /** viewer-kit's files, from the pinned download, never from the repository. */
  const vendor = async (name: string) => {
    if (!VIEWER_KIT_FILES.includes(name)) return new Response("not found", { status: 404 });
    const f = Bun.file(join(VIEWER_KIT_DIR, name));
    const type = name.endsWith(".wasm") ? "application/wasm" : name.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/plain; charset=utf-8";
    return await f.exists() ? new Response(f, { headers: { "content-type": type, "cache-control": "public, max-age=86400" } }) : new Response("viewer-kit isn't downloaded: run bun run viewer-kit", { status: 404 });
  };
  const routed = stack.route(w => req => serverOf(w).fetch(req));
  async function fetch(req: Request): Promise<Response> {
    const foreign = refuseHost(req);
    if (foreign) return foreign;
    const p = new URL(req.url).pathname;
    if (STATIC[p]) return file(STATIC[p]!);
    const kit = p.match(/^\/vendor\/viewer-kit\/([^/]+)$/);
    if (kit) return vendor(kit[1]!);
    return routed(req);
  }
  return { fetch };
}
