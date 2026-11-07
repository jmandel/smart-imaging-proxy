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

let lastActive, ruleSets, ruleSetPick = new URLSearchParams(location.search).get("rule-set");

const SETTING_NAMES = { contextLifetimeSeconds: "Context lifetime", maxSeriesInContext: "Most series listed in a URL", tokenLifetimeSeconds: "Access token lifetime", refreshTokenLifetimeSeconds: "Refresh token lifetime" };
/** A value no choice offers, in words. */
function offChoice(name, v) {
  if (name === "maxSeriesInContext") return String(v);
  for (const [unit, seconds] of [["day", 86400], ["hour", 3600], ["minute", 60]]) if (v >= seconds && v % seconds === 0) return `${v / seconds} ${unit}${v === seconds ? "" : "s"}`;
  return `${v} second${v === 1 ? "" : "s"}`;
}
function renderSetting(select, name, value, choices) {
  const known = choices.some(c => c.value === value);
  const html = `${known ? "" : `<option value="" disabled>${esc(offChoice(name, value))} (current)</option>`}${choices.map(c => `<option value="${c.value}">${esc(c.label)}</option>`).join("")}`;
  if (select.dataset.options !== html) { select.innerHTML = html; select.dataset.options = html; }
  select.value = known ? String(value) : "";
}
function renderRuleSets() {
  const { current, choices } = ruleSets;
  if (!choices.some(c => c.id === ruleSetPick && c.rules)) ruleSetPick = current;
  const select = $("#rule-set-select");
  const pick = choices.find(c => c.id === ruleSetPick && c.rules);
  const html = `${pick ? "" : '<option value="" disabled>Pick a named rule set</option>'}${choices.map(c => `<option value="${esc(c.id)}"${c.rules ? "" : " disabled"}>${esc(c.label)}${c.rules ? "" : " (not in this catalog)"}</option>`).join("")}`;
  if (select.dataset.options !== html) { select.innerHTML = html; select.dataset.options = html; }
  select.value = pick?.id ?? "";
  $("#apply-rule-set").disabled = !pick || pick.id === current;
  $("#rule-set-description").textContent = pick?.description ?? (current ? "The rule set in effect names studies this backend's catalog doesn't hold." : "These rules aren't one of the named rule sets. They stay until you apply one.");
  $("#rule-set-rules-title").hidden = $("#rule-set-rules").hidden = !pick;
  $("#rule-set-rules-title").textContent = pick?.id === current ? "Rules this set applies, in effect now" : "Rules this set applies, once you apply it";
  $("#rule-set-rules").textContent = pick ? (pick.rules.length ? JSON.stringify(pick.rules, null, 2) : "No rules.") : "";
}

function render(s) {
  const { saved, scratch, active, label } = s.store;
  const badge = $("#store-badge");
  badge.textContent = label;
  badge.className = `store-badge ${active}`;
  const col = name => active === name ? ' class="active-col"' : "";
  const row = (name, f) => `<tr><th scope="row">${esc(name)}</th><td${col("saved")}>${esc(f(saved))}</td><td${col("scratch")}>${esc(f(scratch))}</td></tr>`;
  $("#store-table").innerHTML = `<table><thead><tr><th></th><th scope="col"${col("saved")}>Saved policy${active === "saved" ? " (active)" : ""}</th><th scope="col"${col("scratch")}>Flow scratch${active === "scratch" ? " (active)" : ""}</th></tr></thead><tbody>
    ${row("Mode", x => x.mode)}${row("Path", x => x.path)}${row("Durability", x => x.mode === "file" ? x.durability : "none: in memory")}${row("Journal", x => x.journal)}${row("Schema version", x => x.schemaVersion)}
    ${row("Guardians on file", x => x.counts.guardians)}${row("Delegations", x => x.counts.delegations)}${row("App grants", x => x.counts.appGrants)}${row("Rules", x => x.counts.rules)}${row("Settings changed", x => x.counts.settings)}${row("Live access tokens", x => x.counts.liveAccessTokens)}${row("Refresh tokens", x => x.counts.refreshTokens)}${row("Signing keys", x => x.counts.signingKeys)}${row("Retired signing keys", x => x.counts.retiredSigningKeys)}
  </tbody></table>`;

  const sites = v => v === undefined ? "everything they can see" : v.length ? v.join(", ") : "no sites";
  const d = s.policy.delegations, g = s.policy.appGrants, standing = s.policy.guardians;
  $("#chain-list").innerHTML = `<p class="note">In ${esc(label)}</p>
    <h3>Guardians on file</h3>
    <ul class="rows" id="guardians">${standing.map(x => `<li data-guardian="${esc(x.guardian)}"><span><b>${esc(x.guardian)}</b> is the ${esc(x.relationship)} of patient ${esc(x.patient)}: ${x.excludedStudies?.length ? `all but ${esc(x.excludedStudies.join(", "))}, which is confidential from them` : "the whole record"}</span></li>`).join("") || '<li><span class="note">No guardians.</span></li>'}</ul>
    <p class="note">Standing policy the Imaging Server evaluates, seeded from <code>data/patient.json</code>. No one chose it by sharing, so there's no one to revoke it here, and a policy reset puts it back.</p>
    <h3>Delegations</h3>
    <ul class="rows">${d.map(x => `<li><span><b>${esc(x.grantedBy)}</b> to <b>${esc(x.delegate)}</b> (${esc(x.relationship)}), patient ${esc(x.patient)}: ${esc(sites(x.sites))}</span><button class="secondary small" data-del-delegation="${esc(JSON.stringify({ patient: x.patient, delegate: x.delegate }))}">Delete</button></li>`).join("") || '<li><span class="note">No delegations.</span></li>'}</ul>
    <h3>App grants</h3>
    <ul class="rows">${g.map(x => `<li><span><b>${esc(x.user)}</b> authorized app <b>${esc(x.client)}</b>, patient ${esc(x.patient)}: ${esc(sites(x.sites))}</span><button class="secondary small" data-del-grant="${esc(JSON.stringify({ client: x.client, user: x.user, patient: x.patient }))}">Delete</button></li>`).join("") || '<li><span class="note">No app grants.</span></li>'}</ul>`;

  if (lastActive !== undefined && lastActive !== active) ruleSetPick = null;
  lastActive = active;
  ruleSets = s.ruleSets;
  const inEffect = s.ruleSets.choices.find(c => c.id === s.ruleSets.current);
  $("#rules-current").innerHTML = `In ${esc(label)}: <b>${esc(inEffect?.label ?? "Custom rules from a flow or older version")}</b>`;
  $("#custom-rules").hidden = !!inEffect;
  $("#custom-rules-text").textContent = inEffect ? "" : JSON.stringify(s.policy.rules, null, 2);
  renderRuleSets();

  document.querySelectorAll("[data-setting]").forEach(select => renderSetting(select, select.dataset.setting, s.settings[select.dataset.setting], s.settingChoices[select.dataset.setting]));
  const clock = $("#clock-buttons");
  if (!clock.children.length) clock.innerHTML = s.clockChoices.map(c => `<button class="secondary" data-advance="${c.value}">Advance ${esc(c.label)}</button>`).join("");
  $("#clock-now").textContent = `Demo time ${new Date(s.clock.now * 1000).toISOString()}, offset ${s.clock.offsetSeconds} seconds from real time.`;

  const sel = $("#backend-select");
  sel.innerHTML = s.backend.names.map(n => `<option value="${esc(n)}" ${n === s.backend.current ? "selected" : ""}>${esc(n)}</option>`).join("");

  const c = s.catalog;
  $("#catalog-stats").innerHTML = `<dl class="stats"><dt>In use</dt><dd>The ${esc(c.source)} catalog, for ${esc(s.backend.current)}</dd><dt>Path</dt><dd><code>${esc(c.path)}</code></dd><dt>Studies</dt><dd>${esc(c.studies)}</dd><dt>Series</dt><dd>${esc(c.series)}</dd><dt>Hierarchy bytes</dt><dd>${esc(c.hierarchyBytes.toLocaleString())} stored, ${esc(c.hierarchyRawBytes.toLocaleString())} uncompressed</dd></dl>`;

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
  const ahead = e.target.closest("[data-advance]");
  if (ahead) act($("#clock-msg"), `Clock advanced ${ahead.textContent.replace("Advance ", "")}.`, () => call("POST", "/clock", { advanceSeconds: Number(ahead.dataset.advance) }));
});
$("#reset-scratch").onclick = () => act($("#store-msg"), "Flow scratch is reset, with only the guardians on file.", () => call("POST", "/store/reset-scratch"));
$("#reset-saved").onclick = () => {
  if (!confirm("Delete all saved delegations, app grants, rules and settings? This can't be undone. Guardians on file stay.")) return;
  act($("#store-msg"), "Saved policy is reset. Guardians on file, saved tokens and the signing key were kept.", () => call("POST", "/store/reset-saved", { confirm: true }));
};
$("#rule-set-select").onchange = e => { ruleSetPick = e.target.value; renderRuleSets(); };
$("#apply-rule-set").onclick = () => {
  const pick = ruleSets.choices.find(c => c.id === ruleSetPick);
  // Applying disables this button, so focus moves to the choice beside it.
  $("#rule-set-select").focus();
  if (pick) act($("#rules-msg"), `Applied: ${pick.label}.`, () => call("POST", "/rule-set", { id: pick.id }));
};
document.querySelectorAll("[data-setting]").forEach(select => {
  select.onchange = async () => {
    const name = select.dataset.setting;
    const done = await act($("#settings-msg"), `${SETTING_NAMES[name]}: ${select.selectedOptions[0].textContent}.`, () => call("PUT", "/settings", { [name]: Number(select.value) }));
    if (!done) call("GET", "/status").then(render).catch(() => {});
  };
});
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
  act($("#tokens-msg"), "The signing key is rotated, and the proxy has refetched its keys.", async () => {
    const s = await call("POST", "/signing-key/rotate");
    if (!s.rotation.proxyTold) throw new Error("the key is rotated, but the proxy couldn't be told, so it stops trusting the old key within 60 seconds");
    return s;
  });
};
call("GET", "/status").then(render).catch(e => { document.querySelector(".warning").insertAdjacentHTML("afterend", `<p class="msg bad">${esc(e.message)}</p>`); });
fetch("/api/flows").then(r => r.json()).then(d => { $("#live-link").href = d.services["live trace"]; }).catch(() => {});
