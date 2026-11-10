// The public demo client: a standalone SMART App Launch against this deployment, then its clinical and
// imaging data with one token. Every request goes through `traced`, which keeps what the protocol panel
// shows. Images come one instance at a time, the search result already naming them: the middle one
// first, then outward, so the first picture doesn't wait for the rest of the study.
const CLIENT_ID = "demo-client", SCOPE = "launch/patient patient/*.rs";
const REDIRECT = `${location.origin}${BASE}/`, VIEWER = `${BASE}/viewer`;
const onViewer = () => location.pathname === VIEWER;
const SANDBOX = { id: "sandbox", label: "SMART Imaging sandbox", detail: "Your own sandbox of sample patients", own: true };
const allServers = () => [SANDBOX, ...savedServers().map(s => ({ ...s, id: serverKey(s), detail: new URL(s.iss).host }))];
function chosenServer() { const all = allServers(); return all.find(s => s.id === stored(CHOICE_KEY)) ?? all[0]; }
function renderServers() {
  const chosen = chosenServer();
  $("#servers").innerHTML = allServers().map(s => `<label class="server"><input type="radio" name="server" value="${esc(s.id)}" ${s.id === chosen.id ? "checked" : ""}><strong>${esc(s.label)}</strong><span>${esc(s.detail)}</span></label>`).join("");
  $$("input[name=server]").forEach(r => r.addEventListener("change", () => store(CHOICE_KEY, r.value)));
}
const STORE = `smart-imaging-client:${BASE}`;

const saved = () => { try { return JSON.parse(sessionStorage.getItem(STORE) ?? "{}"); } catch { return {}; } };
const save = patch => { try { sessionStorage.setItem(STORE, JSON.stringify({ ...saved(), ...patch })); } catch {} };

// The protocol panel.
const trail = saved().trail ?? [];
const IG = "https://build.fhir.org/ig/argonautproject/smart-imaging/", SMART = "https://build.fhir.org/ig/HL7/smart-app-launch/";
/** The protocol as the client meets it. Requests are the detail; these are the story. */
const STAGES = [
  { key: "discover", from: "This app", to: "Clinical FHIR server", name: "Discover", line: "From one FHIR address, find the sign-in page and the imaging server.", kinds: ["discover"], spec: [`${SMART}conformance.html`, "SMART discovery"] },
  { key: "authorize", from: "Browser and app", to: "Authorization server", name: "Authorize", line: "Sign in, approve this app, and receive an access token for one patient.", kinds: ["authorize", "token", "backend-token"], spec: [`${SMART}app-launch.html`, "SMART App Launch"] },
  { key: "clinical", from: "This app", to: "Clinical FHIR server", name: "Read the chart", line: "Query the clinical server with that token.", kinds: ["patient", "clinical"], spec: [`${SMART}scopes-and-launch-context.html`, "Sandboxes and context"] },
  { key: "imaging", from: "This app", to: "Imaging FHIR server", name: "Find studies", line: "Ask the imaging server for studies, and where to retrieve each one.", kinds: ["imaging"], spec: [IG, "SMART Imaging Access"] },
  { key: "retrieve", from: "This app", to: "DICOMweb endpoint", name: "Retrieve images", line: "Download DICOM from each study's Endpoint, and decode it in the browser.", kinds: ["wado"], spec: ["https://www.dicomstandard.org/using/dicomweb/retrieve-wado-rs-and-wado-uri", "DICOMweb WADO-RS"] },
];
const WHY = {
  discover: "The app reads the SMART configuration at its FHIR address. That says where to sign in, and associated_endpoints names the imaging server, chosen by its smart-imaging-access capability.",
  authorize: "The app sends the browser to the sign-in page with the scopes it wants and a PKCE challenge. It never sees the password, and it gets back a one-time code.",
  "backend-token": "A backend service has no user to sign in. It proves its identity with an assertion signed by its private key, and the server checks that against the public key it registered. What it can reach was granted in advance.",
  token: "The app sends that code with its PKCE verifier. The response has an access token and the patient it applies to.",
  patient: "The app reads the patient named in the token response.",
  clinical: "An ordinary FHIR search on the clinical server, using the access token.",
  imaging: "The same access token, sent to the imaging server found during discovery. Each study comes back with an Endpoint saying where to retrieve its images.",
  wado: "A DICOMweb WADO-RS retrieval from the address in the study's Endpoint, still sending the access token. Each request is one DICOM instance.",
};
/** Which system answered each kind of request. */
const ANSWERED_BY = { "backend-token": "Authorization server", discover: "Clinical FHIR server", authorize: "Authorization server", token: "Authorization server", patient: "Clinical FHIR server", clinical: "Clinical FHIR server", imaging: "Imaging FHIR server", wado: "DICOMweb endpoint" };
const openCalls = new Set();
const stageOf = kind => STAGES.find(st => st.kinds.includes(kind));
function stageState(steps, stage) {
  if (steps.some(s => s.failed)) return "failed";
  return steps.length ? "done" : "waiting";
}
const GLYPH = { done: "✓", failed: "✕" };
const STATE_WORD = { done: "Done", failed: "Failed", waiting: "Not yet" };
function stageHtml(stage, index, open = false) {
  const steps = trail.filter(s => stage.kinds.includes(s.kind)), state = stageState(steps, stage);
  // A service never signs anyone in, so that stage says what it does instead.
  const asService = steps.some(s => s.kind === "backend-token");
  if (asService) stage = { ...stage, from: "This service", line: "Prove this service's identity with a signed assertion, and receive an access token." };
  const facts = Object.assign({}, ...steps.map(s => s.facts ?? {}));
  const tiles = Object.entries(facts).map(([k, v]) => `<div class="fact${String(v).length > 12 ? " long" : ""}"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("");
  const calls = steps.map(callHtml).join("");
  return `<span class="node" aria-hidden="true">${GLYPH[state] ?? index + 1}</span>
    <div class="stage-body">
      <h3>${esc(stage.name)}<span class="sr-only"> (${STATE_WORD[state]})</span></h3>
      <p class="parties"><span>${esc(stage.from)}</span><span class="arrow" aria-hidden="true">→</span><span class="sr-only">talks to</span><span>${esc(stage.to)}</span></p>
      <p class="line">${esc(stage.line)}</p>
      ${tiles ? `<dl class="facts-grid">${tiles}</dl>` : ""}
      ${steps.length ? `<details class="calls" ${open ? "open" : ""}><summary>${plural(steps.length, "request")}</summary><ul class="call-list">${calls}</ul><p class="spec">Underlying standard: <a href="${stage.spec[0]}" target="_blank" rel="noopener">${esc(stage.spec[1])}</a></p></details>` : ""}
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
  const service = trail.some(s => s.kind === "backend-token");
  const shown = STAGES.filter(st => !(service && st.key === "clinical"));
  list.innerHTML = shown.map(st => `<li class="stage-row" data-stage="${st.key}"></li>`).join("");
  shown.forEach(paintStage);
}
function callHtml(s) {
  const status = s.failed ? "Failed" : s.status ?? "OK";
  return `<li><details class="call" data-call="${esc(s.id)}" ${openCalls.has(s.id) ? "open" : ""}>
    <summary><span class="call-title">${esc(s.title)}</span><span class="call-status${s.failed ? " bad" : ""}">${esc(status)}</span>${s.ms === undefined ? "" : `<span class="call-ms">${s.ms} ms</span>`}<span class="chevron" aria-hidden="true"></span></summary>
    <div class="call-body">
      <p class="call-why">${esc(WHY[s.kind] ?? "")}</p>
      <dl class="call-facts"><dt>Answered by</dt><dd>${esc(ANSWERED_BY[s.kind] ?? "")}</dd></dl>
      ${s.request ? `<h4>Request</h4><pre>${esc(s.request)}</pre>` : ""}
      ${s.response ? `<h4>Response</h4><pre>${esc(s.response)}</pre>` : ""}
      ${s.curl ? `<button type="button" class="tool copy" data-copy="${esc(s.id)}">Copy as curl</button>` : ""}
    </div>
  </details></li>`;
}
$("#trail").addEventListener("toggle", e => {
  if (!e.target.matches?.("details.call")) return;
  if (e.target.open) openCalls.add(e.target.dataset.call); else openCalls.delete(e.target.dataset.call);
}, true);
$("#trail").addEventListener("click", async e => {
  const b = e.target.closest("[data-copy]");
  if (!b) return;
  const step = trail.find(t => t.id === b.dataset.copy);
  try { await navigator.clipboard.writeText(step.curl); b.textContent = "Copied. Set $TOKEN first"; }
  catch { b.textContent = "Couldn't copy"; }
  setTimeout(() => { if (b.isConnected) b.textContent = "Copy as curl"; }, 2500);
});
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
  const masked = String(text).replace(/("(?:access_token|refresh_token|id_token)"\s*:\s*")[^"]+/g, "$1…").replace(/((?:code|code_verifier|client_assertion)=)[^&\s]+/g, "$1…").replace(/[A-Za-z0-9_.~-]{72,}/g, m => `${m.slice(0, 16)}…${m.slice(-8)}`);
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
  try { res = await patientFetch(url, init, seconds => addStep({ ...step, request, status: "503", response: `HTTP 503\nretry-after: ${seconds}\n\nThe server is assembling this. Waiting ${seconds} s, then asking again.` })); text = await res.text(); }
  catch (e) { addStep({ ...step, request, failed: true, response: String(e) }); throw e; }
  let found = {};
  if (res.ok) { try { found = learned(JSON.parse(text)); } catch {} }
  addStep({ ...step, request, facts: found, status: `${res.status}`, curl: method === "GET" ? curlOf(url, init.headers) : undefined, ms: Math.round(performance.now() - started), failed: !res.ok, response: `HTTP ${res.status}\n\n${preview(pretty(text))}` });
  if (!res.ok) throw Object.assign(new Error(`${step.title}: HTTP ${res.status}`), { status: res.status });
  return JSON.parse(text);
}

// Connecting.
const random = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
async function discover(iss) {
  return traced({ id: "discover", kind: "discover", title: "Discover the servers" }, `${iss}/.well-known/smart-configuration`, {}, c => {
    const found = imagingOf(c, iss);
    return { "Sign-in": new URL(c.authorization_endpoint).host, "Imaging server": found ? `${new URL(found.url).host}${found.unified ? " (this server)" : ""}` : "None advertised" };
  });
}
const connecting = on => document.documentElement.classList.toggle("connecting", on);
async function connect() {
  const button = $("#connect");
  button.disabled = true;
  connecting(true);
  try {
    const server = chosenServer();
    if (server.mode === "backend") { await connectBackend(server); return; }
    trail.length = 0;
    const iss = server.own ? `${location.origin}${BASE}/fhir` : server.iss, clientId = server.own ? CLIENT_ID : server.clientId, scope = server.scope ?? SCOPE;
    const config = await discover(iss);
    if (config.code_challenge_methods_supported && !config.code_challenge_methods_supported.includes("S256")) throw new Error("This server doesn't offer PKCE with S256.");
    // Nobody signs in to a server this app can't use.
    if (!imagingOf(config, iss) && !server.imaging) throw new Error("This server doesn't advertise SMART Imaging with App Launch. If you know where its imaging FHIR server is, add it under Advanced on Test your server.");
    const verifier = random(), state = random();
    const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
    save({ pending: { verifier, state, config, iss, clientId, imaging: server.imaging, own: !!server.own, label: server.label, jwk: server.jwk } });
    const url = new URL(config.authorization_endpoint);
    Object.entries({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, scope, aud: iss, state, code_challenge: challenge, code_challenge_method: "S256" }).forEach(([k, v]) => url.searchParams.set(k, v));
    addStep({ id: "authorize", kind: "authorize", title: "Sign in and approve the app", request: requestLine("GET", url.toString().replace(/([?&](state|code_challenge)=)[^&]+/g, "$1…")), response: "The browser returned with a one-time code." });
    location.assign(url);
  } catch (e) {
    connecting(false);
    button.disabled = false;
    const el = $("#connect-error"); el.hidden = false; el.textContent = e.message;
  }
}
/** A backend service: no one signs in. It proves its identity, gets a token, and names the patient itself. */
async function connectBackend(server) {
  trail.length = 0;
  const config = await discover(server.iss);
  const imaging = imagingOf(config, server.iss, BACKEND_CAPABILITY)?.url ?? server.imaging;
  if (!imaging) throw new Error("This server doesn't advertise SMART Imaging for Backend Services.");
  const scope = server.scope ?? "system/ImagingStudy.rs";
  const body = new URLSearchParams({ grant_type: "client_credentials", scope, client_assertion_type: ASSERTION_TYPE, client_assertion: await signAssertion(server.jwk, server.clientId, config.token_endpoint) }).toString();
  const token = await traced({ id: "backend-token", kind: "backend-token", title: "Authenticate and get a token" }, config.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body }, t => ({ Granted: t.scope, "Token lasts": `${Math.round(t.expires_in / 60)} min` }));
  const session = { token: token.access_token, patient: server.patient, imaging: imaging.replace(/\/$/, ""), iss: server.iss, own: false, label: server.label, backend: true };
  save({ session });
  history.pushState(null, "", VIEWER);
  await run(session);
}
async function finishSignIn(params) {
  const { pending } = saved();
  history.replaceState(null, "", REDIRECT);
  if (!pending || pending.state !== params.get("state")) throw new Error("This sign-in didn't start here. Connect again.");
  save({ pending: undefined });
  if (params.get("error")) { addStep({ id: "authorize", kind: "authorize", title: "Sign in and approve the app", failed: true, response: params.get("error") }); throw new Error(`The sign-in ended with: ${params.get("error")}`); }
  const body = new URLSearchParams({ grant_type: "authorization_code", code: params.get("code"), redirect_uri: REDIRECT, client_id: pending.clientId, code_verifier: pending.verifier, ...(pending.jwk ? { client_assertion_type: ASSERTION_TYPE, client_assertion: await signAssertion(pending.jwk, pending.clientId, pending.config.token_endpoint) } : {}) }).toString();
  const token = await traced({ id: "token", kind: "token", title: "Exchange the code for a token" }, pending.config.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body }, t => ({ Granted: t.scope, "Token lasts": `${Math.round(t.expires_in / 60)} min` }));
  const imaging = imagingOf(pending.config, pending.iss)?.url ?? pending.imaging;
  if (!imaging) throw new Error("This server doesn't advertise SMART Imaging with App Launch. If you know where its imaging FHIR server is, add it under Advanced on Test your server.");
  if (!token.patient) throw new Error("The token response didn't name a patient.");
  const session = { token: token.access_token, patient: token.patient, imaging, iss: pending.iss, own: pending.own, label: pending.label };
  save({ session });
  // The viewer has an address of its own, so Back from it returns to the overview.
  history.replaceState(null, "", VIEWER);
  return session;
}
function disconnect() {
  try { sessionStorage.removeItem(STORE); } catch {}
  location.assign(`${BASE}/`);
}

// The chart.
const CLINICAL = [
  ["AllergyIntolerance", "clinical-status=active", "Allergies", r => r.code?.text],
  ["Condition", "clinical-status=active", "Conditions", r => r.code?.text],
  ["MedicationRequest", "status=active", "Medications", r => r.medicationCodeableConcept?.text],
];
async function loadPatient(s) {
  const el = $("#patient");
  try {
    const p = await traced({ id: "patient", kind: "patient", title: "Read the patient" }, `${s.iss}/Patient/${s.patient}`, { headers: fhirHeaders(s.token) });
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
      const b = await traced({ id: `clinical-${type}`, kind: "clinical", title: `Search ${type}` }, `${s.iss}/${type}?${filter}&patient=Patient/${s.patient}`, { headers: fhirHeaders(s.token) }, b => ({ [label]: b.entry?.length ?? 0 }));
      const items = (b.entry ?? []).map(e => textOf(e.resource)).filter(Boolean);
      group.innerHTML = `<h3>${label}</h3>${items.length ? `<ul>${items.map(t => `<li>${esc(t)}</li>`).join("")}</ul>` : `<p class="none">None active.</p>`}`;
    } catch (e) { group.innerHTML = `<h3>${label}</h3><p class="none">${e.status === 404 ? "This server doesn't offer this search." : esc(e.message)}</p>`; }
  }));
}
/** The patient's reports. Each opens as its PDF, and leads to the images of the same accession number. */
async function loadReports(s) {
  const el = $("#reports");
  let bundle;
  try { bundle = await traced({ id: "reports", kind: "clinical", title: "Search DiagnosticReport" }, `${s.iss}/DiagnosticReport?patient=${encodeURIComponent(s.patient)}`, { headers: fhirHeaders(s.token) }, b => ({ Reports: b.entry?.length ?? 0 })); }
  catch (e) { el.innerHTML = `<p class="note">${e.status === 404 ? "This server doesn't offer reports." : esc(e.message)}</p>`; return; }
  const reports = (bundle.entry ?? []).map(e => e.resource).filter(r => r?.resourceType === "DiagnosticReport").sort((a, b) => String(b.effectiveDateTime ?? "").localeCompare(String(a.effectiveDateTime ?? "")));
  if (!reports.length) { el.innerHTML = `<p class="note">No reports this app can see.</p>`; return; }
  el.innerHTML = `<ul class="report-list">${reports.map((r, i) => `<li><details class="report"><summary><span class="report-title">${esc(r.code?.text ?? r.code?.coding?.[0]?.display ?? "Report")}</span><span class="report-date">${esc(studyDate(r.effectiveDateTime))}</span></summary><div class="report-body">${r.conclusion ? `<p>${esc(r.conclusion)}</p>` : ""}<div class="report-actions">${r.presentedForm?.some(f => f.contentType === "application/pdf") ? `<button type="button" class="tool" data-pdf="${i}">Open PDF</button>` : ""}<button type="button" class="tool" data-images="${i}">View images</button></div></div></details></li>`).join("")}</ul>`;
  el.onclick = async e => {
    const pdf = e.target.closest("[data-pdf]"), images = e.target.closest("[data-images]");
    if (images) {
      const r = reports[Number(images.dataset.images)], accession = r.identifier?.map(i => i.value) ?? [];
      const i = currentStudies.findIndex(st => st.identifier?.some(x => accession.includes(x.value)));
      const button = i >= 0 && !$(`.study-button[data-i="${i}"]`)?.disabled ? $(`.study-button[data-i="${i}"]`) : null;
      if (button) button.click(); else images.textContent = "No images available";
      return;
    }
    if (!pdf) return;
    // Opened before the fetch, while the tap still counts, so a phone doesn't block it.
    const tab = window.open("", "_blank");
    const form = reports[Number(pdf.dataset.pdf)].presentedForm.find(f => f.contentType === "application/pdf");
    const res = await fetch(new URL(form.url, `${s.iss}/`), { headers: { authorization: `Bearer ${s.token}` } });
    addStep({ id: "report-pdf", kind: "clinical", title: "Retrieve a report PDF", status: `${res.status}`, failed: !res.ok, request: requestLine("GET", form.url, { authorization: "x" }), response: `HTTP ${res.status}\ncontent-type: ${res.headers.get("content-type")}` });
    if (!res.ok) { tab?.close(); pdf.textContent = "Couldn't open"; return; }
    const url = URL.createObjectURL(await res.blob());
    if (tab) tab.location = url; else location.assign(url);
  };
}
let currentStudies = [];
/** Every page of the study search, each one recorded on the protocol panel. */
const searchStudies = s => searchAll(`${s.imaging}/ImagingStudy?patient=${encodeURIComponent(s.patient)}&_include=ImagingStudy:endpoint`, (url, page) => traced({ id: page === 1 ? "imaging" : `imaging-${page}`, kind: "imaging", title: page === 1 ? "Search imaging studies" : `Search imaging studies, page ${page}` }, url, { headers: fhirHeaders(s.token) }, b => { const of = t => (b.entry ?? []).filter(e => e.resource?.resourceType === t).length; return page === 1 ? { Studies: of("ImagingStudy"), Endpoints: of("Endpoint") } : { [`Page ${page}`]: of("ImagingStudy") }; }));
async function loadStudies(s) {
  const el = $("#studies");
  let entries, incomplete;
  try { ({ entries, incomplete } = await searchStudies(s)); }
  catch (e) { el.innerHTML = `<p class="error">${esc(e.message)}</p>`; throw e; }
  const studies = studiesFrom(entries);
  currentStudies = studies;
  const warning = incomplete ? `<p class="note">The server says these results are incomplete. Some sources haven't answered yet.</p>` : "";
  if (!studies.length) { el.innerHTML = `${warning}<p class="note">This patient has no studies this app can see.</p>`; $("#stage-note").textContent = "No studies to show."; return; }
  const usable = st => st.address && st.uid;
  el.innerHTML = `${warning}<ul class="study-list-client">${studies.map((st, i) => `<li><button type="button" class="study-button" data-i="${i}" aria-pressed="false" ${usable(st) ? "" : "disabled"}><strong>${esc(st.description ?? st.modality?.[0]?.code ?? "Study")}</strong><span>${esc([studyDate(st.started), (st.modality ?? []).map(m => m.code).join(", "), usable(st) ? plural(st.numberOfInstances ?? 0, "image") : st.status && st.status !== "available" ? `Not available (${st.status})` : "Images not available to this app"].filter(Boolean).join(" · "))}</span></button></li>`).join("")}</ul>`;
  $$(".study-button", el).forEach(b => b.addEventListener("click", () => openStudy(s, studies[Number(b.dataset.i)], b)));
  const first = studies.find(usable);
  if (first) openStudy(s, first, $(`.study-button[data-i="${studies.indexOf(first)}"]`, el));
}

// The viewer.
const viewer = ImageViewer.create($(".viewer"), { onShown: ms => { if (stats.firstMs === undefined) stats.firstMs = ms; } });
const note = text => viewer.note(text);
const stats = { images: 0, bytes: 0, firstMs: undefined };

/** How the viewer gets a study's images, each retrieval recorded on the protocol panel. */
const recordedSource = (session, study) => wadoSource(session.token, study, { seen: r => {
  const request = requestLine("GET", r.url, { authorization: "x", accept: WADO_ACCEPT });
  if (r.failed) { addStep({ id: "wado", kind: "wado", title: "Retrieve images", failed: true, request, response: `HTTP ${r.status}` }); return; }
  stats.images++; stats.bytes += r.bytes;
  addStep({ id: "wado", kind: "wado", title: "Latest image retrieved", ms: r.ms, request, response: `HTTP ${r.status}\ncontent-type: ${r.contentType}`, curl: curlOf(r.url, { authorization: "x", accept: WADO_ACCEPT }), facts: { Images: stats.images, Data: bytes(stats.bytes), ...(stats.firstMs === undefined ? {} : { "First image": `${stats.firstMs} ms` }) } });
} });
function openStudy(session, study, button) {
  $$(".study-button").forEach(b => b.setAttribute("aria-pressed", String(b === button)));
  stats.firstMs = undefined;
  viewer.openStudy(viewerSeries(study), recordedSource(session, study));
}

// The sandboxes this browser knows. The list is the only thing kept: the URL says which one a page is in.
const SANDBOXES_KEY = "smart-imaging-client:sandboxes";
function knownSandboxes() {
  try { return JSON.parse(stored(SANDBOXES_KEY) ?? "[]"); } catch { return []; }
}
const saveSandboxes = list => store(SANDBOXES_KEY, JSON.stringify(list));
const shareLink = base => `${location.origin}${base}/`;
/** A sandbox's name: `null` when the server says it's gone, and `undefined` when it couldn't be asked. */
async function sandboxName(base) {
  try { return (await api("GET", "/api/sandbox", undefined, base)).name; } catch (e) { return e.status === 404 ? null : undefined; }
}
/** The home page: the sandboxes this browser has made or joined, and a way to make another. */
function paintHome(list) {
  $("#sandbox-list").innerHTML = list.length ? list.map(w => `<li><a href="${esc(w.base)}/" data-root><strong>${esc(w.name ?? "Sandbox")}</strong><span>${w.joined ? "Shared with you" : "Made in this browser"}</span></a></li>`).join("") : `<li class="none">You don't have any yet.</li>`;
}
async function renderHome() {
  let list = knownSandboxes();
  // What this browser remembers, straight away, then checked against the server.
  paintHome(list);
  const names = new Map(await Promise.all(list.map(async w => [w.base, await sandboxName(w.base)])));
  // The list as it is now, since one made or joined meanwhile belongs on it. One deleted by whoever made it is
  // gone for everyone; one that couldn't be asked stays, as it was.
  list = knownSandboxes().flatMap(w => { const n = names.get(w.base); return n === null ? [] : [n ? { ...w, name: n } : w]; });
  saveSandboxes(list);
  paintHome(list);
}
$("#create").addEventListener("click", async () => {
  const button = $("#create"), err = $("#create-error");
  button.disabled = true;
  try {
    const r = await fetch("/api/sandboxes", { method: "POST" });
    if (!r.ok) throw new Error(r.status === 429 ? "Too many sandboxes from this address. Try again in a while." : `The sandbox couldn't be created (HTTP ${r.status})`);
    const { base } = await r.json();
    saveSandboxes([...knownSandboxes(), { base, joined: false }]);
    location.assign(`${base}/`);
  } catch (e) { err.hidden = false; err.textContent = e.message; button.disabled = false; }
});
/** Inside a sandbox: its name, and what can be done with it. A browser that hasn't joined it is asked first. */
async function renderSandbox() {
  const box = $("#sandbox");
  const list = knownSandboxes();
  const name = await sandboxName(BASE);
  if (name === null) { box.innerHTML = `<p class="error">This sandbox doesn't exist any more.</p><p><a href="/" data-root>Your sandboxes</a></p>`; return; }
  if (!name) { box.innerHTML = `<p class="error">This sandbox couldn't be reached. Reload to try again.</p><p><a href="/" data-root>Your sandboxes</a></p>`; return; }
  const mine = list.find(w => w.base === BASE);
  if (!mine) {
    box.innerHTML = `<h2>Join “${esc(name)}”?</h2><p class="note">Someone shared this sandbox with you. Anyone with its link can see and change it. It holds sample data only.</p><div class="sandbox-actions"><button type="button" class="primary" id="join">Join this sandbox</button></div>`;
    $("#join").addEventListener("click", () => { saveSandboxes([...knownSandboxes(), { base: BASE, joined: true, name }]); renderSandbox(); });
    return;
  }
  saveSandboxes(list.map(w => w.base === BASE ? { ...w, name } : w));
  box.innerHTML = `<p class="sandbox-label">Sandbox</p><div class="sandbox-head"><p class="sandbox-name" id="sandbox-name">${esc(name)}</p><button type="button" class="tool" id="rename">Rename</button></div>
    <div class="sandbox-actions"><button type="button" class="tool" id="share">Share</button><a class="tool" href="/" data-root>All sandboxes</a><button type="button" class="tool quiet-danger" id="end">${mine.joined ? "Leave" : "Delete"}</button></div>
    <div id="share-panel" hidden><input type="text" id="share-link" readonly aria-label="Link to this sandbox" value="${esc(shareLink(BASE))}"><p class="note" id="share-note">Anyone with this link can see and change this sandbox.</p></div>`;
  $("#rename").addEventListener("click", async () => {
    const next = prompt("Name this sandbox", name);
    if (next === null || !next.trim()) return;
    await api("PATCH", "/api/sandbox", { name: next });
    renderSandbox();
  });
  $("#share").addEventListener("click", async () => {
    const url = shareLink(BASE), panel = $("#share-panel"), note = $("#share-note");
    panel.hidden = false;
    $("#share-link").select();
    if (navigator.share) { try { await navigator.share({ title: `SMART Imaging sandbox: ${name}`, url }); return; } catch (e) { if (e.name === "AbortError") return; } }
    try { await navigator.clipboard.writeText(url); note.textContent = "Link copied. Anyone with it can see and change this sandbox."; } catch {}
  });
  $("#end").addEventListener("click", async () => {
    if (!mine.joined && !confirm(`Delete “${name}” and everything in it? Anyone you shared it with loses it too.`)) return;
    if (!mine.joined) try { await api("DELETE", "/api/sandbox"); } catch {}
    saveSandboxes(knownSandboxes().filter(w => w.base !== BASE));
    try { sessionStorage.removeItem(STORE); } catch {}
    location.assign("/");
  });
}
function showApp() {
  connecting(false);
  $("#landing").hidden = true; $("#app").hidden = false; $("#disconnect").hidden = false;
  renderTrail();
}
async function run(session) {
  showApp();
  $("#connected").textContent = session.own ? "" : `Connected to ${session.label}`;
  if (session.own && BASE) sandboxName(BASE).then(name => { if (name) $("#connected").textContent = `Sandbox: ${name}`; });
  if (session.backend) {
    $("#patient").innerHTML = `<p class="who">Patient ${esc(session.patient)}</p><p class="facts">Backend service: no one signed in</p>`;
    $("#clinical").hidden = true;
    $("#reports-panel").hidden = true;
    renderTrail();
  }
  const results = await Promise.allSettled(session.backend ? [loadStudies(session)] : [loadPatient(session), loadClinical(session), loadReports(session), loadStudies(session)]);
  if (results.some(r => r.reason?.status === 401)) { save({ session: undefined }); announce("Your session ended. Connect again."); note("Your session ended. Disconnect, then connect again."); }
}
renderServers();
$("#connect").addEventListener("click", connect);
$("#disconnect").addEventListener("click", disconnect);

// A page brought back by Back is as it was left: a disabled button, an old list, or "Connecting…". Bring it up to date.
addEventListener("pageshow", e => {
  if (!e.persisted) return;
  if (!BASE) { $("#create").disabled = false; renderHome(); return; }
  if (onViewer()) { if (!saved().session) location.replace(`${BASE}/`); return; }
  // The overview, as it was left on the way to sign-in: ready to connect again, or to go back to the viewer.
  connecting(false); $("#connect").disabled = false;
  showResume();
  renderSandbox();
});
/** On the overview, a way back to the viewer while this tab is still connected. */
function showResume() {
  const s = saved().session, el = $("#resume");
  el.hidden = !s;
  if (s) el.innerHTML = `Still connected${s.own ? "" : ` to ${esc(s.label)}`}. <a href="${esc(VIEWER)}" data-root>Back to the viewer</a>`;
}
(async function start() {
  const params = new URLSearchParams(location.search);
  if (!BASE) { renderHome(); return; }
  renderSandbox();
  try {
    if (params.has("code") || params.has("error")) { const s = await finishSignIn(params); await run(s); return; }
    // The viewer's own address shows the viewer, for a tab that's connected, and otherwise the overview.
    if (onViewer()) { if (saved().session) await run(saved().session); else location.replace(`${BASE}/`); return; }
    if (params.get("connect") === "1") { history.replaceState(null, "", REDIRECT); await connect(); return; }
    connecting(false);
    showResume();
  } catch (e) {
    connecting(false);
    $("#landing").hidden = false; $("#app").hidden = true;
    const el = $("#connect-error"); el.hidden = false; el.textContent = e.message;
  }
})();
