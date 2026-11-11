// The servers this browser has, as JSON: to copy into another browser, or to edit by hand.
import { useEffect, useState } from "react";
import { plural } from "../lib/format";
import { parseServers, saveServers, type ServerEntry } from "../lib/servers";

export function ServerJson({ list, replaced }: { list: ServerEntry[]; replaced: () => void }) {
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
