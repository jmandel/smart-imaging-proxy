// Explore: pick a person and whose records, or a service and a referral, and see what their app can see. The
// page is a SMART Imaging client, like the demo app. For a person it gets a token from the sandbox's admin
// key, as that person's app would hold after sign-in. A service signs its own assertion with its key. Then it
// searches and retrieves with the token, as any app would. The sandbox explains the view from its policy, and
// a change, a share or an approval, is a write to the sandbox's management API. Every request carries this
// view's trace session, so the activity log shows what it did.
const APP = "portal-app";
let options, referrals = [], view = null, shown = "", wantFocus = false, pageError = "";
let open = null, chain = null, form = null;
const SANDBOX_ID = BASE.slice("/s/".length);
const LAST = `smart-imaging-explore:${BASE}`;
const hex = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, "0")).join("");
/** A new trace session for a view, named as the server names its own. */
const newSession = who => `explore-${who}-${hex(3)}${SANDBOX_ID ? `@${SANDBOX_ID}` : ""}`;
/** What ties a request to the view's session: a new trace for each, under the session. */
const traceHeaders = () => view?.session ? { traceparent: `00-${hex(16)}-${hex(8)}-01`, baggage: `demo.session=${encodeURIComponent(view.session)}` } : {};

const personOf = id => options.people.find(p => p.id === id);
const lineOf = p => p.role;
function whoHtml() {
  const busy = !!view?.running;
  const current = view?.who?.id;
  const person = p => `<li><button type="button" class="person" data-user="${esc(p.id)}" aria-pressed="${current === p.id}" ${busy ? "disabled" : ""}><b>${esc(p.name)}</b><span>${esc(lineOf(p))}</span></button></li>`;
  const service = s => `<li><button type="button" class="person" data-client="${esc(s.id)}" aria-pressed="${current === s.id}" ${busy ? "disabled" : ""}><b>${esc(s.name)}</b><span>${esc(s.role)}</span></button></li>`;
  // On a phone, one select stands in for both lists.
  const opt = (v, label) => `<option value="${esc(v)}" ${current && v.endsWith(`:${current}`) ? "selected" : ""}>${esc(label)}</option>`;
  const select = `<div class="who-select"><label>Who's looking<select id="who-select" ${busy ? "disabled" : ""}>${current ? "" : `<option value="">Choose someone</option>`}<optgroup label="People">${options.people.map(p => opt(`user:${p.id}`, p.name)).join("")}</optgroup><optgroup label="Services">${options.services.map(s => opt(`client:${s.id}`, s.name)).join("")}</optgroup></select></label></div>`;
  return `${select}<section aria-labelledby="h-people"><h2 id="h-people">People</h2><ul>${options.people.map(person).join("")}</ul></section>
    <section aria-labelledby="h-services"><h2 id="h-services">Services</h2><ul>${options.services.map(service).join("")}</ul></section>`;
}
function renderWho() {
  const active = document.activeElement;
  const focused = active?.closest?.("#who") ? (active.id === "who-select" ? "who-select" : active.dataset.user ?? active.dataset.client) : undefined;
  $("#who").innerHTML = whoHtml();
  if (focused === "who-select") $("#who-select")?.focus();
  else if (focused) $(`#who [data-user="${CSS.escape(focused)}"], #who [data-client="${CSS.escape(focused)}"]`)?.focus();
}
const sheetHtml = s => {
  const mod = s.modalities?.[0] ?? "OT";
  const slot = `<div class="thumb" ${s.released && s.thumb ? `data-study="${esc(s.id)}" data-label="${esc(s.title)}"` : ""} aria-hidden="${s.released && s.thumb ? "false" : "true"}"><span class="placeholder">${esc(mod)}</span></div>`;
  const inner = `${slot}<span class="top"><span class="modality">${esc((s.modalities ?? [mod]).join(" "))}</span><span class="date">${esc(studyDate(s.date))}</span></span>
    <span class="title">${esc(s.title)}</span>${s.site ? `<span class="site">${esc(s.site)}</span>` : ""}
    <span class="status ${s.partial ? "partial" : ""}">${s.released ? esc(s.partial ? `Released, ${s.partial}` : `${plural(s.instanceCount ?? 0, "image")} in ${plural(s.seriesCount ?? 0, "series", "series")}`) : `Withheld: ${esc(s.reason)}`}</span>`;
  return s.released ? `<li><button type="button" class="sheet" data-open="${esc(s.id)}" aria-label="Open ${esc(s.title)}">${inner}</button></li>` : `<li><div class="sheet withheld">${inner}</div></li>`;
};

/** Whose records, for a person: the ones they hold, and apart from them, others' they don't. */
function whoseHtml(user, patient, disabled) {
  const p = personOf(user);
  if (!p) return "";
  const held = p.records.map(r => ({ patient: r.patient, label: r.via === "self" ? "Own studies" : `${r.name}'s studies, as ${r.via === "guardian" ? "guardian" : r.relationship}` }));
  const others = p.others;
  if (held.length + others.length < 2) return "";
  return `<div class="whose">${held.length > 1 || (held.length && others.length) ? `<div class="seg" role="group" aria-label="Whose records">${held.map(c => `<button type="button" data-whose="${esc(c.patient)}" aria-pressed="${patient === c.patient}" ${disabled ? "disabled" : ""}>${esc(c.label)}</button>`).join("")}</div>` : ""}
    ${others.length ? `<label class="others">Someone else's studies<select id="other-records" ${disabled ? "disabled" : ""}>${others.some(o => o.patient === patient) ? "" : `<option value="">Choose a person</option>`}${others.map(o => `<option value="${esc(o.patient)}" ${o.patient === patient ? "selected" : ""}>${esc(o.name)}</option>`).join("")}</select></label>` : ""}</div>`;
}

/** Whose records, for a person: the ones they hold, and apart from them, others' they don't. */
function whoseHtml(user, patient, disabled) {
  const p = personOf(user);
  if (!p) return "";
  const held = p.records.map(r => ({ patient: r.patient, label: r.via === "self" ? "Own studies" : `${r.name}'s studies, as ${r.via === "guardian" ? "guardian" : r.relationship}` }));
  const others = p.others;
  if (held.length + others.length < 2) return "";
  return `<div class="whose">${held.length > 1 || (held.length && others.length) ? `<div class="seg" role="group" aria-label="Whose records">${held.map(c => `<button type="button" data-whose="${esc(c.patient)}" aria-pressed="${patient === c.patient}" ${disabled ? "disabled" : ""}>${esc(c.label)}</button>`).join("")}</div>` : ""}
    ${others.length ? `<label class="others">Someone else's studies<select id="other-records" ${disabled ? "disabled" : ""}>${others.some(o => o.patient === patient) ? "" : `<option value="">Choose a person</option>`}${others.map(o => `<option value="${esc(o.patient)}" ${o.patient === patient ? "selected" : ""}>${esc(o.name)}</option>`).join("")}</select></label>` : ""}</div>`;
}
/** The referrals a service works from, grouped by patient. */
function referralHtml(chosen, disabled) {
  const by = new Map();
  for (const r of referrals) { const k = r.patient ?? "Other"; by.set(k, [...(by.get(k) ?? []), r]); }
  return `<div class="whose"><label class="others">Referral<select id="referral-select" ${disabled ? "disabled" : ""}>${[...by].map(([patient, rs]) => `<optgroup label="${esc(patient)}">${rs.map(r => `<option value="${esc(r.id)}" ${r.id === chosen ? "selected" : ""}>${esc(r.report)}</option>`).join("")}</optgroup>`).join("")}</select></label></div>`;
}
function choiceHtml() {
  if (!view) return "";
  if (view.who.kind === "service") return referralHtml(view.who.referral, view.running);
  return whoseHtml(view.who.id, view.patient, view.running);
}
function actionButton(a, i, primary) { return `<button type="button" class="${primary ? "primary" : "secondary"}" data-action="${i}" data-from="${a.where ?? "actions"}">${esc(a.label)}</button>`; }
function formHtml() {
  if (!form) return "";
  const a = form.action;
  const ticks = (sites, ticked) => `<fieldset><legend>Sites</legend><div class="ticks">${sites.map(s => `<label><input type="checkbox" name="site" value="${esc(s)}" ${ticked.includes(s) ? "checked" : ""}> ${esc(s)}</label>`).join("") || `<span class="note">No sites to choose.</span>`}</div></fieldset>`;
  if (a.kind === "approve") return `<form class="form" id="action-form"><p class="eyebrow">The ${esc(options.app)}</p>${ticks(a.sites, a.ticked ?? a.sites)}<div class="buttons"><button class="primary" type="submit">Approve</button><button class="secondary" type="button" data-cancel-form>Cancel</button></div></form>`;
  if (a.kind === "share") return `<form class="form" id="action-form"><p class="eyebrow">${esc(options.names[`user:${a.from}`] ?? a.from)} shares</p>
    ${a.with ? "" : `<label class="field">Share with <select name="with">${a.people.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("")}</select></label>`}
    <label class="field">As their <select name="relationship">${options.relationships.map(r => `<option>${esc(r)}</option>`).join("")}</select></label>
    ${ticks(a.sites, a.sites)}<div class="buttons"><button class="primary" type="submit">Share</button><button class="secondary" type="button" data-cancel-form>Cancel</button></div></form>`;
  return "";
}


// The protocol, as an app does it.
let discovery;
async function discover() {
  discovery ??= fetch(`${BASE}/fhir/.well-known/smart-configuration`).then(r => r.json()).catch(e => { discovery = undefined; throw e; });
  return discovery;
}
/** One request this view made, for its technical detail. */
const noted = (what, status, extra = "") => view.tech.push(`${what}: HTTP ${status}${extra}`);
/** A token as the person's app would hold it after sign-in, from the sandbox's admin key. */
async function personToken(user, patient) {
  const keys = await keysOf();
  const t = await backendToken(keys.admin, keys.tokenEndpoint, { user, patient, app: APP }, keys.now, traceHeaders());
  noted(`Token for the ${options.app} as ${personOf(user)?.name ?? user}, from the sandbox's admin key`, 200);
  return t.access_token;
}
/** A service's own token: SMART Backend Services, with its key. */
async function serviceToken(client) {
  const keys = await keysOf(), mine = keys.services.find(s => s.client_id === client);
  const t = await backendToken(mine, keys.tokenEndpoint, { scope: mine.scope }, keys.now, traceHeaders());
  noted(`Backend Services token for ${client}, signed with its own key`, 200);
  return t.access_token;
}
/** Every page of a search, with this view's token. Gives the studies, or the refusal's status. */
async function search(token, imaging, query) {
  let refused;
  const { entries } = await searchAll(`${imaging}/ImagingStudy?${query}`, async url => {
    const r = await patientFetch(url, { headers: { ...fhirHeaders(token), ...traceHeaders() } });
    noted(`GET ${new URL(url).pathname.split("/").slice(-1)[0]}${new URL(url).search.slice(0, 80)}`, r.status);
    if (!r.ok) { refused = r.status; return {}; }
    return r.json();
  });
  return refused ? { status: refused, studies: [] } : { status: 200, studies: studiesFrom(entries) };
}
/** The sheets: what search found, each with the sandbox's title for it, then what it withholds from what this viewer may know of. */
function sheetsOf(found, rows) {
  const byId = new Map(rows.map(r => [r.id, r]));
  const released = found.map(st => {
    const row = byId.get(st.id) ?? {};
    return { id: st.id, title: row.title ?? st.description ?? st.id, site: row.site, date: st.started, modalities: (st.modality ?? []).map(m => m.code), released: true,
      instanceCount: st.numberOfInstances, seriesCount: st.numberOfSeries, partial: row.partial, thumb: !!(st.address && st.uid) };
  });
  const ids = new Set(found.map(st => st.id));
  return [...released, ...rows.filter(r => !r.released && !ids.has(r.id))];
}
/** A view: the sandbox's explanation, then the app's own token, search and pictures. */
async function look(choice) {
  pageError = ""; open = null; chain = null; form = null; wantFocus = true;
  Thumbs.reset();
  const person = choice.user && personOf(choice.user), service = choice.client && options.services.find(s => s.id === choice.client);
  const referral = service ? choice.referral ?? referrals[0]?.id : undefined;
  view = { running: true, session: newSession(choice.user ?? choice.client), tech: [], retrievals: {}, studies: {},
    who: person ? { kind: "user", id: person.id, name: person.name, first: person.first } : { kind: "service", id: service.id, name: service.name, first: service.name, referral } };
  try { sessionStorage.setItem(LAST, JSON.stringify({ ...choice, ...(referral ? { referral } : {}) })); } catch {}
  render(true);
  const me = view;
  try {
    const q = new URLSearchParams({ session: me.session, ...(person ? { user: person.id, ...(choice.patient ? { patient: choice.patient } : {}) } : { client: service.id, referral }) });
    const v = await api("GET", `/api/sandbox/explore/view?${q}`, undefined, BASE, traceHeaders());
    if (view !== me) return;
    Object.assign(me, v, { patientName: v.patient && options.names[`patient:${v.patient}`] });
    if (v.patient) {
      const config = await discover();
      const imaging = imagingOf(config, `${location.origin}${BASE}/fhir`, service ? BACKEND_CAPABILITY : APP_LAUNCH)?.url;
      const token = service ? await serviceToken(service.id) : await personToken(person.id, v.patient);
      const r = referral && referrals.find(x => x.id === referral);
      const query = service ? new URLSearchParams({ patient: r.patientRef, identifier: `${r.system}|${r.accession}`, _include: "ImagingStudy:endpoint" }) : new URLSearchParams({ patient: v.patient, _include: "ImagingStudy:endpoint", _count: "100" });
      const found = await search(token, imaging, query.toString());
      if (view !== me) return;
      me.token = token; me.searchStatus = found.status;
      for (const st of found.studies) me.studies[st.id] = st;
      me.sheets = sheetsOf(found.studies, v.rows ?? []);
    } else me.sheets = [];
  } catch (e) { if (view === me) { pageError = e.message; me.headline ??= "This didn't finish"; } }
  if (view === me) { me.running = false; render(true); }
}
/** A study's picture for its thumbnail, retrieved with this view's token. */
Thumbs.use(async (id, signal) => {
  const st = view?.studies[id];
  if (!st?.address || !view.token) return undefined;
  const pic = await thumbnailOf(st, sourceFor(st), signal);
  return pic && { data: pic.data, modality: pic.series.modality };
});
const sourceFor = st => wadoSource(view.token, st, { headers: traceHeaders() });
/** The whole study, from its WADO-RS address, counted as it arrives: parts, bytes, and how long it took. */
async function retrieveWhole(id) {
  const st = view.studies[id], r = view.retrievals[id] = { running: true, parts: 0, bytes: 0 }, me = view;
  render(true);
  const url = `${st.address}/studies/${st.uid}`, t0 = performance.now();
  try {
    const res = await patientFetch(url, { headers: { authorization: `Bearer ${view.token}`, accept: WADO_ACCEPT, ...traceHeaders() } });
    r.status = res.status;
    const boundary = res.headers.get("content-type")?.match(/boundary="?([^";]+)/)?.[1];
    if (res.ok && boundary && res.body) {
      // Each part starts after a delimiter line, and the body ends at the closing one.
      const delimiter = new TextEncoder().encode(`--${boundary}`), reader = res.body.getReader();
      let carry = new Uint8Array(0), delimiters = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        r.bytes += value.length;
        const buf = new Uint8Array(carry.length + value.length); buf.set(carry); buf.set(value, carry.length);
        for (let i = 0; i + delimiter.length <= buf.length; i++) if (delimiter.every((c, k) => buf[i + k] === c)) { delimiters++; i += delimiter.length - 1; }
        carry = buf.slice(Math.max(0, buf.length - delimiter.length + 1));
        r.parts = Math.max(0, delimiters - 1);
        if (view === me) render();
      }
      r.complete = delimiters >= 2;
      const timing = performance.getEntriesByName(url).at(-1);
      if (timing?.encodedBodySize) r.wire = timing.encodedBodySize;
    } else await res.body?.cancel();
  } catch (e) { r.error = e.message; }
  r.ms = Math.round(performance.now() - t0); r.running = false;
  if (view === me) { render(true); if (open === id) loadChain(); }
}
/** The study's chain in one line, from the same events the activity log shows for it. */
async function loadChain() {
  const me = view, study = open;
  try { const c = await api("GET", `/api/sandbox/explore/happened?${new URLSearchParams({ session: me.session, study })}`); if (view === me && open === study) chain = c; }
  catch (e) { chain = null; pageError = e.message; }
  render();
}

// Changes, as the sandbox's management API makes them, then the same view again.
const policy = (method, path, body) => api(method, `/api/sandbox/policy${path}`, body, BASE, traceHeaders());
async function change(fn, then) {
  try { await fn(); await loadOptions(); look(then); }
  catch (e) { pageError = e.message; render(true); }
}
const again = () => view.who.kind === "user" ? { user: view.who.id, patient: view.patient } : { client: view.who.id, referral: view.who.referral };
function act(a, sites, f) {
  const user = view.who.id, patient = a.patient ?? view.patient;
  if (a.kind === "approve") return change(() => policy("POST", "/app-approvals", { by: `user:${user}`, app: `app:${APP}`, patient: `patient:${patient}`, sites, fhirUser: personOf(user)?.fhirUser }), again());
  if (a.kind === "share") {
    const to = a.with ?? f?.get("with");
    return change(() => policy("POST", "/shares", { from: `user:${a.from}`, with: `user:${to}`, patient: `patient:${patient}`, sites, label: f?.get("relationship") ?? options.relationships[0] }), user === to ? { user: to, patient } : again());
  }
  if (a.kind === "unshare") return change(() => policy("DELETE", `/shares?${new URLSearchParams({ from: `user:${user}`, with: `user:${a.with}`, patient: `patient:${patient}` })}`), again());
  if (a.kind === "revoke-app") return change(() => policy("DELETE", `/app-approvals?${new URLSearchParams({ by: `user:${user}`, app: `app:${APP}`, patient: `patient:${patient}` })}`), again());
  if (a.kind === "apply-policy") return change(async () => {
    const { ruleSets } = await api("GET", `/api/sandbox/explore/rule-sets?service=${encodeURIComponent(view.who.id)}`);
    for (const rule of ruleSets.find(r => r.id === a.ruleSet)?.rules ?? []) await policy("PUT", `/policies/${encodeURIComponent(rule.id)}`, rule);
  }, again());
  if (a.kind === "person") return look({ user: a.user });
  if (a.kind === "referral") return look({ client: view.who.id, referral: a.referral });
}
function viewHtml() {
  if (pageError && !view) return `<div class="headline"><h1 id="headline" tabindex="-1">Something went wrong</h1></div><p class="error" role="alert">${esc(pageError)}</p>`;
  if (!view) return `<div class="headline"><h1 id="headline" tabindex="-1"><span class="spinner" aria-hidden="true"></span>Loading</h1></div>`;
  if (view.running) return `${choiceHtml()}<div class="headline"><h1 id="headline" tabindex="-1"><span class="spinner" aria-hidden="true"></span>${view.who.kind === "user" ? `Getting ${esc(view.who.first)}'s app a token, and searching` : "Working from the referral"}</h1></div>`;
  if (open) return studyHtml();
  const empty = view.empty ? `<div class="empty"><p>${esc(view.empty.text)}</p>${view.empty.actions.length ? `<div class="buttons">${view.empty.actions.map((a, i) => actionButton({ ...a, where: "empty" }, i, i === 0)).join("")}</div>` : ""}</div>` : "";
  const tech = view.tech?.length ? `<details class="tech-detail"><summary>Technical detail</summary><ul>${view.tech.map(t => `<li>${esc(t)}</li>`).join("")}</ul></details>` : "";
  return `${choiceHtml()}
    <div class="headline"><h1 id="headline" tabindex="-1">${esc(view.headline ?? "")}</h1>
      ${view.detail ? `<p class="note">${esc(view.detail)}</p>` : ""}</div>
    ${tech}
    ${view.chain?.rows?.length ? `<div class="why"><h2 class="why-head">${esc(view.whyTitle)}</h2>${Layers.chain(view.chain, { label: view.whyTitle })}${Layers.legend({ cited: view.chain.columns.some(c => c.cited) })}</div>` : ""}
    ${pageError ? `<p class="error" role="alert">${esc(pageError)}</p>` : ""}
    ${view.sheets?.length ? `<ul class="sheets" aria-label="Studies">${view.sheets.map(sheetHtml).join("")}</ul>` : ""}
    ${empty}${formHtml()}
    <div class="actions">${(view.actions ?? []).map((a, i) => actionButton(a, i, false)).join("")}<a class="log-link" href="${esc(view.activityUrl)}">Logs</a></div>`;
}

function studyHtml() {
  const s = view.sheets.find(x => x.id === open), r = view.retrievals[open];
  return `<button type="button" class="back" id="back">Back to ${esc(view.who.kind === "user" && view.patientName ? `${view.patientName.split(" ")[0]}'s studies` : "the studies")}</button>
  <div class="study-open">
      <div class="study-hero">
        <span class="meta">${esc([(s.modalities ?? []).join(" "), studyDate(s.date), s.site, `${plural(s.instanceCount ?? 0, "image")} in ${plural(s.seriesCount ?? 0, "series", "series")}`, s.partial].filter(Boolean).join(", "))}</span>
        <h2 id="headline" tabindex="-1">${esc(s.title)}</h2>
      </div>
      <div id="viewer-slot"></div>
      <div><button type="button" class="primary" id="retrieve" ${r?.running ? "disabled" : ""}>${r ? (r.running ? "Retrieving…" : "Retrieve again") : "Retrieve the whole study"}</button></div>
      ${r ? `<div class="retrieval"><h3>${r.running ? "Retrieving" : r.status === 200 && r.complete ? "Retrieved" : `Not retrieved (HTTP ${esc(r.status ?? "none")})`}</h3><dl>
        <dt>Parts</dt><dd>${esc(r.parts)}</dd><dt>Received</dt><dd>${esc(bytes(r.bytes))}</dd>${r.wire ? `<dt>On the wire</dt><dd>${esc(bytes(r.wire))}</dd>` : ""}
        ${r.ms !== undefined ? `<dt>Took</dt><dd>${esc(r.ms)} ms</dd>` : ""}${r.error ? `<dt>Problem</dt><dd class="error">${esc(r.error)}</dd>` : ""}</dl></div>` : ""}
    <p class="chain" id="chain">${chain ? `${esc(chain.line)} <a href="${esc(chain.activityUrl)}">Logs</a>` : `<span class="spinner" aria-hidden="true"></span>Loading…`}</p>
  </div>`;
}

// The viewer, made once and moved into each opened study, so a re-render never loses its place. Its images
// come with this view's token, the same way the thumbnails do.
const viewerEl = Object.assign(document.createElement("section"), { className: "explore-viewer", innerHTML: ImageViewer.markup() });
viewerEl.setAttribute("aria-label", "Image viewer");
const viewer = ImageViewer.create(viewerEl);
let viewing = null;
function showViewer() {
  if (!open) { if (viewing) { viewer.close(); viewing = null; } return; }
  $("#viewer-slot")?.replaceWith(viewerEl);
  if (viewing === open) return;
  const st = view.studies[viewing = open];
  viewer.close();
  if (st?.address) viewer.openStudy(viewerSeries(st), sourceFor(st)); else viewer.note("This study has no images to show.");
}

function render(force = false) {
  const key = JSON.stringify([view, open, chain, form, pageError]);
  if (!force && key === shown) return;
  shown = key;
  const focusedAction = document.activeElement?.closest?.("#view") && document.activeElement.id;
  $("#view").innerHTML = viewHtml();
  if (options) renderWho();
  Thumbs.watch($("#view"));
  showViewer();
  if (focusedAction && document.getElementById(focusedAction)) document.getElementById(focusedAction).focus();
  // The new view's headline takes focus, unless the person has moved it elsewhere meanwhile, such as into the settings.
  const free = !document.activeElement || document.activeElement === document.body || document.activeElement.closest("#who, #view");
  if (view && !view.running && wantFocus) { wantFocus = false; if (free) $("#headline")?.focus({ preventScroll: innerWidth > 720 }); announce($("#headline")?.textContent ?? ""); }
}

document.addEventListener("click", e => {
  const t = e.target.closest("button");
  if (!t || !t.closest("#who, #view")) return;
  if (t.dataset.user) look({ user: t.dataset.user });
  else if (t.dataset.client) look({ client: t.dataset.client });
  else if (t.dataset.whose) look({ user: view.who.id, patient: t.dataset.whose });
  else if (t.dataset.open) { open = t.dataset.open; chain = null; wantFocus = true; render(); loadChain(); }
  else if (t.id === "back") { const was = open; open = null; render(); $(`[data-open="${CSS.escape(was)}"]`)?.focus(); }
  else if (t.id === "retrieve") retrieveWhole(open);
  else if (t.dataset.cancelForm !== undefined) { form = null; render(); }
  else if (t.dataset.action !== undefined) {
    const list = t.dataset.from === "empty" ? view.empty.actions : view.actions;
    const a = list[Number(t.dataset.action)];
    if (a.kind === "approve" || (a.kind === "share" && !a.with) || (a.kind === "share" && a.sites?.length > 1)) { form = { action: a }; render(); $("#action-form input, #action-form select")?.focus(); }
    else act(a, a.sites);
  }
});
document.addEventListener("change", e => {
  if (e.target.id === "who-select" && e.target.value) {
    const [kind, id] = [e.target.value.slice(0, e.target.value.indexOf(":")), e.target.value.slice(e.target.value.indexOf(":") + 1)];
    look(kind === "user" ? { user: id } : { client: id });
  }
  if (e.target.id === "other-records" && e.target.value) look({ user: view.who.id, patient: e.target.value });
  if (e.target.id === "referral-select") look({ client: view.who.id, referral: e.target.value });
});
document.addEventListener("submit", e => {
  if (e.target.id !== "action-form") return;
  e.preventDefault();
  const f = new FormData(e.target);
  act(form.action, f.getAll("site"), f);
});
document.addEventListener("settings-changed", () => { loadOptions(); if (view && !view.running) look(again()); });

async function loadOptions() { options = await api("GET", "/api/sandbox/explore/cast"); renderWho(); }
(async () => {
  try {
    await loadOptions();
    referrals = (await api("GET", "/api/sandbox/explore/referrals")).referrals;
    // The view last looked at here, or with nothing chosen yet, Josh, the patient.
    let last; try { last = JSON.parse(sessionStorage.getItem(LAST) ?? "null"); } catch {}
    look(last ?? { user: "josh" });
  } catch (e) { pageError = e.message; render(true); }
})();
addEventListener("pageshow", e => { if (e.persisted && view && !view.running) look(again()); });
