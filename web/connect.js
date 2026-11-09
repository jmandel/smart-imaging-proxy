// Registering an app in this browser's own world. Everything here happens in that world.
const WORLD_KEY_ = "smart-imaging-client:world";
const copyButton = (label, value) => `<button type="button" class="tool" data-copy="${esc(value)}" data-label="${esc(label)}">${esc(label)}</button>`;
const fhirBase = () => `${location.origin}${BASE}/fhir`;
function clientHtml(c) {
  const snippet = JSON.stringify({ label: c.name, iss: fhirBase(), clientId: c.id });
  return `<article class="panel registered">
    <div class="registered-head"><h3>${esc(c.name)}</h3><button type="button" class="tool" data-remove="${esc(c.id)}" aria-label="Remove ${esc(c.name)}">Remove</button></div>
    <dl class="registered-facts">
      <dt>FHIR base</dt><dd><code>${esc(fhirBase())}</code></dd>
      <dt>Client ID</dt><dd><code>${esc(c.id)}</code></dd>
      <dt>Redirect URI</dt><dd>${c.redirectUris.map(u => `<code>${esc(u)}</code>`).join(" ")}</dd>
    </dl>
    <div class="configure-actions">${copyButton("Copy FHIR base", fhirBase())}${copyButton("Copy client ID", c.id)}${copyButton("Copy viewer config", snippet)}</div>
  </article>`;
}
async function refresh() {
  const { clients } = await api("GET", "/api/clients");
  $("#clients").innerHTML = clients.length ? clients.map(clientHtml).join("") : `<p class="note">None yet.</p>`;
}
$("#register").addEventListener("submit", async e => {
  e.preventDefault();
  const err = $("#register-error");
  err.hidden = true;
  try {
    await api("POST", "/api/clients", { name: $("#app-name").value, redirectUris: [$("#app-redirect").value.trim()] });
    e.target.reset();
    await refresh();
    announce("App registered.");
  } catch (x) { err.hidden = false; err.textContent = x.message; }
});
$("#clients").addEventListener("click", async e => {
  const copy = e.target.closest("[data-copy]"), remove = e.target.closest("[data-remove]");
  if (copy) {
    try { await navigator.clipboard.writeText(copy.dataset.copy); copy.textContent = "Copied"; } catch { copy.textContent = "Couldn't copy"; }
    setTimeout(() => { if (copy.isConnected) copy.textContent = copy.dataset.label; }, 2000);
  }
  if (remove) { await api("DELETE", `/api/clients/${encodeURIComponent(remove.dataset.remove)}`); await refresh(); }
});
(async () => {
  if (!BASE) {
    let world = null;
    try { world = localStorage.getItem(WORLD_KEY_); } catch {}
    if (!world || !(await fetch(`${world}/api/settings/status`)).ok) {
      ({ base: world } = await (await fetch("/api/scopes", { method: "POST" })).json());
      try { localStorage.setItem(WORLD_KEY_, world); } catch {}
    }
    location.replace(`${world}/connect`);
    return;
  }
  for (const a of $$("a[href^='/']:not([data-scoped])")) a.setAttribute("href", `${BASE}${a.getAttribute("href")}`);
  await refresh();
})();
