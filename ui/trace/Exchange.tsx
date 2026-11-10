// One HTTP exchange in full: its request and response, headers and bodies, with any JWT it carries decoded. The
// span page shows one; the HTTP log shows one inside each entry it opens.
import { contextOf, decodeJwt, fmtBytes, fmtMs, hexDump, parseForm, pretty, type Message, type Span } from "./model";

function HeaderTable({ headers }: { headers: Record<string, string> | undefined }) {
  const rows = Object.entries(headers ?? {});
  if (!rows.length) return <p className="muted">No headers recorded.</p>;
  return <table className="head-table"><tbody>{rows.map(([k, v]) => <tr key={k}><td>{k}</td><td>{v}</td></tr>)}</tbody></table>;
}

function MessageView({ title, m }: { title: string; m: Message | undefined }) {
  if (!m) return <><h2>{title}</h2><p className="muted">Nothing captured. The call failed, or it hasn't finished.</p></>;
  return (
    <>
      <h2>{title}{m.bytes ? <> <span className="note">{fmtBytes(m.bytes)}</span></> : null}</h2>
      <HeaderTable headers={m.headers} />
      {m.truncated && <p className="note">Showing the first part of {fmtBytes(m.bytes)}. {m.encoding === "hex" ? "Binary bodies are kept to 2 KB." : "Text bodies are kept to 256 KB."}</p>}
      {m.body ? <pre>{m.encoding === "hex" ? hexDump(m.body) : pretty(m)}</pre> : <p className="muted">{m.bytes ? `${fmtBytes(m.bytes)}, not captured.` : "No body."}</p>}
    </>
  );
}

/** A span with an HTTP exchange, as both its messages were captured. */
export function Exchange({ s }: { s: Span }) {
  const h = s.http!;
  const jwts: [string, unknown][] = [];
  const ctx = contextOf(h.url);
  if (ctx) jwts.push(["Signed context in the URL", ctx]);
  const assertion = decodeJwt(parseForm(h.request)?.get("client_assertion"));
  if (assertion) jwts.push(["Client assertion", assertion]);
  return (
    <>
      <p className="exchange-line"><b>{h.method}</b> {h.url} → <b>{h.status ?? (s.end ? "no response" : "…")}</b></p>
      <p className="note">{s.service}, {s.kind} span · {fmtMs(s.end ? s.end - s.start : undefined)} · trace {s.trace.slice(0, 8)} · span {s.span}</p>
      {jwts.map(([t, j]) => <div key={t}><h2>{t}, decoded</h2><pre>{JSON.stringify(j, null, 2)}</pre></div>)}
      <MessageView title="Request" m={h.request} />
      <MessageView title="Response" m={h.response} />
      {Object.keys(s.attrs ?? {}).length > 0 && <><h2>Span attributes</h2><pre>{JSON.stringify(s.attrs, null, 2)}</pre></>}
    </>
  );
}
