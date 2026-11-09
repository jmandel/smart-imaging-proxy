// Describing a server of your own for this sandbox's viewer: what it is, how the viewer signs in, and what to
// register there. Discovery is checked here, from the browser, the way the viewer itself will read it.
const REDIRECT = `${location.origin}${BASE}/`;
const SCOPES = { public: "launch/patient patient/*.rs", confidential: "launch/patient patient/*.rs", backend: "system/ImagingStudy.rs" };
const HOW_LABEL = { public: "Sign-in, public app", confidential: "Sign-in, confidential app", backend: "Backend service" };
const howNow = () => $("input[name=how]:checked").value;
const howOf = s => s.mode === "backend" ? "backend" : s.auth === "private_key_jwt" ? "confidential" : "public";
const publicHalf = jwk => ({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, kid: jwk.kid, use: "sig", alg: "ES256" });
/** What's being edited: the saved entry it replaces, and the private key it signs with. */
let editing = null, key = null, discovered = null;

function paintForm() {
  const how = howNow(), signs = how !== "public";
  $("#key-field").hidden = !signs;
  $("#patient-field").hidden = how !== "backend";
  $("#srv-scope").placeholder = SCOPES[how];
  const facts = [
    ...(how === "backend" ? [] : [["Redirect URI", REDIRECT]]),
    ["Scopes", SCOPES[how]],
    ...(signs ? [["Client authentication", "private_key_jwt, signed with ES256"]] : [["Client authentication", "None (a public client using PKCE)"]]),
    ...(how === "backend" ? [["Grant type", "client_credentials"]] : []),
  ];
  $("#register-facts").innerHTML = facts.map(([k, v]) => `<dt>${k}</dt><dd><code>${esc(v)}</code>${k === "Redirect URI" ? ` ${copyButton("Copy", v, "Copy redirect URI")}` : ""}</dd>`).join("")
    + (signs && key ? `<dt>Public key</dt><dd><code class="jwk">${esc(JSON.stringify(publicHalf(key)))}</code> ${copyButton("Copy JWK", JSON.stringify(publicHalf(key)))} ${copyButton("Copy as JWKS", JSON.stringify({ keys: [publicHalf(key)] }))}</dd>` : "");
  $("#key-state").textContent = !signs ? "" : key ? `Signing with key ${key.kid}. Register its public half above with your server, as a JWK or in a JWKS it fetches.` : "The viewer needs a key to sign with. Generate one here, then register its public half with your server.";
  $("#generate").textContent = key ? "Generate a new key pair" : "Generate a key pair";
  if (discovered) paintDiscovery(discovered);
}
$$("input[name=how]").forEach(r => r.addEventListener("change", paintForm));
$("#generate").addEventListener("click", async () => { key = (await generateKey()).priv; $("#srv-jwk").value = ""; paintForm(); announce("Key pair generated."); });
$("#paste-toggle").addEventListener("click", () => {
  const field = $("#paste-field"), open = field.hidden;
  field.hidden = !open;
  $("#paste-toggle").setAttribute("aria-expanded", String(open));
  if (open) $("#srv-jwk").focus();
});
$("#srv-jwk").addEventListener("input", () => {
  const text = $("#srv-jwk").value.trim();
  if (!text) return;
  try { const k = JSON.parse(text); if (k.kty === "EC" && k.crv === "P-256" && k.d && k.kid) { key = k; paintForm(); } } catch {}
});
// A name to start from, from the address, until someone types their own.
$("#srv-iss").addEventListener("change", () => {
  const label = $("#srv-label");
  try { if (!label.value.trim() || label.dataset.auto) { label.value = new URL($("#srv-iss").value.trim()).host; label.dataset.auto = "1"; } } catch {}
});
$("#srv-label").addEventListener("input", () => delete $("#srv-label").dataset.auto);

/** The form as a server entry, checked. */
function entryOfForm() {
  const how = howNow(), value = id => $(id).value.trim();
  const pasted = value("#srv-jwk");
  if (how !== "public" && pasted && pasted !== JSON.stringify(key)) {
    let k; try { k = JSON.parse(pasted); } catch { throw new Error("The pasted key isn't valid JSON."); }
    if (k.kty !== "EC" || k.crv !== "P-256" || !k.d || !k.kid) throw new Error("The pasted key must be a private EC P-256 JWK (with \"d\") and a \"kid\".");
    key = k;
  }
  if (how !== "public" && !key) throw new Error("Generate a key pair, or paste a private key, so the viewer can sign its assertions.");
  if (how === "backend" && !value("#srv-patient")) throw new Error("A backend service needs the patient's FHIR id.");
  return checkServer({
    label: value("#srv-label"), iss: value("#srv-iss"), clientId: value("#srv-client"),
    ...(value("#srv-scope") ? { scope: value("#srv-scope") } : {}), ...(value("#srv-imaging") ? { imaging: value("#srv-imaging") } : {}),
    ...(how === "backend" ? { mode: "backend", jwk: key, patient: value("#srv-patient") } : how === "confidential" ? { auth: "private_key_jwt", jwk: key } : {}),
  });
}
function save() {
  const err = $("#form-error");
  err.hidden = true;
  try {
    const entry = entryOfForm();
    putServer(entry, editing ?? serverKey(entry));
    clearForm();
    paintSaved();
    announce(`Saved ${entry.label}.`);
    return entry;
  } catch (e) { err.hidden = false; err.textContent = e.message; return null; }
}
$("#save").addEventListener("click", save);
$("#server-form").addEventListener("submit", e => { e.preventDefault(); const entry = save(); if (entry) tryServer(entry); });
function clearForm() {
  $("#server-form").reset();
  delete $("#srv-label").dataset.auto;
  editing = null; key = null; discovered = null;
  $("#discovery").hidden = true;
  $("#paste-field").hidden = true;
  $("#form-title").textContent = "Add a server";
  $("#cancel-edit").hidden = true;
  $("#form-error").hidden = true;
  paintForm();
}
$("#cancel-edit").addEventListener("click", clearForm);
function edit(entry) {
  clearForm();
  editing = serverKey(entry);
  $("#srv-iss").value = entry.iss; $("#srv-label").value = entry.label; $("#srv-client").value = entry.clientId;
  $("#srv-scope").value = entry.scope ?? ""; $("#srv-imaging").value = entry.imaging ?? ""; $("#srv-patient").value = entry.patient ?? "";
  if (entry.scope || entry.imaging) $(".advanced").open = true;
  $(`input[name=how][value=${howOf(entry)}]`).checked = true;
  key = entry.jwk ?? null;
  $("#form-title").textContent = `Edit ${entry.label}`;
  $("#cancel-edit").hidden = false;
  paintForm();
  $("#server-form").scrollIntoView({ block: "start" });
  $("#srv-iss").focus({ preventScroll: true });
}

// Discovery, read the way the viewer reads it.
const ok = (state, what, detail) => `<li data-state="${state}"><span class="mark-${state}" aria-hidden="true">${{ ok: "✓", warn: "!", bad: "✕" }[state]}</span><div><strong>${esc(what)}</strong><span>${detail}</span></div></li>`;
const host = u => { try { return esc(new URL(u).host); } catch { return esc(u); } };
function paintDiscovery(found) {
  const box = $("#discovery");
  box.hidden = false;
  if (found.error) { box.innerHTML = `<ul class="checks">${ok("bad", "Discovery", found.error)}</ul>`; return; }
  const c = found.config, iss = found.iss, how = howNow(), rows = [ok("ok", "Discovery", `Read <code>${esc(found.url)}</code>`)];
  const listed = (field, value) => !c[field] ? "unstated" : c[field].includes(value) ? "yes" : "no";
  if (how !== "backend") {
    rows.push(c.authorization_endpoint ? ok("ok", "Sign-in", `At ${host(c.authorization_endpoint)}`) : ok("bad", "Sign-in", "No <code>authorization_endpoint</code>."));
    const pkce = listed("code_challenge_methods_supported", "S256");
    rows.push(pkce === "yes" ? ok("ok", "PKCE", "Offers S256.") : pkce === "unstated" ? ok("warn", "PKCE", "Doesn't say. The viewer sends S256 anyway.") : ok("bad", "PKCE", "Doesn't offer S256, which the viewer requires."));
  }
  rows.push(c.token_endpoint ? ok("ok", "Tokens", `At ${host(c.token_endpoint)}`) : ok("bad", "Tokens", "No <code>token_endpoint</code>."));
  if (how !== "public") {
    const jwt = listed("token_endpoint_auth_methods_supported", "private_key_jwt"), alg = listed("token_endpoint_auth_signing_alg_values_supported", "ES256");
    rows.push(jwt === "no" ? ok("bad", "Signed assertions", "Doesn't list <code>private_key_jwt</code>.") : alg === "no" ? ok("bad", "Signed assertions", "Doesn't accept ES256, the viewer's algorithm.") : jwt === "yes" && alg === "yes" ? ok("ok", "Signed assertions", "Accepts <code>private_key_jwt</code> with ES256.") : ok("warn", "Signed assertions", "Doesn't say whether it accepts <code>private_key_jwt</code> with ES256."));
  }
  if (how === "backend") {
    const grant = listed("grant_types_supported", "client_credentials");
    rows.push(grant === "yes" ? ok("ok", "Backend services", "Offers <code>client_credentials</code>.") : grant === "unstated" ? ok("warn", "Backend services", "Doesn't list its grant types.") : ok("bad", "Backend services", "Doesn't offer <code>client_credentials</code>."));
  }
  const imaging = imagingOf(c, iss, how === "backend" ? BACKEND_CAPABILITY : APP_LAUNCH), typed = $("#srv-imaging").value.trim();
  rows.push(imaging ? ok("ok", "SMART Imaging", imaging.unified ? "This server offers it itself." : `Offered by an associated server at <code>${esc(imaging.url)}</code>.`)
    : typed ? ok("warn", "SMART Imaging", `Not advertised, so the viewer uses the imaging server you gave under Advanced.`)
    : ok("bad", "SMART Imaging", `Not advertised for ${how === "backend" ? "backend services" : "app launch"}, in <code>capabilities</code> or <code>associated_endpoints</code>. If you know the imaging FHIR server, give it under Advanced.`));
  box.innerHTML = `<ul class="checks">${rows.join("")}</ul>`;
}
$("#check").addEventListener("click", async () => {
  const button = $("#check"), raw = $("#srv-iss").value.trim().replace(/\/$/, "");
  let iss;
  try { iss = new URL(raw).toString().replace(/\/$/, ""); } catch { discovered = { error: "Enter the FHIR base URL first, starting with https://." }; paintDiscovery(discovered); return; }
  const url = `${iss}/.well-known/smart-configuration`;
  button.disabled = true; button.textContent = "Checking…";
  try {
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (!r.ok) discovered = { error: `<code>${esc(url)}</code> answered HTTP ${r.status}. Is the FHIR base right?` };
    else { const config = await r.json().catch(() => null); discovered = config ? { config, iss, url } : { error: `<code>${esc(url)}</code> didn't answer with JSON.` }; }
  } catch {
    discovered = { error: `Couldn't read <code>${esc(url)}</code>. Check the address. If it opens in a new tab, your server isn't allowing requests from ${esc(location.origin)} (CORS), and the viewer needs that too.` };
  }
  button.disabled = false; button.textContent = "Check discovery";
  paintDiscovery(discovered);
});

// The saved list, and the same as JSON.
function paintSaved() {
  const list = savedServers();
  $("#saved").innerHTML = list.length ? list.map((s, i) => `<article class="panel registered">
    <div class="registered-head"><h3>${esc(s.label)}</h3></div>
    <dl class="registered-facts">
      <dt>FHIR base</dt><dd><code>${esc(s.iss)}</code></dd>
      <dt>Connects as</dt><dd>${esc(HOW_LABEL[howOf(s)])}</dd>
      <dt>Client ID</dt><dd><code>${esc(s.clientId)}</code></dd>
      ${s.patient ? `<dt>Patient</dt><dd><code>${esc(s.patient)}</code></dd>` : ""}
      ${s.imaging ? `<dt>Imaging</dt><dd><code>${esc(s.imaging)}</code></dd>` : ""}
    </dl>
    <div class="configure-actions"><button type="button" class="primary" data-connect="${i}">Connect</button><button type="button" class="secondary" data-edit="${i}">Edit</button><button type="button" class="tool quiet-danger" data-remove="${i}" aria-label="Remove ${esc(s.label)}">Remove</button></div>
  </article>`).join("") : `<p class="note">None yet. Servers you save here are also offered on the Overview, beside this sandbox's own.</p>`;
  $("#servers-json").value = JSON.stringify(list, null, 2);
}
$("#saved").addEventListener("click", e => {
  const list = savedServers(), at = name => { const b = e.target.closest(`[data-${name}]`); return b ? list[Number(b.dataset[name])] : undefined; };
  const connectTo = at("connect"), editThis = at("edit"), removeThis = at("remove");
  if (connectTo) tryServer(connectTo);
  if (editThis) edit(editThis);
  if (removeThis) {
    saveServers(list.filter(s => s !== removeThis));
    if (editing === serverKey(removeThis)) clearForm();
    paintSaved();
    announce(`Removed ${removeThis.label}.`);
  }
});
$("#servers-save").addEventListener("click", () => {
  const status = $("#servers-status");
  try { const list = parseServers($("#servers-json").value || "[]"); saveServers(list); paintSaved(); status.textContent = `Saved ${plural(list.length, "server")} of your own.`; }
  catch (e) { status.textContent = `Not saved. ${e.message}`; }
});

if (!BASE) location.replace("/");
paintForm();
paintSaved();
addEventListener("pageshow", e => { if (e.persisted) { paintSaved(); $("#check").disabled = false; $("#check").textContent = "Check discovery"; } });
