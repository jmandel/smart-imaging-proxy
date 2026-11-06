const SERVICES = { user: ["user", "--user"], app: ["app", "--app"], "authorization-server": ["auth", "--as"], "imaging-fhir": ["imaging", "--fhir"], policy: ["policy", "--policy"], "dicomweb-proxy": ["proxy", "--proxy"], backend: ["backend", "--backend"], demo: ["expected", "--demo"] };
const UNATTRIBUTED = "unattributed";
const $ = s => document.querySelector(s);
const spans = new Map();
const hidden = new Set();
const open = new Set();
const details = new Map();
const loading = new Set();
const main = $("#traces");
const items = new Map();
const sections = new Map();
const waiting = [];
let session = new URLSearchParams(location.search).get("session") ?? "", shown, loadTicket = 0, paused = false, pending = false, sessions = [], lastY = 0, kids;

if (session) $("#follow").checked = false;
$("#legend").innerHTML = Object.entries(SERVICES).map(([k, [label, color]]) => `<label><input type="checkbox" data-svc="${k}" checked><span class="svc" style="color:var(${color})">${label}</span></label>`).join("");
$("#legend").addEventListener("change", e => { const k = e.target.dataset.svc; if (e.target.checked) hidden.delete(k); else hidden.add(k); schedule(); });
$("#checks").onchange = schedule; $("#parts").onchange = schedule;
$("#pause").onclick = () => {
  paused = !paused;
  $("#pause").textContent = paused ? "Resume" : "Pause";
  if (!paused) for (const replay of waiting.splice(0)) replay();
  showState();
};
$("#session").onchange = e => {
  session = e.target.value;
  $("#follow").checked = !session;
  loadSession().then(() => { if (session) scrollTo(0, 0); });
};
$("#follow").onchange = () => { if ($("#follow").checked) { session = ""; renderSessions(); loadSession().then(toBottom); } else holdSession(); };

// Reading something stops the page from moving under you.
const holdSession = () => { if (!session) { session = activeSession() ?? ""; renderSessions(); } };
const stopFollowing = () => { if ($("#follow").checked) { $("#follow").checked = false; holdSession(); } };
const nearBottom = () => innerHeight + scrollY >= document.body.scrollHeight - 80;
addEventListener("scroll", () => {
  const movedUp = scrollY < lastY - 1;
  lastY = scrollY;
  if (movedUp && $("#follow").checked && !nearBottom()) stopFollowing();
  releaseHeight();
}, { passive: true });
const toBottom = () => { scrollTo(0, document.body.scrollHeight); lastY = scrollY; };
// A collapse near the bottom would otherwise shorten the page and drag the view with it. The space is given back as you scroll up.
const holdHeight = () => { main.style.minHeight = `${main.offsetHeight}px`; };
const releaseHeight = () => {
  if (!main.style.minHeight) return;
  const needed = scrollY + innerHeight - (main.getBoundingClientRect().top + scrollY);
  if (needed < parseFloat(main.style.minHeight)) main.style.minHeight = needed > 0 ? `${needed}px` : "";
};

main.addEventListener("click", e => {
  if (e.target.closest("a, summary, .preview") || !getSelection().isCollapsed) return;
  const r = e.target.closest(".row");
  if (r) toggle(r.parentElement);
});
main.addEventListener("keydown", e => {
  if ((e.key === "Enter" || e.key === " ") && e.target.classList.contains("name")) { e.preventDefault(); toggle(e.target.closest(".item")); }
});
function toggle(item) {
  const id = item.dataset.id;
  stopFollowing();
  const name = item.querySelector(".name");
  if (open.has(id)) { holdHeight(); open.delete(id); item.querySelector(".preview")?.remove(); name.setAttribute("aria-expanded", "false"); return; }
  open.add(id);
  name.setAttribute("aria-expanded", "true");
  showPreview(item);
}
const kidsOf = id => {
  if (!kids) { kids = new Map(); for (const s of spans.values()) if (s.parent) { if (!kids.has(s.parent)) kids.set(s.parent, []); kids.get(s.parent).push(s); } }
  return kids.get(id) ?? [];
};
const descendantsOf = id => { const out = []; const walk = i => { for (const c of kidsOf(i)) { out.push(c); walk(c.span); } }; walk(id); return out; };
const isPairedServer = s => s.kind === "server" && !!s.http && spans.get(s.parent)?.kind === "client" && !!spans.get(s.parent)?.http;
function pairOf(s) {
  const label = x => SERVICES[x.service]?.[0] ?? x.service;
  if (isPairedServer(s)) return { label: label(s), isClient: false };
  const child = s.kind === "client" && s.http ? kidsOf(s.span).find(isPairedServer) : undefined;
  return child ? { label: label(child), isClient: true } : undefined;
}
async function showPreview(item) {
  const id = item.dataset.id, s = spans.get(id);
  if (!s || !open.has(id)) return;
  let box = item.querySelector(".preview");
  if (!box) { box = document.createElement("div"); box.className = "preview"; item.append(box); }
  if (s.http && (details.get(id)?.seq ?? -1) < (s.seq ?? 0) && !loading.has(id)) {
    if (!box.innerHTML) box.innerHTML = `<p class="muted">Loading…</p>`;
    loading.add(id);
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(s.session)}/spans/${id}`);
      if (r.ok) details.set(id, await r.json());
    } catch { /* The summary below still shows what's known. */ }
    loading.delete(id);
    if (!open.has(id)) return;
  }
  const html = preview(details.get(id) ?? s, descendantsOf(id), pairOf(s));
  if (box.dataset.html === html) return;
  // Only a real change touches the DOM, so a selection in an unchanged preview survives.
  const opened = [...box.querySelectorAll("details")].map(d => d.open);
  box.dataset.html = html;
  box.innerHTML = html;
  box.querySelectorAll("details").forEach((d, i) => { d.open = !!opened[i]; });
}

function sessionLabel(id) { return id === UNATTRIBUTED ? "Calls outside any flow" : id; }
function renderSessions() {
  const sel = $("#session");
  sel.innerHTML = `<option value="">Newest session, following</option>` + sessions.map(s => `<option value="${esc(s.id)}">${esc(sessionLabel(s.id))}</option>`).join("");
  sel.value = session;
}
/** Merges by sequence number, so an older snapshot can't undo a newer live event. */
const keep = s => { const was = spans.get(s.span); if (!was || (s.seq ?? 0) >= (was.seq ?? 0)) { spans.set(s.span, s); kids = undefined; } };
async function loadSession() {
  const id = activeSession(), ticket = ++loadTicket;
  if (id !== shown) { shown = id; clearShown(); }
  showExport();
  if (id) {
    try {
      const list = await (await fetch(`/api/sessions/${encodeURIComponent(id)}/spans`)).json();
      if (ticket !== loadTicket) return;
      for (const s of list) keep(s);
    } catch { $("#state").textContent = "Couldn't load that session."; }
  }
  schedule();
}
// Newest flow, by activity. Calls with no flow don't take over the view while a flow is running.
function activeSession() { return session || (sessions.find(s => s.id !== UNATTRIBUTED) ?? sessions[0])?.id; }
function showState() { $("#state").textContent = paused ? `Paused. ${waiting.length} updates waiting.` : "Live."; }
const clearShown = () => { spans.clear(); kids = undefined; items.clear(); sections.clear(); main.replaceChildren(); main.style.minHeight = ""; };
function showExport() {
  const id = activeSession(), a = $("#export");
  a.hidden = !id;
  if (id) { setAttr(a, "href", `/api/sessions/${encodeURIComponent(id)}/export`); setAttr(a, "title", `Download ${id} as JSON, with its full exchanges`); }
}
async function showStorage() {
  try {
    const s = await (await fetch("/api/stats")).json();
    const held = `${s.sessions} sessions, ${s.spans} spans, ${fmtBytes(s.bytes)}.`;
    const limits = `The least recently active sessions are dropped past ${s.limits.sessions} sessions or ${fmtBytes(s.limits.bytes)}, and a session keeps at most ${s.limits.spansPerSession} spans.`;
    $("#storage").textContent = (s.mode === "file" ? `Traces are saved in a SQLite file of their own, ${s.path}, so they survive a restart, including flow runs whose policy is temporary. ` : "Traces are in memory for this run, and a restart loses them. ") + `${limits} Held now: ${held}${s.lastError ? ` Storage problem: ${s.lastError}` : ""}`;
  } catch { $("#storage").textContent = ""; }
}
document.querySelector(".terms").addEventListener("toggle", e => { if (e.target.open) showStorage(); });
$("#clear").onclick = async () => {
  if (!confirm("Delete every saved trace? This can't be undone.")) return;
  const r = await fetch("/api/sessions", { method: "DELETE" }).catch(() => undefined);
  if (!r?.ok) $("#state").textContent = "Couldn't clear the traces.";
};
/** While paused, live events wait in order. Controls keep working on what's already shown. */
const live = handler => e => {
  const data = JSON.parse(e.data);
  if (paused) { waiting.push(() => handler(data)); showState(); return; }
  handler(data);
};
function connect() {
  const es = new EventSource("/stream");
  es.addEventListener("hello", live(async list => { sessions = list; renderSessions(); await loadSession(); showState(); }));
  es.addEventListener("session", live(s => {
    if (!sessions.some(x => x.id === s.id)) sessions.unshift(s);
    renderSessions();
    if (!session) loadSession();
  }));
  es.addEventListener("cleared", live(() => { sessions = []; session = ""; shown = undefined; loadTicket++; clearShown(); details.clear(); open.clear(); $("#follow").checked = true; renderSessions(); showExport(); schedule(); showStorage(); }));
  es.addEventListener("removed", live(ids => {
    sessions = sessions.filter(s => !ids.includes(s.id));
    if (ids.includes(session)) session = "";
    renderSessions();
    if (ids.includes(shown)) { $("#follow").checked = !session; loadSession(); }
  }));
  es.addEventListener("span", live(s => {
    const m = sessions.find(x => x.id === s.session);
    if (m && sessions[0] !== m && s.session !== UNATTRIBUTED) {
      sessions = [m, ...sessions.filter(x => x !== m)];
      if (!session) { renderSessions(); loadSession(); return; }
    }
    if (s.session === activeSession()) { keep(s); schedule(); }
  }));
  es.onerror = () => { $("#state").textContent = "Disconnected. Reconnecting…"; };
}
function schedule() { if (pending) return; pending = true; requestAnimationFrame(() => { pending = false; render(); }); }
function visible(s) {
  if (hidden.has(s.service)) return false;
  if (s.kind === "check" && !$("#checks").checked) return false;
  if (/^part \d+:/.test(s.name) && !$("#parts").checked) return false;
  return true;
}
const setText = (el, text) => { if (el.textContent !== text) el.textContent = text; };
const setAttr = (el, name, value) => { if (el.getAttribute(name) !== value) el.setAttribute(name, value); };

/** Keeps every element in place and changes only what changed, so scrolling, focus, clicks, and selection survive. */
function render() {
  const byTrace = new Map();
  for (const s of spans.values()) { if (!byTrace.has(s.trace)) byTrace.set(s.trace, []); byTrace.get(s.trace).push(s); }
  const traces = [...byTrace.entries()].map(([id, list]) => ({ id, list: list.sort((a, b) => a.start - b.start), start: Math.min(...list.map(s => s.start)) })).sort((a, b) => a.start - b.start);
  main.querySelector(".empty")?.remove();
  const keepTraces = new Set(traces.map(t => t.id));
  for (const [id, sec] of sections) if (!keepTraces.has(id)) { sec.remove(); sections.delete(id); }
  traces.forEach(({ id, list, start }, i) => {
    let sec = sections.get(id);
    if (!sec) { sec = traceSection(id); sections.set(id, sec); }
    if (main.children[i] !== sec) main.insertBefore(sec, main.children[i] ?? null);
    const end = Math.max(...list.map(s => s.end ?? s.start));
    const total = Math.max(end - start, 1);
    const root = list.find(s => s.kind === "action") ?? list[0];
    setText(sec.querySelector(".title"), shortUids(root.name));
    setText(sec.querySelector(".stats"), `trace ${id.slice(0, 8)} · ${fmtMs(end - start)} · ${list.length} spans`);
    setAttr(sec.querySelector(".meta a"), "href", logHref(root));
    const ids = new Set(list.map(s => s.span));
    const children = new Map();
    for (const s of list) { const k = ids.has(s.parent) ? s.parent : "root"; if (!children.has(k)) children.set(k, []); children.get(k).push(s); }
    const wanted = [];
    const walk = (s, depth) => { if (visible(s)) wanted.push([s, depth]); for (const c of children.get(s.span) ?? []) walk(c, visible(s) ? depth + 1 : depth); };
    for (const r of children.get("root") ?? []) walk(r, 0);
    const rows = sec.lastElementChild;
    const want = new Set(wanted.map(([s]) => s.span));
    for (const it of [...rows.children]) if (!want.has(it.dataset.id)) { items.delete(it.dataset.id); it.remove(); }
    wanted.forEach(([s, depth], n) => {
      let item = items.get(s.span);
      if (!item) { item = newItem(s.span); items.set(s.span, item); }
      if (rows.children[n] !== item) rows.insertBefore(item, rows.children[n] ?? null);
      paintRow(item, s, depth, start, total);
      if (open.has(s.span)) showPreview(item);
    });
  });
  if (!main.children.length) main.innerHTML = `<p class="empty">Nothing yet. Run a flow step in the demo, and it appears here as it happens.</p>`;
  if ($("#follow").checked) toBottom();
}
function traceSection(id) {
  const sec = document.createElement("section");
  sec.className = "trace";
  sec.dataset.trace = id;
  sec.innerHTML = `<h2><span class="title"></span><span class="meta"><span class="stats"></span> · <a target="_blank" rel="noopener" title="Every HTTP exchange in this trace, in a new tab">HTTP log ↗</a></span></h2><div class="rows"></div>`;
  return sec;
}
function newItem(id) {
  const item = document.createElement("div");
  item.className = "item";
  item.dataset.id = id;
  item.innerHTML = `<div class="row"><div class="name" role="button" tabindex="0" aria-expanded="${open.has(id)}"><span class="dot"></span><span class="svc"></span><span class="via"></span><span class="label"></span><span class="hint"></span></div><a class="full" target="_blank" rel="noopener" title="Open full request and response in a new tab" aria-label="Open full request and response in a new tab" hidden>↗</a><div class="bar"><i></i></div><div class="dur"></div></div>`;
  return item;
}
const hintFor = s => {
  if (!s.http) return "";
  let target = "";
  if (s.kind === "client") { try { target = `${s.http.method} ${shortUids(new URL(s.http.url).pathname.replace(/\/wado\/[^/]+/, "/wado/{ctx}"))} · `; } catch { target = ""; } }
  const outcome = s.http.status ?? (s.end ? "no response" : "");
  return `${target}${outcome}${s.http.bytes ? ` · ${fmtBytes(s.http.bytes)}` : ""}`;
};
function paintRow(item, s, depth, start, total) {
  const row = item.firstElementChild;
  const [name, full, bar, dur] = row.children;
  const [dot, svc, via, label, hint] = name.children;
  const [text, color] = SERVICES[s.service] ?? [s.service, "--muted"];
  const st = s.end ? s.status : "running";
  const paired = isPairedServer(s);
  setAttr(row, "class", `row ${s.kind}${paired ? " paired" : ""}`);
  setAttr(name, "style", `padding-left:${depth * 14}px`);
  setAttr(name, "title", s.name);
  setAttr(dot, "class", `dot ${st}`);
  setAttr(dot, "aria-label", st ?? "");
  setText(dot, { ok: "✓", denied: "!", error: "✗", running: "…" }[st] ?? "·");
  setAttr(svc, "style", `color:var(${color})`);
  setText(svc, text);
  setText(via, paired ? "↳" : s.kind === "client" && s.http ? "→" : "");
  setAttr(via, "title", paired ? "The same call as the row above, as it was received" : s.kind === "client" && s.http ? "The caller's side of an HTTP call" : "");
  setText(label, shortUids(s.name));
  setText(hint, hintFor(s));
  if (s.http) { setAttr(full, "href", fullHref(s)); full.hidden = false; } else full.hidden = true;
  setAttr(bar.firstElementChild, "style", `left:${((s.start - start) / total) * 100}%;width:${(((s.end ?? s.start) - s.start) / total) * 100}%`);
  setText(dur, s.kind === "check" ? "" : fmtMs(s.end ? s.end - s.start : undefined));
}
connect();
