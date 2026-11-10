// The site's home: what SMART Imaging adds, as a diagram, and the two ways in.
import { PAGES } from "../sitemap";
import { ImagingChain } from "../components/ImagingChain";
import { PageLink } from "../shell/Shell";

export default function Home() {
  return (
    <main id="home" className="landing">
      <h1>{PAGES.home.name}</h1>
      <p className="lead">A public sandbox and test client for the SMART Imaging Access guide.</p>
      <ImagingChain />
      <section className="ways" aria-label="Where to start">
        <div className="way">
          <h2>Building an app?</h2>
          <p>Point it at a sandbox: a health system's servers with sample patients and studies, and sign-in with no passwords.</p>
          <PageLink id="build-an-app" className="button">Build an App</PageLink>
        </div>
        <div className="way">
          <h2>Running a server?</h2>
          <p>Connect our known-good viewer to it, and see which step it gets wrong.</p>
          <PageLink id="run-a-server" className="button">Run a Server</PageLink>
        </div>
      </section>
      <ul className="more-links" aria-label="More">
        <li><PageLink id="about" /></li>
        <li><PageLink id="sandboxes" /></li>
        <li><a href="/llms.txt">For agents: llms.txt</a></li>
      </ul>
    </main>
  );
}
