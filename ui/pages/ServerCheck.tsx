// The server check: every step of SMART Imaging Access, run against one of your servers as far as it can go on
// its own, saying how far it got and why it stopped. It pauses only for a person to sign in. Nothing it does is
// saved, so the viewer in this tab is left as it was.
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { diagnose, type Diagnosis } from "../lib/diagnose";
import { announce, bytes, CopyButton, plural } from "../lib/format";
import { APP_LAUNCH, BACKEND_CAPABILITY, IMAGING, imagingOf, useServers, type ServerChoice, type ServerEntry } from "../lib/servers";
import { fhirHeaders, NOT_IMAGES, onlyPart, patientFetch, searchAll, studiesFrom, viewerSeries, WADO_ACCEPT, type Bundle } from "../lib/smart-imaging";
import { PageLink } from "../shell/Shell";
import { connectBackend, finishSignIn, signInAddress, signInReturn } from "../viewer/connect";
import { memoryKeeper, type Session } from "../viewer/session";
import { curlOf, HttpError, requestLine, Trail, useSteps, type Step } from "../viewer/trail";

type Mark = "todo" | "running" | "paused" | "pass" | "fail" | "skip" | "unreached";
/** One thing a step looked at in an answer, and whether it was there. */
interface Seen { ok: boolean; text: string }
interface Line { title: string; mark: Mark; said?: string; seen?: Seen[]; diagnosis?: Diagnosis; trail: Trail }

const GLYPH: Record<Mark, string> = { todo: "", running: "", paused: "…", pass: "✓", fail: "✕", skip: "–", unreached: "" };
const WORD: Record<Mark, string> = { todo: "To do", running: "Running", paused: "Waiting for you", pass: "Passed", fail: "Failed", skip: "Skipped", unreached: "Not reached" };
const kindOf = (s: ServerEntry) => s.mode === "backend" ? "backend service" : s.jwk ? "confidential app" : "public app";
const titles = (backend: boolean) => [
  "Discovery is readable from this page",
  backend ? "A token endpoint for backend services" : "Sign-in endpoints",
  "SMART Imaging is advertised",
  backend ? "A token for the service" : "Sign in for a token",
  "The imaging search answers",
  "Every study names where its images are",
  "An image is retrieved with the token",
  "The image is refused without the token",
];
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1).replace(/\.$/, "");
const hostOf = (url: string) => { try { return new URL(url).host; } catch { return url; } };
/** The run was replaced by another, or the page left: it records nothing more. */
class Abandoned extends Error {}

/** A retrieval, recorded as a step. Its body is kept as bytes, so the check can look inside it. */
async function retrieval(trail: Trail, step: Pick<Step, "id" | "title">, url: string, headers: Record<string, string>) {
  const request = requestLine("GET", url, headers), curl = curlOf(url, headers), started = performance.now();
  try {
    const res = await patientFetch(url, { headers }), buffer = await res.arrayBuffer(), type = res.headers.get("content-type");
    const text = /json|text|xml/i.test(type ?? "") ? new TextDecoder().decode(buffer.slice(0, 1600)) : `${plural(buffer.byteLength, "byte")} of ${type ?? "unnamed content"}`;
    const shown: Step = { ...step, kind: "wado", request, curl, status: `${res.status}`, ms: Math.round(performance.now() - started), response: `HTTP ${res.status}\ncontent-type: ${type ?? "(none)"}\n\n${text}` };
    return { res, buffer, type, shown };
  } catch (error) {
    trail.add({ ...step, kind: "wado", request, curl, failed: true, response: String(error), diagnosis: diagnose("wado", url, { error }) });
    return { error };
  }
}
/** Whether a retrieval's body is one DICOM instance, as WADO-RS sends it: a multipart part holding a Part 10 file. */
function isDicom(buffer: ArrayBuffer, type: string | null) {
  if (!/multipart\/related/i.test(type ?? "")) return false;
  try { const part = new Uint8Array(onlyPart(buffer, type)); return new TextDecoder().decode(part.subarray(128, 132)) === "DICM"; } catch { return false; }
}

/**
 * Runs every step against `server`, showing each line as it changes. `signIn` waits for the person to press
 * "Sign in to continue", and gives the tab that press opened.
 */
async function runCheck(server: ServerEntry, show: (lines: Line[]) => void, signIn: () => Promise<Window | null>, live: () => boolean) {
  const backend = server.mode === "backend", keeper = memoryKeeper();
  const lines: Line[] = titles(backend).map(title => ({ title, mark: "todo", trail: new Trail([], keeper) }));
  const set = (i: number, patch: Partial<Line>) => { if (!live()) throw new Abandoned(); lines[i] = { ...lines[i]!, ...patch }; show([...lines]); };
  /** Ends step `i` as failed, and the steps after it as not reached. */
  const stop = (i: number, said: string, more: Partial<Line> = {}) => {
    set(i, { mark: "fail", said, ...more });
    for (let k = i + 1; k < lines.length; k++) set(k, { mark: "unreached" });
  };
  const skipRest = (from: number, said: string) => { for (let k = from; k < lines.length; k++) set(k, { mark: "skip", said }); };
  const failure = (e: unknown, what: string) => e instanceof HttpError ? `${what} answered ${e.status}` : e instanceof TypeError ? `the browser couldn't read the answer from ${what}` : lower((e as Error).message.replace(/ Connect again\.$/, ""));

  // 1. Discovery, read from this page: an answer it may read is CORS for this origin.
  set(0, { mark: "running" });
  let config: any;
  try {
    config = await lines[0]!.trail.traced({ id: "discover", kind: "discover", title: "Read the SMART configuration" }, `${server.iss}/.well-known/smart-configuration`);
  } catch (e) {
    return stop(0, e instanceof HttpError ? `discovery answered ${e.status}` : e instanceof SyntaxError ? "discovery didn't answer with JSON" : "this page couldn't read discovery (no answer, or none with CORS for this origin)");
  }
  if (typeof config !== "object" || !config) return stop(0, "discovery didn't answer with a JSON object");
  set(0, { mark: "pass", said: `Read from ${hostOf(server.iss)}` });

  // 2. Where to sign in and get a token, and the ways this kind of client needs.
  set(1, { mark: "running" });
  const has = (field: string, value: string) => Array.isArray(config[field]) && config[field].includes(value);
  const endpoints: Seen[] = [
    ...(backend ? [] : [{ ok: typeof config.authorization_endpoint === "string", text: "authorization_endpoint" }]),
    { ok: typeof config.token_endpoint === "string", text: "token_endpoint" },
  ];
  const ways: Seen[] = [
    ...(backend ? [] : [{ ok: has("code_challenge_methods_supported", "S256"), text: "code_challenge_methods_supported includes S256 (PKCE)" }]),
    ...(server.jwk ? [{ ok: has("token_endpoint_auth_methods_supported", "private_key_jwt"), text: "token_endpoint_auth_methods_supported includes private_key_jwt" }] : []),
    ...(backend ? [{ ok: has("grant_types_supported", "client_credentials"), text: "grant_types_supported includes client_credentials" }] : []),
  ];
  const seen = [...endpoints, ...ways], missing = seen.filter(s => !s.ok).map(s => s.text.split(" ")[0]!);
  if (endpoints.some(s => !s.ok)) return stop(1, `discovery names no ${missing.join(" or ")}`, { seen });
  // A missing way of signing in is a fault, but the token may still come: the check carries on to find out.
  set(1, missing.length ? { mark: "fail", said: `discovery doesn't offer ${missing.join(" or ")}`, seen } : { mark: "pass", said: `Token endpoint at ${hostOf(config.token_endpoint)}`, seen });

  // 3. SMART Imaging, for this way of connecting, or the imaging server given under Advanced.
  set(2, { mark: "running" });
  const capability = backend ? BACKEND_CAPABILITY : APP_LAUNCH, how = backend ? "backend services" : "app launch";
  const found = imagingOf(config, server.iss, capability), imaging = (found?.url ?? server.imaging)?.replace(/\/$/, "");
  const advertised: Seen[] = [
    { ok: !!found, text: `${found && !found.unified ? "associated_endpoints[].capabilities" : "capabilities"} includes ${IMAGING} and ${capability}` },
    ...(found ? [] : [{ ok: !!server.imaging, text: `the imaging server under Advanced${server.imaging ? `: ${server.imaging}` : " is set"}` }]),
  ];
  if (!imaging) return stop(2, `discovery doesn't advertise ${IMAGING} with ${how}, and no imaging server is set under Advanced`, { seen: advertised });
  set(2, { mark: "pass", seen: advertised, said: found ? (found.unified ? `Advertised at the top level, with ${how}: imaging is this FHIR server` : `Advertised with ${how} on associated_endpoints: ${found.url}`) : `Not advertised; using the imaging server set under Advanced: ${imaging}` });

  // 4. A token: a person signs in, in a tab of their own, or the service proves its key.
  const trail = lines[3]!.trail;
  let session: Session;
  if (backend) {
    set(3, { mark: "running" });
    try { session = await connectBackend(trail, server, { keeper, config }); }
    catch (e) { return stop(3, failure(e, "the token endpoint")); }
  } else {
    set(3, { mark: "paused", said: "Waiting for you to sign in" });
    const tab = await signIn();
    set(3, { mark: "running", said: undefined });
    if (!tab) return stop(3, "the browser blocked the sign-in tab (allow pop-ups for this site, and run again)");
    try {
      const { url, state } = await signInAddress(trail, server, { keeper, config });
      tab.location.href = url.toString();
      session = await finishSignIn(trail, await signInReturn(tab, state), { keeper });
    } catch (e) { tab.close(); if (!live()) throw new Abandoned(); return stop(3, failure(e, "the token endpoint")); }
  }
  set(3, { mark: "pass", said: backend ? `Token granted; searching for patient ${session.patient}, as the entry says` : `Token granted for patient ${session.patient}` });

  // 5. The imaging search, every page of it, with the token.
  set(4, { mark: "running" });
  const search = lines[4]!.trail, headers = fhirHeaders(session.token);
  let result: Awaited<ReturnType<typeof searchAll>>;
  try {
    result = await searchAll(`${imaging}/ImagingStudy?patient=${encodeURIComponent(session.patient)}&_include=ImagingStudy:endpoint`, async (url, page) => {
      const bundle = await search.traced<Bundle & { resourceType?: string }>({ id: `search-${page}`, kind: "imaging", title: page === 1 ? "Search for the patient's studies" : `Page ${page} of the search` }, url, { headers });
      if (bundle?.resourceType !== "Bundle") {
        const step = search.steps.at(-1)!;
        search.add({ ...step, failed: true, diagnosis: diagnose("imaging", url, { wrong: "not-bundle" }) });
        throw new Error("The imaging search didn't answer with a Bundle.");
      }
      return bundle;
    });
  } catch (e) { return stop(4, failure(e, "the imaging search")); }
  const pages = search.steps.length;
  set(4, { mark: "pass", said: `${plural(result.entries.filter(e => e.resource?.resourceType === "ImagingStudy").length, "study", "studies")}, on ${plural(pages, "page")}${result.incomplete ? "; the server says some are missing" : ""}` });

  // 6. Where each study's images are: a WADO-RS Endpoint, for the study or every one of its series.
  set(5, { mark: "running" });
  const studies = studiesFrom(result.entries);
  if (!studies.length) return skipRest(5, "This patient has no studies to check");
  const named = (s: (typeof studies)[number]) => !!s.address || (s.series.length > 0 && s.series.every(x => x.address));
  const without = studies.filter(s => !named(s)), withAddress = studies.length - without.length;
  const listed: Seen[] = studies.map(s => ({ ok: named(s), text: `${s.description ?? `ImagingStudy/${s.id}`}${s.address ? `: ${s.address}` : ""}` }));
  if (!withAddress) return stop(5, `none of the ${plural(studies.length, "study", "studies")} names a dicom-wado-rs Endpoint with an address`, { seen: listed });
  set(5, without.length ? { mark: "fail", said: `${without.length} of ${plural(studies.length, "study", "studies")} name no dicom-wado-rs Endpoint with an address`, seen: listed } : { mark: "pass", said: `All ${plural(studies.length, "study", "studies")} name one`, seen: listed });

  // 7. One instance of the first study with images, at its Endpoint, with the token.
  set(6, { mark: "running" });
  const wado = lines[6]!.trail;
  const pick = studies.flatMap(st => viewerSeries(st).filter(s => !NOT_IMAGES.has(s.modality ?? "") && (s.address ?? st.address)).map(s => ({ st, s })))[0];
  if (!pick) return skipRest(6, "No study has an image series at an Endpoint");
  const base = `${pick.s.address ?? pick.st.address}/studies/${pick.st.uid}/series/${pick.s.uid}`;
  let instance = pick.s.instances[0];
  if (!instance) {
    // The study doesn't list its instances: the series' metadata names them.
    try {
      const items = await wado.traced<any[]>({ id: "metadata", kind: "wado", title: "Read the series' metadata for an instance" }, `${base}/metadata`, { headers: { authorization: `Bearer ${session.token}`, accept: "application/dicom+json" } });
      instance = items?.map(o => o?.["00080018"]?.Value?.[0]).find(v => typeof v === "string");
    } catch (e) { return stop(6, failure(e, "the series' metadata")); }
    if (!instance) return stop(6, "the series' metadata names no instance");
  }
  const url = `${base}/instances/${instance}`;
  const got = await retrieval(wado, { id: "retrieve", title: "Retrieve one instance with the token" }, url, { authorization: `Bearer ${session.token}`, accept: WADO_ACCEPT });
  if (!live()) throw new Abandoned();
  if (!got.res) return stop(6, `the browser couldn't read the answer from ${hostOf(url)}`);
  if (!got.res.ok) { wado.add({ ...got.shown, failed: true, diagnosis: diagnose("wado", url, { status: got.res.status }) }); return stop(6, `the image server answered ${got.res.status}`); }
  if (!isDicom(got.buffer, got.type)) { wado.add({ ...got.shown, failed: true, diagnosis: diagnose("wado", url, { wrong: "not-dicom" }) }); return stop(6, "the image server didn't answer with a DICOM part"); }
  wado.add(got.shown);
  set(6, { mark: "pass", said: `A DICOM part of ${bytes(got.buffer.byteLength)}, from ${hostOf(url)}` });

  // 8. The same address with no token: anyone else asking is refused.
  set(7, { mark: "running" });
  const open = lines[7]!.trail;
  const bare = await retrieval(open, { id: "retrieve-bare", title: "Retrieve the same instance with no token" }, url, { accept: WADO_ACCEPT });
  if (!live()) throw new Abandoned();
  if (!bare.res) return set(7, { mark: "fail", said: "the browser couldn't read the answer, so whether it refused can't be told from this page" });
  const refused = bare.res.status === 401 || bare.res.status === 403;
  open.add(refused ? bare.shown : { ...bare.shown, failed: true, diagnosis: diagnose("wado", url, bare.res.ok ? { wrong: "open" } : { status: bare.res.status }) });
  set(7, refused ? { mark: "pass", said: `Refused with ${bare.res.status}` } : { mark: "fail", said: bare.res.ok ? `the image server sent the image with no token (${bare.res.status})` : `the image server answered ${bare.res.status}, not 401 or 403` });
}

/** The one line at the top: how far the check got, and why it stopped. */
function summary(lines: Line[]): string {
  const of = lines.length, at = (m: Mark) => lines.findIndex(l => l.mark === m);
  if (at("paused") >= 0) return `Waiting at step ${at("paused") + 1} of ${of}: sign in to continue.`;
  if (at("running") >= 0) return `Running step ${at("running") + 1} of ${of}…`;
  const stopped = at("unreached") - 1;
  if (stopped >= 0) return `Stopped at step ${stopped + 1} of ${of}: ${lower(lines[stopped]!.said ?? "it failed")}.`;
  const failed = lines.map((l, i) => l.mark === "fail" ? i + 1 : 0).filter(Boolean), passed = lines.filter(l => l.mark === "pass").length;
  if (failed.length) return `Ran all ${of} steps: ${passed} passed, and ${failed.length === 1 ? `step ${failed[0]}` : `steps ${failed.slice(0, -1).join(", ")} and ${failed.at(-1)}`} failed.`;
  const skipped = lines.filter(l => l.mark === "skip");
  if (skipped.length) return `Passed ${passed} of ${of} steps, and skipped ${skipped.length}: ${lower(skipped[0]!.said ?? "")}.`;
  return `All ${of} steps passed.`;
}

function Call({ s }: { s: Step }) {
  return (
    <li><details className="call" data-call={s.id} open={s.failed || undefined}>
      <summary><span className="call-title">{s.title}</span><span className={`call-status${s.failed ? " bad" : ""}`}>{s.failed ? "Failed" : s.status ?? "OK"}</span>{s.ms !== undefined && <span className="call-ms">{s.ms} ms</span>}<span className="chevron" aria-hidden="true" /></summary>
      <div className="call-body">
        {s.request && <><h4>Request</h4><pre>{s.request}</pre></>}
        {s.response && <><h4>Response</h4><pre>{s.response}</pre></>}
        {s.curl && <CopyButton label="Copy as curl" value={s.curl} aria="Copy as curl (set $TOKEN first)" />}
      </div>
    </details></li>
  );
}

function StepLine({ n, line, signIn }: { n: number; line: Line; signIn?: () => void }) {
  const calls = useSteps(line.trail);
  // What it most likely means: said once, beside the step, from the request that failed.
  const diagnosis = line.diagnosis ?? (line.mark === "fail" ? calls.findLast(c => c.diagnosis)?.diagnosis : undefined);
  const head = <>
    <span className="mark" aria-hidden="true">{line.mark === "running" ? <span className="spinner" /> : GLYPH[line.mark]}</span>
    <span className="what"><b>{n}. {line.title}</b>{line.said && <span className="said">{capital(line.said)}</span>}</span>
    <span className="state">{WORD[line.mark]}</span>
  </>;
  const more = calls.length > 0 || !!line.seen?.length;
  return (
    <li className="check-step" data-step={n} data-state={line.mark}>
      {more ? <details open={line.mark === "fail" || undefined}>
        <summary>{head}<span className="chevron" aria-hidden="true" /></summary>
        <div className="step-body">
          {diagnosis && <div className="call-diagnosis"><p>{diagnosis.cause}</p>{diagnosis.check && <pre>{diagnosis.check}</pre>}</div>}
          {!!line.seen?.length && <ul className="seen">{line.seen.map((s, i) => <li key={i} data-ok={s.ok}><span aria-hidden="true">{s.ok ? "✓" : "✕"}</span><span className="sr-only">{s.ok ? "Present: " : "Missing: "}</span><code>{s.text}</code></li>)}</ul>}
          {calls.length > 0 && <ul className="call-list">{calls.map(c => <Call key={c.id} s={c} />)}</ul>}
        </div>
      </details> : <div className="step-head">{head}</div>}
      {signIn && <div className="step-action"><button type="button" className="primary" onClick={signIn}>Sign in to continue</button><span className="note">The sign-in opens in a tab of its own, and the check carries on when it comes back.</span></div>}
    </li>
  );
}

function Picker({ servers, unknown }: { servers: ServerChoice[]; unknown?: string }) {
  return (
    <section className="check-picker" aria-labelledby="h-pick">
      {unknown && <p className="error" role="alert">There's no server <code>{unknown}</code> in this browser's list.</p>}
      <h2 id="h-pick">Choose a server to check</h2>
      {servers.length ? <ul className="check-servers">{servers.map(s => (
        <li key={s.id}><Link to={`/check?server=${encodeURIComponent(s.id)}`}><b>{s.label}</b><span>{s.detail}</span><span>{capital(kindOf(s))}</span></Link></li>
      ))}</ul> : <p className="note">None yet. Make a sandbox on <PageLink id="home" />, or add a server of your own.</p>}
      <p>Add or change a server on <PageLink id="servers" />.</p>
    </section>
  );
}

function Run({ server }: { server: ServerChoice }) {
  const [lines, setLines] = useState<Line[]>([]);
  const [attempt, setAttempt] = useState(0);
  const [waiting, setWaiting] = useState<(tab: Window | null) => void>();
  const runs = useRef(0);
  useEffect(() => {
    const run = ++runs.current, live = () => runs.current === run;
    setWaiting(undefined);
    const signIn = () => new Promise<Window | null>(done => setWaiting(() => done));
    runCheck(server, setLines, signIn, live).then(() => { if (live()) announce("The server check finished."); }, e => { if (!(e instanceof Abandoned)) console.error(e); });
    return () => { runs.current++; };
  }, [server.id, attempt]);
  // The tab opens from the press itself, or the browser blocks it.
  const signIn = waiting && (() => { setWaiting(undefined); waiting(open("about:blank", "smart-imaging-sign-in")); });
  const busy = lines.some(l => l.mark === "running");
  return <>
    <div className="check-server">
      <p>Checking <b>{server.label}</b> <code>{server.iss}</code> as a {kindOf(server)}, with client ID <code>{server.clientId}</code>.</p>
      <div className="check-actions">
        <button type="button" className="secondary" id="run-again" onClick={() => setAttempt(a => a + 1)}>Run again</button>
        <Link to="/check">Check another server</Link>
      </div>
    </div>
    <p className={`check-summary${busy ? "" : lines.some(l => l.mark === "fail") ? " bad" : lines.length && lines.every(l => l.mark === "pass") ? " good" : ""}`} id="check-summary" role="status">{lines.length ? summary(lines) : "Starting…"}</p>
    <ol className="check-steps">{lines.map((l, i) => <StepLine key={`${attempt}-${i}`} n={i + 1} line={l} signIn={l.mark === "paused" ? signIn : undefined} />)}</ol>
  </>;
}

export default function ServerCheck() {
  const servers = useServers();
  const [params] = useSearchParams();
  const wanted = params.get("server") ?? undefined, server = servers.find(s => s.id === wanted);
  return (
    <main className="landing check-page">
      <h1>Server check</h1>
      <p className="lead">Every step of SMART Imaging Access, run against one server from this page, as far as it can go on its own. It pauses only for you to sign in, and says how far it got and why it stopped.</p>
      {server ? <Run key={server.id} server={server} /> : <Picker servers={servers} unknown={wanted} />}
    </main>
  );
}
