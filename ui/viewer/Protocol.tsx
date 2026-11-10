// The protocol panel: "How this app connected", as five stages on one line of travel. Requests are the detail;
// the stages are the story. Each stage's requests open to what was sent and what came back.
import { useEffect, useRef, useState } from "react";
import { plural } from "../lib/format";
import { useSteps, type Step, type StepKind, type Trail } from "./trail";

const IG = "https://build.fhir.org/ig/argonautproject/smart-imaging/", SMART = "https://build.fhir.org/ig/HL7/smart-app-launch/";
interface Stage { key: string; from: string; to: string; name: string; line: string; kinds: StepKind[]; spec: [string, string] }
/** The protocol as the client meets it. */
const STAGES: Stage[] = [
  { key: "discover", from: "This app", to: "The FHIR server it was given", name: "Discover", line: "From one FHIR address, find the sign-in page and the imaging server: the same server, or another.", kinds: ["discover"], spec: [`${SMART}conformance.html`, "SMART discovery"] },
  { key: "authorize", from: "Browser and app", to: "Authorization server", name: "Authorize", line: "Sign in, approve this app, and receive an access token for one patient.", kinds: ["authorize", "token", "backend-token"], spec: [`${SMART}app-launch.html`, "SMART App Launch"] },
  { key: "clinical", from: "This app", to: "Clinical FHIR server", name: "Read the chart", line: "Query the clinical server with that token.", kinds: ["patient", "clinical"], spec: [`${SMART}scopes-and-launch-context.html`, "SMART scopes and launch context"] },
  { key: "imaging", from: "This app", to: "Imaging FHIR server", name: "Find studies", line: "Ask the imaging server for studies, and where to retrieve each one.", kinds: ["imaging"], spec: [IG, "SMART Imaging Access"] },
  { key: "retrieve", from: "This app", to: "DICOMweb endpoint", name: "Retrieve images", line: "Download DICOM from each study's Endpoint, and decode it in the browser.", kinds: ["wado"], spec: ["https://www.dicomstandard.org/using/dicomweb/retrieve-wado-rs-and-wado-uri", "DICOMweb WADO-RS"] },
];
const WHY: Record<StepKind, string> = {
  discover: "The app reads the SMART configuration at its FHIR address. That says where to sign in, and associated_endpoints names the imaging server, chosen by its smart-imaging-access capability.",
  authorize: "The app sends the browser to the sign-in page with the scopes it wants and a PKCE challenge. It never sees the password, and it gets back a one-time code.",
  "backend-token": "A backend service has no user to sign in. It proves its identity with an assertion signed by its private key, and the server checks that against the public key it registered. What it can reach was granted in advance.",
  token: "The app sends that code with its PKCE verifier. The response has an access token and the patient it applies to.",
  patient: "The app reads the patient named in the token response.",
  clinical: "An ordinary FHIR search on the clinical server, using the access token.",
  imaging: "The same access token, sent to the imaging server found during discovery. Each study comes back with an Endpoint saying where to retrieve its images.",
  wado: "A DICOMweb WADO-RS retrieval from the address in the study's Endpoint, still sending the access token. Each request is one DICOM instance.",
};
/** Which system answered each kind of request. */
const ANSWERED_BY: Record<StepKind, string> = { "backend-token": "Authorization server", discover: "The FHIR server the app was given", authorize: "Authorization server", token: "Authorization server", patient: "Clinical FHIR server", clinical: "Clinical FHIR server", imaging: "Imaging FHIR server", wado: "DICOMweb endpoint" };
type State = "done" | "failed" | "waiting";
const GLYPH: Partial<Record<State, string>> = { done: "✓", failed: "✕" };
const STATE_WORD: Record<State, string> = { done: "Done", failed: "Failed", waiting: "Not yet" };

/** Copies a request as curl. The token is left as $TOKEN, so it says to set that. */
function CurlButton({ curl }: { curl: string }) {
  const [said, setSaid] = useState<string>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    try { await navigator.clipboard.writeText(curl); setSaid("Copied. Set $TOKEN first"); } catch { setSaid("Couldn't copy"); }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setSaid(undefined), 2500);
  };
  return <button type="button" className="tool copy" onClick={copy}>{said ?? "Copy as curl"}</button>;
}

function Call({ s }: { s: Step }) {
  return (
    <li><details className="call" data-call={s.id} open={s.failed || undefined}>
      <summary><span className="call-title">{s.title}</span><span className={`call-status${s.failed ? " bad" : ""}`}>{s.failed ? "Failed" : s.status ?? "OK"}</span>{s.ms !== undefined && <span className="call-ms">{s.ms} ms</span>}<span className="chevron" aria-hidden="true" /></summary>
      <div className="call-body">
        <p className="call-why">{WHY[s.kind]}</p>
        <dl className="call-facts"><dt>Answered by</dt><dd>{ANSWERED_BY[s.kind]}</dd></dl>
        {s.diagnosis && <div className="call-diagnosis"><p>{s.diagnosis.cause}</p>{s.diagnosis.check && <pre>{s.diagnosis.check}</pre>}</div>}
        {s.request && <><h4>Request</h4><pre>{s.request}</pre></>}
        {s.response && <><h4>Response</h4><pre>{s.response}</pre></>}
        {s.curl && <CurlButton curl={s.curl} />}
      </div>
    </details></li>
  );
}

function StageRow({ stage, index, steps }: { stage: Stage; index: number; steps: Step[] }) {
  const state: State = steps.some(s => s.failed) ? "failed" : steps.length ? "done" : "waiting";
  // A service never signs anyone in, so that stage says what it does instead.
  const shown = steps.some(s => s.kind === "backend-token") ? { ...stage, from: "This service", line: "Prove this service's identity with a signed assertion, and receive an access token." } : stage;
  const facts = Object.entries(Object.assign({}, ...steps.map(s => s.facts ?? {})) as Record<string, string | number>);
  // A summary step carries the stage's totals; the rest are the requests.
  const requests = steps.filter(s => !s.summary);
  return (
    <li className="stage-row" data-stage={stage.key} data-state={state}>
      <span className="node" aria-hidden="true">{GLYPH[state] ?? index + 1}</span>
      <div className="stage-body">
        <h3>{shown.name}<span className="sr-only"> ({STATE_WORD[state]})</span></h3>
        <p className="parties"><span>{shown.from}</span><span className="arrow" aria-hidden="true">→</span><span className="sr-only">talks to</span><span>{shown.to}</span></p>
        <p className="line">{shown.line}</p>
        {facts.length > 0 && <dl className="facts-grid">{facts.map(([k, v]) => <div key={k} className={`fact${String(v).length > 12 ? " long" : ""}`}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>}
        {requests.length > 0 && (
          <details className="calls" open={state === "failed" || undefined}>
            <summary>{plural(requests.reduce((n, s) => n + (s.count ?? 1), 0), "request")}{requests.some(s => s.count) ? `, across ${plural(requests.length, "study", "studies")}` : ""}</summary>
            <ul className="call-list">{requests.map(s => <Call key={s.id} s={s} />)}</ul>
            <p className="spec">Underlying standard: <a href={stage.spec[0]} target="_blank" rel="noopener">{stage.spec[1]}</a></p>
          </details>
        )}
      </div>
    </li>
  );
}

export function Protocol({ trail }: { trail: Trail }) {
  const steps = useSteps(trail);
  // A service reads no chart.
  const service = steps.some(s => s.kind === "backend-token");
  const stages = STAGES.filter(st => !(service && st.key === "clinical"));
  return (
    <section className="protocol panel" aria-labelledby="protocol-title">
      <h2 id="protocol-title">How this app connected</h2>
      <ol id="trail">{stages.map(st => <StageRow key={st.key} stage={st} index={STAGES.indexOf(st)} steps={steps.filter(s => st.kinds.includes(s.kind))} />)}</ol>
    </section>
  );
}
