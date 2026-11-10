// Start here: what an app developer needs to point an app at this sandbox, and who to sign in as.
import { BASE } from "../lib/api";
import { CopyButton } from "../lib/format";
import { PAGES, type PageId } from "../sitemap";
import { PageLink } from "../shell/Shell";

const PEOPLE: [string, string][] = [["josh", "Six de-identified studies, with reports"], ["sam-caregiver", "Two synthetic studies, and a guardian of Riley"], ["robin", "No studies: a real empty result"]];
const AFTER: PageId[] = ["activity", "tours", "explore"];

export default function Build() {
  const site = `${location.origin}${BASE}`;
  const endpoints: [string, string][] = [["FHIR base", `${site}/fhir`], ["Discovery", `${site}/fhir/.well-known/smart-configuration`], ["Imaging FHIR server", `${site}/imaging/fhir`]];
  return (
    <main className="landing build-page">
      <h1>Build a client</h1>
      <p className="lead">Your SMART app, against this sandbox's servers. They behave as a health system's would, with sample patients, real policy decisions, and sign-in with no passwords.</p>
      <section className="panel" aria-labelledby="h-register">
        <h2 id="h-register"><span className="step-no">1</span> Register your app</h2>
        <p>A public app, a confidential app with a key, or a backend service. Registering takes a name and a redirect URI or a key, and gives you a client ID.</p>
        <p><PageLink id="connect" className="button" /></p>
      </section>
      <section className="panel" aria-labelledby="h-point">
        <h2 id="h-point"><span className="step-no">2</span> Point it at this sandbox</h2>
        <dl className="registered-facts" id="endpoints">
          {endpoints.map(([name, url]) => [<dt key={`${name}-t`}>{name}</dt>, <dd key={`${name}-d`}><code>{url}</code> <CopyButton label="Copy" value={url} aria={`Copy ${name}`} /></dd>])}
        </dl>
        <ul className="how">
          <li>Apps use PKCE (S256). Confidential apps also send a <code>private_key_jwt</code> assertion, signed with ES256, ES384 or RS384.</li>
          <li>Ask for <code>launch/patient patient/*.rs</code>. Backend services use <code>client_credentials</code> with <code>system/ImagingStudy.rs</code>, and name the patient in each search.</li>
          <li>Discovery names the imaging FHIR server above in <code>associated_endpoints</code>. In <PageLink id="config" />, the sandbox can instead be one server, with imaging at the FHIR base.</li>
        </ul>
      </section>
      <section className="panel" aria-labelledby="h-signin">
        <h2 id="h-signin"><span className="step-no">3</span> Sign in as a sample patient</h2>
        <dl className="registered-facts">
          {PEOPLE.map(([who, what]) => [<dt key={`${who}-t`}><code>{who}</code></dt>, <dd key={`${who}-d`}>{what}</dd>])}
        </dl>
        <p className="note">No passwords. Choose the person on the sign-in page, then approve the app.</p>
      </section>
      <section aria-labelledby="h-see">
        <h2 id="h-see"><span className="step-no">4</span> See what the servers did</h2>
        <ul className="link-list">{AFTER.map(id => <li key={id}><PageLink id={id} /><span>{PAGES[id].blurb}</span></li>)}</ul>
      </section>
      <p className="note agents">Working with an AI agent? Give it <a href={`${BASE}/llms.txt`}>this sandbox's llms.txt</a>. It has the endpoints, the registration API and a sign-in walk-through, so the agent can register your app and test it against this sandbox for you.</p>
      <p className="note">Testing your own server instead? <PageLink id="run-a-server" />.</p>
    </main>
  );
}
