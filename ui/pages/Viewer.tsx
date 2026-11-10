// The viewer: our general SMART app. A standalone SMART App Launch against one of your sandboxes or a server you
// added, then its clinical and imaging data with one token, and every step of the protocol as it happens. The
// sign-in opens in a tab of its own, which hands its address back (main.tsx), so this tab never leaves the app.
import { useEffect, useState } from "react";
import { CHOICE_KEY, savedServers, sandboxServer, serverKey, type ServerEntry } from "../lib/servers";
import { store, stored, useSandboxes } from "../lib/store";
import { connectBackend, finishSignIn, signInAddress, signInReturn } from "../viewer/connect";
import { forget, saved, type Session } from "../viewer/session";
import { Trail } from "../viewer/trail";
import { Workspace } from "../viewer/Workspace";
import { PageLink } from "../shell/Shell";

interface Choice extends ServerEntry { id: string; detail: string }
/** Your sandboxes, then the servers you added. One you added by hand stands in for the sandbox it names. */
function useServers(): Choice[] {
  const sandboxes = useSandboxes();
  const added = savedServers().map(s => ({ ...s, id: serverKey(s), detail: new URL(s.iss).host })), ids = new Set(added.map(s => s.id));
  const yours = sandboxes.map(w => sandboxServer(w.base, w.name)).map(s => ({ ...s, id: serverKey(s), detail: "Your sandbox of sample patients" }));
  return [...yours.filter(s => !ids.has(s.id)), ...added];
}
/** A sign-in that had to happen in this tab, handed back to this address. */
const returned = () => { const q = new URLSearchParams(location.search); return q.has("code") || q.has("error") ? q : undefined; };

type Phase = "landing" | "connecting" | "app";

export default function Viewer() {
  const servers = useServers();
  const [choice, setChoice] = useState(() => stored(CHOICE_KEY));
  const chosen = servers.find(s => s.id === choice) ?? servers[0];
  // Decided before the first paint: a tab that's connected, or finishing a sign-in, never shows the Connect form.
  const [session, setSession] = useState<Session | undefined>(() => returned() ? undefined : saved().session);
  const [phase, setPhase] = useState<Phase>(() => session ? "app" : returned() ? "connecting" : "landing");
  const [trail, setTrail] = useState(() => new Trail(saved().trail ?? []));
  const [error, setError] = useState<string>();

  const failed = (e: unknown) => { setPhase("landing"); setError((e as Error).message); };
  const connected = (s: Session) => { setSession(s); setPhase("app"); };

  useEffect(() => {
    const params = returned();
    if (params) {
      // The viewer's address is left clean, without the code. The router isn't told, so the page isn't drawn afresh.
      history.replaceState(history.state, "", "/viewer");
      finishSignIn(trail, params).then(connected, failed);
    }
    // A page brought back by Back is as it was left, perhaps "Connecting…" while a sign-in tab was open.
    const shown = (e: PageTransitionEvent) => { if (e.persisted && !saved().session) setPhase("landing"); };
    addEventListener("pageshow", shown);
    return () => removeEventListener("pageshow", shown);
  }, []);

  const connect = async () => {
    const server = chosen!;
    // A person signs in in a tab of its own, so this one never leaves the viewer. It opens from the click itself.
    const tab = server.mode === "backend" ? null : open("about:blank", "smart-imaging-sign-in");
    setError(undefined);
    setPhase("connecting");
    try {
      if (server.mode === "backend") { connected(await connectBackend(trail, server)); return; }
      const { url, state } = await signInAddress(trail, server);
      // A browser that blocks the tab: the sign-in happens here instead, and comes back to the viewer.
      if (!tab) { location.assign(url); return; }
      tab.location.href = url.toString();
      connected(await finishSignIn(trail, await signInReturn(tab, state)));
    } catch (e) {
      tab?.close();
      failed(e);
    }
  };
  const disconnect = () => {
    trail.end();
    forget();
    setSession(undefined);
    setTrail(new Trail());
    setPhase("landing");
  };

  if (phase === "connecting") return <p className="connecting-note shown" id="connecting" role="status">Connecting…</p>;
  if (phase === "app" && session) return <Workspace session={session} trail={trail} disconnect={disconnect} />;
  return (
    <main id="landing" className="landing viewer-connect">
      <h1>Viewer</h1>
      <p className="lead">Our SMART Imaging app. Connect it to one of your sandboxes, or to a server of your own, and watch each step of the protocol as it happens. Signing in opens a tab of its own.</p>
      <section className="path panel" id="try" aria-label="Connect">
        <fieldset className="server-choice"><legend>Connect to</legend>
          <div id="servers">
            {chosen ? servers.map(s => (
              <label className="server" key={s.id}>
                <input type="radio" name="server" value={s.id} checked={s.id === chosen.id} onChange={() => { store(CHOICE_KEY, s.id); setChoice(s.id); }} />
                <strong>{s.label}</strong><span>{s.detail}</span>
              </label>
            )) : <p className="note">No servers yet. <PageLink id="home">Create a sandbox</PageLink>, or add a server of your own.</p>}
          </div>
        </fieldset>
        <div className="connect-actions"><button type="button" className="primary" id="connect" disabled={!chosen} onClick={connect}>Connect</button></div>
        {error && <p className="error" id="connect-error" role="alert">{error}</p>}
        <p className="note">Add or change servers in <PageLink id="servers" />.</p>
      </section>
    </main>
  );
}
