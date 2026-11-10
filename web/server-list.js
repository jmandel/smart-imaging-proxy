// The servers of your own that this browser's viewer can connect to, kept in this browser. The "Test your
// server" page writes them, and the viewer reads them, so both agree on what an entry must hold.
const SERVERS_KEY = "smart-imaging-client:servers", CHOICE_KEY = "smart-imaging-client:choice";
const stored = key => { try { return localStorage.getItem(key); } catch { return null; } };
const store = (key, value) => { try { value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch {} };
const isLocal = host => ["localhost", "127.0.0.1"].includes(host);
/** One entry as given, checked. Gives the entry, or throws saying what's wrong. */
function checkServer(s, where = "This server") {
  for (const [k, name] of [["label", "a name"], ["iss", "a FHIR base URL"], ["clientId", "a client ID"]]) if (typeof s?.[k] !== "string" || !s[k].trim()) throw new Error(`${where} needs ${name} ("${k}").`);
  for (const k of ["iss", "imaging"]) if (s[k] !== undefined) {
    let u; try { u = new URL(s[k]); } catch { throw new Error(`${where}: "${k}" isn't a URL.`); }
    if (u.protocol !== "https:" && !isLocal(u.hostname)) throw new Error(`${where}: "${k}" must use https.`);
  }
  if (s.scope !== undefined && typeof s.scope !== "string") throw new Error(`${where}: "scope" must be text.`);
  if (s.mode !== undefined && !["launch", "backend"].includes(s.mode)) throw new Error(`${where}: "mode" must be launch or backend.`);
  if (s.auth !== undefined && !["public", "private_key_jwt"].includes(s.auth)) throw new Error(`${where}: "auth" must be public or private_key_jwt.`);
  const signs = s.auth === "private_key_jwt" || s.mode === "backend";
  if (signs && (typeof s.jwk !== "object" || !s.jwk?.d || !s.jwk?.kid)) throw new Error(`${where} needs a "jwk": a private ES256 JWK with a kid.`);
  if (s.mode === "backend" && (typeof s.patient !== "string" || !s.patient)) throw new Error(`${where} needs a "patient": the patient's FHIR id.`);
  return {
    label: s.label.trim(), iss: s.iss.trim().replace(/\/$/, ""), clientId: s.clientId.trim(),
    ...(s.scope?.trim() ? { scope: s.scope.trim() } : {}), ...(s.imaging ? { imaging: s.imaging.trim().replace(/\/$/, "") } : {}),
    ...(s.mode === "backend" ? { mode: "backend" } : {}), ...(s.auth === "private_key_jwt" ? { auth: "private_key_jwt" } : {}),
    ...(signs ? { jwk: s.jwk } : {}), ...(s.mode === "backend" ? { patient: s.patient } : {}),
  };
}
/** A pasted list. Gives the servers, or throws saying what's wrong. */
function parseServers(text) {
  const list = JSON.parse(text);
  if (!Array.isArray(list)) throw new Error("Expected a JSON array of servers.");
  return list.map((s, i) => checkServer(s, `Server ${i + 1}`));
}
/** The servers this browser has added. */
function savedServers() {
  try { const text = stored(SERVERS_KEY); if (text) return parseServers(text); } catch {}
  return [];
}
const saveServers = list => store(SERVERS_KEY, list.length ? JSON.stringify(list) : null);
const serverKey = s => `${s.iss}|${s.clientId}`;
/** Adds a server, or replaces the one with the same address and client. */
function putServer(entry, replacing = serverKey(entry)) {
  const list = savedServers(), at = list.findIndex(s => serverKey(s) === replacing);
  if (at >= 0) list[at] = entry; else list.push(entry);
  saveServers(list);
}
/** Makes a server the viewer's choice, and opens the viewer, ending any session it had there. */
function tryServer(entry) {
  store(CHOICE_KEY, serverKey(entry));
  try { sessionStorage.removeItem(`smart-imaging-client:${BASE}`); } catch {}
  location.assign(`${BASE}/viewer`);
}

const IMAGING = "smart-imaging-access", APP_LAUNCH = "http://fhir.org/argonaut/smart-imaging/capabilities/app-launch";
const BACKEND_CAPABILITY = "http://fhir.org/argonaut/smart-imaging/capabilities/backend-services";
/** Where discovery says imaging is, for a way of connecting: on this FHIR server, or an associated one. */
function imagingOf(config, iss, capability = APP_LAUNCH) {
  const offers = caps => caps?.includes(IMAGING) && caps.includes(capability);
  if (offers(config.capabilities)) return { url: iss, unified: true };
  const associated = (config.associated_endpoints ?? []).find(e => offers(e.capabilities));
  return associated && { url: associated.url.replace(/\/$/, ""), unified: false };
}
/** A fresh ES256 pair, made here, so the server only ever sees the public half. */
async function generateKey() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const kid = crypto.randomUUID(), [priv, pub] = await Promise.all([crypto.subtle.exportKey("jwk", pair.privateKey), crypto.subtle.exportKey("jwk", pair.publicKey)]);
  return { priv: { ...priv, kid }, pub: { kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y, kid } };
}
