// Describing servers of your own for the viewer: what each is, how the viewer signs in, and what to register there.
// The list stays in this browser; adding or editing is a step away, in the address (?add, ?edit=), and with none
// saved the page is the form. Build a Server walks through the same form a step at a time.
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { launchViewer } from "../lib/launch";
import type { PrivateJwk } from "../lib/api";
import { announce, plural } from "../lib/format";
import { parseServers, putServer, savedServers, saveServers, serverKey, type ServerEntry } from "../lib/servers";
import { HOW_LABEL, howOf, ServerForm, type How } from "../components/ServerForm";

/** The server check, run on one saved server. */
const checkOf = (s: ServerEntry) => `/check?${new URLSearchParams({ server: serverKey(s) })}`;
/** The way of connecting a `?how=` names, or the default. */
const howNamed = (named: string | null): How => named === "confidential" || named === "backend" ? named : "public";

function Saved({ list, onEdit, onRemove }: { list: ServerEntry[]; onEdit: (s: ServerEntry) => void; onRemove: (s: ServerEntry) => void }) {
  return <ul className="server-rows">{list.map(s => (
    <li key={serverKey(s)}>
      <div className="server-row-what">
        <h3>{s.label}</h3>
        <p><code>{s.iss}</code></p>
        <p className="note">{HOW_LABEL[howOf(s)]}, client ID <code>{s.clientId}</code>{s.patient ? <>, patient <code>{s.patient}</code></> : null}</p>
      </div>
      <div className="server-row-actions">
        <Link className="button" to={checkOf(s)}>Check it</Link>
        <button type="button" className="secondary" onClick={() => launchViewer(s, { connect: true })}>Open in the viewer</button>
        <button type="button" className="tool" onClick={() => onEdit(s)} aria-label={`Edit ${s.label}`}>Edit</button>
        <button type="button" className="tool quiet-danger" aria-label={`Remove ${s.label}`} onClick={() => onRemove(s)}>Remove</button>
      </div>
    </li>
  ))}</ul>;
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
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const editKey = params.get("edit"), named = params.get("how");
  /** The saved entry being edited. */
  const editing = editKey ? list.find(x => serverKey(x) === editKey) : undefined;
  const [how, setHow] = useState<How>(howNamed(named));
  /** The private key the viewer signs with, made here or pasted. */
  const [keyPair, setKeyPair] = useState<PrivateJwk | null>(null);
  const reload = () => setList(savedServers());
  // A page brought back with Back shows the list as it is now.
  useEffect(() => {
    const shown = (e: PageTransitionEvent) => { if (e.persisted) reload(); };
    addEventListener("pageshow", shown);
    return () => removeEventListener("pageshow", shown);
  }, []);
  // The form follows the address: an edit link, Back, or a reload fills it from the saved entry.
  useEffect(() => { setHow(editing ? howOf(editing) : howNamed(named)); }, [editKey, named]);
  // A saved server's own key goes with it. A key made or pasted here stays while the way of connecting changes.
  useEffect(() => { setKeyPair(editing?.jwk ?? null); }, [editKey]);
  // A new server's way of connecting is in the address too (?add&how=), so a link opens the form set to it.
  const choose = (v: How) => {
    setHow(v);
    // `?add` stays bare: URLSearchParams would write `add=`.
    if (editKey) return;
    const q = new URLSearchParams(location.search);
    if (v === "public") q.delete("how"); else q.set("how", v);
    navigate(`?${q}`.replace(/([?&])add=(?=&|$)/, "$1add"), { replace: true, preventScrollReset: true });
  };
  const remove = (s: ServerEntry) => {
    saveServers(savedServers().filter(x => serverKey(x) !== serverKey(s)));
    if (editKey === serverKey(s)) setParams({});
    reload();
    announce(`Removed ${s.label}.`);
  };
  /** Saves the form's server in place of the one it edits, then goes on to the check or back to the list. */
  const saved = (entry: ServerEntry, action: "check" | "save") => {
    putServer(entry, editing ? serverKey(editing) : serverKey(entry));
    reload();
    announce(`Saved ${entry.label}.`);
    if (action === "check") navigate(checkOf(entry)); else setParams({});
  };
  const toList = () => setParams({});

  const showForm = !list.length || params.has("add") || !!editing;
  return (
    <main className="landing servers-page">
      <div className="your-sandboxes-head">
        <h1>Your servers</h1>
        {list.length > 0 && !showForm && <Link className="button" id="add-server" to="?add">Add a server</Link>}
      </div>
      <p className="lead">The servers you test, kept in this browser. Check one step by step, or open it in our viewer: both use this list.</p>
      {editKey && !editing && <p className="error" role="alert">There's no saved server <code>{editKey}</code> to edit.</p>}

      {!showForm && <section aria-label="Saved servers" id="saved"><Saved list={list} onEdit={s => { setParams({ edit: serverKey(s) }); window.scrollTo(0, 0); }} onRemove={remove} /></section>}

      {showForm && <ServerForm
        key={editKey ?? "new"}
        title={editing ? `Edit ${editing.label}` : list.length ? "Add a server" : "Add your first server"}
        how={how} onHow={choose}
        keyPair={keyPair} onKeyPair={setKeyPair}
        editing={editing}
        onSaved={saved}
        onCancel={list.length > 0 ? toList : undefined}
      />}

      {(!showForm || !list.length) && <ServersJson list={list} replaced={reload} />}

      <p className="note agents">Working with an AI agent? Give it <a href="/llms.txt">llms.txt</a>. It describes this page's settings and what the viewer expects from a server, so the agent can work out your server's values, or why discovery fails, with you.</p>
    </main>
  );
}
