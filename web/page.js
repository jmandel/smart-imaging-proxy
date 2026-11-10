// What every page shares: its sandbox, small helpers, and the settings menu in the header.
/** The sandbox this page is in, if any: every request it makes stays there. */
const BASE = location.pathname.match(/^\/s\/[^/]+/)?.[0] ?? "";
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
/** A call to this page's sandbox. The management API, under /api/sandbox, gets the sandbox's admin token. */
async function api(method, path, body, base = BASE) {
  const managed = path.startsWith("/api/sandbox"), send = async () => fetch(`${base}${path}`, { method, headers: { ...(managed ? { authorization: `Bearer ${await adminToken(base)}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  let r = await send();
  // A token revoked, or expired by the demo clock: get a fresh one, once.
  if (r.status === 401 && managed) { adminTokens.delete(base); r = await send(); }
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(b.error ?? `HTTP ${r.status}`), { status: r.status });
  return b;
}

// Signing, for SMART's asymmetric client authentication: the sandbox's admin key here, and apps' keys elsewhere.
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const textBytes = t => new TextEncoder().encode(t);
const jsonPart = o => b64url(textBytes(JSON.stringify(o)));
const ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
/** A client assertion for `tokenEndpoint`, signed here with the client's private ES256 key, expiring by the sandbox's clock when given. */
async function signAssertion(jwk, clientId, tokenEndpoint, now = Math.floor(Date.now() / 1000)) {
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const jti = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const head = `${jsonPart({ alg: "ES256", kid: jwk.kid, typ: "JWT" })}.${jsonPart({ iss: clientId, sub: clientId, aud: tokenEndpoint, exp: now + 240, jti })}`;
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, textBytes(head)));
  return `${head}.${b64url(signature)}`;
}
/** A sandbox's sample keys, its admin client's and its services', and its time now. Anyone with the sandbox's URL may have them. */
async function keysOf(base = BASE) {
  const r = await fetch(`${base}/api/sandbox/keys`);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
  return r.json();
}
/** A token from a Backend Services client's key: client_credentials with a signed assertion, plus any extra fields. */
async function backendToken(client, tokenEndpoint, fields, now) {
  const r = await fetch(tokenEndpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "client_credentials", client_assertion_type: ASSERTION_TYPE, client_assertion: await signAssertion(client.jwk, client.client_id, tokenEndpoint, now), ...fields }) });
  const t = await r.json().catch(() => ({}));
  if (!t.access_token) throw new Error(`The token endpoint refused ${client.client_id}: ${t.error ?? `HTTP ${r.status}`}`);
  return t;
}
/** The sandbox's admin token, for its management API, held until shortly before it expires. */
const adminTokens = new Map();
async function adminToken(base = BASE) {
  const held = adminTokens.get(base);
  if (held && held.until > Date.now()) return held.token;
  const keys = await keysOf(base);
  const t = await backendToken(keys.admin, keys.tokenEndpoint, { scope: keys.admin.scope }, keys.now);
  adminTokens.set(base, { token: t.access_token, until: Date.now() + (t.expires_in - 30) * 1000 });
  return t.access_token;
}
const bytes = n => { const v = Number(n ?? 0); return v >= 1e9 ? `${(v / 1e9).toFixed(2)} GB` : v >= 1e6 ? `${(v / 1e6).toFixed(1)} MB` : v >= 1e3 ? `${(v / 1e3).toFixed(1)} KB` : `${v} B`; };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** A list of studies, one per line under its count: study titles carry commas, so they are never joined. */
const studyList = (items, lead = plural(items.length, "study", "studies") + ":") => `${esc(lead)}<ul class="study-list">${items.map(t => `<li>${esc(t)}</li>`).join("")}</ul>`;
const studyDate = d => d ? String(d).slice(0, 10) : "";
const announce = text => { const el = $("#announce"); if (el) { el.textContent = ""; setTimeout(() => { el.textContent = text; }, 30); } };

/** A button that copies `value`, and says so. One listener below serves every page's. */
const copyButton = (label, value, aria = label) => `<button type="button" class="tool" data-copy="${esc(value)}" data-label="${esc(label)}"${aria === label ? "" : ` aria-label="${esc(aria)}"`}>${esc(label)}</button>`;
document.addEventListener("click", async e => {
  const copy = e.target.closest?.("[data-copy]");
  if (!copy) return;
  try { await navigator.clipboard.writeText(copy.dataset.copy); copy.textContent = "Copied"; } catch { copy.textContent = "Couldn't copy"; }
  setTimeout(() => { if (copy.isConnected) copy.textContent = copy.dataset.label; }, 2000);
});

/** How people sign in: done for them, or by themselves in a window that a Sign in button opens. Kept in this browser. */
const SIGNIN_KEY = "smart-imaging-signin";
function signInMode() { try { return localStorage.getItem(SIGNIN_KEY) === "window" ? "window" : "auto"; } catch { return "auto"; } }
function setSignInMode(mode) { try { localStorage.setItem(SIGNIN_KEY, mode); } catch {} document.dispatchEvent(new CustomEvent("signin-mode", { detail: mode })); }

// The settings menu: how people sign in, where images come from, the demo clock, and resets, for this page's sandbox.
const BACKEND_LABELS = { "static-files": "Local files", s3: "S3 bucket", orthanc: "Orthanc" };
function initSettings() {
  const button = $("#settings-button"), panel = $("#settings");
  if (!button || !panel) return;
  const close = () => { panel.hidden = true; button.setAttribute("aria-expanded", "false"); };
  button.addEventListener("click", async () => {
    if (!panel.hidden) { close(); return; }
    panel.hidden = false;
    button.setAttribute("aria-expanded", "true");
    await renderSettings();
    $("#settings h2")?.focus();
  });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !panel.hidden) { close(); button.focus(); } });
  document.addEventListener("click", e => { if (!panel.hidden && !panel.contains(e.target) && !button.contains(e.target)) close(); });
}
const offsetText = s => s === 0 ? "real time" : `${s > 0 ? "+" : "−"}${Math.abs(s) >= 86400 ? `${(Math.abs(s) / 86400).toFixed(Math.abs(s) % 86400 ? 1 : 0)} days` : Math.abs(s) >= 3600 ? `${(Math.abs(s) / 3600).toFixed(Math.abs(s) % 3600 ? 1 : 0)} hours` : `${Math.round(Math.abs(s) / 60)} minutes`}`;
async function renderSettings(message = "") {
  const panel = $("#settings");
  let st;
  try { st = await api("GET", "/api/sandbox"); } catch (e) { panel.innerHTML = `<p class="error">${esc(e.message)}</p>`; return; }
  panel.innerHTML = `
    <h2 tabindex="-1">Settings</h2>
    <section><h3 id="h-signin">Signing in</h3>
      <div class="row" role="radiogroup" aria-labelledby="h-signin">${[["auto", "Automatic"], ["window", "In a window"]].map(([v, l]) => `<label class="radio"><input type="radio" name="signin" value="${v}" ${signInMode() === v ? "checked" : ""}> ${l}</label>`).join("")}</div></section>
    <p class="group">${st.sandbox ? "This sandbox" : "Saved policy"}</p>
    <section><h3><label for="set-backend">Images come from</label></h3>
      <div class="row"><select id="set-backend">${st.storage.names.map(n => `<option value="${esc(n)}" ${n === st.storage.current ? "selected" : ""}>${esc(BACKEND_LABELS[n] ?? n)}</option>`).join("")}</select></div>
      <p id="backend-health"></p></section>
    ${st.sandbox ? `<section><h3><label for="set-topology">Imaging FHIR server</label></h3>
      <div class="row"><select id="set-topology"><option value="separate" ${st.topology.current === "separate" ? "selected" : ""}>Separate, named in discovery</option><option value="unified" ${st.topology.current === "unified" ? "selected" : ""}>Unified with the clinical server</option></select></div></section>` : ""}
    <section><h3>Demo clock</h3><p>Now ${esc(offsetText(st.clock.offsetSeconds))}. Moving it ahead shows links and tokens expiring.</p>
      <div class="row">${st.clockChoices.map(c => `<button class="secondary" data-advance="${c.value}">Ahead ${esc(c.label)}</button>`).join("")}<button class="secondary" data-clock-reset ${st.clock.offsetSeconds ? "" : "disabled"}>Back to real time</button></div></section>
    <section><h3>Start over</h3><p>Puts relationships and organization policy back as they are on file, and clears every share and app approval.</p>
      <div class="row"><button class="secondary" data-reset>Reset policy</button></div></section>
    <section><h3>End access now</h3><p>Signed links and cached decisions otherwise last until they expire.</p>
      <div class="row"><button class="secondary" data-end="/tokens/revoke-all">Revoke every token</button><button class="secondary" data-end="/proxy/flush">Flush cached decisions</button><button class="secondary" data-end="/signing-key/rotate">Rotate the signing key</button></div></section>
    <p class="msg" role="status">${esc(message)}</p>`;
  const act = async (route, body, said, method = "POST") => { try { await api(method, `/api/sandbox${route}`, body); await renderSettings(said); document.dispatchEvent(new CustomEvent("settings-changed")); } catch (e) { $("#settings .msg").textContent = e.message; } };
  for (const r of $$("input[name=signin]", panel)) r.addEventListener("change", () => setSignInMode(r.value));
  $("#set-backend").addEventListener("change", e => act("", { storage: e.target.value }, `Images now come from ${BACKEND_LABELS[e.target.value] ?? e.target.value}.`, "PATCH"));
  $("#set-topology")?.addEventListener("change", e => act("", { topology: e.target.value }, e.target.value === "unified" ? "Imaging is now on the clinical FHIR server." : "Imaging is now on a separate FHIR server.", "PATCH"));
  for (const b of $$("[data-advance]", panel)) b.addEventListener("click", () => act("/clock", { advanceSeconds: Number(b.dataset.advance) }, "The clock moved ahead."));
  $("[data-clock-reset]", panel).addEventListener("click", () => act("/clock", { reset: true }, "The clock is back to real time."));
  $("[data-reset]", panel).addEventListener("click", () => act("/reset", { confirm: true }, "Policy is as it is on file."));
  for (const b of $$("[data-end]", panel)) b.addEventListener("click", () => act(b.dataset.end, undefined, `${b.textContent}: done.`));
  api("GET", "/api/sandbox/storage").then(r => {
    const mine = r.stores.find(b => b.name === r.current);
    const el = $("#backend-health");
    if (el && mine) el.textContent = mine.ok ? `Working: ${mine.detail}.` : `Not working: ${mine.detail}.`;
  }).catch(() => {});
}

function initHeader() {
  initSettings();
}
initHeader();


// Inside a sandbox every link stays in it, including links a page draws later, except those marked data-root.
function keepInSandbox(root) {
  if (!BASE || !root?.querySelectorAll) return;
  const links = [...(root.matches?.("a[href^='/']") ? [root] : []), ...root.querySelectorAll("a[href^='/']")];
  for (const a of links) {
    const href = a.getAttribute("href");
    if (!a.hasAttribute("data-root") && !href.startsWith("//") && !href.startsWith("/s/")) a.setAttribute("href", `${BASE}${href}`);
  }
}
keepInSandbox(document);
if (BASE) new MutationObserver(changes => { for (const c of changes) for (const n of c.addedNodes) keepInSandbox(n); }).observe(document.documentElement, { childList: true, subtree: true });
