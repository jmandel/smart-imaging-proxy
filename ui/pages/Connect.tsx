// Register an app: registering an app in this sandbox, and its apps so far, each with what its developer needs.
import { BASE } from "../lib/api";
import { PageLink } from "../shell/Shell";
import { RegisterForm, Registered, useClients } from "../components/RegisterApp";

export default function Connect() {
  const { clients, refresh } = useClients(BASE);
  return (
    <main className="landing connect-page">
      <h1>Register an app</h1>
      <p className="lead">Register your SMART app in this sandbox to get a client ID. It stays registered until you remove it. <PageLink id="build" /> has the addresses to point it at, and who to sign in as.</p>
      <RegisterForm base={BASE} registered={refresh} />
      <section aria-labelledby="yours"><h2 id="yours">Your apps</h2>
        <div id="clients">{!clients ? <p className="note">Loading…</p> : clients.length ? clients.map(c => <Registered key={c.id} c={c} base={BASE} removed={refresh} />) : <p className="note">None yet.</p>}</div>
      </section>
    </main>
  );
}
