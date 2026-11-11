// The live trace: every span the services record, grouped by trace, nested by cause, with timings, as it happens.
// A row opens a short preview of that span; the full exchange and a trace's HTTP log open in tabs of their own.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { useSearchParams } from "react-router";
import { BASE } from "../lib/api";
import { LinkToView } from "../lib/format";
import { useReady } from "../lib/ready";
import { Preview } from "../trace/Preview";
import { RECENT_TRACES, SERVICES, sessionLabel, useLiveTrace, type LiveTrace } from "../trace/live";
import { fmtBytes, fmtMs, fullHref, logHref, sessionApi, shortUids, traceApi, type Span, type Stats } from "../trace/model";
import "../trace/trace.css";

interface Filters { hidden: ReadonlySet<string>; checks: boolean; parts: boolean }
const visible = (s: Span, f: Filters) => !f.hidden.has(s.service) && (s.kind !== "check" || f.checks) && (!/^part \d+:/.test(s.name) || f.parts);

interface TraceGroup { id: string; spans: Span[]; root: Span; start: number; end: number; rows: [Span, number][] }
/** The shown session's spans, a section per trace in the order they started, each a tree of what's visible. */
function groupsOf(trace: LiveTrace, f: Filters): TraceGroup[] {
  const byTrace = new Map<string, Span[]>();
  for (const s of trace.spans.values()) { const list = byTrace.get(s.trace) ?? []; list.push(s); byTrace.set(s.trace, list); }
  return [...byTrace].map(([id, list]) => {
    list.sort((a, b) => a.start - b.start);
    const start = Math.min(...list.map(s => s.start)), end = Math.max(...list.map(s => s.end ?? s.start));
    const ids = new Set(list.map(s => s.span));
    const children = new Map<string, Span[]>();
    for (const s of list) { const k = s.parent && ids.has(s.parent) ? s.parent : ""; const c = children.get(k) ?? []; c.push(s); children.set(k, c); }
    // A hidden span's children move up to its place.
    const rows: [Span, number][] = [];
    const walk = (s: Span, depth: number) => { const shown = visible(s, f); if (shown) rows.push([s, depth]); for (const c of children.get(s.span) ?? []) walk(c, shown ? depth + 1 : depth); };
    for (const r of children.get("") ?? []) walk(r, 0);
    return { id, spans: list, root: list.find(s => s.kind === "action") ?? list[0]!, start, end, rows };
  }).sort((a, b) => a.start - b.start);
}

const MARKS: Record<string, string> = { ok: "✓", denied: "!", error: "✗", running: "…" };
function hintFor(s: Span) {
  if (!s.http) return "";
  let target = "";
  if (s.kind === "client") { try { target = `${s.http.method} ${shortUids(new URL(s.http.url).pathname.replace(/\/wado\/[^/]+/, "/wado/{ctx}"))} · `; } catch { target = ""; } }
  const outcome = s.http.status ?? (s.end ? "no response" : "");
  return `${target}${outcome}${s.http.bytes ? ` · ${fmtBytes(s.http.bytes)}` : ""}`;
}

/** One span's row: its service, what it was, the HTTP outcome, and where it falls in its trace's time. */
const Row = memo(function Row({ s, depth, start, total, paired, open, onToggle }: { s: Span; depth: number; start: number; total: number; paired: boolean; open: boolean; onToggle: (id: string) => void }) {
  const [text, color] = SERVICES[s.service] ?? [s.service, "--muted"];
  const st = s.end ? s.status : "running";
  const caller = s.kind === "client" && !!s.http;
  const click = (e: MouseEvent) => {
    // A link opens, and selecting text to copy it doesn't toggle the row.
    if ((e.target as Element).closest("a") || !getSelection()?.isCollapsed) return;
    onToggle(s.span);
  };
  const key = (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(s.span); } };
  return (
    <div className={`row${paired ? " paired" : ""}`} data-kind={s.kind} onClick={click}>
      <div className="name" role="button" tabIndex={0} aria-expanded={open} style={{ paddingLeft: depth * 14 }} title={s.name} onKeyDown={key}>
        <span className={`dot ${st ?? ""}`} aria-label={st ?? ""}>{MARKS[st ?? ""] ?? "·"}</span>
        <span className="svc" style={{ color: `var(${color})` }}>{text}</span>
        <span className="via" title={paired ? "The same call as the row above, as it was received" : caller ? "The caller's side of an HTTP call" : ""}>{paired ? "↳" : caller ? "→" : ""}</span>
        <span className="label">{shortUids(s.name)}</span>
        <span className="hint">{hintFor(s)}</span>
      </div>
      <a className="full" href={s.http ? fullHref(s) : undefined} target="_blank" rel="noopener" title="Open full request and response in a new tab" aria-label="Open full request and response in a new tab" hidden={!s.http}>↗</a>
      <div className="bar"><i style={{ left: `${((s.start - start) / total) * 100}%`, width: `${(((s.end ?? s.start) - s.start) / total) * 100}%` }} /></div>
      <div className="dur">{s.kind === "check" ? "" : fmtMs(s.end ? s.end - s.start : undefined)}</div>
    </div>
  );
});

/** An open row's preview, from the span's full record once it's loaded. */
function OpenPreview({ trace, s }: { trace: LiveTrace; s: Span }) {
  useEffect(() => { trace.loadDetail(s); }, [trace, s]);
  const full = trace.details.get(s.span);
  if (s.http && !full && trace.isLoading(s.span)) return <div className="span-preview"><p className="muted">Loading…</p></div>;
  return <div className="span-preview"><Preview span={full ?? s} related={trace.descendantsOf(s.span)} pair={trace.pairOf(s)} /></div>;
}

function TraceSection({ trace, g, onToggle }: { trace: LiveTrace; g: TraceGroup; onToggle: (id: string) => void }) {
  const total = Math.max(g.end - g.start, 1);
  return (
    <section className="trace" data-trace={g.id}>
      <h2>
        <span className="title">{shortUids(g.root.name)}</span>
        <span className="meta"><span className="stats">trace {g.id.slice(0, 8)} · {fmtMs(g.end - g.start)} · {g.spans.length} spans</span> · <a href={logHref(g.root)} target="_blank" rel="noopener" title="Every HTTP exchange in this trace, in a new tab">HTTP log ↗</a></span>
      </h2>
      <div className="rows">
        {g.rows.map(([s, depth]) => {
          const open = trace.open.has(s.span);
          return (
            <div className="item" key={s.span} data-id={s.span}>
              <Row s={s} depth={depth} start={g.start} total={total} paired={trace.isPairedServer(s)} open={open} onToggle={onToggle} />
              {open && <OpenPreview trace={trace} s={s} />}
            </div>
          );
        })}
      </div>
    </section>
  );
}

// A collapse near the bottom would otherwise shorten the page and drag the view with it. The space is given back as you scroll up.
const holdHeight = (el: HTMLElement) => { el.style.minHeight = `${el.offsetHeight}px`; };
function releaseHeight(el: HTMLElement) {
  if (!el.style.minHeight) return;
  const needed = innerHeight - el.getBoundingClientRect().top;
  if (needed < parseFloat(el.style.minHeight)) el.style.minHeight = needed > 0 ? `${needed}px` : "";
}

function storageText(s: Stats) {
  const held = `${s.sessions} sessions, ${s.spans} spans, ${fmtBytes(s.bytes)}.`;
  const limits = `The least recently active sessions are dropped past ${s.limits.sessions} sessions or ${fmtBytes(s.limits.bytes)}, and a session keeps at most ${s.limits.spansPerSession} spans.`;
  return (s.mode === "file" ? `Traces are saved in a SQLite file of their own, ${s.path}, so they survive a restart, including flow runs whose policy is temporary. ` : "Traces are in memory for this run, and a restart loses them. ") + `${limits} Held now: ${held}${s.lastError ? ` Storage problem: ${s.lastError}` : ""}`;
}

function Terms() {
  const [storage, setStorage] = useState("");
  const toggled = (open: boolean) => { if (open) fetch(traceApi("/stats")).then(r => r.json()).then((s: Stats) => setStorage(storageText(s)), () => setStorage("")); };
  return (
    <details className="terms" onToggle={e => toggled(e.currentTarget.open)}>
      <summary>What these terms mean</summary>
      <dl>
        <dt>Session</dt><dd>One run of a flow. Everything it causes shares a session, carried across services in a <code>baggage</code> header.</dd>
        <dt>Trace</dt><dd>One user action: a step. Its ID travels between services in the W3C <code>traceparent</code> header.</dd>
        <dt>Span</dt><dd>One timed piece of work, nested under the work that caused it.</dd>
        <dt>Action</dt><dd>What the user did, with the choices they made.</dd>
        <dt>Client and server</dt><dd>The two sides of one HTTP call. <b>→</b> marks the caller's side. The row nested right under it, marked <b>↳</b>, is the same call as the receiving service saw it. Both are shown because each side records its own headers and timing.</dd>
        <dt>Check</dt><dd>An in-memory decision with no network call, such as one fast-path test or one policy evaluation. Green passed. Amber didn't, which isn't always an error: a failed fast-path test just means the proxy asks.</dd>
        <dt>Preview</dt><dd>A short reading of one span, opened by clicking its row or pressing Enter or Space on it. It shows the fields that matter for that kind of event, such as a token request's grant, or a retrieval's signed context and parts.</dd>
        <dt>Full exchange</dt><dd>One HTTP call's headers and bodies, in a new tab. <b>↗</b> on a row opens it.</dd>
        <dt>HTTP log</dt><dd>Every HTTP call in a trace, in a new tab, each with its full exchange. You can filter it by any text.</dd>
      </dl>
      <p>Text bodies are kept up to 256 KB and binary bodies to 2 KB, with the true size shown. Clicking a row, or scrolling up, turns off <b>Follow newest</b> so the page holds still. Tick it to return to the newest session.</p>
      <p>{storage}</p>
      <p>Tokens, codes, and PKCE verifiers appear only as <code>sha256:</code> prefixes, so you can match them across services without seeing them. Session cookies and client assertion signatures aren't recorded. Orthanc is shown as HTTP calls to it. The S3 bucket and static files are read through a storage client, so they appear as spans without HTTP exchanges.</p>
    </details>
  );
}

export default function Trace() {
  // The session held still on, and the span whose preview is open, are in the address (?session=&span=). With no
  // session, the page follows the newest.
  const [params, setParams] = useSearchParams();
  const asked = params.get("session") ?? "";
  const trace = useLiveTrace(asked);
  const [span, setSpan] = useState(params.get("span"));
  const spanToOpen = useRef(span);
  useEffect(() => { if (asked !== trace.chosen) trace.choose(asked); }, [asked]);
  useEffect(() => {
    const q = new URLSearchParams();
    if (trace.chosen) q.set("session", trace.chosen);
    if (trace.chosen && span) q.set("span", span);
    if (q.toString() !== params.toString()) setParams(q, { replace: true, preventScrollReset: true });
  }, [trace.chosen, span]);
  // A span the address names opens once it has arrived, and is brought into sight.
  useEffect(() => {
    const id = spanToOpen.current;
    if (!id || !trace.spans.has(id)) return;
    spanToOpen.current = null;
    if (!trace.open.has(id)) { trace.stopFollowing(); trace.toggle(id); }
    requestAnimationFrame(() => document.querySelector(`[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "center" }));
  }, [trace.version]);
  useReady(trace.status !== "Connecting…");
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [checks, setChecks] = useState(true);
  const [parts, setParts] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const lastY = useRef(0);
  const groups = useMemo(() => groupsOf(trace, { hidden, checks, parts }), [trace, trace.version, hidden, checks, parts]);
  const active = trace.activeSession();

  // Following, the newest spans stay in view: the end of the list sits at the bottom of the window. A page just
  // opened stays at its top, with the header in sight, until the reader has reached the end once.
  const reachedEnd = useRef(false);
  const toBottom = () => {
    const el = list.current;
    if (!el) return;
    scrollTo(0, Math.max(0, scrollY + el.getBoundingClientRect().bottom - innerHeight));
    lastY.current = scrollY;
  };
  useLayoutEffect(() => { if (trace.follow && reachedEnd.current) toBottom(); });
  useEffect(() => {
    const nearBottom = () => list.current!.getBoundingClientRect().bottom <= innerHeight + 80;
    const scrolled = () => {
      if (nearBottom()) reachedEnd.current = true;
      const movedUp = scrollY < lastY.current - 1;
      lastY.current = scrollY;
      if (movedUp && trace.follow && !nearBottom()) trace.stopFollowing();
      if (list.current) releaseHeight(list.current);
    };
    addEventListener("scroll", scrolled, { passive: true });
    return () => removeEventListener("scroll", scrolled);
  }, [trace]);
  const onToggle = useCallback((id: string) => {
    trace.stopFollowing();
    const closing = trace.open.has(id);
    if (closing && list.current) holdHeight(list.current);
    trace.toggle(id);
    setSpan(was => closing ? (was === id ? null : was) : id);
  }, [trace]);
  // A different session starts with the page as tall as it needs.
  useEffect(() => { if (list.current) list.current.style.minHeight = ""; }, [trace.shown]);

  const clear = () => { if (confirm("Delete every saved trace? This can't be undone.")) trace.clearAll(); };
  return (
    <main className="trace-page">
      <div className="trace-head">
        <div><h1>Live trace</h1><p role="status" className={trace.status === "Live." ? "sr-only" : undefined}>{trace.status}</p></div>
        <div className="trace-controls">
          <label>Session{" "}
            <select value={trace.chosen} onChange={e => { const v = e.target.value; trace.choose(v).then(() => { if (v) scrollTo(0, 0); }); }}>
              <option value="">Newest session, following</option>
              {trace.sessions.map(s => <option key={s.id} value={s.id}>{sessionLabel(s.id)}</option>)}
            </select>
          </label>
          <label><input type="checkbox" checked={trace.follow} onChange={e => trace.setFollow(e.target.checked)} /> Follow newest</label>
          <label title="A line for each check a service made, such as a token's expiry or an assertion's signature"><input type="checkbox" checked={checks} onChange={e => setChecks(e.target.checked)} /> Checks each service made</label>
          <label title="A line for each DICOM part streamed in a retrieval, with its transfer syntax and size"><input type="checkbox" checked={parts} onChange={e => setParts(e.target.checked)} /> Each image part</label>
          <button type="button" onClick={() => trace.togglePause()}>{trace.paused ? "Resume" : "Pause"}</button>
          <LinkToView />
          {active && <a className="action" download href={sessionApi(active, "/export")} title={`Download ${active} as JSON, with its full exchanges`}>Export session</a>}
          {/* Only the site's own trace can be cleared: a sandbox's is kept for everyone using it. */}
          {!BASE && <button type="button" onClick={clear}>Clear traces</button>}
        </div>
      </div>
      <div className="legend">
        {Object.entries(SERVICES).map(([k, [label, color]]) => (
          <label key={k}>
            <input type="checkbox" checked={!hidden.has(k)} onChange={e => setHidden(h => { const n = new Set(h); if (e.target.checked) n.delete(k); else n.add(k); return n; })} />
            <span className="svc" style={{ color: `var(${color})` }}>{label}</span>
          </label>
        ))}
      </div>
      <Terms />
      {!trace.allLoaded && <p className="trace-earlier" role="note">Showing this session's newest {RECENT_TRACES} of its {trace.traceCount} requests. <button type="button" onClick={() => trace.loadAll()}>Load all {trace.traceCount}</button></p>}
      <div id="traces" ref={list}>
        {groups.length ? groups.map(g => <TraceSection key={g.id} trace={trace} g={g} onToggle={onToggle} />)
          : <p className="trace-empty">Nothing yet. Run a flow step in the demo, and it appears here as it happens.</p>}
      </div>
    </main>
  );
}
