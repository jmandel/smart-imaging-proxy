// What an app developer needs to point an app at a sandbox: its addresses, how to authenticate and what to ask
// for, and the sample people to sign in as. Build an App walks through them in order; a sandbox's Endpoints page
// keeps them for reference.
import { useEffect, useState } from "react";
import { Address } from "../lib/format";
import { imagingOf } from "../lib/servers";
import { PageLink } from "../shell/Shell";

/** A sandbox's FHIR base, discovery and imaging FHIR server, each with a copy button. */
export function Endpoints({ base }: { base: string }) {
  const site = `${location.origin}${base}`;
  // Where imaging is comes from discovery, as an app finds it: the FHIR base itself when the sandbox is one server.
  const [imaging, setImaging] = useState<{ url: string; unified: boolean }>();
  useEffect(() => {
    let live = true;
    fetch(`${site}/fhir/.well-known/smart-configuration`).then(r => r.json()).then(c => { if (live) setImaging(imagingOf(c, `${site}/fhir`)); }, () => undefined);
    return () => { live = false; };
  }, [site]);
  const rows: [string, string][] = [["FHIR base", `${site}/fhir`], ["Discovery", `${site}/fhir/.well-known/smart-configuration`],
    imaging?.unified ? ["Imaging FHIR server (the FHIR base: this sandbox is one server)", `${site}/fhir`] : ["Imaging FHIR server", imaging?.url ?? `${site}/imaging/fhir`]];
  return (
    <dl className="addresses" id="endpoints">
      {rows.map(([name, url]) => <div className="address" key={name}>
        <dt>{name}</dt>
        <dd><Address value={url} name={name} /></dd>
      </div>)}
    </dl>
  );
}

export function AuthNotes({ base }: { base: string }) {
  return (
    <ul className="how">
      <li>Apps use PKCE (S256). Confidential apps also send a <code>private_key_jwt</code> assertion, signed with ES256, ES384 or RS384.</li>
      <li>Ask for <code>launch/patient patient/*.rs</code>. Backend services use <code>client_credentials</code> with <code>system/ImagingStudy.rs</code>, and name the patient in each search.</li>
      <li>Discovery says where imaging is: in <code>associated_endpoints</code> when it's a separate server, or in the top-level <code>capabilities</code> when the sandbox is one server, with imaging at the FHIR base. <PageLink id="config" base={base} /> switches between the two.</li>
    </ul>
  );
}

const PEOPLE: [string, string][] = [["josh", "Six de-identified studies, with reports"], ["sam-caregiver", "Two synthetic studies, and a guardian of Riley"], ["robin", "No studies: a real empty result"]];
/** Who to sign in as: no passwords, just a choice on the sign-in page. */
export function SamplePeople() {
  return <>
    <dl className="registered-facts">{PEOPLE.map(([who, what]) => [<dt key={`${who}-t`}><code>{who}</code></dt>, <dd key={`${who}-d`}>{what}</dd>])}</dl>
    <p className="note">No passwords. Choose the person on the sign-in page, then approve the app.</p>
  </>;
}
