// A sandbox's Endpoints: what an app needs to connect to it, kept for reference. Build an App walks through the
// same facts in order.
import { BASE } from "../lib/api";
import { PAGES, type PageId } from "../sitemap";
import { PageLink } from "../shell/Shell";
import { AuthNotes, Endpoints, SamplePeople } from "../components/ConnectFacts";

const NEXT: PageId[] = ["connect", "activity", "explore"];

export default function Build() {
  return (
    <main className="landing build-page">
      <h1>Endpoints</h1>
      <p className="lead">This sandbox's addresses, and who to sign in as. <PageLink id="build-an-app" /> walks through connecting an app, step by step.</p>
      <section aria-labelledby="h-addresses">
        <h2 id="h-addresses">Addresses</h2>
        <Endpoints base={BASE} />
      </section>
      <section aria-labelledby="h-auth">
        <h2 id="h-auth">Signing in and scopes</h2>
        <AuthNotes base={BASE} />
      </section>
      <section aria-labelledby="h-people">
        <h2 id="h-people">Sample people</h2>
        <SamplePeople />
      </section>
      <section aria-labelledby="h-next">
        <h2 id="h-next">In this sandbox</h2>
        <ul className="link-list">{NEXT.map(id => <li key={id}><PageLink id={id} /><span>{PAGES[id].blurb}</span></li>)}</ul>
      </section>
      <p className="note agents">Working with an AI agent? Give it <a href={`${BASE}/llms.txt`}>this sandbox's llms.txt</a>. It has the endpoints, the registration API and a sign-in walk-through, so the agent can register your app and test it against this sandbox for you.</p>
    </main>
  );
}
