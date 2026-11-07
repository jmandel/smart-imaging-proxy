// What every page shares: its scope, small helpers, and the settings menu in the header.
/** The scope this page is in, if any: every request it makes stays there. */
const BASE = location.pathname.match(/^\/s\/[^/]+/)?.[0] ?? "";
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
async function api(method, path, body) {
  const r = await fetch(`${BASE}${path}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(b.error ?? `HTTP ${r.status}`), { status: r.status });
  return b;
}
const bytes = n => { const v = Number(n ?? 0); return v >= 1e9 ? `${(v / 1e9).toFixed(2)} GB` : v >= 1e6 ? `${(v / 1e6).toFixed(1)} MB` : v >= 1e3 ? `${(v / 1e3).toFixed(1)} KB` : `${v} B`; };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const studyDate = d => d ? String(d).slice(0, 10) : "";
const announce = text => { const el = $("#announce"); if (el) { el.textContent = ""; setTimeout(() => { el.textContent = text; }, 30); } };

// The settings menu: where images come from, the demo clock, and resets, for this page's world.
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
  try { st = await api("GET", "/api/settings/status"); } catch (e) { panel.innerHTML = `<p class="error">${esc(e.message)}</p>`; return; }
  const where = st.scope ? "this tour's own scope" : "saved policy";
  panel.innerHTML = `
    <h2 tabindex="-1">Settings</h2>
    <p>These act on ${esc(where)}.</p>
    <section><h3><label for="set-backend">Images come from</label></h3>
      <div class="row"><select id="set-backend">${st.backend.names.map(n => `<option value="${esc(n)}" ${n === st.backend.current ? "selected" : ""}>${esc(BACKEND_LABELS[n] ?? n)}</option>`).join("")}</select></div>
      <p id="backend-health"></p></section>
    <section><h3>Demo clock</h3><p>Now ${esc(offsetText(st.clock.offsetSeconds))}. Moving it ahead shows links and tokens expiring.</p>
      <div class="row">${st.clockChoices.map(c => `<button class="secondary" data-advance="${c.value}">Ahead ${esc(c.label)}</button>`).join("")}<button class="secondary" data-clock-reset ${st.clock.offsetSeconds ? "" : "disabled"}>Back to real time</button></div></section>
    <section><h3>Start over</h3><p>Puts relationships and organization policy back as they are on file, and clears every share and app approval.</p>
      <div class="row"><button class="secondary" data-reset>Reset policy</button></div></section>
    <section><h3>End access now</h3><p>Signed links and cached decisions otherwise last until they expire.</p>
      <div class="row"><button class="secondary" data-end="/tokens/revoke-all">Revoke every token</button><button class="secondary" data-end="/proxy/flush">Flush cached decisions</button><button class="secondary" data-end="/signing-key/rotate">Rotate the signing key</button></div></section>
    <p class="msg" role="status">${esc(message)}</p>`;
  const act = async (route, body, said) => { try { await api("POST", `/api/settings${route}`, body); await renderSettings(said); document.dispatchEvent(new CustomEvent("settings-changed")); } catch (e) { $("#settings .msg").textContent = e.message; } };
  $("#set-backend").addEventListener("change", e => act("/backend", { backend: e.target.value }, `Images now come from ${BACKEND_LABELS[e.target.value] ?? e.target.value}.`));
  for (const b of $$("[data-advance]", panel)) b.addEventListener("click", () => act("/clock", { advanceSeconds: Number(b.dataset.advance) }, "The clock moved ahead."));
  $("[data-clock-reset]", panel).addEventListener("click", () => act("/clock", { reset: true }, "The clock is back to real time."));
  $("[data-reset]", panel).addEventListener("click", () => act("/reset", { confirm: true }, "Policy is as it is on file."));
  for (const b of $$("[data-end]", panel)) b.addEventListener("click", () => act(b.dataset.end, undefined, `${b.textContent}: done.`));
  api("GET", "/api/settings/backends").then(r => {
    const mine = r.backends.find(b => b.name === r.current);
    const el = $("#backend-health");
    if (el && mine) el.textContent = mine.ok ? `Working: ${mine.detail}.` : `Not working: ${mine.detail}.`;
  }).catch(() => {});
}

/** The header's links go to saved policy's pages. A page in a scope says so. */
function initHeader() {
  const where = $("#where");
  if (where && BASE) where.textContent = "In a tour's own scope";
  initSettings();
}
initHeader();
