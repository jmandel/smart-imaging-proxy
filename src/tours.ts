// Tours: four short stories, each in a scope of its own. A step is an action only. What it should come
// to is computed by the reference model (src/reference-model.ts) from the scope's policy and catalog at
// that moment, and the check compares the system's real answer with the model's. "Run checks" runs the
// protocol flows in src/flows as one pass/fail list.
import { randomBytes } from "node:crypto";
import { ref, type PolicyDocument } from "@smart-imaging-proxy/core";
import { PATIENT_NAMES, USERS, type BackendClient } from "./auth-server";
import { defaultsFor, FLOWS, runStep, startFlowIn } from "./flows";
import { Ctx, StepStopped } from "./flows/runtime";
import { cascade, referenceModel, type RefStudy } from "./reference-model";
import { citedBy, referralsFrom, reportTitle } from "./referrals";
import { RULE_SETS } from "./rule-presets";
import { patientAttributes } from "./stores";
import { inScope, recordEvent, runInSession, sessionKey, traceSettled, withSpan } from "./trace";
import type { World } from "./world";
import type { Stack } from "./stack";

const APP = "portal-app";
const JOSH = "josh", SAM = "sam-caregiver", JOSH_PATIENT = "josh-example";
const SERVICE = "hand-referral-service";

/** A world's policy document now, with every row's id and basis. */
const documentOf = (world: World): PolicyDocument => { const { revision: _r, ...doc } = world.store.snapshot(); return doc; };
/** The reference model over a world as it is now, or with its document changed as given. */
export function modelOf(world: World, change?: (doc: PolicyDocument) => PolicyDocument) {
  const snap = documentOf(world);
  const doc = change ? change(snap) : snap;
  const studies: RefStudy[] = world.catalog.allStudies().map(st => ({ id: st.id, patient: st.patient, site: st.site, labels: st.labels, date: st.date, modalities: [...new Set(st.series.map(x => x.modality))], seriesUids: st.series.map(x => x.uid) }));
  return referenceModel({ doc, studies, now: world.clock.now(), birthDate: p => patientAttributes(p)?.birthDate, patientOf: u => USERS[u]?.patient });
}

const first = (user: string) => USERS[user]?.name.split(" ")[0] ?? user;
const list = (items: string[]) => items.length < 2 ? items.join("") || "nothing" : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const sorted = (xs: Iterable<string>) => [...xs].sort();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** What a check compares: a value, and how it reads. */
interface Answer { value: unknown; text: string; }
interface Run {
  world: World; c: Ctx; mode: "scripted" | "window"; state: Record<string, any>;
  model(change?: (doc: PolicyDocument) => PolicyDocument): ReturnType<typeof modelOf>;
  title(id: string): string;
}
interface TourStep {
  id: string; title: string; actor: string;
  /** The policy as it will be once this step's action is done: the expectation comes from it, and the store's policy after the step must match it. */
  intends?: (r: Run, doc: PolicyDocument) => PolicyDocument;
  expect(r: Run, m: ReturnType<typeof modelOf>): Answer;
  act(r: Run): Promise<Answer>;
}
interface Tour { id: string; title: string; summary: string; note?: string; steps: TourStep[]; }

const studyText = (r: Run, ids: string[]) => ids.length ? `${plural(ids.length, "study", "studies")}: ${list(ids.map(id => r.title(id)))}` : "no studies";
const reachText = (r: Run, ids: string[]) => ({ value: sorted(ids), text: studyText(r, sorted(ids)) });
const statusText = (status: number) => ({ value: status, text: status === 200 ? "200, and the images" : `${status}, and no images` });

/** Sites in a fixed order, so a tour reads the same on every catalog. */
const joshSites = (r: Run) => sorted(new Set(r.world.catalog.allStudies().filter(s => s.patient === JOSH_PATIENT).flatMap(s => s.site ? [s.site] : [])));
/** A share of every site but the last, so narrowing shows. */
const someSites = (r: Run) => { const all = joshSites(r); return all.length > 1 ? all.slice(0, -1) : all; };
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
    return sh ? `share from ${sh.from} with ${sh.with}` : "a row no longer on file";
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

/** A user's approval of the app for a patient, as a check reads it. */
const approvalText = (sites: string[] | undefined) => sites === undefined ? "every site" : list(sorted(sites));
function launchStep(id: string, user: string, patient: string, sites: (r: Run) => string[] | undefined, title: string): TourStep {
  const allSites = (r: Run) => sorted(new Set(r.world.catalog.allStudies().filter(s => s.patient === patient).flatMap(s => s.site ? [s.site] : [])));
  return {
    id, title, actor: first(user),
    expect(r, m) {
      if (!m.holds(user, patient)) return { value: { token: false }, text: `No token: ${first(user)} holds no record of ${PATIENT_NAMES[patient]}` };
      const asked = sites(r);
      const narrowed = asked ? asked.filter(s => m.approvableSites(user, patient).includes(s)) : undefined;
      // All of the patient's sites is the same as no limit.
      const approved = narrowed && !(narrowed.length && narrowed.length === allSites(r).length) ? sorted(narrowed) : undefined;
      return { value: { token: true, patient, sites: approved ?? "all" }, text: `A token for ${PATIENT_NAMES[patient]}, with the app approved for ${approvalText(approved)}` };
    },
    async act(r) {
      const t = await r.c.launch(user, APP, { window: r.mode === "window", sites: sites(r), patient });
      if (!t.access_token) return { value: { token: false }, text: `No token: the sign-in ended with ${t.error}` };
      r.state[`token:${user}`] = t.access_token;
      r.state[`tokenExp:${user}`] = r.world.clock.now() + (t.expires_in ?? 0);
      const a = r.world.store.approvals().find(x => x.by === ref("user", user) && x.app === ref("app", APP) && x.patient === ref("patient", t.patient));
      const approved = a?.sites ? sorted(a.sites) : undefined;
      return { value: { token: true, patient: t.patient, sites: approved ?? "all" }, text: `A token for ${PATIENT_NAMES[t.patient] ?? t.patient}, with the app approved for ${approvalText(approved)}` };
    },
  };
}
function searchStep(id: string, user: string, patient: string, title: string): TourStep {
  return {
    id, title, actor: "The app",
    expect: (r, m) => reachText(r, m.appReach(user, APP, patient).map(s => s.id)),
    async act(r) {
      const s = await r.c.search(r.state[`token:${user}`], `patient=${patient}&_include=ImagingStudy:endpoint`);
      // The signed URLs a later step uses are the last ones search gave.
      if (Object.keys(s.studies).length) { r.state.found = s.studies; r.state.signedAt = r.world.clock.now(); }
      if (s.status !== 200) return { value: `HTTP ${s.status}`, text: `Search answered ${s.status}` };
      return reachText(r, Object.keys(s.studies));
    },
  };
}
/** A plain URL, as a client would use after learning a study's UID elsewhere: the proxy asks. */
function plainRetrieveStep(id: string, user: string, patient: string, pick: (r: Run, m: ReturnType<typeof modelOf>) => string | undefined, title: string): TourStep {
  const chosen = (r: Run) => r.state[`pick:${id}`] ??= pick(r, r.model());
  return {
    id, title, actor: "The app",
    expect(r, m) {
      const study = chosen(r);
      if (!study) return { value: "none", text: "There's no such study here" };
      return { ...statusText(m.appReach(user, APP, patient).some(s => s.id === study) ? 200 : 404), text: `${m.appReach(user, APP, patient).some(s => s.id === study) ? "200" : "404, the same as a study that doesn't exist"}, for ${r.title(study)}` };
    },
    async act(r) {
      const study = chosen(r);
      if (!study) return { value: "none", text: "There's no such study here" };
      const uid = r.world.catalog.allStudies().find(s => s.id === study)!.uid;
      const got = await r.c.retrieve("App", `Retrieve ${study} by UID`, r.c.studyUrl(r.c.plainBase(), uid), r.state[`token:${user}`]);
      return { value: got.status, text: `${got.status}${got.status === 404 ? ", the same as a study that doesn't exist" : ""}, for ${r.title(study)}` };
    },
  };
}
/** Of the studies search gave signed URLs for, the one with the fewest images, so a retrieval is quick. */
const smallestFound = (r: Run) => Object.keys(r.state.found ?? {}).sort((a, b) => (r.world.catalog.allStudies().find(s => s.id === a)?.instanceCount ?? 0) - (r.world.catalog.allStudies().find(s => s.id === b)?.instanceCount ?? 0))[0];
/**
 * The signed URL search gave for a study: the proxy answers from it alone until it expires, and after
 * that asks, and current policy decides.
 */
function signedRetrieveStep(id: string, user: string, patient: string, title: string, after = 0): TourStep {
  return {
    id, title, actor: "The app",
    expect(r, m) {
      const study = smallestFound(r);
      if (!study) return { value: "none", text: "An earlier search has to return a study first" };
      const lifetime = r.world.store.getSettings().contextLifetimeSeconds;
      const now = r.world.clock.now() + (after ? lifetime + after : 0);
      const exp = Math.min(r.state.signedAt + lifetime, r.state[`tokenExp:${user}`]);
      const status = now < exp ? 200 : now >= r.state[`tokenExp:${user}`] ? 401 : m.appReach(user, APP, patient).some(s => s.id === study) ? 200 : 404;
      const why = now < exp ? "the signed URL hasn't expired, so the proxy answers from it alone" : status === 404 ? "the signed URL has expired, so the proxy asks, and policy no longer releases it" : "the signed URL has expired, so the proxy asks";
      return { value: status, text: `${status}, for ${r.title(study)}: ${why}` };
    },
    async act(r) {
      const study = smallestFound(r);
      if (!study) throw new StepStopped("An earlier search has to return a study first");
      if (after) { const lifetime = r.world.store.getSettings().contextLifetimeSeconds; r.world.clock.advance(lifetime + after); }
      const f = r.state.found[study];
      const got = await r.c.retrieve("App", `Retrieve ${study} with its signed URL`, r.c.studyUrl(f.base, f.uid), r.state[`token:${user}`]);
      return { value: got.status, text: `${got.status}, for ${r.title(study)}, ${got.authz === "instant" ? "from the signed URL alone" : got.authz ? `after the proxy ${got.authz === "cached" ? "used a cached decision" : "asked"}` : ""}`.replace(/, $/, "") };
    },
  };
}
const accessOf = async (r: Run, user: string, patient: string) => {
  const a = await r.world.policy.access(user, USERS[user]!.fhirUser);
  const held = a.records.find(x => x.patient === patient);
  return held ? { value: sorted(held.sites), text: `${first(user)} holds ${PATIENT_NAMES[patient]}'s records at ${list(sorted(held.sites))}` } : { value: [], text: `${first(user)} holds none of ${PATIENT_NAMES[patient]}'s records` };
};
const holdsText = (user: string, patient: string, sites: string[]) => sites.length ? { value: sorted(sites), text: `${first(user)} holds ${PATIENT_NAMES[patient]}'s records at ${list(sorted(sites))}` } : { value: [], text: `${first(user)} holds none of ${PATIENT_NAMES[patient]}'s records` };
function shareStep(id: string, sites: (r: Run) => string[], title: string): TourStep {
  return {
    id, title, actor: first(JOSH), intends: (r, doc) => withShare(sites(r))(r, doc),
    expect: (_r, m) => holdsText(SAM, JOSH_PATIENT, m.approvableSites(SAM, JOSH_PATIENT)),
    async act(r) {
      const status = await r.c.delegate(JOSH, SAM, "caregiver", sites(r), { window: r.mode === "window", patient: JOSH_PATIENT });
      if (status !== 303) return { value: `HTTP ${status}`, text: `The account page answered ${status}` };
      return accessOf(r, SAM, JOSH_PATIENT);
    },
  };
}

/** The referral this tour's service works from, and one for a study outside its policy. */
const referralOf = (r: Run, modality: string) => referralsFrom(r.world.catalog, r.world.urls.clinicalFhir).find(x => { const st = r.world.catalog.allStudies().find(s => s.id === x.study)!; return st.patient === JOSH_PATIENT && st.series.some(s => s.modality === modality); });
function serviceSearchStep(id: string, modality: string, title: string): TourStep {
  return {
    id, title, actor: "The service",
    expect(r, m) {
      const ref = referralOf(r, modality);
      if (!ref) return { value: "none", text: "No referral here cites such a study" };
      if (!m.serviceMaySearch(SERVICE, JOSH_PATIENT)) return { value: 403, text: "403: no service-access policy covers the service for this patient" };
      const ids = m.serviceReach(SERVICE, JOSH_PATIENT).filter(s => s.id === ref.study).map(s => s.id);
      return { value: ids, text: ids.length ? `The study the referral cites: ${r.title(ref.study)}` : `No study: the policy withholds ${r.title(ref.study)}` };
    },
    async act(r) {
      const ref = referralOf(r, modality);
      if (!ref) return { value: "none", text: "No referral here cites such a study" };
      const cited = citedBy(ref.bundle);
      r.state.service ??= (await r.c.backendToken(SERVICE)).access_token;
      const s = await r.c.search(r.state.service, new URLSearchParams({ patient: cited.patientRef!, identifier: `${cited.system}|${cited.accession}`, _include: "ImagingStudy:endpoint" }).toString(), SERVICE);
      r.state.serviceFound = s.studies;
      if (s.status !== 200) return { value: s.status, text: `${s.status}: the service may not search this patient` };
      const ids = Object.keys(s.studies);
      return { value: ids, text: ids.length ? `The study the referral cites: ${r.title(ids[0]!)}` : `No study: the policy withholds ${r.title(ref.study)}` };
    },
  };
}

const TOURS: Tour[] = [
  {
    id: "caregiver", title: "Josh shares with a caregiver", summary: "Josh shares some sites with Sam. Sam gives an app one of them. Each link can only narrow what the one before allowed.",
    steps: [
      shareStep("share", someSites, "Josh shares some of his sites with Sam, on his account page"),
      launchStep("launch", SAM, JOSH_PATIENT, r => someSites(r).slice(0, 1), "Sam signs in, picks Josh's records, and gives the app one site"),
      searchStep("search", SAM, JOSH_PATIENT, "The app searches Josh's studies"),
      plainRetrieveStep("outside", SAM, JOSH_PATIENT, (r, m) => m.userReach(SAM, JOSH_PATIENT).find(s => !m.appReach(SAM, APP, JOSH_PATIENT).some(x => x.id === s.id))?.id ?? m.userReach(SAM, JOSH_PATIENT)[0]?.id, "The app asks for a study Sam holds and didn't give it"),
    ],
  },
  {
    id: "app-consent", title: "An app sees only the sites Josh approves", summary: "Consent at sign-in is kept as Imaging Server policy, not in the token. Search and retrieval both follow it.",
    steps: [
      launchStep("launch", JOSH, JOSH_PATIENT, r => joshSites(r).slice(-1), "Josh signs in and approves the app for one site"),
      searchStep("search", JOSH, JOSH_PATIENT, "The app searches Josh's studies"),
      signedRetrieveStep("signed", JOSH, JOSH_PATIENT, "The app retrieves a study with the signed URL search gave it"),
      plainRetrieveStep("outside", JOSH, JOSH_PATIENT, (_r, m) => m.userReach(JOSH, JOSH_PATIENT).find(s => !m.appReach(JOSH, APP, JOSH_PATIENT).some(x => x.id === s.id))?.id, "The app asks for a study at a site Josh didn't approve"),
    ],
  },
  {
    id: "revoke", title: "Revoking takes effect", summary: "Search changes at once. A signed URL already given out works until it expires, and then the proxy asks.",
    steps: [
      shareStep("share", r => joshSites(r), "Josh shares all his sites with Sam"),
      launchStep("launch", SAM, JOSH_PATIENT, () => undefined, "Sam signs in, picks Josh's records, and approves the app"),
      searchStep("search", SAM, JOSH_PATIENT, "The app searches Josh's studies"),
      {
        id: "revoke", title: "Josh stops sharing with Sam", actor: first(JOSH),
        // The share goes, and with it what rested only on it.
        intends: (_r, doc) => cascade({ ...doc, shares: doc.shares.filter(s => !(s.from === ref("user", JOSH) && s.with === ref("user", SAM))) }),
        expect: (_r, m) => holdsText(SAM, JOSH_PATIENT, m.approvableSites(SAM, JOSH_PATIENT)),
        async act(r) { await r.c.revokeDelegation(JOSH, SAM); return accessOf(r, SAM, JOSH_PATIENT); },
      },
      searchStep("search-again", SAM, JOSH_PATIENT, "The app searches again, with the same token"),
      signedRetrieveStep("signed", SAM, JOSH_PATIENT, "The app uses a signed URL it was given before"),
      signedRetrieveStep("expired", SAM, JOSH_PATIENT, "The signed URL expires, and the app tries it again", 1),
    ],
  },
  {
    id: "backend", title: "A service works from a referral", summary: "A consult referral names the patient on the clinical FHIR server and cites the imaging report, with its accession number. The service searches for exactly that study, and its service-access policy decides what it sees.",
    note: "Across organizations, a referral would carry an MRN instead, and the service would first resolve it with Patient?identifier=. That isn't shown here.",
    steps: [
      {
        id: "check", title: "The referral arrives, and the service checks the patient is on the FHIR server it's authorized for", actor: "The service",
        expect: r => ({ value: true, text: `The patient reference is on ${r.world.urls.clinicalFhir}` }),
        async act(r) {
          const ref = referralOf(r, "CR");
          if (!ref) throw new StepStopped("No referral here cites an X-ray");
          const cited = citedBy(ref.bundle);
          r.state.referral = ref.bundle;
          const ok = !!cited.patientRef?.startsWith(`${r.world.urls.clinicalFhir}/Patient/`);
          recordEvent("app", { kind: "referral.checked", client: SERVICE, referral: ref.id, reference: cited.patientRef, authorizedBase: r.world.urls.clinicalFhir, ok, accession: cited.accession, system: cited.system });
          return { value: ok, text: ok ? `${cited.patientRef} is on ${r.world.urls.clinicalFhir}` : `${cited.patientRef} isn't on ${r.world.urls.clinicalFhir}` };
        },
      },
      serviceSearchStep("search", "CR", "It gets a token, and searches for the patient and the report's accession number"),
      {
        id: "policy", title: "The organization gives the service a service-access policy", actor: "The organization",
        intends: (r, doc) => { const rules = RULE_SETS.find(s => s.id === "hand-wrist-referral")!.rules(r.world.catalog)!; return { ...doc, policies: [...doc.policies.filter(p => !rules.some(x => x.id === p.id)), ...rules] }; },
        expect: (r, m) => reachText(r, m.serviceReach(SERVICE, JOSH_PATIENT).map(s => s.id)),
        async act(r) {
          for (const rule of RULE_SETS.find(s => s.id === "hand-wrist-referral")!.rules(r.world.catalog)!) await r.world.policy.putPolicy(rule);
          const x: any = await r.world.explain({ client: SERVICE, patient: JOSH_PATIENT });
          return reachText(r, x.studies.filter((s: any) => s.release !== "none").map((s: any) => s.id));
        },
      },
      serviceSearchStep("search-again", "CR", "It searches again"),
      {
        id: "retrieve", title: "It retrieves the study", actor: "The service",
        expect: (r, m) => { const ref = referralOf(r, "CR"); return statusText(ref && m.serviceReach(SERVICE, JOSH_PATIENT).some(s => s.id === ref.study) ? 200 : 404); },
        async act(r) {
          const [study] = Object.keys(r.state.serviceFound ?? {});
          if (!study) return statusText(404);
          const f = r.state.serviceFound[study];
          return statusText((await r.c.retrieve(SERVICE, `Retrieve ${study}`, r.c.studyUrl(f.base, f.uid), r.state.service)).status);
        },
      },
      serviceSearchStep("outside", "CT", "A second referral cites a CT, which the policy doesn't cover"),
    ],
  },
];
export const tourById = (id: string) => TOURS.find(t => t.id === id);
export const PROTOCOL_CHECKS = FLOWS.filter(f => f.group === "protocol");

/** The tours and checks of one world. A tour runs in a scope minted for it, and a reload there comes back to it. */
export function createTours(world: World, clients: Record<string, BackendClient>, stack: Stack) {
  let run: { tour: Tour; r: Run; results: Record<string, any>; running?: string; session: string } | undefined;
  const json = (b: unknown, status = 200) => Response.json(b, { status });
  const title = (id: string) => { const s = world.catalog.allStudies().find(x => x.id === id); return s ? reportTitle(s) : id; };
  const activityUrl = (session: string, w: World = world) => `${w.prefix}/activity?session=${encodeURIComponent(session)}`;

  function begin(tour: Tour) {
    const c = new Ctx(world, clients);
    const session = sessionKey(world.scope, `tour-${tour.id}-${randomBytes(3).toString("hex")}`);
    c.session = session;
    const r: Run = { world, c, mode: "scripted", state: {}, model: change => modelOf(world, change ? doc => change(doc) : undefined), title };
    run = { tour, r, results: {}, session };
    return run;
  }
  /** Each step, with what the model says it should come to now, before it runs. */
  function state() {
    if (!run) return { scope: world.scope ? { id: world.scope, base: world.prefix } : null, tour: null };
    const { tour, r, results } = run;
    const next = tour.steps.find(s => !results[s.id]);
    let expect: string | undefined;
    if (next) { try { expect = next.expect(r, r.model(next.intends ? doc => next.intends!(r, doc) : undefined)).text; } catch (e) { expect = String((e as Error).message ?? e); } }
    return {
      scope: { id: world.scope, base: world.prefix }, session: run.session, activityUrl: activityUrl(run.session), running: run.running ?? null, pendingAuthUrl: r.c.pendingAuthUrl ?? null,
      tour: { id: tour.id, title: tour.title, summary: tour.summary, note: tour.note },
      steps: tour.steps.map(s => ({ id: s.id, title: s.title, actor: s.actor, ...(s === next ? { expect } : {}), ...(results[s.id] ? { result: results[s.id] } : {}) })),
    };
  }
  async function step(id: string, mode: "scripted" | "window") {
    const { tour, r } = run!;
    const s = tour.steps.find(x => x.id === id)!;
    r.mode = mode;
    r.c.beginStep();
    const trace = randomBytes(16).toString("hex");
    let result: any;
    try {
      // Everything is decided before the action: a step that changes policy is checked against the model
      // of the policy it intends, and then the store's policy against that intended policy.
      const intended = s.intends?.(r, documentOf(world));
      const expected = s.expect(r, r.model(intended ? () => intended : undefined));
      const actual = await inScope(world.scope, () => runInSession(run!.session, () => withSpan("user", "action", `${tour.title}: ${s.title}`, { tour: tour.id, step: s.id, mode }, () => s.act(r), { session: run!.session, trace })));
      const mismatch = intended && writeMismatch(intended, documentOf(world));
      result = { ok: same(actual.value, expected.value) && !mismatch, expected: expected.text, actual: actual.text, ...(mismatch ? { write: `The step didn't write what it intended. ${mismatch}` } : {}) };
    } catch (e) { result = { ok: false, expected: "", actual: String((e as Error).message ?? e), stopped: e instanceof StepStopped }; }
    await traceSettled();
    result.trace = trace;
    result.events = stack.collector.store.events({ session: run!.session, trace });
    run!.results[id] = result;
    return result;
  }

  /** One protocol flow in a scope of its own, every step with its defaults, as one line. */
  async function check(flowId: string) {
    const flow = PROTOCOL_CHECKS.find(f => f.id === flowId)!;
    const w = stack.scopes.mint();
    const c = await startFlowIn(w, clients, flow);
    const failures: { step: string; label: string; detail?: string }[] = [];
    let passed = 0;
    for (const s of flow.steps) {
      try {
        const res = await runStep(c, flow, s.id, defaultsFor(c, flow, s.id));
        for (const k of res.checks) k.ok ? passed++ : failures.push({ step: s.title, label: k.label, detail: k.detail });
      } catch (e) { failures.push({ step: s.title, label: String((e as Error).message ?? e) }); }
    }
    return { id: flow.id, title: flow.title, ok: failures.length === 0, passed, failures, scope: w.scope, activityUrl: activityUrl(c.session, w) };
  }

  return {
    receiveCallback(url: URL) { if (!run?.r.c.pendingAuthUrl) return false; return run.r.c.receiveCallback(url); },
    callbackContext() { return run?.r.c.callbackContext; },
    async fetch(req: Request, url: URL): Promise<Response> {
      const p = url.pathname;
      if (p === "/api/tours" && req.method === "GET") return json({ tours: TOURS.map(t => ({ id: t.id, title: t.title, summary: t.summary, steps: t.steps.length })), checks: PROTOCOL_CHECKS.map(f => ({ id: f.id, title: f.title, summary: f.summary })), current: run?.tour.id ?? null, scope: world.scope ? { id: world.scope, base: world.prefix } : null });
      if (p === "/api/tours/state" && req.method === "GET") {
        // A scope minted for a tour shows its steps, and what the model expects of the first, before any runs.
        const want = tourById(url.searchParams.get("tour") ?? "");
        if (!run && world.scope && want) begin(want);
        return json(state());
      }
      if (req.method !== "POST") return new Response("not found", { status: 404 });
      const started = p.match(/^\/api\/tours\/([^/]+)\/start$/);
      if (started) {
        const tour = tourById(started[1]!);
        if (!tour) return json({ error: "unknown tour" }, 404);
        // A tour gets a scope of its own, seeded from what's on file.
        const w = stack.scopes.mint();
        return json({ scope: { id: w.scope, base: w.prefix }, tour: tour.id }, 201);
      }
      const stepped = p.match(/^\/api\/tours\/([^/]+)\/steps\/([^/]+)$/);
      if (stepped) {
        if (!world.scope) return json({ error: "a tour runs in its own scope: start it, and run its steps at that scope's URLs" }, 409);
        const tour = tourById(stepped[1]!);
        if (!tour) return json({ error: "unknown tour" }, 404);
        if (run && run.tour.id !== tour.id) return json({ error: "this scope runs another tour: start this one to get its own scope" }, 409);
        if (!run) begin(tour);
        if (run!.running) return json({ error: "a step is still running" }, 409);
        const s = tour.steps.find(x => x.id === stepped[2]);
        if (!s) return json({ error: "no such step" }, 404);
        if (run!.results[s.id]) return json({ error: "this step has already run: start the tour again to rerun it" }, 409);
        const pending = tour.steps.find(x => !run!.results[x.id]);
        if (pending !== s) return json({ error: `run "${pending?.title}" first` }, 409);
        const body: any = await req.json().catch(() => ({}));
        run!.running = s.id;
        try { await step(s.id, body?.mode === "window" ? "window" : "scripted"); } finally { run!.running = undefined; }
        return json(state());
      }
      if (p === "/api/tours/cancel") { run?.r.c.cancelWindow?.("The sign-in window closed before it finished."); return json(state()); }
      const checked = p.match(/^\/api\/checks\/([^/]+)$/);
      if (checked) {
        if (!PROTOCOL_CHECKS.some(f => f.id === checked[1])) return json({ error: "unknown check" }, 404);
        return json(await check(checked[1]!));
      }
      return new Response("not found", { status: 404 });
    },
  };
}
