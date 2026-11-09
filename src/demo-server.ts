// The demo's own web server: the tours, which are its home page, Explore, and the activity log, backed by the real services, and the
// flow API the checks and tests run flows through. `/s/{scope}/...` is that scope's own: its Explore,
// its tour, its activity, its settings and its redirects. Starting a tour or a flow mints a scope for it.
import { join } from "node:path";
import { friendlyName, NAME_LIMIT } from "./world-names";
import { addClient, listClients, removeClient } from "./clients";
import { traced } from "./trace";
import type { BackendName, Stack } from "./stack";
import { FLOWS, flowById, runStep, startFlowIn, BadStepInput } from "./flows";
import { StepStopped, type Ctx } from "./flows/runtime";
import { extraField, readJson, refuseHost, refuseWrite, settingsApi, BACKEND_NAMES } from "./settings-api";
import type { BackendClient } from "./auth-server";
import { createExplore } from "./explore";
import { createTours, tourById } from "./tours";
import { eventQueryOf } from "./trace-collector";
import { EVENT_SUMMARY_MAX, type EventQuery } from "./trace-store";
import { activityType, sessionRows, sessionStudies, studiesNamed, tiles, timeline, ACTIVITY_TYPES } from "./activity";
import { reportTitle } from "./referrals";
import { scopeOfSession, type EventRecord } from "./trace";
import { forViewer, viewerKnows } from "./viewer-events";
import { loadViewerKit, VIEWER_KIT_FILES } from "./vendor";
import { panelOf } from "./stores";
import type { World } from "./world";

const json = (b: unknown, status = 200) => Response.json(b, { status });

/** `viewerKitDir` is where viewer-kit was downloaded, `$DEMO_STORAGE/vendor/{tag}` unless given. */
export function createDemoServer(stack: Stack, clients: Record<string, BackendClient>, root: string, options: { viewerKitDir?: string } = {}) {
  const perWorld = new WeakMap<World, ReturnType<typeof worldServer>>();
  const serverOf = (w: World) => { let s = perWorld.get(w); if (!s) perWorld.set(w, s = worldServer(w)); return s; };
  const file = (name: string) => new Response(Bun.file(join(root, "web", name)));
  /** The guide for agents. A sandbox's own copy names that sandbox, so handing over its one link is enough. */
  async function llmsTxt(world: World) {
    const site = world.urls.demo, origin = new URL(site).origin;
    const name = world.scope ? world.store.note("name") : undefined;
    const section = world.scope
      ? `## This sandbox\n\n${name ? `This is "${name}". ` : ""}Everything below works here now. This link is its access, so share it only with those who should use it.\n\n\`\`\`sh\nSANDBOX=${site}\n\`\`\``
      : `## Start here\n\nCreate a sandbox, and use it for everything below:\n\n\`\`\`sh\nSANDBOX=${origin}$(curl -sX POST ${origin}/api/scopes | jq -r .base)\n\`\`\`\n\nOr open the site in a browser and press Connect. Each sandbox has its own copy of this file at \`$SANDBOX/llms.txt\`, which names it.`;
    const text = (await Bun.file(join(root, "web", "llms.txt")).text()).replaceAll("{{SANDBOX_SECTION}}", section).replaceAll("{{ORIGIN}}", origin).replaceAll("{{SITE}}", site);
    return new Response(text, { headers: { "content-type": "text/plain; charset=utf-8", ...(world.scope ? { "x-robots-tag": "noindex", "cache-control": "no-store" } : {}) } });
  }
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
    /** A session's events as its viewer may see them: an Explore view's person or service, a tour's taker, or whoever a flow acts as. */
    const idOfUid = (uid: string) => world.catalog.studyByUid(uid)?.id;
    const viewerEvents = (session: string, events: EventRecord[]) => {
      const all = stack.collector.store.events({ session, limit: EVENT_SUMMARY_MAX }, EVENT_SUMMARY_MAX);
      return forViewer(events, viewerKnows(all, explore.knownIn(session) ?? tours.knownIn(session) ?? []), idOfUid);
    };
    /**
     * The log's filters. A scope's log is its own, and the root's covers every world, filtered by
     * scope. With a session, a study keeps that study's events and the session's events about no
     * study, as Explore tells its chain. With none, it keeps only events that name the study.
     */
    function activityQuery(url: URL): EventQuery | string {
      const q = eventQueryOf(url);
      if (world.scope) q.scope = world.scope;
      const study = url.searchParams.get("study");
      if (study) {
        const uid = world.catalog.allStudies().find(s => s.id === study)?.uid;
        if (q.session) q.about = { study, uid };
        else q.anyLink = [`study:${study}`, ...(uid ? [`uid:${uid}`] : [])];
      }
      const typeId = url.searchParams.get("type");
      if (typeId) {
        const type = activityType(typeId);
        if (!type) return "that isn't one of the log's types";
        if ("kinds" in type) q.kinds = [...type.kinds]; else q.outcomes = [...type.outcomes];
      }
      return q;
    }
    /** A session study by study, with each study's title: the events name only studies its viewer may know. */
    const flowOf = (events: EventRecord[]) => {
      const f = sessionStudies(events, idOfUid);
      const titled = (r: { study: string }) => { const st = world.catalog.allStudies().find(c => c.id === r.study); return { ...r, title: st ? reportTitle(st) : r.study, site: st?.site }; };
      return { ...f, phases: f.phases.map(p => ({ ...p, studies: p.studies.map(titled) })) };
    };
    /** What a session is, in words: Explore, a tour, a flow, or one of the protocol checks. */
    const sessionLabel = (session: string) => {
      const name = session.replace(/@[^@]*$/, "");
      if (name.startsWith("explore-")) return "Explore";
      const tour = name.match(/^tour-(.+)-[0-9a-f]{6}$/);
      if (tour) return `Tour: ${tourById(tour[1]!)?.title ?? tour[1]}`;
      const flow = name.match(/^flow-\d+-(.+)-[0-9a-f]{6}$/);
      if (flow) return `Flow: ${flowById(flow[1]!)?.title ?? flow[1]}`;
      if (name === "unattributed") return "Outside any session";
      return name;
    };
    /** Events as the log shows them: with the study each names, by id, and how long a retrieval's exchange took. */
    const shown = (events: EventRecord[]) => {
      const spans = new Map<string, string[]>();
      for (const e of events) if (e.span && (e.kind === "stream.done" || e.kind === "retrieval.answered")) spans.set(e.session, [...(spans.get(e.session) ?? []), e.span]);
      const ms = new Map([...spans].flatMap(([session, list]) => Object.entries(stack.collector.store.spanDurations(session, list)).map(([span, v]) => [`${session} ${span}`, v] as const)));
      return events.map(e => {
        const study = typeof e.data.study === "string" ? e.data.study : typeof e.data.studyUid === "string" ? idOfUid(e.data.studyUid) : undefined;
        const took = e.span ? ms.get(`${e.session} ${e.span}`) : undefined;
        return { ...e, ...(study ? { study } : {}), ...(took !== undefined ? { ms: took } : {}) };
      });
    };
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
      if (p === "/") return file("client.html");
      if (p === "/tours") return file("tours.html");
      if (p === "/explore") return file("index.html");
      if (p === "/activity") return file("activity.html");
      if (p === "/connect") return file("connect.html");
      if (p === "/llms.txt") return llmsTxt(world);
      if (p.startsWith("/api/explore/")) return explore.fetch(req, url);
      if (p === "/api/tours" || p.startsWith("/api/tours/") || p.startsWith("/api/checks/")) {
        if (req.method === "POST") { const refused = refuseWrite(req, url); if (refused) return refused; }
        return tours.fetch(req, url);
      }
      if (p.startsWith("/api/settings/")) return settingsApi(stack, world, req, url);
      if (p === "/api/activity" && req.method === "GET") {
        // One page of events, oldest first, ending at `before`. One session's is what its viewer may
        // see; every session's at once is the operator's, which alone links to the live trace.
        const q = activityQuery(url);
        if (typeof q === "string") return json({ error: q }, 400);
        const limit = Math.min(Math.max(1, q.limit ?? 100), 500);
        const page = stack.collector.store.events({ ...q, limit: limit + 1 });
        const more = page.length > limit;
        const raw = more ? page.slice(1) : page;
        const events = shown(q.session ? viewerEvents(q.session, raw) : raw);
        return json({ events, more, before: raw[0]?.seq ?? null, ...(q.session ? { viewer: true } : { traceUrl: world.urls.trace }) });
      }
      if (p === "/api/activity/summary" && req.method === "GET") {
        // The rollups, from the same events the log lists, through the same filter, for every type at once.
        const q = activityQuery(url);
        if (typeof q === "string") return json({ error: q }, 400);
        const { kinds: _k, outcomes: _o, before: _b, after: _a, limit: _l, ...base } = q;
        const read = stack.collector.store.events({ ...base, limit: EVENT_SUMMARY_MAX }, EVENT_SUMMARY_MAX);
        const events = base.session ? viewerEvents(base.session, read) : read;
        return json({
          viewer: !!base.session, total: events.length, capped: read.length >= EVENT_SUMMARY_MAX,
          types: ACTIVITY_TYPES.map(t => t.id), tiles: tiles(events), timeline: timeline(events),
          sessions: sessionRows(events, sessionLabel, idOfUid).slice(0, 200), studies: studiesNamed(events, idOfUid),
          ...(base.session ? { flow: flowOf(events) } : { scopes: world.scope ? [] : stack.collector.store.eventFacets().scopes, traceUrl: world.urls.trace }),
        });
      }
      if (p === "/api/activity/span" && req.method === "GET") {
        // The exchange behind an event its session's viewer may see, and no other.
        const session = url.searchParams.get("session") ?? "", span = url.searchParams.get("span") ?? "";
        if (world.scope && scopeOfSession(session) !== world.scope) return json({ error: "not found" }, 404);
        if (!span || !viewerEvents(session, stack.collector.store.events({ session, limit: EVENT_SUMMARY_MAX }, EVENT_SUMMARY_MAX)).some(e => e.span === span)) return json({ error: "not found" }, 404);
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
        const w = stack.scopes.mint({ saved: true });
        return json({ scope: w.scope, base: w.prefix, urls: w.urls }, 201);
      }
      if (p === "/api/world") {
        if (!world.scope) return json({ error: "only a sandbox has a name" }, 409);
        if (req.method === "GET") { let name = world.store.note("name"); if (!name) { name = friendlyName(); world.store.setNote("name", name); } return json({ name }); }
        if (req.method !== "POST") return new Response("not found", { status: 404 });
        const refused = refuseWrite(req, url);
        if (refused) return refused;
        const body: any = await req.json().catch(() => ({}));
        const name = typeof body.name === "string" ? body.name.trim() : "";
        if (!name || name.length > NAME_LIMIT) return json({ error: `a name is 1 to ${NAME_LIMIT} characters` }, 400);
        world.store.setNote("name", name);
        return json({ name });
      }
      if (p === "/api/clients" || p.startsWith("/api/clients/")) {
        if (!world.scope) return json({ error: "apps are registered in a sandbox: open /connect" }, 409);
        if (req.method === "GET" && p === "/api/clients") return json({ clients: listClients(world.store) });
        const refused = refuseWrite(req, url);
        if (refused) return refused;
        if (req.method === "POST" && p === "/api/clients") {
          const body = await req.json().catch(() => ({}));
          const made = addClient(world.store, body as any);
          return "error" in made ? json(made, 400) : json(made, 201);
        }
        const id = p.slice("/api/clients/".length);
        if (req.method === "DELETE" && id) return removeClient(world.store, decodeURIComponent(id)) ? json({ removed: true }) : json({ error: "no such app" }, 404);
        return new Response("not found", { status: 404 });
      }
      if (p === "/api/scopes/current" && req.method === "DELETE") {
        if (!world.scope) return json({ error: "only a scope can be ended" }, 409);
        const refused = refuseWrite(req, url);
        if (refused) return refused;
        stack.scopes.remove(world.scope);
        return json({ deleted: true });
      }
      if (p === "/api/policy" && req.method === "GET") return json(panelOf(world.store));
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
  const STATIC: Record<string, string> = Object.fromEntries(["styles.css", "page.js", "event-words.js", "layers.js", "explore.js", "tours.js", "activity.js", "thumbs.js", "client.js", "client.css", "connect.js", "fonts/atkinson-next.woff2", "fonts/atkinson-mono.woff2"].map(f => [`/${f}`, f]));
  /**
   * viewer-kit's files, from the pinned download, never from the repository: checked once, here at
   * startup, and served only as the bytes that were checked. With none that check out, every one is a
   * 404, and the thumbnails keep their placeholders.
   */
  const kit = loadViewerKit(options.viewerKitDir);
  const vendor = (name: string) => {
    const bytes = kit?.get(name);
    if (!bytes) return new Response(kit || !VIEWER_KIT_FILES.includes(name) ? "not found" : "viewer-kit isn't downloaded, or doesn't match its pin: run bun run viewer-kit", { status: 404 });
    const type = name.endsWith(".wasm") ? "application/wasm" : name.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/plain; charset=utf-8";
    return new Response(bytes, { headers: { "content-type": type, "cache-control": "public, max-age=86400" } });
  };
  const routed = stack.route(w => req => serverOf(w).fetch(req));
  async function fetch(req: Request): Promise<Response> {
    const foreign = refuseHost(req);
    if (foreign) return foreign;
    const p = new URL(req.url).pathname;
    if (STATIC[p]) return file(STATIC[p]!);
    const vendored = p.match(/^\/vendor\/viewer-kit\/([^/]+)$/);
    if (vendored) return vendor(vendored[1]!);
    return routed(req);
  }
  return { fetch };
}
