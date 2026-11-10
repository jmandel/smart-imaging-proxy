// Tours, the home page: six stories as cards, each drawing the layer chain it ends on. Choosing one
// starts it in a sandbox of its own and opens its step runner there. Each step is an action this page
// takes, as an app or a person would: a real sign-in, a search, a retrieval with its own token, or a
// change through the sandbox's management API. The sandbox plans each step and says beforehand what the
// reference model expects, and the step passes when what this page saw matches. The protocol checks sit below.
let list, state = null, running = false, wantFocus = false, pageError = "";
const checks = {};
const params = () => new URLSearchParams(location.search);
const chosen = () => params().get("tour") ?? list?.current;
const windowMode = () => signInMode() === "window";

function checksHtml() {
  const done = Object.values(checks).filter(c => c.ok !== undefined), busy = Object.values(checks).some(c => c.running);
  return `<section class="checks-panel" aria-labelledby="h-checks"><h2 id="h-checks">Checks against the guide</h2>
      <p class="note">This demo follows the SMART Imaging Access guide, a published standard for how apps and services get medical images. Each check below acts out one situation the guide covers and says whether the demo did what the guide asks.</p>
      <div class="row"><button type="button" class="secondary" id="run-checks" ${busy ? "disabled" : ""}>Run all checks</button>
        ${busy ? `<span class="note" role="status">${done.length} of ${list.checks.length} run</span>` : done.length ? `<span class="${done.every(c => c.ok) ? "verdict ok" : "verdict bad"}" role="status">${done.filter(c => c.ok).length} of ${done.length} passed</span>` : ""}</div>
      <ul class="check-list">${list.checks.map(c => { const r = checks[c.id]; return `<li><span class="verdict ${r?.ok ? "ok" : r?.ok === false ? "bad" : ""}">${r?.running ? '<span class="spinner" aria-hidden="true"></span>' : r ? (r.ok ? "Pass" : "Fail") : ""}</span><span class="check-what"><b>${esc(c.title)}</b><span>${esc(c.summary)}</span></span>${r?.activityUrl ? `<a href="${esc(r.activityUrl)}">Activity log</a>` : ""}${r?.failures?.length ? `<span class="fail-detail">${r.failures.map(f => esc(`${f.step}: ${f.label}${f.detail ? ` (${f.detail})` : ""}`)).join("<br>")}</span>` : ""}</li>`; }).join("")}</ul>
    </section>`;
}

// The home page: who's who, then a card per story, on film, with the chain it ends on.
function homeHtml() {
  const has = k => list.tours.some(t => t.chains.some(c => c.chain.columns.some(x => x[k])));
  const locked = has("locked"), cited = has("cited");
  const linked = list.tours.some(t => t.chains.some(c => c.chain.rows.some(r => r.kind === "links" && r.has.length)));
  return `<div class="home-head"><h1 id="tour-title" tabindex="-1">Tours</h1><a href="/explore">Explore on your own</a></div>
    ${pageError ? `<p class="error" role="alert">${esc(pageError)}</p>` : ""}
    <section class="cast" aria-labelledby="h-cast"><h2 id="h-cast">Who's who</h2><dl>${list.cast.map(c => `<div><dt>${esc(c.name)}</dt><dd>${esc(c.line)}</dd></div>`).join("")}</dl></section>
    <section class="key film" aria-labelledby="h-key"><h2 id="h-key">Reading the diagrams</h2>${Layers.legend({ locked, cited, linked, film: true })}</section>
    <ul class="stories">${list.tours.map(t => `<li class="story">
      <h2><button type="button" class="story-go" data-start="${esc(t.id)}">${esc(t.title)}</button></h2>
      <p>${esc(t.premise)}</p>
      ${Layers.chains(t.chains, { film: true, label: `${t.title}: why the app sees what it sees` })}
</li>`).join("")}</ul>
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
    <span class="what"><b>${esc(s.title)}</b><span>${esc(s.actor)}</span>${next && s.expect ? `<span class="expect">${s.expectItems ? studyList(s.expectItems, `Expected: ${s.expect}`) : `Expected: ${esc(s.expect)}`}</span>` : ""}</span>
    ${r ? `<span class="verdict ${r.ok ? "ok" : "bad"}">${r.ok ? "As expected" : r.stopped ? "Stopped" : "Not as expected"}</span>` : next ? `<button type="button" class="primary" data-step="${esc(s.id)}" ${running ? "disabled" : ""}>${running ? "Running…" : label}</button>` : "<span></span>"}
    ${r ? `<dl class="compare">${r.expected ? `<dt>Expected</dt><dd>${r.expectedItems ? studyList(r.expectedItems, r.expected) : esc(r.expected)}</dd>` : ""}<dt>Got</dt><dd>${r.actualItems ? studyList(r.actualItems, r.actual) : esc(r.actual)}</dd>${r.detail ? `<dt>Technical detail</dt><dd class="tech">${esc(r.detail)}</dd>` : ""}${r.write ? `<dt>Policy written</dt><dd>${esc(r.write)}</dd>` : ""}</dl>
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
  const locked = latest.columns.some(x => x.locked);
  const caption = doneAt < 0 ? "At the start, before any step runs" : doneAt === steps.length - 1 ? "Where the story ends" : `After step ${doneAt + 1}: ${steps[doneAt].title}`;
  // A story about a change shows its panels, from the server, once the change has run.
  const body = state.panels ? Layers.chains(state.panels) : `<p class="ly-pane-label">${esc(caption)}</p>${Layers.chain(latest)}`;
  const linked = (state.panels ?? []).some(p => p.chain.rows.some(r => r.kind === "links" && r.has.length));
  return `<div class="tour-chain"><h2 class="sr-only">Why the app sees what it sees</h2>${body}${Layers.legend({ locked, cited: latest.columns.some(x => x.cited), linked })}</div>`;
}

function runnerHtml() {
  if (pageError) return `<h1 id="tour-title" tabindex="-1">Something went wrong</h1><p class="error" role="alert">${esc(pageError)}</p>`;
  const steps = state.steps, left = steps.filter(s => !s.result).length;
  return `<div class="tour-head"><h1 id="tour-title" tabindex="-1">${esc(state.tour.title)}</h1><p>${esc(state.tour.summary)}</p>${state.tour.detail ? `<details class="tech-detail"><summary>Technical detail</summary><p>${esc(state.tour.detail)}</p></details>` : ""}</div>
    ${standingHtml()}
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

async function refresh() { state = await api("GET", `/api/sandbox/tours/state?tour=${encodeURIComponent(chosen() ?? "")}`); state.start ??= state.chain; }

// The tour's client: it holds each person's token, and the service's, and nothing else keeps them.
let client;
/** What this page does for a step, as planned, under the tour's session and the step's trace. */
async function perform(plan, session, trace, popup) {
  if (client?.session !== session) client = sandboxClient(BASE, session);
  const tokenOf = user => { if (!client.tokens[user]) throw new Error("An earlier step has to sign in first."); return client.tokens[user]; };
  const found = s => ({ status: s.status, studies: s.studies.map(({ id, uid, base }) => ({ id, uid, base })) });
  switch (plan.do) {
    case "sign-in": { const t = await client.signIn({ ...plan, popup }, trace); delete t.accessToken; return t; }
    case "search": return found(await client.search(tokenOf(plan.as), plan.query, trace, APP_LAUNCH));
    case "retrieve": return { status: (await client.retrieve(tokenOf(plan.as), plan.url, trace)).status };
    case "service-search": return found(await client.search(await client.serviceToken(plan.client, trace), plan.query, trace, BACKEND_CAPABILITY));
    case "service-retrieve": return { status: (await client.retrieve(await client.serviceToken(plan.client, trace), plan.url, trace)).status };
    case "referral-check": return { ok: !!plan.patientRef?.startsWith(`${plan.clinicalFhir}/Patient/`) };
    case "management": {
      const statuses = [];
      for (const c of plan.calls) { try { await client.manage(c.method, `/api/sandbox/policy${c.path}`, c.body, trace); statuses.push(200); } catch (e) { statuses.push(e.status ?? 0); } }
      return { statuses };
    }
    default: return {};
  }
}
async function runStep(id) {
  running = true;
  const step = state.steps.find(s => s.id === id), tour = state.tour.id;
  // The window opens from the Sign in click itself, before its address is known.
  const popup = windowMode() && step?.signsIn ? open("about:blank", "smart-imaging-authorize", "width=600,height=800") : undefined;
  render();
  const start = state.start, path = `/api/sandbox/tours/${encodeURIComponent(tour)}/steps/${encodeURIComponent(id)}`;
  try {
    const b = await api("POST", `${path}/begin`, {});
    if (b.state) state = b.state;
    else state = await api("POST", `${path}/finish`, { seen: await perform(b.plan, b.session, b.trace, popup) });
    state.start = start;
  } catch (e) { pageError = e.message; }
  finally { running = false; if (popup && !popup.closed) popup.close(); }
  const s = state.steps?.find(x => x.id === id);
  if (s?.result) announce(`${s.title}: ${s.result.ok ? "as expected" : "not as expected"}`);
  render();
  $(`[data-step]`)?.focus();
}
async function start(id) {
  try {
    // In a sandbox, the tour starts it over; from the root, the tour gets a sandbox of its own.
    const r = BASE ? await api("POST", `/api/sandbox/tours/${encodeURIComponent(id)}/start`, {}) : await fetch(`/api/tours/${encodeURIComponent(id)}/start`, { method: "POST" }).then(x => x.json());
    client = undefined;
    location.href = `${r.sandbox.base}/tours?tour=${encodeURIComponent(id)}`;
  } catch (e) { pageError = e.message; render(); }
}
async function runChecks() {
  for (const c of list.checks) checks[c.id] = { running: true };
  render();
  for (const c of list.checks) {
    try { checks[c.id] = await runPageCheck(c.id, c.title); }
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
