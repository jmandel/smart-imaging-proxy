// The home page's diagram: what SMART Imaging adds to a SMART sign-in. An app is given one FHIR address, which
// belongs to a group of servers, drawn as a stack: an imaging FHIR server always, and perhaps clinical and other
// FHIR servers behind it, separate or the same one. The group shares one discovery, one sign-in and one token.
// Each study the imaging server finds names an Endpoint, whose address is where its images are: a DICOMweb
// server, anywhere, which takes the same token.
const SHARED: [string, string][] = [
  ["One discovery", "smart-configuration names each server"],
  ["One sign-in", "the patient approves once"],
  ["One token", "accepted by every server, and by DICOMweb"],
];

export function ImagingChain() {
  return (
    <figure className="stack-map" aria-label="The servers behind one SMART Imaging FHIR address, and where a patient's images are">
      <div className="stack-row">
        <div className="stack-behind" aria-hidden="true">
          <div className="stack-card behind b2"><span>Other FHIR servers</span></div>
          <div className="stack-card behind b1"><span>Clinical FHIR server</span></div>
        </div>
        <div className="stack-card front"><b>Imaging FHIR server</b><code>ImagingStudy?patient=…</code></div>
        <div className="stack-link" aria-hidden="true"><code>Endpoint.address</code></div>
        <div className="stack-card images"><b>DICOMweb server</b><code>/studies/{"{uid}"}/…</code></div>
        <p className="stack-note">One server, or several</p>
      </div>
      <ul className="stack-shared" aria-label="What the servers share">
        {SHARED.map(([what, how]) => <li key={what}><b>{what}</b> {how}</li>)}
      </ul>
    </figure>
  );
}
