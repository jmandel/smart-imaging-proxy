// Tours, the home page: six stories as cards, each drawing the layer chain it ends on. Choosing one
// starts it in a scope of its own and opens its step runner there. Each step is an action. What it
// should come to is the reference model's, computed from the scope's policy as it is when the step
// runs, and the step passes when the system's real answer matches. The protocol checks sit below.
let list, state = null, running = false, popup, popupSent = false, wantFocus = false, pageError = "";
const checks = {};
const params = () => new URLSearchParams(location.search);
const chosen = () => params().get("tour") ?? list?.current;
const windowMode = () => signInMode() === "window";

function checksHtml() {
  const done = Object.values(checks).filter(c => c.ok !== undefined), busy = Object.values(checks).some(c => c.running);
  return `<section class="checks-panel" aria-labelledby="h-checks"><h2 id="h-checks">Protocol checks</h2>
      <div class="row"><button type="button" class="secondary" id="run-checks" ${busy ? "disabled" : ""}>Run checks</button>
        ${busy ? `<span class="note" role="status">${done.length} of ${list.checks.length} run</span>` : done.length ? `<span class="${done.every(c => c.ok) ? "verdict ok" : "verdict bad"}" role="status">${done.filter(c => c.ok).length} of ${done.length} passed</span>` : ""}</div>
      <ul class="check-list">${list.checks.map(c => { const r = checks[c.id]; return `<li><span class="verdict ${r?.ok ? "ok" : r?.ok === false ? "bad" : ""}">${r?.running ? '<span class="spinner" aria-hidden="true"></span>' : r ? (r.ok ? "Pass" : "Fail") : ""}</span><span class="check-what"><b>${esc(c.title)}</b><span>${esc(c.summary)}</span></span>${r?.activityUrl ? `<a href="${esc(r.activityUrl)}">Activity log</a>` : ""}${r?.failures?.length ? `<span class="fail-detail">${r.failures.map(f => esc(`${f.step}: ${f.label}${f.detail ? ` (${f.detail})` : ""}`)).join("<br>")}</span>` : ""}</li>`; }).join("")}</ul>
    </section>`;
}

// The home page: who's who, then a card per story, on film, with the chain it ends on.
function homeHtml() {
  const locked = list.tours.some(t => t.chains.some(c => c.chain.columns.some(x => x.locked)));
  return `<div class="home-head"><h1 id="tour-title" tabindex="-1">Tours</h1><a href="/explore">Explore on your own</a></div>
    ${pageError ? `<p class="error" role="alert">${esc(pageError)}</p>` : ""}
    <section class="cast" aria-labelledby="h-cast"><h2 id="h-cast">Who's who</h2><dl>${list.cast.map(c => `<div><dt>${esc(c.name)}</dt><dd>${esc(c.line)}</dd></div>`).join("")}</dl></section>
    <section class="key film" aria-labelledby="h-key"><h2 id="h-key">Reading the diagrams</h2>${Layers.legend({ locked, film: true })}</section>
    <ul class="stories">${list.tours.map(t => `<li class="story">
      <h2><button type="button" class="story-go" data-start="${esc(t.id)}">${esc(t.title)}</button></h2>
      <p>${esc(t.premise)}</p>
      ${Layers.chains(t.chains, { film: true, label: `${t.title}: why the app sees what it sees` })}
      <span class="story-steps">${esc(plural(t.steps, "step"))}</span></li>`).join("")}</ul>
    ${checksHtml()}`;
}

function stepHtml(s, i, steps) {
  const next = !s.result && (i === 0 || steps[i - 1].result);
  const cls = s.result ? "step" : next ? "step next" : "step pending";
  const r = s.result;
  // A step's chain shows where the step changed it.
  const before = chainBefore(i);
  const changed = r?.chain && JSON.stringify(r.chain.rows) !== JSON.stringify(before?.rows);
  const label = s.signsIn && windowMode() ? "Sign in" : "Run";
  return `<li class="${cls}">
    <span class="what"><b>${esc(s.title)}</b><span>${esc(s.actor)}</span>${next && s.expect ? `<span class="expect">Expected: ${esc(s.expect)}</span>` : ""}</span>
    ${r ? `<span class="verdict ${r.ok ? "ok" : "bad"}">${r.ok ? "As expected" : r.stopped ? "Stopped" : "Not as expected"}</span>` : next ? `<button type="button" class="primary" data-step="${esc(s.id)}" ${running ? "disabled" : ""}>${running ? "Running…" : label}</button>` : "<span></span>"}
    ${r ? `<dl class="compare">${r.expected ? `<dt>Expected</dt><dd>${esc(r.expected)}</dd>` : ""}<dt>Got</dt><dd>${esc(r.actual)}</dd>${r.detail ? `<dt>Technical detail</dt><dd class="tech">${esc(r.detail)}</dd>` : ""}${r.write ? `<dt>Policy written</dt><dd>${esc(r.write)}</dd>` : ""}</dl>
      ${changed ? `<div class="step-chain"><p class="ly-pane-label">After this step</p>${Layers.chain(r.chain, { label: "After this step: why the app sees what it sees" })}</div>` : ""}
      ${r.eventCount ? `<p class="result"><a href="${esc(r.activityUrl)}">Activity log</a>, ${esc(plural(r.eventCount, "event"))}</p>` : r.quiet ? `<p class="result note">${esc(r.quiet)}</p>` : ""}` : ""}
  </li>`;
}

/** The chain as it stood before step `i` ran. */
const chainBefore = i => state.steps.slice(0, i).reverse().find(x => x.result?.chain)?.result.chain ?? state.start;
/** Where the story stands: before any step, after the latest, and for a story about a change, before and after it. */
function standingHtml() {
  const steps = state.steps;
  const doneAt = steps.findLastIndex(s => s.result?.chain);
  const latest = doneAt >= 0 ? steps[doneAt].result.chain : state.chain;
  const change = state.tour.change && steps.findIndex(s => s.id === state.tour.change.step);
  const locked = latest.columns.some(x => x.locked);
  const caption = doneAt < 0 ? "At the start, before any step runs" : doneAt === steps.length - 1 ? "Where the story ends" : `After step ${doneAt + 1}: ${steps[doneAt].title}`;
  const body = change >= 0 && steps[change].result
    ? Layers.chains([{ label: state.tour.change.before, chain: chainBefore(change) }, { label: state.tour.change.after, chain: latest }])
    : `<p class="ly-pane-label">${esc(caption)}</p>${Layers.chain(latest)}`;
  return `<div class="tour-chain"><h2 class="sr-only">Why the app sees what it sees</h2>${body}${Layers.legend({ locked })}</div>`;
}

function runnerHtml() {
  if (pageError) return `<h1 id="tour-title" tabindex="-1">Something went wrong</h1><p class="error" role="alert">${esc(pageError)}</p>`;
  const steps = state.steps, left = steps.filter(s => !s.result).length;
  return `<div class="tour-head"><h1 id="tour-title" tabindex="-1">${esc(state.tour.title)}</h1><p>${esc(state.tour.summary)}</p>${state.tour.detail ? `<details class="tech-detail"><summary>Technical detail</summary><p>${esc(state.tour.detail)}</p></details>` : ""}</div>
    ${standingHtml()}
    ${state.pendingAuthUrl ? `<p class="note"><a href="${esc(state.pendingAuthUrl)}" target="smart-imaging-authorize" rel="opener">Open the sign-in window again</a></p>` : ""}
    <ol class="steps">${steps.map(stepHtml).join("")}</ol>
    <div class="tour-buttons">
      ${left ? `<button type="button" class="secondary" id="run-rest" ${running ? "disabled" : ""}>Run the rest</button>` : `<span class="verdict ${steps.every(s => s.result.ok) ? "ok" : "bad"}" role="status">${steps.every(s => s.result.ok) ? "Every step went as expected" : "Some steps didn't go as expected"}</span>`}
      <button type="button" class="secondary" id="start">Start over</button>
      ${state.activityUrl ? `<a href="${esc(state.activityUrl)}">Activity log</a>` : ""}</div>`;
}

function listHtml() {
  const current = state?.tour?.id;
  return `<h2>Stories</h2>${list.tours.map(t => `<button type="button" class="tour" data-start="${esc(t.id)}" ${t.id === current ? 'aria-current="true"' : ""}><b>${esc(t.title)}</b><span>${esc(t.premise)}</span></button>`).join("")}`;
}

const inRunner = () => !!(BASE && state?.tour);
function render() {
  const focused = document.activeElement?.id || document.activeElement?.dataset?.step;
  $("#tours-main").classList.toggle("home", !inRunner());
  $("#tour-list").hidden = !inRunner();
  if (inRunner()) { $("#tour-list").innerHTML = listHtml(); $("#tour").innerHTML = runnerHtml(); }
  else $("#tour").innerHTML = homeHtml();
  if (wantFocus) { wantFocus = false; $("#tour-title")?.focus(); }
  else if (focused) (document.getElementById(focused) ?? $(`[data-step]`))?.focus();
}

async function refresh() { state = await api("GET", `/api/tours/state?tour=${encodeURIComponent(chosen() ?? "")}`); state.start ??= state.chain; }
async function runStep(id) {
  running = true;
  const window = windowMode() && state.steps.find(s => s.id === id)?.signsIn;
  // The window opens from the Sign in click itself, before its address is known.
  if (window) { popup = open("about:blank", "smart-imaging-authorize", "width=600,height=800"); popupSent = false; }
  render();
  const watch = setInterval(async () => {
    try {
      const s = await api("GET", "/api/tours/state");
      if (popup && s.pendingAuthUrl && !popupSent && !popup.closed) { popup.location = s.pendingAuthUrl; popupSent = true; }
      if (popup && popupSent && popup.closed && s.pendingAuthUrl) { api("POST", "/api/tours/cancel", {}).catch(() => {}); popup = null; }
    } catch {}
  }, 300);
  const start = state.start;
  try { state = await api("POST", `/api/tours/${encodeURIComponent(state.tour.id)}/steps/${encodeURIComponent(id)}`, { mode: window ? "window" : "scripted" }); state.start = start; }
  catch (e) { pageError = e.message; }
  finally { clearInterval(watch); running = false; if (popup && !popup.closed && !window) popup.close(); popup = null; }
  const s = state.steps?.find(x => x.id === id);
  if (s?.result) announce(`${s.title}: ${s.result.ok ? "as expected" : "not as expected"}`);
  render();
  $(`[data-step]`)?.focus();
}
async function start(id) {
  try {
    const r = await api("POST", `/api/tours/${encodeURIComponent(id)}/start`, {});
    location.href = `${r.scope.base}/tours?tour=${encodeURIComponent(id)}`;
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
/** Runs every step left, stopping before one a person signs in to themselves. */
async function runRest() {
  for (let s = state.steps.find(x => !x.result); s && !pageError; s = state.steps.find(x => !x.result)) {
    if (s.signsIn && windowMode()) break;
    await runStep(s.id);
    if (!state.steps.find(x => x.id === s.id)?.result) break;
  }
}

document.addEventListener("click", e => {
  const t = e.target.closest("button");
  if (!t) return;
  if (t.dataset.start) start(t.dataset.start);
  else if (t.id === "start") start(state.tour.id);
  else if (t.id === "run-checks") runChecks();
  else if (t.dataset.step) runStep(t.dataset.step);
  else if (t.id === "run-rest") runRest();
});
document.addEventListener("signin-mode", () => { if (inRunner()) render(); });

(async () => {
  try {
    list = await fetch("/api/tours").then(r => r.json());
    if (BASE && chosen()) await refresh();
    wantFocus = !!BASE;
    render();
  } catch (e) { pageError = e.message; render(); }
})();
