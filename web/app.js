const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const api = async (path, opts) => { const r = await fetch(path, opts); const b = await r.json(); if (!r.ok) throw new Error(b.error ?? r.statusText); return b; };
const post = (path, body) => api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });

let flows = [], services = {}, current = null, stepsDone = {}, flowStatus = {};
const BADGE = { instant: "instant: no network call", asked: "asked can_i", cached: "cached decision" };

function showStore(store) {
  const b = $("#store-badge");
  b.textContent = store.label;
  b.className = `store-badge ${store.active}`;
  const t = $("#policy-store");
  if (t) t.textContent = store.label;
  $("#back-to-saved").hidden = store.active === "saved";
}
async function backToSaved() {
  const status = await post("/api/admin/store/activate", { store: "saved" });
  showStore(status.store);
  current = null;
  renderNav();
  renderIntro(services);
}
async function init() {
  const data = await api("/api/flows");
  flows = data.flows;
  services = data.services;
  $("#back-to-saved").onclick = backToSaved;
  showStore(data.store);
  renderNav();
  renderIntro(data.services);
  // A flow in progress comes back as it was. Loading this page changes nothing on the server.
  const state = await api("/api/flow-state");
  if (state.flow && state.store.active === "scratch") restoreFlow(state);
  const b = await api("/api/backends");
  const sel = $("#backend");
  sel.innerHTML = b.backends.map(x => `<option value="${x.name}" ${x.name === b.current ? "selected" : ""}>${x.name}${x.ok ? "" : " (unavailable)"}</option>`).join("");
  sel.onchange = async () => { await post("/api/backend", { backend: sel.value }); if (current) openFlow(current.id); showBackend(b); };
  showBackend(b);
}
function showBackend(b) {
  const x = b.backends.find(n => n.name === $("#backend").value);
  $("#backend-status").textContent = x ? `${x.capabilities.selection}${x.capabilities.hasManifest ? ", manifest" : ""}` : "";
  $("#backend-status").title = x ? x.capabilities.notes.join(" ") : "";
}
function renderNav() {
  const item = f => `<button data-id="${f.id}" class="${current?.id === f.id ? "active" : ""}"><span class="n">${f.number}</span><span>${esc(f.title)}</span>${flowStatus[f.id] === true ? '<span class="done" aria-label="passed">✓</span>' : flowStatus[f.id] === false ? '<span class="failed" aria-label="failed">✗</span>' : ""}</button>`;
  const nav = $("#flow-list");
  nav.innerHTML = `<h2>Policy flows</h2>${flows.filter(f => f.group === "policy").map(item).join("")}<h2>Protocol flows</h2>${flows.filter(f => f.group === "protocol").map(item).join("")}<button id="run-all" class="secondary">Run every flow</button>`;
  nav.querySelectorAll("button[data-id]").forEach(b => b.onclick = () => openFlow(b.dataset.id));
  $("#run-all").onclick = runEvery;
}
function renderIntro(services) {
  document.querySelector(".live-link").href = services["live trace"];
  $("#main").innerHTML = `<section class="intro"><h2>How this works</h2>
  <p>An app gets a signed URL from the Imaging Server's search. The proxy in front of the image store either answers from that URL, instantly, or asks the Imaging Server. It holds a public key and no policy.</p>
  <div class="grid">
    <div class="card"><h3>Instant</h3>The signature, expiry, study and token hash all check out. No network call.</div>
    <div class="card"><h3>Asked <code>can_i</code></h3>Anything else: a refreshed token, a separate client, an expired context. It's an <a href="https://openid.net/specs/authorization-api-1_0.html">AuthZEN</a> evaluation.</div>
    <div class="card"><h3>Nothing for clients to learn</h3><code>Endpoint.address</code> is an opaque URL, and any currently valid token covering the study works.</div>
  </div>
  <h3>Who can access what</h3>
  <ol class="chain-doc">
    <li><b>Sign in.</b> Every person has their own account at the Authorization Server, and in this demo picking an account stands in for real authentication. Patients see their own records.</li>
    <li><b>Delegate to a related person.</b> A patient can let someone else sign in as themselves and see all or part of the patient's records.</li>
    <li><b>Delegate to an app.</b> Anyone with access, patient or related person, can authorize an app through SMART App Launch, and can give it part of what they hold.</li>
  </ol>
  <p>Each link can only narrow what the one before it allows. The Imaging Server keeps these choices as policy. Tokens carry the patient and scope, and the proxy learns none of it. Try the <a href="${esc(services.authorization ?? "")}/account" target="_blank" rel="noopener">account page</a>, which works on the policy the badge above names, or flows 1 and 2.</p>
  <p>Pick a flow on the left. Each step makes real requests to these local services, and you can change the choices and the policy as you go. A flow works in flow scratch, which is reset when it starts, so saved policy isn't affected. The button beside the badge goes back to saved policy, and the <a href="/admin">admin screen</a> manages both.</p>
  <ul>${Object.entries(services).map(([k, v]) => `<li>${esc(k)}: <code>${esc(v)}</code></li>`).join("")}</ul></section>`;
}

async function openFlow(id) {
  showFlow(id, await post(`/api/flows/${id}/start`));
}
function restoreFlow(state) {
  showFlow(state.flow, state);
  for (const s of state.steps) if (state.completed[s.id]) {
    const { inputs, result } = state.completed[s.id];
    const el = $(`[data-step="${s.id}"]`);
    el.className = "step";
    showInputs(el, inputs);
    showResult(s.id, el, result);
  }
  renderSteps(state.steps);
  if (state.running) {
    const btn = $(`[data-run="${state.running}"]`);
    if (btn) { btn.disabled = true; btn.textContent = "Still running…"; }
    setTimeout(async () => { const again = await api("/api/flow-state"); if (again.flow === state.flow) restoreFlow(again); }, 1000);
  }
}
function showFlow(id, data) {
  const f = flows.find(x => x.id === id);
  current = { ...f, steps: data.steps };
  stepsDone = {};
  renderNav();
  $("#main").innerHTML = `<h2 class="flow-title">${f.number}. ${esc(f.title)}</h2><p class="summary">${esc(f.summary)}</p><p class="shows">${esc(f.shows)}</p>
    <div class="toolbar"><button class="primary" id="run-rest">Run remaining steps</button><button class="secondary" id="restart">Start over</button></div>
    <div id="chain" class="chain"></div><details class="policy" id="policy"><summary>Imaging Server policy</summary><div class="inner"><p class="note">Known only to the Imaging Server. The proxy never receives it. Edit it and apply to change what later steps do. This panel acts on: <b id="policy-store"></b>.</p><textarea id="policy-text" spellcheck="false" aria-label="Policy JSON"></textarea><div><button class="secondary" id="apply-policy">Apply policy</button><span class="msg" id="policy-msg" role="status"></span></div></div></details>
    <div id="steps"></div>`;
  $("#restart").onclick = () => openFlow(id);
  $("#run-rest").onclick = runRemaining;
  $("#apply-policy").onclick = applyPolicy;
  showStore(data.store);
  setPolicy(data.policy);
  renderSteps(data.steps);
}
function setPolicy(p) {
  const t = $("#policy-text");
  if (t) t.value = JSON.stringify(p, null, 2);
  const box = $("#chain");
  if (!box) return;
  const sites = s => s?.length ? s.join(", ") : s ? "no sites" : "everything they can see";
  const lines = [...p.delegations.map(d => `${d.grantedBy} → ${d.delegate} (${d.relationship}): ${sites(d.sites)}`), ...p.appGrants.map(g => `${g.user} → app ${g.client}: ${sites(g.sites)}`)];
  box.innerHTML = lines.length ? `<h3>Current delegations</h3><ul>${lines.map(l => `<li>${esc(l)}</li>`).join("")}</ul>` : "";
}
async function applyPolicy() {
  const msg = $("#policy-msg");
  try {
    const r = await api("/api/policy", { method: "PUT", headers: { "content-type": "application/json" }, body: $("#policy-text").value });
    setPolicy(r);
    msg.textContent = "Applied.";
  } catch (e) { msg.textContent = `Not applied: ${e.message}`; }
}
function inputHtml(step, i) {
  i = { ...i, default: i.clickDefault ?? i.default };
  const id = `${step.id}-${i.id}`;
  const help = i.help ? `<div class="help">${esc(i.help)}</div>` : "";
  if (i.type === "multi") return `<div><span class="name"><label class="name">${esc(i.label)}</label></span><div class="checks" data-input="${i.id}" data-type="multi">${(i.options ?? []).map(o => `<label><input type="checkbox" value="${esc(o.value)}" ${(i.default ?? []).includes(o.value) ? "checked" : ""}> ${esc(o.label)}</label>`).join("")}</div>${help}</div>`;
  if (i.type === "select") return `<div><label class="name" for="${id}">${esc(i.label)}</label><select id="${id}" data-input="${i.id}">${(i.options ?? []).map(o => `<option value="${esc(o.value)}" ${o.value === i.default ? "selected" : ""}>${esc(o.label)}</option>`).join("")}</select>${help}</div>`;
  return `<div><label class="name" for="${id}">${esc(i.label)}</label><input type="text" id="${id}" data-input="${i.id}" value="${esc(i.default)}">${help}</div>`;
}
function renderSteps(steps) {
  const wrap = $("#steps");
  steps.forEach((s, n) => {
    let el = wrap.querySelector(`[data-step="${s.id}"]`);
    if (!el) {
      el = document.createElement("section");
      el.className = "step";
      el.dataset.step = s.id;
      wrap.appendChild(el);
    }
    if (stepsDone[s.id]) return;
    const next = !steps.slice(0, n).some(p => !stepsDone[p.id]);
    el.className = `step ${next ? "" : "pending"}`;
    el.innerHTML = `<div class="head"><span class="num">${n + 1}</span><h3>${esc(s.title)}</h3><span class="actor">${esc(s.actor)}</span></div>
      <div class="body"><div class="doc">${s.doc}</div><div class="inputs">${s.inputs.map(i => inputHtml(s, i)).join("")}</div><button class="primary" data-run="${s.id}">Run this step</button><div class="result" role="status"></div></div>`;
    el.querySelector("[data-run]").onclick = () => runStep(s.id);
  });
}
function showInputs(el, inputs) {
  el.querySelectorAll("[data-input]").forEach(i => {
    const v = inputs[i.dataset.input];
    if (i.dataset.type === "multi") i.querySelectorAll("input").forEach(c => { c.checked = (v ?? []).includes(c.value); });
    else if (v !== undefined) i.value = v;
  });
}
function showResult(id, el, result) {
  stepsDone[id] = result.checks.every(c => c.ok) ? "ok" : "bad";
  el.querySelector("[data-run]")?.remove();
  el.querySelector(".inputs").querySelectorAll("input,select").forEach(i => i.disabled = true);
  el.querySelector(".result").innerHTML = renderResult(result);
}
function collect(el) {
  const out = {};
  el.querySelectorAll("[data-input]").forEach(i => {
    if (i.dataset.type === "multi") out[i.dataset.input] = [...i.querySelectorAll("input:checked")].map(c => c.value);
    else out[i.dataset.input] = i.value;
  });
  return out;
}
async function runStep(id) {
  const el = $(`[data-step="${id}"]`);
  const btn = el.querySelector("[data-run]");
  btn.disabled = true; btn.textContent = "Running…";
  const inputs = collect(el);
  // A popup has to open from the click itself, so it opens before the authorization URL exists.
  const popup = inputs.mode === "window" ? window.open("about:blank", "smart-imaging-authorize", "width=600,height=800") : null;
  if (inputs.mode === "window" && !popup) inputs.mode = "scripted"; // Popups are blocked, so the scripted path runs.
  if (popup) btn.textContent = "Waiting for you in the other window…";
  let polling = !!popup;
  (async () => { while (polling) { const p = await api("/api/pending-authorization"); if (p.url) { popup.location = p.url; return; } await new Promise(r => setTimeout(r, 200)); } })();
  try {
    const r = await post(`/api/flows/${current.id}/steps/${id}`, { inputs });
    polling = false;
    showResult(id, el, r.result);
    setPolicy(r.policy);
    showStore(r.store);
    current.steps = r.steps;
    renderSteps(r.steps);
    if (current.steps.every(s => stepsDone[s.id])) { flowStatus[current.id] = current.steps.every(s => stepsDone[s.id] === "ok"); renderNav(); }
    return stepsDone[id] === "ok";
  } catch (e) {
    polling = false;
    btn.disabled = false; btn.textContent = "Run this step";
    el.querySelector(".result").innerHTML = `<p class="error">${esc(e.message)}</p>`;
    return false;
  }
}
async function runRemaining() {
  for (const s of current.steps) if (!stepsDone[s.id]) { if (!(await runStep(s.id))) break; }
}
async function runEvery() {
  const btn = $("#run-all");
  for (const f of flows) { await openFlow(f.id); await runRemaining(); const b = $("#run-all"); if (b) b.textContent = `Ran through ${f.number} of ${flows.length}`; }
}
function renderResult(r) {
  return `${r.exchanges.map(renderExchange).join("")}${r.decisions.map(renderDecision).join("")}
   <ul class="checks">${r.checks.map(c => `<li><span class="${c.ok ? "ok" : "bad"}">${c.ok ? "✓" : "✗"}</span> ${esc(c.label)}${c.detail ? ` <span class="detail">${esc(c.detail)}</span>` : ""}</li>`).join("")}</ul>`;
}
function renderExchange(x) {
  const ok = typeof x.status === "number" && x.status < 400;
  const headers = Object.entries(x.requestHeaders ?? {}).map(([k, v]) => `${esc(k)}: ${esc(v)}`).join("\n");
  const resHeaders = Object.entries(x.responseHeaders ?? {}).filter(([k]) => /content-type|www-authenticate|retry-after/i.test(k)).map(([k, v]) => `${esc(k)}: ${esc(v)}`).join("\n");
  return `<div class="exchange"><div class="line"><span class="title">${esc(x.title ?? "")}</span><span class="status ${ok ? "ok" : "err"}">${esc(x.status)}</span>${x.authz && BADGE[x.authz] ? `<span class="badge ${x.authz}">${BADGE[x.authz]}</span>` : ""}${x.denial ? `<span class="detail">${esc(x.denial)}</span>` : ""}${x.ms !== undefined ? `<span class="ms">${x.ms} ms</span>` : ""}</div>
    ${x.summary ? `<p class="result-note">${esc(x.summary)}</p>` : ""}${x.note ? `<p class="proxy-note">Proxy: ${esc(x.note)}</p>` : ""}
    <details><summary>Request and response</summary><div class="req">${esc(x.actor)} → ${esc(x.method)} ${esc(x.url)}</div>${headers ? `<pre>${headers}</pre>` : ""}${x.requestBody ? `<pre>${esc(x.requestBody)}</pre>` : ""}${resHeaders ? `<pre>${resHeaders}</pre>` : ""}${x.body !== undefined ? `<pre>${esc(typeof x.body === "string" ? x.body : JSON.stringify(x.body, null, 2))}</pre>` : ""}</details></div>`;
}
function renderDecision(d) {
  return `<div class="decision"><h4>Decision API: ${d.response.decision ? "allowed" : "denied"}</h4><div class="why">${esc(d.why)}</div><details><summary>AuthZEN request and response</summary><pre>POST /access/v1/evaluation\n${esc(JSON.stringify(d.request, null, 2))}</pre><pre>${esc(JSON.stringify(d.response, null, 2))}</pre></details></div>`;
}
// A page restored from the browser's cache would show stale state, so it loads again.
window.addEventListener("pageshow", e => { if (e.persisted) location.reload(); });
init();
