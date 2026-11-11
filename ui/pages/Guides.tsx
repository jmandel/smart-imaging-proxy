// Why SMART Imaging: for anyone deciding what it's worth or how it works. Plain sections, each linking to the page
// that does it. Build an App and Build a Server are wizards of their own.
import type { ReactNode } from "react";
import { REFERENCES } from "../sitemap";
import { PageLink } from "../shell/Shell";
import { InSandbox } from "../components/InSandbox";
import { ImagingChain } from "../components/ImagingChain";

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

export function About() {
  return <Guide heading="Why SMART Imaging" lead="Patients carry their records between health systems, but rarely their images. SMART Imaging Access lets an app a patient chooses fetch both, with one sign-in and the health system's own rules." sections={[
    { title: "What it makes possible", body: <ul className="how">
      <li>A patient opens their scans in an app of their choice, next to their reports.</li>
      <li>A parent or caregiver reaches what they're allowed to, and no more.</li>
      <li>A referral service finds the one study it needs, not the whole record.</li>
      <li>Images stay where they are. Nothing is copied ahead of time.</li>
    </ul> },
    { title: "How it works", body: <ImagingChain /> },
    { title: "See it work", body: <p>Our viewer signs in as a sample patient and opens their images. Explore shows what each sample person and service can reach, and why. The live trace shows every request between the servers.</p>, links: <><InSandbox page="viewer" className="button">Open the viewer</InSandbox> <InSandbox page="explore">Explore</InSandbox> <InSandbox page="trace">Live trace</InSandbox></> },
    { title: "What it takes", body: <ul className="how">
      <li><strong>A health system</strong> adds an imaging FHIR server and a DICOMweb endpoint behind the sign-in it already has for SMART apps.</li>
      <li><strong>An app</strong> uses the SMART App Launch it may already support, asking for imaging too.</li>
    </ul>, links: <><PageLink id="build-a-server">For server teams</PageLink> <PageLink id="build-an-app">For app teams</PageLink> <a href={REFERENCES[0]![1]}>The specification</a></> },
  ]} />;
}
