// Register an app: registering an app in this sandbox, the apps registered so far, and the demo's own, each with what
// its developer needs. The kind of app the form is set to, and an app just registered, are in the address
// (?type=, ?app=).
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { BASE } from "../lib/api";
import { useReady } from "../lib/ready";
import { PageLink } from "../shell/Shell";
import { CLIENT_KINDS, RegisterForm, Registered, useClients, type ClientType } from "../components/RegisterApp";

export default function Connect() {
  const { clients, builtIn, refresh } = useClients(BASE);
  const [params, setParams] = useSearchParams();
  const asked = params.get("type") as ClientType | null, named: ClientType = asked && CLIENT_KINDS.includes(asked) ? asked : "public";
  // Held here as well, so the radio changes as it's pressed, before the address catches up.
  const [type, hold] = useState(named);
  useEffect(() => hold(named), [named]);
  const setType = (t: ClientType) => { hold(t); setParams(p => { const q = new URLSearchParams(p); if (t === "public") q.delete("type"); else q.set("type", t); return q; }, { replace: true }); };
  const shown = params.get("app");
  useReady(!!clients);
  // An app named in the address is brought into sight once the list is drawn.
  useEffect(() => { if (clients && shown) document.getElementById(`app-${shown}`)?.scrollIntoView({ block: "nearest" }); }, [!!clients, shown]);
  return (
    <main className="landing connect-page">
      <h1>Register an app</h1>
      <p className="lead">Register your SMART app in this sandbox to get a client ID. It stays registered until you remove it. <PageLink id="build" /> has the addresses to point it at, and who to sign in as.</p>
      <RegisterForm base={BASE} kind={[type, setType]} registered={async c => { await refresh(); setParams({ app: c.id }, { replace: true }); }} />
      <section aria-labelledby="yours"><h2 id="yours">Your apps</h2>
        <div id="clients">{!clients ? <p className="note">Loading…</p> : clients.length ? clients.map(c => <Registered key={c.id} c={c} base={BASE} removed={refresh} />) : <p className="note">None yet.</p>}</div>
      </section>
      {!!builtIn?.length && <section aria-labelledby="built-in"><h2 id="built-in">Built into this sandbox</h2>
        <p className="note">The demo's own apps, which work here without being registered, so you can sign in as one and see what an app gets. They can't be removed: a backend service among them reaches what this sandbox's policy releases.</p>
        <div id="built-in-clients">{builtIn.map(c => <Registered key={c.id} c={c} base={BASE} removed={refresh} />)}</div>
      </section>}
    </main>
  );
}
