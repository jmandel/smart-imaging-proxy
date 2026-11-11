// Build an App: a wizard, one step at a time, for connecting an app to a sandbox. Choose the sandbox, choose or
// register the app (the same form as the sandbox's Register an app page, here in place), see where to point it,
// then try it. The step and the app are in the address, so Back, Forward and a reload keep the place.
import { Link, useSearchParams } from "react-router";
import { useLinkedSandbox } from "../lib/store";
import { PageLink } from "../shell/Shell";
import { Address, Choice } from "../lib/format";
import { useReady } from "../lib/ready";
import { SandboxPicker } from "../components/SandboxPicker";
import { AuthNotes, Endpoints, SamplePeople } from "../components/ConnectFacts";
import { RegisterForm, useClients, type Client } from "../components/RegisterApp";
import { InSandbox } from "../components/InSandbox";

const STEPS = [
  { id: "sandbox", name: "Sandbox" },
  { id: "app", name: "Your app" },
  { id: "connect", name: "Connect it" },
  { id: "try", name: "Try it" },
] as const;
type StepId = typeof STEPS[number]["id"];
const KIND: Record<Client["type"], string> = { public: "Public app", confidential: "Confidential app", backend: "Backend service" };

export default function BuildAnApp() {
  const [params, setParams] = useSearchParams();
  const sandbox = useLinkedSandbox();
  const { clients, refresh } = useClients(sandbox?.base ?? "");
  const step: StepId = STEPS.some(s => s.id === params.get("step")) ? params.get("step") as StepId : "sandbox";
  const app = clients?.find(c => c.id === params.get("app"));
  const at = STEPS.findIndex(s => s.id === step);
  useReady(!sandbox || clients !== undefined);
  // How far the wizard can go: an app needs a sandbox, and connecting needs the app.
  const reachable = (id: StepId) => id === "sandbox" || (!!sandbox && (id === "app" || !!app));
  const go = (id: StepId, appId = app?.id) => setParams(p => { const q = new URLSearchParams(p); q.set("step", id); if (appId) q.set("app", appId); else q.delete("app"); return q; });
  const next = STEPS[at + 1], back = STEPS[at - 1];

  return (
    <main className="landing guide wizard">
      <h1>Build an imaging app</h1>
      <p className="lead">Connect your SMART app to a sandbox: a private copy of a health system's servers, with sample patients, studies and reports, and sign-in with no passwords.</p>
      <ol className="wizard-steps" aria-label="Steps">
        {STEPS.map((s, i) => (
          <li key={s.id} aria-current={s.id === step ? "step" : undefined} className={i < at ? "done" : undefined}>
            {reachable(s.id) && s.id !== step ? <Link to={`?${new URLSearchParams({ step: s.id, ...(app ? { app: app.id } : {}) })}`}>{s.name}</Link> : <span>{s.name}</span>}
          </li>
        ))}
      </ol>

      <section className="wizard-step" aria-labelledby="wizard-title">
        {step === "sandbox" && <>
          <h2 id="wizard-title">Choose a sandbox</h2>
          <p>A sandbox keeps its own registered apps, tokens and settings, until you delete it, and you can share its link with your team.</p>
          <SandboxPicker />
        </>}

        {step === "app" && sandbox && <>
          {clients?.length ? <>
            <h2 id="wizard-title">Choose your app</h2>
            <fieldset className="server-choice"><legend className="sr-only">Apps registered in {sandbox.name ?? "this sandbox"}</legend>
              {clients.map(c => (
                <Choice className="server" key={c.id} type="radio" name="app" checked={app?.id === c.id} onChange={() => go("app", c.id)} label={c.name} detail={<>{KIND[c.type]}, client ID <code>{c.id}</code></>} bold />
              ))}
            </fieldset>
          </> : <h2 id="wizard-title" className="sr-only">Your app</h2>}
          <RegisterForm base={sandbox.base} title={clients?.length ? "Or register another" : `Register your app in ${sandbox.name ?? "this sandbox"}`} registered={async c => { await refresh(); go("connect", c.id); }} />
        </>}

        {step === "connect" && sandbox && app && <>
          <h2 id="wizard-title">Connect {app.name}</h2>
          <p>Point your app at these addresses, with its client ID.</p>
          <dl className="addresses"><div className="address"><dt>Client ID</dt><dd><Address value={app.id} name="client ID" /></dd></div></dl>
          <Endpoints base={sandbox.base} />
          <AuthNotes base={sandbox.base} />
        </>}

        {step === "try" && sandbox && app && <>
          <h2 id="wizard-title">Try {app.name}</h2>
          {app.type !== "backend" ? <><p>Launch your app against the addresses from the previous step, and sign in as one of the sample people:</p><SamplePeople /></>
            : <p>Have your service request a token at the token endpoint with its signed assertion, then search <code>ImagingStudy</code> for a patient.</p>}
          <p className="wizard-actions">
            <a href={`${sandbox.base}/activity`} target="_blank" rel="noopener">See its requests in the logs</a>
            <InSandbox page="viewer">Open our reference viewer on this sandbox</InSandbox>
          </p>
          <h3>Then, grade it</h3>
          <p>The App check runs your app against this sandbox while it stages what any server may do: small pages of results, a 503 with Retry-After, Endpoints in each form the guide allows. You follow a script, such as signing in as josh and opening every study, and each requirement of the guide comes back passed or failed, with the requests behind it.</p>
          <p className="guide-links"><Link to={`${sandbox.base}/app-check?${new URLSearchParams({ app: app.id })}`}>Check {app.name}</Link></p>
          <h3>Then, the hard cases</h3>
          <p>Real systems refuse access, expire links, and let guardians act for children. The Tour plays these out, Explore shows what each sample person can reach, and Sandbox Config moves the clock so links and tokens expire.</p>
          <p className="guide-links"><InSandbox page="tours">Tour</InSandbox> <InSandbox page="explore">Explore</InSandbox> <InSandbox page="config">Sandbox Config</InSandbox></p>
        </>}
      </section>

      <div className="wizard-nav">
        {back && <button type="button" className="secondary" onClick={() => go(back.id)}>Back</button>}
        {next && reachable(next.id) && <button type="button" className="primary" onClick={() => go(next.id)}>Next: {next.name}</button>}
      </div>
      <p className="note agents">Working with an AI agent? Give it <a href="/llms.txt">llms.txt</a>. Registering, signing in and searching all have APIs, described there. You can also work in a sandbox's own pages: <PageLink id="sandboxes" />.</p>
    </main>
  );
}
