// One span's HTTP exchange in full, opened from a row of the live trace in a tab of its own.
import { useEffect, useState } from "react";
import { Exchange } from "../trace/Exchange";
import { logHref, sessionApi, type Span } from "../trace/model";
import { useReady } from "../lib/ready";
import "../trace/trace.css";

type Loaded = { state: "loading" } | { state: "missing" } | { state: "unchosen" } | { state: "shown"; span: Span };

export default function TraceSpan() {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  useEffect(() => {
    const q = new URLSearchParams(location.search), session = q.get("session"), span = q.get("span");
    if (!session || !span) { setLoaded({ state: "unchosen" }); return; }
    let live = true;
    fetch(sessionApi(session, `/spans/${encodeURIComponent(span)}`))
      .then(async r => r.ok ? { state: "shown" as const, span: await r.json() as Span } : { state: "missing" as const }, () => ({ state: "missing" as const }))
      .then(l => {
        if (!live) return;
        setLoaded(l);
        if (l.state === "shown") document.title = `${l.span.name} · HTTP exchange · SMART Imaging`;
      });
    return () => { live = false; };
  }, []);
  useReady(loaded.state !== "loading");
  return (
    <main className="trace-page trace-sub">
      {loaded.state === "loading" && <p className="muted">Loading…</p>}
      {loaded.state === "unchosen" && <><h1>No exchange chosen</h1><p className="muted">This link needs both a session and a span. Open it from a row in the live trace.</p></>}
      {loaded.state === "missing" && <><h1>Not found</h1><p className="muted">This exchange is no longer held. The collector keeps recent sessions only.</p></>}
      {loaded.state === "shown" && <>
        <h1>{loaded.span.name}</h1>
        <p className="note"><a href={logHref(loaded.span)}>Every exchange in this trace</a></p>
        {loaded.span.http ? <Exchange s={loaded.span} /> : <pre>{JSON.stringify(loaded.span, null, 2)}</pre>}
      </>}
    </main>
  );
}
