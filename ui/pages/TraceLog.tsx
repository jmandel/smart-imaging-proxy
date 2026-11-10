// Every HTTP exchange in one trace, from both sides of each call, opened from the live trace in a tab of its own.
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { useReady } from "../lib/ready";
import { Exchange } from "../trace/Exchange";
import { fmtBytes, sessionApi, shortUids, type Span } from "../trace/model";
import "../trace/trace.css";

const SIDES: Record<string, string> = { client: "sent by", server: "received by" };

function Entry({ s, open, hidden, toggled }: { s: Span; open: boolean; hidden: boolean; toggled: (open: boolean) => void }) {
  const h = s.http!;
  return (
    <details className="exchange" open={open} hidden={hidden} onToggle={e => { if (e.currentTarget.open !== open) toggled(e.currentTarget.open); }}>
      <summary>
        <b>{h.method}</b> {shortUids(s.name.startsWith(`${h.method} `) ? s.name.slice(h.method.length + 1) : s.name)} → <b>{h.status ?? (s.end ? "no response" : "…")}</b>{" "}
        <span className="side">{SIDES[s.kind] ?? s.kind} {s.service}{h.response?.bytes ? `, ${fmtBytes(h.response.bytes)}` : ""}</span>
      </summary>
      {/* A body can be hundreds of KB, so an entry's detail is only drawn while it's open. */}
      {open && <Exchange s={s} />}
    </details>
  );
}

export default function TraceLog() {
  // The filter is in the address with the trace (?filter=), kept in place as it's typed.
  const [q, setQ] = useSearchParams(), session = q.get("session"), trace = q.get("trace"), filter = q.get("filter") ?? "";
  const setFilter = (text: string) => setQ(p => { const n = new URLSearchParams(p); if (text) n.set("filter", text); else n.delete("filter"); return n; }, { replace: true });
  const [spans, setSpans] = useState<Span[]>();
  const [failed, setFailed] = useState(false);
  const [opened, setOpened] = useState<ReadonlySet<number>>(new Set());
  useEffect(() => {
    if (!session) return;
    let live = true;
    fetch(sessionApi(session, `/http${trace ? `?trace=${encodeURIComponent(trace)}` : ""}`))
      .then(r => r.ok ? r.json() : Promise.reject())
      .then((list: Span[]) => { if (live) setSpans(list); }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [session, trace]);
  const texts = useMemo(() => spans?.map(s => JSON.stringify(s).toLowerCase()) ?? [], [spans]);
  const f = filter.toLowerCase();
  const shown = (i: number) => !f || texts[i]!.includes(f);
  const count = spans ? spans.filter((_, i) => shown(i)).length : 0;
  useReady(!session || failed || !!spans);
  const toggle = (i: number, open: boolean) => setOpened(o => { const n = new Set(o); if (open) n.add(i); else n.delete(i); return n; });

  if (!session) return <main className="trace-page trace-sub"><h1>HTTP log</h1><p className="note">Open this page from the HTTP log link on a trace in the live view.</p></main>;
  return (
    <main className="trace-page trace-sub">
      <h1>HTTP log</h1>
      <p className="note">Session {session}{trace ? `, trace ${trace.slice(0, 8)}` : ""}. Both sides of each call appear: the caller's view and the receiver's.</p>
      <div className="toolbar">
        <button type="button" onClick={() => setOpened(new Set(spans?.map((_, i) => i).filter(shown)))}>Expand all</button>
        <button type="button" onClick={() => setOpened(new Set())}>Collapse all</button>
        <label>Filter <input type="search" placeholder="Path, service, or text" value={filter} onChange={e => setFilter(e.target.value)} /></label>
        <span className="note" role="status">{spans ? `${count} of ${spans.length} shown` : ""}</span>
      </div>
      {failed ? <p className="muted">Couldn't load this trace's exchanges. The collector keeps recent sessions only.</p>
        : !spans ? <p className="muted">Loading…</p>
        : !spans.length ? <p className="muted">No HTTP exchanges in this trace.</p>
        : spans.map((s, i) => <Entry key={s.span + s.kind} s={s} open={opened.has(i)} hidden={!shown(i)} toggled={open => toggle(i, open)} />)}
    </main>
  );
}
