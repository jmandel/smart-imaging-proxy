// The public demo client: a standalone SMART App Launch against this deployment, then its clinical and
// imaging data with one token. Every request goes through `traced`, which keeps what the protocol panel
// shows. Images come one instance at a time, the search result already naming them: the middle one
// first, then outward, so the first picture doesn't wait for the rest of the study.
const CLIENT_ID = "demo-client", SCOPE = "launch/patient patient/*.rs";
const REDIRECT = `${location.origin}${BASE}/`;
/** Where another server sends the browser back: one fixed address, since a server registers its clients' redirects exactly. */
const ROOT_REDIRECT = `${location.origin}/`;
const SANDBOX = { id: "sandbox", label: "SMART Imaging sandbox", detail: "Your own sandbox of sample patients", own: true };
const DEFAULT_SERVERS = [];
const SERVERS_KEY = "smart-imaging-client:servers", CHOICE_KEY = "smart-imaging-client:choice", WORLD_KEY = "smart-imaging-client:world";
const stored = key => { try { return localStorage.getItem(key); } catch { return null; } };
const store = (key, value) => { try { value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch {} };
/** What a pasted configuration must be. Gives the servers, or throws saying what's wrong. */
function parseServers(text) {
  const list = JSON.parse(text);
  if (!Array.isArray(list)) throw new Error("Expected a JSON array of servers.");
  return list.map((s, i) => {
    const where = `Server ${i + 1}`;
    for (const k of ["label", "iss", "clientId"]) if (typeof s?.[k] !== "string" || !s[k].trim()) throw new Error(`${where} needs a "${k}".`);
    for (const k of ["iss", "imaging"]) if (s[k] !== undefined) {
      let u; try { u = new URL(s[k]); } catch { throw new Error(`${where}: "${k}" isn't a URL.`); }
      if (u.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(u.hostname)) throw new Error(`${where}: "${k}" must use https.`);
    }
    if (s.scope !== undefined && typeof s.scope !== "string") throw new Error(`${where}: "scope" must be text.`);
    return { label: s.label, iss: s.iss.replace(/\/$/, ""), clientId: s.clientId, ...(s.scope ? { scope: s.scope } : {}), ...(s.imaging ? { imaging: s.imaging.replace(/\/$/, "") } : {}) };
  });
}
/** The servers this browser has added. */
function savedServers() {
  try { const text = stored(SERVERS_KEY); if (text) return parseServers(text); } catch {}
  return [];
}
const serverKey = s => `${s.iss}|${s.clientId}`;
/** The built-ins, then this browser's own. An entry for the same server and client replaces the built-in. */
function configuredServers() {
  const saved = savedServers(), mine = new Map(saved.map(s => [serverKey(s), s]));
  return [...DEFAULT_SERVERS.map(s => mine.get(serverKey(s)) ?? s), ...saved.filter(s => !DEFAULT_SERVERS.some(d => serverKey(d) === serverKey(s)))];
}
const allServers = () => [SANDBOX, ...configuredServers().map(s => ({ ...s, id: serverKey(s), detail: new URL(s.iss).host }))];
function chosenServer() { const all = allServers(); return all.find(s => s.id === stored(CHOICE_KEY)) ?? all[0]; }
function renderServers() {
  const chosen = chosenServer();
  $("#servers").innerHTML = allServers().map(s => `<label class="server"><input type="radio" name="server" value="${esc(s.id)}" ${s.id === chosen.id ? "checked" : ""}><strong>${esc(s.label)}</strong><span>${esc(s.detail)}</span></label>`).join("");
  $$("input[name=server]").forEach(r => r.addEventListener("change", () => store(CHOICE_KEY, r.value)));
}
function initConfigure() {
  $("#redirect-uri").textContent = ROOT_REDIRECT;
  const box = $("#servers-json"), status = $("#servers-status");
  box.value = JSON.stringify(savedServers(), null, 2);
  $("#servers-save").addEventListener("click", () => {
    try { const list = parseServers(box.value); store(SERVERS_KEY, JSON.stringify(list)); box.value = JSON.stringify(list, null, 2); renderServers(); status.textContent = `Saved ${plural(list.length, "server")} of your own.`; }
    catch (e) { status.textContent = `Not saved. ${e.message}`; }
  });
  $("#servers-reset").addEventListener("click", () => { store(SERVERS_KEY, null); store(CHOICE_KEY, null); box.value = "[]"; renderServers(); status.textContent = "Only the built-in servers remain."; });
}
const STORE = `smart-imaging-client:${BASE}`;
// As stored, since the decoder reads every standard syntax, with uncompressed as the fallback the spec makes universal.
const WADO_ACCEPT = 'multipart/related; type="application/dicom"; transfer-syntax=*, multipart/related; type="application/dicom"; transfer-syntax=1.2.840.10008.1.2.1; q=0.5';
const IMAGING = "smart-imaging-access", APP_LAUNCH = "http://fhir.org/argonaut/smart-imaging/capabilities/app-launch";
/** How long the app will wait, in all, on servers that say to retry. */
const MOST_RETRIES = 5, LONGEST_WAIT_SECONDS = 30;
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
  { key: "discover", from: "This app", to: "Clinical FHIR server", name: "Discover", line: "From one FHIR address, find the sign-in page and the imaging server.", kinds: ["discover"], spec: [`${SMART}conformance.html`, "SMART discovery"] },
  { key: "authorize", from: "Browser and app", to: "Authorization server", name: "Authorize", line: "Sign in, approve this app, and receive an access token for one patient.", kinds: ["authorize", "token"], spec: [`${SMART}app-launch.html`, "SMART App Launch"] },
  { key: "clinical", from: "This app", to: "Clinical FHIR server", name: "Read the chart", line: "Query the clinical server with that token.", kinds: ["patient", "clinical"], spec: [`${SMART}scopes-and-launch-context.html`, "Scopes and context"] },
  { key: "imaging", from: "This app", to: "Imaging FHIR server", name: "Find studies", line: "Ask the imaging server for studies, and where to retrieve each one.", kinds: ["imaging"], spec: [IG, "SMART Imaging Access"] },
  { key: "retrieve", from: "This app", to: "DICOMweb endpoint", name: "Retrieve images", line: "Download DICOM from each study's Endpoint, and decode it in the browser.", kinds: ["wado"], spec: ["https://www.dicomstandard.org/using/dicomweb/retrieve-wado-rs-and-wado-uri", "DICOMweb WADO-RS"] },
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
/** Which system answered each kind of request. */
const ANSWERED_BY = { discover: "Clinical FHIR server", authorize: "Authorization server", token: "Authorization server", patient: "Clinical FHIR server", clinical: "Clinical FHIR server", imaging: "Imaging FHIR server", wado: "DICOMweb endpoint" };
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
  list.innerHTML = STAGES.map(st => `<li class="stage-row" data-stage="${st.key}"></li>`).join("");
  STAGES.forEach(paintStage);
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
  const masked = String(text).replace(/("(?:access_token|refresh_token|id_token)"\s*:\s*")[^"]+/g, "$1…").replace(/((?:code|code_verifier)=)[^&\s]+/g, "$1…").replace(/[A-Za-z0-9_.~-]{72,}/g, m => `${m.slice(0, 16)}…${m.slice(-8)}`);
  return masked.length > 1600 ? `${masked.slice(0, 1600)}\n… ${masked.length - 1600} more characters` : masked;
};
const pretty = text => { try { return JSON.stringify(JSON.parse(text), null, 1); } catch { return text; } };
const requestLine = (method, url, headers) => [`${method} ${preview(url)}`, ...Object.entries(headers ?? {}).map(([k, v]) => `${k}: ${/^authorization$/i.test(k) ? "Bearer …" : v}`)].join("\n");

const sleep = (ms, signal) => new Promise((done, fail) => { const t = setTimeout(done, ms); signal?.addEventListener("abort", () => { clearTimeout(t); fail(new DOMException("aborted", "AbortError")); }, { once: true }); });
/** A request, repeated while the server answers 503 with Retry-After: the spec's way of saying results are being assembled. */
async function patientFetch(url, init, waiting = () => {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init), after = Number(res.headers.get("retry-after"));
    if (res.status !== 503 || !res.headers.has("retry-after") || !Number.isFinite(after) || attempt >= MOST_RETRIES) return res;
    await res.body?.cancel();
    const seconds = Math.min(after, LONGEST_WAIT_SECONDS);
    waiting(seconds);
    await sleep(seconds * 1000, init?.signal);
  }
}

/** The same GET from a terminal. The token stays a variable, so the panel never holds it. */
const curlOf = (url, headers) => `curl "${url}" \\\n${Object.entries(headers ?? {}).map(([k, v]) => `  -H "${k}: ${/^authorization$/i.test(k) ? "Bearer $TOKEN" : v.replace(/"/g, '\\"')}"`).join(" \\\n")}`;

/** Where discovery says imaging is, by capability: on this FHIR server, or an associated one, if it offers App Launch. */
function imagingOf(config, iss) {
  const offers = caps => caps?.includes(IMAGING) && caps.includes(APP_LAUNCH);
  if (offers(config.capabilities)) return { url: iss, unified: true };
  const associated = (config.associated_endpoints ?? []).find(e => offers(e.capabilities));
  return associated && { url: associated.url.replace(/\/$/, ""), unified: false };
}
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
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const random = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
async function discover(iss) {
  return traced({ id: "discover", kind: "discover", title: "Discover the servers" }, `${iss}/.well-known/smart-configuration`, {}, c => {
    const found = imagingOf(c, iss);
    return { "Sign-in": new URL(c.authorization_endpoint).host, "Imaging server": found ? `${new URL(found.url).host}${found.unified ? " (this server)" : ""}` : "None advertised" };
  });
}
async function connect() {
  const button = $("#connect");
  button.disabled = true;
  try {
    const server = chosenServer();
    // Another server has a redirect registered for one fixed address, so its sign-in runs from there.
    if (!server.own && BASE) { location.assign("/?connect=1"); return; }
    // Everyone gets a world of their own, so one visitor's changes never reach another's.
    if (server.own && !BASE) {
      // This browser's sandbox lasts until its owner starts over, so go back to it if it's there.
      const known = stored(WORLD_KEY);
      if (known && (await fetch(`${known}/api/settings/status`)).ok) { location.assign(`${known}/?connect=1`); return; }
      const r = await fetch("/api/scopes", { method: "POST" });
      if (!r.ok) throw new Error(r.status === 429 ? "Too many sandboxes from this address. Try again in a while." : `The sandbox couldn't be created (HTTP ${r.status})`);
      const { base } = await r.json();
      store(WORLD_KEY, base);
      location.assign(`${base}/?connect=1`);
      return;
    }
    trail.length = 0;
    const iss = server.own ? `${location.origin}${BASE}/fhir` : server.iss, clientId = server.own ? CLIENT_ID : server.clientId, scope = server.scope ?? SCOPE;
    const config = await discover(iss);
    if (config.code_challenge_methods_supported && !config.code_challenge_methods_supported.includes("S256")) throw new Error("This server doesn't offer PKCE with S256.");
    // Nobody signs in to a server this app can't use.
    if (!imagingOf(config, iss) && !server.imaging) throw new Error("This server doesn't advertise SMART Imaging with App Launch. Add \"imaging\" to its configuration if you know where it is.");
    const verifier = random(), state = random();
    const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
    save({ pending: { verifier, state, config, iss, clientId, imaging: server.imaging, own: !!server.own, label: server.label } });
    const url = new URL(config.authorization_endpoint);
    Object.entries({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, scope, aud: iss, state, code_challenge: challenge, code_challenge_method: "S256" }).forEach(([k, v]) => url.searchParams.set(k, v));
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
  const body = new URLSearchParams({ grant_type: "authorization_code", code: params.get("code"), redirect_uri: REDIRECT, client_id: pending.clientId, code_verifier: pending.verifier }).toString();
  const token = await traced({ id: "token", kind: "token", title: "Exchange the code for a token" }, pending.config.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body }, t => ({ Granted: t.scope, "Token lasts": `${Math.round(t.expires_in / 60)} min` }));
  const imaging = imagingOf(pending.config, pending.iss)?.url ?? pending.imaging;
  if (!imaging) throw new Error("This server doesn't advertise SMART Imaging with App Launch. Add \"imaging\" to its configuration if you know where it is.");
  if (!token.patient) throw new Error("The token response didn't name a patient.");
  const session = { token: token.access_token, patient: token.patient, imaging, iss: pending.iss, own: pending.own, label: pending.label };
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
const connectionOf = e => e?.connectionType?.code ?? e?.connectionType?.coding?.[0]?.code;
/** An Endpoint by reference: contained, a response-local urn:uuid, or a full or relative URL in the Bundle. */
function resolveEndpoint(owner, ref, entries) {
  if (!ref) return undefined;
  if (ref.startsWith("#")) return owner.contained?.find(c => c.id === ref.slice(1));
  const endpoints = entries.filter(e => e.resource.resourceType === "Endpoint");
  const relative = /^Endpoint\/[^/]+$/.test(ref);
  return (endpoints.find(e => e.fullUrl === ref) ?? (relative ? endpoints.find(e => e.fullUrl?.endsWith(`/${ref}`) || e.resource.id === ref.split("/")[1]) : undefined))?.resource;
}
/** The WADO-RS address among some references. The token only ever goes to one of these, never to a QIDO-RS or viewer link. */
function wadoAddress(owner, refs, entries) {
  for (const r of refs ?? []) {
    const e = resolveEndpoint(owner, r.reference, entries);
    if (e?.address && connectionOf(e) === "dicom-wado-rs") return e.address.replace(/\/$/, "");
  }
  return undefined;
}
/** Every page of a search, each from the same server, and whether the server says something is missing. */
async function searchAll(s) {
  const first = `${s.imaging}/ImagingStudy?patient=${encodeURIComponent(s.patient)}&_include=ImagingStudy:endpoint`, origin = new URL(first).origin;
  const entries = [];
  let url = first, page = 0, incomplete = false;
  const seen = new Set();
  while (url && !seen.has(url) && page < 200) {
    seen.add(url); page++;
    const bundle = await traced({ id: page === 1 ? "imaging" : `imaging-${page}`, kind: "imaging", title: page === 1 ? "Search imaging studies" : `Search imaging studies, page ${page}` }, url, { headers: fhirHeaders(s.token) }, b => { const of = t => (b.entry ?? []).filter(e => e.resource?.resourceType === t).length; return page === 1 ? { Studies: of("ImagingStudy"), Endpoints: of("Endpoint") } : { [`Page ${page}`]: of("ImagingStudy") }; });
    for (const e of bundle.entry ?? []) {
      if (e.resource?.resourceType === "OperationOutcome" && e.resource.issue?.some(i => i.code === "incomplete")) incomplete = true;
      else entries.push(e);
    }
    const next = bundle.link?.find(l => l.relation === "next")?.url;
    // A next link is followed with the token, so it has to stay on the imaging server.
    url = next && new URL(next, first).origin === origin ? new URL(next, first).toString() : undefined;
  }
  return { entries, incomplete };
}
async function loadStudies(s) {
  const el = $("#studies");
  let entries, incomplete;
  try { ({ entries, incomplete } = await searchAll(s)); }
  catch (e) { el.innerHTML = `<p class="error">${esc(e.message)}</p>`; throw e; }
  const studies = entries.filter(e => e.resource?.resourceType === "ImagingStudy").map(e => e.resource).map(r => ({
    ...r,
    uid: (r.identifier ?? []).find(i => i.system === "urn:dicom:uid")?.value?.replace(/^urn:oid:/, ""),
    address: r.status === "available" || r.status === undefined ? wadoAddress(r, r.endpoint, entries) : undefined,
    series: (r.series ?? []).map(x => ({ ...x, address: wadoAddress(r, x.endpoint, entries) })),
  })).sort((a, b) => String(b.started ?? "").localeCompare(String(a.started ?? "")));
  const warning = incomplete ? `<p class="note">The server says these results are incomplete. Some sources haven't answered yet.</p>` : "";
  if (!studies.length) { el.innerHTML = `${warning}<p class="note">This patient has no studies this app can see.</p>`; $("#stage-note").textContent = "No studies to show."; return; }
  const usable = st => st.address && st.uid;
  el.innerHTML = `${warning}<ul class="study-list-client">${studies.map((st, i) => `<li><button type="button" class="study-button" data-i="${i}" aria-pressed="false" ${usable(st) ? "" : "disabled"}><strong>${esc(st.description ?? st.modality?.[0]?.code ?? "Study")}</strong><span>${esc([studyDate(st.started), (st.modality ?? []).map(m => m.code).join(", "), usable(st) ? plural(st.numberOfInstances ?? 0, "image") : st.status && st.status !== "available" ? `Not available (${st.status})` : "Images not available to this app"].filter(Boolean).join(" · "))}</span></button></li>`).join("")}</ul>`;
  $$(".study-button", el).forEach(b => b.addEventListener("click", () => openStudy(s, studies[Number(b.dataset.i)], b)));
  const first = studies.find(usable);
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
const seriesBase = v => v.series.address ?? v.study.address;
async function retrieve(v, instance, signal, url = `${seriesBase(v)}/studies/${v.study.uid}/series/${v.series.uid}/instances/${instance}`) {
  const t0 = performance.now();
  const res = await patientFetch(url, { headers: { authorization: `Bearer ${v.session.token}`, accept: WADO_ACCEPT }, signal }, seconds => { if (v === view) note(`The server is preparing these images. Trying again in ${seconds} s…`); });
  if (!res.ok) { await res.body?.cancel(); addStep({ id: "wado", kind: "wado", title: "Retrieve images", failed: true, request: requestLine("GET", url, { authorization: "x", accept: WADO_ACCEPT }), response: `HTTP ${res.status}` }); throw new Error(res.status === 406 ? "The image server can't send this image in a form this viewer accepts." : `The image server answered ${res.status}.`); }
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
  const res = await patientFetch(`${seriesBase(v)}/studies/${v.study.uid}/series/${v.series.uid}/metadata`, { headers: { authorization: `Bearer ${v.session.token}`, accept: "application/dicom+json" }, signal: v.abort.signal });
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
  if (!v.slices.length) { note("This server didn't list this series' images, which SMART Imaging requires."); return; }
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
// One finger or the mouse uses the chosen tool. Two fingers pinch to zoom and move the image together.
const pointers = new Map();
let pinch;
/** Where a pointer is, in canvas pixels from the canvas's centre, which is what the renderer's pan is measured from. */
function fromCentre(e) {
  const r = canvas.getBoundingClientRect(), dpr = devicePixelRatio || 1;
  return { x: (e.clientX - r.left - r.width / 2) * dpr, y: (e.clientY - r.top - r.height / 2) * dpr };
}
function startPinch() {
  const [a, b] = [...pointers.values()];
  pinch = { distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), middle: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, zoom: view.zoom, panX: view.panX, panY: view.panY };
  drag = undefined;
}
function startDrag(e) { drag = { x: e.clientX, y: e.clientY, panX: view.panX, panY: view.panY, ...view.window }; }
stage.addEventListener("pointerdown", e => {
  if (!view?.window) return;
  try { stage.setPointerCapture(e.pointerId); } catch {}
  pointers.set(e.pointerId, fromCentre(e));
  if (pointers.size === 2) startPinch();
  else if (pointers.size === 1) startDrag(e);
});
stage.addEventListener("pointermove", e => {
  if (!view?.window || !renderer || !pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, fromCentre(e));
  if (pinch && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const middle = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const zoom = Math.min(16, Math.max(0.25, pinch.zoom * Math.hypot(a.x - b.x, a.y - b.y) / pinch.distance));
    // The point between the fingers stays under them.
    const ratio = zoom / pinch.zoom;
    view.zoom = zoom;
    view.panX = middle.x - (pinch.middle.x - pinch.panX) * ratio;
    view.panY = middle.y - (pinch.middle.y - pinch.panY) * ratio;
    refreshView();
    return;
  }
  if (!drag) return;
  if (tool === "pan") {
    const dpr = devicePixelRatio || 1;
    view.panX = drag.panX + (e.clientX - drag.x) * dpr; view.panY = drag.panY + (e.clientY - drag.y) * dpr;
  } else {
    const gain = Math.max(drag.width, 1) / 400;
    view.window = { width: Math.max(1, drag.width + (e.clientX - drag.x) * gain), center: drag.center + (e.clientY - drag.y) * gain };
  }
  refreshView();
});
function endPointer(e) {
  pointers.delete(e.pointerId);
  pinch = undefined;
  drag = undefined;
  // A finger left after a pinch carries on from where the image is, without a jump.
  if (pointers.size === 1 && view?.window) { const rest = [...pointers.values()][0], r = canvas.getBoundingClientRect(), dpr = devicePixelRatio || 1; startDrag({ clientX: rest.x / dpr + r.left + r.width / 2, clientY: rest.y / dpr + r.top + r.height / 2 }); }
}
stage.addEventListener("pointerup", endPointer); stage.addEventListener("pointercancel", endPointer);
$("#reset-view").addEventListener("click", async () => {
  if (!view?.defaultWindow) return;
  view.window = view.defaultWindow;
  view.zoom = 1; view.panX = 0; view.panY = 0; view.invert = false;
  syncInvert();
  refreshView();
});

// The sandboxes this browser knows: the current one is WORLD_KEY, and a joined one is someone else's to end.
const WORLDS_KEY = "smart-imaging-client:worlds";
function worlds() {
  let list = [];
  try { list = JSON.parse(stored(WORLDS_KEY) ?? "[]"); } catch {}
  const current = stored(WORLD_KEY);
  if (current && !list.some(w => w.base === current)) list.push({ base: current, joined: false });
  return list;
}
const saveWorlds = list => store(WORLDS_KEY, JSON.stringify(list));
const shareLink = base => `${location.origin}${base}/?join=1`;
async function worldName(base) {
  const r = await fetch(`${base}/api/world`);
  return r.ok ? (await r.json()).name : null;
}
async function renderSandbox() {
  const box = $("#sandbox"), current = stored(WORLD_KEY);
  if (!current) { box.hidden = true; return; }
  let list = worlds();
  const name = await worldName(current);
  if (!name) { // Ended by someone else.
    saveWorlds(list.filter(w => w.base !== current));
    store(WORLD_KEY, list.find(w => w.base !== current)?.base ?? null);
    return renderSandbox();
  }
  list = list.map(w => w.base === current ? { ...w, name } : w);
  saveWorlds(list);
  const mine = list.find(w => w.base === current), others = list.filter(w => w.base !== current);
  box.innerHTML = `<h2>Your sandbox</h2>
    <div class="sandbox-head"><p class="sandbox-name" id="sandbox-name">${esc(name)}</p><button type="button" class="tool" id="rename">Rename</button></div>
    <div class="sandbox-actions"><button type="button" class="tool" id="share">Share</button><button type="button" class="tool" id="end">${mine.joined ? "Leave this sandbox" : "Start over with a new sandbox"}</button></div>
    <div id="share-panel" hidden><input type="text" id="share-link" readonly aria-label="Link to this sandbox" value="${esc(shareLink(current))}"><p class="note" id="share-note">Anyone with this link can see and change this sandbox.</p></div>
    ${others.length ? `<ul class="other-sandboxes">${others.map(w => `<li><span>${esc(w.name ?? "Sandbox")}</span><button type="button" class="tool" data-switch="${esc(w.base)}">Switch</button></li>`).join("")}</ul>` : ""}`;
  box.hidden = false;
  $("#rename").addEventListener("click", async () => {
    const next = prompt("Name this sandbox", name);
    if (next === null || !next.trim()) return;
    await fetch(`${current}/api/world`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: next }) });
    renderSandbox();
  });
  $("#share").addEventListener("click", async () => {
    const url = shareLink(current), panel = $("#share-panel"), note = $("#share-note");
    panel.hidden = false;
    $("#share-link").select();
    if (navigator.share) { try { await navigator.share({ title: `SMART Imaging sandbox: ${name}`, url }); return; } catch (e) { if (e.name === "AbortError") return; } }
    try { await navigator.clipboard.writeText(url); note.textContent = "Link copied. Anyone with it can see and change this sandbox."; } catch {}
  });
  $("#end").addEventListener("click", async () => {
    if (!mine.joined && !confirm(`Delete “${name}” and everything in it? Anyone you shared it with loses it too.`)) return;
    if (!mine.joined) try { await fetch(`${current}/api/scopes/current`, { method: "DELETE" }); } catch {}
    const rest = list.filter(w => w.base !== current);
    saveWorlds(rest);
    store(WORLD_KEY, rest[0]?.base ?? null);
    try { sessionStorage.clear(); } catch {}
    location.assign("/");
  });
  $$("[data-switch]", box).forEach(b => b.addEventListener("click", () => { store(WORLD_KEY, b.dataset.switch); try { sessionStorage.clear(); } catch {} location.assign("/"); }));
}
async function showInvite() {
  const name = await worldName(BASE);
  if (!name) return;
  $("#invite-title").textContent = `You've been invited to “${name}”`;
  $("#invite").hidden = false;
  $("#join").addEventListener("click", () => {
    const list = worlds();
    if (!list.some(w => w.base === BASE)) list.push({ base: BASE, joined: true, name });
    saveWorlds(list);
    store(WORLD_KEY, BASE);
    location.assign(`${BASE}/`);
  });
}
function showApp() {
  $("#landing").hidden = true; $("#app").hidden = false; $("#disconnect").hidden = false;
  renderTrail();
}
async function run(session) {
  showApp();
  $("#connected").textContent = session.own ? "" : `Connected to ${session.label}`;
  if (session.own && BASE) worldName(BASE).then(name => { if (name) $("#connected").textContent = `Sandbox: ${name}`; });
  const results = await Promise.allSettled([loadPatient(session), loadClinical(session), loadStudies(session)]);
  if (results.some(r => r.reason?.status === 401)) { save({ session: undefined }); announce("Your session ended. Connect again."); note("Your session ended. Disconnect, then connect again."); }
}
renderServers();
initConfigure();
$("#connect").addEventListener("click", connect);
$("#disconnect").addEventListener("click", disconnect);
// The header's links stay in this visitor's sandbox.
if (BASE) for (const a of $$("a[href^='/']:not([data-scoped])")) a.setAttribute("href", `${BASE}${a.getAttribute("href")}`);

(async function start() {
  const params = new URLSearchParams(location.search);
  if (params.get("join") === "1" && BASE) showInvite(); else renderSandbox();
  try {
    if (params.has("code") || params.has("error")) { const s = await finishSignIn(params); await run(s); return; }
    if (saved().session) { await run(saved().session); return; }
    if (params.get("connect") === "1" && (BASE || !chosenServer().own)) { history.replaceState(null, "", REDIRECT); await connect(); }
  } catch (e) {
    $("#landing").hidden = false; $("#app").hidden = true;
    const el = $("#connect-error"); el.hidden = false; el.textContent = e.message;
  }
})();
