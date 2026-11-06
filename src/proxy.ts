// WADO-RS proxy. It has the Imaging Server's public keys, a service credential, and a backend. It
// holds no policy, patient data, or signing secret: a request is either covered by a signed context,
// or it asks. It also holds nothing per study. Its only state is the bounded decision cache, the
// bounded event log, and its copy of the public keys, so another process could serve the same request.
import type { KeyObject } from "node:crypto";
import { acceptsZstd, parseAccept, type PlanItem } from "./accept";
import { BackendError, type Backend, type InstancePart, type PartStream, type PlannedPart, type Scope } from "./backends/types";
import { jwksKeys, staticKeys, type KeySource } from "./jwks";
import { ath, kidOf, sha, verifyJws } from "./jws";
import { closing, newBoundary, partFooter, partHeader, stableBoundary } from "./multipart";
import { readFileMeta } from "./dicom";
import { isStandard } from "./syntax";
import { now } from "./clock";
import { check, inSpan, startSpan, tfetch, traced, withSpan, type SpanHandle } from "./trace";
import { rawFrame, rawFrameSize, RawFrameWriter } from "./zstd-frames";

const UID = /^[0-9]+(\.[0-9]+)*$/;
const CTX = /^[A-Za-z0-9_\-.]+$|^-$/;
const validUid = (u: string) => UID.test(u) && u.length <= 64;
const ROUTE = /^\/wado\/([^/]+)\/studies\/([^/]+)(?:\/series\/([^/]+))?(?:\/instances\/([^/]+))?(?:\/(metadata|bulk\/[0-9a-fA-F/]+|frames\/.+|rendered|thumbnail))?\/?$/;
const enc = new TextEncoder();

type Release = "study" | { series: string[] };
interface Outcome { allowed: boolean; release?: Release; denial?: string; via: "instant" | "cached" | "asked"; why?: string; unavailable?: boolean; version?: number; }

export interface ProxyEvent {
  id: number; method: string; path: string; authz?: string; status?: number; denial?: string; parts?: number; ms?: number;
  syntaxes?: string[]; note?: string; rewritten?: number; truncated?: boolean;
  /** Bytes handed to the client so far. */
  bytes?: number; disconnected?: boolean;
}

/** Keys come from a JWKS URL or, in tests, from a map. */
type KeyOption = { jwksUrl: string; jwksTtlSeconds?: number; jwksCooldownSeconds?: number; jwksClock?: () => number; keys?: undefined } | { keys: Map<string, KeyObject>; jwksUrl?: undefined };

export function createProxy(opts: KeyOption & {
  publicBase: () => string; decisionUrl: string; serviceSecret: string; backend: () => Backend; maxDecisions?: number; maxEvents?: number;
}) {
  const keySource: KeySource = opts.keys ? staticKeys(opts.keys) : jwksKeys({ url: opts.jwksUrl, ttlSeconds: opts.jwksTtlSeconds, cooldownSeconds: opts.jwksCooldownSeconds, clock: opts.jwksClock });
  const maxDecisions = opts.maxDecisions ?? 10000, maxEvents = opts.maxEvents ?? 500;
  const cache = new Map<string, { until: number; outcome: Outcome }>();
  const events: ProxyEvent[] = [];
  let seq = 0;

  const verified = async (ctx: string) => verifyJws(ctx, await keySource.keysFor(kidOf(ctx)));

  /** Room for one more: expired entries go first, then the oldest. */
  function remember(key: string, entry: { until: number; outcome: Outcome }) {
    cache.delete(key);
    if (cache.size >= maxDecisions) {
      const t = now();
      for (const [k, v] of cache) if (v.until <= t) cache.delete(k);
      for (const k of cache.keys()) { if (cache.size < maxDecisions) break; cache.delete(k); }
    }
    cache.set(key, entry);
  }
  /** A version is a positive whole number. Anything else isn't something this proxy can act on. */
  const validVersion = (v: unknown) => v === undefined || (Number.isInteger(v) && (v as number) > 0);

  async function canI(token: string, ctx: string | undefined, study: string, operation: string): Promise<Outcome> {
    const key = `${sha(token)}|${ctx ? sha(ctx) : "-"}|${study}|${operation}`;
    // A decision cached for a signed URL lasts only while that URL's signature still verifies.
    const hit = !ctx || await verified(ctx) ? cache.get(key) : undefined;
    if (hit && hit.until <= now()) cache.delete(key);
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
    if (d.decision && !check("dicomweb-proxy", "decision's study version is understood", validVersion(d.context?.version), { version: d.context?.version })) return { allowed: false, via: "asked", unavailable: true };
    const outcome: Outcome = d.decision
      ? { allowed: true, release, via: "asked", ...(d.context?.version !== undefined ? { version: d.context.version } : {}) }
      : { allowed: false, denial: d.context?.denial ?? "not_released", via: "asked" };
    const age = d.context?.max_age_seconds ?? 0;
    if (age > 0) remember(key, { until: now() + age, outcome });
    return outcome;
  }

  async function fastPath(token: string, ctx: string | undefined, study: string, series: string | undefined): Promise<Outcome | undefined> {
    const T = "dicomweb-proxy" as const;
    if (!check(T, "fast path: URL carries a signed context", !!ctx)) return undefined;
    const claims = await verified(ctx!);
    if (!check(T, "fast path: signature verifies", !!claims && claims.v === 1, { alg: "EdDSA" })) return undefined;
    if (!check(T, "fast path: context isn't marked restricted", !claims.restricted)) return undefined;
    if (!check(T, "fast path: context hasn't expired", claims.exp > now(), { exp: claims.exp, now: now() })) return undefined;
    if (!check(T, "fast path: requested study is in the context", claims.study === study, { requested: study, context: claims.study })) return undefined;
    if (!check(T, "fast path: token hash matches ath", claims.ath === ath(token), { presented: ath(token).slice(0, 10), context: String(claims.ath).slice(0, 10) })) return undefined;
    if (series && !check(T, "fast path: requested series is released", !claims.series || claims.series.includes(series), { series, listed: claims.series?.length ?? "whole study" })) return undefined;
    if (!check(T, "fast path: study version is understood", validVersion(claims.ver), { version: claims.ver })) return undefined;
    return { allowed: true, release: claims.series ? { series: claims.series } : "study", via: "instant", ...(claims.ver !== undefined ? { version: claims.ver } : {}) };
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

  const plural = (n: number) => `${n} part${n === 1 ? "" : "s"}`;

  /**
   * The response body. It reads `frames` only when the client's side of the stream asks for more,
   * so the proxy holds about one backend chunk per stream, however large the study and however slow
   * the client. The server span stays open until the client has it all or has gone.
   */
  function deliver(frames: AsyncGenerator<Uint8Array>, closeBackend: () => Promise<unknown>, progress: () => { parts: number; syntaxes: string[] }, ev: ProxyEvent, server: SpanHandle, streamSpan: SpanHandle, started: number) {
    let sent = 0, over = false;
    const finish = (status: "ok" | "error", attrs: Record<string, unknown>) => {
      over = true;
      const { parts, syntaxes } = progress();
      ev.parts = parts; ev.syntaxes = syntaxes; ev.bytes = sent;
      ev.ms = Math.round((performance.now() - started) * 10) / 10;
      streamSpan.end(status, { parts, syntaxes: syntaxes.join(", "), bytes_sent: sent, ...attrs });
      server.end(status);
    };
    return new ReadableStream<Uint8Array>({
      pull: c => inSpan(server.ctx, async () => {
        try {
          let r = await frames.next();
          while (!r.done && !r.value.length) r = await frames.next(); // A pull must make progress.
          if (over) return;
          if (r.done) { finish("ok", { closing_boundary: true }); c.close(); return; }
          sent += r.value.length;
          ev.bytes = sent;
          c.enqueue(r.value);
        } catch (e) {
          if (over) return;
          // No closing boundary: abort, so the client can't mistake this for a complete study.
          ev.truncated = true; ev.note = String((e as Error).message ?? e);
          finish("error", { closing_boundary: false, aborted: true, reason: ev.note });
          c.error(e);
        }
      }),
      cancel: () => inSpan(server.ctx, () => {
        if (over) return;
        ev.disconnected = true;
        ev.note = `client disconnected after ${plural(progress().parts)} and ${sent} bytes, so the backend reads were cancelled`;
        check("dicomweb-proxy", "client stayed until the response ended", false, { parts: progress().parts, bytes_sent: sent, backend_reads_cancelled: true });
        finish("error", { closing_boundary: false, client_disconnected: true, backend_reads_cancelled: true });
        // Not awaited: a backend read that's stuck mustn't hold up the cancel.
        closeBackend().catch(() => {});
        frames.return(undefined).catch(() => {});
      }),
    }, { highWaterMark: 0 });
  }

  /** Ends the backend reads: the part body in progress, and the stream of parts. */
  const closer = (parts: PartStream["parts"], body: () => AsyncIterator<Uint8Array> | undefined) => () =>
    Promise.allSettled([body()?.return?.(), parts.return("complete")]);

  async function retrieve(scope: Scope, plan: PlanItem[], ev: ProxyEvent, server: SpanHandle, clientTakesZstd: boolean, started: number): Promise<Response> {
    let stream: PartStream;
    const backendName = opts.backend().capabilities().name;
    try {
      stream = await withSpan("backend", "client", `open instances (${backendName})`, { backend: backendName, study: scope.study, series: scope.series, instance: scope.instance, only_series: scope.onlySeries?.length, version: scope.version, plan: plan.map(p => `${p.syntax};q=${p.q}`).join(", "), passthrough_zstd: clientTakesZstd }, () => opts.backend().openInstances(scope, plan, clientTakesZstd ? { passthroughZstd: true } : undefined));
    } catch (e) { check("dicomweb-proxy", "backend could provide an accepted syntax", false, { error: (e as Error).message }); return backendStatus(e); }
    return stream.plan
      ? planned(stream.parts, stream.plan, scope, plan, ev, server, clientTakesZstd, started, backendName)
      : unplanned(stream.parts, scope, plan, ev, server, started, backendName);
  }

  /**
   * A backend that knows every part up front. Its plan is authoritative, so everything is decided
   * before anything is opened, and the whole response's length is known. A backend that then
   * delivers anything other than what it planned gets the response aborted.
   */
  async function planned(parts: PartStream["parts"], items: PlannedPart[], scope: Scope, plan: PlanItem[], ev: ProxyEvent, server: SpanHandle, zstd: boolean, started: number, backendName: string): Promise<Response> {
    let body: AsyncIterator<Uint8Array> | undefined;
    const closeBackend = closer(parts, () => body);
    const refuse = (res: Response) => { closeBackend().catch(() => {}); return res; };
    if (!check("dicomweb-proxy", "plan has instances", items.length > 0)) return refuse(new Response(null, { status: 404 }));
    const refused = items.find(i => !accepted(i.syntax, plan));
    if (!check("dicomweb-proxy", "every planned part is in an accepted syntax", !refused, { parts: items.length, refused: refused?.syntax })) {
      ev.note = `backend planned ${refused!.syntax}, which the request did not accept`;
      return refuse(new Response(null, { status: 406 }));
    }
    // Stored zstd can only leave as `Content-Encoding: zstd`, which only some clients take.
    if (!check("dicomweb-proxy", "plan's encodings can be sent", zstd || items.every(i => i.encoding === "none"))) {
      ev.note = "backend planned zstd parts without being offered passthrough";
      return refuse(new Response(null, { status: 502 }));
    }

    const boundary = stableBoundary(JSON.stringify([scope.study, scope.series, scope.instance, scope.onlySeries, scope.version, items.map(i => [i.sop, i.syntax])]));
    // Part length is the instance's, even when its body arrives as a frame of some other size.
    const partLength = (i: PlannedPart) => i.encoding === "zstd" ? i.decodedBytes : i.bytes;
    const opening = (index: number) => {
      const i = items[index]!;
      const length = partLength(i);
      const head = partHeader(boundary, { "Content-Type": `application/dicom; transfer-syntax=${i.syntax}`, ...(length !== undefined ? { "Content-Length": String(length) } : {}) });
      if (index === 0) return head;
      const out = new Uint8Array(partFooter.length + head.length);
      out.set(partFooter); out.set(head, partFooter.length);
      return out;
    };
    const ending = () => {
      const last = closing(boundary);
      const out = new Uint8Array(partFooter.length + last.length);
      out.set(partFooter); out.set(last, partFooter.length);
      return out;
    };
    const framed = (bytes: Uint8Array) => zstd ? rawFrame(bytes) : bytes;
    const encodedBody = (i: PlannedPart) => zstd && i.encoding === "none" ? rawFrameSize(i.bytes) : i.bytes;
    let total = framed(ending()).length;
    for (const [index, i] of items.entries()) total += framed(opening(index)).length + encodedBody(i);

    // Commit late: nothing is sent until the first part has opened and given up its first chunk.
    let first: IteratorResult<InstancePart, "complete" | "truncated">;
    let firstChunk: IteratorResult<Uint8Array>;
    try {
      first = await parts.next();
      if (first.done) { check("dicomweb-proxy", "first planned part opened", false, { ended: first.value }); return new Response(null, { status: 502 }); }
      body = first.value.body[Symbol.asyncIterator]();
      firstChunk = await body.next();
    } catch (e) { check("dicomweb-proxy", "first planned part opened", false, { error: (e as Error).message }); return refuse(backendStatus(e)); }
    check("dicomweb-proxy", "first planned part opened (commit to 200)", true, { parts: items.length, content_length: total, content_encoding: zstd ? "zstd" : "identity" });

    server.set({ streaming: true });
    const streamSpan = startSpan("dicomweb-proxy", "internal", "stream multipart response", { study: scope.study, backend: backendName, content_length: total, content_encoding: zstd ? "zstd" : "identity" });
    const syntaxes = new Set<string>();
    let count = 0;
    let held: IteratorResult<Uint8Array> | undefined = firstChunk;
    async function* frames(): AsyncGenerator<Uint8Array> {
      try {
        let part: InstancePart = first.value as InstancePart;
        for (const [index, item] of items.entries()) {
          if (index > 0) {
            const next = await parts.next();
            if (next.done) throw new Error(next.value === "truncated" ? "upstream ended before the study was complete" : `backend ended after ${index} of ${items.length} planned parts`);
            part = next.value;
            body = part.body[Symbol.asyncIterator]();
          }
          if (part.sop !== undefined && part.sop !== item.sop) throw new Error(`backend delivered ${part.sop} where its plan has ${item.sop}`);
          if ((part.encoding ?? "none") !== item.encoding) throw new Error(`backend delivered ${part.encoding ?? "none"} where its plan has ${item.encoding}`);
          syntaxes.add(item.syntax);
          check("dicomweb-proxy", `part ${index + 1}: labeled with the planned syntax`, true, { syntax: item.syntax, bytes: item.bytes, encoding: item.encoding });
          yield framed(opening(index));
          const raw = zstd && item.encoding === "none" ? new RawFrameWriter(item.bytes) : undefined;
          if (raw) yield raw.start();
          let seen = 0;
          while (true) {
            const r: IteratorResult<Uint8Array> = held ?? await body!.next();
            held = undefined;
            if (r.done) break;
            seen += r.value.length;
            if (seen > item.bytes) throw new Error(`part ${index + 1} ran past its planned ${item.bytes} bytes`);
            if (raw) yield* raw.push(r.value);
            else yield r.value;
          }
          if (seen !== item.bytes) throw new Error(`part ${index + 1} ended at ${seen} of its planned ${item.bytes} bytes`);
          raw?.finish();
          count++;
        }
        const after = await parts.next();
        if (!after.done) throw new Error(`backend delivered more than its ${items.length} planned parts`);
        if (after.value === "truncated") throw new Error("upstream ended before the study was complete");
        yield framed(ending());
      } finally { await closeBackend(); }
    }
    const response = deliver(frames(), closeBackend, () => ({ parts: count, syntaxes: [...syntaxes] }), ev, server, streamSpan, started);
    return new Response(response, { status: 200, headers: {
      "Content-Type": `multipart/related; type="application/dicom"; boundary=${boundary}`,
      "Content-Length": String(total),
      Vary: "Accept-Encoding",
      ...(zstd ? { "Content-Encoding": "zstd" } : {}),
    } });
  }

  /** A backend that learns each part as it goes, so the proxy labels each from its File Meta. */
  async function unplanned(parts: PartStream["parts"], scope: Scope, plan: PlanItem[], ev: ProxyEvent, server: SpanHandle, started: number, backendName: string): Promise<Response> {
    let body: AsyncIterator<Uint8Array> | undefined;
    const closeBackend = closer(parts, () => body);
    // Reads the start of a part to learn its real transfer syntax, keeping what it read.
    const open = async (p: InstancePart) => {
      if (p.encoding === "zstd") throw new Error("backend sent a zstd part with no plan");
      const it = p.body[Symbol.asyncIterator]();
      body = it;
      let head = new Uint8Array(0);
      let done = false;
      while (head.length < 4096 && !done) {
        const r = await it.next();
        if (r.done) { done = true; break; }
        const n = new Uint8Array(head.length + r.value.length); n.set(head); n.set(r.value, head.length); head = n;
      }
      const meta = readFileMeta(head);
      return { head, it, done, syntax: meta?.transferSyntax ?? p.syntax, bytes: p.bytes };
    };

    // Commit late: nothing is sent until the first part has been read and checked.
    const first = await parts.next().catch(e => e as BackendError);
    if (first instanceof Error) return backendStatus(first);
    if (first.done) {
      if (first.value === "truncated") return new Response(null, { status: 502 });
      return new Response(null, { status: 404 });
    }
    let firstOpen;
    try { firstOpen = await open(first.value); }
    catch (e) { closeBackend().catch(() => {}); return backendStatus(e); }
    if (!firstOpen.syntax || !accepted(firstOpen.syntax, plan)) {
      ev.note = `backend returned ${firstOpen.syntax}, which the request did not accept`;
      check("dicomweb-proxy", "first part is in an accepted syntax", false, { syntax: firstOpen.syntax });
      closeBackend().catch(() => {});
      return new Response(null, { status: 406 });
    }

    check("dicomweb-proxy", "first part is in an accepted syntax (commit to 200)", true, { syntax: firstOpen.syntax });
    const boundary = newBoundary();
    server.set({ streaming: true });
    const streamSpan = startSpan("dicomweb-proxy", "internal", "stream multipart response", { study: scope.study, backend: backendName });
    const syntaxes = new Set<string>();
    let count = 0;
    async function* frames(): AsyncGenerator<Uint8Array> {
      try {
        let current: Awaited<ReturnType<typeof open>> = firstOpen!;
        while (true) {
          syntaxes.add(current.syntax!);
          check("dicomweb-proxy", `part ${count + 1}: labeled with File Meta syntax`, true, { syntax: current.syntax });
          yield partHeader(boundary, { "Content-Type": `application/dicom; transfer-syntax=${current.syntax}`, ...(current.bytes !== undefined ? { "Content-Length": String(current.bytes) } : {}) });
          let seen = current.head.length;
          if (current.head.length) yield current.head;
          if (!current.done) {
            while (true) {
              const r = await current.it.next();
              if (r.done) break;
              seen += r.value.length;
              yield r.value;
            }
          }
          if (current.bytes !== undefined && seen !== current.bytes) throw new Error(`part ${count + 1} was ${seen} bytes, not the ${current.bytes} it stated`);
          yield partFooter;
          count++;
          const next = await parts.next();
          if (next.done) {
            if (next.value === "truncated") throw new Error("upstream ended before the study was complete");
            break;
          }
          current = await open(next.value);
          if (!current.syntax || !accepted(current.syntax, plan)) throw new Error(`upstream sent ${current.syntax}, which the request did not accept`);
        }
        yield closing(boundary);
      } finally { await closeBackend(); }
    }
    const response = deliver(frames(), closeBackend, () => ({ parts: count, syntaxes: [...syntaxes] }), ev, server, streamSpan, started);
    return new Response(response, { status: 200, headers: { "Content-Type": `multipart/related; type="application/dicom"; boundary=${boundary}` } });
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

  const handle = async (req: Request, ev: ProxyEvent, server: SpanHandle, started: number): Promise<Response> => {
    const pathname = new URL(req.url).pathname;
    // Tells this proxy to refetch the keys now, rather than wait for their TTL. Takes no input.
    if (pathname === "/internal/keys/refresh") {
      if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
      if (!check("dicomweb-proxy", "caller holds the service credential", req.headers.get("authorization") === `Bearer ${opts.serviceSecret}`)) return new Response(null, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
      const refreshed = await keySource.refresh();
      check("dicomweb-proxy", "signing keys refetched", refreshed);
      return new Response(null, { status: refreshed ? 204 : 503 });
    }
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
    const decision = await fastPath(token!, ctx, study, series) ?? await canI(token!, ctx, study, operation);
    ev.authz = decision.via;
    server.set({ authz: decision.via, allowed: decision.allowed, denial: decision.denial });
    if (!decision.allowed) { ev.denial = decision.unavailable ? "decision service unavailable" : decision.denial; return denyResponse(decision); }
    const released = decision.release!;
    if (series && typeof released === "object" && !check("dicomweb-proxy", "requested series is in the released list", released.series.includes(series), { series })) { ev.denial = "series not released"; return new Response(null, { status: 404 }); }
    const scope: Scope = { study, series, instance };
    if (decision.version !== undefined) scope.version = decision.version;
    if (!series && typeof released === "object") scope.onlySeries = released.series;

    if (tail === "metadata") return metadata(scope, ctxSeg, ev);
    if (tail?.startsWith("bulk/")) {
      if (!series || !instance) return new Response(null, { status: 404 });
      try {
        const b = await opts.backend().openBulk(study, series, instance, tail.slice(5), decision.version);
        return new Response(b.body as any, { status: 200, headers: { "Content-Type": b.contentType } });
      } catch (e) { return backendStatus(e); }
    }
    if (tail) { ev.note = `${tail.split("/")[0]} is a SHOULD this demo proxy does not implement`; return new Response(null, { status: 501 }); }

    const accept = parseAccept(req.headers.get("accept"), "dicom");
    // PS3.18 8.7.5: a request without Accept gets 406.
    if (!check("dicomweb-proxy", "Accept has an acceptable media type", !(accept.kind === "none" || accept.kind === "bad" || !accept.plan.length), { accept: req.headers.get("accept") })) { ev.note = "no acceptable media type in Accept"; return new Response(null, { status: 406 }); }
    check("dicomweb-proxy", "Accept compiled into a plan", true, { plan: accept.plan.map(p => `${p.syntax};q=${p.q}`).join(", ") });
    return retrieve(scope, accept.plan, ev, server, acceptsZstd(req.headers.get("accept-encoding")), started);
  };

  return {
    fetch: traced("dicomweb-proxy", async (req: Request, server: SpanHandle): Promise<Response> => {
      const start = performance.now();
      const ev: ProxyEvent = { id: ++seq, method: req.method, path: new URL(req.url).pathname };
      events.push(ev);
      while (events.length > maxEvents) events.shift();
      const res = await handle(req, ev, server, start).catch(e => { ev.note = String(e); return new Response(null, { status: 502 }); });
      ev.status = res.status;
      // A stream sets this again when delivery ends.
      ev.ms = Math.round((performance.now() - start) * 10) / 10;
      return res;
    }),
    events,
    reset() { cache.clear(); events.length = 0; },
    flushDecisions() { cache.clear(); },
    refreshKeys: () => keySource.refresh(),
    get cachedDecisions() { return cache.size; },
  };
}
