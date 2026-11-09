// The public demo client: a standalone SMART App Launch against this deployment, then its clinical and
// imaging data with one token. Every request goes through `traced`, which keeps what the protocol panel
// shows. Images come one instance at a time, the search result already naming them: the middle one
// first, then outward, so the first picture doesn't wait for the rest of the study.
const CLIENT_ID = "demo-client", SCOPE = "launch/patient patient/*.rs";
const ISS = `${location.origin}${BASE}/fhir`, REDIRECT = `${location.origin}${BASE}/`;
const STORE = `smart-imaging-client:${BASE}`;
const WADO_ACCEPT = 'multipart/related; type="application/dicom"; transfer-syntax=*';
const KIT = "/vendor/viewer-kit/";
/** Non-image series a viewer has no picture for. */
const NOT_IMAGES = new Set(["SR", "PR", "KO", "SEG", "RTSTRUCT", "DOC"]);
const NEAR = 3, FETCHES_AT_ONCE = 4;

const saved = () => { try { return JSON.parse(sessionStorage.getItem(STORE) ?? "{}"); } catch { return {}; } };
const save = patch => { try { sessionStorage.setItem(STORE, JSON.stringify({ ...saved(), ...patch })); } catch {} };

// The protocol panel.
const trail = saved().trail ?? [];
const IG = "https://build.fhir.org/ig/argonautproject/smart-imaging/", SMART = "https://build.fhir.org/ig/HL7/smart-app-launch/";
/** The protocol as the client meets it. Requests are the detail; these are the story. */
const STAGES = [
  { key: "discover", name: "Discover", line: "From one FHIR address, find the sign-in page and the imaging server.", kinds: ["discover"], spec: [`${SMART}conformance.html`, "SMART discovery"] },
  { key: "authorize", name: "Authorize", line: "Sign in, approve this app, and receive an access token for one patient.", kinds: ["authorize", "token"], spec: [`${SMART}app-launch.html`, "SMART App Launch"] },
  { key: "clinical", name: "Read the chart", line: "Query the clinical server with that token.", kinds: ["patient", "clinical"], spec: [`${SMART}scopes-and-launch-context.html`, "Scopes and context"] },
  { key: "imaging", name: "Find studies", line: "Ask the imaging server for studies, and where to retrieve each one.", kinds: ["imaging"], spec: [IG, "SMART Imaging Access"] },
  { key: "retrieve", name: "Retrieve images", line: "Download DICOM from each study's Endpoint, and decode it in the browser.", kinds: ["wado"], spec: ["https://www.dicomstandard.org/using/dicomweb/retrieve-wado-rs-and-wado-uri", "DICOMweb WADO-RS"] },
];
const WHY = {
  discover: "The app reads the SMART configuration at its FHIR address. That says where to sign in, and associated_endpoints names the imaging server, chosen by its smart-imaging-access capability.",
  authorize: "The app sends the browser to the sign-in page with the scopes it wants and a PKCE challenge. It never sees the password, and it gets back a one-time code.",
  token: "The app sends that code with its PKCE verifier. The response has an access token and the patient it applies to.",
  patient: "The app reads the patient named in the token response.",
  clinical: "An ordinary FHIR search on the clinical server, using the access token.",
  imaging: "The same access token, sent to the imaging server found during discovery. Each study comes back with an Endpoint saying where to retrieve its images.",
  wado: "A DICOMweb WADO-RS retrieval from the address in the study's Endpoint, still sending the access token. Each request is one DICOM instance.",
};
const stageOf = kind => STAGES.find(st => st.kinds.includes(kind));
function stageState(steps, stage) {
  if (steps.some(s => s.failed)) return "failed";
  return steps.length ? "done" : "waiting";
}
const GLYPH = { done: "✓", failed: "✕" };
const STATE_WORD = { done: "Done", failed: "Failed", waiting: "Not yet" };
function stageHtml(stage, index, open = false) {
  const steps = trail.filter(s => stage.kinds.includes(s.kind)), state = stageState(steps, stage);
  const facts = Object.assign({}, ...steps.map(s => s.facts ?? {}));
  const tiles = Object.entries(facts).map(([k, v]) => `<div class="fact${String(v).length > 12 ? " long" : ""}"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("");
  const calls = steps.map(s => `<li><button type="button" class="call" data-call="${esc(s.id)}"><span class="call-title">${esc(s.title)}</span>${s.ms === undefined ? "" : `<span class="call-ms">${s.ms} ms</span>`}</button></li>`).join("");
  return `<span class="node" aria-hidden="true">${GLYPH[state] ?? index + 1}</span>
    <div class="stage-body">
      <h3>${esc(stage.name)}<span class="sr-only"> (${STATE_WORD[state]})</span></h3>
      <p class="line">${esc(stage.line)}</p>
      ${tiles ? `<dl class="facts-grid">${tiles}</dl>` : ""}
      ${steps.length ? `<details class="calls" ${open ? "open" : ""}><summary>${plural(steps.length, "request")}</summary><ul>${calls}</ul><a href="${stage.spec[0]}" target="_blank" rel="noopener">${esc(stage.spec[1])}</a></details>` : ""}
    </div>`;
}
function paintStage(stage) {
  const li = $(`#trail [data-stage="${stage.key}"]`);
  if (!li) return;
  const steps = trail.filter(s => stage.kinds.includes(s.kind));
  li.dataset.state = stageState(steps, stage);
  li.innerHTML = stageHtml(stage, STAGES.indexOf(stage), !!li.querySelector("details[open]"));
}
function renderTrail() {
  const list = $("#trail");
  if (!list) return;
  list.innerHTML = STAGES.map(st => `<li class="stage-row" data-stage="${st.key}"></li>`).join("");
  STAGES.forEach(paintStage);
}
function showCall(id) {
  const s = trail.find(t => t.id === id), box = $("#call-detail");
  if (!s) return;
  $("#call-body").innerHTML = `<h2>${esc(s.title)}</h2><p class="call-why">${esc(WHY[s.kind] ?? "")}</p>
    ${s.request ? `<h3>Request</h3><pre>${esc(s.request)}</pre>` : ""}
    ${s.response ? `<h3>Response</h3><pre>${esc(s.response)}</pre>` : ""}
    ${s.curl ? `<h3>Try it yourself</h3><pre>${esc(s.curl)}</pre>` : ""}`;
  box.showModal();
}
$("#trail").addEventListener("click", e => { const b = e.target.closest("[data-call]"); if (b) showCall(b.dataset.call); });
$("#call-close").addEventListener("click", () => $("#call-detail").close());
$("#call-detail").addEventListener("click", e => { if (e.target === e.currentTarget) e.currentTarget.close(); });
function addStep(step) {
  const at = trail.findIndex(s => s.id === step.id);
  if (at >= 0) trail[at] = step; else trail.push(step);
  save({ trail });
  // Only the stage that changed, so a panel someone is reading doesn't redraw with every image.
  const stage = stageOf(step.kind);
  if (stage && $(`#trail [data-stage="${stage.key}"]`)) paintStage(stage); else renderTrail();
}
/** What the panel shows of a body: no secret in full, and only the start of a long one. */
const preview = text => {
  const masked = String(text).replace(/("(?:access_token|refresh_token|id_token)"\s*:\s*")[^"]+/g, "$1…").replace(/((?:code|code_verifier)=)[^&\s]+/g, "$1…").replace(/[A-Za-z0-9_.~-]{72,}/g, m => `${m.slice(0, 16)}…${m.slice(-8)}`);
  return masked.length > 1600 ? `${masked.slice(0, 1600)}\n… ${masked.length - 1600} more characters` : masked;
};
const pretty = text => { try { return JSON.stringify(JSON.parse(text), null, 1); } catch { return text; } };
const requestLine = (method, url, headers) => [`${method} ${preview(url)}`, ...Object.entries(headers ?? {}).map(([k, v]) => `${k}: ${/^authorization$/i.test(k) ? "Bearer …" : v}`)].join("\n");

/** The same GET from a terminal. The token stays a variable, so the panel never holds it. */
const curlOf = (url, headers) => `curl "${url}" \\\n${Object.entries(headers ?? {}).map(([k, v]) => `  -H "${k}: ${/^authorization$/i.test(k) ? "Bearer $TOKEN" : v.replace(/"/g, '\\"')}"`).join(" \\\n")}`;

/** One request, recorded as a step, with what the app took from the answer. A failed status is thrown. */
async function traced(step, url, init = {}, learned = () => ({})) {
  const started = performance.now(), method = init.method ?? "GET";
  const request = requestLine(method, url, init.headers) + (init.body ? `\n\n${preview(init.body)}` : "");
  let res, text;
  try { res = await fetch(url, init); text = await res.text(); }
  catch (e) { addStep({ ...step, request, failed: true, response: String(e) }); throw e; }
  let found = {};
  if (res.ok) { try { found = learned(JSON.parse(text)); } catch {} }
  addStep({ ...step, request, facts: found, curl: method === "GET" ? curlOf(url, init.headers) : undefined, ms: Math.round(performance.now() - started), failed: !res.ok, response: `HTTP ${res.status}\n\n${preview(pretty(text))}` });
  if (!res.ok) throw Object.assign(new Error(`${step.title}: HTTP ${res.status}`), { status: res.status });
  return JSON.parse(text);
}

// Connecting.
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const random = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
async function discover() {
  return traced({ id: "discover", kind: "discover", title: "Discover the servers" }, `${ISS}/.well-known/smart-configuration`, {}, c => {
    const imaging = (c.associated_endpoints ?? []).find(e => e.capabilities?.includes("smart-imaging-access"));
    return { "Sign-in": new URL(c.authorization_endpoint).host, "Imaging server": imaging ? new URL(imaging.url).host : "None advertised" };
  });
}
async function connect() {
  const button = $("#connect");
  button.disabled = true;
  try {
    // Everyone gets a world of their own, so one visitor's changes never reach another's.
    if (!BASE) {
      const r = await fetch("/api/scopes", { method: "POST" });
      if (!r.ok) throw new Error(`The sandbox couldn't be created (HTTP ${r.status})`);
      location.assign(`${(await r.json()).base}/?connect=1`);
      return;
    }
    trail.length = 0;
    const config = await discover();
    const verifier = random(), state = random();
    const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
    save({ pending: { verifier, state, config } });
    const url = new URL(config.authorization_endpoint);
    Object.entries({ response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT, scope: SCOPE, aud: ISS, state, code_challenge: challenge, code_challenge_method: "S256" }).forEach(([k, v]) => url.searchParams.set(k, v));
    addStep({ id: "authorize", kind: "authorize", title: "Sign in and approve the app", request: requestLine("GET", url.toString().replace(/([?&](state|code_challenge)=)[^&]+/g, "$1…")), response: "The browser returned with a one-time code." });
    location.assign(url);
  } catch (e) {
    button.disabled = false;
    const el = $("#connect-error"); el.hidden = false; el.textContent = e.message;
  }
}
async function finishSignIn(params) {
  const { pending } = saved();
  history.replaceState(null, "", REDIRECT);
  if (!pending || pending.state !== params.get("state")) throw new Error("This sign-in didn't start here. Connect again.");
  save({ pending: undefined });
  if (params.get("error")) { addStep({ id: "authorize", kind: "authorize", title: "Sign in and approve the app", failed: true, response: params.get("error") }); throw new Error(`The sign-in ended with: ${params.get("error")}`); }
  const body = new URLSearchParams({ grant_type: "authorization_code", code: params.get("code"), redirect_uri: REDIRECT, client_id: CLIENT_ID, code_verifier: pending.verifier }).toString();
  const token = await traced({ id: "token", kind: "token", title: "Exchange the code for a token" }, pending.config.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body }, t => ({ Granted: t.scope, "Token lasts": `${Math.round(t.expires_in / 60)} min` }));
  const imaging = (pending.config.associated_endpoints ?? []).find(e => e.capabilities?.includes("smart-imaging-access"))?.url;
  if (!imaging) throw new Error("This server doesn't name an imaging server.");
  const session = { token: token.access_token, patient: token.patient, imaging };
  save({ session });
  return session;
}
function disconnect() {
  try { sessionStorage.removeItem(STORE); } catch {}
  location.assign(`${BASE}/`);
}

// The chart.
const fhirHeaders = token => ({ authorization: `Bearer ${token}`, accept: "application/fhir+json" });
const CLINICAL = [
  ["AllergyIntolerance", "clinical-status=active", "Allergies", r => r.code?.text],
  ["Condition", "clinical-status=active", "Conditions", r => r.code?.text],
  ["MedicationRequest", "status=active", "Medications", r => r.medicationCodeableConcept?.text],
];
async function loadPatient(s) {
  const el = $("#patient");
  try {
    const p = await traced({ id: "patient", kind: "patient", title: "Read the patient" }, `${ISS}/Patient/${s.patient}`, { headers: fhirHeaders(s.token) });
    const name = p.name?.[0] ? `${(p.name[0].given ?? []).join(" ")} ${p.name[0].family ?? ""}`.trim() : p.id;
    const facts = [p.birthDate && `Born ${p.birthDate}`, p.gender, p.identifier?.[0]?.value && `MRN ${p.identifier[0].value}`].filter(Boolean);
    el.innerHTML = `<p class="who">${esc(name)}</p>${facts.length ? `<p class="facts">${facts.map(esc).join(" · ")}</p>` : ""}`;
  } catch (e) { el.innerHTML = `<p class="error">${esc(e.message)}</p>`; throw e; }
}
async function loadClinical(s) {
  const el = $("#clinical");
  el.innerHTML = `<h2>Clinical data</h2>${CLINICAL.map(([type, , label]) => `<div class="clinical-group" id="c-${type}"><h3>${label}</h3><p class="none">Loading…</p></div>`).join("")}`;
  // Each search stands alone: one failing leaves the others on the screen.
  await Promise.all(CLINICAL.map(async ([type, filter, label, textOf]) => {
    const group = $(`#c-${type}`);
    try {
      const b = await traced({ id: `clinical-${type}`, kind: "clinical", title: `Search ${type}` }, `${ISS}/${type}?${filter}&patient=Patient/${s.patient}`, { headers: fhirHeaders(s.token) }, b => ({ [label]: b.entry?.length ?? 0 }));
      const items = (b.entry ?? []).map(e => textOf(e.resource)).filter(Boolean);
      group.innerHTML = `<h3>${label}</h3>${items.length ? `<ul>${items.map(t => `<li>${esc(t)}</li>`).join("")}</ul>` : `<p class="none">None active.</p>`}`;
    } catch (e) { group.innerHTML = `<h3>${label}</h3><p class="error">${esc(e.message)}</p>`; }
  }));
}
async function loadStudies(s) {
  const el = $("#studies");
  let bundle;
  try { bundle = await traced({ id: "imaging", kind: "imaging", title: "Search imaging studies" }, `${s.imaging}/ImagingStudy?patient=Patient/${s.patient}&_include=ImagingStudy:endpoint&_count=100`, { headers: fhirHeaders(s.token) }, b => { const of = t => (b.entry ?? []).filter(e => e.resource.resourceType === t).length; return { Studies: of("ImagingStudy"), Endpoints: of("Endpoint") }; }); }
  catch (e) { el.innerHTML = `<p class="error">${esc(e.message)}</p>`; throw e; }
  const entries = bundle.entry ?? [];
  const studies = entries.filter(e => e.resource.resourceType === "ImagingStudy").map(e => e.resource).map(r => ({
    ...r,
    uid: r.identifier.find(i => i.system === "urn:dicom:uid")?.value.replace(/^urn:oid:/, "") ?? r.identifier[0].value.replace(/^urn:oid:/, ""),
    address: r.endpoint?.[0] && entries.find(e => e.fullUrl === r.endpoint[0].reference)?.resource.address,
  })).sort((a, b) => String(b.started ?? "").localeCompare(String(a.started ?? "")));
  if (!studies.length) { el.innerHTML = `<p class="note">This patient has no studies this app can see.</p>`; $("#stage-note").textContent = "No studies to show."; return; }
  el.innerHTML = `<ul class="study-list-client">${studies.map((st, i) => `<li><button type="button" class="study-button" data-i="${i}" aria-pressed="false" ${st.address ? "" : "disabled"}><strong>${esc(st.description ?? st.modality?.[0]?.code ?? "Study")}</strong><span>${esc([studyDate(st.started), (st.modality ?? []).map(m => m.code).join(", "), st.address ? plural(st.numberOfInstances ?? 0, "image") : "Images not available to this app"].filter(Boolean).join(" · "))}</span></button></li>`).join("")}</ul>`;
  $$(".study-button", el).forEach(b => b.addEventListener("click", () => openStudy(s, studies[Number(b.dataset.i)], b)));
  const first = studies.find(st => st.address);
  if (first) openStudy(s, first, $(`.study-button[data-i="${studies.indexOf(first)}"]`, el));
}

// The viewer.
let kitPromise, renderer;
const decoder = () => kitPromise ??= import(`${KIT}viewer-kit.js`).then(async kit => ({ kit, pool: await kit.DecoderPool.create({ wasm: `${KIT}shl_dicom_decode.wasm`, workerUrl: `${KIT}decoder-worker.js` }) }));
/** What's open: a study, one of its series, and that series' images. Replaced whole, so late answers can tell they're stale. */
let view;
const stats = { images: 0, bytes: 0, firstMs: undefined, started: 0 };

const canvas = $("#canvas"), stage = $("#stage"), slider = $("#slice");
function note(text) { $("#stage-note").textContent = text; }
function sizeCanvas() {
  if (!renderer) return;
  const r = canvas.getBoundingClientRect(), dpr = devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(r.width * dpr)); canvas.height = Math.max(1, Math.round(r.height * dpr));
  renderer.draw?.();
}
new ResizeObserver(sizeCanvas).observe(canvas);

/** The one part of a single-instance retrieval, as bytes for the decoder. */
function onlyPart(buffer, contentType) {
  const boundary = contentType?.match(/boundary="?([^";]+)/)?.[1];
  const bytes = new Uint8Array(buffer);
  if (!boundary) return buffer;
  const CRLF2 = [13, 10, 13, 10];
  let head = -1;
  for (let i = 0; i + 4 <= Math.min(bytes.length, 4096); i++) if (CRLF2.every((c, k) => bytes[i + k] === c)) { head = i; break; }
  if (head < 0) throw new Error("The response had no multipart header.");
  const start = head + 4, length = new TextDecoder().decode(bytes.subarray(0, head)).match(/content-length:\s*(\d+)/i)?.[1];
  if (length) return buffer.slice(start, start + Number(length));
  const close = new TextEncoder().encode(`\r\n--${boundary}`);
  for (let i = bytes.length - close.length; i >= start; i--) if (close.every((c, k) => bytes[i + k] === c)) return buffer.slice(start, i);
  throw new Error("The response had no closing boundary.");
}
async function retrieve(v, instance, signal, url = `${v.study.address}/studies/${v.study.uid}/series/${v.series.uid}/instances/${instance}`) {
  const t0 = performance.now();
  const res = await fetch(url, { headers: { authorization: `Bearer ${v.session.token}`, accept: WADO_ACCEPT }, signal });
  if (!res.ok) { await res.body?.cancel(); addStep({ id: "wado", kind: "wado", title: "Retrieve images", failed: true, request: requestLine("GET", url, { authorization: "x", accept: WADO_ACCEPT }), response: `HTTP ${res.status}` }); throw new Error(`The image server answered ${res.status}.`); }
  const buffer = await res.arrayBuffer();
  stats.images++; stats.bytes += buffer.byteLength;
  addStep({ id: "wado", kind: "wado", title: "Latest image retrieved", ms: Math.round(performance.now() - t0), request: requestLine("GET", url, { authorization: "x", accept: WADO_ACCEPT }), response: `HTTP ${res.status}\ncontent-type: ${res.headers.get("content-type")}`, curl: curlOf(url, { authorization: "x", accept: WADO_ACCEPT }), facts: { Images: stats.images, Data: bytes(stats.bytes), ...(stats.firstMs === undefined ? {} : { "First image": `${stats.firstMs} ms` }) } });
  return onlyPart(buffer, res.headers.get("content-type"));
}
/** An image, decoded once however many times it's asked for. */
function imageAt(v, i, priority) {
  const slice = v.slices[i];
  let p = v.images.get(slice.instance);
  if (!p) {
    p = (async () => {
      const [{ pool }, data] = await Promise.all([decoder(), retrieve(v, slice.instance, v.abort.signal)]);
      return pool.decode(data, { key: `${v.series.uid}/${slice.instance}${v.scale ? `@${v.scale}` : ""}`, priority, signal: v.abort.signal, ...(v.scale ? { scale: v.scale } : {}) });
    })();
    v.images.set(slice.instance, p);
    p.catch(() => v.images.delete(slice.instance));
  }
  return p;
}
async function show(v, i) {
  const { kit } = await decoder();
  v.at = i;
  slider.value = String(i);
  $("#slice-out").textContent = `${i + 1} / ${v.slices.length}`;
  let img;
  try { img = await imageAt(v, i, kit.Priority.Visible); }
  catch (e) { if (v === view && v.at === i && e.name !== "AbortError") note(e.decoderMessage ?? e.message); return; }
  if (v !== view || v.at !== i) return;
  renderer ??= (sizeCanvasFirst(), kit.createRenderer(canvas));
  if (!v.window) { const w = kit.defaultWindow(img); v.window = v.defaultWindow = { center: w.center, width: w.width }; }
  renderer.setFrame(kit.frameOf(img, v.slices[i].frame), { windowCenter: v.window.center, windowWidth: v.window.width });
  v.shown = img;
  applyView(kit, v);
  note("");
  if (stats.firstMs === undefined) stats.firstMs = Math.round(performance.now() - stats.started);
  // A single multi-frame instance: its frames become the images.
  if (img.frames > 1 && v.slices.length === 1) {
    v.slices = Array.from({ length: img.frames }, (_, frame) => ({ instance: v.slices[0].instance, frame }));
    slider.max = String(v.slices.length - 1); slider.disabled = false;
    $("#slice-out").textContent = `${i + 1} / ${v.slices.length}`;
  }
  writeOverlay(v, img);
}
function sizeCanvasFirst() { const r = canvas.getBoundingClientRect(), dpr = devicePixelRatio || 1; canvas.width = Math.max(1, Math.round(r.width * dpr)); canvas.height = Math.max(1, Math.round(r.height * dpr)); }
function applyView(kit, v) {
  renderer.setView({ ...kit.defaultView(), windowCenter: v.window.center, windowWidth: v.window.width, zoom: v.zoom, panX: v.panX, panY: v.panY, invert: v.invert });
  if (v.shown) writeOverlay(v, v.shown);
}
function writeOverlay(v, img) {
  $("#overlay").textContent = `${v.series.description ?? v.series.modality?.code ?? ""}\n${img.columns} × ${img.rows}  W ${Math.round(v.window.width)} C ${Math.round(v.window.center)}  Zoom ${Math.round(v.zoom * 100)}%`;
}
/** Everything else in the series, nearest first, a few at a time. The first few wait for the picture on screen. */
async function prefetch(v, kit) {
  const order = v.slices.map((_, i) => i).filter(i => i !== v.at).sort((a, b) => Math.abs(a - v.at) - Math.abs(b - v.at));
  let next = 0;
  const worker = async () => {
    while (v === view && next < order.length) {
      const i = order[next++];
      try { await imageAt(v, i, Math.abs(i - v.at) <= NEAR ? kit.Priority.Near : kit.Priority.Prefetch); } catch {}
    }
  };
  await Promise.all(Array.from({ length: FETCHES_AT_ONCE }, worker));
}
/** A slide's small picture: the pyramid's THUMBNAIL, or its smallest single-frame level. Never OVERVIEW, which can show the label. */
async function slideInstance(v) {
  const res = await fetch(`${v.study.address}/studies/${v.study.uid}/series/${v.series.uid}/metadata`, { headers: { authorization: `Bearer ${v.session.token}`, accept: "application/dicom+json" }, signal: v.abort.signal });
  if (!res.ok) throw new Error(`The image server answered ${res.status} for this slide's details.`);
  const items = await res.json(), get = (o, t) => o?.[t]?.Value;
  const typeOf = o => get(o, "00080008") ?? [], uid = o => get(o, "00080018")?.[0];
  const thumb = items.find(o => typeOf(o)[2] === "THUMBNAIL");
  if (thumb) return uid(thumb);
  const area = o => Number(get(o, "00280010")?.[0] ?? 0) * Number(get(o, "00280011")?.[0] ?? 0);
  return items.filter(o => typeOf(o)[2] === "VOLUME" && Number(get(o, "00280008")?.[0] ?? 1) === 1).sort((a, b) => area(a) - area(b))[0] && uid(items.filter(o => typeOf(o)[2] === "VOLUME" && Number(get(o, "00280008")?.[0] ?? 1) === 1).sort((a, b) => area(a) - area(b))[0]);
}
async function openSeries(session, study, series) {
  view?.abort.abort();
  const v = view = { session, study, series, slices: [], images: new Map(), abort: new AbortController(), at: 0, window: undefined, defaultWindow: undefined, scale: 0, zoom: 1, panX: 0, panY: 0, invert: false };
  syncInvert();
  stats.started = performance.now(); stats.firstMs = undefined;
  $$("#series button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.uid === series.uid)));
  $("#overlay").textContent = ""; note("Retrieving…");
  slider.disabled = true; $("#reset-view").disabled = false;
  try {
    if (series.modality?.code === "SM") {
      const instance = await slideInstance(v);
      if (!instance) { note("This slide has no small picture to show."); return; }
      v.slices = [{ instance, frame: 0 }];
    } else {
      v.slices = [...(series.instance ?? [])].sort((a, b) => (a.number ?? 0) - (b.number ?? 0)).map(i => ({ instance: i.uid, frame: 0 }));
    }
  } catch (e) { if (v === view && e.name !== "AbortError") note(e.message); return; }
  if (v !== view) return;
  if (!v.slices.length) { note("This series has no images."); return; }
  slider.max = String(v.slices.length - 1);
  slider.disabled = v.slices.length < 2;
  const { kit } = await decoder();
  if (v !== view) return;
  await show(v, Math.floor((v.slices.length - 1) / 2));
  if (v === view && v.slices.length > 1) prefetch(v, kit);
}
function openStudy(session, study, button) {
  $$(".study-button").forEach(b => b.setAttribute("aria-pressed", String(b === button)));
  const images = (study.series ?? []).filter(s => !NOT_IMAGES.has(s.modality?.code));
  $("#series").innerHTML = images.length > 1 ? images.map(s => `<button type="button" data-uid="${esc(s.uid)}" aria-pressed="false">${esc(s.description || `Series ${s.number ?? ""}`)} <span>(${s.numberOfInstances ?? s.instance?.length ?? 0})</span></button>`).join("") : "";
  $$("#series button").forEach(b => b.addEventListener("click", () => openSeries(session, study, images.find(s => s.uid === b.dataset.uid))));
  if (!images.length) { view?.abort.abort(); view = undefined; note("This study has no images to show."); return; }
  // The series with the most images is usually the one to look at first.
  openSeries(session, study, [...images].sort((a, b) => (b.numberOfInstances ?? 0) - (a.numberOfInstances ?? 0))[0]);
}
function step(delta) { if (view?.slices.length) show(view, Math.min(view.slices.length - 1, Math.max(0, view.at + delta))); }
slider.addEventListener("input", () => { if (view) show(view, Number(slider.value)); });
stage.addEventListener("wheel", e => {
  if (!view) return;
  if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoomBy(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP); return; }
  if (view.slices.length < 2) return;
  e.preventDefault(); step(Math.sign(e.deltaY));
}, { passive: false });
stage.addEventListener("keydown", e => {
  const d = { ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1 }[e.key];
  if (d) { e.preventDefault(); step(d); }
  if (e.key === "+" || e.key === "=") zoomBy(ZOOM_STEP);
  if (e.key === "-") zoomBy(1 / ZOOM_STEP);
});
let drag, tool = "window";
const ZOOM_STEP = 1.25;
async function refreshView() { if (!view?.window || !renderer) return; const { kit } = await decoder(); applyView(kit, view); }
function zoomBy(factor) { if (!view) return; view.zoom = Math.min(16, Math.max(0.25, view.zoom * factor)); refreshView(); }
function setTool(name) { tool = name; $("#tool-window").setAttribute("aria-pressed", String(name === "window")); $("#tool-pan").setAttribute("aria-pressed", String(name === "pan")); stage.style.cursor = name === "pan" ? "move" : ""; }
function syncInvert() { $("#invert").setAttribute("aria-pressed", String(!!view?.invert)); }
$("#tool-window").addEventListener("click", () => setTool("window"));
$("#tool-pan").addEventListener("click", () => setTool("pan"));
$("#zoom-in").addEventListener("click", () => zoomBy(ZOOM_STEP));
$("#zoom-out").addEventListener("click", () => zoomBy(1 / ZOOM_STEP));
$("#invert").addEventListener("click", () => { if (!view) return; view.invert = !view.invert; syncInvert(); refreshView(); });
stage.addEventListener("pointerdown", e => { if (!view?.window) return; drag = { x: e.clientX, y: e.clientY, panX: view.panX, panY: view.panY, ...view.window }; stage.setPointerCapture(e.pointerId); });
stage.addEventListener("pointermove", async e => {
  if (!drag || !view?.window || !renderer) return;
  if (tool === "pan") {
    const dpr = devicePixelRatio || 1;
    view.panX = drag.panX + (e.clientX - drag.x) * dpr; view.panY = drag.panY + (e.clientY - drag.y) * dpr;
    refreshView();
    return;
  }
  const gain = Math.max(drag.width, 1) / 400;
  view.window = { width: Math.max(1, drag.width + (e.clientX - drag.x) * gain), center: drag.center + (e.clientY - drag.y) * gain };
  const { kit } = await decoder();
  applyView(kit, view);
});
const endDrag = () => { drag = undefined; };
stage.addEventListener("pointerup", endDrag); stage.addEventListener("pointercancel", endDrag);
$("#reset-view").addEventListener("click", async () => {
  if (!view?.defaultWindow) return;
  view.window = view.defaultWindow;
  view.zoom = 1; view.panX = 0; view.panY = 0; view.invert = false;
  syncInvert();
  refreshView();
});

/** Our own sandbox's storage choice. A server that isn't ours has no such API, and the control stays hidden. */
async function initSource(session) {
  if (!BASE) return;
  let status;
  try { status = await api("GET", "/api/settings/status"); } catch { return; }
  const select = $("#source-select"), health = $("#source-health");
  select.innerHTML = status.backend.names.map(n => `<option value="${esc(n)}" ${n === status.backend.current ? "selected" : ""}>${esc(BACKEND_LABELS[n] ?? n)}</option>`).join("");
  const showHealth = async () => {
    try {
      const r = await api("GET", "/api/settings/backends"), mine = r.backends.find(b => b.name === r.current);
      health.textContent = mine ? `${mine.ok ? "Working" : "Not working"}: ${mine.detail}` : "";
    } catch { health.textContent = ""; }
  };
  select.addEventListener("change", async () => {
    select.disabled = true;
    try {
      await api("POST", "/api/settings/backend", { backend: select.value });
      showHealth();
      view?.abort.abort(); view = undefined;
      note("Retrieving…");
      await loadStudies(session);
    } catch (e) { health.textContent = e.message; }
    finally { select.disabled = false; }
  });
  $("#source").hidden = false;
  showHealth();
}
function showApp() {
  $("#landing").hidden = true; $("#app").hidden = false; $("#disconnect").hidden = false;
  renderTrail();
}
async function run(session) {
  showApp();
  initSource(session);
  const results = await Promise.allSettled([loadPatient(session), loadClinical(session), loadStudies(session)]);
  if (results.some(r => r.reason?.status === 401)) { save({ session: undefined }); announce("Your session ended. Connect again."); note("Your session ended. Disconnect, then connect again."); }
}
$("#connect").addEventListener("click", connect);
$("#disconnect").addEventListener("click", disconnect);
// The header's links stay in this visitor's sandbox.
if (BASE) for (const a of $$("a[href^='/']")) a.setAttribute("href", `${BASE}${a.getAttribute("href")}`);

(async function start() {
  const params = new URLSearchParams(location.search);
  try {
    if (params.has("code") || params.has("error")) { const s = await finishSignIn(params); await run(s); return; }
    if (saved().session) { await run(saved().session); return; }
    if (params.get("connect") === "1" && BASE) { history.replaceState(null, "", REDIRECT); await connect(); }
  } catch (e) {
    $("#landing").hidden = false; $("#app").hidden = true;
    const el = $("#connect-error"); el.hidden = false; el.textContent = e.message;
  }
})();
