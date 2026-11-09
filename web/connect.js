// Registering an app in this browser's own sandbox. Everything here happens in that sandbox.
const copyButton = (label, value) => `<button type="button" class="tool" data-copy="${esc(value)}" data-label="${esc(label)}">${esc(label)}</button>`;
const KEYS_KEY = "smart-imaging-client:keys";
const savedKeys = () => { try { return JSON.parse(localStorage.getItem(KEYS_KEY) ?? "{}"); } catch { return {}; } };
const keepKey = (id, jwk) => { try { localStorage.setItem(KEYS_KEY, JSON.stringify({ ...savedKeys(), [id]: jwk })); } catch {} };
const TYPE_LABEL = { public: "Public app", confidential: "Confidential app", backend: "Backend service" };
const typeNow = () => $("input[name=type]:checked").value;
function showFields() { const t = typeNow(); $("#redirect-field").hidden = t === "backend"; $("#key-field").hidden = t === "public"; $("#patients-field").hidden = t !== "backend"; }
$$("input[name=type]").forEach(r => r.addEventListener("change", showFields));
/** A fresh ES256 pair, made here, so the server only ever sees the public half. */
async function generateKey() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const kid = crypto.randomUUID(), [priv, pub] = await Promise.all([crypto.subtle.exportKey("jwk", pair.privateKey), crypto.subtle.exportKey("jwk", pair.publicKey)]);
  return { priv: { ...priv, kid }, pub: { kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y, kid } };
}
/** Whether the viewer on this site can act as this client: it holds the key, and for sign-in, its address is registered. */
const canTry = c => (c.type === "public" || savedKeys()[c.id]) && (c.type === "backend" || c.redirectUris.includes(`${location.origin}${BASE}/`));
function tryInViewer(c) {
  const jwk = savedKeys()[c.id], entry = { label: c.name, iss: fhirBase(), clientId: c.id, ...(c.type === "backend" ? { mode: "backend", jwk, patient: c.patients === "any" ? "josh-example" : c.patients, scope: "system/ImagingStudy.rs" } : c.type === "confidential" ? { auth: "private_key_jwt", jwk } : {}) };
  let list = [];
  try { list = JSON.parse(localStorage.getItem("smart-imaging-client:servers") ?? "[]").filter(s => s.clientId !== c.id); } catch {}
  list.push(entry);
  try { localStorage.setItem("smart-imaging-client:servers", JSON.stringify(list)); localStorage.setItem("smart-imaging-client:choice", `${entry.iss}|${entry.clientId}`); sessionStorage.clear(); } catch {}
  location.assign(`${BASE}/?connect=1`);
}
const fhirBase = () => `${location.origin}${BASE}/fhir`;
function clientHtml(c) {
  const snippet = JSON.stringify({ label: c.name, iss: fhirBase(), clientId: c.id });
  return `<article class="panel registered">
    <div class="registered-head"><h3>${esc(c.name)}</h3><button type="button" class="tool" data-remove="${esc(c.id)}" aria-label="Remove ${esc(c.name)}">Remove</button></div>
    <dl class="registered-facts">
      <dt>FHIR base</dt><dd><code>${esc(fhirBase())}</code></dd>
      <dt>Client ID</dt><dd><code>${esc(c.id)}</code></dd>
      <dt>Type</dt><dd>${esc(TYPE_LABEL[c.type] ?? c.type)}</dd>
      ${c.redirectUris.length ? `<dt>Redirect URI</dt><dd>${c.redirectUris.map(u => `<code>${esc(u)}</code>`).join(" ")}</dd>` : ""}
      ${c.type === "backend" ? `<dt>May reach</dt><dd>${esc(c.patients === "any" ? "Any patient" : c.patients)}</dd>` : ""}
      ${c.jwk ? `<dt>Key id</dt><dd><code>${esc(c.jwk.kid)}</code></dd>` : ""}
      ${c.jwksUrl ? `<dt>JWKS URL</dt><dd><code>${esc(c.jwksUrl)}</code></dd>` : ""}
    </dl>
    <div class="configure-actions">${copyButton("Copy FHIR base", fhirBase())}${copyButton("Copy client ID", c.id)}${copyButton("Copy viewer config", snippet)}${savedKeys()[c.id] ? copyButton("Copy private key", JSON.stringify(savedKeys()[c.id])) : ""}${canTry(c) ? `<button type="button" class="primary" data-try="${esc(c.id)}">Try it in the viewer</button>` : ""}</div>
  </article>`;
}
let knownClients = [];
async function refresh() {
  const { clients } = await api("GET", "/api/sandbox/clients");
  knownClients = clients;
  $("#clients").innerHTML = clients.length ? clients.map(clientHtml).join("") : `<p class="note">None yet.</p>`;
}
$("#register").addEventListener("submit", async e => {
  e.preventDefault();
  const err = $("#register-error");
  err.hidden = true;
  try {
    const type = typeNow(), body = { name: $("#app-name").value, type };
    let priv;
    if (type !== "backend") body.redirectUris = [$("#app-redirect").value.trim()];
    if (type !== "public") {
      const pasted = $("#app-key").value.trim(), jwksUrl = $("#app-jwks").value.trim();
      if (jwksUrl) body.jwksUrl = jwksUrl;
      else if (pasted) { try { body.jwk = JSON.parse(pasted); } catch { throw new Error("The key isn't valid JSON."); } }
      else { const made = await generateKey(); body.jwk = made.pub; priv = made.priv; }
    }
    if (type === "backend") body.patients = $("#app-patients").value;
    const made = await api("POST", "/api/sandbox/clients", body);
    if (priv) keepKey(made.id, priv);
    e.target.reset();
    showFields();
    await refresh();
    announce("App registered.");
  } catch (x) { err.hidden = false; err.textContent = x.message; }
});
$("#clients").addEventListener("click", async e => {
  const copy = e.target.closest("[data-copy]"), remove = e.target.closest("[data-remove]"), attempt = e.target.closest("[data-try]");
  if (attempt) tryInViewer(knownClients.find(c => c.id === attempt.dataset.try));
  if (copy) {
    try { await navigator.clipboard.writeText(copy.dataset.copy); copy.textContent = "Copied"; } catch { copy.textContent = "Couldn't copy"; }
    setTimeout(() => { if (copy.isConnected) copy.textContent = copy.dataset.label; }, 2000);
  }
  if (remove) { await api("DELETE", `/api/sandbox/clients/${encodeURIComponent(remove.dataset.remove)}`); await refresh(); }
});
(async () => {
  if (!BASE) { location.replace("/"); return; }
  await refresh();
})();
