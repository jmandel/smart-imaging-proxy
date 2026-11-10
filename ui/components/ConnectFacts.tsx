// What an app developer needs to point an app at a sandbox: its addresses, how to authenticate and what to ask
// for, and the sample people to sign in as. Build an App walks through them in order; a sandbox's Endpoints page
// keeps them for reference.
import { Address } from "../lib/format";
import { PageLink } from "../shell/Shell";

/** A sandbox's FHIR base, discovery and imaging FHIR server, each with a copy button. */
export function Endpoints({ base }: { base: string }) {
  const site = `${location.origin}${base}`;
  const rows: [string, string][] = [["FHIR base", `${site}/fhir`], ["Discovery", `${site}/fhir/.well-known/smart-configuration`], ["Imaging FHIR server", `${site}/imaging/fhir`]];
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
      <li>Discovery names the imaging FHIR server in <code>associated_endpoints</code>. In <PageLink id="config" base={base} />, the sandbox can instead be one server, with imaging at the FHIR base.</li>
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
