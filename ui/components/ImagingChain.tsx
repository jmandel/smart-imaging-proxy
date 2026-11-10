// The home page's diagram: what SMART Imaging adds to a SMART sign-in. An app is given one FHIR address, in a
// group of servers that always includes an imaging FHIR server, and may include clinical ones or be just the one.
// From there it follows pointers to a patient's images: discovery names the imaging server, each study names its
// Endpoint, and the Endpoint's address is where the images are. Every hop carries the one token from sign-in.
const HOPS: { server: string; ask: string; answer: string; leads: string }[] = [
  { server: "The FHIR address you're given", ask: "GET .well-known/smart-configuration", answer: "capabilities, associated_endpoints[]", leads: "say which server answers imaging searches: this one, or another the group includes" },
  { server: "Its imaging FHIR server", ask: "GET ImagingStudy?patient=…", answer: "ImagingStudy.endpoint → Endpoint", leads: "each study says where its images are" },
  { server: "A DICOMweb server", ask: "GET {Endpoint.address}/studies/{uid}/…", answer: "DICOM instances", leads: "the images, for the viewer to decode" },
];

export function ImagingChain() {
  return (
    <figure className="chain-map" aria-labelledby="chain-map-title">
      <h2 id="chain-map-title">From one FHIR address to a patient's images</h2>
      <ol className="chain-hops">
        {HOPS.map(h => (
          <li key={h.server} className="chain-hop">
            <b className="chain-server">{h.server}</b>
            <code>{h.ask}</code>
            <span className="chain-answer"><code>{h.answer}</code> {h.leads}</span>
          </li>
        ))}
      </ol>
      <p className="chain-token"><span>One access token, from the patient's sign-in, at every step</span></p>
    </figure>
  );
}
