// The app check's grading: what a run asks a person to do with their app, what the sandbox stages while it runs,
// and, from the sandbox's activity log, which of the guide's requirements on apps the app met or broke. Only clear
// requirements are graded, each with its source; what an app relied on that the spec doesn't promise is a note.
// An app's requests are found by its tokens: `token.issued` names the client, a search names it too, and a
// retrieval carries its token's hash, or with no token, the hash of an address a search issued to one of them.
import type { EventRecord } from "./trace";
import type { Faults } from "./sandbox";

export interface Source { doc: string; section: string; url: string; text: string }
const SIA = "https://build.fhir.org/ig/argonautproject/smart-imaging/specification.html";
const sia = (section: string, anchor: string, text: string): Source => ({ doc: "SMART Imaging Access", section, url: `${SIA}#${anchor}`, text });
/** Where each graded requirement and each note comes from, quoted. */
export const SOURCES = {
  sameToken: sia("Retrieving images", "retrieving-images", "It SHALL send the same SMART access token used for the authorized FHIR request in the Authorization header."),
  opaque: sia("Retrieving images", "retrieving-images", "Clients SHALL treat returned addresses as opaque base URLs, preserve their capability information when constructing retrieval paths, and protect them from unintended disclosure."),
  designated: sia("Token validation and access enforcement, Responsibilities by actor", "token-validation-and-access-enforcement-both-modes", "The App, including a Backend Client, SHALL treat the access token as a secret and present it only to the Authorization Server, the Clinical FHIR Server covered by the authorization, the Imaging Server's FHIR endpoint, and WADO-RS endpoints the Imaging Server has designated (via Endpoint.address)."),
  forms: sia("Finding studies", "finding-studies", "An Endpoint may be a response-local Bundle entry, a separately addressable resource included in the Bundle, or a contained resource within an ImagingStudy. Apps SHALL support all three forms and resolve references using the FHIR Bundle reference-resolution rules."),
  accept: { doc: "DICOM PS3.18 (DICOMweb)", section: "8.4.1.1 Accept", url: "https://dicom.nema.org/medical/dicom/current/output/html/part18.html#sect_8.4.1.1", text: "All requests that might have a response containing a payload shall provide an Accept Header Field." },
  retry: sia("Finding studies, Delayed search results", "finding-studies", "The app SHOULD wait the indicated number of seconds and repeat the identical request."),
  retrieval503: sia("Retrieving images", "retrieving-images", "If assembling authorized data takes time (for example, a C-MOVE from a PACS under the hood), the endpoint MAY respond 503 with a Retry-After header, exactly as in Finding studies."),
  paging: { doc: "FHIR R4 RESTful API", section: "3.1.0.14 Paging", url: "https://hl7.org/fhir/R4/http.html#paging", text: "The links are opaque to the client, have no dictated structure, and only the server understands them. The client must use the server supplied links in order to traverse the pages." },
  count: { doc: "FHIR R4 Search", section: "3.1.1.5.3 Page Count", url: "https://hl7.org/fhir/R4/search.html#count", text: "Servers SHALL NOT return more resources than requested, even if they don't support paging, but may return less than the client requested." },
  richer: sia("Retrieving images, Additional retrieval operations", "retrieving-images", "Servers SHOULD support […] Frame-level retrieval […] Rendered images […]. Apps SHOULD degrade gracefully: try the richer request, fall back to full-study retrieval if the server doesn't offer it."),
  include: sia("Finding studies", "finding-studies", "The Imaging FHIR Server SHALL support _include=ImagingStudy:endpoint so that referenced Endpoints are returned in the search Bundle."),
  patient: sia("Finding studies, Access control", "finding-studies", "In App Launch mode, the patient search parameter SHALL match the token's patient context; a mismatch receives 403 Forbidden, not an empty Bundle."),
} satisfies Record<string, Source>;

/** What a run asks the person to do, and what a new sandbox releases for it: the expected answers in llms.txt. */
export interface Script { id: string; title: string; kind: "launch" | "backend"; user?: string; patient: string; steps: string[]; newSandbox: { released: number; of: number } }
export const SCRIPTS: Script[] = [
  { id: "josh", title: "Josh's own studies", kind: "launch", user: "josh", patient: "josh-example", newSandbox: { released: 6, of: 6 },
    steps: ["Sign in as josh, and approve everything offered.", "Find every study: a new sandbox has 6.", "Open every study."] },
  { id: "riley", title: "Riley, by her guardian", kind: "launch", user: "sam-caregiver", patient: "riley-example", newSandbox: { released: 1, of: 2 },
    steps: ["Sign in as sam-caregiver, choose Riley, and approve everything offered.", "Find Riley's studies: a correct app gets 1 of her 2, since the other is confidential care that Sam can't see.", "Open the study it finds."] },
  { id: "robin", title: "Robin, with no studies", kind: "launch", user: "robin", patient: "robin-example", newSandbox: { released: 0, of: 0 },
    steps: ["Sign in as robin, and approve.", "Search for Robin's studies: there are none.", "Show that there are none, without an error."] },
  { id: "service", title: "A backend service, for Josh", kind: "backend", patient: "josh-example", newSandbox: { released: 6, of: 6 },
    steps: ["Get a token as the service, with system/ImagingStudy.rs.", "Search for josh-example's studies.", "Retrieve every study it finds."] },
];
export const scriptById = (id: string) => SCRIPTS.find(s => s.id === id);

/** What a run stages: things the guide or FHIR lets any server do, as the sandbox's faults. */
export interface Condition { id: string; text: string; faults: Partial<Faults> }
export const CONDITIONS: Condition[] = [
  { id: "small-pages", text: "Search pages hold at most 2 studies, so the rest are behind next links", faults: { pageSize: 2 } },
  { id: "search-503", text: "The first search answers 503 with Retry-After: 1", faults: { searchRetryAfter: 1 } },
  { id: "retrieval-503", text: "The first retrieval answers 503 with Retry-After: 1", faults: { retrievalRetryAfter: 1 } },
  { id: "endpoint-forms", text: "Endpoints come in all three forms the guide allows: a response-local entry, contained in the study, and an entry with its own address", faults: { endpointForms: true } },
];
export const STAGED_FAULTS: (keyof Faults)[] = ["pageSize", "searchRetryAfter", "retrievalRetryAfter", "endpointForms"];
/** The faults a run's conditions set: every staged one, the rest off. */
export function faultsFor(conditions: string[]): Partial<Faults> {
  const off: Partial<Faults> = { pageSize: null, searchRetryAfter: null, retrievalRetryAfter: null, endpointForms: false };
  return Object.assign(off, ...CONDITIONS.filter(c => conditions.includes(c.id)).map(c => c.faults));
}

export type GradeState = "pass" | "fail" | "note" | "unreached";
export interface Request { request: string; response: string; log?: string }
export interface GradedStep { n: number; group: "script" | "requirement"; title: string; state: GradeState; result: string; sources?: Source[]; requests: Request[] }
export interface Note { title: string; detail: string; sources: Source[]; requests: Request[] }
export interface Graded { summary: string; steps: GradedStep[]; notes: Note[]; notChecked: string[] }

/** What no app check looks at, so a pass isn't read as more than it is. */
export const NOT_CHECKED = [
  "Signing in: PKCE, state, aud and client assertions are enforced by the sign-in server, so an app that breaks them gets no token, but they aren't graded here",
  "Token expiry and renewal: no token expires during a run",
  "Approving less at sign-in: the script approves everything offered",
  "Reports and clinical data: only imaging searches and retrievals are graded",
  "Discovery: reading smart-configuration can't be tied to the app",
  "What the app shows: the check sees requests, not the screen",
];

/** The events grading reads: the client's tokens, whenever issued; the addresses issued to them; and the run's events. */
export interface Evidence { tokens: EventRecord[]; contexts: EventRecord[]; events: EventRecord[] }
export interface GradeInput {
  client: string; script: Script; conditions: string[]; evidence: Evidence;
  /** The imaging FHIR base and the proxy base, for writing requests out. */
  imaging: string; proxy: string;
  /** A link to the log, at an event, from the token it names. */
  log: (tokenHash: string | undefined, seq: number | undefined) => string | undefined;
}

const MAX_REQUESTS = 8;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const IMAGE_RESOURCES = new Set(["study", "series", "instance", "bulk"]);
const RICHER = new Set(["frames", "rendered", "thumbnail"]);

/** The app's requests in a run, sorted out of the log. */
function sortOut(input: GradeInput) {
  const { client, evidence } = input;
  const issued = evidence.tokens.filter(e => e.kind === "token.issued" && e.data.client === client);
  const tokens = new Map(issued.map(e => [String(e.data.tokenHash), e]));
  const contexts = new Map(evidence.contexts.filter(e => e.kind === "context.signed" && tokens.has(String(e.data.tokenHash))).map(e => [String(e.data.contextHash), e]));
  const d = (e: EventRecord) => e.data as Record<string, any>;
  const searches = evidence.events.filter(e => e.kind === "search.returned" && (d(e).client === client || tokens.has(d(e).tokenHash)));
  // A retrieval is the app's by its token, or with none, by an address a search issued to its token.
  const retrievals = evidence.events.filter(e => (e.kind === "stream.done" || e.kind === "retrieval.answered") && (d(e).tokenHash ? tokens.has(d(e).tokenHash) : contexts.has(d(e).contextHash)));
  const windowTokens = evidence.events.filter(e => e.kind === "token.issued" && d(e).client === client);
  return { tokens, contexts, searches, retrievals, windowTokens, d };
}

/** What the app's requests in a run show so far: for the page while it runs. */
export function progressOf(input: Pick<GradeInput, "client" | "evidence">) {
  const s = sortOut({ ...input, script: SCRIPTS[0]!, conditions: [], imaging: "", proxy: "", log: () => undefined });
  return { tokens: s.windowTokens.length, searches: s.searches.length, retrievals: s.retrievals.length };
}

export function grade(input: GradeInput): Graded {
  const { script, conditions } = input;
  const { tokens, contexts, searches, retrievals, windowTokens, d } = sortOut(input);
  const studyOfContext = (hash: string | undefined) => hash ? contexts.get(hash) : undefined;
  const log = (e: EventRecord) => input.log(d(e).tokenHash ?? studyOfContext(d(e).contextHash)?.data.tokenHash as string | undefined, e.seq);
  const tokenLine = (h: unknown) => typeof h === "string" ? `sha256:${h}…` : "none";
  const searchLine = (e: EventRecord): Request => {
    const x = d(e);
    const response = x.status === 200 ? `200: ${plural((x.found ?? []).length, "study", "studies")} of ${x.total}${(x.found ?? []).length ? ` (${x.found.join(", ")})` : ""}`
      : `${x.status}${x.reason ? `: ${x.reason}` : ""}`;
    return { request: `GET ${input.imaging}/ImagingStudy?${x.query}  (token ${tokenLine(x.tokenHash)})`, response, ...(log(e) ? { log: log(e) } : {}) };
  };
  const retrievalLine = (e: EventRecord): Request => {
    const x = d(e), issued = studyOfContext(x.contextHash);
    const address = x.contextHash ? issued ? `the address issued for ${issued.data.study}` : "an address not issued to this app" : "no address from a search";
    const parts = [x.authz === "no token" ? "no token" : `token ${tokenLine(x.tokenHash)}`, x.noAccept ? "no Accept" : ""].filter(Boolean).join(", ");
    const response = e.kind === "stream.done" ? `${x.status}: ${plural(x.parts ?? 0, "part")}${x.complete ? "" : ", cut short"}` : `${x.status}${x.note ? `: ${x.note}` : x.denial ? `: ${x.denial}` : ""}`;
    const at = new Date(e.at).toISOString().slice(11, 23);
    return { request: `${at} GET ${input.proxy}/wado/…${x.target ?? `/studies/${x.studyUid ?? "?"} (${x.resource})`}, with ${address}; ${parts}`, response, ...(log(e) ? { log: log(e) } : {}) };
  };
  const lines = <T>(list: T[], f: (t: T) => Request) => list.slice(0, MAX_REQUESTS).map(f);

  const steps: GradedStep[] = [];
  const add = (s: Omit<GradedStep, "n">) => steps.push({ n: steps.length + 1, ...s });

  // What the script asked. Each depends on the one before: an app with no token searched for nothing.
  const forPatient = searches.filter(e => d(e).patient === script.patient);
  const answered = forPatient.filter(e => d(e).status === 200);
  const mine = windowTokens.filter(e => script.kind === "backend" ? d(e).grant === "client_credentials" && !d(e).user : d(e).grant !== "client_credentials");
  const right = mine.filter(e => script.kind === "backend" || (d(e).user === script.user && d(e).patient === script.patient));
  const tokenRequest = (e: EventRecord): Request => ({ request: `POST token (${d(e).grant})`, response: `200: a token for ${[d(e).user, d(e).patient].filter(Boolean).join(", for ") || d(e).client}, scope ${d(e).scope}`, ...(input.log(d(e).tokenHash, e.seq) ? { log: input.log(d(e).tokenHash, e.seq) } : {}) });
  const signedTitle = script.kind === "backend" ? "Got a token as the service" : `Signed in as ${script.user} for ${script.patient}`;
  let reached = true;
  if (right.length) add({ group: "script", title: signedTitle, state: "pass", result: `${plural(right.length, "token")} issued to ${input.client}`, requests: lines(right, tokenRequest) });
  else {
    reached = false;
    add({ group: "script", title: signedTitle, state: "fail", result: mine.length ? `The tokens issued to ${input.client} were for ${[...new Set(mine.map(e => [d(e).user, d(e).patient].filter(Boolean).join(" for ")))].join("; ")}, not what the script asked` : `No token was issued to ${input.client} during the run`, requests: lines(mine, tokenRequest) });
  }
  const approvedTitle = "Approved everything offered";
  if (script.kind === "launch") {
    const withheld = [...new Set(answered.flatMap(e => (d(e).withheld ?? []).map((w: any) => w.study as string)))];
    if (!reached || !answered.length) add({ group: "script", title: approvedTitle, state: "unreached", result: "No search answered, so this can't be told", requests: [] });
    else if (withheld.length) add({ group: "script", title: approvedTitle, state: "fail", result: `The approval left out ${plural(withheld.length, "study", "studies")} the person can see (${withheld.join(", ")}): sign in again and approve everything offered`, requests: lines(answered, searchLine) });
    else add({ group: "script", title: approvedTitle, state: "pass", result: "Nothing the person can see was withheld from the app", requests: [] });
  }
  const searchedTitle = `Searched for ${script.patient}'s studies`;
  if (!reached) add({ group: "script", title: searchedTitle, state: "unreached", result: "No token for the script's patient", requests: lines(forPatient, searchLine) });
  else if (answered.length) add({ group: "script", title: searchedTitle, state: "pass", result: `${plural(forPatient.length, "search request")}, ${answered.length} answered with a Bundle`, requests: lines(forPatient, searchLine) });
  else { reached = false; add({ group: "script", title: searchedTitle, state: "fail", result: forPatient.length ? `No search for ${script.patient} answered 200 (${[...new Set(forPatient.map(e => d(e).status))].join(", ")})` : `The app never searched for ${script.patient}`, requests: lines(searches, searchLine) }); }

  // What the server released, by its own count, and the addresses it gave for each study.
  const released = Math.max(0, ...answered.map(e => Number(d(e).total ?? 0)));
  const found = [...new Set(answered.flatMap(e => (d(e).found ?? []) as string[]))];
  const uidOf = new Map([...contexts.values()].map(c => [String(c.data.study), String(c.data.studyUid)]));
  const policyNote = released !== script.newSandbox.released ? ` A new sandbox releases ${script.newSandbox.released}, so this sandbox's policy has been changed.` : "";
  const foundTitle = script.id === "riley" ? "Found the 1 study of Riley's that Sam may see" : "Found every study the server released";
  if (!reached) add({ group: "script", title: foundTitle, state: "unreached", result: "No search answered", requests: [] });
  else if (found.length >= released) add({ group: "script", title: foundTitle, state: "pass", result: `${released ? `All ${plural(released, "study", "studies")}` : "None: the server released no studies, and the app's search said so"}${released && script.newSandbox.of > released ? `, of the patient's ${script.newSandbox.of}` : ""}.${policyNote}`, requests: [] });
  else { reached = false; add({ group: "script", title: foundTitle, state: "fail", result: `Found ${found.length} of the ${plural(released, "study", "studies")} the server released.${policyNote}`, requests: lines(answered, searchLine) }); }

  const openable = found.filter(s => uidOf.has(s));
  const opened = new Set(retrievals.filter(e => d(e).status === 200 && (e.kind === "stream.done" ? d(e).complete && IMAGE_RESOURCES.has(d(e).resource) : IMAGE_RESOURCES.has(d(e).resource))).map(e => String(d(e).studyUid)));
  const unopened = openable.filter(s => !opened.has(uidOf.get(s)!));
  const openTitle = "Opened every study it found";
  if (!reached) add({ group: "script", title: openTitle, state: "unreached", result: "It didn't find every study", requests: [] });
  else if (!openable.length) add({ group: "script", title: openTitle, state: "pass", result: "There was nothing to open", requests: [] });
  else if (!unopened.length) add({ group: "script", title: openTitle, state: "pass", result: `Retrieved images from all ${plural(openable.length, "study", "studies")}`, requests: [] });
  else add({ group: "script", title: openTitle, state: "fail", result: `Retrieved images from ${openable.length - unopened.length} of ${plural(openable.length, "study", "studies")}; not from ${unopened.join(", ")}`, requests: lines(retrievals.filter(e => unopened.some(s => uidOf.get(s) === d(e).studyUid)), retrievalLine) });

  // The requirements. Each is checked on every request the app made that it covers, and needs at least one.
  const none = (what: string) => ({ state: "note" as const, result: `Nothing to check: the app made no ${what} during the run`, requests: [] });
  const tokenBad = retrievals.filter(e => d(e).authz === "no token" || (studyOfContext(d(e).contextHash) && studyOfContext(d(e).contextHash)!.data.tokenHash !== d(e).tokenHash));
  add({ group: "requirement", title: "Each retrieval sends the token of the search that gave its address", sources: [SOURCES.sameToken],
    ...(!retrievals.length ? none("retrievals") : tokenBad.length
      ? { state: "fail", result: `${plural(tokenBad.length, "retrieval")} of ${retrievals.length} sent ${tokenBad.every(e => d(e).authz === "no token") ? "no token" : "a token other than the one its address was issued to"}`, requests: lines(tokenBad, retrievalLine) }
      : { state: "pass", result: `All ${plural(retrievals.length, "retrieval")} did`, requests: [] }) });

  const withToken = retrievals.filter(e => d(e).tokenHash);
  const addressBad = withToken.filter(e => { const c = studyOfContext(d(e).contextHash); return !c || c.data.studyUid !== d(e).studyUid; });
  add({ group: "requirement", title: "Each retrieval uses its study's Endpoint.address as given", sources: [SOURCES.opaque, SOURCES.designated],
    ...(!withToken.length ? none("retrievals with a token") : addressBad.length
      ? { state: "fail", result: `${plural(addressBad.length, "retrieval")} of ${withToken.length} ${addressBad.some(e => !d(e).contextHash) ? "used an address no search returned, built by the app itself" : addressBad.some(e => !studyOfContext(d(e).contextHash)) ? "used an address not issued to this app" : "used another study's address"}`, requests: lines(addressBad, retrievalLine) }
      : { state: "pass", result: `All ${plural(withToken.length, "retrieval")} did`, requests: [] }) });

  // Endpoint forms: a form is resolved when the app retrieved through the address of a study that had it.
  const formsOn = conditions.includes("endpoint-forms");
  const formOf = new Map<string, string>(answered.flatMap(e => Object.entries((d(e).endpointForms ?? {}) as Record<string, string>)));
  const tried = new Set(retrievals.map(e => studyOfContext(d(e).contextHash)?.data.study as string | undefined).filter(Boolean));
  const shown = [...new Set(formOf.values())], resolved = shown.filter(f => [...formOf].some(([s, g]) => g === f && tried.has(s)));
  const formsTitle = "Endpoints in every form are resolved";
  if (!formsOn) add({ group: "requirement", title: formsTitle, sources: [SOURCES.forms], state: "note", result: "Not staged in this run, so every Endpoint was a response-local entry", requests: [] });
  else if (!shown.length || !tried.size) add({ group: "requirement", title: formsTitle, sources: [SOURCES.forms], ...(shown.length ? { state: "note" as const, result: retrievals.length ? "Nothing to check: no retrieval went through an address a search returned" : "Nothing to check: the app made no retrievals during the run", requests: [] } : { state: "note" as const, result: "Nothing to check: no study with an Endpoint was returned", requests: [] }) });
  else {
    const missed = shown.filter(f => !resolved.includes(f)), all = ["response-local", "contained", "separate"], absent = all.filter(f => !shown.includes(f));
    const studiesOf = (f: string) => [...formOf].filter(([, g]) => g === f).map(([s]) => s);
    add({ group: "requirement", title: formsTitle, sources: [SOURCES.forms], requests: [],
      ...(missed.length
        ? { state: "fail", result: `The app retrieved through ${resolved.join(" and ") || "no"} Endpoint${resolved.length === 1 ? "" : "s"}, but never through a ${missed.join(" or ")} one (${missed.flatMap(studiesOf).join(", ")})` }
        : { state: "pass", result: `Retrieved through each form returned: ${resolved.join(", ")}${absent.length ? `. ${absent.join(" and ")} ${absent.length === 1 ? "wasn't" : "weren't"} returned, with ${plural(formOf.size, "study", "studies")}` : ""}` }) });
  }

  const acceptBad = retrievals.filter(e => d(e).noAccept);
  add({ group: "requirement", title: "Each retrieval sends an Accept header", sources: [SOURCES.accept],
    ...(!retrievals.length ? none("retrievals") : acceptBad.length
      ? { state: "fail", result: `${plural(acceptBad.length, "retrieval")} of ${retrievals.length} had no Accept header`, requests: lines(acceptBad, retrievalLine) }
      : { state: "pass", result: `All ${plural(retrievals.length, "retrieval")} did`, requests: [] }) });

  // Beyond what the spec guarantees: notes, each with what the app relied on and why it isn't promised.
  const notes: Note[] = [];
  const count = answered.map(e => new URLSearchParams(d(e).query).get("_count")).find(Boolean);
  if (answered.length && found.length < released) notes.push({ title: "Relied on one page of results", sources: [SOURCES.paging, SOURCES.count], requests: lines(answered, searchLine),
    detail: `The search said ${released} studies were released and the app saw ${found.length}: it didn't follow the Bundle's next link.${count ? ` It asked for _count=${count}, and a server may return fewer than asked.` : ""} A server may page results however it likes, and the next link is the only way to the rest.` });
  const staged503 = (e: EventRecord) => d(e).status === 503 && /^staged/.test(String(d(e).reason ?? d(e).note ?? ""));
  const retryOf = (e: EventRecord, list: EventRecord[], same: (a: EventRecord) => boolean) => list.find(a => (a.seq ?? 0) > (e.seq ?? 0) && same(a));
  for (const [kind, list, same, source] of [
    ["search", searches, (e: EventRecord) => (a: EventRecord) => d(a).query === d(e).query, SOURCES.retry],
    // The identical request: the same path under the same address. Another request for the study meanwhile, such as
    // its metadata, isn't a repeat.
    ["retrieval", retrievals, (e: EventRecord) => (a: EventRecord) => d(e).target ? d(a).target === d(e).target && d(a).contextHash === d(e).contextHash : d(a).studyUid === d(e).studyUid, SOURCES.retrieval503],
  ] as const) {
    const delayed = list.filter(staged503), seconds = (e: EventRecord) => Number(String(d(e).reason ?? d(e).note).match(/Retry-After: (\d+)/)?.[1] ?? 0);
    const dropped = delayed.filter(e => !retryOf(e, list, same(e)));
    const early = delayed.map(e => ({ e, again: retryOf(e, list, same(e)) })).filter(x => x.again && x.again.at - x.e.at < seconds(x.e) * 1000 - 250);
    const line = kind === "search" ? searchLine : retrievalLine;
    if (dropped.length) notes.push({ title: `Gave up on a ${kind} answered 503 with Retry-After`, sources: [source, SOURCES.retry], requests: lines(dropped, line),
      detail: `${plural(dropped.length, kind === "search" ? "search" : "retrieval")} answered 503 with Retry-After and ${dropped.length === 1 ? "was" : "were"} never repeated. The guide lets a server answer this way while it assembles results, and says an app should wait and repeat the request: a should, so this isn't graded, but the app went without what it asked for.` });
    if (early.length) notes.push({ title: `Repeated a ${kind} before Retry-After had passed`, sources: [SOURCES.retry], requests: lines(early.flatMap(x => [x.e, x.again!]), line),
      detail: `${plural(early.length, kind === "search" ? "search" : "retrieval")} came again ${early.map(x => `${((x.again!.at - x.e.at) / 1000).toFixed(1)} s`).join(", ")} after a 503 that asked for ${seconds(early[0]!.e)} s.` });
  }
  const richer = retrievals.filter(e => d(e).status === 501 && RICHER.has(String(d(e).resource)));
  if (richer.length) {
    const asked = [...new Set(richer.map(e => `/${d(e).resource}`))], fellBack = richer.every(e => opened.has(String(d(e).studyUid)));
    notes.push({ title: `Asked for ${asked.join(", ")}`, sources: [SOURCES.richer], requests: lines(richer, retrievalLine),
      detail: `This sandbox answers ${asked.join(" and ")} with 501: the guide makes them a server should, not a must. ${fellBack ? "The app fell back to retrieving the instances, as the guide asks." : "The app didn't fall back to retrieving the instances for every study it asked about."}` });
  }
  const noInclude = answered.filter(e => !new URLSearchParams(d(e).query).getAll("_include").includes("ImagingStudy:endpoint"));
  if (noInclude.length) notes.push({ title: "Searched without _include=ImagingStudy:endpoint", sources: [SOURCES.include], requests: lines(noInclude, searchLine),
    detail: "This sandbox puts each study's Endpoint in the Bundle anyway, as the guide requires for addresses made for one token. A server whose Endpoints are records of their own returns them only when asked." });
  const otherPatient = searches.filter(e => d(e).status === 403 && /patient does not match/.test(String(d(e).reason)));
  if (otherPatient.length) notes.push({ title: "Searched for a patient the token isn't for", sources: [SOURCES.patient], requests: lines(otherPatient, searchLine),
    detail: `The search named ${[...new Set(otherPatient.map(e => d(e).patient))].join(", ")}, and the token is for ${[...new Set(right.map(e => d(e).patient).filter(Boolean))].join(", ") || "another patient"}. The server must refuse it with 403, and did.` });

  // This run's own gaps: a requirement the app made no request for wasn't checked either.
  const unexercised = steps.filter(s => s.group === "requirement" && s.state === "note").map(s => `${s.title}: the app made no request it covers`);
  return { summary: summaryOf(steps), steps, notes, notChecked: [...unexercised, ...NOT_CHECKED] };
}

/** The line at the top: how the requirements came out, and how far the script got. */
export function summaryOf(steps: GradedStep[]): string {
  const reqs = steps.filter(s => s.group === "requirement"), failed = reqs.filter(s => s.state === "fail"), checked = reqs.filter(s => s.state !== "note");
  const script = steps.filter(s => s.group === "script"), stopped = script.find(s => s.state === "fail");
  const graded = !checked.length ? "No requirement could be checked: the app made no requests that they cover."
    : failed.length ? `${failed.length} of ${plural(checked.length, "requirement")} checked failed: ${failed.map(s => s.title.charAt(0).toLowerCase() + s.title.slice(1)).join("; ")}.`
    : `All ${plural(checked.length, "requirement")} checked ${checked.length === 1 ? "was" : "were"} met.`;
  return `${graded} ${stopped ? `The app stopped short of the script: ${stopped.result.charAt(0).toLowerCase()}${stopped.result.slice(1).replace(/\.$/, "")}.` : "The app did what the script asked."}`;
}
