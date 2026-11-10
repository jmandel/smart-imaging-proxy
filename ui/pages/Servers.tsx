// Describing a server of your own for the viewer: what it is, how the viewer signs in, and what to
// register there. Discovery is checked here, from the browser, the way the viewer itself will read it.
import { Fragment, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { launchViewer } from "../lib/launch";
import type { PrivateJwk } from "../lib/api";
import { announce, CopyButton, plural } from "../lib/format";
import {
  APP_LAUNCH, BACKEND_CAPABILITY, checkServer, generateKey, imagingOf, parseServers, putServer,
  savedServers, saveServers, serverKey, VIEWER_URL, type ServerEntry,
} from "../lib/servers";
import { PageLink } from "../shell/Shell";

type How = "public" | "confidential" | "backend";
const SCOPES: Record<How, string> = { public: "launch/patient patient/*.rs", confidential: "launch/patient patient/*.rs", backend: "system/ImagingStudy.rs" };
const HOW_LABEL: Record<How, string> = { public: "Sign-in, public app", confidential: "Sign-in, confidential app", backend: "Backend service" };
const HOWS: [How, string, ReactNode][] = [
  ["public", "Sign-in, as a public app", "A person signs in. Authorization code with PKCE, and no key."],
  ["confidential", "Sign-in, as a confidential app", <>The same, plus a <code>private_key_jwt</code> assertion signed in this browser.</>],
  ["backend", "Backend service", "No one signs in. A signed assertion gets a token, and the viewer names the patient."],
];
const howOf = (s: ServerEntry): How => s.mode === "backend" ? "backend" : s.auth === "private_key_jwt" ? "confidential" : "public";
const publicHalf = (jwk: PrivateJwk) => ({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, kid: jwk.kid, use: "sig", alg: "ES256" });
const isPrivateKey = (k: any): k is PrivateJwk => k?.kty === "EC" && k.crv === "P-256" && !!k.d && !!k.kid;
const hostOf = (u: string) => { try { return new URL(u).host; } catch { return u; } };

/** What reading discovery gave: the configuration, or what went wrong. */
type Discovered = { config: any; iss: string; url: string } | { error: ReactNode };

/** The form's fields, as typed. */
interface Fields { iss: string; label: string; clientId: string; scope: string; imaging: string; patient: string; pasted: string }
const EMPTY: Fields = { iss: "", label: "", clientId: "", scope: "", imaging: "", patient: "", pasted: "" };

// Discovery, read the way the viewer reads it: one row per thing the viewer needs, for the way it connects.
type State = "ok" | "warn" | "bad";
const MARK: Record<State, string> = { ok: "✓", warn: "!", bad: "✕" };
function Check({ state, what, children }: { state: State; what: string; children: ReactNode }) {
  return <li data-state={state}><span className={`mark-${state}`} aria-hidden="true">{MARK[state]}</span><div><strong>{what}</strong><span>{children}</span></div></li>;
}
function DiscoveryChecks({ found, how, imagingTyped }: { found: Discovered; how: How; imagingTyped: boolean }) {
  if ("error" in found) return <ul className="checks"><Check state="bad" what="Discovery">{found.error}</Check></ul>;
  const c = found.config;
  const listed = (field: string, value: string) => !c[field] ? "unstated" : c[field].includes(value) ? "yes" : "no";
  const rows: ReactNode[] = [<Check key="d" state="ok" what="Discovery">Read <code>{found.url}</code></Check>];
  if (how !== "backend") {
    rows.push(c.authorization_endpoint ? <Check key="a" state="ok" what="Sign-in">At {hostOf(c.authorization_endpoint)}</Check> : <Check key="a" state="bad" what="Sign-in">No <code>authorization_endpoint</code>.</Check>);
    const pkce = listed("code_challenge_methods_supported", "S256");
    rows.push(pkce === "yes" ? <Check key="p" state="ok" what="PKCE">Offers S256.</Check>
      : pkce === "unstated" ? <Check key="p" state="warn" what="PKCE">Doesn't say. The viewer sends S256 anyway.</Check>
      : <Check key="p" state="bad" what="PKCE">Doesn't offer S256, which the viewer requires.</Check>);
  }
  rows.push(c.token_endpoint ? <Check key="t" state="ok" what="Tokens">At {hostOf(c.token_endpoint)}</Check> : <Check key="t" state="bad" what="Tokens">No <code>token_endpoint</code>.</Check>);
  if (how !== "public") {
    const jwt = listed("token_endpoint_auth_methods_supported", "private_key_jwt"), alg = listed("token_endpoint_auth_signing_alg_values_supported", "ES256");
    rows.push(jwt === "no" ? <Check key="s" state="bad" what="Signed assertions">Doesn't list <code>private_key_jwt</code>.</Check>
      : alg === "no" ? <Check key="s" state="bad" what="Signed assertions">Doesn't accept ES256, the viewer's algorithm.</Check>
      : jwt === "yes" && alg === "yes" ? <Check key="s" state="ok" what="Signed assertions">Accepts <code>private_key_jwt</code> with ES256.</Check>
      : <Check key="s" state="warn" what="Signed assertions">Doesn't say whether it accepts <code>private_key_jwt</code> with ES256.</Check>);
  }
  if (how === "backend") {
    const grant = listed("grant_types_supported", "client_credentials");
    rows.push(grant === "yes" ? <Check key="b" state="ok" what="Backend services">Offers <code>client_credentials</code>.</Check>
      : grant === "unstated" ? <Check key="b" state="warn" what="Backend services">Doesn't list its grant types.</Check>
      : <Check key="b" state="bad" what="Backend services">Doesn't offer <code>client_credentials</code>.</Check>);
  }
  const imaging = imagingOf(c, found.iss, how === "backend" ? BACKEND_CAPABILITY : APP_LAUNCH);
  rows.push(imaging ? <Check key="i" state="ok" what="SMART Imaging">{imaging.unified ? "This server offers it itself." : <>Offered by an associated server at <code>{imaging.url}</code>.</>}</Check>
    : imagingTyped ? <Check key="i" state="warn" what="SMART Imaging">Not advertised, so the viewer uses the imaging server you gave under Advanced.</Check>
    : <Check key="i" state="bad" what="SMART Imaging">Not advertised for {how === "backend" ? "backend services" : "app launch"}, in <code>capabilities</code> or <code>associated_endpoints</code>. If you know the imaging FHIR server, give it under Advanced.</Check>);
  return <ul className="checks">{rows}</ul>;
}

/** Reads a server's discovery from this browser, as the viewer will. */
async function readDiscovery(typed: string): Promise<Discovered> {
  let iss: string;
  try { iss = new URL(typed.trim().replace(/\/$/, "")).toString().replace(/\/$/, ""); } catch { return { error: "Enter the FHIR base URL first, starting with https://." }; }
  const url = `${iss}/.well-known/smart-configuration`;
  try {
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (!r.ok) return { error: <><code>{url}</code> answered HTTP {r.status}. Is the FHIR base right?</> };
    const config = await r.json().catch(() => null);
    return config ? { config, iss, url } : { error: <><code>{url}</code> didn't answer with JSON.</> };
  } catch {
    return { error: <>Couldn't read <code>{url}</code>. Check the address. If it opens in a new tab, your server isn't allowing requests from {location.origin} (CORS), and the viewer needs that too.</> };
  }
}

/** What to register at your server for this way of connecting, and the public key when the viewer signs. */
function RegisterFacts({ how, keyPair }: { how: How; keyPair: PrivateJwk | null }) {
  const signs = how !== "public";
  const facts: [string, string][] = [
    ...(how === "backend" ? [] : [["Redirect URI", VIEWER_URL] as [string, string]]),
    ["Scopes", SCOPES[how]],
    ["Client authentication", signs ? "private_key_jwt, signed with ES256" : "None (a public client using PKCE)"],
    ...(how === "backend" ? [["Grant type", "client_credentials"] as [string, string]] : []),
  ];
  const pub = keyPair && JSON.stringify(publicHalf(keyPair));
  return (
    <dl className="registered-facts" id="register-facts">
      {facts.map(([k, v]) => <Fragment key={k}>
        <dt>{k}</dt><dd><code>{v}</code>{k === "Redirect URI" && <> <CopyButton label="Copy" value={v} aria="Copy redirect URI" /></>}</dd>
      </Fragment>)}
      {signs && keyPair && pub && <>
        <dt>Public key</dt>
        <dd><code className="jwk">{pub}</code> <CopyButton label="Copy JWK" value={pub} /> <CopyButton label="Copy as JWKS" value={JSON.stringify({ keys: [publicHalf(keyPair)] })} /></dd>
      </>}
    </dl>
  );
}

/** The server check, run on one saved server. */
const checkOf = (s: ServerEntry) => `/check?${new URLSearchParams({ server: serverKey(s) })}`;

function Saved({ list, onEdit, onRemove }: { list: ServerEntry[]; onEdit: (s: ServerEntry) => void; onRemove: (s: ServerEntry) => void }) {
  if (!list.length) return <p className="note">None yet. Servers you save here are offered in the viewer, beside your sandboxes.</p>;
  return <>{list.map(s => (
    <article className="panel registered" key={serverKey(s)}>
      <div className="registered-head"><h3>{s.label}</h3></div>
      <dl className="registered-facts">
        <dt>FHIR base</dt><dd><code>{s.iss}</code></dd>
        <dt>Connects as</dt><dd>{HOW_LABEL[howOf(s)]}</dd>
        <dt>Client ID</dt><dd><code>{s.clientId}</code></dd>
        {s.patient && <><dt>Patient</dt><dd><code>{s.patient}</code></dd></>}
        {s.imaging && <><dt>Imaging</dt><dd><code>{s.imaging}</code></dd></>}
      </dl>
      <div className="configure-actions">
        <Link className="button" to={checkOf(s)}>Check it</Link>
        <button type="button" className="secondary" onClick={() => launchViewer(s, { connect: true })}>Open in the viewer</button>
        <button type="button" className="secondary" onClick={() => onEdit(s)}>Edit</button>
        <button type="button" className="tool quiet-danger" aria-label={`Remove ${s.label}`} onClick={() => onRemove(s)}>Remove</button>
      </div>
    </article>
  ))}</>;
}

/** The same list as JSON, to copy into another browser or edit by hand. */
function ServersJson({ list, replaced }: { list: ServerEntry[]; replaced: () => void }) {
  const [text, setText] = useState(""), [status, setStatus] = useState("");
  useEffect(() => setText(JSON.stringify(list, null, 2)), [list]);
  const replace = () => {
    try { const next = parseServers(text || "[]"); saveServers(next); replaced(); setStatus(`Saved ${plural(next.length, "server")} of your own.`); }
    catch (e) { setStatus(`Not saved. ${(e as Error).message}`); }
  };
  return (
    <details className="configure" id="json">
      <summary>Import or export as JSON</summary>
      <p className="note">The same list as JSON, to copy into another browser or edit by hand. Each entry needs <code>label</code>, <code>iss</code> and <code>clientId</code>.</p>
      <label htmlFor="servers-json">Your servers</label>
      <textarea id="servers-json" rows={8} spellCheck={false} autoCapitalize="off" value={text} onChange={e => setText(e.target.value)} />
      <div className="configure-actions"><button type="button" className="secondary" id="servers-save" onClick={replace}>Replace with this</button></div>
      <p className="configure-status" id="servers-status" role="status">{status}</p>
    </details>
  );
}

export default function Servers() {
  const [list, setList] = useState<ServerEntry[]>(savedServers);
  const [fields, setFields] = useState<Fields>(EMPTY);
  const [how, setHow] = useState<How>("public");
  /** The private key the viewer signs with, made here or pasted. */
  const [keyPair, setKeyPair] = useState<PrivateJwk | null>(null);
  /** The saved entry being edited, by its key and name, and whether the name was filled in from the address. */
  const [editing, setEditing] = useState<{ key: string; label: string } | null>(null);
  const [autoLabel, setAutoLabel] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false), [advancedOpen, setAdvancedOpen] = useState(false);
  const [discovered, setDiscovered] = useState<Discovered | null>(null), [checking, setChecking] = useState(false);
  const [error, setError] = useState<string>();
  const reload = () => setList(savedServers());
  // A page brought back with Back shows the list as it is now.
  useEffect(() => {
    const shown = (e: PageTransitionEvent) => { if (e.persisted) { reload(); setChecking(false); } };
    addEventListener("pageshow", shown);
    return () => removeEventListener("pageshow", shown);
  }, []);

  const set = (k: keyof Fields) => (e: { target: { value: string } }) => setFields(f => ({ ...f, [k]: e.target.value }));
  const signs = how !== "public";

  const clearForm = () => {
    setFields(EMPTY); setHow("public"); setKeyPair(null); setEditing(null); setAutoLabel(false);
    setPasteOpen(false); setAdvancedOpen(false); setDiscovered(null); setError(undefined);
  };
  const edit = (s: ServerEntry) => {
    clearForm();
    setEditing({ key: serverKey(s), label: s.label });
    setFields({ ...EMPTY, iss: s.iss, label: s.label, clientId: s.clientId, scope: s.scope ?? "", imaging: s.imaging ?? "", patient: s.patient ?? "" });
    setHow(howOf(s)); setKeyPair(s.jwk ?? null); setAdvancedOpen(!!(s.scope || s.imaging));
    const form = document.getElementById("server-form");
    form?.scrollIntoView({ block: "start" });
    document.getElementById("srv-iss")?.focus({ preventScroll: true });
  };
  const remove = (s: ServerEntry) => {
    saveServers(savedServers().filter(x => serverKey(x) !== serverKey(s)));
    if (editing?.key === serverKey(s)) clearForm();
    reload();
    announce(`Removed ${s.label}.`);
  };

  // A name to start from, from the address, until someone types their own.
  const issChanged = () => {
    if (fields.label.trim() && !autoLabel) return;
    try { const host = new URL(fields.iss.trim()).host; setFields(f => ({ ...f, label: host })); setAutoLabel(true); } catch {}
  };
  const pasteChanged = (text: string) => {
    setFields(f => ({ ...f, pasted: text }));
    try { const k = JSON.parse(text.trim()); if (isPrivateKey(k)) setKeyPair(k); } catch {}
  };
  const generate = async () => {
    setKeyPair((await generateKey()).priv);
    setFields(f => ({ ...f, pasted: "" }));
    announce("Key pair generated.");
  };
  const check = async () => {
    setChecking(true);
    setDiscovered(await readDiscovery(fields.iss));
    setChecking(false);
  };

  /** The form as a server entry, checked. */
  /** The entry the form describes, or what's wrong with it. Only `keep` takes a pasted key as the one to sign with. */
  const entryOfForm = (keep = true): ServerEntry => {
    const v = (k: keyof Fields) => fields[k].trim();
    let jwk = keyPair;
    if (signs && v("pasted") && v("pasted") !== JSON.stringify(jwk)) {
      let k: unknown; try { k = JSON.parse(v("pasted")); } catch { throw new Error("The pasted key isn't valid JSON."); }
      if (!isPrivateKey(k)) throw new Error("The pasted key must be a private EC P-256 JWK (with \"d\") and a \"kid\".");
      jwk = k; if (keep) setKeyPair(k);
    }
    if (signs && !jwk) throw new Error("Generate a key pair, or paste a private key, so the viewer can sign its assertions.");
    if (how === "backend" && !v("patient")) throw new Error("A backend service needs the patient's FHIR id.");
    return checkServer({
      label: v("label"), iss: v("iss"), clientId: v("clientId"),
      ...(v("scope") ? { scope: v("scope") } : {}), ...(v("imaging") ? { imaging: v("imaging") } : {}),
      ...(how === "backend" ? { mode: "backend", jwk, patient: v("patient") } : how === "confidential" ? { auth: "private_key_jwt", jwk } : {}),
    });
  };
  const save = (): ServerEntry | null => {
    setError(undefined);
    try {
      const entry = entryOfForm();
      putServer(entry, editing?.key ?? serverKey(entry));
      clearForm();
      reload();
      announce(`Saved ${entry.label}.`);
      return entry;
    } catch (e) { setError((e as Error).message); return null; }
  };
  const navigate = useNavigate();
  // What the form still needs, worked out as it's filled in: Save stays off, and says why, until there's nothing.
  const missing = (() => { try { entryOfForm(false); return undefined; } catch (e) { return (e as Error).message.replace(/ \("\w+"\)/, ""); } })();
  const saveAndCheck = (e: FormEvent) => { e.preventDefault(); const entry = save(); if (entry) navigate(checkOf(entry)); };

  return (
    <main className="landing servers-page">
      <h1>Your servers</h1>
      <p className="lead">Describe your server once, then check it step by step, or open it in our viewer. The viewer and the server check both use this list.</p>
      <ol className="steps-line" aria-label="Steps">
        <li>Describe your server</li><li>Register the viewer with it</li><li>Check it, step by step</li>
      </ol>

      <form id="server-form" className="panel form" noValidate onSubmit={saveAndCheck}>
        <h2 id="form-title">{editing ? `Edit ${editing.label}` : "Add a server"}</h2>
        <label htmlFor="srv-iss">FHIR base URL</label>
        <div className="inline-field">
          <input type="url" id="srv-iss" required placeholder="https://ehr.example.org/fhir" autoComplete="off" autoCapitalize="off" spellCheck={false} value={fields.iss} onChange={set("iss")} onBlur={issChanged} />
          <button type="button" className="secondary" id="check" disabled={checking} onClick={check}>{checking ? "Checking…" : "Check discovery"}</button>
        </div>
        <p className="note">Where an app starts: the server whose <code>/.well-known/smart-configuration</code> names its sign-in and imaging endpoints.</p>
        {discovered && <div id="discovery" className="discovery" role="status"><DiscoveryChecks found={discovered} how={how} imagingTyped={!!fields.imaging.trim()} /></div>}

        <label htmlFor="srv-label">Name</label>
        <input type="text" id="srv-label" required maxLength={80} placeholder="My test EHR" autoComplete="off" value={fields.label} onChange={e => { set("label")(e); setAutoLabel(false); }} />

        <fieldset className="client-type"><legend>How the viewer connects</legend>
          {HOWS.map(([v, label, what]) => <label key={v}><input type="radio" name="how" value={v} checked={how === v} onChange={() => setHow(v)} /> {label} <span>{what}</span></label>)}
        </fieldset>

        <section className="register-box" aria-labelledby="register-title">
          <h3 id="register-title">Register the viewer with your server</h3>
          <p className="note" id="register-why">Your server needs a client for this viewer. Register it with these details, then enter the client ID it gives you.</p>
          {/* Drawn afresh for each way of connecting: the facts differ, rather than moving. */}
          <RegisterFacts key={how} how={how} keyPair={keyPair} />
          {signs && <div id="key-field">
            <p className="key-state" id="key-state">{keyPair ? `Signing with key ${keyPair.kid}. Register its public half above with your server, as a JWK or in a JWKS it fetches.` : "The viewer needs a key to sign with. Generate one here, then register its public half with your server."}</p>
            <div className="configure-actions">
              <button type="button" className="secondary" id="generate" onClick={generate}>{keyPair ? "Generate a new key pair" : "Generate a key pair"}</button>
              <button type="button" className="tool" id="paste-toggle" aria-expanded={pasteOpen} onClick={() => setPasteOpen(!pasteOpen)}>Paste a private key instead</button>
            </div>
            {pasteOpen && <div id="paste-field">
              <label htmlFor="srv-jwk">Private key (JWK)</label>
              <textarea id="srv-jwk" rows={4} spellCheck={false} autoCapitalize="off" autoFocus placeholder='{"kty":"EC","crv":"P-256","x":"…","y":"…","d":"…","kid":"…"}' value={fields.pasted} onChange={e => pasteChanged(e.target.value)} />
              <p className="note">An ES256 (P-256) key with a <code>kid</code>. It's kept in this browser and used only to sign assertions here, so use a test key.</p>
            </div>}
          </div>}
        </section>

        <label htmlFor="srv-client">Client ID</label>
        <input type="text" id="srv-client" required autoComplete="off" autoCapitalize="off" spellCheck={false} value={fields.clientId} onChange={set("clientId")} />
        <p className="note">What your server gave you when you registered the viewer.</p>

        {how === "backend" && <div id="patient-field">
          <label htmlFor="srv-patient">Patient</label>
          <input type="text" id="srv-patient" placeholder="example-patient-id" autoComplete="off" autoCapitalize="off" spellCheck={false} value={fields.patient} onChange={set("patient")} />
          <p className="note">The FHIR id of the patient whose studies the viewer searches for. No one signs in to choose one.</p>
        </div>}

        <details className="advanced" open={advancedOpen} onToggle={e => setAdvancedOpen(e.currentTarget.open)}>
          <summary>Advanced</summary>
          <label htmlFor="srv-scope">Scope</label>
          <input type="text" id="srv-scope" placeholder={SCOPES[how]} autoComplete="off" autoCapitalize="off" spellCheck={false} value={fields.scope} onChange={set("scope")} />
          <p className="note">Leave empty for the default shown.</p>
          <label htmlFor="srv-imaging">Imaging FHIR server</label>
          <input type="url" id="srv-imaging" placeholder="https://imaging.example.org/fhir" autoComplete="off" autoCapitalize="off" spellCheck={false} value={fields.imaging} onChange={set("imaging")} />
          <p className="note">Only if discovery doesn't name it. The viewer searches <code>ImagingStudy</code> there.</p>
        </details>

        <div className="form-actions">
          <button type="submit" className="primary" id="save-try" disabled={!!missing} aria-describedby="form-missing">Save and check</button>
          <button type="button" className="secondary" id="save" disabled={!!missing} aria-describedby="form-missing" onClick={save}>Save</button>
          {editing && <button type="button" className="tool" id="cancel-edit" onClick={clearForm}>Cancel</button>}
        </div>
        {missing && <p className="form-missing" id="form-missing">Before saving: {missing.replace(/^This server needs/, "it needs")}</p>}
        {error && <p className="error" id="form-error" role="alert">{error}</p>}
      </form>

      <section aria-labelledby="yours"><h2 id="yours">Your servers</h2><div id="saved"><Saved list={list} onEdit={edit} onRemove={remove} /></div></section>

      <ServersJson list={list} replaced={reload} />


      <p className="note agents">Working with an AI agent? Give it <a href="/llms.txt">llms.txt</a>. It describes this page's settings and what the viewer expects from a server, so the agent can work out your server's values, or why discovery fails, with you.</p>
    </main>
  );
}
