// Build a Server: the servers this browser has, and the wizard that adds one. Register a client with your server,
// describe it here, then check every step of the guide against it. The servers are kept in this browser; the wizard's
// step, the way the viewer connects, and the server described are in the address, so Back, Forward and a reload keep
// the place.
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import type { PrivateJwk } from "../lib/api";
import { Address, announce, Choice } from "../lib/format";
import { generateKey, putServer, savedServers, saveServers, serverKey, type ServerEntry } from "../lib/servers";
import { session } from "../lib/store";
import { launchViewer } from "../lib/launch";
import { ClientMetadata, CLIENT_TYPES, type ClientType } from "../components/ClientMetadata";
import { HOW_LABEL, howOf, ServerForm } from "../components/ServerForm";
import { ServerJson } from "../components/ServerJson";
import { CONFORMANCE_PLAN } from "../sitemap";

const STEPS = [
  { id: "register", name: "Register the viewer" },
  { id: "server", name: "Your server" },
  { id: "check", name: "Check it" },
] as const;
type StepId = typeof STEPS[number]["id"];

/** The way of connecting a `?how=` names, or the default. */
const howNamed = (named: string | null): ClientType => CLIENT_TYPES.some(([v]) => v === named) ? named as ClientType : "public";
/** The key made for the client being registered, kept for this tab: a reload mustn't sign with a key the server doesn't know. */
const KEY = "smart-imaging-client:build-a-server:key";
const keptKey = (): PrivateJwk | null => { try { return JSON.parse(session.get(KEY) ?? "null"); } catch { return null; } };
/** The server check, run on one saved server. */
const checkOf = (s: ServerEntry) => `/check?${new URLSearchParams({ server: serverKey(s) })}`;
/** How the viewer connects, in a sentence: what the server has to expect. */
const CONNECTS_AS: Record<ClientType, string> = {
  public: "a public app, with PKCE and no key",
  confidential: "a confidential app, signing its assertions with a key",
  backend: "a backend service, with no one to sign in",
};

/** The servers this browser has: what each is, and what can be done with it. */
function Yours({ list, onEdit, onRemove }: { list: ServerEntry[]; onEdit: (s: ServerEntry) => void; onRemove: (s: ServerEntry) => void }) {
  return <ul className="server-rows">{list.map(s => <li key={serverKey(s)}>
    <div className="server-row-what">
      <h3>{s.label}</h3>
      <p><code>{s.iss}</code></p>
      <p className="note">{HOW_LABEL[howOf(s)]}, client ID <code>{s.clientId}</code>{s.patient ? <>, patient <code>{s.patient}</code></> : null}</p>
    </div>
    <div className="server-row-actions">
      <Link className="button" to={checkOf(s)}>Check it</Link>
      <button type="button" className="secondary" onClick={() => launchViewer(s, { connect: true })}>Open in the viewer</button>
      <button type="button" className="tool" onClick={() => onEdit(s)} aria-label={`Edit ${s.label}`}>Edit</button>
      <button type="button" className="tool quiet-danger" onClick={() => onRemove(s)} aria-label={`Remove ${s.label}`}>Remove</button>
    </div>
  </li>)}</ul>;
}

export default function BuildAServer() {
  const [params, setParams] = useSearchParams();
  const [saved, setSaved] = useState<ServerEntry[]>(savedServers);
  const step: StepId = STEPS.some(s => s.id === params.get("step")) ? params.get("step") as StepId : "register";
  const at = STEPS.findIndex(s => s.id === step);
  // The way of connecting is in the address (?how=), so a link opens the wizard on it.
  const asked = params.get("how"), named = howNamed(asked);
  // Held here as well, so the radio changes as it's pressed, before the address catches up.
  const [how, setHow] = useState(named);
  useEffect(() => setHow(named), [named]);
  /** The private key the viewer signs with, made here once, whether the way was chosen on the page or by the link. */
  const [key, held] = useState<PrivateJwk | null>(keptKey);
  const setKey = (k: PrivateJwk | null) => { held(k); session.set(KEY, k ? JSON.stringify(k) : null); };
  useEffect(() => { if (how !== "public" && !key) generateKey().then(k => setKey(k.priv)); }, [how]);
  // The server described, once it's saved: named in the address, so Back from the check finds it again.
  const entry = saved.find(s => serverKey(s) === params.get("server"));
  const reload = () => setSaved(savedServers());
  const choose = (t: ClientType) => {
    setHow(t);
    const q = new URLSearchParams(params);
    if (t === "public") q.delete("how"); else q.set("how", t);
    setParams(q, { replace: true, preventScrollReset: true });
  };
  // A step in the address is what opens the wizard, so every step is written, the first included.
  const go = (id: StepId, server?: string) => setParams(p => {
    const q = new URLSearchParams(p);
    q.set("step", id);
    if (server) q.set("server", server); else q.delete("server");
    return q;
  });
  /** Whether the wizard shows: always when there's nothing described yet, and otherwise when a step is asked for. */
  const wizard = saved.length === 0 || params.has("step") || params.has("how") || params.has("server");
  /** Opens the wizard below the list, at its first step, for another server. */
  const addAnother = () => { setKey(null); go("register"); };
  /** Back to the servers described, with the wizard closed. */
  const close = () => setParams({});
  const remove = (s: ServerEntry) => {
    saveServers(savedServers().filter(x => serverKey(x) !== serverKey(s)));
    if (params.get("server") === serverKey(s)) go("register");
    reload();
    announce(`Removed ${s.label}.`);
  };
  // A step that needs the server described can't be reached until it is.
  const reachable = (id: StepId) => id !== "check" || !!entry;
  // A server already described knows its own way of connecting, whatever the address says.
  const shownHow = entry ? howOf(entry) : how;

  return (
    <main className="landing guide wizard">
      <h1>Build an imaging server</h1>
      <p className="lead">Connect our viewer, a known-good SMART Imaging app, to your server: register a client with it, describe it here, then check every step of the guide against it. When something fails, you'll know it's the server, not the app.</p>

      {saved.length > 0 && <section className="panel your-servers" aria-labelledby="h-yours">
        <h2 id="h-yours">Your servers</h2>
        <p className="note">Described already, and kept in this browser: check one, open it in the viewer, or change it.</p>
        <Yours list={saved} onEdit={s => go("server", serverKey(s))} onRemove={remove} />
        <button type="button" className="add-server" id="add-server" aria-expanded={wizard} onClick={wizard ? close : addAnother}>{wizard ? "Hide" : "Add another server"}</button>
      </section>}

      {wizard && <>
      <ol className="wizard-steps" aria-label="Steps">
        {STEPS.map((s, i) => (
          <li key={s.id} aria-current={s.id === step ? "step" : undefined} className={i < at ? "done" : undefined}>
            {reachable(s.id) && s.id !== step ? <Link to={`?${new URLSearchParams({ step: s.id, ...(asked ? { how: asked } : {}), ...(entry ? { server: serverKey(entry) } : {}) })}`}>{s.name}</Link> : <span>{s.name}</span>}
          </li>
        ))}
      </ol>

      <section className="wizard-step" aria-labelledby="wizard-title">
        {step === "register" && <>
          <h2 id="wizard-title">{saved.length ? "Add a server" : "Register the viewer with your server"}</h2>
          <p>Your server needs a client for our viewer. Register one in its admin console, or by posting the JSON to its dynamic registration, then note the client ID it gives you.</p>
          <fieldset className="client-type"><legend>How the viewer connects</legend>
            {CLIENT_TYPES.map(([v, label, what]) => <Choice key={v} type="radio" name="guide-how" value={v} checked={how === v} onChange={() => choose(v)} label={label} detail={what} />)}
          </fieldset>
          <ClientMetadata type={how} keyPair={key} />
          {how !== "public" && key && <p className="note">The viewer signs its assertions with key <code>{key.kid}</code>, made in this browser just now; the private half stays here. Your server checks them against the public half, which this site serves at the <code>jwks_uri</code>, or which you can register as the <code>jwks</code> itself.</p>}
          <h3>What your server needs</h3>
          <ul className="how">
            <li><strong>CORS</strong> for <code>{location.origin}</code> on discovery, the token endpoint, FHIR searches and image retrieval. The viewer runs in the browser.</li>
            <li><strong>Discovery</strong> that names SMART Imaging by capability: <code>smart-imaging-access</code> with the {how === "backend" ? "backend services" : "app-launch"} capability, at the top level or on an entry in <code>associated_endpoints</code>.</li>
            <li><strong>ImagingStudy search</strong> by <code>patient</code>, with <code>_include=ImagingStudy:endpoint</code> and <code>next</code> links.</li>
            <li><strong>WADO-RS</strong> at each study's <code>Endpoint.address</code>, accepting the token, and <code>503</code> with <code>Retry-After</code> while images are prepared.</li>
          </ul>
        </>}

        {step === "server" && <>
          <h2 id="wizard-title">{entry ? `Edit ${entry.label}` : "Describe your server"}</h2>
          <p>The viewer connects as {CONNECTS_AS[shownHow]}. Changing that is the first step, in the row above.</p>
          <ServerForm
            key={entry ? serverKey(entry) : "new"}
            title="The server"
            how={shownHow}
            keyPair={key ?? entry?.jwk ?? null} onKeyPair={setKey}
            editing={entry}
            withRegister={false} withKey
            onCancel={saved.length ? close : undefined}
            onSaved={(form, action) => {
              putServer(form, entry ? serverKey(entry) : serverKey(form));
              // The key is the server's own now: kept with it in Your servers, not as this tab's pending one.
              setKey(null);
              reload();
              if (action === "check") go("check", serverKey(form)); else close();
            }}
          />
        </>}

        {step === "check" && entry && <>
          <h2 id="wizard-title">Check {entry.label}</h2>
          <p>The server check runs every step of the guide against it, as far as it can on its own, and says where it stopped and why: each request, its answer, and what a failure usually means.</p>
          <dl className="addresses">
            <div className="address"><dt>FHIR base</dt><dd><Address value={entry.iss} name="FHIR base" /></dd></div>
            <div className="address"><dt>Client ID</dt><dd><Address value={entry.clientId} name="client ID" /></dd></div>
            <div className="address"><dt>Connects as</dt><dd>{HOW_LABEL[shownHow]}</dd></div>
          </dl>
          <p className="wizard-actions">
            <Link className="button" id="run-check" to={checkOf(entry)}>Run the check</Link>
            <a href={CONFORMANCE_PLAN} target="_blank" rel="noopener">Ideas for more checks, on GitHub</a>
          </p>
        </>}

        {step === "check" && !entry && <>
          <h2 id="wizard-title">Check it</h2>
          <p>There's no server described yet. Describe it first, and the check runs against that.</p>
        </>}
      </section>

      <div className="wizard-nav">
        {at > 0 && <button type="button" className="secondary" onClick={() => go(STEPS[at - 1]!.id, entry ? serverKey(entry) : undefined)}>Back</button>}
        {step === "register" && saved.length > 0 && <button type="button" className="tool" onClick={close}>Cancel</button>}
        {step === "register" && <button type="button" className="primary" onClick={() => go("server")}>I've registered it</button>}
        {step === "check" && !entry && <button type="button" className="primary" onClick={() => go("server")}>Describe your server</button>}
      </div>
      </>}

      <section aria-labelledby="h-json">
        <h2 id="h-json" className="sr-only">This browser's servers, as data</h2>
        <ServerJson list={saved} replaced={reload} />
      </section>

      <p className="note agents">Working with an AI agent? Give it <a href="/llms.txt">llms.txt</a>. Everything on this page has an API, and it's all described there.</p>
    </main>
  );
}
