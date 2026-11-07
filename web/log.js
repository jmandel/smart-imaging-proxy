(async () => {
  const q = new URLSearchParams(location.search);
  const session = q.get("session"), trace = q.get("trace");
  if (!session) { document.getElementById("scope").textContent = "Open this page from the HTTP log link on a trace in the live view."; return; }
  document.getElementById("scope").textContent = `Session ${session}${trace ? `, trace ${trace.slice(0, 8)}` : ""}. Both sides of each call appear: the caller's view and the receiver's.`;
  const spans = await (await fetch(`/api/sessions/${encodeURIComponent(session)}/http${trace ? `?trace=${trace}` : ""}`)).json();
  const list = document.getElementById("list"), count = document.getElementById("count");
  const SIDES = { client: "sent by", server: "received by" };
  const summaryHtml = s => `<summary><b>${esc(s.http.method)}</b> ${esc(shortUids(s.name))} → <b>${esc(s.http.status ?? (s.end ? "no response" : "…"))}</b> <span class="side">${esc(SIDES[s.kind] ?? s.kind)} ${esc(s.service)}${s.http.response?.bytes ? `, ${esc(fmtBytes(s.http.response.bytes))}` : ""}</span></summary>`;
  list.innerHTML = spans.map((s, i) => `<details class="exchange" data-i="${i}">${summaryHtml(s)}</details>`).join("") || `<p class="muted">No HTTP exchanges in this trace.</p>`;
  const texts = spans.map(s => JSON.stringify(s).toLowerCase());
  const all = () => [...list.querySelectorAll("details.exchange")];
  // A body can be hundreds of KB, so an entry's detail is only built once it's opened.
  list.addEventListener("toggle", e => {
    const d = e.target;
    if (d.open && !d.dataset.built) { d.dataset.built = "1"; d.insertAdjacentHTML("beforeend", exchangeHtml(spans[d.dataset.i])); }
  }, true);
  const showCount = () => { const n = all().filter(d => !d.hidden).length; count.textContent = `${n} of ${spans.length} shown`; };
  document.getElementById("expand").onclick = () => all().forEach(d => { if (!d.hidden) d.open = true; });
  document.getElementById("collapse").onclick = () => all().forEach(d => { d.open = false; });
  document.getElementById("filter").oninput = e => { const f = e.target.value.toLowerCase(); all().forEach(d => { d.hidden = !!f && !texts[d.dataset.i].includes(f); }); showCount(); };
  showCount();
})();
