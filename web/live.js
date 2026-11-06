const SERVICES = { user: ["user", "--user"], app: ["app", "--app"], "authorization-server": ["auth", "--as"], "imaging-fhir": ["imaging", "--fhir"], policy: ["policy", "--policy"], "dicomweb-proxy": ["proxy", "--proxy"], backend: ["backend", "--backend"], demo: ["expected", "--demo"] };
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const spans = new Map();
const hidden = new Set();
const open = new Set();
let session = new URLSearchParams(location.search).get("session") ?? "", paused = false, pending = false, sessions = [], es;

$("#legend").innerHTML = Object.entries(SERVICES).map(([k, [label, color]]) => `<label><input type="checkbox" data-svc="${k}" checked><span class="svc" style="color:var(${color})">${label}</span></label>`).join("");
$("#legend").addEventListener("change", e => { const k = e.target.dataset.svc; if (e.target.checked) hidden.delete(k); else hidden.add(k); schedule(); });
$("#checks").onchange = schedule; $("#parts").onchange = schedule;
$("#pause").onclick = () => { paused = !paused; $("#pause").textContent = paused ? "Resume" : "Pause"; if (!paused) schedule(); };
$("#session").onchange = e => { session = e.target.value; loadSession(); };
$("#traces").addEventListener("click", e => { const r = e.target.closest(".row"); if (!r) return; const id = r.dataset.id; if (open.has(id)) open.delete(id); else open.add(id); schedule(); });

function renderSessions() {
  const sel = $("#session");
  sel.innerHTML = `<option value="">Newest session, following</option>` + sessions.map(s => `<option value="${esc(s.id)}" ${s.id === session ? "selected" : ""}>${esc(s.id)}</option>`).join("");
}
async function loadSession() {
  spans.clear();
  const id = session || sessions[0]?.id;
  if (id) for (const s of await (await fetch(`/api/sessions/${encodeURIComponent(id)}/spans`)).json()) spans.set(s.span, s);
  schedule();
}
function activeSession() { return session || sessions[0]?.id; }
function connect() {
  es = new EventSource("/stream");
  es.addEventListener("hello", async e => { sessions = JSON.parse(e.data); renderSessions(); await loadSession(); $("#state").textContent = "Live."; });
  es.addEventListener("session", e => { const s = JSON.parse(e.data); sessions.unshift(s); renderSessions(); if (!session) { spans.clear(); } });
  es.addEventListener("span", e => { const s = JSON.parse(e.data); if (s.session === activeSession()) { spans.set(s.span, s); schedule(); } const m = sessions.find(x => x.id === s.session); if (m && sessions[0] !== m && !session) { sessions = [m, ...sessions.filter(x => x !== m)]; renderSessions(); spans.clear(); loadSession(); } });
  es.onerror = () => { $("#state").textContent = "Disconnected. Reconnecting…"; };
}
function schedule() { if (paused || pending) return; pending = true; requestAnimationFrame(() => { pending = false; render(); }); }
const fmt = ms => ms === undefined ? "…" : ms < 10 ? `${ms.toFixed(1)} ms` : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
function visible(s) {
  if (hidden.has(s.service)) return false;
  if (s.kind === "check" && !$("#checks").checked) return false;
  if (/^part \d+:/.test(s.name) && !$("#parts").checked) return false;
  return true;
}
function render() {
  const byTrace = new Map();
  for (const s of spans.values()) { if (!byTrace.has(s.trace)) byTrace.set(s.trace, []); byTrace.get(s.trace).push(s); }
  const traces = [...byTrace.values()].map(list => ({ list: list.sort((a, b) => a.start - b.start), start: Math.min(...list.map(s => s.start)) })).sort((a, b) => a.start - b.start);
  const parts = traces.map(({ list, start }) => {
    const end = Math.max(...list.map(s => s.end ?? s.start));
    const total = Math.max(end - start, 1);
    const ids = new Set(list.map(s => s.span));
    const kids = new Map();
    for (const s of list) { const k = ids.has(s.parent) ? s.parent : "root"; if (!kids.has(k)) kids.set(k, []); kids.get(k).push(s); }
    const rows = [];
    const walk = (s, depth) => {
      if (visible(s)) rows.push(row(s, depth, start, total));
      for (const c of kids.get(s.span) ?? []) walk(c, visible(s) ? depth + 1 : depth);
    };
    for (const r of kids.get("root") ?? []) walk(r, 0);
    const root = list.find(s => s.kind === "action") ?? list[0];
    return `<section class="trace"><h2>${esc(root.name)}<span class="meta">trace ${root.trace.slice(0, 8)} · ${fmt(end - start)} · ${list.length} spans</span></h2>${rows.join("")}</section>`;
  });
  $("#traces").innerHTML = parts.join("") || `<p class="empty">Nothing yet. Run a flow step in the demo, and it appears here as it happens.</p>`;
  if ($("#follow").checked) window.scrollTo(0, document.body.scrollHeight);
}
function row(s, depth, start, total) {
  const [label, color] = SERVICES[s.service] ?? [s.service, "--muted"];
  const left = ((s.start - start) / total) * 100, width = (((s.end ?? s.start) - s.start) / total) * 100;
  const st = s.end ? s.status : "running";
  const mark = { ok: "✓", denied: "!", error: "✗", running: "…" }[st] ?? "·";
  const main = `<div class="row ${s.kind}" data-id="${s.span}" title="${esc(s.name)}"><div class="name" style="padding-left:${depth * 14}px"><span class="dot ${st}" aria-label="${st}">${mark}</span><span class="svc" style="color:var(${color})">${label}</span><span class="label">${esc(s.name)}</span></div><div class="bar"><i style="left:${left}%;width:${width}%"></i></div><div class="dur">${s.kind === "check" ? "" : fmt(s.end ? s.end - s.start : undefined)}</div></div>`;
  return main + (open.has(s.span) ? `<div class="attrs">${esc(JSON.stringify({ ...s.attrs, kind: s.kind, service: s.service, status: st }, null, 1))}</div>` : "");
}
connect();
