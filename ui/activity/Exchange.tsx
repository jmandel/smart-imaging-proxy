// The raw exchange behind an event, fetched when its detail opens, and decoded where it helps: a signed link or
// a client assertion as its claims, JSON laid out, a multipart body as its parts' headers.
import { useState } from "react";
import { api, ApiError } from "../lib/api";
import { jwt, multipartHeaders, type LogEvent } from "../lib/event-words";
import { bytes, plural } from "../lib/format";

interface Message { headers?: Record<string, string>; body?: string; encoding?: string; bytes?: number; truncated?: boolean }
interface Span { session: string; span: string; attrs?: Record<string, unknown>; http?: { method: string; url: string; status?: number; request?: Message; response?: Message } }

const Pretty = ({ value }: { value: unknown }) => <pre>{JSON.stringify(value, null, 2)}</pre>;
const Headers = ({ h }: { h?: Record<string, string> }) => <pre>{Object.entries(h ?? {}).map(([k, v]) => `${k}: ${v}`).join("\n")}</pre>;

function Body({ m }: { m?: Message }) {
  if (!m) return <p className="note">Nothing captured.</p>;
  if (!m.body) return <p className="note">{m.bytes ? `${bytes(m.bytes)}, not captured` : "No body"}.</p>;
  const type = m.headers?.["content-type"] ?? "";
  if (m.encoding === "hex") {
    const parts = multipartHeaders(m.body, type);
    if (!parts) return <p className="note">{bytes(m.bytes)} of binary data.</p>;
    return <>
      <p className="note">{bytes(m.bytes)} in all. The first {bytes(m.body.length / 2)} hold {plural(parts.length, "part")}:</p>
      {parts.map((p, i) => <div className="part" key={i}><b>Part {i + 1}</b><pre>{p}</pre></div>)}
    </>;
  }
  let shown = m.body;
  if (/json/.test(type)) { try { shown = JSON.stringify(JSON.parse(m.body), null, 2); } catch { /* As it came. */ } }
  const assertion = /x-www-form-urlencoded/.test(type) ? new URLSearchParams(m.body).get("client_assertion") : null;
  const decoded = assertion ? jwt(assertion) : undefined;
  return <>
    {decoded && <><h4>Client assertion, decoded</h4><Pretty value={decoded} /></>}
    <pre>{shown}</pre>
    {m.truncated && <p className="note">The first part of {bytes(m.bytes)}.</p>}
  </>;
}

function Shown({ s, traceUrl }: { s: Span; traceUrl?: string }) {
  if (!s.http) return <>
    <p className="note">This step made no HTTP exchange of its own.</p>
    {Object.keys(s.attrs ?? {}).length > 0 && <Pretty value={s.attrs} />}
  </>;
  const ctx = s.http.url.match(/\/wado\/([^/]+)\//)?.[1];
  const link = ctx && ctx !== "-" ? jwt(ctx) : undefined;
  return <>
    <p><b>{s.http.method}</b> <code>{s.http.url}</code> → <b>{s.http.status ?? "…"}</b></p>
    {link && <><h4>Signed link, decoded</h4><Pretty value={link} /></>}
    <h4>Request</h4><Headers h={s.http.request?.headers} />{s.http.request?.body && <Body m={s.http.request} />}
    <h4>Response</h4><Headers h={s.http.response?.headers} /><Body m={s.http.response} />
    {traceUrl && <p><a href={`${traceUrl}/span.html?session=${encodeURIComponent(s.session)}&span=${encodeURIComponent(s.span)}`}>Open in the live trace</a></p>}
  </>;
}

/** "The exchange", closed until someone opens it. */
export function Exchange({ e, traceUrl }: { e: LogEvent; traceUrl?: string }) {
  const [span, setSpan] = useState<Span | string>();
  const load = async () => {
    if (span) return;
    try { setSpan(await api<Span>("GET", `/api/activity/span?session=${encodeURIComponent(e.session)}&span=${encodeURIComponent(e.span!)}`)); }
    catch (err) { setSpan(err instanceof ApiError && err.status === 404 ? "This exchange isn't kept any more." : (err as Error).message); }
  };
  return (
    <details data-exchange={e.seq} onToggle={x => { if ((x.target as HTMLDetailsElement).open) load(); }}>
      <summary>The exchange</summary>
      <div className="raw">{!span ? <p className="note">Loading…</p> : typeof span === "string" ? <p className="note">{span}</p> : <Shown s={span} traceUrl={traceUrl} />}</div>
    </details>
  );
}
