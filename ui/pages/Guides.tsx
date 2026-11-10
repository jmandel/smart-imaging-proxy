// The site's guides: Run a Server for server teams, and Why SMART Imaging for anyone deciding what it's worth or
// how it works. Plain sections, each linking to the page that does it. Build an App is a wizard of its own.
import { useEffect, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { Choice } from "../lib/format";
import type { PrivateJwk } from "../lib/api";
import { generateKey } from "../lib/servers";
import { ClientMetadata, CLIENT_TYPES, type ClientType } from "../components/ClientMetadata";
import { CONFORMANCE_PLAN, REFERENCES } from "../sitemap";
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

/** Registering the viewer: the kind of client, and the metadata your server needs for it, key included. "Add
 *  this server" carries both to Your servers. */
function RegisterViewer() {
  // The way of connecting is in the address (?how=), so a link opens the guide on it.
  const [params, setParams] = useSearchParams(), asked = params.get("how");
  const named: ClientType = CLIENT_TYPES.some(([v]) => v === asked) ? asked as ClientType : "public";
  // Held here as well, so the radio changes as it's pressed, before the address catches up.
  const [type, setType] = useState(named);
  useEffect(() => setType(named), [named]);
  const [key, setKey] = useState<PrivateJwk | null>(null);
  const navigate = useNavigate();
  // A way that signs needs a key, made here once, whether it was chosen on the page or by the link.
  useEffect(() => { if (type !== "public" && !key) generateKey().then(k => setKey(k.priv)); }, [type]);
  const choose = (t: ClientType) => { setType(t); setParams(t === "public" ? {} : { how: t }, { replace: true, preventScrollReset: true }); };
  return <>
    <fieldset className="client-type"><legend>How the viewer connects</legend>
      {CLIENT_TYPES.map(([v, label, what]) => <Choice key={v} type="radio" name="guide-how" value={v} checked={type === v} onChange={() => choose(v)} label={label} detail={what} />)}
    </fieldset>
    <p>Register a client with these details, in your server's admin console or, if it supports dynamic registration, by posting the JSON. Then note the client ID it gives you.</p>
    <ClientMetadata type={type} keyPair={key} />
    {type !== "public" && key && <p className="note">The viewer signs its assertions with key <code>{key.kid}</code>, made in this browser just now; the private half stays here. Your server checks them against the public half, which this site serves at the <code>jwks_uri</code>, or which you can register as the <code>jwks</code> itself.</p>}
    <p className="guide-links"><button type="button" className="primary" onClick={() => navigate(`/servers?add&how=${type}`, { state: type !== "public" && key ? { key } : undefined })}>Add this server</button></p>
  </>;
}

export function RunAServer() {
  return <Guide heading="Test your imaging server" lead="Connect our viewer, a known-good SMART Imaging app, to your server. When something fails, you'll know it's the server, not the app." sections={[
    { title: "What your server needs", body: <ul className="how">
      <li><strong>CORS</strong> for <code>{location.origin}</code> on discovery, the token endpoint, FHIR searches and image retrieval. The viewer runs in the browser.</li>
      <li><strong>Discovery</strong> that names SMART Imaging by capability: <code>smart-imaging-access</code> with the app-launch capability, at the top level or on an entry in <code>associated_endpoints</code>.</li>
      <li><strong>ImagingStudy search</strong> by <code>patient</code>, with <code>_include=ImagingStudy:endpoint</code> and <code>next</code> links.</li>
      <li><strong>WADO-RS</strong> at each study's <code>Endpoint.address</code>, accepting the token, and <code>503</code> with <code>Retry-After</code> while images are prepared.</li>
    </ul> },
    { title: "Register our viewer with it", body: <RegisterViewer /> },
    { title: "Check it", body: <p>Once it's added, the server check runs every step of the guide against it, as far as it can on its own, and says where it stopped and why: each request, its answer, and what a failure usually means.</p>, links: <><PageLink id="servers" /> <a href={CONFORMANCE_PLAN}>Ideas for more checks, on GitHub</a></> },
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
