// The demo's own web server: the tours, which are its home page, Explore, and the activity log, backed by the real services, and the
// flow API the checks and tests run flows through. `/s/{sandbox}/...` is that sandbox's own: its Explore,
// its tour, its activity, its settings and its redirects. Starting a tour or a flow mints a sandbox for it.
import { join } from "node:path";
import { fetchJwks } from "./jwks";
import { PUBLIC_DEMO } from "./config";
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
import { sandboxOfSession, type EventRecord } from "./trace";
import { forViewer, viewerKnows } from "./viewer-events";
import { loadViewerKit, VIEWER_KIT_FILES } from "./vendor";
import { panelOf } from "./stores";
import type { Sandbox } from "./sandbox";
import { ADMIN_SCOPE, SANDBOX_ADMIN } from "./sandbox-keys";

const json = (b: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(b, { status, headers });

/** `viewerKitDir` is where viewer-kit was downloaded, `$DEMO_STORAGE/vendor/{tag}` unless given. */
export function createDemoServer(stack: Stack, clients: Record<string, BackendClient>, root: string, options: { viewerKitDir?: string } = {}) {
  const perSandbox = new WeakMap<Sandbox, ReturnType<typeof sandboxServer>>();
  const serverOf = (w: Sandbox) => { let s = perSandbox.get(w); if (!s) perSandbox.set(w, s = sandboxServer(w)); return s; };
  const file = (name: string) => new Response(Bun.file(join(root, "web", name)));
  /** A sandbox's keys, given out as sample credentials: its admin client's, and each demo service's. */
  const sampleKeys = (sandbox: Sandbox) => {
    const jwkOf = (c: BackendClient) => ({ client_id: c.client_id, jwk: { ...c.privateKey.export({ format: "jwk" }), kid: c.kid, alg: "ES256", use: "sig" } });
    // The sandbox's time, by its demo clock, which an assertion's expiry is checked against.
    return { tokenEndpoint: sandbox.auth.tokenUrl, now: sandbox.clock.now(), admin: { ...jwkOf(sandbox.admin), scope: ADMIN_SCOPE }, services: Object.values(sandbox.clients).map(c => ({ ...jwkOf(c), scope: "system/ImagingStudy.rs" })) };
  };
  /** Why a management call is refused, if it is: it needs a live token this sandbox issued its admin, with the admin scope. */
  const adminDenied = (sandbox: Sandbox, req: Request) => {
    const token = req.headers.get("authorization")?.match(/^bearer +(.+)$/i)?.[1];
    const g: any = token && sandbox.auth.grantOf(token);
    const ok = g && !g.revoked && g.exp > sandbox.clock.now() && g.client_id === SANDBOX_ADMIN && g.scope.split(" ").includes(ADMIN_SCOPE);
    return ok ? undefined : json({ error: "the management API takes this sandbox's admin token: get one with its admin key, from GET /api/sandbox/keys" }, 401, { "WWW-Authenticate": 'Bearer scope="sandbox/admin"' });
  };
  /** The guide for agents. A sandbox's own copy names that sandbox, so handing over its one link is enough. */
  async function llmsTxt(sandbox: Sandbox) {
    const site = sandbox.urls.demo, origin = new URL(site).origin;
    const name = sandbox.id ? sandbox.store.note("name") : undefined;
    const section = sandbox.id
      ? `## This sandbox\n\n${name ? `This is "${name}". ` : ""}Everything below works here now. This link is its access, so share it only with those who should use it.\n\n\`\`\`sh\nSANDBOX=${site}\n\`\`\``
      : `## Start here\n\nCreate a sandbox, and use it for everything below:\n\n\`\`\`sh\nSANDBOX=${origin}$(curl -sX POST ${origin}/api/sandboxes | jq -r .base)\n\`\`\`\n\nOr open the site in a browser and choose Create a sandbox. Each sandbox has its own copy of this file at \`$SANDBOX/llms.txt\`, which names it.`;
    const text = (await Bun.file(join(root, "web", "llms.txt")).text()).replaceAll("{{SANDBOX_SECTION}}", section).replaceAll("{{ORIGIN}}", origin).replaceAll("{{SITE}}", site);
    return new Response(text, { headers: { "content-type": "text/plain; charset=utf-8", ...(sandbox.id ? { "x-robots-tag": "noindex", "cache-control": "no-store" } : {}) } });
  }
  const sandboxOf = (w: Sandbox) => w.id ? { id: w.id, base: w.prefix } : null;

  /** Mints a sandbox and starts `flowId` there. */
  async function startRun(flowId: string) {
    const flow = flowById(flowId);
    if (!flow) return undefined;
    const sandbox = stack.sandboxes.mint();
    const run = await serverOf(sandbox).start(flow.id);
    return { sandbox, run: run! };
  }

  function sandboxServer(sandbox: Sandbox) {
    const services = { proxy: sandbox.urls.proxy, imaging: sandbox.urls.imaging, authorization: sandbox.urls.auth, "live trace": sandbox.urls.trace };
    // What a reload needs to show this sandbox's flow run again, and what stops another tab from disturbing it.
    let session: { flowId: string; ctx: Ctx; completed: Record<string, { inputs: unknown; result: unknown }>; running?: string } | undefined;

    // The redirect URI the demo app registered. Whoever is waiting takes only its own redirect, by `state`.
    // The redirect is a real protocol message with no trace fields, so its span joins the flow waiting on it.
    const explore = createExplore(sandbox, clients, stack);
    const tours = createTours(sandbox, clients, stack);
    /** A session's events as its viewer may see them: an Explore view's person or service, a tour's taker, or whoever a flow acts as. */
    const idOfUid = (uid: string) => sandbox.catalog.studyByUid(uid)?.id;
    const viewerEvents = (session: string, events: EventRecord[]) => {
      const all = stack.collector.store.events({ session, limit: EVENT_SUMMARY_MAX }, EVENT_SUMMARY_MAX);
      return forViewer(events, viewerKnows(all, explore.knownIn(session) ?? tours.knownIn(session) ?? []), idOfUid);
    };
    /**
     * The log's filters. A sandbox's log is its own, and the root's covers every sandbox, filtered by
     * sandbox. With a session, a study keeps that study's events and the session's events about no
     * study, as Explore tells its chain. With none, it keeps only events that name the study.
     */
    function activityQuery(url: URL): EventQuery | string {
      const q = eventQueryOf(url);
      if (sandbox.id) q.sandbox = sandbox.id;
      const study = url.searchParams.get("study");
      if (study) {
        const uid = sandbox.catalog.allStudies().find(s => s.id === study)?.uid;
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
      const titled = (r: { study: string }) => { const st = sandbox.catalog.allStudies().find(c => c.id === r.study); return { ...r, title: st ? reportTitle(st) : r.study, site: st?.site }; };
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
      session = { flowId, ctx: await startFlowIn(sandbox, clients, flow), completed: {} };
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
      if (p === "/build") return new Response((await Bun.file(join(root, "web", "build.html")).text()).replaceAll("{{SITE}}", sandbox.urls.demo), { headers: { "content-type": "text/html; charset=utf-8" } });
      if (p === "/servers") return file("servers.html");
      if (p === "/llms.txt") return llmsTxt(sandbox);
      // The management API takes this sandbox's admin token. Its keys are the one thing open: the URL is the access.
      if (p === "/api/sandbox/keys" && req.method === "GET") return PUBLIC_DEMO && !sandbox.id ? json({ error: "the shared sandbox gives out no keys: make a sandbox of your own with POST /api/sandboxes" }, 403) : json(sampleKeys(sandbox));
      if (p === "/api/sandbox" || p.startsWith("/api/sandbox/")) {
        const denied = adminDenied(sandbox, req);
        if (denied) return denied;
        if (p.startsWith("/api/sandbox/policy/")) {
          if (req.method !== "GET") { const refused = refuseWrite(req, url); if (refused) return refused; }
          const body = req.method === "GET" || req.method === "DELETE" ? undefined : await req.text();
          const r = await sandbox.policyFetch(`${p.slice("/api/sandbox/policy".length)}${url.search}`, { method: req.method, body, contentType: req.headers.get("content-type") ?? undefined });
          return new Response(r.body, { status: r.status, headers: { "content-type": r.headers.get("content-type") ?? "application/json" } });
        }
      }
      if (p.startsWith("/api/explore/")) return explore.fetch(req, url);
      if (p === "/api/tours" || p.startsWith("/api/tours/") || p.startsWith("/api/checks/")) {
        if (req.method === "POST") { const refused = refuseWrite(req, url); if (refused) return refused; }
        return tours.fetch(req, url);
      }
      if ((p === "/api/sandbox" && req.method !== "DELETE") || (p.startsWith("/api/sandbox/") && !p.startsWith("/api/sandbox/clients") && p !== "/api/sandbox/policy")) return settingsApi(stack, sandbox, req, url);
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
        return json({ events, more, before: raw[0]?.seq ?? null, ...(q.session ? { viewer: true } : { traceUrl: sandbox.urls.trace }) });
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
          ...(base.session ? { flow: flowOf(events) } : { sandboxes: sandbox.id ? [] : stack.collector.store.eventFacets().sandboxes, traceUrl: sandbox.urls.trace }),
        });
      }
      if (p === "/api/activity/span" && req.method === "GET") {
        // The exchange behind an event its session's viewer may see, and no other.
        const session = url.searchParams.get("session") ?? "", span = url.searchParams.get("span") ?? "";
        if (sandbox.id && sandboxOfSession(session) !== sandbox.id) return json({ error: "not found" }, 404);
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
      if (p === "/api/session") return json({ session: session?.ctx.session ?? null, flow: session?.flowId ?? null, traceUrl: sandbox.urls.trace, sandbox: sandboxOf(sandbox) });
      if (p === "/api/flow-state") {
        const flow = session && flowById(session.flowId);
        if (!session || !flow) return json({ sandbox: sandboxOf(sandbox), flow: null });
        return json({ sandbox: sandboxOf(sandbox), flow: session.flowId, running: session.running ?? null, steps: stepInfo(flow, session.ctx), completed: session.completed, policy: panelOf(sandbox.store) });
      }
      if (p === "/api/flows") return json({ services, backend: sandbox.backend, sandbox: sandboxOf(sandbox), flows: FLOWS.map(f => ({ id: f.id, number: f.number, group: f.group, title: f.title, summary: f.summary, shows: f.shows, steps: f.steps.length })) });
      if ((p === "/api/sandboxes" || p.startsWith("/api/flows/")) && req.method === "POST") {
        const refused = refuseWrite(req, url);
        if (refused) return refused;
      }
      // A new sandbox, seeded from the guardians on file, for anyone to use by its URLs.
      if (p === "/api/sandboxes" && req.method === "POST") {
        const unwanted = (await req.text()).trim();
        if (unwanted && unwanted !== "{}") return json({ error: "this action takes no input" }, 400);
        const w = stack.sandboxes.mint({ saved: true });
        return json({ sandbox: w.id, base: w.prefix, urls: w.urls }, 201);
      }
      if (p === "/api/sandbox/clients" || p.startsWith("/api/sandbox/clients/")) {
        if (!sandbox.id) return json({ error: "apps are registered in a sandbox: open /connect" }, 409);
        if (req.method === "GET" && p === "/api/sandbox/clients") return json({ clients: listClients(sandbox.store) });
        const refused = refuseWrite(req, url);
        if (refused) return refused;
        if (req.method === "POST" && p === "/api/sandbox/clients") {
          const body = await req.json().catch(() => ({}));
          // A URL has to work when it's registered, which also shows its owner any mistake straight away.
          const jwksUrl = (body as any).jwksUrl, jwksOk = typeof jwksUrl === "string" && jwksUrl ? !!(await fetchJwks(jwksUrl, PUBLIC_DEMO))?.length : true;
          const made = addClient(sandbox.store, body as any, { jwksReachable: () => jwksOk });
          return "error" in made ? json(made, 400) : json(made, 201);
        }
        const id = p.slice("/api/sandbox/clients/".length);
        if (req.method === "DELETE" && id) return removeClient(sandbox.store, decodeURIComponent(id)) ? json({ removed: true }) : json({ error: "no such app" }, 404);
        return new Response("not found", { status: 404 });
      }
      if (p === "/api/sandbox" && req.method === "DELETE") {
        if (!sandbox.id) return json({ error: "only a sandbox can be deleted" }, 409);
        const refused = refuseWrite(req, url);
        if (refused) return refused;
        stack.sandboxes.remove(sandbox.id);
        return json({ deleted: true });
      }
      if (p === "/api/sandbox/policy" && req.method === "GET") return json(panelOf(sandbox.store));
      const started = p.match(/^\/api\/flows\/([^/]+)\/start$/);
      if (started && req.method === "POST") {
        const r = await startRun(started[1]!);
        if (!r) return json({ error: "unknown flow" }, 404);
        return json({ sandbox: sandboxOf(r.sandbox), steps: stepInfo(r.run.flow, r.run.ctx), policy: panelOf(r.sandbox.store), session: r.run.ctx.session });
      }
      const step = p.match(/^\/api\/flows\/([^/]+)\/steps\/([^/]+)$/);
      if (step && req.method === "POST") {
        if (!sandbox.id) return json({ error: "a flow runs in its own sandbox: start it, and run its steps at that sandbox's URLs" }, 409);
        const text = await req.text();
        let b: any = {};
        if (text.trim()) { try { b = JSON.parse(text) ?? {}; } catch { return json({ error: "the request body isn't JSON" }, 400); } }
        if (b.inputs !== undefined && (typeof b.inputs !== "object" || b.inputs === null || Array.isArray(b.inputs))) return json({ error: "inputs must be an object" }, 400);
        if (session && session.flowId !== step[1]) return json({ error: "this sandbox runs another flow: start this one to get its own sandbox" }, 409);
        if (session?.running) return json({ error: `the step "${session.running}" is still running` }, 409);
        if (session && Object.hasOwn(session.completed, step[2]!)) return json({ error: "this step has already run: reload to see its result" }, 409);
        if (session) session.running = step[2]!; // Set before anything can yield, so a second tab sees it.
        // A sandbox minted with no run takes the first flow asked of it.
        const s = session ? { flow: flowById(session.flowId)!, ctx: session.ctx, session } : await start(step[1]!);
        if (!s) return json({ error: "unknown flow" }, 404);
        s.session.running = step[2]!;
        try {
          const result = await runStep(s.ctx, s.flow, step[2]!, b.inputs ?? {});
          s.session.completed[step[2]!] = { inputs: b.inputs ?? {}, result };
          return json({ result, steps: stepInfo(s.flow, s.ctx), policy: panelOf(sandbox.store), events: sandbox.proxy.events.slice(-12), sandbox: sandboxOf(sandbox) });
        } catch (e) { return json({ error: String((e as Error).message ?? e) }, e instanceof StepStopped ? 409 : e instanceof BadStepInput ? 400 : /^no step /.test((e as Error).message) ? 404 : 500); }
        finally { s.session.running = undefined; }
      }
      return new Response("not found", { status: 404 });
    }
    return { fetch, start };
  }

  // The same files in every sandbox: the pages work out their sandbox from their own URL.
  const STATIC: Record<string, string> = Object.fromEntries(["styles.css", "page.js", "event-words.js", "layers.js", "explore.js", "tours.js", "activity.js", "thumbs.js", "client.js", "server-list.js", "servers.js", "image-viewer.js", "image-viewer.css", "client.css", "connect.js", "fonts/atkinson-next.woff2", "fonts/atkinson-mono.woff2"].map(f => [`/${f}`, f]));
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
