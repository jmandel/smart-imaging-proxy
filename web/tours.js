// Tours: four stories, each run in a scope of its own, and the protocol checks as one list. Each step is
// an action. What it should come to is the reference model's, computed from the scope's policy as it is
// when the step runs, and the step passes when the system's real answer matches.
let list, state = null, running = false, popup, popupSent = false, wantFocus = false, pageError = "";
const checks = {};
const chosen = () => new URLSearchParams(location.search).get("tour") ?? list?.current ?? list?.tours[0]?.id;
const windowMode = () => $("#window-mode")?.checked ?? false;

function listHtml() {
  const current = state?.tour?.id ?? chosen();
  const done = Object.values(checks).filter(c => c.ok !== undefined), running = Object.values(checks).some(c => c.running);
  return `<h2>Stories</h2>${list.tours.map(t => `<a class="tour" href="/tours?tour=${esc(t.id)}" ${t.id === current ? 'aria-current="true"' : ""}><b>${esc(t.title)}</b><span>${esc(t.summary)}</span></a>`).join("")}
    <section class="checks-panel" aria-labelledby="h-checks"><h2 id="h-checks">Protocol checks</h2>
      <p class="note">Each flow runs in a scope of its own, every step with its usual choices, and every check it makes has to pass.</p>
      <div class="row"><button type="button" class="secondary" id="run-checks" ${Object.values(checks).some(c => c.running) ? "disabled" : ""}>Run checks</button>
        ${running ? `<span class="note" role="status">${done.length} of ${list.checks.length} run</span>` : done.length ? `<span class="${done.every(c => c.ok) ? "verdict ok" : "verdict bad"}" role="status">${done.filter(c => c.ok).length} of ${done.length} passed</span>` : ""}</div>
      <ul class="check-list">${list.checks.map(c => { const r = checks[c.id]; return `<li><span class="verdict ${r?.ok ? "ok" : r?.ok === false ? "bad" : ""}">${r?.running ? '<span class="spinner" aria-hidden="true"></span>' : r ? (r.ok ? "Pass" : "Fail") : ""}</span><span>${esc(c.title)}</span>${r?.activityUrl ? `<a href="${esc(r.activityUrl)}">What happened</a>` : ""}${r?.failures?.length ? `<span class="fail-detail">${r.failures.map(f => esc(`${f.step}: ${f.label}${f.detail ? ` (${f.detail})` : ""}`)).join("<br>")}</span>` : ""}</li>`; }).join("")}</ul>
    </section>`;
}

function stepHtml(s, i, steps) {
  const next = !s.result && (i === 0 || steps[i - 1].result);
  const cls = s.result ? "step" : next ? "step next" : "step pending";
  const r = s.result;
  return `<li class="${cls}">
    <span class="what"><b>${esc(s.title)}</b><span>${esc(s.actor)}${next && s.expect ? `. The model expects: ${esc(s.expect)}` : ""}</span></span>
    ${r ? `<span class="verdict ${r.ok ? "ok" : "bad"}">${r.ok ? "Matches the model" : r.stopped ? "Stopped" : "Differs from the model"}</span>` : next ? `<button type="button" class="primary" data-step="${esc(s.id)}" ${running ? "disabled" : ""}>${running ? "Running…" : "Run"}</button>` : "<span></span>"}
    ${r ? `<dl class="compare">${r.expected ? `<dt>Expected</dt><dd>${esc(r.expected)}</dd>` : ""}<dt>Got</dt><dd>${esc(r.actual)}</dd>${r.write ? `<dt>Policy written</dt><dd>${esc(r.write)}</dd>` : ""}</dl>
      <div class="result"><details><summary>What happened, ${plural(r.events.length, "event")}</summary>${Cards.list(r.events)}</details></div>` : ""}
  </li>`;
}

function tourHtml() {
  if (pageError) return `<h1 id="tour-title" tabindex="-1">Something went wrong</h1><p class="error" role="alert">${esc(pageError)}</p>`;
  if (!state?.tour) {
    const t = list.tours.find(x => x.id === chosen());
    return `<div class="tour-head"><h1 id="tour-title" tabindex="-1">${esc(t.title)}</h1><p>${esc(t.summary)}</p></div>
      <span class="pill">Runs in a scope of its own, so saved policy and Explore stay as they are</span>
      <div class="tour-buttons"><button type="button" class="primary" id="start">Start the tour</button>
      <label class="note"><input type="checkbox" id="window-mode"> Sign in yourself, in a window</label></div>`;
  }
  const steps = state.steps, left = steps.filter(s => !s.result).length;
  return `<div class="tour-head"><h1 id="tour-title" tabindex="-1">${esc(state.tour.title)}</h1><p>${esc(state.tour.summary)}</p>${state.tour.note ? `<p>${esc(state.tour.note)}</p>` : ""}</div>
    <span class="pill">In its own scope: <code>${esc(state.scope.id)}</code></span>
    ${state.pendingAuthUrl ? `<p class="note">Sign in in the window that opened. <a href="${esc(state.pendingAuthUrl)}" target="smart-imaging-authorize" rel="opener">Open it again</a></p>` : ""}
    <ol class="steps">${steps.map(stepHtml).join("")}</ol>
    <div class="tour-buttons">
      ${left ? `<button type="button" class="secondary" id="run-rest" ${running ? "disabled" : ""}>Run the rest</button>` : `<span class="verdict ${steps.every(s => s.result.ok) ? "ok" : "bad"}" role="status">${steps.every(s => s.result.ok) ? "Every step matched the model" : "Some steps differ from the model"}</span>`}
      <button type="button" class="secondary" id="start">Start over</button>
      <label class="note"><input type="checkbox" id="window-mode"> Sign in yourself, in a window</label>
      <a href="${esc(state.activityUrl)}">All the activity</a></div>`;
}

function render() {
  const mode = windowMode();
  const focused = document.activeElement?.id || document.activeElement?.dataset?.step;
  $("#tour-list").innerHTML = listHtml();
  $("#tour").innerHTML = tourHtml();
  if ($("#window-mode")) $("#window-mode").checked = mode;
  Cards.wire($("#tour"));
  if (wantFocus) { wantFocus = false; $("#tour-title")?.focus(); }
  else if (focused) (document.getElementById(focused) ?? $(`[data-step]`))?.focus();
}

async function refresh() { state = await api("GET", `/api/tours/state?tour=${encodeURIComponent(chosen())}`); }
async function runStep(id) {
  running = true;
  const window = windowMode();
  if (window) { popup = open("about:blank", "smart-imaging-authorize", "width=600,height=800"); popupSent = false; }
  render();
  // While a step waits on a window, the state carries its sign-in URL.
  const watch = setInterval(async () => {
    try {
      const s = await api("GET", "/api/tours/state");
      if (popup && s.pendingAuthUrl && !popupSent && !popup.closed) { popup.location = s.pendingAuthUrl; popupSent = true; }
      if (popup && popupSent && popup.closed && s.pendingAuthUrl) { api("POST", "/api/tours/cancel", {}).catch(() => {}); popup = null; }
    } catch {}
  }, 300);
  try { state = await api("POST", `/api/tours/${encodeURIComponent(state.tour.id)}/steps/${encodeURIComponent(id)}`, { mode: window ? "window" : "scripted" }); }
  catch (e) { pageError = e.message; }
  finally { clearInterval(watch); running = false; if (popup && !popup.closed && !window) popup.close(); popup = null; }
  const s = state.steps?.find(x => x.id === id);
  if (s?.result) announce(`${s.title}: ${s.result.ok ? "matches the model" : "differs from the model"}`);
  render();
  $(`[data-step]`)?.focus();
}
async function start() {
  const id = chosen();
  try {
    const r = await api("POST", `/api/tours/${encodeURIComponent(id)}/start`, {});
    location.href = `${r.scope.base}/tours?tour=${encodeURIComponent(id)}${windowMode() ? "&window=1" : ""}`;
  } catch (e) { pageError = e.message; render(); }
}
async function runChecks() {
  for (const c of list.checks) checks[c.id] = { running: true };
  render();
  for (const c of list.checks) {
    try { checks[c.id] = await fetch(`/api/checks/${encodeURIComponent(c.id)}`, { method: "POST" }).then(r => r.json()); }
    catch (e) { checks[c.id] = { ok: false, failures: [{ step: c.title, label: e.message }] }; }
    render();
  }
  const done = Object.values(checks);
  announce(`${done.filter(c => c.ok).length} of ${done.length} checks passed`);
}

document.addEventListener("click", e => {
  const t = e.target.closest("button");
  if (!t) return;
  if (t.id === "start") start();
  else if (t.id === "run-checks") runChecks();
  else if (t.dataset.step) runStep(t.dataset.step);
  else if (t.id === "run-rest") (async () => { for (let s = state.steps.find(x => !x.result); s && !pageError; s = state.steps.find(x => !x.result)) { await runStep(s.id); if (!state.steps.find(x => x.id === s.id)?.result) break; } })();
});

(async () => {
  try {
    list = await fetch("/api/tours").then(r => r.json());
    if (BASE) await refresh();
    wantFocus = !!BASE;
    render();
    if (new URLSearchParams(location.search).get("window") && $("#window-mode")) $("#window-mode").checked = true;
  } catch (e) { pageError = e.message; render(); }
})();
