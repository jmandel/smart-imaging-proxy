// The viewer: our general SMART app. A standalone SMART App Launch against one of your sandboxes or a server you
// added, then its clinical and imaging data with one token, and every step of the protocol as it happens. The
// sign-in opens in a tab of its own, which hands its address back (main.tsx), so this tab never leaves the app.
// It's a sandbox's own page (/s/{id}/viewer), so the sandbox's bar stays around it, and the site's at /viewer for
// servers of your own. The server chosen is in the address (?sandbox= or ?server=), and with `connect` it signs in
// at once.
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { BASE } from "../lib/api";
import { takeSignInTab } from "../lib/launch";
import { Choice as Option } from "../lib/format";
import { useReady } from "../lib/ready";
import { CHOICE_KEY, sandboxServer, serverKey, serverQuery, useServers, type ServerChoice as Choice } from "../lib/servers";
import { store, stored, useSandboxes } from "../lib/store";
import { connectBackend, finishSignIn, signInAddress, signInReturn } from "../viewer/connect";
import { forget, saved, type Session } from "../viewer/session";
import { Trail, useSteps } from "../viewer/trail";
import { Protocol } from "../viewer/Protocol";
import { Workspace } from "../viewer/Workspace";
import { PageLink } from "../shell/Shell";

/** A sign-in that had to happen in this tab, handed back to this address. */
const returned = () => { const q = new URLSearchParams(location.search); return q.has("code") || q.has("error") ? q : undefined; };

type Phase = "landing" | "connecting" | "app";

export default function Viewer() {
  const known = useServers(), sandboxes = useSandboxes();
  const [params, setParams] = useSearchParams();
  // The server the address names: a sandbox's link opens it, known in this browser or not; a server of your own
  // only where this browser has it. A sandbox's own viewer starts on that sandbox.
  const base = params.get("sandbox") ?? (BASE || null), wanted = params.get("server");
  const onSandbox: Choice | undefined = base !== null && /^(\/s\/[A-Za-z0-9_-]+)?$/.test(base)
    ? (s => ({ ...s, id: serverKey(s), detail: "Your sandbox of sample patients" }))(sandboxServer(base, sandboxes.find(w => w.base === base)?.name)) : undefined;
  const named = onSandbox ? known.find(s => s.id === onSandbox.id) ?? onSandbox : wanted ? known.find(s => s.id === wanted) : undefined;
  const servers = named && !known.some(s => s.id === named.id) ? [named, ...known] : known;
  // The one just picked leads the address by a moment, so its radio changes as it's pressed.
  const [picked, setPicked] = useState<string>();
  useEffect(() => setPicked(undefined), [base, wanted]);
  const chosen = servers.find(s => s.id === picked) ?? named ?? servers.find(s => s.id === stored(CHOICE_KEY)) ?? servers[0];
  // Decided before the first paint: a tab that's connected, or finishing a sign-in, never shows the Connect form,
  // unless the address names another server.
  const [session, setSession] = useState<Session | undefined>(() => { const s = returned() ? undefined : saved().session; return s && (!named || named.iss === s.iss) ? s : undefined; });
  const [phase, setPhase] = useState<Phase>(() => session ? "app" : returned() ? "connecting" : "landing");
  const [trail, setTrail] = useState(() => new Trail(saved().trail ?? []));
  // A connection that failed: to which server, and why, beside the steps it took.
  const [failure, setFailure] = useState<{ server: Choice; message: string }>();
  const { state } = useLocation(), navigate = useNavigate();
  const choose = (s: Choice) => { setPicked(s.id); store(CHOICE_KEY, s.id); setParams(serverQuery(s), { replace: true, preventScrollReset: true }); };

  const failed = (server: Choice | undefined) => (e: unknown) => { setPhase("landing"); setFailure(server && { server, message: (e as Error).message }); };
  const connected = (s: Session) => { setSession(s); setPhase("app"); };

  useEffect(() => {
    const back = returned();
    if (back) {
      // The viewer's address is left clean, without the code. The router isn't told, so the page isn't drawn afresh.
      history.replaceState(history.state, "", location.pathname);
      finishSignIn(trail, back).then(connected, failed(chosen));
    }
    // A page brought back by Back is as it was left, perhaps "Connecting…" while a sign-in tab was open.
    const shown = (e: PageTransitionEvent) => { if (e.persisted && !saved().session) setPhase("landing"); };
    addEventListener("pageshow", shown);
    // Opened to connect at once, from Your servers: the click there opened the sign-in tab, which is taken here.
    if ((state as { connect?: boolean } | null)?.connect && chosen) {
      navigate({ search: location.search }, { replace: true, state: null });
      connect(takeSignInTab());
    } else if (params.has("connect") && chosen && phase === "landing") {
      // A link that says connect has no click to open a tab from, so the sign-in happens in this tab, and comes back.
      const q = new URLSearchParams(params); q.delete("connect");
      navigate({ search: `?${q}` }, { replace: true });
      connect(null);
    }
    return () => removeEventListener("pageshow", shown);
  }, []);

  /** Connects to the chosen server. A person signs in in a tab of its own, opened from the click itself, so this one never leaves the viewer. */
  const connect = async (given?: Window | null) => {
    const server = chosen!;
    // Kept as the choice, so a sign-in that comes back to this tab knows which server it was.
    store(CHOICE_KEY, server.id);
    const tab = server.mode === "backend" ? null : given !== undefined ? given : open("about:blank", "smart-imaging-sign-in");
    setFailure(undefined);
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
      failed(server)(e);
    }
  };
  // The address names the server chosen, so the page can be handed on as it is.
  // One it doesn't know stays named, beside the error that says so.
  useEffect(() => { if (phase === "landing" && chosen && !named && !wanted && !params.has("connect")) setParams(serverQuery(chosen), { replace: true }); }, [phase, chosen?.id]);
  useReady(phase !== "connecting");
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
      {wanted && !named && <p className="error" role="alert">There's no server <code>{wanted}</code> in this browser's list.</p>}
      <section className="path panel" id="try" aria-label="Connect">
        <fieldset className="server-choice"><legend>Connect to</legend>
          <div id="servers">
            {chosen ? servers.map(s => (
              <Option className="server" key={s.id} type="radio" name="server" value={s.id} checked={s.id === chosen.id} onChange={() => choose(s)} label={s.label} detail={s.detail} bold />
            )) : <p className="note">No servers yet. <PageLink id="home">Create a sandbox</PageLink>, or add a server of your own.</p>}
          </div>
        </fieldset>
        <div className="connect-actions"><button type="button" className="primary" id="connect" disabled={!chosen} onClick={() => connect()}>Connect</button></div>
        <p className="note">Add or change servers in <PageLink id="servers" />. To test a server step by step, use the <PageLink id="check" />.</p>
      </section>
      {failure && <Failed failure={failure} trail={trail} />}
    </main>
  );
}

/** Why a connection failed: the request that failed, what that usually means, how to check, and every step taken. */
function Failed({ failure, trail }: { failure: { server: Choice; message: string }; trail: Trail }) {
  const steps = useSteps(trail), bad = [...steps].reverse().find(st => st.failed);
  const check = `/check?${new URLSearchParams({ server: failure.server.id })}`;
  return (
    <section className="connect-failed" id="connect-error" role="alert" aria-labelledby="h-failed">
      <h2 id="h-failed">Couldn't connect to {failure.server.label}</h2>
      <p className="failed-what">{bad ? <><b>{bad.title}</b> failed: {bad.diagnosis?.cause ?? failure.message}</> : failure.message}</p>
      {bad?.diagnosis?.check && <pre className="failed-check">{bad.diagnosis.check}</pre>}
      <p className="failed-next"><Link to={check}>Check this server, step by step</Link> <PageLink id="servers">Edit it in Your servers</PageLink></p>
      {steps.length > 0 && <Protocol trail={trail} />}
    </section>
  );
}
