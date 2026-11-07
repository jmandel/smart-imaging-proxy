const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const api = async (path, opts) => { const r = await fetch(path, opts); const b = await r.json(); if (!r.ok) throw new Error(b.error ?? r.statusText); return b; };
const post = (path, body) => api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });

let flows = [], services = {}, current = null, stepsDone = {}, flowStatus = {}, shownStore;
const BADGE = { instant: "instant: no network call", asked: "asked can_i", cached: "cached decision" };

function showStore(store) {
  const b = $("#store-badge");
  b.textContent = store.label;
  b.className = `store-badge ${store.active}`;
  const t = $("#policy-store");
  if (t) t.textContent = store.label;
  $("#back-to-saved").hidden = store.active === "saved";
  const saved = store.active === "saved";
  const text = $("#policy-text");
  if (text) {
    text.readOnly = saved;
    $("#apply-policy").disabled = saved;
    $("#policy-note").textContent = saved
      ? "Read-only now, because saved policy is active. This panel changes only flow scratch, and saved rules change through the named rule sets on the admin screen. Running a flow step goes back to flow scratch."
      : "Known only to the Imaging Server. The proxy never receives it. Edit it and apply to change what later steps do. This panel changes only flow scratch.";
  }
}
/** Another tab can change the active store, so a flow page checks when it's looked at again. */
async function refreshStore() {
  if (!$("#policy-text")) return;
  const store = await api("/api/store");
  const changed = store.active !== shownStore;
  showStore(store);
  shownStore = store.active;
  if (changed) setPolicy(await api("/api/policy"));
}
async function backToSaved() {
  const status = await post("/api/admin/store/activate", { store: "saved" });
  showStore(status.store);
  current = null;
  renderNav();
  renderIntro(services);
}
async function init() {
  const returning = location.hash === "#flow";
  const data = await api("/api/flows");
  flows = data.flows;
  services = data.services;
  $("#back-to-saved").onclick = backToSaved;
  showStore(data.store);
  renderNav();
  renderIntro(data.services);
  // A flow in progress comes back as it was. Loading this page changes nothing on the server.
  const state = await api("/api/flow-state");
  // Only a reload or Back returns to a flow, so the Overview link always shows the overview.
  if (state.flow && state.store.active === "scratch" && returning) restoreFlow(state);
  const b = await api("/api/backends");
  const sel = $("#backend");
  sel.innerHTML = b.backends.map(x => `<option value="${x.name}" ${x.name === b.current ? "selected" : ""}>${x.name}${x.ok ? "" : " (unavailable)"}</option>`).join("");
  sel.onchange = async () => { await post("/api/backend", { backend: sel.value }); if (current) openFlow(current.id); showBackend(b); };
  showBackend(b);
}
function showBackend(b) {
  const x = b.backends.find(n => n.name === $("#backend").value);
  $("#backend-status").textContent = x ? `${x.capabilities.selection}${x.capabilities.hasManifest ? ", indexed" : ""}` : "";
  $("#backend-status").title = x ? x.capabilities.notes.join(" ") : "";
}
// Grouped by the question each flow answers. Flow numbers stay as the docs cite them.
const FLOW_GROUPS = [
  ["Who can see what", [1, 2, 15, 3, 4, 6]],
  ["How the proxy decides", [5, 7, 8, 9, 10]],
  ["What comes back", [11, 12, 13, 14]],
];
const flowsIn = numbers => numbers.map(n => flows.find(f => f.number === n)).filter(Boolean);
const statusMark = f => flowStatus[f.id] === true ? '<span class="done" aria-label="passed">✓</span>' : flowStatus[f.id] === false ? '<span class="failed" aria-label="failed">✗</span>' : "";
function renderNav() {
  const item = f => `<button data-id="${f.id}" class="${current?.id === f.id ? "active" : ""}"><span class="n">${f.number}</span><span>${esc(f.title)}</span>${statusMark(f)}</button>`;
  const nav = $("#flow-list");
  nav.innerHTML = `${FLOW_GROUPS.map(([name, numbers]) => `<h2>${name}</h2>${flowsIn(numbers).map(item).join("")}`).join("")}<button id="run-all" class="secondary">Run every flow</button>`;
  nav.querySelectorAll("button[data-id]").forEach(b => b.onclick = () => openFlow(b.dataset.id));
  $("#run-all").onclick = runEvery;
}
const firstSentence = text => text.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? text;
function flowChooser() {
  const choice = f => `<button class="flow-choice" data-id="${f.id}"><span class="n">${f.number}</span><span class="what"><b>${esc(f.title)}</b><span>${esc(firstSentence(f.summary))}</span></span>${statusMark(f)}</button>`;
  return `<section class="flows-section" aria-labelledby="h-flows"><h2 id="h-flows">Try a flow</h2><p>Each one runs real requests step by step, in a scratch policy that resets when the flow starts.</p>
    <div class="flow-groups">${FLOW_GROUPS.map(([name, numbers]) => `<div><h3>${name}</h3>${flowsIn(numbers).map(choice).join("")}</div>`).join("")}</div>
    <button id="run-every" class="secondary">Run every flow</button></section>`;
}
const ROUTE_WHY = {
  instant: "The URL's signature, expiry, study and token hash all check out, so the proxy answers with no network call.",
  asked: 'Anything else, such as a refreshed token, a separate client or an expired URL. The proxy asks with an <a href="https://openid.net/specs/authorization-api-1_0.html">AuthZEN</a> evaluation, <code>can_i</code>, and keeps the answer briefly.',
};
const routeNode = (x, y, name, sub) => `<rect class="node" x="${x}" y="${y}" width="210" height="72" rx="6"/><text x="${x + 16}" y="${y + 31}">${name}</text><text class="sub" x="${x + 16}" y="${y + 54}">${sub}</text>`;
const routeSvg = (cls, box, instantPath, askedPath, nodes) => `<svg class="route ${cls}" data-route="instant" viewBox="0 0 ${box}" role="img" aria-label="An app requests images from the proxy, which reads the image store, and asks the Imaging Server only when the URL can't answer.">
    <path class="path asked" d="${askedPath}"/><path class="path instant" d="${instantPath}"/>${nodes}
    <circle class="pulse instant-pulse" r="7" style="offset-path:path('${instantPath}')"/><circle class="pulse asked-pulse" r="7" style="offset-path:path('${askedPath}')"/></svg>`;
function renderIntro(services) {
  document.querySelector(".live-link").href = services["live trace"];
  const wide = routeSvg("wide", "920 250", "M125 190 H795", "M125 190 H420 V90 H500 V190 H795",
    routeNode(20, 154, "App", "token, signed URL") + routeNode(355, 154, "Proxy", "a key, no policy") + routeNode(690, 154, "Image store", "bytes only") + routeNode(355, 18, "Imaging Server", "all the policy"));
  const tall = routeSvg("tall", "460 366", "M115 56 V316", "M115 56 V172 H345 V200 H115 V316",
    routeNode(10, 20, "App", "token, signed URL") + routeNode(10, 150, "Proxy", "a key, no policy") + routeNode(10, 280, "Image store", "bytes only") + routeNode(240, 150, "Imaging Server", "all the policy"));
  history.replaceState(null, "", location.pathname);
  document.body.classList.remove("in-flow");
  document.querySelector('.pages a[href="/"]')?.setAttribute("aria-current", "page");
  $("#main").innerHTML = `<section class="intro">
    <div class="hero">
      <h1>The proxy decides without ever holding the policy.</h1>
      <p>Search signs each study's URL. The proxy checks that signature on every request, and asks the Imaging Server only when it can't answer alone.</p>
      <div class="route-tabs" role="group" aria-label="Which route a request takes"><button data-route="instant" aria-pressed="true">Signed URL checks out</button><button data-route="asked" aria-pressed="false">Anything else</button></div>
      ${wide}${tall}
      <p class="route-why" id="route-why" role="status">${ROUTE_WHY.instant}</p>
    </div>
    <div class="narrowing">
      <div>
        <h2>Each link can only narrow access</h2>
        <ol class="links-of-access">
          <li><b>Josh, the patient</b><span>All their own studies</span></li>
          <li><b>Sam, a related person</b><span>What Josh shares with Sam</span></li>
          <li><b>An app</b><span>What Sam gives it</span></li>
        </ol>
        <p>Anyone with access can authorize an app, through a real SMART App Launch. The Imaging Server keeps these choices as policy, tokens carry the patient and scope, and the proxy learns none of it.</p>
      </div>
      <div class="next">
        <h2>See who can see what</h2>
        <p>Sign in as someone and see exactly the studies they can reach.</p>
        <p><a class="button" href="/browse">Browse studies</a></p>
        <p class="note">Accounts share from their own <a href="${esc(services.authorization ?? "")}/account" target="_blank" rel="noopener">account page</a>, and the <a href="/admin">admin screen</a> manages the rest.</p>
      </div>
    </div>
    ${flowChooser()}
    <details class="addresses"><summary>Service addresses</summary><dl>${Object.entries(services).map(([k, v]) => `<dt>${esc(k)}</dt><dd><code>${esc(v)}</code></dd>`).join("")}</dl></details></section>`;
}
document.addEventListener("click", e => {
  const pick = e.target.closest?.(".flow-choice, [data-next]");
  if (pick) { openFlow(pick.dataset.id ?? pick.dataset.next); scrollTo(0, 0); return; }
  if (e.target.id === "run-every") { runEvery(); return; }
  const b = e.target.closest?.(".route-tabs button");
  if (!b) return;
  document.querySelectorAll(".route-tabs button").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
  document.querySelectorAll(".route").forEach(svg => { svg.dataset.route = ""; void svg.getBoundingClientRect(); svg.dataset.route = b.dataset.route; });
  $("#route-why").innerHTML = ROUTE_WHY[b.dataset.route];
});
async function openFlow(id) {
  try { showFlow(id, await post(`/api/flows/${id}/start`)); }
  catch (e) { $("#main").innerHTML = `<p class="error" role="alert">${esc(e.message)}</p>`; }
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
  history.replaceState(null, "", "#flow");
  document.body.classList.add("in-flow");
  const f = flows.find(x => x.id === id);
  current = { ...f, steps: data.steps };
  stepsDone = {};
  renderNav();
  const order = FLOW_GROUPS.flatMap(([, numbers]) => flowsIn(numbers));
  const next = order[order.indexOf(f) + 1];
  document.querySelector('.pages a[href="/"]')?.removeAttribute("aria-current");
  $("#main").innerHTML = `<p class="back"><a href="/">All flows</a></p><h2 class="flow-title">${f.number}. ${esc(f.title)}</h2><p class="summary">${esc(f.summary)}</p><p class="shows">${esc(f.shows)}</p>
    <div class="toolbar"><button class="primary" id="run-rest">Run remaining steps</button><button class="secondary" id="restart">Start over</button></div>
    <div id="chain" class="chain"></div><details class="policy" id="policy"><summary>Imaging Server policy</summary><div class="inner"><p class="note"><span id="policy-note"></span> Active: <b id="policy-store"></b>.</p><textarea id="policy-text" spellcheck="false" aria-label="Policy JSON"></textarea><div><button class="secondary" id="apply-policy">Apply policy</button><span class="msg" id="policy-msg" role="status"></span></div></div></details>
    <div id="steps"></div>${next ? `<p class="next-flow"><button class="secondary" data-next="${next.id}">Next flow: ${next.number}. ${esc(next.title)}</button></p>` : ""}`;
  $("#restart").onclick = () => openFlow(id);
  $("#run-rest").onclick = runRemaining;
  $("#apply-policy").onclick = applyPolicy;
  showStore(data.store);
  shownStore = data.store.active;
  setPolicy(data.policy);
  renderSteps(data.steps);
}
function setPolicy(p) {
  const t = $("#policy-text");
  if (t) t.value = JSON.stringify(p, null, 2);
  const box = $("#chain");
  if (!box) return;
  const sites = s => s?.length ? s.join(", ") : s ? "no sites" : "everything they can see";
  // Guardians are on file in every flow, and matter only where someone acts for another person.
  const standing = (current?.number === 2 || current?.number === 15 ? p.guardians ?? [] : []).map(g => `${g.guardian} is ${g.patient}'s ${g.relationship}, on file: ${g.excludedStudies?.length ? "all but what's confidential from them" : "the whole record"}`);
  const lines = [...standing, ...p.delegations.map(d => `${d.grantedBy} → ${d.delegate} (${d.relationship}), ${d.patient}: ${sites(d.sites)}`), ...p.appGrants.map(g => `${g.user} → app ${g.client}, ${g.patient}: ${sites(g.sites)}`)];
  box.innerHTML = lines.length ? `<h3>Who holds what</h3><ul>${lines.map(l => `<li>${esc(l)}</li>`).join("")}</ul>` : "";
}
async function applyPolicy() {
  const msg = $("#policy-msg");
  try {
    const r = await api("/api/policy", { method: "PUT", headers: { "content-type": "application/json" }, body: $("#policy-text").value });
    setPolicy(r);
    msg.textContent = "Applied.";
  } catch (e) { msg.textContent = `Not applied: ${e.message}`; refreshStore().catch(() => {}); }
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
  el.querySelector(".result").innerHTML = "";
  const inputs = collect(el);
  // A popup has to open from the click itself, so it opens before the authorization URL exists.
  const popup = inputs.mode === "window" ? window.open("about:blank", "smart-imaging-authorize", "width=600,height=800") : null;
  if (inputs.mode === "window" && !popup) inputs.mode = "scripted"; // Popups are blocked, so the scripted path runs.
  if (popup) btn.textContent = "Waiting for you in the other window…";
  let polling = !!popup;
  (async () => {
    let sent = false, closedPolls = 0;
    while (polling) {
      if (!sent) { const p = await api("/api/pending-authorization"); if (p.url) { popup.location = p.url; sent = true; } }
      // Someone closed the window without finishing. Two polls, since the redirect also closes it.
      else if (popup.closed && ++closedPolls >= 2) { await post("/api/pending-authorization/cancel"); return; }
      await new Promise(r => setTimeout(r, 250));
    }
  })();
  try {
    const r = await post(`/api/flows/${current.id}/steps/${id}`, { inputs });
    polling = false;
    showResult(id, el, r.result);
    setPolicy(r.policy);
    showStore(r.store);
    shownStore = r.store.active;
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
  const order = FLOW_GROUPS.flatMap(([, numbers]) => flowsIn(numbers));
  for (const [i, f] of order.entries()) { await openFlow(f.id); await runRemaining(); const b = $("#run-all"); if (b) b.textContent = `Ran ${i + 1} of ${order.length}`; }
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
window.addEventListener("focus", () => { refreshStore().catch(() => {}); });
init();
