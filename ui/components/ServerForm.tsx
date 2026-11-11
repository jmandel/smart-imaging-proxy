// Describing a server of your own for the viewer: its FHIR base, how the viewer signs in, and the client ID it gave
// you. Discovery is checked here, from the browser, the way the viewer itself will read it. Your servers uses this
// form on its own, with the way of connecting among its fields; Build a Server uses it as a step, the way of
// connecting and the client metadata chosen there.
import { useState, type FormEvent, type ReactNode } from "react";
import type { PrivateJwk } from "../lib/api";
import { Choice } from "../lib/format";
import { APP_LAUNCH, BACKEND_CAPABILITY, checkServer, generateKey, imagingOf, type ServerEntry } from "../lib/servers";
import { ClientMetadata, CLIENT_TYPES, SCOPES, type ClientType } from "./ClientMetadata";

export type How = ClientType;
export const HOW_LABEL: Record<How, string> = { public: "Sign-in, public app", confidential: "Sign-in, confidential app", backend: "Backend service" };
/** The way a saved server connects, as the form names it. */
export const howOf = (s: ServerEntry): How => s.mode === "backend" ? "backend" : s.auth === "private_key_jwt" ? "confidential" : "public";
export const isPrivateKey = (k: any): k is PrivateJwk => k?.kty === "EC" && k.crv === "P-256" && !!k.d && !!k.kid;
const hostOf = (u: string) => { try { return new URL(u).host; } catch { return u; } };

/** What reading discovery gave: the configuration, or what went wrong. */
export type Discovered = { config: any; iss: string; url: string } | { error: ReactNode };

/** The form's fields, as typed. */
interface Fields { iss: string; label: string; clientId: string; scope: string; imaging: string; patient: string; pasted: string }
const EMPTY: Fields = { iss: "", label: "", clientId: "", scope: "", imaging: "", patient: "", pasted: "" };
const fieldsOf = (s?: ServerEntry): Fields => s
  ? { iss: s.iss, label: s.label, clientId: s.clientId, scope: s.scope ?? "", imaging: s.imaging ?? "", patient: s.patient ?? "", pasted: "" }
  : EMPTY;

// Discovery, read the way the viewer reads it: one row per thing the viewer needs, for the way it connects.
type State = "ok" | "warn" | "bad";
const MARK: Record<State, string> = { ok: "✓", warn: "!", bad: "✕" };
function Check({ state, what, children }: { state: State; what: string; children: ReactNode }) {
  return <li data-state={state}><span className={`mark-${state}`} aria-hidden="true">{MARK[state]}</span><div><strong>{what}</strong><span>{children}</span></div></li>;
}
export function DiscoveryChecks({ found, how, imagingTyped }: { found: Discovered; how: How; imagingTyped: boolean }) {
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
export async function readDiscovery(typed: string): Promise<Discovered> {
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

export interface ServerFormProps {
  /** The way the viewer connects. Shown among the fields unless a step above chose it. */
  how: How;
  onHow?: (h: How) => void;
  /** The private key the viewer signs with, made here or pasted. */
  keyPair: PrivateJwk | null;
  onKeyPair: (k: PrivateJwk | null) => void;
  /** A saved server being edited: the fields start from it. Pass a new `key` to remount for another. */
  editing?: ServerEntry;
  /** The way-of-connecting radios, and the register-the-viewer box. Off in Build a Server, whose first step did that. */
  withRegister?: boolean;
  /** The key the viewer signs with, on its own: off with the register box, on in Build a Server, whose first step made it. */
  withKey?: boolean;
  title: ReactNode;
  /** What the primary button says. It saves the server, and answers `"check"`. */
  primary?: string;
  /** A plain Save beside it, which answers `"save"`. */
  withSave?: boolean;
  onSaved: (entry: ServerEntry, action: "check" | "save") => void;
  onCancel?: () => void;
}

export function ServerForm({ how, onHow, keyPair, onKeyPair, editing, withRegister = true, withKey = withRegister, title, primary = "Save and check", withSave = true, onSaved, onCancel }: ServerFormProps) {
  const [fields, setFields] = useState<Fields>(() => fieldsOf(editing));
  const [autoLabel, setAutoLabel] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(!!(editing?.scope || editing?.imaging));
  const [discovered, setDiscovered] = useState<Discovered | null>(null), [checking, setChecking] = useState(false);
  const [error, setError] = useState<string>();
  const set = (k: keyof Fields) => (e: { target: { value: string } }) => setFields(f => ({ ...f, [k]: e.target.value }));
  const signs = how !== "public";

  // A name to start from, from the address, until someone types their own.
  const issChanged = () => {
    if (fields.label.trim() && !autoLabel) return;
    try { const host = new URL(fields.iss.trim()).host; setFields(f => ({ ...f, label: host })); setAutoLabel(true); } catch {}
  };
  const pasteChanged = (text: string) => {
    setFields(f => ({ ...f, pasted: text }));
    try { const k = JSON.parse(text.trim()); if (isPrivateKey(k)) onKeyPair(k); } catch {}
  };
  const generate = async () => {
    onKeyPair((await generateKey()).priv);
    setFields(f => ({ ...f, pasted: "" }));
  };
  const check = async () => {
    setChecking(true);
    setDiscovered(await readDiscovery(fields.iss));
    setChecking(false);
  };

  /** The entry the form describes, or what's wrong with it. `keep` takes a pasted key as the one to sign with. */
  const entryOfForm = (keep = true): ServerEntry => {
    const v = (k: keyof Fields) => fields[k].trim();
    let jwk = keyPair;
    if (signs && v("pasted") && v("pasted") !== JSON.stringify(jwk)) {
      let k: unknown; try { k = JSON.parse(v("pasted")); } catch { throw new Error("The pasted key isn't valid JSON."); }
      if (!isPrivateKey(k)) throw new Error("The pasted key must be a private EC P-256 JWK (with \"d\") and a \"kid\".");
      jwk = k; if (keep) onKeyPair(k);
    }
    if (signs && !jwk) throw new Error("Generate a key pair, or paste a private key, so the viewer can sign its assertions.");
    if (how === "backend" && !v("patient")) throw new Error("A backend service needs the patient's FHIR id.");
    return checkServer({
      label: v("label"), iss: v("iss"), clientId: v("clientId"),
      ...(v("scope") ? { scope: v("scope") } : {}), ...(v("imaging") ? { imaging: v("imaging") } : {}),
      ...(how === "backend" ? { mode: "backend", jwk, patient: v("patient") } : how === "confidential" ? { auth: "private_key_jwt", jwk } : {}),
    });
  };
  const submit = (action: "check" | "save") => (e?: FormEvent) => {
    e?.preventDefault();
    setError(undefined);
    try { onSaved(entryOfForm(), action); }
    catch (x) { setError((x as Error).message); }
  };
  // What the form still needs, worked out as it's filled in: Save stays off, and says why, until there's nothing.
  const missing = (() => { try { entryOfForm(false); return undefined; } catch (e) { return (e as Error).message.replace(/ \("\w+"\)/, ""); } })();
  /** The key the viewer signs with: made here, or pasted, and which key it is. */
  const keyField = <div id="key-field">
    <p className="key-state" id="key-state">{keyPair ? <>Signing with key <code>{keyPair.kid}</code>, kept in this browser. This site serves its public half at the <code>jwks_uri</code> in the metadata, or register it as the <code>jwks</code> itself.</> : "The viewer needs a key to sign with. Generate one here, and its public half joins the metadata."}</p>
    <div className="configure-actions">
      <button type="button" className="secondary" id="generate" onClick={generate}>{keyPair ? "Generate a new key pair" : "Generate a key pair"}</button>
      <button type="button" className="tool" id="paste-toggle" aria-expanded={pasteOpen} onClick={() => setPasteOpen(!pasteOpen)}>Paste a private key instead</button>
    </div>
    {pasteOpen && <div id="paste-field">
      <label htmlFor="srv-jwk">Private key (JWK)</label>
      <textarea id="srv-jwk" rows={4} spellCheck={false} autoCapitalize="off" autoFocus placeholder='{"kty":"EC","crv":"P-256","x":"…","y":"…","d":"…","kid":"…"}' value={fields.pasted} onChange={e => pasteChanged(e.target.value)} />
      <p className="note">An ES256 (P-256) key with a <code>kid</code>. It's kept in this browser and used only to sign assertions here, so use a test key.</p>
    </div>}
  </div>;

  return (
    <form id="server-form" className="panel form" noValidate onSubmit={submit("check")}>
      <h2 id="form-title">{title}</h2>
      <label htmlFor="srv-iss">FHIR base URL</label>
      <div className="inline-field">
        <input type="url" id="srv-iss" required placeholder="https://ehr.example.org/fhir" autoComplete="off" autoCapitalize="off" spellCheck={false} value={fields.iss} onChange={set("iss")} onBlur={issChanged} />
        <button type="button" className="secondary" id="check" disabled={checking} onClick={check}>{checking ? "Checking…" : "Check discovery"}</button>
      </div>
      <p className="note">Where an app starts: the server whose <code>/.well-known/smart-configuration</code> names its sign-in and imaging endpoints.</p>
      {discovered && <div id="discovery" className="discovery" role="status"><DiscoveryChecks found={discovered} how={how} imagingTyped={!!fields.imaging.trim()} /></div>}

      <label htmlFor="srv-label">Name</label>
      <input type="text" id="srv-label" required maxLength={80} placeholder="My test EHR" autoComplete="off" value={fields.label} onChange={e => { set("label")(e); setAutoLabel(false); }} />

      {withRegister && <>
        <fieldset className="client-type"><legend>How the viewer connects</legend>
          {CLIENT_TYPES.map(([v, label, what]) => <Choice key={v} type="radio" name="how" value={v} checked={how === v} onChange={() => onHow?.(v)} label={label} detail={what} />)}
        </fieldset>

        <section className="register-box" aria-labelledby="register-title">
          <h3 id="register-title">Register the viewer with your server</h3>
          <p className="note" id="register-why">Your server needs a client for this viewer. Register one with these details, in its admin console or by posting the JSON to its dynamic registration, then enter the client ID it gives you below.</p>
          <ClientMetadata type={how} keyPair={keyPair} scope={fields.scope.trim()} />
          {signs && keyField}
        </section>
      </>}

      {!withRegister && withKey && signs && <section className="register-box" aria-labelledby="key-title">
        <h3 id="key-title">The key the viewer signs with</h3>
        <p className="note">The metadata from the last step held this key's public half. Paste the private key you registered, if it isn't this one.</p>
        {keyField}
      </section>}

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
        <button type="submit" className="primary" id="save-try" disabled={!!missing} aria-describedby="form-missing">{primary}</button>
        {withSave && <button type="button" className="secondary" id="save" disabled={!!missing} aria-describedby="form-missing" onClick={submit("save")}>Save</button>}
        {onCancel && <button type="button" className="tool" id="cancel-edit" onClick={onCancel}>Cancel</button>}
      </div>
      {missing && <p className="form-missing" id="form-missing">Before saving: {missing.replace(/^This server needs/, "it needs")}</p>}
      {error && <p className="error" id="form-error" role="alert">{error}</p>}
    </form>
  );
}
