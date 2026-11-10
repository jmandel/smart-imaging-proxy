// My Sandboxes: the sandboxes this browser has made or joined, each checked with the server, and a new one.
import { useEffect, useState } from "react";
import { sandboxName } from "../lib/api";
import { createSandbox, knownSandboxes, saveSandboxes, useSandboxes } from "../lib/store";

export default function Sandboxes() {
  const list = useSandboxes();
  const [creating, setCreating] = useState(false), [error, setError] = useState<string>();
  // Checked against the server: one deleted by whoever made it is gone for everyone; one that couldn't be asked stays.
  useEffect(() => {
    const check = async () => {
      const names = new Map(await Promise.all(knownSandboxes().map(async w => [w.base, await sandboxName(w.base)] as const)));
      // The list as it is now, since one made or joined meanwhile belongs on it.
      saveSandboxes(knownSandboxes().flatMap(w => { const n = names.get(w.base); return n === null ? [] : [n ? { ...w, name: n } : w]; }));
    };
    check();
    // A page brought back by Back shows where things are now.
    const back = (e: PageTransitionEvent) => { if (e.persisted) { setCreating(false); check(); } };
    addEventListener("pageshow", back);
    return () => removeEventListener("pageshow", back);
  }, []);
  const create = async () => {
    setCreating(true); setError(undefined);
    try { location.assign(`${await createSandbox()}/`); } catch (e) { setError((e as Error).message); setCreating(false); }
  };
  return (
    <main id="home" className="landing">
      <div className="your-sandboxes-head">
        <h1>My Sandboxes</h1>
        <button type="button" className="primary" id="create" disabled={creating} onClick={create}>Create a sandbox</button>
      </div>
      <p className="lead">A sandbox is a private copy of a health system's servers. What you do in one stays there until you delete it, and you can share one by its link.</p>
      <ul className="sandbox-list" id="sandbox-list">
        {list.length ? list.map(w => <li key={w.base}><a href={`${w.base}/`}><strong>{w.name ?? "Sandbox"}</strong><span>{w.joined ? "Shared with you" : "Made in this browser"}</span></a></li>)
          : <li className="none">You don't have any yet.</li>}
      </ul>
      {error && <p className="error" id="create-error" role="alert">{error}</p>}
    </main>
  );
}
