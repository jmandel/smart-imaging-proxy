// Registering an app in a sandbox: the Register an app page, Build an App's wizard, and App check all use these.
// A key made here stays in this browser, for the app developer to copy.
import { useEffect, useState, type FormEvent } from "react";
import { api, type PrivateJwk } from "../lib/api";
import { Address, announce, Choice, CopyButton } from "../lib/format";
import { generateKey } from "../lib/servers";
import { store, stored } from "../lib/store";

export type ClientType = "public" | "confidential" | "backend";
export interface Client { id: string; name: string; type: ClientType; redirectUris: string[]; patients?: string; jwk?: { kid: string }; jwks?: { kid: string }[]; jwksUrl?: string }

const KEYS_KEY = "smart-imaging-client:keys";
const savedKeys = (): Record<string, PrivateJwk> => { try { return JSON.parse(stored(KEYS_KEY) ?? "{}"); } catch { return {}; } };
const keepKey = (id: string, jwk: PrivateJwk) => store(KEYS_KEY, JSON.stringify({ ...savedKeys(), [id]: jwk }));
const TYPES: [ClientType, string, string][] = [
  ["public", "Public app", "Authorization code with PKCE, and no key."],
  ["confidential", "Confidential app", "Sign-in, plus a signed key assertion."],
  ["backend", "Backend service", "No sign-in. Access is granted when you register."],
];
const PATIENTS = ["josh-example", "sam-example", "riley-example", "robin-example"];
/** A sandbox's FHIR base. */
const fhirBaseOf = (base: string) => `${location.origin}${base}/fhir`;

/** A registered app, with the details its developer needs to connect it. */
export function Registered({ c, base, removed }: { c: Client; base: string; removed: () => void }) {
  const key = savedKeys()[c.id], fhirBase = fhirBaseOf(base), openRedirect = c.redirectUris.includes("*");
  const remove = async () => { await api("DELETE", `/api/sandbox/clients/${encodeURIComponent(c.id)}`, undefined, base); removed(); };
  return (
    <article className="panel registered" id={`app-${c.id}`}>
      <div className="registered-head"><h3>{c.name}</h3><button type="button" className="tool" aria-label={`Remove ${c.name}`} onClick={remove}>Remove</button></div>
      <dl className="registered-facts">
        <dt>FHIR base</dt><dd><Address value={fhirBase} name="FHIR base" /></dd>
        <dt>Client ID</dt><dd><code>{c.id}</code></dd>
        <dt>Type</dt><dd>{TYPES.find(t => t[0] === c.type)?.[1] ?? c.type}</dd>
        {openRedirect ? <><dt>Redirect URI</dt><dd>Any URI allowed (<code>*</code> — not checked at sign-in)</dd></>
          : c.redirectUris.length > 0 && <><dt>{c.redirectUris.length > 1 ? "Redirect URIs" : "Redirect URI"}</dt><dd className="addr-list">{c.redirectUris.map(u => <Address key={u} value={u} name="redirect URI" />)}</dd></>}
        {c.type === "backend" && <><dt>May reach</dt><dd>{c.patients === "any" ? "Any patient" : c.patients}</dd></>}
        {(c.jwks ?? (c.jwk ? [c.jwk] : [])).length > 0 && <><dt>{(c.jwks?.length ?? 1) > 1 ? "Key ids" : "Key id"}</dt><dd>{(c.jwks ?? [c.jwk!]).map((k, i) => <span key={k.kid}>{i ? ", " : ""}<code>{k.kid}</code></span>)}</dd></>}
        {c.jwksUrl && <><dt>JWKS URL</dt><dd><Address value={c.jwksUrl} name="JWKS URL" /></dd></>}
      </dl>
      <div className="configure-actions">
        <CopyButton label="Copy FHIR base" value={fhirBase} />
        <CopyButton label="Copy client ID" value={c.id} />
        {key && <CopyButton label="Copy private key" value={JSON.stringify(key)} />}
      </div>
    </article>
  );
}

/** A sandbox's registered apps, and a way to read them again. */
export function useClients(base: string) {
  const [clients, setClients] = useState<Client[]>();
  const refresh = async () => setClients((await api<{ clients: Client[] }>("GET", "/api/sandbox/clients", undefined, base)).clients);
  useEffect(() => { setClients(undefined); refresh(); }, [base]);
  return { clients, refresh };
}

export const CLIENT_KINDS = TYPES.map(t => t[0]);
/** The form that registers an app in `base`'s sandbox. `registered` hears of the app it made. Its kind of app is
 *  its own, unless the page holds it, as Register an app does in its address. */
/** What registering answers, RFC 7591's client metadata, as the app this page shows. */
interface RegisteredMetadata { client_id: string; client_name: string; token_endpoint_auth_method: string; grant_types: string[]; redirect_uris?: string[]; jwks?: { keys: (JsonWebKey & { kid: string })[] }; jwks_uri?: string; patients?: string }
const clientOf = (m: RegisteredMetadata): Client => ({
  id: m.client_id, name: m.client_name, redirectUris: m.redirect_uris ?? [],
  type: m.grant_types.includes("client_credentials") ? "backend" : m.token_endpoint_auth_method === "private_key_jwt" ? "confidential" : "public",
  ...(m.jwks ? { jwk: m.jwks.keys[0], jwks: m.jwks.keys } : {}), ...(m.jwks_uri ? { jwksUrl: m.jwks_uri } : {}), ...(m.patients ? { patients: m.patients } : {}),
} as Client);

export function RegisterForm({ base, registered, title = "Register an app", kind }: { base: string; registered: (c: Client) => void; title?: string; kind?: [ClientType, (t: ClientType) => void] }) {
  const [name, setName] = useState(""), [ownType, setOwnType] = useState<ClientType>("public"), [redirects, setRedirects] = useState("");
  const [type, setType] = kind ?? [ownType, setOwnType];
  const [anyRedirect, setAnyRedirect] = useState(false);
  const [jwks, setJwks] = useState(""), [pasted, setPasted] = useState(""), [patients, setPatients] = useState("any");
  const [error, setError] = useState<string>();
  const register = async (e: FormEvent) => {
    e.preventDefault();
    setError(undefined);
    try {
      // RFC 7591 client metadata: the kind of app follows from how it authenticates, and its grant.
      const body: Record<string, unknown> = { client_name: name, token_endpoint_auth_method: type === "public" ? "none" : "private_key_jwt", grant_types: type === "backend" ? ["client_credentials"] : ["authorization_code"] };
      let priv: PrivateJwk | undefined;
      if (type !== "backend") {
        if (anyRedirect) body.redirect_uris = ["*"];
        else {
          const uris = [...new Set(redirects.split(/\r?\n/).map(s => s.trim()).filter(Boolean))];
          if (!uris.length) throw new Error("Enter at least one redirect URI, or allow any redirect URI.");
          body.redirect_uris = uris;
        }
      }
      if (type !== "public") {
        if (jwks.trim()) body.jwks_uri = jwks.trim();
        else if (pasted.trim()) { try { body.jwks = { keys: [JSON.parse(pasted)] }; } catch { throw new Error("The key isn't valid JSON."); } }
        else { const made = await generateKey(); body.jwks = { keys: [made.pub] }; priv = made.priv; }
      }
      if (type === "backend") body.patients = patients;
      const made = clientOf(await api<RegisteredMetadata>("POST", "/register", body, base));
      if (priv) keepKey(made.id, priv);
      setName(""); setType("public"); setRedirects(""); setAnyRedirect(false); setJwks(""); setPasted(""); setPatients("any");
      announce(`${made.name} registered.`);
      registered(made);
    } catch (x) { setError((x as Error).message); }
  };
  return (
    <form id="register" className="panel" onSubmit={register}>
      <h2>{title}</h2>
      <label htmlFor="app-name">App name</label>
      <input type="text" id="app-name" required maxLength={80} autoComplete="off" value={name} onChange={e => setName(e.target.value)} />
      <fieldset className="client-type"><legend>Type</legend>
        {TYPES.map(([v, label, what]) => <Choice key={v} type="radio" name="type" value={v} checked={type === v} onChange={() => setType(v)} label={label} detail={what} />)}
      </fieldset>
      {type !== "backend" && <div id="redirect-field">
        <label htmlFor="app-redirect">Redirect URIs</label>
        <textarea id="app-redirect" rows={2} disabled={anyRedirect} placeholder={"https://example.org/callback\nhttp://localhost:3000/callback"} autoComplete="off" autoCapitalize="off" spellCheck={false} value={redirects} onChange={e => setRedirects(e.target.value)} />
        <p className="note">One per line, matched exactly at sign-in. Use https, or http on localhost, 127.0.0.1 or [::1].</p>
        <label className="check"><input type="checkbox" checked={anyRedirect} onChange={e => setAnyRedirect(e.target.checked)} /> Allow any redirect URI (don't check at sign-in, for testing)</label>
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
  );
}
