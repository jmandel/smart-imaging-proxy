// A guide for each audience: what matters for their jobs, most important first, each step linking to the page
// that does it. Links into a sandbox go to the one you were last in; with none, following one makes one.
import { useState, type MouseEvent, type ReactNode } from "react";
import { createSandbox, linkedSandbox, useSandboxes } from "../lib/store";
import { openViewer, sandboxServer, VIEWER_URL } from "../lib/servers";
import { CONFORMANCE_PLAN, REFERENCES, type PageId } from "../sitemap";
import { PageLink } from "../shell/Shell";

/** A link into your sandbox's `page`, or the viewer opened on it, making a sandbox first if there's none. */
function InSandbox({ page, button, children }: { page: PageId | "trace" ; button?: boolean; children: ReactNode }) {
  const linked = linkedSandbox(useSandboxes());
  const [error, setError] = useState<string>();
  const path = page === "viewer" ? "/viewer" : page === "sandbox" ? "/" : page === "trace" ? "/trace/" : `/${page}`;
  const go = async (e: MouseEvent) => {
    if (linked && page !== "viewer") return;
    e.preventDefault();
    try {
      const base = linked?.base ?? await createSandbox();
      if (page === "viewer") openViewer(sandboxServer(base)); else location.assign(`${base}${path}`);
    } catch (x) { setError((x as Error).message); }
  };
  return <>
    <a className={button ? "button" : undefined} href={page === "viewer" ? "/viewer" : `${linked?.base ?? ""}${path}`} onClick={go}>{children}</a>
    {error && <span className="error" role="alert"> {error}</span>}
  </>;
}

interface Step { title: string; body: ReactNode; links?: ReactNode }

function Guide({ heading, lead, steps }: { heading: string; lead: string; steps: Step[] }) {
  const linked = linkedSandbox(useSandboxes());
  return (
    <main className="landing guide">
      <h1>{heading}</h1>
      <p className="lead">{lead}</p>
      <p className="guide-sandbox note" id="guide-sandbox">
        {linked ? <>Links go to your sandbox “{linked.name ?? "Sandbox"}”. <a href="/">Your sandboxes</a></> : "You don't have a sandbox yet. The first link into one makes it."}
      </p>
      {steps.map((s, i) => (
        <section className="panel guide-step" key={s.title} aria-labelledby={`h-${i + 1}`}>
          <h2 id={`h-${i + 1}`}><span className="step-no">{i + 1}</span> {s.title}</h2>
          {s.body}
          {s.links && <p className="guide-links">{s.links}</p>}
        </section>
      ))}
      <p className="note agents">Working with an AI agent? Give it <a href="/llms.txt">llms.txt</a>. Everything on these pages has an API, and it's all described there.</p>
    </main>
  );
}

export function BuildAnApp() {
  return <Guide heading="Build an imaging app" lead="Connect your SMART app to a sandbox: a private copy of a health system's servers, with sample patients, studies and reports, and sign-in with no passwords." steps={[
    { title: "Get a sandbox", body: <p>Your sandbox keeps your registered apps, tokens and settings, until you delete it. Share its link with your team.</p>, links: <InSandbox page="sandbox" button>Open your sandbox</InSandbox> },
    { title: "Point your app at it", body: <p>The FHIR base and discovery address, the scopes to ask for, and sample people to sign in as, with what each can see.</p>, links: <InSandbox page="build">Endpoints and sample logins →</InSandbox> },
    { title: "Register your app", body: <p>A public app with PKCE, a confidential app that signs with its key, or a backend service with no one signing in. You get a client ID, and can try each kind in our viewer.</p>, links: <InSandbox page="connect">Register an app →</InSandbox> },
    { title: "When a request is refused", body: <p>The logs show every request your app made, and why each was allowed or refused.</p>, links: <InSandbox page="activity">Logs →</InSandbox> },
    { title: "Try the hard cases", body: <p>Real systems refuse access, expire links, and let guardians act for children. The Tour plays these out, Explore shows what each sample person can reach, and Sandbox Config moves the clock so links and tokens expire.</p>, links: <><InSandbox page="tours">Tour →</InSandbox> <InSandbox page="explore">Explore →</InSandbox> <InSandbox page="config">Sandbox Config →</InSandbox></> },
  ]} />;
}

export function RunAServer() {
  return <Guide heading="Test your imaging server" lead="Connect our viewer, a known-good SMART Imaging app, to your server. When something fails, you'll know it's the server, not the app." steps={[
    { title: "What your server needs", body: <ul className="how">
      <li><strong>CORS</strong> for <code>{location.origin}</code> on discovery, the token endpoint, FHIR searches and image retrieval. The viewer runs in the browser.</li>
      <li><strong>Discovery</strong> that names SMART Imaging by capability: <code>smart-imaging-access</code> with the app-launch capability, at the top level or on an entry in <code>associated_endpoints</code>.</li>
      <li><strong>ImagingStudy search</strong> by <code>patient</code>, with <code>_include=ImagingStudy:endpoint</code> and <code>next</code> links.</li>
      <li><strong>WADO-RS</strong> at each study's <code>Endpoint.address</code>, accepting the token, and <code>503</code> with <code>Retry-After</code> while images are prepared.</li>
    </ul> },
    { title: "Register our viewer", body: <>
      <p>As a client on your server, in any of three ways: a public app with PKCE (S256), a confidential app signing with <code>private_key_jwt</code>, or a backend service using <code>client_credentials</code>. Apps ask for <code>launch/patient patient/*.rs</code>, services for <code>system/ImagingStudy.rs</code>. The redirect URI, the same for every server:</p>
      <p><code>{VIEWER_URL}</code></p>
    </> },
    { title: "Add your server, and connect", body: <p>Describe your server for the viewer, and how it signs in. The page checks your discovery as the viewer reads it, and makes a key pair in your browser for a confidential app or a service.</p>, links: <PageLink id="servers" className="button" /> },
    { title: "Compare with a working server", body: <p>Open the viewer on a sandbox, and read its logs: every request and response, from discovery to the last image.</p>, links: <><InSandbox page="viewer">Viewer →</InSandbox> <InSandbox page="activity">Logs →</InSandbox></> },
    { title: "Conformance checks, planned", body: <p>Our client will check your server against the guide, step by step. Tell us what you'd want checked.</p>, links: <a href={CONFORMANCE_PLAN}>The plan, on GitHub →</a> },
  ]} />;
}

export function HowItWorks() {
  return <Guide heading="How SMART Imaging works" lead="One sign-in gives an app a patient's clinical records and their images. Here it runs end to end, with sample patients." steps={[
    { title: "See it work", body: <p>Our viewer signs in as a sample patient, then shows their records and opens their images.</p>, links: <InSandbox page="viewer" button>Open the viewer</InSandbox> },
    { title: "The parts", body: <dl className="registered-facts">
      <dt>Clinical FHIR server</dt><dd>Discovery, and the patient's records</dd>
      <dt>Authorization server</dt><dd>Sign-in, consent and tokens</dd>
      <dt>Imaging FHIR server</dt><dd>The patient's studies, each with where to get its images</dd>
      <dt>DICOMweb server</dt><dd>The images, retrieved with the same token</dd>
    </dl> },
    { title: "The stories", body: <p>A patient shares with a caregiver, a guardian acts for a teenager, a referral service finds one X-ray. Each is played out step by step.</p>, links: <InSandbox page="tours">Tour →</InSandbox> },
    { title: "Every request", body: <p>The live trace shows each request between the parts as it happens.</p>, links: <><InSandbox page="trace">Live trace →</InSandbox> <a href={REFERENCES[0]![1]}>The specification →</a></> },
  ]} />;
}

export function WhyItMatters() {
  return <Guide heading="Why imaging interoperability matters" lead="Patients carry their records between health systems, but rarely their images. SMART Imaging lets any app a patient chooses fetch both, with one sign-in and the health system's own rules." steps={[
    { title: "What it makes possible", body: <ul className="how">
      <li>A patient opens their scans in an app of their choice, next to their reports.</li>
      <li>A parent or caregiver reaches what they're allowed to, and no more.</li>
      <li>A referral service finds the one study it needs, not the whole record.</li>
      <li>Images stay where they are. Nothing is copied ahead of time.</li>
    </ul>, links: <InSandbox page="tours">See these as stories →</InSandbox> },
    { title: "Watch it work", body: <p>A sample patient signs in, and their images open in the viewer.</p>, links: <InSandbox page="viewer" button>Open the viewer</InSandbox> },
    { title: "What it takes", body: <ul className="how">
      <li><strong>A health system</strong> adds an imaging FHIR server and a DICOMweb endpoint behind the sign-in it already has for SMART apps.</li>
      <li><strong>An app</strong> uses the SMART App Launch it may already support, asking for imaging too.</li>
    </ul>, links: <><PageLink id="run-a-server">For server teams →</PageLink> <PageLink id="build-an-app">For app teams →</PageLink></> },
  ]} />;
}
