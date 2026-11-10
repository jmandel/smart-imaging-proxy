// Registering an app in this sandbox, and trying it in our viewer. A key made here stays in this browser.
import { useEffect, useState, type FormEvent } from "react";
import { api, BASE, type PrivateJwk } from "../lib/api";
import { announce, CopyButton } from "../lib/format";
import { generateKey, savedServers, saveServers, VIEWER_URL, type ServerEntry } from "../lib/servers";
import { launchViewer } from "../lib/launch";
import { store, stored } from "../lib/store";
import { PageLink } from "../shell/Shell";

type ClientType = "public" | "confidential" | "backend";
interface Client { id: string; name: string; type: ClientType; redirectUris: string[]; patients?: string; jwk?: { kid: string }; jwksUrl?: string }

const KEYS_KEY = "smart-imaging-client:keys";
const savedKeys = (): Record<string, PrivateJwk> => { try { return JSON.parse(stored(KEYS_KEY) ?? "{}"); } catch { return {}; } };
const keepKey = (id: string, jwk: PrivateJwk) => store(KEYS_KEY, JSON.stringify({ ...savedKeys(), [id]: jwk }));
const TYPES: [ClientType, string, string][] = [
  ["public", "Public app", "Authorization code with PKCE, and no key."],
  ["confidential", "Confidential app", "Sign-in, plus a signed key assertion."],
  ["backend", "Backend service", "No sign-in. Access is granted when you register."],
];
const PATIENTS = ["josh-example", "sam-example", "riley-example", "robin-example"];
/** This sandbox's FHIR base, for the page shown. */
const fhirBaseOf = () => `${location.origin}${BASE}/fhir`;

/** Whether the viewer can act as this client: it holds the key, and for sign-in, the viewer's address is registered. */
const canTry = (c: Client) => (c.type === "public" || !!savedKeys()[c.id]) && (c.type === "backend" || c.redirectUris.includes(VIEWER_URL));
function tryInViewer(c: Client) {
  const jwk = savedKeys()[c.id];
  const entry: ServerEntry = { label: c.name, iss: fhirBaseOf(), clientId: c.id, ...(c.type === "backend" ? { mode: "backend" as const, jwk, patient: c.patients === "any" ? "josh-example" : c.patients, scope: "system/ImagingStudy.rs" } : c.type === "confidential" ? { auth: "private_key_jwt" as const, jwk } : {}) };
  saveServers([...savedServers().filter(s => s.clientId !== c.id), entry]);
  // Straight to connecting: the sign-in tab, if any, opens from this click.
  launchViewer(entry, { connect: true });
}

function Registered({ c, removed }: { c: Client; removed: () => void }) {
  const key = savedKeys()[c.id], fhirBase = fhirBaseOf();
  const remove = async () => { await api("DELETE", `/api/sandbox/clients/${encodeURIComponent(c.id)}`); removed(); };
  return (
    <article className="panel registered">
      <div className="registered-head"><h3>{c.name}</h3><button type="button" className="tool" aria-label={`Remove ${c.name}`} onClick={remove}>Remove</button></div>
      <dl className="registered-facts">
        <dt>FHIR base</dt><dd><code>{fhirBase}</code></dd>
        <dt>Client ID</dt><dd><code>{c.id}</code></dd>
        <dt>Type</dt><dd>{TYPES.find(t => t[0] === c.type)?.[1] ?? c.type}</dd>
        {c.redirectUris.length > 0 && <><dt>Redirect URI</dt><dd>{c.redirectUris.map(u => <code key={u}>{u}</code>)}</dd></>}
        {c.type === "backend" && <><dt>May reach</dt><dd>{c.patients === "any" ? "Any patient" : c.patients}</dd></>}
        {c.jwk && <><dt>Key id</dt><dd><code>{c.jwk.kid}</code></dd></>}
        {c.jwksUrl && <><dt>JWKS URL</dt><dd><code>{c.jwksUrl}</code></dd></>}
      </dl>
      <div className="configure-actions">
        <CopyButton label="Copy FHIR base" value={fhirBase} />
        <CopyButton label="Copy client ID" value={c.id} />
        <CopyButton label="Copy viewer config" value={JSON.stringify({ label: c.name, iss: fhirBase, clientId: c.id })} />
        {key && <CopyButton label="Copy private key" value={JSON.stringify(key)} />}
        {canTry(c) && <button type="button" className="primary" onClick={() => tryInViewer(c)}>Try it in the viewer</button>}
      </div>
    </article>
  );
}

export default function Connect() {
  const [clients, setClients] = useState<Client[]>();
  const [name, setName] = useState(""), [type, setType] = useState<ClientType>("public"), [redirect, setRedirect] = useState("");
  const [jwks, setJwks] = useState(""), [pasted, setPasted] = useState(""), [patients, setPatients] = useState("any");
  const [error, setError] = useState<string>();
  const refresh = async () => setClients((await api<{ clients: Client[] }>("GET", "/api/sandbox/clients")).clients);
  useEffect(() => { refresh(); }, []);
  const register = async (e: FormEvent) => {
    e.preventDefault();
    setError(undefined);
    try {
      const body: Record<string, unknown> = { name, type };
      let priv: PrivateJwk | undefined;
      if (type !== "backend") body.redirectUris = [redirect.trim()];
      if (type !== "public") {
        if (jwks.trim()) body.jwksUrl = jwks.trim();
        else if (pasted.trim()) { try { body.jwk = JSON.parse(pasted); } catch { throw new Error("The key isn't valid JSON."); } }
        else { const made = await generateKey(); body.jwk = made.pub; priv = made.priv; }
      }
      if (type === "backend") body.patients = patients;
      const made = await api<Client>("POST", "/api/sandbox/clients", body);
      if (priv) keepKey(made.id, priv);
      setName(""); setType("public"); setRedirect(""); setJwks(""); setPasted(""); setPatients("any");
      await refresh();
      announce("App registered.");
    } catch (x) { setError((x as Error).message); }
  };
  return (
    <main className="landing connect-page">
      <h1>Register an app</h1>
      <p className="lead">Register your SMART app in this sandbox to get a client ID. It stays registered until you remove it. <PageLink id="build" /> has the endpoints to point it at, and who to sign in as.</p>
      <form id="register" className="panel" onSubmit={register}>
        <h2>Register an app</h2>
        <label htmlFor="app-name">App name</label>
        <input type="text" id="app-name" required maxLength={80} autoComplete="off" value={name} onChange={e => setName(e.target.value)} />
        <fieldset className="client-type"><legend>Type</legend>
          {TYPES.map(([v, label, what]) => <label key={v}><input type="radio" name="type" value={v} checked={type === v} onChange={() => setType(v)} /> {label} <span>{what}</span></label>)}
        </fieldset>
        {type !== "backend" && <div id="redirect-field">
          <label htmlFor="app-redirect">Redirect URI</label>
          <input type="url" id="app-redirect" placeholder="https://example.org/callback" autoComplete="off" autoCapitalize="off" spellCheck={false} value={redirect} onChange={e => setRedirect(e.target.value)} />
          <p className="note">Must match exactly at sign-in. Use https, or http on localhost. To try the app in our viewer, use <code>{VIEWER_URL}</code>.</p>
        </div>}
        {type !== "public" && <div id="key-field">
          <label htmlFor="app-jwks">JWKS URL</label>
          <input type="url" id="app-jwks" placeholder="https://example.org/.well-known/jwks.json" autoComplete="off" autoCapitalize="off" spellCheck={false} value={jwks} onChange={e => setJwks(e.target.value)} />
          <label htmlFor="app-key">Or a public key (JWK)</label>
          <textarea id="app-key" rows={4} spellCheck={false} autoCapitalize="off" placeholder="Leave both empty to generate a key pair in this browser" value={pasted} onChange={e => setPasted(e.target.value)} />
          <p className="note">Keys may be ES256, ES384 or RS384.</p>
          <p className="note">A generated private key stays in this browser, so use it only for testing.</p>
        </div>}
        {type === "backend" && <div id="patients-field">
          <label htmlFor="app-patients">Patients it may reach</label>
          <select id="app-patients" value={patients} onChange={e => setPatients(e.target.value)}><option value="any">Any patient</option>{PATIENTS.map(p => <option key={p} value={p}>{p}</option>)}</select>
        </div>}
        <button type="submit" className="primary">Register</button>
        {error && <p className="error" id="register-error" role="alert">{error}</p>}
      </form>
      <section aria-labelledby="yours"><h2 id="yours">Your apps</h2>
        <div id="clients">{!clients ? <p className="note">Loading…</p> : clients.length ? clients.map(c => <Registered key={c.id} c={c} removed={refresh} />) : <p className="note">None yet.</p>}</div>
      </section>
    </main>
  );
}
