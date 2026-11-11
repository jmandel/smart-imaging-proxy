// The server check's steps: every step of SMART Imaging Access, and the refusals it promises, run against one
// server from this page, as far as they can go on their own. A step that later steps depend on stops the run when
// it fails; one they don't depend on fails and the run carries on. Nothing is saved, so the viewer is left as it was.
import { diagnose, type Diagnosis } from "../lib/diagnose";
import { bytes, plural } from "../lib/format";
import { APP_LAUNCH, BACKEND_CAPABILITY, GRANT_FOR, IMAGING, imagingOf, signsIn, type ServerEntry } from "../lib/servers";
import { fhirHeaders, NOT_IMAGES, onlyPart, patientFetch, searchAll, studiesFrom, viewerSeries, WADO_ACCEPT, type Bundle } from "../lib/smart-imaging";
import { connectBackend, finishSignIn, signInAddress, signInReturn, type ConnectOptions } from "../viewer/connect";
import { memoryKeeper, type Session } from "../viewer/session";
import { curlOf, HttpError, requestLine, Trail, type Step } from "../viewer/trail";

/** A step's state. "note" is a step with nothing to check on this server, such as paging when everything fits one page. */
export type Mark = "todo" | "running" | "paused" | "pass" | "fail" | "skip" | "note" | "unreached";
/** One thing a step looked at in an answer, and whether it was there. */
export interface Seen { ok: boolean; text: string }
export interface Line { title: string; mark: Mark; said?: string; seen?: Seen[]; diagnosis?: Diagnosis; trail: Trail }

export const WORD: Record<Mark, string> = { todo: "To do", running: "Running", paused: "Waiting for you", pass: "Passed", fail: "Failed", skip: "Skipped", note: "Nothing to check", unreached: "Not reached" };
export const kindOf = (s: Pick<ServerEntry, "mode" | "auth">) => s.mode === "backend" ? "backend service" : s.auth === "private_key_jwt" ? "confidential app" : "public app";
/** The patients every sandbox has, for asking about one the token isn't for. */
const SANDBOX_PATIENTS = ["riley-example", "robin-example", "sam-example", "josh-example"];
/** A sandbox's base, when `iss` is one of this site's sandboxes: "" for the root's. */
export function sandboxOf(iss: string): string | undefined {
  const m = iss.match(/^(.*?)(\/s\/[^/]+)?\/fhir$/);
  return m && m[1] === location.origin ? m[2] ?? "" : undefined;
}

const TITLES = (backend: boolean) => [
  "Discovery is readable from this page",
  backend ? "A token endpoint for backend services" : "Sign-in endpoints",
  "SMART Imaging is advertised",
  backend ? "A token for the service" : "Sign in for a token",
  "The imaging search answers",
  "Next links stay on the imaging server",
  "The search is refused without the token",
  "Another patient's studies aren't returned",
  "Every study names where its images are",
  "An image is retrieved with the token",
  "The image is refused without the token",
  "A 503 with Retry-After is waited out",
];
export const STEP_COUNT = TITLES(false).length;
export const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1).replace(/\.$/, "");
const hostOf = (url: string) => { try { return new URL(url).host; } catch { return url; } };
/** The run was replaced by another, or the page left: it records nothing more. */
export class Abandoned extends Error {}

/** A GET, recorded as a step. Its body is kept as bytes, so the check can look inside it. */
async function recorded(trail: Trail, step: Pick<Step, "id" | "title" | "kind">, url: string, headers: Record<string, string>) {
  const request = requestLine("GET", url, headers), curl = curlOf(url, headers), started = performance.now();
  let waited: Step["waited"];
  try {
    const res = await patientFetch(url, { headers }, seconds => { waited = { seconds: (waited?.seconds ?? 0) + seconds, times: (waited?.times ?? 0) + 1 }; });
    const buffer = await res.arrayBuffer(), type = res.headers.get("content-type");
    const readable = /json|text|xml/i.test(type ?? "") ? new TextDecoder().decode(buffer.slice(0, 1600)) : `${plural(buffer.byteLength, "byte")} of ${type ?? "unnamed content"}`;
    const shown: Step = { ...step, request, curl, status: `${res.status}`, ms: Math.round(performance.now() - started), response: `HTTP ${res.status}\ncontent-type: ${type ?? "(none)"}\n\n${readable}`, ...(waited ? { waited } : {}) };
    return { res, buffer, type, shown };
  } catch (error) {
    return { error, shown: { ...step, request, curl, failed: true, response: String(error) } as Step };
  }
}
/** Whether a retrieval's body is one DICOM instance, as WADO-RS sends it: a multipart part holding a Part 10 file. */
function isDicom(buffer: ArrayBuffer, type: string | null) {
  if (!/multipart\/related/i.test(type ?? "")) return false;
  try { const part = new Uint8Array(onlyPart(buffer, type)); return new TextDecoder().decode(part.subarray(128, 132)) === "DICM"; } catch { return false; }
}
const parsed = (buffer: ArrayBuffer): any => { try { return JSON.parse(new TextDecoder().decode(buffer)); } catch { return undefined; } };
const studyCount = (b: any) => (b?.entry ?? []).filter((e: any) => e?.resource?.resourceType === "ImagingStudy").length;

export interface RunOptions {
  /** Shows the lines as they change. */
  show: (lines: Line[]) => void;
  /** Waits for the person to press "Sign in to continue", and gives the tab that press opened. */
  signIn: () => Promise<Window | null>;
  /** Whether this run is still the page's. */
  live: () => boolean;
  /** Signs the client's assertion, when its key isn't in the entry. */
  assertion?: ConnectOptions["assertion"];
}

/** Runs every step against `server`. */
export async function runCheck(server: ServerEntry, { show, signIn, live, assertion }: RunOptions) {
  const backend = server.mode === "backend", keeper = memoryKeeper();
  const lines: Line[] = TITLES(backend).map(title => ({ title, mark: "todo", trail: new Trail([], keeper) }));
  const set = (i: number, patch: Partial<Line>) => { if (!live()) throw new Abandoned(); lines[i] = { ...lines[i]!, ...patch }; show([...lines]); };
  /** Ends step `i` as failed, and the steps after it as not reached. */
  const stop = (i: number, said: string, more: Partial<Line> = {}) => {
    set(i, { mark: "fail", said, ...more });
    for (let k = i + 1; k < lines.length; k++) set(k, { mark: "unreached" });
  };
  const failure = (e: unknown, what: string) => e instanceof HttpError ? `${what} answered ${e.status}` : e instanceof TypeError ? `the browser couldn't read the answer from ${what}` : lower((e as Error).message.replace(/ Connect again\.$/, ""));
  const step = (i: number) => { set(i, { mark: "running" }); return lines[i]!.trail; };

  // 1. Discovery, read from this page: an answer it may read is CORS for this origin.
  let config: any;
  try {
    config = await step(0).traced({ id: "discover", kind: "discover", title: "Read the SMART configuration" }, `${server.iss}/.well-known/smart-configuration`);
  } catch (e) {
    return stop(0, e instanceof HttpError ? `discovery answered ${e.status}` : e instanceof SyntaxError ? "discovery didn't answer with JSON" : "this page couldn't read discovery (no answer, or none with CORS for this origin)");
  }
  if (typeof config !== "object" || !config) return stop(0, "discovery didn't answer with a JSON object");
  set(0, { mark: "pass", said: `Read from ${hostOf(server.iss)}, with CORS for this page` });

  // 2. Where to sign in and get a token, and the ways this kind of client needs.
  step(1);
  const has = (field: string, value: string) => Array.isArray(config[field]) && config[field].includes(value);
  const endpoints: Seen[] = [
    ...(backend ? [] : [{ ok: typeof config.authorization_endpoint === "string", text: "authorization_endpoint" }]),
    { ok: typeof config.token_endpoint === "string", text: "token_endpoint" },
  ];
  const ways: Seen[] = [
    ...(backend ? [] : [{ ok: has("code_challenge_methods_supported", "S256"), text: "code_challenge_methods_supported includes S256 (PKCE)" }]),
    ...(signsIn(server) ? [{ ok: has("token_endpoint_auth_methods_supported", "private_key_jwt"), text: "token_endpoint_auth_methods_supported includes private_key_jwt" }] : []),
    ...(backend ? [{ ok: has("grant_types_supported", "client_credentials"), text: "grant_types_supported includes client_credentials" }] : []),
  ];
  const seen = [...endpoints, ...ways], missing = seen.filter(s => !s.ok).map(s => s.text.split(" ")[0]!);
  if (endpoints.some(s => !s.ok)) return stop(1, `discovery names no ${missing.join(" or ")}`, { seen });
  // A missing way of signing in is a fault, but the token may still come: the check carries on to find out.
  set(1, missing.length ? { mark: "fail", said: `discovery doesn't offer ${missing.join(" or ")}`, seen } : { mark: "pass", said: `Token endpoint at ${hostOf(config.token_endpoint)}${backend ? ", with client_credentials and private_key_jwt" : ", with PKCE S256"}`, seen });

  // 3. SMART Imaging, for this way of connecting, or the imaging server given under Advanced.
  step(2);
  const mode = backend ? BACKEND_CAPABILITY : APP_LAUNCH, how = backend ? "backend services" : "app launch";
  const found = imagingOf(config, server.iss, mode), imaging = (found?.url ?? server.imaging)?.replace(/\/$/, "");
  const advertised: Seen[] = [
    { ok: !!found, text: `${found && !found.unified ? "associated_endpoints[].capabilities" : "capabilities"} includes ${IMAGING}, and grant_types_supported includes ${GRANT_FOR[mode]}` },
    ...(found ? [] : [{ ok: !!server.imaging, text: `the imaging server under Advanced${server.imaging ? `: ${server.imaging}` : " is set"}` }]),
  ];
  if (!imaging) return stop(2, `discovery doesn't advertise ${IMAGING} with ${how}, and no imaging server is set under Advanced`, { seen: advertised });
  set(2, { mark: "pass", seen: advertised, said: found ? (found.unified ? `Advertised at the top level, with ${how}: imaging is this FHIR server` : `Advertised with ${how} on associated_endpoints: ${found.url}`) : `Not advertised; using the imaging server set under Advanced: ${imaging}` });

  // 4. A token: a person signs in, in a tab of their own, or the service proves its key.
  const trail = lines[3]!.trail;
  let session: Session;
  if (backend) {
    step(3);
    try { session = await connectBackend(trail, server, { keeper, config, assertion }); }
    catch (e) { if (!live()) throw new Abandoned(); return stop(3, failure(e, "the token endpoint")); }
  } else {
    set(3, { mark: "paused", said: "Waiting for you to sign in" });
    const tab = await signIn();
    set(3, { mark: "running", said: undefined });
    if (!tab) return stop(3, "the browser blocked the sign-in tab (allow pop-ups for this site, and run again)");
    try {
      const { url, state } = await signInAddress(trail, server, { keeper, config });
      tab.location.href = url.toString();
      session = await finishSignIn(trail, await signInReturn(tab, state), { keeper, assertion });
    } catch (e) { tab.close(); if (!live()) throw new Abandoned(); return stop(3, failure(e, "the token endpoint")); }
  }
  set(3, { mark: "pass", said: backend ? `Token granted; searching for patient ${session.patient}, as the entry says` : `Token granted for patient ${session.patient}` });

  // 5. The imaging search, every page of it, with the token. Each page's next link is kept for step 6.
  const search = step(4), headers = fhirHeaders(session.token);
  const first = `${imaging}/ImagingStudy?patient=${encodeURIComponent(session.patient)}&_include=ImagingStudy:endpoint`;
  const nexts: { from: string; next: string }[] = [];
  const page = (trail: Trail, id: string, title: string) => async (url: string, n: number) => {
    const bundle = await trail.traced<Bundle & { resourceType?: string }>({ id: `${id}-${n}`, kind: "imaging", title: n === 1 ? title : `Page ${n}` }, url, { headers });
    if (bundle?.resourceType !== "Bundle") {
      trail.add({ ...trail.steps.at(-1)!, failed: true, diagnosis: diagnose("imaging", url, { wrong: "not-bundle" }) });
      throw new Error(`The imaging search answered ${bundle?.resourceType ?? "something"}, not a Bundle.`);
    }
    const next = bundle.link?.find(l => l.relation === "next")?.url;
    if (next) nexts.push({ from: url, next });
    return bundle;
  };
  let result: Awaited<ReturnType<typeof searchAll>>;
  try { result = await searchAll(first, page(search, "search", "Search for the patient's studies")); }
  catch (e) { return stop(4, failure(e, "the imaging search")); }
  const studies = studiesFrom(result.entries), pages = search.steps.length;
  set(4, { mark: "pass", said: `${plural(studies.length, "study", "studies")}, on ${plural(pages, "page")}${result.incomplete ? "; the server says some are missing" : ""}` });

  // 6. Paging: a small page, so there's a next link to look at, and every next link on the imaging server's origin.
  const paging = step(5), home = new URL(first).origin;
  if (studies.length > 1 && !nexts.length) {
    try { await searchAll(`${first}&_count=1`, page(paging, "paged", "Search with _count=1, for a next link")); } catch { /* A server may refuse _count: what links it gave are still checked. */ }
  }
  const away = nexts.filter(l => { try { return new URL(l.next, l.from).origin !== home; } catch { return true; } });
  if (away.length) {
    const at = paging.steps.at(-1) ?? search.steps.at(-1)!;
    (paging.steps.length ? paging : search).add({ ...at, diagnosis: diagnose("imaging", away[0]!.from, { wrong: "off-origin" }) });
    set(5, { mark: "fail", said: `a next link goes to ${hostOf(new URL(away[0]!.next, away[0]!.from).toString())}, off the imaging server at ${new URL(home).host}; it wasn't followed`, diagnosis: diagnose("imaging", away[0]!.from, { wrong: "off-origin" }), seen: nexts.map(l => ({ ok: !away.includes(l), text: l.next })) });
  } else if (nexts.length) set(5, { mark: "pass", said: `${plural(nexts.length, "next link")}, all on ${new URL(home).host}`, seen: nexts.map(l => ({ ok: true, text: l.next })) });
  else set(5, { mark: "note", said: studies.length > 1 ? `Every study came on one page, even with _count=1, so there was no next link to check` : "There's at most one study, so no next link to check" });

  // 7. The same search with no token: nothing about a patient's imaging without their sign-in.
  const bare = await recorded(step(6), { id: "search-bare", kind: "imaging", title: "Search with no token" }, first, { accept: "application/fhir+json" });
  if (!live()) throw new Abandoned();
  if (!bare.res) {
    const diagnosis = diagnose("imaging", first, { wrong: "no-cors-refusal" });
    lines[6]!.trail.add({ ...bare.shown, diagnosis });
    set(6, { mark: "fail", said: "the browser couldn't read the answer, so whether it refused can't be told from this page", diagnosis });
  } else if (bare.res.status === 401 || bare.res.status === 403) {
    lines[6]!.trail.add(bare.shown);
    set(6, { mark: "pass", said: `Refused with ${bare.res.status}` });
  } else {
    const n = studyCount(parsed(bare.buffer)), diagnosis = diagnose("imaging", first, bare.res.ok ? { wrong: "open-search" } : { status: bare.res.status });
    lines[6]!.trail.add({ ...bare.shown, failed: true, diagnosis });
    set(6, { mark: "fail", said: bare.res.ok ? `with no token, the search answered ${bare.res.status}${n ? ` with ${plural(n, "study", "studies")}` : ", though with no studies"}, not 401 or 403` : `with no token, the search answered ${bare.res.status}, not 401 or 403`, diagnosis });
  }

  // 8. Another patient's studies, with this patient's token. A sandbox has real other patients; any other server, a made-up id.
  const other = step(7), sandbox = sandboxOf(server.iss) !== undefined;
  if (backend) set(7, { mark: "note", said: "A backend service may be granted many patients, so another patient's studies may be its own to see; not checked" });
  else {
    const who = sandbox ? SANDBOX_PATIENTS.find(p => p !== session.patient)! : `not-a-patient-${crypto.randomUUID().slice(0, 8)}`;
    const url = `${imaging}/ImagingStudy?patient=${encodeURIComponent(who)}&_include=ImagingStudy:endpoint`;
    const got = await recorded(other, { id: "search-other", kind: "imaging", title: `Search for ${who}'s studies with ${session.patient}'s token` }, url, headers);
    if (!live()) throw new Abandoned();
    const caveat = sandbox ? "" : ". A made-up id shows only that the server doesn't hand out an arbitrary patient's studies, not that it keeps real patients apart";
    if (!got.res) {
      other.add({ ...got.shown, diagnosis: diagnose("imaging", url, { error: got.error }) });
      set(7, { mark: "fail", said: `the browser couldn't read the answer from ${hostOf(url)}` });
    } else {
      const body = parsed(got.buffer), n = studyCount(body), refused = [401, 403, 404].includes(got.res.status);
      if (refused || (got.res.ok && body?.resourceType === "Bundle" && n === 0)) {
        other.add(got.shown);
        set(7, { mark: "pass", said: `${refused ? `Refused with ${got.res.status}` : "An empty Bundle"} for ${who}, with ${session.patient}'s token${caveat}` });
      } else {
        const diagnosis = got.res.ok ? diagnose("imaging", url, { wrong: "other-patient", other: who }) : diagnose("imaging", url, { status: got.res.status });
        other.add({ ...got.shown, failed: true, diagnosis });
        set(7, { mark: "fail", said: got.res.ok ? `${session.patient}'s token returned ${plural(n, "study", "studies")} for ${who}` : `the search for ${who} answered ${got.res.status}, not 403 or an empty Bundle`, diagnosis });
      }
    }
  }

  // 9. Where each study's images are: a WADO-RS Endpoint, for the study or every one of its series.
  step(8);
  const skipRest = (from: number, said: string) => { for (let k = from; k < lines.length - 1; k++) set(k, { mark: "skip", said }); waits(); };
  // 12, at the end of any run that got this far: whether a 503 with Retry-After was waited out, from every request made.
  const waits = () => {
    const all = lines.flatMap(l => l.trail.steps), waited = all.filter(s => s.waited);
    if (!waited.length) return set(11, { mark: "note", said: `No answer was a 503 with Retry-After, so there was nothing to wait out (${plural(all.length, "request")} made)` });
    const gaveUp = waited.filter(s => s.status === "503"), seconds = waited.reduce((t, s) => t + s.waited!.seconds, 0);
    set(11, gaveUp.length
      ? { mark: "fail", said: `${gaveUp[0]!.title.toLowerCase()} still answered 503 after waiting ${seconds} s, as Retry-After asked`, seen: waited.map(s => ({ ok: s.status !== "503", text: `${s.title}: ${plural(s.waited!.times, "wait")}, ${s.waited!.seconds} s` })) }
      : { mark: "pass", said: `Waited ${seconds} s, as Retry-After asked, on ${plural(waited.length, "request")}, and each then answered`, seen: waited.map(s => ({ ok: true, text: `${s.title}: ${plural(s.waited!.times, "wait")}, ${s.waited!.seconds} s, then ${s.status}` })) });
  };
  if (!studies.length) return skipRest(8, "This patient has no studies to check");
  const named = (s: (typeof studies)[number]) => !!s.address || (s.series.length > 0 && s.series.every(x => x.address));
  const without = studies.filter(s => !named(s)), withAddress = studies.length - without.length;
  const listed: Seen[] = studies.map(s => ({ ok: named(s), text: `${s.description ?? `ImagingStudy/${s.id}`}${s.address ? `: ${s.address}` : ""}` }));
  if (!withAddress) return stop(8, `none of the ${plural(studies.length, "study", "studies")} names a dicom-wado-rs Endpoint with an address`, { seen: listed });
  set(8, without.length ? { mark: "fail", said: `${without.length} of ${plural(studies.length, "study", "studies")} name no dicom-wado-rs Endpoint with an address`, seen: listed } : { mark: "pass", said: `All ${plural(studies.length, "study", "studies")} name one, at ${[...new Set(studies.map(s => hostOf(s.address ?? s.series[0]!.address!)))].join(", ")}`, seen: listed });

  // 10. One instance of the first study with images, at its Endpoint, with the token.
  const wado = step(9);
  const pick = studies.flatMap(st => viewerSeries(st).filter(s => !NOT_IMAGES.has(s.modality ?? "") && (s.address ?? st.address)).map(s => ({ st, s })))[0];
  if (!pick) return skipRest(9, "No study has an image series at an Endpoint");
  const base = `${pick.s.address ?? pick.st.address}/studies/${pick.st.uid}/series/${pick.s.uid}`;
  let instance = pick.s.instances[0];
  if (!instance) {
    // The study doesn't list its instances: the series' metadata names them.
    try {
      const items = await wado.traced<any[]>({ id: "metadata", kind: "wado", title: "Read the series' metadata for an instance" }, `${base}/metadata`, { headers: { authorization: `Bearer ${session.token}`, accept: "application/dicom+json" } });
      instance = items?.map(o => o?.["00080018"]?.Value?.[0]).find(v => typeof v === "string");
    } catch (e) { return stop(9, failure(e, "the series' metadata")); }
    if (!instance) return stop(9, "the series' metadata names no instance");
  }
  const url = `${base}/instances/${instance}`;
  const got = await recorded(wado, { id: "retrieve", kind: "wado", title: "Retrieve one instance with the token" }, url, { authorization: `Bearer ${session.token}`, accept: WADO_ACCEPT });
  if (!live()) throw new Abandoned();
  if (!got.res) { wado.add({ ...got.shown, diagnosis: diagnose("wado", url, { error: got.error }) }); return stop(9, `the browser couldn't read the answer from ${hostOf(url)}`); }
  if (!got.res.ok) { wado.add({ ...got.shown, failed: true, diagnosis: diagnose("wado", url, { status: got.res.status }) }); return stop(9, `the image server answered ${got.res.status} for an instance of ${pick.st.description ?? pick.st.uid}`); }
  if (!isDicom(got.buffer, got.type)) { wado.add({ ...got.shown, failed: true, diagnosis: diagnose("wado", url, { wrong: "not-dicom" }) }); return stop(9, `the image server answered ${got.type ?? "with no content-type"}, not a DICOM part`); }
  wado.add(got.shown);
  set(9, { mark: "pass", said: `A DICOM part of ${bytes(got.buffer.byteLength)}, from ${hostOf(url)}` });

  // 11. The same address with no token: anyone else asking is refused.
  const open = step(10);
  const unsent = await recorded(open, { id: "retrieve-bare", kind: "wado", title: "Retrieve the same instance with no token" }, url, { accept: WADO_ACCEPT });
  if (!live()) throw new Abandoned();
  if (!unsent.res) {
    const diagnosis = diagnose("wado", url, { wrong: "no-cors-refusal" });
    open.add({ ...unsent.shown, diagnosis });
    set(10, { mark: "fail", said: "the browser couldn't read the answer, so whether it refused can't be told from this page", diagnosis });
  } else {
    const refused = unsent.res.status === 401 || unsent.res.status === 403;
    open.add(refused ? unsent.shown : { ...unsent.shown, failed: true, diagnosis: diagnose("wado", url, unsent.res.ok ? { wrong: "open" } : { status: unsent.res.status }) });
    set(10, refused ? { mark: "pass", said: `Refused with ${unsent.res.status}` } : { mark: "fail", said: unsent.res.ok ? `the image server sent the image with no token (${unsent.res.status})` : `the image server answered ${unsent.res.status} with no token, not 401 or 403` });
  }
  waits();
}

/** The one line at the top: how far the check got, and why it stopped. `brief` leaves out the why, for a page that shows the step itself just below. */
export function summary(lines: Line[], brief = false): string {
  const of = lines.length, at = (m: Mark) => lines.findIndex(l => l.mark === m);
  if (!of) return "Starting…";
  if (at("paused") >= 0) return `Waiting at step ${at("paused") + 1} of ${of}: sign in to continue.`;
  if (at("running") >= 0) return `Running step ${at("running") + 1} of ${of}…`;
  const stopped = at("unreached") - 1;
  if (stopped >= 0) return `Stopped at step ${stopped + 1} of ${of}${brief ? "" : `: ${lower(lines[stopped]!.said ?? "it failed")}`}.`;
  const numbers = (m: Mark) => lines.map((l, i) => l.mark === m ? i + 1 : 0).filter(Boolean);
  const list = (ns: number[]) => ns.length === 1 ? `step ${ns[0]}` : `steps ${ns.slice(0, -1).join(", ")} and ${ns.at(-1)}`;
  const passed = numbers("pass").length, failed = numbers("fail"), skipped = numbers("skip"), noted = numbers("note");
  if (passed === of) return `All ${of} steps passed.`;
  const parts = [`${passed} passed`, failed.length && `${list(failed)} failed`, skipped.length && `${list(skipped)} skipped`, noted.length && `${list(noted)} had nothing to check`].filter(Boolean) as string[];
  return `Ran all ${of} steps: ${parts.slice(0, -1).join(", ")}${parts.length > 1 ? ", and " : ""}${parts.at(-1)}.`;
}
