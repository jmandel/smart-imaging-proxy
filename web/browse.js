/** The scope this page is in, if any: every request it makes stays there. */
const BASE = location.pathname.match(/^\/s\/[^/]+/)?.[0] ?? "";
// The Browse page. The demo server holds the token and does every request: this page sends choices,
// and shows what comes back.
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const call = async (method, path, body) => {
  const r = await fetch(`${BASE}/api/browse${path}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(b.error ?? `HTTP ${r.status}`);
  return b;
};
const say = text => { $("#announce").textContent = text; };
const bytes = n => {
  const v = Number(n ?? 0);
  return `${shortBytes(v)} (${v.toLocaleString()} bytes)`;
};
const shortBytes = v => {
  const short = v >= 1e9 ? `${(v / 1e9).toFixed(2)} GB` : v >= 1e6 ? `${(v / 1e6).toFixed(1)} MB` : v >= 1e3 ? `${(v / 1e3).toFixed(1)} KB` : `${v} B`;
  return short;
};

let options, view = null, shown = "", timer, popup, popupSent = false, closedPolls = 0, wantFocus = false, pageError = "", backendSet = false, optionsOpen = false;
const choices = { mode: "scripted", app: "portal-app", count: 5, patient: "josh-example", records: {} };

/** A control can be gone or disabled after a re-render, and focus then goes to the results, never to the page. */
function keepFocus(fid) {
  const el = $(`[data-fid="${fid}"]`);
  if (el && !el.disabled) el.focus(); else $("#h-results").focus({ preventScroll: true });
}


function renderPick() {
  const busy = !!view?.running;
  const current = view && (view.who?.id ?? view.start.user ?? view.start.client);
  const viaWords = r => r.via === "self" ? "Own records" : r.via === "guardian" ? `As ${r.relationship ?? "guardian"}` : `Shared, as ${r.relationship ?? "a related person"}`;
  const whoseChoice = (p, r) => `<button class="whose-choice" data-whose="${esc(r.patient)}" data-for="${esc(p.id)}" data-fid="whose-${esc(p.id)}-${esc(r.patient)}" aria-current="${current === p.id && view?.patient === r.patient}" ${busy ? "disabled" : ""}><b>${esc(r.name)}</b><span>${esc(viaWords(r))}</span><span class="sr-only">Sign in again, and search these records</span></button>`;
  const whose = p => p.records.length > 1 ? `<div class="whose" role="group" aria-label="Whose records ${esc(p.first)} opens" data-records="${esc(p.id)}"><span class="whose-label">Whose records</span><div class="whose-choices">${p.records.map(r => whoseChoice(p, r)).join("")}</div>${p.unshared ? `<button class="whose-missing" data-whose-unshared="${esc(p.unshared.patient)}" data-for="${esc(p.id)}" data-fid="whose-${esc(p.id)}-unshared" ${busy ? "disabled" : ""}>${esc(p.unshared.name)} hasn't shared with ${esc(p.first)}</button>` : ""}</div>` : "";
  const person = p => `<li><button class="who" data-user="${esc(p.id)}" data-fid="who-${esc(p.id)}" aria-current="${current === p.id}" ${busy ? "disabled" : ""}><b>${esc(p.name)}</b><span class="role">${esc(p.role)}${p.detail ? `. ${esc(p.detail)}` : ""}</span><span class="sr-only">Sign in and see studies</span></button>${whose(p)}</li>`;
  const client = c => `<li><button class="who" data-client="${esc(c.id)}" data-fid="who-${esc(c.id)}" aria-current="${current === c.id}" ${busy ? "disabled" : ""}><b>${esc(c.id)}</b><span class="role">${esc(c.role)}</span><span class="sr-only">Get a token and search</span></button></li>`;
  const focused = document.activeElement?.dataset?.fid;
  const appName = options.apps.find(a => a.id === choices.app)?.name ?? "";
  $("#pick").innerHTML = `
    <details class="options" id="options" ${optionsOpen ? "open" : ""}><summary>${choices.mode === "scripted" ? "Signs in for you" : "You sign in, in a window"}, to the ${esc(appName)}, ${choices.count} per page</summary><div class="inner">
      <fieldset><legend>How a person signs in</legend>
        <label class="choice"><input type="radio" name="mode" value="scripted" ${choices.mode === "scripted" ? "checked" : ""}> Sign in for me</label>
        <label class="choice"><input type="radio" name="mode" value="window" ${choices.mode === "window" ? "checked" : ""}> Sign in yourself in a real window</label>
      </fieldset>
      <label class="field">App a person signs in to <select id="app">${options.apps.map(a => `<option value="${esc(a.id)}" ${choices.app === a.id ? "selected" : ""}>${esc(a.name)}</option>`).join("")}</select></label>
      <label class="field">Studies per page <select id="count">${options.pageSizes.map(n => `<option ${choices.count === n ? "selected" : ""}>${n}</option>`).join("")}</select></label>
    </div></details>
    <h3>People, who sign in</h3><ul class="who-list">${options.people.map(person).join("")}</ul>
    <h3>Backend clients, which request a token</h3>
    <label class="field clients-for">Searching for <select id="patient">${options.patients.map(p => `<option value="${esc(p.id)}" ${choices.patient === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></label>
    <ul class="who-list">${options.clients.map(client).join("")}</ul>`;
  if (focused) keepFocus(focused);
}

async function loadOptions() {
  options = await call("GET", "/options");
  // Someone can lose a record they chose earlier, such as when a share is revoked.
  for (const p of options.people) if (choices.records[p.id] && !p.records.some(r => r.patient === choices.records[p.id])) delete choices.records[p.id];
  $("#live-link").href = options.traceUrl;
  renderPick();
}

function openPopup() {
  // A popup has to open from the click itself, so it opens before the authorization URL exists.
  popup = window.open("about:blank", "smart-imaging-authorize", "width=600,height=800");
  popupSent = false; closedPolls = 0;
}

async function begin(body) {
  pageError = "";
  if (body.mode === "window") openPopup(); else popup = null;
  say("Starting.");
  wantFocus = true;
  shown = "";
  $("#result").innerHTML = '<div class="panel outcome"><h3><span class="spinner" aria-hidden="true"></span>Starting…</h3></div>';
  document.querySelectorAll("button.who, button.whose-choice, button.whose-missing").forEach(b => { b.disabled = true; });
  try { apply(await call("POST", "/start", body)); poll(); }
  catch (e) {
    popup?.close();
    pageError = e.message;
    shown = ""; render();
  }
}
const startUser = (user, extra = {}) => begin({ user, client: choices.app, mode: choices.mode, count: choices.count, ...(choices.records[user] ? { patient: choices.records[user] } : {}), ...extra });
const startClient = client => begin({ client, patient: choices.patient, count: choices.count });
const again = (extra = {}) => begin({ ...view.start, ...(view.start.user ? { mode: choices.mode } : {}), ...extra });

function poll() {
  if (timer) return;
  timer = setInterval(async () => {
    try {
      const r = await call("GET", "/session");
      apply(r);
      if (!r.session?.running && !r.session?.retrieving) { clearInterval(timer); timer = undefined; if (r.session) loadOptions(); }
    } catch (e) { clearInterval(timer); timer = undefined; pageError = e.message; shown = ""; render(); }
  }, 250);
}

function syncPopup() {
  if (!popup) return;
  if (view?.authUrl) {
    if (!popupSent && !popup.closed) { popup.location = view.authUrl; popupSent = true; }
    // Someone closed the window without finishing. Two polls, since the redirect also closes it.
    if (popup.closed && ++closedPolls >= 2) { popup = null; call("POST", "/cancel", {}).catch(() => {}); }
  } else if (!view?.running) {
    if (!popup.closed && view?.status === "failed") popup.close();
    popup = null;
  }
}

function apply(r) {
  if (r.backend && $("#backend")) $("#backend").value = r.backend;
  if (r.session !== undefined) view = r.session;
  syncPopup();
  render();
}

function render() {
  const { retrievals, retrieving, ...rest } = view ?? {};
  const key = JSON.stringify(rest) + pageError;
  if (key !== shown) {
    shown = key;
    const focused = document.activeElement?.dataset?.fid;
    $("#result").innerHTML = (pageError ? `<p class="error" role="alert">${esc(pageError)}</p>` : "") + (view ? renderView() : EMPTY);
    if (options) renderPick();
    if (focused) keepFocus(focused);
    if (view && !view.running) {
      say(view.headline ?? "Done.");
      if (wantFocus) { wantFocus = false; $("#h-results").focus({ preventScroll: true }); if (innerWidth <= 900) $("#results").scrollIntoView(); }
    }
  }
  renderRetrievals();
}

const EMPTY = '<div class="viewbox-empty"><p>Pick someone, and their studies go up here, from a real sign-in and a real search.</p><div class="ghosts" aria-hidden="true"><i></i><i></i><i></i><i></i></div></div>';
const WAITING_TEXT = "Discovery, PKCE, sign-in, consent, and the code exchange are running against the real services.";
function renderView() {
  const v = view;
  const heading = v.who.asked !== undefined || v.start.user ? `${esc(v.who.name)}, through the ${esc(v.who.app)}${v.whose ? `, for ${esc(v.whose.name)}` : ""}` : `${esc(v.who.name)}, for ${esc(v.whose?.name ?? v.patient ?? "")}`;
  const trace = `<a href="${esc(v.liveUrl)}" target="smart-imaging-live" rel="noopener">Live trace of this session ↗</a>`;
  if (v.status === "signing-in") return `<div class="panel outcome"><h3><span class="spinner" aria-hidden="true"></span>Working on ${heading}</h3><p class="note">${v.start.user ? WAITING_TEXT : "The token request and the search are running against the real services."}</p><p class="links">${trace}</p></div>`;
  if (v.status === "waiting-for-you") return `<div class="panel outcome"><h3><span class="spinner" aria-hidden="true"></span>Waiting for you in the other window</h3>
    <p>Sign in and approve on the Authorization Server's own pages. This page carries on when the window finishes.</p>
    ${popup && !popup.closed ? "" : `<p><a class="button" href="${esc(v.authUrl)}" target="smart-imaging-authorize" rel="opener">Open the sign-in page</a></p><p class="note">No window opened, so open it here.</p>`}
    <div class="actions"><button class="secondary" id="cancel" data-fid="cancel">Stop waiting for this sign-in</button></div><p class="links">${trace}</p></div>`;

  const asked = v.who.asked && v.who.asked !== v.who.id ? `<p class="note">${esc(v.who.name)} signed in, in place of the account you picked.</p>` : "";
  const shares = v.share ? `<div class="panel"><h3>Share from ${esc(v.share.from)}'s account page</h3>
    <fieldset class="tick-list" id="share-sites"><legend>Sites ${esc(v.share.from)} shares</legend>${v.share.sites.map(s => `<label><input type="checkbox" value="${esc(s.name)}" ${s.ticked ? "checked" : ""}> ${esc(s.name)}</label>`).join("")}</fieldset>
    <div class="actions">${v.share.offers.map(o => `<button class="primary" data-share="${esc(o.delegate)}" data-fid="share-${esc(o.delegate)}">${esc(o.label)}</button>`).join("")}</div>
    <p class="note">This submits the real account page as ${esc(v.share.from)}, then signs the person in again.</p></div>` : "";
  const narrow = v.appSites?.sites.length ? `<details class="raw panel"><summary>Sign in again, and give the ${esc(v.who.app)} only some sites</summary>
    <fieldset class="tick-list" id="app-sites"><legend>Sites the app can see</legend>${v.appSites.sites.map(s => `<label><input type="checkbox" value="${esc(s)}" ${v.appSites.granted.includes(s) ? "checked" : ""}> ${esc(s)}</label>`).join("")}</fieldset>
    <div class="actions"><button class="secondary" id="narrow" data-fid="narrow">Sign in again with these sites</button></div></details>` : "";
  const signIn = v.status === "token-rejected" ? `<div class="actions"><button class="primary" id="again" data-fid="again">Sign in again</button></div>` : v.status === "failed" || v.status === "forbidden" || v.status === "denied" ? `<div class="actions"><button class="secondary" id="again" data-fid="again">${v.start.user ? "Sign in again" : "Request a token and search again"}</button></div>` : "";

  return `<div class="panel outcome ${esc(v.status)}">
      ${v.whose ? `<p class="whose-line" data-whose-shown="${esc(v.whose.patient)}">${esc(v.whose.plain)}</p>` : ""}
      <h3>${esc(v.headline ?? "")}</h3>
      <p class="note">${heading}</p>${asked}
      ${v.detail ? `<p>${esc(v.detail)}</p>` : ""}
      ${v.explain ? `<p><b>Why this list:</b> ${esc(v.explain.chain)}.</p>` : ""}
      ${signIn}
      <p class="links">${trace}${v.accounts.map(a => `<a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.label)} ↗</a>`).join("")}</p>
      ${v.ruleHelp ? `<p>${esc(v.ruleHelp.text)}</p><p class="links"><a href="${esc(v.ruleHelp.url)}">Rules on the admin screen</a></p>` : ""}
    </div>${shares}${studies()}${narrow}${steps()}${serverView()}`;
}

// A frame draws its series from the search result: more instances, a larger exposure and finer rules.
const exposure = n => Math.min(1, Math.log10(Math.max(1, Number(n))) / 3).toFixed(2);
const rule = n => Math.max(2, Math.round(26 - 8 * Math.log10(Math.max(1, Number(n)))));
function studies() {
  const v = view, p = v.page;
  if (v.status !== "results") return "";
  const pager = `<div class="panel pager"><span class="where">${p.total ? `Studies ${p.first}–${p.last} of ${p.total}, page ${p.number}` : `Total ${p.total ?? 0}`}</span>
    <button class="secondary" data-to="first" data-fid="to-first" ${p.hasPrevious && !v.searching ? "" : "disabled"}>First page</button>
    <button class="secondary" data-to="previous" data-fid="to-previous" ${p.hasPrevious && !v.searching ? "" : "disabled"}>Previous page</button>
    <button class="primary" data-to="next" data-fid="to-next" ${p.hasNext && !v.searching ? "" : "disabled"}>Next page</button>
    <button class="secondary" data-to="again" data-fid="to-again" ${v.searching ? "disabled" : ""}>Search again</button>
    <label>Per page <select id="page-size" data-fid="page-size">${options.pageSizes.map(n => `<option ${p.count === n ? "selected" : ""}>${n}</option>`).join("")}</select></label></div>`;
  const frame = f => f.withheld
    ? `<li class="frame withheld" title="Series ${esc(f.number)} withheld"><span class="mod">${esc(f.modality)}</span><span class="no">${esc(f.number)}</span><span class="gone">withheld</span><span class="count">${esc(f.instances)}</span></li>`
    : `<li class="frame" data-mod="${esc(f.modality)}" title="${esc(f.description ?? `Series ${f.number}`)}: ${esc(f.instances)} ${f.instances === 1 ? "instance" : "instances"}"><span class="exposure" style="--n:${exposure(f.instances)};--rule:${rule(f.instances)}px"></span><span class="mod">${esc(f.modality)}</span><span class="no">${esc(f.number)}</span><span class="count">${esc(f.instances)}</span></li>`;
  const frames = s => [...(s.seriesList ?? []), ...s.withheld.map(x => ({ number: x.number, modality: x.modality, instances: x.instanceCount, withheld: true }))].sort((a, b) => Number(a.number) - Number(b.number));
  const study = s => `<article class="study" data-study="${esc(s.id)}">
    <div class="sheet">
      <h3>${esc(s.description ?? s.title ?? s.id)}</h3>
      ${s.title && s.title !== s.description ? `<p class="title">${esc(s.title)}</p>` : ""}
      ${frames(s).length ? `<ol class="frames" aria-label="Series">${frames(s).map(frame).join("")}</ol>` : ""}
    </div>
    <div class="plate">
    <dl class="facts">
      <div><dt>Date</dt><dd>${esc(s.date ?? "not recorded")}</dd></div>
      <div><dt>Site, from the catalog</dt><dd>${esc(s.site ?? "none on file")}</dd></div>
      <div><dt>Modality</dt><dd>${esc(s.modalities.join(", ") || "none listed")}</dd></div>
      <div><dt>Series</dt><dd>${esc(s.series ?? "none listed")}</dd></div>
      <div><dt>Instances</dt><dd>${esc(s.instances ?? "none listed")}</dd></div>
      ${s.status === "available" ? "" : `<div><dt>Status</dt><dd>${esc(s.status)}</dd></div>`}
    </dl>
    ${s.withheld.length ? `<p class="withheld-note">${s.withheld.length} series withheld from this client. The hatched frames show what policy holds back, which only this demo's view of the server can see.</p>` : ""}
    ${s.context ? `<p class="context"><b>Signed context:</b> ${esc(s.context.plain)}.</p>` : ""}
    ${s.retrievable ? `<div class="actions"><button class="secondary" data-retrieve="${esc(s.id)}" data-zstd="1" data-fid="z-${esc(s.id)}">Retrieve with zstd</button><button class="secondary" data-retrieve="${esc(s.id)}" data-zstd="0" data-fid="i-${esc(s.id)}">Retrieve without zstd</button><a href="${BASE}/api/browse/metadata?study=${encodeURIComponent(s.id)}" target="_blank" rel="noopener">View metadata ↗</a></div>` : `<p class="note">This study has no Endpoint, so there's nothing to retrieve yet.</p>`}
    <div class="slot" data-slot="${esc(s.id)}"></div>
    </div>
  </article>`;
  return `${pager}${p.studies.map(study).join("")}${p.studies.length > 2 ? pager.replace(/data-fid="[^"]*"/g, "").replace('id="page-size"', 'data-page-size') : ""}
    <details class="raw panel" id="raw"><summary>Raw FHIR Bundle for this page</summary><p class="links"><a href="${BASE}/api/browse/bundle" target="_blank" rel="noopener">Open in a new tab ↗</a></p><pre id="raw-text">Loading…</pre></details>`;
}

function steps() {
  const v = view;
  if (!v.steps.length) return "";
  return `<details class="steps panel"><summary>Requests behind this (${v.steps.length})</summary><ul class="step-rows">${v.steps.map(s => `<li><span class="status ${typeof s.status === "number" && s.status < 400 ? "ok" : "err"}">${esc(s.status)}</span><span>${esc(s.title)}${s.ms !== undefined ? ` <span class="ms">${esc(s.ms)} ms</span>` : ""}</span></li>`).join("")}</ul></details>`;
}

function serverView() {
  const v = view;
  if (v.explainError) return `<div class="panel server-view"><h3>The Imaging Server's view: an app never sees this</h3><p class="error">The demo couldn't read it: ${esc(v.explainError)}</p></div>`;
  if (!v.explain) return "";
  const rows = v.explain.studies;
  const released = rows.filter(r => r.released).length;
  return `<div class="panel server-view"><h3>The Imaging Server's view: an app never sees this</h3>
    <p class="note">Only this demo can see this panel. It runs the same policy evaluation as search over every study for ${esc(v.explain.patientName)}, using the demo's service credential.</p>
    ${rows.length ? `<p class="tally"><b>${released} of ${rows.length}</b> released.</p><ul class="view-rows">${rows.map(r => `<li><span class="tag ${r.released ? "good" : "bad"}">${esc(r.releaseLabel)}</span> <b>${esc(r.title ?? r.description ?? r.id)}</b>, ${esc(r.site ?? "no site")}<span class="why">${esc(r.reason)}.</span>${r.chain.length ? `<span class="why">Chain: ${r.chain.map(esc).join(" → ")}</span>` : ""}</li>`).join("")}</ul>` : `<p>The catalog holds no studies for ${esc(v.explain.patientName)}.</p>`}
  </div>`;
}

function renderRetrievals() {
  const v = view;
  if (!v) return;
  for (const slot of document.querySelectorAll("[data-slot]")) {
    const mine = (v.retrievals ?? []).filter(r => r.study === slot.dataset.slot);
    const html = mine.map(renderRetrieval).join("");
    if (slot.dataset.html !== html) { slot.innerHTML = html; slot.dataset.html = html; }
  }
  // aria-disabled, since a disabled button would lose keyboard focus while the retrieval runs.
  for (const b of document.querySelectorAll("[data-retrieve]")) b.setAttribute("aria-disabled", String(!!v.retrieving));
}
function renderRetrieval(r) {
  const label = r.mode === "zstd" ? "With zstd" : "Without zstd";
  const most = Math.max(Number(r.wireBytes ?? 0), Number(r.decodedBytes ?? 0), 1);
  const bar = (name, n, cls = "") => `<span>${name}</span><span><i class="${cls}" style="width:${(100 * Number(n ?? 0) / most).toFixed(1)}%"></i></span><span class="v" title="${esc(bytes(n))}">${esc(shortBytes(Number(n ?? 0)))}</span>`;
  const ok = r.status >= 200 && r.status < 300;
  const head = r.running && !r.status ? `<span class="spinner" aria-hidden="true"></span>${label}: requesting…` : `${r.running ? '<span class="spinner" aria-hidden="true"></span>' : ""}${label}: <span class="status ${ok ? "ok" : "err"}">${esc(r.status ?? "no response")}</span>`;
  return `<div class="retrieved"><h4>${head}</h4>
    ${r.error ? `<p class="error">${esc(r.error)}</p>` : ""}
    ${r.status === 401 ? `<p class="error">This token no longer works. Sign in again.</p>` : ""}
    ${r.denial ? `<p class="note">The proxy reported: ${esc(r.denial)}</p>` : ""}
    <p class="context"><b>How the proxy authorized it:</b> ${esc(r.authzPlain ?? "not reported yet")}.</p>
    <div class="wire">${bar("On the wire", r.wireBytes, "on-wire")}${bar("Decoded", r.decodedBytes)}</div>
    <dl class="facts">
      <div><dt>Parts</dt><dd>${esc(r.parts)}</dd></div>
      <div><dt>Syntaxes</dt><dd>${r.syntaxes.map(s => `<code>${esc(s)}</code>`).join(" ") || "none"}</dd></div>
      <div><dt>DICOM in the parts</dt><dd>${esc(bytes(r.dicomBytes))}</dd></div>
      <div><dt>Content-Encoding</dt><dd>${esc(r.encoding ?? "not reported yet")}</dd></div>
      <div><dt>Closing boundary</dt><dd>${r.running ? "reading…" : r.complete ? "received" : "not received"}</dd></div>
      ${r.ms !== undefined ? `<div><dt>Time</dt><dd>${esc(r.ms)} ms</dd></div>` : ""}
    </dl>
    ${r.traceUrl ? `<p class="links"><a href="${esc(r.traceUrl)}" target="_blank" rel="noopener">This retrieval's trace ↗</a></p>` : ""}</div>`;
}

const ticked = id => [...document.querySelectorAll(`#${id} input:checked`)].map(i => i.value);

document.addEventListener("click", async e => {
  const t = e.target.closest("button");
  if (!t || t.disabled || t.getAttribute("aria-disabled") === "true") return;
  try {
    if (t.dataset.user) startUser(t.dataset.user);
    else if (t.dataset.whose) { choices.records[t.dataset.for] = t.dataset.whose; startUser(t.dataset.for); }
    else if (t.dataset.whoseUnshared) startUser(t.dataset.for, { patient: t.dataset.whoseUnshared });
    else if (t.dataset.client) startClient(t.dataset.client);
    else if (t.dataset.share) { const d = t.dataset.share; choices.records[d] = view.share.patient; startUser(d, { share: { delegate: d, sites: ticked("share-sites") } }); }
    else if (t.id === "again") again();
    else if (t.id === "narrow") again({ sites: ticked("app-sites") });
    else if (t.id === "cancel") { popup?.close(); popup = null; apply(await call("POST", "/cancel", { stopped: true })); }
    else if (t.dataset.to) {
      document.querySelectorAll("[data-to]").forEach(b => { b.setAttribute("aria-disabled", "true"); });
      apply(await call("POST", "/page", { to: t.dataset.to }));
    } else if (t.dataset.retrieve) {
      apply(await call("POST", "/retrieve", { study: t.dataset.retrieve, zstd: t.dataset.zstd === "1" }));
      poll();
    }
  } catch (err) { pageError = err.message; shown = ""; render(); }
});
document.addEventListener("change", async e => {
  const t = e.target;
  if (t.name === "mode") { choices.mode = t.value; renderPick(); }
  else if (t.id === "app") { choices.app = t.value; renderPick(); }
  else if (t.id === "count") { choices.count = Number(t.value); renderPick(); }
  else if (t.id === "patient") choices.patient = t.value;
  else if (t.id === "page-size" || t.dataset.pageSize !== undefined) {
    try { apply(await call("POST", "/page", { count: Number(t.value) })); }
    catch (err) { pageError = err.message; shown = ""; render(); }
  } else if (t.id === "backend") {
    try {
      const r = await fetch(`${BASE}/api/backend`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ backend: t.value }) });
      if (!r.ok) throw new Error((await r.json()).error);
      if (view?.status === "results") apply(await call("POST", "/page", { to: "again" }));
      await loadOptions();
    } catch (err) { pageError = err.message; shown = ""; render(); }
  }
});
// The Bundle can be large, so it's read when opened. A toggle doesn't bubble, so this listens in capture.
document.addEventListener("toggle", async e => {
  if (e.target.id === "options") optionsOpen = e.target.open;
  if (e.target.id !== "raw" || !e.target.open || e.target.dataset.loaded) return;
  e.target.dataset.loaded = "1";
  const r = await fetch(`${BASE}/api/browse/bundle`);
  $("#raw-text").textContent = await r.text();
}, true);
// Someone may have shared on an account page in another tab, which changes whose records a person holds.
addEventListener("focus", () => { if (!timer) call("GET", "/session").then(apply).then(loadOptions).catch(() => {}); });

(async () => {
  try {
    const [s, b] = await Promise.all([call("GET", "/session"), fetch(`${BASE}/api/backends`).then(r => r.json())]);
    await loadOptions();
    $("#backend").innerHTML = b.backends.map(x => `<option value="${esc(x.name)}" ${x.name === b.current ? "selected" : ""}>${esc(x.name)}${x.ok ? "" : " (unavailable)"}</option>`).join("");
    apply(s);
    if (s.session?.running || s.session?.retrieving) poll();
  } catch (e) { $("#pick").innerHTML = `<p class="error" role="alert">${esc(e.message)}</p>`; }
})();
