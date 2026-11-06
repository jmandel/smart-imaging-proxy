// WADO-RS proxy. It has a public key, a service credential, and a backend. It holds no policy,
// patient data, or signing secret: a request is either covered by a signed context, or it asks.
import type { KeyObject } from "node:crypto";
import { parseAccept, type PlanItem } from "./accept";
import { BackendError, type Backend, type InstancePart, type Scope } from "./backends/types";
import { ath, sha, verifyJws } from "./jws";
import { closing, newBoundary, partFooter, partHeader } from "./multipart";
import { readFileMeta } from "./dicom";
import { isStandard } from "./syntax";
import { now } from "./clock";
import { check, startSpan, tfetch, traced, withSpan, type SpanHandle } from "./trace";

const UID = /^[0-9]+(\.[0-9]+)*$/;
const CTX = /^[A-Za-z0-9_\-.]+$|^-$/;
const validUid = (u: string) => UID.test(u) && u.length <= 64;
const ROUTE = /^\/wado\/([^/]+)\/studies\/([^/]+)(?:\/series\/([^/]+))?(?:\/instances\/([^/]+))?(?:\/(metadata|bulk\/[0-9a-fA-F/]+|frames\/.+|rendered|thumbnail))?\/?$/;

type Release = "study" | { series: string[] };
interface Outcome { allowed: boolean; release?: Release; denial?: string; via: "instant" | "cached" | "asked"; why?: string; unavailable?: boolean; }

export interface ProxyEvent {
  id: number; method: string; path: string; authz?: string; status?: number; denial?: string; parts?: number; ms?: number;
  syntaxes?: string[]; note?: string; rewritten?: number; truncated?: boolean;
}

export function createProxy(opts: {
  publicBase: () => string; keys: Map<string, KeyObject>; decisionUrl: string; serviceSecret: string; backend: () => Backend;
}) {
  const cache = new Map<string, { until: number; outcome: Outcome }>();
  const events: ProxyEvent[] = [];
  let seq = 0;

  async function canI(token: string, ctx: string | undefined, study: string, operation: string): Promise<Outcome> {
    const key = `${sha(token)}|${ctx ? sha(ctx) : "-"}|${study}|${operation}`;
    const hit = cache.get(key);
    if (check("dicomweb-proxy", "decision cache lookup", !!(hit && hit.until > now()), { hit: !!hit, fresh: !!hit && hit.until > now(), study })) return { ...hit!.outcome, via: "cached" };
    let res: Response;
    try {
      res = await tfetch("dicomweb-proxy", "can_i (AuthZEN evaluation)", opts.decisionUrl, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${opts.serviceSecret}`, "x-request-id": crypto.randomUUID() },
        body: JSON.stringify({
          subject: { type: "smart_bearer_token", id: ath(token), properties: { access_token: token } },
          action: { name: operation },
          resource: { type: "dicom_study", id: study },
          ...(ctx ? { context: { signed_context: ctx } } : {}),
        }),
      }, { study, operation, token_hash: ath(token).slice(0, 10), has_context: !!ctx });
    } catch { return { allowed: false, via: "asked", unavailable: true }; }
    if (!res.ok) return { allowed: false, via: "asked", unavailable: true };
    const d: any = await res.json().catch(() => undefined);
    if (typeof d?.decision !== "boolean") return { allowed: false, via: "asked", unavailable: true };
    // A true decision is only usable if its release is understood. Anything else fails closed.
    const release = d.context?.release;
    const understood = release === "study" || (Array.isArray(release?.series) && release.series.every((s: unknown) => typeof s === "string"));
    if (d.decision && !check("dicomweb-proxy", "decision's release is understood", understood, { release })) return { allowed: false, via: "asked", unavailable: true };
    const outcome: Outcome = d.decision
      ? { allowed: true, release, via: "asked" }
      : { allowed: false, denial: d.context?.denial ?? "not_released", via: "asked" };
    const age = d.context?.max_age_seconds ?? 0;
    if (age > 0) cache.set(key, { until: now() + age, outcome });
    return outcome;
  }

  function fastPath(token: string, ctx: string | undefined, study: string, series: string | undefined): Outcome | undefined {
    const T = "dicomweb-proxy" as const;
    if (!check(T, "fast path: URL carries a signed context", !!ctx)) return undefined;
    const claims = verifyJws(ctx!, opts.keys);
    if (!check(T, "fast path: signature verifies", !!claims && claims.v === 1, { alg: "EdDSA" })) return undefined;
    if (!check(T, "fast path: context isn't marked restricted", !claims.restricted)) return undefined;
    if (!check(T, "fast path: context hasn't expired", claims.exp > now(), { exp: claims.exp, now: now() })) return undefined;
    if (!check(T, "fast path: requested study is in the context", claims.study === study, { requested: study, context: claims.study })) return undefined;
    if (!check(T, "fast path: token hash matches ath", claims.ath === ath(token), { presented: ath(token).slice(0, 10), context: String(claims.ath).slice(0, 10) })) return undefined;
    if (series && !check(T, "fast path: requested series is released", !claims.series || claims.series.includes(series), { series, listed: claims.series?.length ?? "whole study" })) return undefined;
    return { allowed: true, release: claims.series ? { series: claims.series } : "study", via: "instant" };
  }

  const denyResponse = (o: Outcome) => {
    if (o.unavailable) return new Response(null, { status: 503, headers: { "Retry-After": "5" } });
    if (o.denial === "invalid_token") return new Response(null, { status: 401, headers: { "WWW-Authenticate": 'Bearer error="invalid_token"' } });
    if (o.denial === "insufficient_scope") return new Response(null, { status: 403, headers: { "WWW-Authenticate": 'Bearer error="insufficient_scope"' } });
    return new Response(null, { status: 404 });
  };

  const backendStatus = (e: unknown) => {
    if (e instanceof BackendError) {
      if (e.kind === "NotFound") return new Response(null, { status: 404 });
      if (e.kind === "NotAcceptable" || e.kind === "CannotDecode") return new Response(null, { status: 406 });
      if (e.kind === "Unavailable") return new Response(null, { status: 503, headers: { "Retry-After": String(e.retryAfter ?? 5) } });
    }
    return new Response(null, { status: 502 });
  };

  const accepted = (syntax: string, plan: PlanItem[]) => plan.some(p => p.syntax === syntax || (p.syntax === "*" && isStandard(syntax)));

  async function retrieve(scope: Scope, plan: PlanItem[], ev: ProxyEvent, server: SpanHandle): Promise<Response> {
    let stream;
    const backendName = opts.backend().capabilities().name;
    try {
      stream = await withSpan("backend", "client", `open instances (${backendName})`, { backend: backendName, study: scope.study, series: scope.series, instance: scope.instance, only_series: scope.onlySeries?.length, plan: plan.map(p => `${p.syntax};q=${p.q}`).join(", ") }, () => opts.backend().openInstances(scope, plan));
    } catch (e) { check("dicomweb-proxy", "backend could provide an accepted syntax", false, { error: (e as Error).message }); return backendStatus(e); }
    const parts = stream.parts;

    // Reads the start of a part to learn its real transfer syntax, keeping what it read.
    const open = async (p: InstancePart) => {
      const it = p.body[Symbol.asyncIterator]();
      let head = new Uint8Array(0);
      let done = false;
      while (head.length < 4096 && !done) {
        const r = await it.next();
        if (r.done) { done = true; break; }
        const n = new Uint8Array(head.length + r.value.length); n.set(head); n.set(r.value, head.length); head = n;
      }
      const meta = readFileMeta(head);
      return { head, it, done, syntax: meta?.transferSyntax ?? p.syntax };
    };

    // Commit late: nothing is sent until the first part has been read and checked.
    const first = await parts.next().catch(e => e as BackendError);
    if (first instanceof Error) return backendStatus(first);
    if (first.done) {
      if (first.value === "truncated") return new Response(null, { status: 502 });
      return new Response(null, { status: 404 });
    }
    const firstOpen = await open(first.value);
    if (!firstOpen.syntax || !accepted(firstOpen.syntax, plan)) {
      ev.note = `backend returned ${firstOpen.syntax}, which the request did not accept`;
      check("dicomweb-proxy", "first part is in an accepted syntax", false, { syntax: firstOpen.syntax });
      return new Response(null, { status: 406 });
    }

    check("dicomweb-proxy", "first part is in an accepted syntax (commit to 200)", true, { syntax: firstOpen.syntax });
    const boundary = newBoundary();
    server.set({ streaming: true });
    const streamSpan = startSpan("dicomweb-proxy", "internal", "stream multipart response", { study: scope.study, backend: backendName });
    const syntaxes = new Set<string>();
    let count = 0;
    const body = new ReadableStream<Uint8Array>({
      async start(c) {
        try {
          let current: Awaited<ReturnType<typeof open>> = firstOpen;
          while (true) {
            syntaxes.add(current.syntax!);
            check("dicomweb-proxy", `part ${count + 1}: labeled with File Meta syntax`, true, { syntax: current.syntax });
            c.enqueue(partHeader(boundary, { "Content-Type": `application/dicom; transfer-syntax=${current.syntax}` }));
            if (current.head.length) c.enqueue(current.head);
            if (!current.done) {
              while (true) {
                const r = await current.it.next();
                if (r.done) break;
                c.enqueue(r.value);
              }
            }
            c.enqueue(partFooter);
            count++;
            const next = await parts.next();
            if (next.done) {
              if (next.value === "truncated") throw new Error("upstream ended before the study was complete");
              break;
            }
            current = await open(next.value);
            if (!current.syntax || !accepted(current.syntax, plan)) throw new Error(`upstream sent ${current.syntax}, which the request did not accept`);
          }
          c.enqueue(closing(boundary));
          ev.parts = count; ev.syntaxes = [...syntaxes];
          streamSpan.end("ok", { parts: count, syntaxes: [...syntaxes].join(", "), closing_boundary: true });
          server.end("ok");
          c.close();
        } catch (e) {
          // No closing boundary: abort, so the client can't mistake this for a complete study.
          ev.parts = count; ev.truncated = true; ev.note = String((e as Error).message ?? e);
          streamSpan.end("error", { parts: count, closing_boundary: false, aborted: true, reason: ev.note });
          server.end("error");
          c.error(e);
        }
      },
    });
    return new Response(body, { status: 200, headers: { "Content-Type": `multipart/related; type="application/dicom"; boundary=${boundary}` } });
  }

  function rewriteBulk(value: any, base: string): number {
    let n = 0;
    const visit = (v: any) => {
      if (Array.isArray(v)) return v.forEach(visit);
      if (v && typeof v === "object") {
        for (const [k, el] of Object.entries<any>(v)) {
          if (k === "BulkDataURI" && typeof el === "string") {
            const tag = el.startsWith("bulk:") ? el.slice(5) : el.match(/\/bulk\/([0-9a-fA-F/]+)$/)?.[1] ?? el.split("/").pop()!;
            v[k] = `${base}/bulk/${tag.toUpperCase()}`;
            n++;
          } else visit(el);
        }
      }
    };
    visit(value);
    return n;
  }

  async function metadata(scope: Scope, ctxSegment: string, ev: ProxyEvent): Promise<Response> {
    let items: any[];
    try { items = await withSpan("backend", "client", `read metadata (${opts.backend().capabilities().name})`, { study: scope.study }, () => opts.backend().getMetadata(scope)); } catch (e) { return backendStatus(e); }
    if (!items.length) return new Response(null, { status: 404 });
    let rewritten = 0;
    const raw: string[] = [];
    for (const item of items) {
      const p = item.__path;
      delete item.__path;
      if (item.__rawUrls) { raw.push(...item.__rawUrls); delete item.__rawUrls; }
      const base = `${opts.publicBase()}/wado/${ctxSegment}/studies/${scope.study}/series/${p.series}/instances/${p.instance}`;
      rewritten += rewriteBulk(item, base);
    }
    ev.rewritten = rewritten;
    check("dicomweb-proxy", "metadata rewritten: no upstream URLs remain", true, { instances: items.length, bulk_links_rewritten: rewritten, upstream_urls_hidden: raw.length });
    if (raw.length) ev.note = `hid upstream URLs such as ${raw[0]}`;
    return Response.json(items, { headers: { "Content-Type": "application/dicom+json" } });
  }

  const handle = async (req: Request, ev: ProxyEvent, server: SpanHandle): Promise<Response> => {
    if (req.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET" } });
    const path = new URL(req.url).pathname;
    const m = path.match(ROUTE);
    if (!m) return new Response(null, { status: 404 });
    const [, ctxSeg, study, series, instance, tail] = m as unknown as [string, string, string, string | undefined, string | undefined, string | undefined];
    if (!check("dicomweb-proxy", "UIDs and context are well formed", CTX.test(ctxSeg) && validUid(study) && (!series || validUid(series)) && (!instance || validUid(instance)), { study, series, instance })) return new Response(null, { status: 400 });
    if (instance && !series) return new Response(null, { status: 404 });

    const token = req.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9._~+/=-]+)$/)?.[1];
    if (!check("dicomweb-proxy", "request has a bearer token", !!token, token ? { token_hash: ath(token).slice(0, 10) } : {})) { ev.authz = "no token"; return new Response(null, { status: 401, headers: { "WWW-Authenticate": "Bearer" } }); }
    const ctx = ctxSeg === "-" ? undefined : ctxSeg;
    const operation = tail === "metadata" ? "metadata" : "retrieve";
    const decision = fastPath(token!, ctx, study, series) ?? await canI(token!, ctx, study, operation);
    ev.authz = decision.via;
    server.set({ authz: decision.via, allowed: decision.allowed, denial: decision.denial });
    if (!decision.allowed) { ev.denial = decision.unavailable ? "decision service unavailable" : decision.denial; return denyResponse(decision); }
    const released = decision.release!;
    if (series && typeof released === "object" && !check("dicomweb-proxy", "requested series is in the released list", released.series.includes(series), { series })) { ev.denial = "series not released"; return new Response(null, { status: 404 }); }
    const scope: Scope = { study, series, instance };
    if (!series && typeof released === "object") scope.onlySeries = released.series;

    if (tail === "metadata") return metadata(scope, ctxSeg, ev);
    if (tail?.startsWith("bulk/")) {
      if (!series || !instance) return new Response(null, { status: 404 });
      try {
        const b = await opts.backend().openBulk(study, series, instance, tail.slice(5));
        return new Response(b.body as any, { status: 200, headers: { "Content-Type": b.contentType } });
      } catch (e) { return backendStatus(e); }
    }
    if (tail) { ev.note = `${tail.split("/")[0]} is a SHOULD this demo proxy does not implement`; return new Response(null, { status: 501 }); }

    const accept = parseAccept(req.headers.get("accept"), "dicom");
    // PS3.18 8.7.5: a request without Accept gets 406.
    if (!check("dicomweb-proxy", "Accept has an acceptable media type", !(accept.kind === "none" || accept.kind === "bad" || !accept.plan.length), { accept: req.headers.get("accept") })) { ev.note = "no acceptable media type in Accept"; return new Response(null, { status: 406 }); }
    check("dicomweb-proxy", "Accept compiled into a plan", true, { plan: accept.plan.map(p => `${p.syntax};q=${p.q}`).join(", ") });
    return retrieve(scope, accept.plan, ev, server);
  };

  return {
    fetch: traced("dicomweb-proxy", async (req: Request, server: SpanHandle): Promise<Response> => {
      const start = performance.now();
      const ev: ProxyEvent = { id: ++seq, method: req.method, path: new URL(req.url).pathname };
      events.push(ev);
      if (events.length > 500) events.shift();
      const res = await handle(req, ev, server).catch(e => { ev.note = String(e); return new Response(null, { status: 502 }); });
      ev.status = res.status;
      ev.ms = Math.round((performance.now() - start) * 10) / 10;
      return res;
    }),
    events,
    reset() { cache.clear(); events.length = 0; },
  };
}
