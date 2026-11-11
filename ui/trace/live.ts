// The live trace's data: the sessions the trace service holds, the one shown and its spans, kept current from the
// service's event stream. A page reads it through useLiveTrace, and redraws at most once a frame however fast spans
// arrive. Spans merge by sequence number, so an older snapshot can't undo a newer live event.
import { useEffect, useState, useSyncExternalStore } from "react";
import { sessionApi, streamUrl, traceApi, type SessionInfo, type Span } from "./model";

export const UNATTRIBUTED = "unattributed";
/** Each service's short label, and the colour it's drawn in. */
export const SERVICES: Record<string, [string, string]> = {
  user: ["user", "--svc-user"], app: ["app", "--svc-app"], "authorization-server": ["auth", "--svc-as"], "imaging-fhir": ["imaging", "--svc-fhir"],
  policy: ["policy", "--svc-policy"], "dicomweb-proxy": ["proxy", "--svc-proxy"], backend: ["backend", "--svc-backend"], demo: ["expected", "--svc-demo"],
};
export const sessionLabel = (id: string) => id === UNATTRIBUTED ? "Calls outside any flow" : id;

/** A long session shows its newest requests first: drawing thousands at once holds the page for seconds. */
const RECENT_TRACES = 200;

export class LiveTrace {
  sessions: SessionInfo[] = [];
  /** The session chosen to hold still on, or "" to follow the newest. */
  chosen: string;
  /** Whether the view keeps to the newest session and the newest spans. */
  follow: boolean;
  paused = false;
  /** What the page says about the stream: live, paused, or what went wrong. */
  status = "Connecting…";
  /** The session whose spans are held, and those spans. */
  shown?: string;
  readonly spans = new Map<string, Span>();
  /** Spans whose previews are open, and the full records loaded for them. */
  readonly open = new Set<string>();
  readonly details = new Map<string, Span>();
  /** Bumped on every change: what React compares. */
  version = 0;

  /** How many traces the shown session holds, and whether all are loaded: a long session loads its newest first. */
  traceCount = 0;
  allLoaded = true;
  private wantAll = false;
  private waiting: (() => void)[] = [];
  private loading = new Set<string>();
  private loadTicket = 0;
  private kids?: Map<string, Span[]>;
  private descendants = new Map<string, Span[]>();
  private listeners = new Set<() => void>();
  private frame = 0;
  private es?: EventSource;

  constructor(chosen = "") {
    this.chosen = chosen;
    this.follow = !chosen;
  }

  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  /**
   * Many spans can arrive in one frame, so the page draws once for all of them. What someone does draws at once,
   * so a control shows its new state as it's used.
   */
  private changed(now = false) {
    this.version++;
    if (now) { cancelAnimationFrame(this.frame); this.frame = 0; this.notify(); return; }
    if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.notify(); });
  }
  private notify() { for (const fn of this.listeners) fn(); }

  /** Newest flow, by activity. Calls with no flow don't take over the view while a flow is running. */
  activeSession() { return this.chosen || (this.sessions.find(s => s.id !== UNATTRIBUTED) ?? this.sessions[0])?.id; }
  get waitingCount() { return this.waiting.length; }

  private keep(s: Span) {
    const was = this.spans.get(s.span);
    if (!was || (s.seq ?? 0) >= (was.seq ?? 0)) { this.spans.set(s.span, s); this.kids = undefined; this.descendants.clear(); }
  }
  private clearShown() { this.spans.clear(); this.kids = undefined; this.descendants.clear(); }

  /** Loads the active session's spans, starting afresh when it's a different session from the one shown. */
  async load() {
    const id = this.activeSession(), ticket = ++this.loadTicket;
    if (id !== this.shown) { this.shown = id; this.clearShown(); this.wantAll = false; }
    this.changed();
    if (!id) return;
    try {
      const r = await fetch(sessionApi(id, this.wantAll ? "/spans" : `/spans?traces=${RECENT_TRACES}`));
      const list: Span[] = await r.json();
      if (ticket !== this.loadTicket) return;
      this.traceCount = Number(r.headers.get("x-trace-count") ?? 0);
      this.allLoaded = this.wantAll || this.traceCount <= RECENT_TRACES;
      for (const s of list) this.keep(s);
    } catch { this.status = "Couldn't load that session."; }
    this.changed();
  }

  /** Loads the shown session's earlier traces too. */
  loadAll() { this.wantAll = true; return this.load(); }
  /** Holds still on one session, or with "", follows the newest again. */
  choose(id: string) { this.chosen = id; this.follow = !id; this.changed(true); return this.load(); }
  setFollow(on: boolean) {
    if (on) { this.follow = true; this.chosen = ""; this.changed(true); return this.load(); }
    this.stopFollowing();
  }
  /** Reading something stops the page from moving under you. */
  stopFollowing() {
    if (!this.follow) return;
    this.follow = false;
    if (!this.chosen) this.chosen = this.activeSession() ?? "";
    this.changed(true);
  }
  togglePause() {
    this.paused = !this.paused;
    if (!this.paused) for (const replay of this.waiting.splice(0)) replay();
    this.showStatus(true);
  }
  private showStatus(now = false) { this.status = this.paused ? `Paused. ${this.waiting.length} updates waiting.` : "Live."; this.changed(now); }
  toggle(id: string) {
    if (this.open.has(id)) this.open.delete(id); else this.open.add(id);
    this.changed(true);
  }
  async clearAll() {
    const r = await fetch(traceApi("/sessions"), { method: "DELETE" }).catch(() => undefined);
    if (!r?.ok) { this.status = "Couldn't clear the traces."; this.changed(); }
  }
  /** The full record of a span with an exchange, for its preview, once per change to the span. */
  async loadDetail(s: Span) {
    const id = s.span;
    if (!s.http || (this.details.get(id)?.seq ?? -1) >= (s.seq ?? 0) || this.loading.has(id)) return;
    this.loading.add(id);
    try {
      const r = await fetch(sessionApi(s.session, `/spans/${encodeURIComponent(id)}`));
      if (r.ok) this.details.set(id, await r.json());
    } catch { /* The summary still shows what's known. */ }
    this.loading.delete(id);
    this.changed();
  }
  isLoading(id: string) { return this.loading.has(id); }

  kidsOf(id: string) {
    if (!this.kids) {
      this.kids = new Map();
      for (const s of this.spans.values()) if (s.parent) { const list = this.kids.get(s.parent) ?? []; list.push(s); this.kids.set(s.parent, list); }
    }
    return this.kids.get(id) ?? [];
  }
  /** Everything nested under a span. The same list until the spans change, so a preview isn't read again for nothing. */
  descendantsOf(id: string) {
    let out = this.descendants.get(id);
    if (!out) {
      const list: Span[] = [];
      const walk = (i: string) => { for (const c of this.kidsOf(i)) { list.push(c); walk(c.span); } };
      walk(id);
      this.descendants.set(id, out = list);
    }
    return out;
  }
  /** The receiving side of an HTTP call whose caller's side is its parent. */
  isPairedServer(s: Span) {
    const parent = s.parent ? this.spans.get(s.parent) : undefined;
    return s.kind === "server" && !!s.http && parent?.kind === "client" && !!parent.http;
  }
  pairOf(s: Span) {
    const label = (x: Span) => SERVICES[x.service]?.[0] ?? x.service;
    if (this.isPairedServer(s)) return { label: label(s), isClient: false };
    const child = s.kind === "client" && s.http ? this.kidsOf(s.span).find(c => this.isPairedServer(c)) : undefined;
    return child ? { label: label(child), isClient: true } : undefined;
  }

  /** While paused, live events wait in order. Controls keep working on what's already shown. */
  private live<T>(handler: (data: T) => void) {
    return (e: MessageEvent) => {
      const data = JSON.parse(e.data) as T;
      if (this.paused) { this.waiting.push(() => handler(data)); this.showStatus(); return; }
      handler(data);
    };
  }
  connect() {
    const es = this.es = new EventSource(streamUrl());
    es.addEventListener("hello", this.live<SessionInfo[]>(async list => { this.sessions = list; await this.load(); this.showStatus(); }));
    es.addEventListener("session", this.live<SessionInfo>(s => {
      if (!this.sessions.some(x => x.id === s.id)) this.sessions = [s, ...this.sessions];
      if (!this.chosen) this.load(); else this.changed();
    }));
    es.addEventListener("cleared", this.live(() => {
      this.sessions = []; this.chosen = ""; this.shown = undefined; this.loadTicket++; this.follow = true;
      this.clearShown(); this.details.clear(); this.open.clear();
      this.changed();
    }));
    es.addEventListener("removed", this.live<string[]>(ids => {
      this.sessions = this.sessions.filter(s => !ids.includes(s.id));
      if (ids.includes(this.chosen)) this.chosen = "";
      if (this.shown && ids.includes(this.shown)) { this.follow = !this.chosen; this.load(); } else this.changed();
    }));
    es.addEventListener("span", this.live<Span>(s => {
      const m = this.sessions.find(x => x.id === s.session);
      if (m && this.sessions[0] !== m && s.session !== UNATTRIBUTED) {
        this.sessions = [m, ...this.sessions.filter(x => x !== m)];
        if (!this.chosen) { this.load(); return; }
      }
      if (s.session === this.activeSession()) { this.keep(s); this.changed(); }
    }));
    es.onerror = () => { this.status = "Disconnected. Reconnecting…"; this.changed(); };
  }
  close() { this.es?.close(); cancelAnimationFrame(this.frame); this.frame = 0; }
}

/** The live trace for this page, connected while the page is shown. The page redraws when anything in it changes. */
export function useLiveTrace(chosen: string) {
  const [trace] = useState(() => new LiveTrace(chosen));
  useEffect(() => { trace.connect(); return () => trace.close(); }, [trace]);
  useSyncExternalStore(trace.subscribe, () => trace.version);
  return trace;
}
