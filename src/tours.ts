// Tours: six short stories, the demo's curated set, each in a sandbox of its own. Each one's card on the
// home page draws the layer chain its story ends on. A step is an action only. What it should come
// to is computed by the reference model (src/reference-model.ts) from the sandbox's policy and catalog at
// that moment, and the check compares the system's real answer with the model's. "Run checks" runs the
// protocol flows in src/flows as one pass/fail list.
import { randomBytes } from "node:crypto";
import { restoreGrants } from "./clients";
import { ref, type PolicyDocument } from "@smart-imaging-proxy/core";
import { PATIENT_NAMES, USERS, type BackendClient } from "./auth-server";
import { FLOWS } from "./flows";
import { StepStopped } from "./flows/runtime";
import { DEFAULT_SCOPE } from "./flows/oauth";
import { cascade, referenceModel, type RefStudy } from "./reference-model";
import { citedBy, referralsFrom, reportTitle } from "./referrals";
import { RULE_SETS } from "./rule-presets";
import { GUARDIANS_ON_FILE, POLICIES_ON_FILE, patientAttributes } from "./stores";
import { chainFor, siteWord, type Chain, type Viewer } from "./chain";
import { APP_LINE, NETWORK_LINE, PEOPLE_LINES, RILEY_LINE, SERVICE_LINES } from "./cast";
import { inSandbox, recordEvent, runInSession, sessionKey, traceSettled, withSpan, type EventRecord } from "./trace";
import { forViewer, viewerKnows } from "./viewer-events";
import type { Sandbox } from "./sandbox";
import type { Stack } from "./stack";

const APP = "portal-app";
const JOSH = "josh", SAM = "sam-caregiver", JOSH_PATIENT = "josh-example", RILEY = "riley-example";
const SERVICE = "hand-referral-service";
/** The clients the stories act as. */
const TOUR_CLIENTS = [APP, SERVICE];

/** A sandbox's policy document now, with every row's id and basis. */
const documentOf = (sandbox: Sandbox): PolicyDocument => { const { revision: _r, ...doc } = sandbox.store.snapshot(); return doc; };
/** A catalog's studies, as the reference model reads them. */
export const refStudies = (sandbox: Sandbox): RefStudy[] => sandbox.catalog.allStudies().map(st => ({ id: st.id, patient: st.patient, site: st.site, labels: st.labels, date: st.date, modalities: [...new Set(st.series.map(x => x.modality))], seriesUids: st.series.map(x => x.uid) }));
/** The reference model over a sandbox as it is now, or with its document changed as given, or at another time. */
export function modelOf(sandbox: Sandbox, change?: (doc: PolicyDocument) => PolicyDocument, at?: number) {
  const snap = documentOf(sandbox);
  const doc = change ? change(snap) : snap;
  return referenceModel({ doc, studies: refStudies(sandbox), now: at ?? sandbox.clock.now(), birthDate: p => patientAttributes(p)?.birthDate, patientOf: u => USERS[u]?.patient });
}
/** Seconds since the epoch at a patient's 18th birthday, at midnight UTC. */
const eighteenth = (patient: string) => { const [y, m, d] = patientAttributes(patient)!.birthDate!.split("-").map(Number); return Date.UTC(y! + 18, m! - 1, d!) / 1000; };

const first = (user: string) => USERS[user]?.name.split(" ")[0] ?? user;
const list = (items: string[]) => items.length < 2 ? items.join("") || "nothing" : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const sorted = (xs: Iterable<string>) => [...xs].sort();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** What a check compares: a value, how it reads in plain words, any studies it lists, and its technical detail. */
interface Answer { value: unknown; text: string; items?: string[]; detail?: string; }
interface Run {
  sandbox: Sandbox; state: Record<string, any>;
  /** How the proxy decided the step's last retrieval, from its recorded events. */
  retrieved(): string | undefined;
  model(change?: (doc: PolicyDocument) => PolicyDocument): ReturnType<typeof modelOf>;
  title(id: string): string;
}
/** Words that may name the sandbox's own sites. */
type Text = string | ((sandbox: Sandbox) => string);
const textOf = (t: Text, sandbox: Sandbox) => typeof t === "string" ? t : t(sandbox);
/**
 * What the page does for a step, with its own token, or with the sandbox's management API: the server
 * plans and judges, and never does the protocol itself.
 */
export type Plan =
  | { do: "sign-in"; user: string; patient: string; sites?: string[]; app: string; redirectUri: string; scope: string; aud: string }
  | { do: "search"; as: string; query: string }
  | { do: "retrieve"; as: string; url: string }
  | { do: "service-search"; client: string; query: string }
  | { do: "service-retrieve"; client: string; url: string }
  | { do: "management"; calls: { method: string; path: string; body?: unknown }[] }
  | { do: "referral-check"; referral: string; patientRef?: string; accession?: string; system?: string; clinicalFhir: string }
  | { do: "none" };
interface TourStep {
  id: string; title: Text; actor: string;
  /** What a step that makes no request did, said in place of a link to its activity. */
  quiet?: string;
  /** The policy as it will be once this step's action is done: the expectation comes from it, and the store's policy after the step must match it. */
  intends?: (r: Run, doc: PolicyDocument) => PolicyDocument;
  expect(r: Run, m: ReturnType<typeof modelOf>): Answer;
  /** What the page should do, decided as the step begins. Anything only the sandbox does, such as moving its clock, happens here. */
  plan(r: Run): Plan;
  /** The step's answer, from what the page saw. */
  settle(r: Run, seen: any): Promise<Answer> | Answer;
}
interface Tour {
  id: string; title: string; summary: Text; steps: TourStep[];
  /** Technical detail behind the story, shown labelled as such. */
  detail?: string;
  /** For its card: the story's end state, in words. */
  premise(sandbox: Sandbox): string;
  /** The studies the person taking the tour knows of, beyond what its events show: those of the patient they act as, or that a referral cites. */
  knows(r: Run): string[];
  /** Whose access the story follows, for its layer chain. */
  viewer: Viewer | ((sandbox: Sandbox) => Viewer);
  /** Where the story ends: the policy on file with the story's rows added, and the time, which its card's chain is drawn from. */
  scene(sandbox: Sandbox): { doc: PolicyDocument; now?: number };
  /** A story about a change: the scene before it, and the step that makes it, so the card and the runner show both. */
  change?: {
    before(sandbox: Sandbox): { doc: PolicyDocument; now?: number }; step: string; beforeLabel: string; after: string;
    /** For a change that study links outlast: the step that tries a link once it has expired, and that panel's label. */
    links?: { expiredStep: string; expiredLabel: string };
  };
}

/** What's on file, with ids, as a story's scene starts from it. */
const onFile = (): PolicyDocument => ({ relationships: GUARDIANS_ON_FILE.map((r, i) => ({ ...r, id: `on-file-${i}` })), policies: [...POLICIES_ON_FILE], shares: [], approvals: [] });
const relId = (doc: PolicyDocument, user: string, patient: string) => doc.relationships.find(r => r.subject === `user:${user}` && r.relation === "guardian_of" && r.object === `patient:${patient}`)!.id!;
const sitesOf = (sandbox: Sandbox, patient: string) => sorted(new Set(sandbox.catalog.allStudies().filter(s => s.patient === patient).flatMap(s => s.site ? [s.site] : [])));
const approve = (doc: PolicyDocument, user: string, patient: string, basis: string[], sites?: string[]): PolicyDocument => ({ ...doc, approvals: [...doc.approvals, { id: `scene-approval-${user}`, by: `user:${user}`, app: `app:${APP}`, patient: `patient:${patient}`, ...(sites ? { sites } : {}), basis }] });

/** Studies as a check reads them: a count, and their titles as a list, never joined, since titles carry commas. */
const reachText = (r: Run, ids: string[]): Answer => { const xs = sorted(ids); return xs.length ? { value: xs, text: `${plural(xs.length, "study", "studies")}:`, items: xs.map(id => r.title(id)) } : { value: xs, text: "No studies" }; };
/** A retrieval's answer, for whoever asked. */
const statusText = (who: string, status: number): Answer => ({ value: status, text: status === 200 ? `${who} gets the images` : `Refused: ${who.toLowerCase()} gets no images`, detail: `HTTP ${status}` });
/** A patient's first name. */
const patientFirst = (patient: string) => (PATIENT_NAMES[patient] ?? patient).split(" ")[0]!;
/** Whose studies, as a person names them: Josh's own are "his", and everyone else's go by name. */
const whoseOf = (user: string, patient: string) => user === JOSH && patient === JOSH_PATIENT ? "his" : `${patientFirst(patient)}'s`;
/** Sites as a sentence names them. */
const sitesWords = (sites: string[]) => list(sites.map(siteWord));

/** Sites in a fixed order, so a tour reads the same on every catalog. */
const joshSites = (r: Run) => sorted(new Set(r.sandbox.catalog.allStudies().filter(s => s.patient === JOSH_PATIENT).flatMap(s => s.site ? [s.site] : [])));
/** A share of every site but the last, so narrowing shows. */
const someSites = (r: Run) => { const all = joshSites(r); return all.length > 1 ? all.slice(0, -1) : all; };
const someSitesOf = (w: Sandbox) => { const all = sitesOf(w, JOSH_PATIENT); return all.length > 1 ? all.slice(0, -1) : all; };
/**
 * The policy once Josh shares these sites with Sam: his earlier share with Sam, if any, keeps its id,
 * with sites narrowed to those he may name, and records the route he shares through.
 */
const withShare = (sites: string[]) => (r: Run, doc: PolicyDocument): PolicyDocument => {
  const m = r.model(() => doc);
  const from = ref("user", JOSH), to = ref("user", SAM);
  const earlier = doc.shares.find(s => s.from === from && s.with === to && s.patient === ref("patient", JOSH_PATIENT));
  // A new share gets an id of its own here, so the model can name it as a route. The check ignores ids.
  const share = { id: earlier?.id ?? "intended-share", from, with: to, patient: ref("patient", JOSH_PATIENT), sites: sites.filter(x => m.nameableSites(JOSH, JOSH_PATIENT).includes(x)), label: "caregiver", basis: m.shareBasis(JOSH, JOSH_PATIENT) };
  return { ...doc, shares: earlier ? doc.shares.map(s => s === earlier ? share : s) : [...doc.shares, share] };
};

/** A document as a step's check compares it: rows without their ids, and each basis as the rows it names. */
function comparable(doc: PolicyDocument, keepBasis: (kind: "share" | "approval", row: any) => boolean = () => true) {
  const named = (b: string) => {
    if (b === "self") return "self";
    const rel = doc.relationships.find(x => x.id === b);
    if (rel) return `${rel.subject} ${rel.relation} ${rel.object}`;
    const sh = doc.shares.find(x => x.id === b);
    return sh ? `share from ${sh.from} with ${sh.with}` : "a row that isn't on file";
  };
  const bySort = <T>(xs: T[]) => xs.map(x => JSON.stringify(x)).sort();
  return {
    relationships: bySort(doc.relationships.map(({ subject, relation, object, recordedBy }) => ({ subject, relation, object, recordedBy }))),
    policies: bySort([...doc.policies].sort((a, b) => a.id.localeCompare(b.id))),
    shares: bySort(doc.shares.map(s => ({ from: s.from, with: s.with, patient: s.patient, sites: sorted(s.sites), label: s.label, ...(keepBasis("share", s) && s.basis !== undefined ? { basis: named(s.basis) } : {}) }))),
    approvals: bySort(doc.approvals.map(a => ({ by: a.by, app: a.app, patient: a.patient, ...(a.sites ? { sites: sorted(a.sites) } : {}), ...(keepBasis("approval", a) && a.basis ? { basis: sorted(a.basis.map(named)) } : {}) }))),
  };
}
/** How the policy a step left differs from the policy it intended, part by part, or undefined if it doesn't. */
export function writeMismatch(intended: PolicyDocument, actual: PolicyDocument): string | undefined {
  // A fresh row in the intended document without a basis says nothing about the basis the store records.
  const fresh = (kind: "share" | "approval") => new Set((kind === "share" ? intended.shares : intended.approvals).filter((x: any) => !x.id && !x.basis).map((x: any) => kind === "share" ? `${x.from} ${x.with} ${x.patient}` : `${x.by} ${x.app} ${x.patient}`));
  const keep = (kind: "share" | "approval", x: any) => !fresh(kind).has(kind === "share" ? `${x.from} ${x.with} ${x.patient}` : `${x.by} ${x.app} ${x.patient}`);
  const want = comparable(intended, keep), got = comparable(actual, keep);
  const parts = (Object.keys(want) as (keyof typeof want)[]).filter(k => !same(want[k], got[k]));
  if (!parts.length) return undefined;
  return parts.map(k => `${k}: it intended ${want[k].length ? want[k].join("; ") : "none"}, and the store holds ${got[k].length ? got[k].join("; ") : "none"}`).join(". ");
}

/** The sites an app approval covers, as a check reads it. */
const approvalText = (sites: string[] | undefined) => sites === undefined ? "every site" : sitesWords(sorted(sites));
function launchStep(id: string, user: string, patient: string, sites: (r: Run) => string[] | undefined, title: Text): TourStep {
  const allSites = (r: Run) => sorted(new Set(r.sandbox.catalog.allStudies().filter(s => s.patient === patient).flatMap(s => s.site ? [s.site] : [])));
  const approved = (sites: string[] | undefined) => `${first(user)} lets the app see ${whoseOf(user, patient)} studies at ${approvalText(sites)}`;
  const refused = (error: string): Answer => ({ value: { token: false }, text: `${first(user)} can't sign in for ${patientFirst(patient)}: ${first(user)} can see none of ${patientFirst(patient)}'s studies`, detail: `The sign-in ends with ${error}, and the app gets no access token` });
  return {
    id, title, actor: first(user),
    quiet: `The sign-in was refused before ${first(user)} could approve anything, so no request reached the imaging services.`,
    expect(r, m) {
      if (!m.holds(user, patient)) return refused("access_denied");
      const asked = sites(r);
      const narrowed = asked ? asked.filter(s => m.approvableSites(user, patient).includes(s)) : undefined;
      // All of the patient's sites is the same as no limit.
      const sitesApproved = narrowed && !(narrowed.length && narrowed.length === allSites(r).length) ? sorted(narrowed) : undefined;
      return { value: { token: true, patient, sites: sitesApproved ?? "all" }, text: approved(sitesApproved), detail: `An access token for patient ${patient}` };
    },
    plan: r => ({ do: "sign-in", user, patient, ...(sites(r) ? { sites: sites(r) } : {}), app: APP, redirectUri: r.sandbox.urls.callback, scope: DEFAULT_SCOPE, aud: r.sandbox.urls.clinicalFhir }),
    settle(r, seen) {
      if (!seen.token) return refused(seen.error ?? "an error");
      r.state[`tokenExp:${user}`] = r.sandbox.clock.now() + (seen.expiresIn ?? 0);
      const a = r.sandbox.store.approvals().find(x => x.by === ref("user", user) && x.app === ref("app", APP) && x.patient === ref("patient", seen.patient));
      const sitesApproved = a?.sites ? sorted(a.sites) : undefined;
      return { value: { token: true, patient: seen.patient, sites: sitesApproved ?? "all" }, text: approved(sitesApproved), detail: `An access token for patient ${seen.patient}` };
    },
  };
}
function searchStep(id: string, user: string, patient: string, title: Text): TourStep {
  return {
    id, title, actor: "The app",
    expect: (r, m) => reachText(r, m.appReach(user, APP, patient).map(s => s.id)),
    plan: () => ({ do: "search", as: user, query: `patient=${patient}&_include=ImagingStudy:endpoint` }),
    settle(r, seen) {
      const studies: { id: string; uid: string; base: string }[] = seen.studies ?? [];
      // The signed URLs a later step uses are the last ones search gave.
      if (studies.length) { r.state.found = Object.fromEntries(studies.map(x => [x.id, { uid: x.uid, base: x.base }])); r.state.signedAt = r.sandbox.clock.now(); }
      if (seen.status !== 200) return { value: `HTTP ${seen.status}`, text: "The search is refused", detail: `HTTP ${seen.status}` };
      return reachText(r, studies.map(x => x.id));
    },
  };
}
/** Asking for a study by its UID alone, as an app would after learning it elsewhere: the proxy asks the Imaging Server. */
function plainRetrieveStep(id: string, user: string, patient: string, pick: (r: Run, m: ReturnType<typeof modelOf>) => string | undefined, title: Text): TourStep {
  const chosen = (r: Run) => r.state[`pick:${id}`] ??= pick(r, r.model());
  const answer = (r: Run, study: string, status: number): Answer => ({ value: status, text: status === 200 ? `The app gets ${r.title(study)}` : `${r.title(study)}: refused, the same way as a study that doesn't exist`, detail: status === 404 ? "HTTP 404 Not Found. The app can't tell a study it may not see from one that isn't there." : `HTTP ${status}` });
  return {
    id, title, actor: "The app",
    expect(r, m) {
      const study = chosen(r);
      if (!study) return { value: "none", text: "There's no such study here" };
      return answer(r, study, m.appReach(user, APP, patient).some(s => s.id === study) ? 200 : 404);
    },
    plan(r) {
      const study = chosen(r);
      if (!study) return { do: "none" };
      // No signed context: the proxy's address with none, which makes it ask the Imaging Server.
      return { do: "retrieve", as: user, url: `${r.sandbox.urls.proxy}/wado/-/studies/${r.sandbox.catalog.allStudies().find(s => s.id === study)!.uid}` };
    },
    settle(r, seen) {
      const study = chosen(r);
      return study ? answer(r, study, seen.status) : { value: "none", text: "There's no such study here" };
    },
  };
}
/** Of the studies search gave signed URLs for, the one with the fewest images, so a retrieval is quick. */
const smallestFound = (r: Run) => Object.keys(r.state.found ?? {}).sort((a, b) => (r.sandbox.catalog.allStudies().find(s => s.id === a)?.instanceCount ?? 0) - (r.sandbox.catalog.allStudies().find(s => s.id === b)?.instanceCount ?? 0))[0];
/**
 * The study link search gave for a study, a signed URL: the proxy answers from it alone until it
 * expires, and after that asks the Imaging Server, and current policy decides.
 */
function signedRetrieveStep(id: string, user: string, patient: string, title: Text, after = 0): TourStep {
  const answer = (r: Run, study: string, status: number, how: string): Answer => ({
    value: status,
    text: status === 200 ? `The app gets ${r.title(study)}${how === "alone" ? ": the link it was given still works" : ""}` : status === 401 ? "Refused: the app's sign-in has expired" : `Refused: the link has expired, and the app can't see ${r.title(study)}`,
    detail: `HTTP ${status}. ${how === "alone" ? "The signed URL hasn't expired, so the proxy answers from the URL alone, without asking the Imaging Server." : how === "token" ? "The access token has expired." : how === "cached" ? "The proxy used a decision the Imaging Server gave earlier." : status === 200 ? "The signed URL has expired, so the proxy asks the Imaging Server, which allows it." : "The signed URL has expired, so the proxy asks the Imaging Server, and current policy releases nothing."}`,
  });
  return {
    id, title, actor: "The app",
    expect(r, m) {
      const study = smallestFound(r);
      if (!study) return { value: "none", text: "An earlier search has to find a study first" };
      const lifetime = r.sandbox.store.getSettings().contextLifetimeSeconds;
      const now = r.sandbox.clock.now() + (after ? lifetime + after : 0);
      const exp = Math.min(r.state.signedAt + lifetime, r.state[`tokenExp:${user}`]);
      const status = now < exp ? 200 : now >= r.state[`tokenExp:${user}`] ? 401 : m.appReach(user, APP, patient).some(s => s.id === study) ? 200 : 404;
      return answer(r, study, status, now < exp ? "alone" : status === 401 ? "token" : "asked");
    },
    plan(r) {
      const study = smallestFound(r);
      if (!study) throw new StepStopped("An earlier search has to find a study first");
      if (after) { const lifetime = r.sandbox.store.getSettings().contextLifetimeSeconds; r.sandbox.clock.advance(lifetime + after); }
      const f = r.state.found[study];
      return { do: "retrieve", as: user, url: `${f.base}/studies/${f.uid}` };
    },
    settle(r, seen) {
      const authz = r.retrieved();
      return answer(r, smallestFound(r)!, seen.status, authz === "instant" ? "alone" : authz === "cached" ? "cached" : seen.status === 401 ? "token" : "asked");
    },
  };
}
const canSeeText = (user: string, patient: string, sites: string[]): Answer => sites.length
  ? { value: sorted(sites), text: `${first(user)} can see ${patientFirst(patient)}'s studies at ${sitesWords(sorted(sites))}` }
  : { value: [], text: `${first(user)} can see none of ${patientFirst(patient)}'s studies` };
const accessOf = async (r: Run, user: string, patient: string) => {
  const a = await r.sandbox.policy.access(user, USERS[user]!.fhirUser);
  return canSeeText(user, patient, a.records.find(x => x.patient === patient)?.sites ?? []);
};
function shareStep(id: string, sites: (r: Run) => string[], title: Text): TourStep {
  return {
    id, title, actor: first(JOSH), intends: (r, doc) => withShare(sites(r))(r, doc),
    expect: (_r, m) => canSeeText(SAM, JOSH_PATIENT, m.approvableSites(SAM, JOSH_PATIENT)),
    plan: r => ({ do: "management", calls: [{ method: "POST", path: "/shares", body: { from: ref("user", JOSH), with: ref("user", SAM), patient: ref("patient", JOSH_PATIENT), sites: sites(r), label: "caregiver" } }] }),
    settle(r, seen) {
      const status = seen.statuses?.[0];
      if (status !== 200) return { value: `HTTP ${status}`, text: "The share was refused", detail: `HTTP ${status}` };
      return accessOf(r, SAM, JOSH_PATIENT);
    },
  };
}

/** The referral this tour's service works from, and one for a study outside its rule. */
const referralOf = (w: Sandbox, modality: string) => referralsFrom(w.catalog, w.urls.clinicalFhir).find(x => { const st = w.catalog.allStudies().find(s => s.id === x.study)!; return st.patient === JOSH_PATIENT && st.series.some(s => s.modality === modality); });
const REFUSED_NO_RULE = "Refused: there's no rule yet that lets the service see any of Josh's studies";
const notCovered = (title: string) => `It finds nothing: the service's rule covers Josh's X-rays only, and the referral cites ${title}`;
function serviceSearchStep(id: string, modality: string, title: Text): TourStep {
  return {
    id, title, actor: "The service",
    expect(r, m) {
      const ref = referralOf(r.sandbox, modality);
      if (!ref) return { value: "none", text: "No referral here cites such a study" };
      if (!m.serviceMaySearch(SERVICE, JOSH_PATIENT)) return { value: 403, text: REFUSED_NO_RULE, detail: "HTTP 403 Forbidden" };
      const ids = m.serviceReach(SERVICE, JOSH_PATIENT).filter(s => s.id === ref.study).map(s => s.id);
      return { value: ids, text: ids.length ? `It finds the study the referral cites: ${r.title(ref.study)}` : notCovered(r.title(ref.study)), detail: ids.length ? "HTTP 200, with the study" : "HTTP 200, with no studies" };
    },
    plan(r) {
      const ref = referralOf(r.sandbox, modality);
      if (!ref) return { do: "none" };
      const cited = citedBy(ref.bundle);
      return { do: "service-search", client: SERVICE, query: new URLSearchParams({ patient: cited.patientRef!, identifier: `${cited.system}|${cited.accession}`, _include: "ImagingStudy:endpoint" }).toString() };
    },
    settle(r, seen) {
      const ref = referralOf(r.sandbox, modality);
      if (!ref) return { value: "none", text: "No referral here cites such a study" };
      const studies: { id: string; uid: string; base: string }[] = seen.studies ?? [];
      r.state.serviceFound = Object.fromEntries(studies.map(x => [x.id, { uid: x.uid, base: x.base }]));
      const detail = `A FHIR search by patient and the report's accession number, ${citedBy(ref.bundle).accession}. HTTP ${seen.status}${seen.status === 200 ? `, with ${studies.length ? "the study" : "no studies"}` : ""}.`;
      if (seen.status !== 200) return { value: seen.status, text: REFUSED_NO_RULE, detail };
      const ids = studies.map(x => x.id);
      return { value: ids, text: ids.length ? `It finds the study the referral cites: ${r.title(ids[0]!)}` : notCovered(r.title(ref.study)), detail };
    },
  };
}

const joshStudies = (r: Run) => r.sandbox.catalog.allStudies().filter(s => s.patient === JOSH_PATIENT).map(s => s.id);
const rileyStudies = (r: Run) => r.sandbox.catalog.allStudies().filter(s => s.patient === RILEY).map(s => s.id);
const lastSite = (w: Sandbox) => sitesWords(sitesOf(w, JOSH_PATIENT).slice(-1));
/** Josh's share with Sam, of these sites. */
const sharedScene = (sites: string[]): PolicyDocument => ({ ...onFile(), shares: [{ id: "scene-share", from: `user:${JOSH}`, with: `user:${SAM}`, patient: `patient:${JOSH_PATIENT}`, sites, label: "caregiver", basis: "self" }] });

const TOURS: Tour[] = [
  {
    id: "own", title: "Josh decides what an app can see",
    premise: w => `Josh lets the Health Records App see only his studies at ${lastSite(w)}. The app sees those, and nothing else.`,
    summary: w => `Josh lets the Health Records App see all his studies, then only those at ${lastSite(w)}. Each time, the app sees what Josh allows and nothing more.`,
    knows: joshStudies,
    viewer: { user: JOSH, patient: JOSH_PATIENT, app: APP },
    scene: w => ({ doc: approve(onFile(), JOSH, JOSH_PATIENT, ["self"], sitesOf(w, JOSH_PATIENT).slice(-1)) }),
    steps: [
      launchStep("launch", JOSH, JOSH_PATIENT, () => undefined, "Josh signs in and lets the app see all his studies"),
      searchStep("search", JOSH, JOSH_PATIENT, "The app searches Josh's studies"),
      launchStep("narrow", JOSH, JOSH_PATIENT, r => joshSites(r).slice(-1), w => `Josh signs in again and lets the app see only his studies at ${lastSite(w)}`),
      searchStep("search-again", JOSH, JOSH_PATIENT, "The app searches again"),
      plainRetrieveStep("outside", JOSH, JOSH_PATIENT, (_r, m) => m.userReach(JOSH, JOSH_PATIENT).find(s => !m.appReach(JOSH, APP, JOSH_PATIENT).some(x => x.id === s.id))?.id, "The app asks for a study Josh didn't let it see"),
    ],
  },
  {
    id: "guardian", title: "Sam, guardian of 15-year-old Riley",
    premise: () => "The imaging network's rule for guardians of teenagers leaves out Riley's study labeled confidential. The app Sam uses sees Riley's other study.",
    summary: "Sam is the guardian of Riley, who is 15. The imaging network's rule for guardians of patients aged 13 to 17 covers every study except those labeled confidential, so the app Sam uses sees every study of Riley's but the confidential one.",
    knows: rileyStudies,
    viewer: { user: SAM, patient: RILEY, app: APP },
    scene: () => { const doc = onFile(); return { doc: approve(doc, SAM, RILEY, [relId(doc, SAM, RILEY)]) }; },
    steps: [
      launchStep("launch", SAM, RILEY, () => undefined, "Sam signs in, picks Riley, and lets the app see Riley's studies"),
      searchStep("search", SAM, RILEY, "The app searches Riley's studies"),
      plainRetrieveStep("labeled", SAM, RILEY, (r, m) => rileyStudies(r).find(id => !m.userReach(SAM, RILEY).some(s => s.id === id)), "The app asks for the study labeled confidential"),
    ],
  },
  {
    id: "caregiver", title: "Josh shares with Sam, and Sam shares with an app",
    premise: w => `Josh shares his studies at ${sitesWords(someSitesOf(w))} with Sam. Sam lets the Health Records App act for Sam on only what Josh shares at ${sitesWords(someSitesOf(w).slice(0, 1))}, so that's all the app sees.`,
    summary: w => `Josh shares his studies at ${sitesWords(someSitesOf(w))} with Sam. Sam then lets the Health Records App act for Sam on only the ${sitesWords(someSitesOf(w).slice(0, 1))} ones. An app acting for Sam gets only what Sam was given.`,
    knows: joshStudies,
    viewer: { user: SAM, patient: JOSH_PATIENT, app: APP },
    scene: w => ({ doc: approve(sharedScene(someSitesOf(w)), SAM, JOSH_PATIENT, ["scene-share"], someSitesOf(w).slice(0, 1)) }),
    steps: [
      shareStep("share", someSites, w => `Josh shares his studies at ${sitesWords(someSitesOf(w))} with Sam`),
      launchStep("launch", SAM, JOSH_PATIENT, r => someSites(r).slice(0, 1), w => `Sam signs in, picks Josh, and lets the app see only Josh's studies at ${sitesWords(someSitesOf(w).slice(0, 1))}`),
      searchStep("search", SAM, JOSH_PATIENT, "The app searches Josh's studies"),
      plainRetrieveStep("outside", SAM, JOSH_PATIENT, (r, m) => m.userReach(SAM, JOSH_PATIENT).find(s => !m.appReach(SAM, APP, JOSH_PATIENT).some(x => x.id === s.id))?.id ?? m.userReach(SAM, JOSH_PATIENT)[0]?.id, "The app asks for a study Sam can see but didn't let the app see"),
    ],
  },
  {
    id: "revoke", title: "Josh stops sharing with Sam",
    premise: () => "Josh has shared all his studies with Sam, and the app Sam uses sees them. Then Josh stops sharing, Sam's approval of the app goes with the share, and the app sees none. Study links the app already had keep working for a few minutes, until they expire.",
    summary: "Josh has shared all his studies with Sam, and the app Sam uses sees them. Then Josh stops sharing, and Sam's approval of the app goes with the share. The app's next search finds nothing. Study links the app already had keep working for a few minutes, until they expire, and are then refused too.",
    detail: "A study link is a signed URL. Until it expires, the proxy answers from the URL alone. After that, it asks the Imaging Server, and current policy decides.",
    knows: joshStudies,
    viewer: { user: SAM, patient: JOSH_PATIENT, app: APP },
    // Once the share goes, the approval that rested on it goes too.
    scene: () => ({ doc: onFile() }),
    change: { before: w => ({ doc: approve(sharedScene(sitesOf(w, JOSH_PATIENT)), SAM, JOSH_PATIENT, ["scene-share"]) }), step: "revoke", beforeLabel: "Before Josh stops sharing", after: "After Josh stops sharing", links: { expiredStep: "expired", expiredLabel: "Once those study links expire" } },
    steps: [
      shareStep("share", r => joshSites(r), "Josh shares all his studies with Sam"),
      launchStep("launch", SAM, JOSH_PATIENT, () => undefined, "Sam signs in, picks Josh, and lets the app see Josh's studies"),
      searchStep("search", SAM, JOSH_PATIENT, "The app searches Josh's studies"),
      {
        id: "revoke", title: "Josh stops sharing with Sam", actor: first(JOSH),
        // The share goes, and with it what rested only on it.
        intends: (_r, doc) => cascade({ ...doc, shares: doc.shares.filter(s => !(s.from === ref("user", JOSH) && s.with === ref("user", SAM))) }),
        expect: (_r, m) => canSeeText(SAM, JOSH_PATIENT, m.approvableSites(SAM, JOSH_PATIENT)),
        // The study links the app holds when the share goes: the ones its last search gave it.
        plan(r) { r.state.linked = Object.keys(r.state.found ?? {}); return { do: "management", calls: [{ method: "DELETE", path: `/shares?${new URLSearchParams({ from: ref("user", JOSH), with: ref("user", SAM) })}` }] }; },
        settle: r => accessOf(r, SAM, JOSH_PATIENT),
      },
      searchStep("search-again", SAM, JOSH_PATIENT, "The app searches again, without Sam signing in again"),
      signedRetrieveStep("signed", SAM, JOSH_PATIENT, "The app opens a study link it was given before"),
      signedRetrieveStep("expired", SAM, JOSH_PATIENT, "The study link expires, and the app tries it again", 1),
    ],
  },
  {
    id: "backend", title: "A referral service finds one X-ray",
    premise: () => "The imaging network's rule lets the hand referral service see Josh's X-rays. A referral cites one of them, and that one is what the service finds.",
    summary: "The hand referral service gets a referral that cites one of Josh's X-rays. Once the imaging network adds a rule that lets the service see Josh's X-rays, the service searches for the one the referral cites, and finds it. A CT scan, which the rule doesn't cover, stays out of reach.",
    detail: "The referral names the patient on the clinical FHIR server and cites the imaging report with its accession number, and the service searches by patient and accession. Across organizations, a referral would carry an MRN instead, and the service would first look the patient up with Patient?identifier=. This demo doesn't show that step.",
    knows: r => ["CR", "CT"].flatMap(m => referralOf(r.sandbox, m)?.study ?? []),
    viewer: w => ({ service: SERVICE, patient: JOSH_PATIENT, cited: referralOf(w, "CR")?.study }),
    scene: w => ({ doc: { ...onFile(), policies: [...POLICIES_ON_FILE, ...RULE_SETS.find(s => s.id === "hand-wrist-referral")!.rules(w.catalog)!] } }),
    steps: [
      {
        id: "check", title: "A referral arrives, and the service checks that its patient is on the clinical records server it may use", actor: "The service",
        expect: r => ({ value: true, text: "The referral's patient is on that server", detail: r.sandbox.urls.clinicalFhir }),
        plan(r) {
          const ref = referralOf(r.sandbox, "CR");
          if (!ref) throw new StepStopped("No referral here cites an X-ray");
          const cited = citedBy(ref.bundle);
          return { do: "referral-check", referral: ref.id, patientRef: cited.patientRef, accession: cited.accession, system: cited.system, clinicalFhir: r.sandbox.urls.clinicalFhir };
        },
        settle(r, seen) {
          const ref = referralOf(r.sandbox, "CR")!, cited = citedBy(ref.bundle), ok = seen.ok === true;
          // What the service decided, as it says it did: the service is the page, and this is its event.
          recordEvent("app", { kind: "referral.checked", client: SERVICE, referral: ref.id, reference: cited.patientRef, authorizedBase: r.sandbox.urls.clinicalFhir, ok, accession: cited.accession, system: cited.system });
          return { value: ok, text: ok ? "The referral's patient is on that server" : "The referral's patient isn't on that server", detail: `${cited.patientRef} ${ok ? "is" : "isn't"} on ${r.sandbox.urls.clinicalFhir}` };
        },
      },
      serviceSearchStep("search", "CR", "The service searches for the X-ray the referral cites"),
      {
        id: "policy", title: "The imaging network adds a rule: the hand referral service can see Josh's X-rays", actor: "The imaging network",
        intends: (r, doc) => { const rules = RULE_SETS.find(s => s.id === "hand-wrist-referral")!.rules(r.sandbox.catalog)!; return { ...doc, policies: [...doc.policies.filter(p => !rules.some(x => x.id === p.id)), ...rules] }; },
        expect: (r, m) => reachText(r, m.serviceReach(SERVICE, JOSH_PATIENT).map(s => s.id)),
        plan: r => ({ do: "management", calls: RULE_SETS.find(s => s.id === "hand-wrist-referral")!.rules(r.sandbox.catalog)!.map(rule => ({ method: "PUT", path: `/policies/${encodeURIComponent(rule.id)}`, body: rule })) }),
        async settle(r) {
          const x: any = await r.sandbox.explain({ client: SERVICE, patient: JOSH_PATIENT });
          return reachText(r, x.studies.filter((s: any) => s.release !== "none").map((s: any) => s.id));
        },
      },
      serviceSearchStep("search-again", "CR", "The service searches again"),
      {
        id: "retrieve", title: "The service retrieves the X-ray", actor: "The service",
        expect: (r, m) => { const ref = referralOf(r.sandbox, "CR"); return statusText("The service", ref && m.serviceReach(SERVICE, JOSH_PATIENT).some(s => s.id === ref.study) ? 200 : 404); },
        plan(r) {
          const [study] = Object.keys(r.state.serviceFound ?? {});
          if (!study) return { do: "none" };
          const f = r.state.serviceFound[study];
          return { do: "service-retrieve", client: SERVICE, url: `${f.base}/studies/${f.uid}` };
        },
        settle: (r, seen) => statusText("The service", Object.keys(r.state.serviceFound ?? {}).length ? seen.status : 404),
      },
      serviceSearchStep("outside", "CT", "A second referral cites a CT scan of Josh's, which the rule doesn't cover"),
    ],
  },
  {
    id: "turns-18", title: "Riley turns 18",
    premise: () => "Riley is 18, and no rule lets guardians see an adult's studies. Sam's approval of the app stays on file, but it reaches nothing, and Sam can't sign in for Riley.",
    summary: "The imaging network's rules for guardians stop at age 17. Once Riley turns 18, no rule lets Sam see Riley's studies, and the app Sam approved sees none of them.",
    knows: rileyStudies,
    viewer: { user: SAM, patient: RILEY, app: APP },
    scene: () => { const doc = onFile(); return { doc: approve(doc, SAM, RILEY, [relId(doc, SAM, RILEY)]), now: eighteenth(RILEY) + 86400 }; },
    steps: [
      launchStep("launch", SAM, RILEY, () => undefined, "Sam signs in, picks Riley, and lets the app see Riley's studies"),
      searchStep("search", SAM, RILEY, "The app searches Riley's studies"),
      {
        id: "birthday", title: "The demo clock moves to the day after Riley's 18th birthday", actor: "Setting: the demo clock",
        quiet: "Only the demo clock moved. No request was made.",
        expect: r => { const m = modelOf(r.sandbox, undefined, Math.max(r.sandbox.clock.now(), eighteenth(RILEY) + 86400)); return canSeeText(SAM, RILEY, m.approvableSites(SAM, RILEY)); },
        plan(r) { r.sandbox.clock.advance(Math.max(0, eighteenth(RILEY) + 86400 - r.sandbox.clock.now())); return { do: "none" }; },
        settle: r => accessOf(r, SAM, RILEY),
      },
      launchStep("again", SAM, RILEY, () => undefined, "Sam tries to sign in for Riley again"),
    ],
  },
];
export const tourById = (id: string) => TOURS.find(t => t.id === id);
export const PROTOCOL_CHECKS = FLOWS.filter(f => f.group === "protocol");
/** Each protocol check in plain words, for the home page: a title, and what it shows in one line. */
const CHECK_WORDS: Record<string, { title: string; summary: string }> = {
  "token-refresh": { title: "An app renews its sign-in", summary: "The app's sign-in is renewed, and the study links it already has keep working." },
  viewer: { title: "An app hands a study link to an image viewer", summary: "A viewer inside the app can use the app's access. A separate viewer app needs its own approval." },
  "decision-outage": { title: "The service that decides access is down", summary: "Study links that haven't expired keep working, and everything else is refused." },
  attacks: { title: "Altered links and borrowed sign-ins get nothing", summary: "Attempts to get around the checks on study links and sign-ins are all refused." },
  "transfer-syntax": { title: "Asking for images in different formats", summary: "Each image format an app asks for gets the answer the guide calls for." },
  truncation: { title: "An image store stops partway", summary: "When the store holding the images stops partway through a study, the app can tell the study is incomplete." },
  metadata: { title: "Study details hide internal addresses", summary: "Study details don't expose the names of internal servers, and their links still work." },
  "paged-search": { title: "Searching a few studies at a time", summary: "The app pages through search results, and the rules apply again on every page." },
};

/**
 * The panels of a story about a change: before, after, and when study links outlast the change, once they
 * expire. `linked` is the studies whose links the app had when the change came.
 */
function changePanels(tour: Tour, before: Chain, after: Chain, linked?: string[], expired = false) {
  const c = tour.change!;
  if (!linked) return [{ label: c.beforeLabel, chain: before }, { label: c.after, chain: after }];
  const split = (gone: boolean): Chain => ({ ...after, rows: [
    ...after.rows.map(r => r.kind === "outcome" ? { ...r, name: "What a new search finds" } : r),
    { level: "outcome", kind: "links", name: gone ? "Study links the app already had: expired, and refused" : "Study links the app already had: work for a few minutes, until they expire", has: gone ? [] : linked },
  ] });
  return [{ label: c.beforeLabel, chain: before }, { label: c.after, chain: split(false) }, ...(expired ? [{ label: c.links!.expiredLabel, chain: split(true) }] : [])];
}

/** The tours and checks of one sandbox. A tour runs in a sandbox minted for it, and a reload there comes back to it. */
/**
 * Puts a sandbox back to what's on file for a tour, leaving other apps as they were: their tokens, and
 * their approvals, for as long as the person approving still holds a route to that patient.
 */
function startOver(sandbox: Sandbox) {
  const others = sandbox.store.approvals().filter(a => !TOUR_CLIENTS.some(c => a.app === ref("app", c)));
  sandbox.store.resetPolicy();
  restoreGrants(sandbox.store);
  for (const { by, app, patient, sites } of others) { try { sandbox.store.putApproval({ by, app, patient, ...(sites ? { sites } : {}) }); } catch {} }
  sandbox.store.deleteTokensOf(TOUR_CLIENTS);
  sandbox.clock.reset();
  sandbox.clearRuntime();
}

export function createTours(sandbox: Sandbox, stack: Stack) {
  /** The run in progress here: the step the page is doing, if any, with what was decided before it began. */
  let run: { tour: Tour; r: Run; results: Record<string, any>; session: string; pending?: { step: string; trace: string; intended?: PolicyDocument; expected: Answer } } | undefined;
  const json = (b: unknown, status = 200) => Response.json(b, { status });
  const title = (id: string) => { const s = sandbox.catalog.allStudies().find(x => x.id === id); return s ? reportTitle(s) : id; };
  const activityUrl = (session: string, w: Sandbox = sandbox) => `${w.prefix}/activity?session=${encodeURIComponent(session)}`;

  function begin(tour: Tour) {
    const session = sessionKey(sandbox.id, `tour-${tour.id}-${randomBytes(3).toString("hex")}`);
    const r: Run = { sandbox, state: {}, model: change => modelOf(sandbox, change ? doc => change(doc) : undefined), title, retrieved: () => {
      const trace = run?.pending?.trace;
      const done = trace ? stack.collector.store.events({ session, trace }).filter(e => (e.kind === "stream.done" || e.kind === "retrieval.answered") && (e.data as any).authz).at(-1) : undefined;
      return (done?.data as any)?.authz;
    } };
    run = { tour, r, results: {}, session };
    return run;
  }
  const viewerOf = (tour: Tour) => typeof tour.viewer === "function" ? tour.viewer(sandbox) : tour.viewer;
  const sceneChain = (tour: Tour, scene: { doc: PolicyDocument; now?: number }): Chain => chainFor({ snap: scene.doc, studies: sandbox.catalog.allStudies(), now: scene.now ?? sandbox.clock.now(), viewer: viewerOf(tour), title: s => reportTitle(s) });
  /** The chain a story ends on, for its card, drawn from its scene by core's model. */
  const cardChain = (tour: Tour): Chain => sceneChain(tour, tour.scene(sandbox));
  /** A story about a change: its card shows the chain before it, and after, each with its label. */
  /**
   * A story about a change: its card shows the chain before it, and after. When study links outlast the
   * change, the after panel shows the links the app already had, which a search before the change gave it:
   * what the model releases to the app in the before scene. A panel for once they expire follows, if the
   * tour has a step that tries one then.
   */
  const cardChains = (tour: Tour) => {
    if (!tour.change) return [{ chain: cardChain(tour) }];
    const before = sceneChain(tour, tour.change.before(sandbox)), after = cardChain(tour), links = tour.change.links;
    const linked = before.rows.find(r => r.kind === "outcome")!.has;
    return changePanels(tour, before, after, links ? linked : undefined, !!links && tour.steps.some(s => s.id === links.expiredStep));
  };
  /** Who's who, for the home page: people by first name, the app, the service the stories follow, and the imaging network with its sites. */
  const cast = () => {
    const sites = sorted(new Set(sandbox.catalog.allStudies().flatMap(s => s.site ? [s.site] : [])));
    return [
      ...["josh", SAM].map(u => ({ name: first(u), line: PEOPLE_LINES[u]! })),
      { name: "Riley", line: RILEY_LINE },
      { name: "Health Records App", line: APP_LINE },
      { name: "Hand referral service", line: SERVICE_LINES[SERVICE]! },
      { name: "The imaging network", line: `${NETWORK_LINE} Its sites are ${list(sites)}.` },
    ];
  };
  /** The chain a story's viewer has now, in the tour's sandbox, as its narrator sees it. */
  const chainNow = (tour: Tour): Chain => chainFor({ snap: sandbox.store.snapshot(), studies: sandbox.catalog.allStudies(), now: sandbox.clock.now(), viewer: viewerOf(tour), title: s => reportTitle(s) });
  /** The studies the person taking this sandbox's tour knows of, beyond its events, if the session is the tour's. */
  const knownIn = (session: string) => run && run.session === session ? run.tour.knows(run.r) : undefined;
  /** Events of the tour's session, as the person taking it may see them. */
  const viewerEvents = (session: string, events: EventRecord[]) => forViewer(events, viewerKnows(stack.collector.store.events({ session }), knownIn(session) ?? []), uid => sandbox.catalog.studyByUid(uid)?.id);
  /** Each step, with what the model says it should come to now, before it runs. */
  function state() {
    if (!run) return { sandbox: sandbox.id ? { id: sandbox.id, base: sandbox.prefix } : null, tour: null };
    return stateOf(run.tour, run.r, run.results, run);
  }
  /** A tour's steps before any has run, with nothing started. */
  function preview(tour: Tour) {
    const r: Run = { sandbox, state: {}, model: change => modelOf(sandbox, change ? doc => change(doc) : undefined), title, retrieved: () => undefined };
    return stateOf(tour, r, {});
  }
  /** Once a story's change has run: the chain before it and after it, from the steps' own results, and the links the app really held. */
  function changed(tour: Tour, r: Run, results: Record<string, any>) {
    const c = tour.change, at = c ? tour.steps.findIndex(s => s.id === c.step) : -1;
    if (!c || at < 1 || !results[c.step]?.chain || !results[tour.steps[at - 1]!.id]?.chain) return undefined;
    return changePanels(tour, results[tour.steps[at - 1]!.id].chain, results[c.step].chain, c.links ? r.state.linked ?? [] : undefined, !!c.links && !!results[c.links.expiredStep]);
  }
  function stateOf(tour: Tour, r: Run, results: Record<string, any>, started?: NonNullable<typeof run>) {
    const next = tour.steps.find(s => !results[s.id]);
    let expect: string | undefined, expectDetail: string | undefined, expectItems: string[] | undefined;
    if (next) { try { const e = next.expect(r, r.model(next.intends ? doc => next.intends!(r, doc) : undefined)); expect = e.text; expectDetail = e.detail; expectItems = e.items; } catch (e) { expect = String((e as Error).message ?? e); } }
    return {
      sandbox: { id: sandbox.id, base: sandbox.prefix }, session: started?.session ?? null, activityUrl: started ? activityUrl(started.session) : null,
      tour: { id: tour.id, title: tour.title, summary: textOf(tour.summary, sandbox), detail: tour.detail, premise: tour.premise(sandbox), ...(tour.change ? { change: { step: tour.change.step, before: tour.change.beforeLabel, after: tour.change.after } } : {}) },
      chain: chainNow(tour),
      ...(changed(tour, r, results) ? { panels: changed(tour, r, results) } : {}),
      steps: tour.steps.map(s => ({ id: s.id, title: textOf(s.title, sandbox), actor: s.actor, ...(s === next ? { expect, expectDetail, ...(expectItems ? { expectItems } : {}) } : {}), ...(results[s.id] ? { result: results[s.id] } : {}) })),
    };
  }
  /**
   * A step begins: everything is decided before its action. A step that changes policy is checked against
   * the model of the policy it intends, and then the store's policy against that intended policy. The page
   * does the action, under the tour's session and this step's trace.
   */
  function beginStep(s: TourStep) {
    const { r } = run!;
    const trace = randomBytes(16).toString("hex");
    const intended = s.intends?.(r, documentOf(sandbox));
    const expected = s.expect(r, r.model(intended ? () => intended : undefined));
    run!.pending = { step: s.id, trace, intended, expected };
    try { return { plan: s.plan(r), trace, session: run!.session }; }
    catch (e) { run!.pending = undefined; throw e; }
  }
  /** A step finishes with what the page saw: its answer, judged against what was decided as it began. */
  async function finishStep(s: TourStep, seen: any) {
    const { tour, r } = run!, { trace, intended, expected } = run!.pending!;
    await traceSettled();
    let result: any;
    try {
      const actual = await inSandbox(sandbox.id, () => runInSession(run!.session, () => withSpan("user", "action", `${tour.title}: ${textOf(s.title, sandbox)}`, { tour: tour.id, step: s.id }, async () => s.settle(r, seen ?? {}), { session: run!.session, trace })));
      const mismatch = intended && writeMismatch(intended, documentOf(sandbox));
      result = { ok: same(actual.value, expected.value) && !mismatch, expected: expected.text, actual: actual.text, ...(expected.items ? { expectedItems: expected.items } : {}), ...(actual.items ? { actualItems: actual.items } : {}), ...(actual.detail ? { detail: actual.detail } : {}), ...(mismatch ? { write: `The step didn't write what it intended. ${mismatch}` } : {}) };
    } catch (e) { result = { ok: false, expected: "", actual: String((e as Error).message ?? e), stopped: e instanceof StepStopped }; }
    await traceSettled();
    result.trace = trace;
    // The step's events stay in the activity log: the step carries how many its taker may see, and the link.
    result.eventCount = viewerEvents(run!.session, stack.collector.store.events({ session: run!.session, trace })).length;
    result.activityUrl = `${activityUrl(run!.session)}&trace=${trace}`;
    // A step that made no request says what it did instead.
    if (!result.eventCount) result.quiet = s.quiet ?? "This step made no requests.";
    result.chain = chainNow(tour);
    run!.results[s.id] = result;
    run!.pending = undefined;
  }

  return {
    knownIn,
    async fetch(req: Request, url: URL): Promise<Response> {
      const p = url.pathname;
      if (p === "/api/tours" && req.method === "GET") return json({ tours: TOURS.map(t => ({ id: t.id, title: t.title, summary: textOf(t.summary, sandbox), premise: t.premise(sandbox), steps: t.steps.length, chains: cardChains(t) })), cast: cast(), checks: PROTOCOL_CHECKS.map(f => ({ id: f.id, ...(CHECK_WORDS[f.id] ?? { title: f.title, summary: f.summary }) })), current: run?.tour.id ?? null });
      // Started from the root, where nobody's sandbox is, a tour gets a sandbox of its own.
      const fromRoot = p.match(/^\/api\/tours\/([^/]+)\/start$/);
      if (fromRoot && req.method === "POST") {
        if (!tourById(fromRoot[1]!)) return json({ error: "unknown tour" }, 404);
        if (sandbox.id) return json({ error: "in a sandbox, a tour starts with its admin token: POST /api/sandbox/tours/{id}/start" }, 409);
        const w = stack.sandboxes.mint();
        return json({ sandbox: { id: w.id, base: w.prefix }, tour: fromRoot[1] }, 201);
      }
      // The rest is the sandbox's management API.
      if (p === "/api/sandbox/tours/state" && req.method === "GET") {
        // A sandbox shows a tour's steps, and what the model expects of the first, before any runs. Reading it starts nothing.
        const want = tourById(url.searchParams.get("tour") ?? "");
        return json(want && (!run || run.tour.id !== want.id) ? preview(want) : state());
      }
      if (req.method !== "POST" || !p.startsWith("/api/sandbox/tours/")) return new Response("not found", { status: 404 });
      if (!sandbox.id) return json({ error: "a tour runs in a sandbox of its own: start one at /api/tours/{id}/start" }, 409);
      const started = p.match(/^\/api\/sandbox\/tours\/([^/]+)\/start$/);
      if (started) {
        const tour = tourById(started[1]!);
        if (!tour) return json({ error: "unknown tour" }, 404);
        // A tour starts the sandbox over from what's on file, and runs there.
        startOver(sandbox);
        run = undefined;
        return json({ sandbox: { id: sandbox.id, base: sandbox.prefix }, tour: tour.id }, 201);
      }
      const stepped = p.match(/^\/api\/sandbox\/tours\/([^/]+)\/steps\/([^/]+)\/(begin|finish)$/);
      if (stepped) {
        const tour = tourById(stepped[1]!);
        if (!tour) return json({ error: "unknown tour" }, 404);
        if (run && run.tour.id !== tour.id) return json({ error: "this sandbox runs another tour: start this one to run it here" }, 409);
        if (!run) begin(tour);
        const s = tour.steps.find(x => x.id === stepped[2]);
        if (!s) return json({ error: "no such step" }, 404);
        if (run!.results[s.id]) return json({ error: "this step has already run: start the tour again to rerun it" }, 409);
        const pending = tour.steps.find(x => !run!.results[x.id]);
        if (pending !== s) return json({ error: `run "${pending?.title}" first` }, 409);
        if (stepped[3] === "begin") {
          // Beginning again, say after a reload, replaces a step the page didn't finish.
          try { return json(beginStep(s)); }
          catch (e) { run!.results[s.id] = { ok: false, expected: "", actual: String((e as Error).message ?? e), stopped: e instanceof StepStopped, chain: chainNow(tour) }; return json({ state: state() }); }
        }
        if (run!.pending?.step !== s.id) return json({ error: "begin the step first" }, 409);
        const body: any = await req.json().catch(() => ({}));
        await finishStep(s, body?.seen);
        return json(state());
      }
      return new Response("not found", { status: 404 });
    },
  };
}
