// A sandbox's home: its name, sharing, and its pages by what they're for. A browser that hasn't joined it is
// asked first.
import { useEffect, useState } from "react";
import { api, BASE, sandboxName } from "../lib/api";
import { knownSandboxes, renameSandbox, saveSandboxes, session, useSandboxes } from "../lib/store";
import { VIEWER_SESSION } from "../lib/servers";
import { PAGES, SANDBOX_GROUPS } from "../sitemap";
import { PageLink } from "../shell/Shell";

export default function SandboxHome() {
  const shareLink = `${location.origin}${BASE}/`;
  const mine = useSandboxes().find(w => w.base === BASE);
  // What the server says: its name, `null` when it's gone, `undefined` while asking or when it can't be reached.
  const [name, setName] = useState<string | null | undefined>(), [asked, setAsked] = useState(false);
  const [sharing, setSharing] = useState(false), [shareNote, setShareNote] = useState("Anyone with this link can see and change this sandbox.");
  useEffect(() => { sandboxName(BASE).then(n => { setName(n); setAsked(true); }); }, []);
  if (!asked) return <main id="landing" className="landing overview"><section className="sandbox panel" id="sandbox"><p className="note">Loading…</p></section></main>;
  if (name === null || name === undefined) return (
    <main id="landing" className="landing overview">
      <section className="sandbox panel" id="sandbox">
        <p className="error">{name === null ? "This sandbox doesn't exist any more." : "This sandbox couldn't be reached. Reload to try again."}</p>
        <p><a href="/sandboxes">Your sandboxes</a></p>
      </section>
    </main>
  );
  const shown = mine?.name ?? name;
  const rename = async () => {
    const next = prompt("Name this sandbox", shown);
    if (next === null || !next.trim()) return;
    await renameSandbox(BASE, next);
    setName(next);
  };
  const share = async () => {
    setSharing(true);
    if (navigator.share) { try { await navigator.share({ title: `SMART Imaging sandbox: ${shown}`, url: shareLink }); return; } catch (e) { if ((e as Error).name === "AbortError") return; } }
    try { await navigator.clipboard.writeText(shareLink); setShareNote("Link copied. Anyone with it can see and change this sandbox."); } catch {}
  };
  const end = async () => {
    if (!mine!.joined && !confirm(`Delete “${shown}” and everything in it? Anyone you shared it with loses it too.`)) return;
    if (!mine!.joined) try { await api("DELETE", "/api/sandbox"); } catch {}
    saveSandboxes(knownSandboxes().filter(w => w.base !== BASE));
    session.set(VIEWER_SESSION, null);
    location.assign("/sandboxes");
  };
  return (
    <main id="landing" className="landing overview">
      <section className="sandbox panel" id="sandbox">
        {mine ? <>
          <div className="sandbox-head"><p className="sandbox-name" id="sandbox-name">{shown}</p><button type="button" className="tool" onClick={rename}>Rename</button></div>
          <div className="sandbox-actions">
            <button type="button" className="tool" onClick={share}>Share</button>
            <a className="tool" href="/sandboxes">All sandboxes</a>
            <button type="button" className="tool quiet-danger" onClick={end}>{mine.joined ? "Leave" : "Delete"}</button>
          </div>
          {sharing && <div id="share-panel"><input type="text" id="share-link" readOnly aria-label="Link to this sandbox" value={shareLink} onFocus={e => e.target.select()} autoFocus /><p className="note" id="share-note">{shareNote}</p></div>}
        </> : <>
          <h2>Join “{name}”?</h2>
          <p className="note">Someone shared this sandbox with you. Anyone with its link can see and change it. It holds sample data only.</p>
          <div className="sandbox-actions"><button type="button" className="primary" onClick={() => saveSandboxes([...knownSandboxes(), { base: BASE, joined: true, name }])}>Join this sandbox</button></div>
        </>}
      </section>
      <div className="sandbox-groups">
        {SANDBOX_GROUPS.map(g => (
          <section key={g.title} aria-label={g.title}>
            <h2>{g.title}</h2>
            <ul className="link-list">{g.pages.map(id => <li key={id}><PageLink id={id} /><span>{id === "viewer" ? "Our SMART app, signed in to this sandbox." : id === "check" ? "Every step of the guide, and the checks only a sandbox can run, against this sandbox." : PAGES[id].blurb}</span></li>)}</ul>
          </section>
        ))}
      </div>
      <p className="note agents">Working with an AI agent? Give it <a href={`${BASE}/llms.txt`}>this sandbox's llms.txt</a>. It explains the whole sandbox and its API.</p>
    </main>
  );
}
