// The site's home: who you are, a guide for each, and the sandboxes this browser has made or joined.
import { useEffect, useState } from "react";
import { sandboxName } from "../lib/api";
import { createSandbox, knownSandboxes, saveSandboxes, useSandboxes } from "../lib/store";
import { MENU, PAGES } from "../sitemap";
import { PageLink } from "../shell/Shell";

export default function Home() {
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
      <h1>{PAGES.home.name}</h1>
      <p className="lead">A public sandbox and test client for the SMART Imaging Access guide: one sign-in that gives an app a patient's records and their medical images.</p>
      <ul className="link-list jobs">
        {MENU.map(id => <li key={id}><PageLink id={id} /><span>{PAGES[id].blurb}</span></li>)}
      </ul>
      <p className="note agents">Working with an AI agent? Give it <a href="/llms.txt">llms.txt</a>. It describes everything here, and its API.</p>
      <section className="your-sandboxes" aria-labelledby="h-sandboxes">
        <h2 id="h-sandboxes">Your sandboxes</h2>
        <p className="note">A sandbox is a private copy of the health system. What you do in one stays there until you delete it, and you can share one by its link.</p>
        <ul className="sandbox-list" id="sandbox-list">
          {list.length ? list.map(w => <li key={w.base}><a href={`${w.base}/`}><strong>{w.name ?? "Sandbox"}</strong><span>{w.joined ? "Shared with you" : "Made in this browser"}</span></a></li>)
            : <li className="none">You don't have any yet.</li>}
        </ul>
        <button type="button" className="secondary" id="create" disabled={creating} onClick={create}>Create a sandbox</button>
        {error && <p className="error" id="create-error" role="alert">{error}</p>}
      </section>
    </main>
  );
}
