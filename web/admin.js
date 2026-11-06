const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function call(method, path, body) {
  const r = await fetch(`/api/admin${path}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(b.error ?? `HTTP ${r.status}`); e.errors = b.errors; throw e; }
  return b;
}
function say(el, text, bad = false, errors) {
  el.className = `msg${bad ? " bad" : ""}`;
  el.innerHTML = `${esc(text)}${errors?.length ? `<ul>${errors.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}`;
}
/** Runs an action that returns the new status, and reports the outcome in `msg`. */
async function act(msg, done, fn) {
  try { render(await fn()); say(msg, done); return true; }
  catch (e) { say(msg, e.errors?.length ? "Not saved:" : `Not done: ${e.message}`, true, e.errors); return false; }
}

let lastActive, rulesEdited = false;

function render(s) {
  const { saved, scratch, active, label } = s.store;
  const badge = $("#store-badge");
  badge.textContent = label;
  badge.className = `store-badge ${active}`;
  const col = name => active === name ? ' class="active-col"' : "";
  const row = (name, f) => `<tr><th scope="row">${esc(name)}</th><td${col("saved")}>${esc(f(saved))}</td><td${col("scratch")}>${esc(f(scratch))}</td></tr>`;
  $("#store-table").innerHTML = `<table><thead><tr><th></th><th scope="col"${col("saved")}>Saved policy${active === "saved" ? " (active)" : ""}</th><th scope="col"${col("scratch")}>Flow scratch${active === "scratch" ? " (active)" : ""}</th></tr></thead><tbody>
    ${row("Mode", x => x.mode)}${row("Path", x => x.path)}${row("Durability", x => x.mode === "file" ? x.durability : "none: in memory")}${row("Journal", x => x.journal)}${row("Schema version", x => x.schemaVersion)}
    ${row("Delegations", x => x.counts.delegations)}${row("App grants", x => x.counts.appGrants)}${row("Rules", x => x.counts.rules)}${row("Settings changed", x => x.counts.settings)}${row("Live access tokens", x => x.counts.liveAccessTokens)}${row("Refresh tokens", x => x.counts.refreshTokens)}${row("Signing keys", x => x.counts.signingKeys)}${row("Retired signing keys", x => x.counts.retiredSigningKeys)}
  </tbody></table>`;

  const sites = v => v === undefined ? "everything they can see" : v.length ? v.join(", ") : "no sites";
  const d = s.policy.delegations, g = s.policy.appGrants;
  $("#chain-list").innerHTML = `<p class="note">In ${esc(label)}</p>
    <ul class="rows">${d.map(x => `<li><span><b>${esc(x.grantedBy)}</b> to <b>${esc(x.delegate)}</b> (${esc(x.relationship)}), patient ${esc(x.patient)}: ${esc(sites(x.sites))}</span><button class="secondary small" data-del-delegation="${esc(JSON.stringify({ patient: x.patient, delegate: x.delegate }))}">Delete</button></li>`).join("") || '<li><span class="note">No delegations.</span></li>'}</ul>
    <ul class="rows">${g.map(x => `<li><span><b>${esc(x.user)}</b> authorized app <b>${esc(x.client)}</b>, patient ${esc(x.patient)}: ${esc(sites(x.sites))}</span><button class="secondary small" data-del-grant="${esc(JSON.stringify({ client: x.client, user: x.user, patient: x.patient }))}">Delete</button></li>`).join("") || '<li><span class="note">No app grants.</span></li>'}</ul>`;

  if (!rulesEdited || lastActive !== active) { $("#rules-text").value = JSON.stringify(s.policy.rules, null, 2); rulesEdited = false; }
  lastActive = active;

  for (const [k, v] of Object.entries(s.settings)) { const i = document.querySelector(`[name=${k}]`); if (i && document.activeElement !== i) i.value = v; }
  $("#clock-now").textContent = `Demo time ${new Date(s.clock.now * 1000).toISOString()}, offset ${s.clock.offsetSeconds} seconds from real time.`;

  const sel = $("#backend-select");
  sel.innerHTML = s.backend.names.map(n => `<option value="${esc(n)}" ${n === s.backend.current ? "selected" : ""}>${esc(n)}</option>`).join("");

  $("#outage-state").textContent = s.outage ? "An outage is injected: the decision service is answering with errors." : "The decision service is up.";
  const toggle = $("#outage-toggle");
  toggle.textContent = s.outage ? "Clear outage" : "Inject outage";
  toggle.onclick = () => act($("#outage-msg"), s.outage ? "Outage cleared." : "Outage injected.", () => call("POST", "/outage", { on: !s.outage }));

  const counts = (active === "saved" ? saved : scratch).counts;
  $("#token-counts").textContent = `In ${label}. Live access tokens: ${counts.liveAccessTokens}. Refresh tokens: ${counts.refreshTokens}. Decisions cached at the proxy: ${s.proxy.cachedDecisions}. Signing key: ${s.signing.kid}. Retired signing keys: ${saved.counts.retiredSigningKeys}.`;
}

document.addEventListener("click", e => {
  const del = e.target.closest("[data-del-delegation]");
  if (del) act($("#chain-msg"), "Delegation deleted.", () => call("DELETE", `/delegations?${new URLSearchParams(JSON.parse(del.dataset.delDelegation))}`));
  const grant = e.target.closest("[data-del-grant]");
  if (grant) act($("#chain-msg"), "App grant deleted.", () => call("DELETE", `/app-grants?${new URLSearchParams(JSON.parse(grant.dataset.delGrant))}`));
  const use = e.target.closest("[data-activate]");
  if (use) act($("#store-msg"), `Now using ${use.textContent.replace("Use ", "")}.`, () => call("POST", "/store/activate", { store: use.dataset.activate }));
});
$("#reset-scratch").onclick = () => act($("#store-msg"), "Flow scratch is empty.", () => call("POST", "/store/reset-scratch"));
$("#reset-saved").onclick = () => {
  if (!confirm("Delete all saved delegations, app grants, rules and settings? This can't be undone.")) return;
  act($("#store-msg"), "Saved policy is reset. Saved tokens and the signing key were kept.", () => call("POST", "/store/reset-saved", { confirm: true }));
};
$("#rules-text").oninput = () => { rulesEdited = true; };
$("#save-rules").onclick = async () => {
  let rules;
  try { rules = JSON.parse($("#rules-text").value); }
  catch (e) { say($("#rules-msg"), `Not saved: this isn't valid JSON. ${e.message}`, true); return; }
  rulesEdited = false;
  const saved = await act($("#rules-msg"), "Rules saved.", () => call("PUT", "/rules", { rules }));
  if (!saved) rulesEdited = true;
};
$("#settings-form").onsubmit = e => {
  e.preventDefault();
  const body = Object.fromEntries([...new FormData(e.target)].map(([k, v]) => [k, v === "" ? null : Number(v)]));
  act($("#settings-msg"), "Settings saved.", () => call("PUT", "/settings", body));
};
$("#clock-form").onsubmit = e => {
  e.preventDefault();
  act($("#clock-msg"), "Clock advanced.", () => call("POST", "/clock", { advanceSeconds: Number($("#clock-seconds").value) }));
};
$("#clock-reset").onclick = () => act($("#clock-msg"), "Clock is back to real time.", () => call("POST", "/clock", { reset: true }));
$("#backend-select").onchange = e => act($("#backend-msg"), `Now using ${e.target.value}.`, () => call("POST", "/backend", { backend: e.target.value }));
$("#self-test").onclick = async () => {
  const out = $("#self-test-results");
  out.innerHTML = '<p class="note">Testing…</p>';
  try {
    const r = await call("GET", "/backends");
    out.innerHTML = `<ul class="rows">${r.backends.map(b => `<li><span><b>${esc(b.name)}</b>: <span class="${b.ok ? "ok" : "fail"}">${b.ok ? "ok" : "failed"}</span>. ${esc(b.detail)}</span></li>`).join("")}</ul>`;
  } catch (e) { out.innerHTML = ""; say($("#backend-msg"), `Self-test failed: ${e.message}`, true); }
};
$("#revoke-all").onclick = () => {
  if (!confirm("Revoke every access and refresh token in the active store?")) return;
  act($("#tokens-msg"), "All tokens are revoked.", () => call("POST", "/tokens/revoke-all"));
};

$("#flush-cache").onclick = () => act($("#tokens-msg"), "The proxy's decision cache is empty.", () => call("POST", "/proxy/flush"));
$("#rotate-key").onclick = () => {
  if (!confirm("Rotate the signing key? This demo's proxy is told at once, so every signed URL already issued loses the instant path now, and its requests go to the Imaging Server. A proxy that isn't told stops trusting the old key within 60 seconds.")) return;
  act($("#tokens-msg"), "The signing key is rotated.", () => call("POST", "/signing-key/rotate"));
};
call("GET", "/status").then(render).catch(e => { document.querySelector(".warning").insertAdjacentHTML("afterend", `<p class="msg bad">${esc(e.message)}</p>`); });
