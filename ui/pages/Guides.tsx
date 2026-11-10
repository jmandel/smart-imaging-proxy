// The site's guides: Run a Server for server teams, and Why SMART Imaging for anyone deciding what it's worth or
// how it works. Plain sections, each linking to the page that does it. Build an App is a wizard of its own.
import type { ReactNode } from "react";
import { VIEWER_URL } from "../lib/servers";
import { CONFORMANCE_PLAN, REFERENCES } from "../sitemap";
import { PageLink } from "../shell/Shell";
import { InSandbox } from "../components/InSandbox";
import { ImagingChain } from "../components/ImagingChain";
import { Address } from "../lib/format";

interface Section { title: string; body: ReactNode; links?: ReactNode }

function Guide({ heading, lead, sections }: { heading: string; lead: string; sections: Section[] }) {
  return (
    <main className="landing guide">
      <h1>{heading}</h1>
      <p className="lead">{lead}</p>
      {sections.map((s, i) => (
        <section className="guide-section" key={s.title} aria-labelledby={`h-${i + 1}`}>
          <h2 id={`h-${i + 1}`}>{s.title}</h2>
          {s.body}
          {s.links && <p className="guide-links">{s.links}</p>}
        </section>
      ))}
      <p className="note agents">Working with an AI agent? Give it <a href="/llms.txt">llms.txt</a>. Everything on these pages has an API, and it's all described there.</p>
    </main>
  );
}

export function RunAServer() {
  return <Guide heading="Test your imaging server" lead="Connect our viewer, a known-good SMART Imaging app, to your server. When something fails, you'll know it's the server, not the app." sections={[
    { title: "What your server needs", body: <ul className="how">
      <li><strong>CORS</strong> for <code>{location.origin}</code> on discovery, the token endpoint, FHIR searches and image retrieval. The viewer runs in the browser.</li>
      <li><strong>Discovery</strong> that names SMART Imaging by capability: <code>smart-imaging-access</code> with the app-launch capability, at the top level or on an entry in <code>associated_endpoints</code>.</li>
      <li><strong>ImagingStudy search</strong> by <code>patient</code>, with <code>_include=ImagingStudy:endpoint</code> and <code>next</code> links.</li>
      <li><strong>WADO-RS</strong> at each study's <code>Endpoint.address</code>, accepting the token, and <code>503</code> with <code>Retry-After</code> while images are prepared.</li>
    </ul> },
    { title: "Register our viewer with it", body: <>
      <p>As a client on your server, in any of three ways: a public app with PKCE (S256), a confidential app signing with <code>private_key_jwt</code>, or a backend service using <code>client_credentials</code>. Apps ask for <code>launch/patient patient/*.rs</code>, services for <code>system/ImagingStudy.rs</code>. The redirect URI is the same for every server:</p>
      <p><Address value={VIEWER_URL} name="the redirect URI" /></p>
    </> },
    { title: "Add it, then check it", body: <p>Describe your server and how the viewer signs in to it; the form checks your discovery as you go. Then the server check runs every step of the guide against it, as far as it can on its own, and says where it stopped and why: each request, its answer, and what a failure usually means.</p>, links: <><PageLink id="servers" className="button" /> <a href={CONFORMANCE_PLAN}>Ideas for more checks, on GitHub</a></> },
    { title: "Compare with a working server", body: <p>Open the viewer on a sandbox, and read its logs: every request and response, from discovery to the last image.</p>, links: <><InSandbox page="viewer">Viewer</InSandbox> <InSandbox page="activity">Logs</InSandbox></> },
  ]} />;
}

export function About() {
  return <Guide heading="Why SMART Imaging" lead="Patients carry their records between health systems, but rarely their images. SMART Imaging Access lets an app a patient chooses fetch both, with one sign-in and the health system's own rules." sections={[
    { title: "What it makes possible", body: <ul className="how">
      <li>A patient opens their scans in an app of their choice, next to their reports.</li>
      <li>A parent or caregiver reaches what they're allowed to, and no more.</li>
      <li>A referral service finds the one study it needs, not the whole record.</li>
      <li>Images stay where they are. Nothing is copied ahead of time.</li>
    </ul> },
    { title: "How it works", body: <ImagingChain /> },
    { title: "See it work", body: <p>Our viewer signs in as a sample patient and opens their images. The Tour plays out sharing, guardians and referrals. The live trace shows every request between the servers.</p>, links: <><InSandbox page="viewer" className="button">Open the viewer</InSandbox> <InSandbox page="tours">Tour</InSandbox> <InSandbox page="trace">Live trace</InSandbox></> },
    { title: "What it takes", body: <ul className="how">
      <li><strong>A health system</strong> adds an imaging FHIR server and a DICOMweb endpoint behind the sign-in it already has for SMART apps.</li>
      <li><strong>An app</strong> uses the SMART App Launch it may already support, asking for imaging too.</li>
    </ul>, links: <><PageLink id="run-a-server">For server teams</PageLink> <PageLink id="build-an-app">For app teams</PageLink> <a href={REFERENCES[0]![1]}>The specification</a></> },
  ]} />;
}
