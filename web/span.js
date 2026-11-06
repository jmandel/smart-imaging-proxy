// The full view of one exchange. log.js reuses exchangeHtml for each entry in a log.
function headerTable(headers) {
  const rows = Object.entries(headers ?? {});
  return rows.length ? `<table class="head-table"><tbody>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}</tbody></table>` : `<p class="muted">No headers recorded.</p>`;
}
function messageHtml(title, m) {
  if (!m) return `<h2>${esc(title)}</h2><p class="muted">Nothing captured. The call failed, or it hasn't finished.</p>`;
  const cut = m.truncated ? `<p class="note">Showing the first part of ${esc(fmtBytes(m.bytes))}. ${m.encoding === "hex" ? "Binary bodies are kept to 2 KB." : "Text bodies are kept to 256 KB."}</p>` : "";
  const body = !m.body ? `<p class="muted">${m.bytes ? `${esc(fmtBytes(m.bytes))}, not captured.` : "No body."}</p>` : `<pre>${esc(m.encoding === "hex" ? hexDump(m.body) : pretty(m))}</pre>`;
  return `<h2>${esc(title)}${m.bytes ? ` <span class="note">${esc(fmtBytes(m.bytes))}</span>` : ""}</h2>${headerTable(m.headers)}${cut}${body}`;
}
function exchangeHtml(s) {
  const h = s.http;
  const jwts = [];
  const ctx = contextOf(h.url);
  if (ctx) jwts.push(["Signed context in the URL", ctx]);
  const assertion = parseForm(h.request)?.get("client_assertion");
  if (assertion && decodeJwt(assertion)) jwts.push(["Client assertion", decodeJwt(assertion)]);
  return `<p class="line"><b>${esc(h.method)}</b> ${esc(h.url)} → <b>${esc(h.status ?? (s.end ? "no response" : "…"))}</b></p>
    <p class="note">${esc(s.service)}, ${esc(s.kind)} span · ${fmtMs(s.end ? s.end - s.start : undefined)} · trace ${esc(s.trace.slice(0, 8))} · span ${esc(s.span)}</p>
    ${jwts.map(([t, j]) => `<h2>${esc(t)}, decoded</h2><pre>${esc(JSON.stringify(j, null, 2))}</pre>`).join("")}
    ${messageHtml("Request", h.request)}${messageHtml("Response", h.response)}
    ${Object.keys(s.attrs ?? {}).length ? `<h2>Span attributes</h2><pre>${esc(JSON.stringify(s.attrs, null, 2))}</pre>` : ""}`;
}
if (document.getElementById("page")) (async () => {
  const q = new URLSearchParams(location.search);
  const page = document.getElementById("page");
  if (!q.get("session") || !q.get("span")) { page.innerHTML = `<h1>No exchange chosen</h1><p class="muted">This link needs both a session and a span. Open it from a row in the live trace.</p>`; return; }
  const r = await fetch(`/api/sessions/${encodeURIComponent(q.get("session"))}/spans/${encodeURIComponent(q.get("span"))}`);
  if (!r.ok) { page.innerHTML = `<h1>Not found</h1><p class="muted">This exchange is no longer held. The collector keeps recent sessions only.</p>`; return; }
  const s = await r.json();
  document.title = `${s.name} | HTTP Exchange`;
  page.innerHTML = `<h1>${esc(s.name)}</h1><p class="note"><a href="${esc(logHref(s))}">Every exchange in this trace</a></p>${s.http ? exchangeHtml(s) : `<pre>${esc(JSON.stringify(s, null, 2))}</pre>`}`;
})();
