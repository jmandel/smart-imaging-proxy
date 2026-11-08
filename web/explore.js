// Explore: pick a person or a service, and see what they can see, from a real sign-in and a real
// search the demo server runs. The server holds the token: this page sends choices and shows answers.
let options, view = null, shown = "", timer, popup, popupSent = false, closedPolls = 0, wantFocus = false, pageError = "";
let open = null, chain = null, form = null, mode = "scripted";
const picked = { records: {}, referral: {} };
/** Each service's referrals, asked for once that service is chosen. */
const referralsFor = {}, askedReferrals = new Set();
async function loadReferrals(service) {
  askedReferrals.add(service);
  try { referralsFor[service] = (await api("GET", `/api/explore/referrals?service=${encodeURIComponent(service)}`)).referrals; }
  catch (e) { askedReferrals.delete(service); pageError = e.message; }
  render(true);
}

function whoHtml() {
  const busy = !!view?.running;
  const current = view?.who?.kind === "user" ? view.who.asked : view?.who?.id;
  const person = p => `<li><button type="button" class="person" data-user="${esc(p.id)}" aria-pressed="${current === p.id}" ${busy ? "disabled" : ""}><b>${esc(p.name)}</b><span>${esc(p.role)}${p.detail ? `, ${esc(p.detail.toLowerCase())}` : ""}</span></button></li>`;
  const service = s => `<li><button type="button" class="person" data-client="${esc(s.id)}" aria-pressed="${current === s.id}" ${busy ? "disabled" : ""}><b>${esc(s.name)}</b><span>${esc(s.role)}</span></button></li>`;
  // On a phone, one select stands in for both lists.
  const opt = (v, label) => `<option value="${esc(v)}" ${current && v.endsWith(`:${current}`) ? "selected" : ""}>${esc(label)}</option>`;
  const select = `<div class="who-select"><label>Who's looking<select id="who-select" ${busy ? "disabled" : ""}>${current ? "" : `<option value="">Choose someone</option>`}<optgroup label="People">${options.people.map(p => opt(`user:${p.id}`, `${p.name}, ${p.role.toLowerCase()}`)).join("")}</optgroup><optgroup label="Services">${options.services.map(s => opt(`client:${s.id}`, s.name)).join("")}</optgroup></select></label></div>`;
  return `${select}<section aria-labelledby="h-people"><h2 id="h-people">People</h2><ul>${options.people.map(person).join("")}</ul></section>
    <section aria-labelledby="h-services"><h2 id="h-services">Services</h2><ul>${options.services.map(service).join("")}</ul></section>
    <fieldset class="mode"><legend>Signing in</legend>
      <label><input type="radio" name="mode" value="scripted" ${mode === "scripted" ? "checked" : ""}> Done for you</label>
      <label><input type="radio" name="mode" value="window" ${mode === "window" ? "checked" : ""}> Yourself, in a window</label></fieldset>`;
}
function renderWho() {
  const active = document.activeElement;
  const focused = active?.closest?.("#who") ? (active.id === "who-select" ? "who-select" : active.dataset.user ?? active.dataset.client) : undefined;
  $("#who").innerHTML = whoHtml();
  if (focused === "who-select") $("#who-select")?.focus();
  else if (focused) $(`#who [data-user="${CSS.escape(focused)}"], #who [data-client="${CSS.escape(focused)}"]`)?.focus();
}

async function loadOptions() {
  options = await api("GET", "/api/explore/options");
  renderWho();
}

const sheetHtml = s => {
  const mod = s.modalities?.[0] ?? "OT";
  const slot = `<div class="thumb" ${s.released && s.thumb ? `data-study="${esc(s.id)}" data-label="${esc(s.title)}"` : ""} aria-hidden="${s.released && s.thumb ? "false" : "true"}"><span class="placeholder">${esc(mod)}</span></div>`;
  const inner = `${slot}<span class="top"><span class="modality">${esc((s.modalities ?? [mod]).join(" "))}</span><span class="date">${esc(studyDate(s.date))}</span></span>
    <span class="title">${esc(s.title)}</span>${s.site ? `<span class="site">${esc(s.site)}</span>` : ""}
    <span class="status ${s.partial ? "partial" : ""}">${s.released ? esc(s.partial ? `Released, ${s.partial}` : `${plural(s.instanceCount ?? 0, "image")} in ${plural(s.seriesCount ?? 0, "series", "series")}`) : `Withheld: ${esc(s.reason)}`}</span>`;
  return s.released ? `<li><button type="button" class="sheet" data-open="${esc(s.id)}" aria-label="Open ${esc(s.title)}">${inner}</button></li>` : `<li><div class="sheet withheld">${inner}</div></li>`;
};

function whoseHtml() {
  if (!view || view.who.kind !== "user") {
    if (view?.who.kind === "service") {
      const chosen = picked.referral[view.who.id] ?? view.who.referral;
      const referrals = referralsFor[view.who.id];
      if (!referrals) { if (!askedReferrals.has(view.who.id)) loadReferrals(view.who.id); return ""; }
      return `<div class="whose" role="group" aria-label="Referral"><span>Referral</span>${referrals.map(r => `<button type="button" class="chip-choice" data-referral="${esc(r.id)}" aria-pressed="${chosen === r.id}" ${view.running ? "disabled" : ""} title="${esc(r.reason)}">${esc(r.report)}${r.patient ? `, ${esc(r.patient.split(" ")[0])}` : ""}</button>`).join("")}</div>`;
    }
    return "";
  }
  const p = options.people.find(x => x.id === view.who.asked);
  if (!p) return "";
  const choices = [...p.records.map(r => ({ patient: r.patient, label: r.via === "self" ? "Own records" : `${r.name.split(" ")[0]}, ${r.via === "guardian" ? "as guardian" : `shared, as ${r.relationship}`}` })), ...p.others.map(o => ({ patient: o.patient, label: `${o.name.split(" ")[0]}, not shared` }))];
  if (choices.length < 2) return "";
  return `<div class="whose" role="group" aria-label="Whose records"><span>Whose records</span>${choices.map(c => `<button type="button" class="chip-choice" data-whose="${esc(c.patient)}" aria-pressed="${view.patient === c.patient}" ${view.running ? "disabled" : ""}>${esc(c.label)}</button>`).join("")}</div>`;
}

function actionButton(a, i) { return `<button type="button" class="${a.kind === "revoke-app" || a.kind === "unshare" ? "secondary" : i === 0 && a.kind !== "approve" ? "primary" : "secondary"}" data-action="${i}" data-from="${a.where ?? "actions"}">${esc(a.label)}</button>`; }
function formHtml() {
  if (!form) return "";
  const a = form.action;
  const ticks = (sites, ticked) => `<fieldset><legend>Sites</legend><div class="ticks">${sites.map(s => `<label><input type="checkbox" name="site" value="${esc(s)}" ${ticked.includes(s) ? "checked" : ""}> ${esc(s)}</label>`).join("") || `<span class="note">No sites to choose.</span>`}</div></fieldset>`;
  if (a.kind === "approve") return `<form class="form" id="action-form"><p class="eyebrow">A new sign-in, approving the ${esc(options.app)} for the sites ticked</p>${ticks(a.sites, a.ticked ?? a.sites)}<div class="buttons"><button class="primary" type="submit">Sign in and approve</button><button class="secondary" type="button" data-cancel-form>Cancel</button></div></form>`;
  if (a.kind === "share") return `<form class="form" id="action-form"><p class="eyebrow">On ${esc(options.names[`user:${a.from}`] ?? a.from)}'s account page</p>
    ${a.with ? "" : `<label class="field">Share with <select name="with">${a.people.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("")}</select></label>`}
    <label class="field">As their <select name="relationship">${options.relationships.map(r => `<option>${esc(r)}</option>`).join("")}</select></label>
    ${ticks(a.sites, a.sites)}<div class="buttons"><button class="primary" type="submit">Share</button><button class="secondary" type="button" data-cancel-form>Cancel</button></div></form>`;
  return "";
}

function viewHtml() {
  if (pageError && !view) return `<div class="headline"><h1 id="headline" tabindex="-1">Something went wrong</h1></div><p class="error" role="alert">${esc(pageError)}</p>`;
  if (!view) return `<div class="headline"><h1 id="headline" tabindex="-1">Pick someone to see what they can see</h1></div>
    <div class="empty"><p>Each choice is a real sign-in and search against the Authorization Server, the Imaging Server and the proxy. The activity log records every step.</p></div>`;
  if (view.running) return `${whoseHtml()}<div class="headline"><h1 id="headline" tabindex="-1"><span class="spinner" aria-hidden="true"></span>${view.authUrl ? "Waiting for you in the sign-in window" : view.who.kind === "user" ? `Signing ${esc(view.who.first)} in and searching` : "Working from the referral"}</h1></div>
    ${view.authUrl ? `<div class="empty"><p>Sign in and approve in the window that opened. <a href="${esc(view.authUrl)}" target="smart-imaging-authorize" rel="opener">Open it again</a></p><button type="button" class="secondary" id="stop-waiting">Stop waiting</button></div>` : ""}`;
  if (open) return studyHtml();
  const empty = view.empty ? `<div class="empty"><p>${esc(view.empty.text)}</p>${view.empty.actions.map((a, i) => actionButton({ ...a, where: "empty" }, i)).join("")}</div>` : "";
  return `${whoseHtml()}
    <div class="headline"><h1 id="headline" tabindex="-1">${esc(view.headline ?? "")}</h1>
      ${view.why?.length ? `<ul class="chips" aria-label="Why">${view.why.map(c => `<li class="${esc(c.level)}"><span class="sr-only">${esc(c.level)}: </span>${esc(c.text)}</li>`).join("")}</ul>` : ""}
      ${view.detail ? `<p class="note">${esc(view.detail)}</p>` : ""}</div>
    ${pageError ? `<p class="error" role="alert">${esc(pageError)}</p>` : ""}
    ${view.sheets?.length ? `<ul class="sheets" aria-label="Studies">${view.sheets.map(sheetHtml).join("")}</ul>` : ""}
    ${empty}${formHtml()}
    <div class="actions">${(view.actions ?? []).map((a, i) => actionButton(a, i)).join("")}<span class="note"><a href="${esc(view.activityUrl)}">See it in the activity log</a></span></div>`;
}

function studyHtml() {
  const s = view.sheets.find(x => x.id === open);
  const r = view.retrievals?.find(x => x.study === open);
  return `<button type="button" class="back" id="back">Back to ${esc(view.who.kind === "user" && view.patientName ? `${view.patientName.split(" ")[0]}'s studies` : "the studies")}</button>
  <div class="study-open">
      <div class="study-hero">
        <div class="thumb" data-study="${esc(s.id)}" data-label="${esc(s.title)}"><span class="placeholder">${esc(s.modalities?.[0] ?? "")}</span></div>
        <span class="meta">${esc([(s.modalities ?? []).join(" "), studyDate(s.date), s.site, `${plural(s.instanceCount ?? 0, "image")} in ${plural(s.seriesCount ?? 0, "series", "series")}`, s.partial].filter(Boolean).join(" · "))}</span>
        <h2 id="headline" tabindex="-1">${esc(s.title)}</h2>
        <ul class="series-list">${s.series.map(x => `<li>${esc(x.modality)} ${esc(x.description ?? `Series ${x.number}`)}, ${plural(x.instances, "image")}</li>`).join("")}</ul>
      </div>
      <div><button type="button" class="primary" id="retrieve" ${r?.running ? "disabled" : ""}>${r ? (r.running ? "Retrieving…" : "Retrieve again") : "Retrieve the whole study"}</button></div>
      ${r ? `<div class="retrieval"><h3>${r.running ? "Retrieving" : r.status === 200 && r.complete ? "Retrieved" : `The proxy answered ${esc(r.status ?? "nothing")}`}</h3><dl>
        <dt>Parts</dt><dd>${esc(r.parts)}</dd><dt>On the wire</dt><dd>${esc(bytes(r.wireBytes))}${r.encoding === "zstd" ? ", zstd" : ""}</dd><dt>DICOM</dt><dd>${esc(bytes(r.dicomBytes))}</dd>
        ${r.authz ? `<dt>Decided</dt><dd>${esc(r.authz === "instant" ? "from the signed link, with no call" : r.authz === "cached" ? "from a cached decision" : "by asking the Imaging Server")}</dd>` : ""}
        ${r.ms !== undefined ? `<dt>Took</dt><dd>${esc(r.ms)} ms</dd>` : ""}${r.error ? `<dt>Problem</dt><dd class="error">${esc(r.error)}</dd>` : ""}</dl></div>` : ""}
    <p class="chain" id="chain">${chain ? `${esc(chain.line)} <a href="${esc(chain.activityUrl)}">See it in the activity log</a>` : `<span class="spinner" aria-hidden="true"></span>Loading…`}</p>
  </div>`;
}

function render(force = false) {
  const key = JSON.stringify([view, open, chain, form, pageError]);
  if (!force && key === shown) return;
  shown = key;
  const focusedAction = document.activeElement?.closest?.("#view") && document.activeElement.id;
  $("#view").innerHTML = viewHtml();
  if (options) renderWho();
  Thumbs.watch($("#view"));
  if (focusedAction && document.getElementById(focusedAction)) document.getElementById(focusedAction).focus();
  if (view && !view.running && wantFocus) { wantFocus = false; $("#headline")?.focus({ preventScroll: innerWidth > 720 }); announce(view.headline ?? ""); }
}

function openPopup() {
  // A popup has to open from the click itself, so it opens before the authorization URL exists.
  popup = window.open("about:blank", "smart-imaging-authorize", "width=600,height=800");
  popupSent = false; closedPolls = 0;
}
function syncPopup() {
  if (!popup) return;
  if (view?.authUrl) {
    if (!popupSent && !popup.closed) { popup.location = view.authUrl; popupSent = true; }
    if (popup.closed && ++closedPolls >= 2) { popup = null; api("POST", "/api/explore/cancel", {}).catch(() => {}); }
  } else if (!view?.running) popup = null;
}

async function call(path, body) {
  pageError = ""; open = null; chain = null; form = null; wantFocus = true;
  Thumbs.reset();
  if (mode === "window" && (path === "/start" || path === "/approve")) openPopup(); else popup = null;
  try { const r = await api("POST", `/api/explore${path}`, body); view = r.session; render(); poll(); }
  catch (e) { popup?.close(); pageError = e.message; render(true); }
}
function poll() {
  if (timer) return;
  timer = setInterval(async () => {
    try {
      const r = await api("GET", "/api/explore/session");
      view = r.session; syncPopup(); render();
      const busy = view?.running || view?.retrievals?.some(x => x.running);
      if (!busy) { clearInterval(timer); timer = undefined; loadOptions(); if (open) loadChain(); }
    } catch (e) { clearInterval(timer); timer = undefined; pageError = e.message; render(true); }
  }, 300);
}
/** The study's chain in one line, from the same events the activity log shows for it. */
async function loadChain() {
  try { chain = await api("GET", `/api/explore/happened?study=${encodeURIComponent(open)}`); } catch (e) { chain = null; pageError = e.message; }
  render();
}

document.addEventListener("click", e => {
  const t = e.target.closest("button, a");
  if (!t) return;
  if (t.dataset.user) {
    const p = options.people.find(x => x.id === t.dataset.user);
    call("/start", { user: t.dataset.user, mode, ...(picked.records[p.id] ? { patient: picked.records[p.id] } : {}) });
  } else if (t.dataset.client) call("/start", { client: t.dataset.client, ...(picked.referral[t.dataset.client] ? { referral: picked.referral[t.dataset.client] } : {}) });
  else if (t.dataset.whose) { picked.records[view.who.asked] = t.dataset.whose; call("/start", { user: view.who.asked, mode, patient: t.dataset.whose }); }
  else if (t.dataset.referral) { picked.referral[view.who.id] = t.dataset.referral; call("/start", { client: view.who.id, referral: t.dataset.referral }); }
  else if (t.dataset.open) { open = t.dataset.open; chain = null; wantFocus = true; render(); loadChain(); }
  else if (t.id === "back") { const was = open; open = null; render(); $(`[data-open="${CSS.escape(was)}"]`)?.focus(); }
  else if (t.id === "retrieve") { api("POST", "/api/explore/retrieve", { study: open }).then(r => { view = r.session; render(); poll(); }, err => { pageError = err.message; render(true); }); }
  else if (t.id === "stop-waiting") { popup?.close(); api("POST", "/api/explore/cancel", { stopped: true }).catch(() => {}); }
  else if (t.dataset.cancelForm !== undefined) { form = null; render(); }
  else if (t.dataset.action !== undefined) {
    const list = t.dataset.from === "empty" ? view.empty.actions : view.actions;
    const a = list[Number(t.dataset.action)];
    if (a.kind === "approve" && t.dataset.from === "empty") call("/approve", {});
    else if (a.kind === "approve" || (a.kind === "share" && !a.with) || (a.kind === "share" && a.sites?.length > 1)) { form = { action: a }; render(); $("#action-form input, #action-form select")?.focus(); }
    else if (a.kind === "share") call("/share", { from: a.from, with: a.with, patient: a.patient, sites: a.sites, relationship: options.relationships[0] });
    else if (a.kind === "unshare") call("/unshare", { with: a.with });
    else if (a.kind === "revoke-app") call("/revoke-app", {});
    else if (a.kind === "apply-policy") call("/apply-policy", { ruleSet: a.ruleSet });
  }
});
document.addEventListener("change", e => {
  if (e.target.name === "mode") mode = e.target.value;
  if (e.target.id === "who-select" && e.target.value) {
    const [kind, id] = [e.target.value.slice(0, e.target.value.indexOf(":")), e.target.value.slice(e.target.value.indexOf(":") + 1)];
    if (kind === "user") call("/start", { user: id, mode, ...(picked.records[id] ? { patient: picked.records[id] } : {}) });
    else call("/start", { client: id, ...(picked.referral[id] ? { referral: picked.referral[id] } : {}) });
  }
});
document.addEventListener("submit", e => {
  if (e.target.id !== "action-form") return;
  e.preventDefault();
  const a = form.action, f = new FormData(e.target);
  const sites = f.getAll("site");
  if (a.kind === "approve") call("/approve", { sites });
  else call("/share", { from: a.from, with: a.with ?? f.get("with"), patient: a.patient ?? view.patient, sites, relationship: f.get("relationship") });
});
document.addEventListener("settings-changed", () => { loadOptions(); });

(async () => {
  try {
    await loadOptions();
    const r = await api("GET", "/api/explore/session");
    view = r.session;
    render(true);
    if (view?.running) poll();
  } catch (e) { pageError = e.message; render(true); }
})();
