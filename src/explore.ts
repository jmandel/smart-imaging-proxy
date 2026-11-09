// Explore's server side. Picking someone runs a real launch, or for a service the work it starts from,
// then a real search, here in the demo server, as an app's own server would. The token stays in this
// file's sessions: `view` builds everything the page receives. What the page shows of a study it
// takes from search and the Imaging Server's explain, and never a study the viewer's routes don't reach.
import { randomBytes } from "node:crypto";
import { ath, boundaryOf, createModel, readMultipart, ref, type CatalogStudy } from "@smart-imaging-proxy/core";
import { APP_NAMES, PATIENT_NAMES, RELATIONSHIPS, USERS, type BackendClient } from "./auth-server";
import { chainFor, type Chain } from "./chain";
import { PEOPLE_LINES, SERVICE_LINES } from "./cast";
import { readJson, refuseWrite } from "./settings-api";
import { RULE_SETS } from "./rule-presets";
import { accountUrl, submitAppRevocation, submitDelegation, submitRevocation } from "./flows/oauth";
import { ACCEPT_ANY, browserFetch, Ctx } from "./flows/runtime";
import { citedBy, referralsFrom, reportTitle } from "./referrals";
import { referenceModel } from "./reference-model";
import { nameOf, type Sandbox } from "./sandbox";
import { patientAttributes } from "./stores";
import { recordEvent, runInSession, sessionKey, tfetch, traceSettled, withSpan } from "./trace";
import { forViewer, viewerKnows } from "./viewer-events";
import { chainLine } from "./activity";
import type { Stack } from "./stack";

const MAX_SESSIONS = 20;
const COOKIE = "explore_session";
const APP = "portal-app";
/** Series that hold no picture to show. */
const NOT_IMAGES = new Set(["SR", "PR", "KO", "DOC", "SEG", "RTSTRUCT", "RTPLAN"]);
const STORED_ANY = "multipart/related; type=application/dicom; transfer-syntax=*";
/** A DICOM UID: digits in dot-separated components, no leading zero in a component, at most 64 characters. */
export const DICOM_UID = /^(?=.{1,64}$)(0|[1-9][0-9]*)(\.(0|[1-9][0-9]*))*$/;

type Status = "signing-in" | "results" | "no-access" | "declined" | "forbidden" | "token-rejected" | "failed";
interface Start { kind: "user"; user: string; patient?: string; mode: "scripted" | "window"; sites?: string[]; }
interface ServiceStart { kind: "service"; client: string; referral: string; }
interface Retrieval { study: string; running: boolean; status?: number; authz?: string; parts: number; wireBytes: number; dicomBytes: number; encoding?: string; complete: boolean; error?: string; ms?: number; }
interface Session {
  id: string; name: string; c: Ctx; start: Start | ServiceStart; running: boolean; status: Status;
  token?: string; tokenHash?: string; patient?: string; signedIn?: string;
  headline?: string; detail?: string;
  /** Technical detail behind the view, shown labelled as such. */
  tech?: string;
  sheets: any[]; endpoints: Map<string, { address: string; uid: string; series: any[]; modality: string }>;
  knowable: Set<string>; empty?: { text: string; actions: any[] }; actions: any[];
  retrievals: Map<string, Retrieval>; abort: AbortController; metadata: Map<string, Promise<any[] | undefined>>; cited?: string;
  /** The layer chain behind the view, as its viewer may see it. */
  chain?: Chain;
}
/** What adding a rule set does, said as the imaging network would. */
const RULE_SET_WORDS: Record<string, string> = {
  "hand-wrist-referral": "let the hand referral service see Josh's X-rays",
  "outside-release": "let the outside release service see Josh's CT scan, without its dose reports",
  "research-donation": "let the research donation service see all of Josh's studies",
};

const hex = (n: number) => randomBytes(n).toString("hex");
const first = (user: string) => USERS[user]?.name.split(" ")[0] ?? user;
const patientFirst = (patient: string) => (PATIENT_NAMES[patient] ?? patient).split(" ")[0]!;
const possessive = (name: string) => `${name}'s`;
const cap = (s: string) => s ? s[0]!.toUpperCase() + s.slice(1) : s;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Explore in one sandbox: the root, or a sandbox, whose sign-ins, searches and shares all stay in it. */
export function createExplore(sandbox: Sandbox, clients: Record<string, BackendClient>, stack: Stack) {
  const sessions = new Map<string, Session>();
  const json = (b: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(b, { status, headers });
  const sandboxRef = sandbox.id ? { id: sandbox.id, base: sandbox.prefix } : null;
  const model = createModel({ patientOf: user => USERS[user]?.patient, attributesOf: patientAttributes, now: () => sandbox.clock.now(), name: nameOf });
  const studiesOf = (patient: string) => sandbox.catalog.allStudies().filter(st => st.patient === patient);
  /** The ids of a patient's studies some route reaches for a user, before any app approval. */
  const reachedBy = (user: string, patient: string) => new Set(model.visible(sandbox.store.patientSnapshot(ref("patient", patient)), ref("user", user), ref("patient", patient), studiesOf(patient), USERS[user]?.fhirUser).map(st => st.id));
  const sitesOf = (studies: CatalogStudy[]) => [...new Set(studies.flatMap(s => s.site ? [s.site] : []))];
  const reachedSites = (user: string, patient: string) => { const r = reachedBy(user, patient); return sitesOf(studiesOf(patient).filter(s => r.has(s.id))); };
  /** The sites a person may name to someone else: those of what they see as the patient or a guardian. */
  const nameable = (user: string, patient: string) => { const snap = sandbox.store.patientSnapshot(ref("patient", patient)); return sitesOf(studiesOf(patient).filter(st => model.baseline(snap, ref("user", user), ref("patient", patient), st).ok)); };

  /** Everyone a person holds, as the Imaging Server's model decides it. */
  function recordsOf(id: string) {
    const u = USERS[id]!;
    const out: { patient: string; name: string; via: "self" | "guardian" | "share"; relationship?: string }[] = [];
    if (u.patient) out.push({ patient: u.patient, name: patientFirst(u.patient), via: "self" });
    const mine = sandbox.store.personSnapshot(ref("user", id));
    for (const r of mine.relationships) {
      const patient = r.relation === "guardian_of" ? r.object.replace(/^patient:/, "") : undefined;
      if (patient && patient !== u.patient && !out.some(x => x.patient === patient) && model.guardianPolicies(sandbox.store.patientSnapshot(r.object), r.object).policies.length) out.push({ patient, name: patientFirst(patient), via: "guardian", relationship: "guardian" });
    }
    for (const s of mine.shares) {
      const patient = s.patient.replace(/^patient:/, "");
      if (s.with !== ref("user", id) || out.some(r => r.patient === patient) || !model.sharingFor(sandbox.store.patientSnapshot(s.patient), s.from, s.patient).policy) continue;
      out.push({ patient, name: patientFirst(patient), via: "share", relationship: s.label });
    }
    return out;
  }
  /** Who could share a patient's records: the patient's own account, and guardians on file. */
  const sharersOf = (patient: string) => [
    ...Object.entries(USERS).filter(([, u]) => u.patient === patient).map(([id]) => id),
    ...sandbox.store.patientSnapshot(ref("patient", patient)).relationships.filter(r => r.relation === "guardian_of" && r.object === ref("patient", patient)).map(r => r.subject.replace(/^user:/, "")),
  ].filter((v, i, a) => a.indexOf(v) === i && USERS[v]);
  /** A share someone could make for this person, from their own account page. */
  const shareOffer = (from: string, to: string, patient: string) => ({ kind: "share", label: `As ${first(from)}: share ${from === "josh" && USERS[from]?.patient === patient ? "his" : possessive(patientFirst(patient))} studies with ${first(to)}`, from, with: to, patient, sites: nameable(from, patient) });
  const serviceName = (client: string) => cap(nameOf(ref("service", client)).replace(/^the /, ""));
  const referrals = () => referralsFrom(sandbox.catalog, sandbox.urls.clinicalFhir);

  /** Who someone is, in one line that says why they're in the demo. */
  const castOf = (id: string) => PEOPLE_LINES[id] ?? (USERS[id]?.patient ? "A patient" : "A person with an account");
  function options() {
    const linked = new Set(sandbox.catalog.linkedPatients());
    return {
      people: Object.entries(USERS).map(([id, u]) => {
        const records = recordsOf(id);
        const held = new Set(records.map(r => r.patient));
        const own = u.patient ? studiesOf(u.patient).length : undefined;
        // Others whose records could be shared with this person: anyone with an account and studies.
        const others = Object.values(USERS).flatMap(o => o.patient && !held.has(o.patient) && linked.has(o.patient) && studiesOf(o.patient).length ? [{ patient: o.patient, name: patientFirst(o.patient) }] : []);
        return { id, name: first(id), first: first(id), role: castOf(id), records, others, ...(own === undefined ? {} : { own }) };
      }),
      services: Object.keys(clients).map(id => {
        const mine = sandbox.store.policiesOf("service-access").filter(r => r.service === `service:${id}`);
        return { id, name: serviceName(id), role: SERVICE_LINES[id] ?? "A backend service", policies: mine.length };
      }),
      relationships: RELATIONSHIPS, sandbox: sandboxRef, backend: sandbox.backend, app: APP_NAMES[APP],
      names: { ...Object.fromEntries(Object.keys(USERS).map(id => [`user:${id}`, first(id)])), ...Object.fromEntries(Object.keys(PATIENT_NAMES).map(id => [`patient:${id}`, patientFirst(id)])), ...Object.fromEntries(Object.keys(clients).map(id => [`client:${id}`, serviceName(id)])), ...Object.fromEntries(Object.entries(APP_NAMES).map(([id, n]) => [`app:${id}`, `the ${n}`])) },
    };
  }

  /** The referrals a service works from, with the report each cites. Only a service is given them. */
  const referralList = () => referrals().map(r => { const c = citedBy(r.bundle); return { id: r.id, reason: c.reason, report: c.report, patient: patientFirst(r.bundle.entry[0].resource.subject.reference.split("/").pop()) }; });

  const act = async <T>(s: Session, name: string, attrs: Record<string, unknown>, fn: () => Promise<T>): Promise<T> => {
    s.c.beginStep();
    try { return await runInSession(s.name, () => withSpan("user", "action", name, { backend: sandbox.backend, ...attrs }, fn, { session: s.name, trace: hex(16) })); }
    finally { await traceSettled(); }
  };

  /** Every page of a search, followed to the end. */
  async function searchAll(s: Session, query: string, actor: string) {
    let url: string | undefined = `${sandbox.urls.imaging}/fhir/ImagingStudy?${query}`;
    const entries: any[] = [];
    let status = 200, body: any;
    while (url) {
      const r = await s.c.searchPage("Search ImagingStudy", s.token, url, actor);
      status = r.status; body = r.body;
      if (r.status !== 200) break;
      entries.push(...(r.body.entry ?? []));
      url = r.next;
    }
    return { status, body, entries };
  }

  /** The film sheets search returned, with each one's Endpoint kept here. */
  function sheetsFrom(s: Session, entries: any[], rows: Map<string, any>) {
    const byUrl = new Map(entries.filter(e => e.resource.resourceType === "Endpoint").map(e => [e.fullUrl, e.resource]));
    return entries.filter(e => e.resource.resourceType === "ImagingStudy").map(e => {
      const st = e.resource, row = rows.get(st.id);
      const ep: any = st.endpoint && byUrl.get(st.endpoint[0].reference);
      const uid = st.identifier?.[0]?.value?.replace("urn:oid:", "");
      const series = (st.series ?? []).map((x: any) => ({ uid: x.uid, number: x.number, modality: x.modality?.code, description: x.description, instances: (x.instance ?? []).map((i: any) => ({ uid: i.uid, number: i.number })) }));
      const modality = (st.modality ?? [])[0]?.code ?? "OT";
      if (ep) s.endpoints.set(st.id, { address: ep.address, uid, series, modality });
      const withheldSeries = row?.withheldSeries?.length ?? 0;
      return {
        id: st.id, title: reportTitle({ title: row?.title, description: st.description, id: st.id }), site: row?.site, date: st.started, released: true,
        modalities: (st.modality ?? []).map((m: any) => m.code), seriesCount: st.numberOfSeries, instanceCount: st.numberOfInstances,
        partial: withheldSeries ? `${plural(withheldSeries, "series", "series")} withheld` : undefined,
        series: series.map((x: any) => ({ number: x.number, modality: x.modality, description: x.description, instances: x.instances.length })),
        thumb: ep && thumbOf(series) ? true : false, retrievable: !!ep,
      };
    });
  }
  const withheldSheet = (row: any, title?: string) => ({
    id: row.id, title: title ?? reportTitle(row), site: row.site, date: row.date ? `${row.date.slice(0, 4)}-${row.date.slice(4, 6)}-${row.date.slice(6, 8)}` : undefined,
    modalities: row.modalities, released: false, reason: row.why, series: [], thumb: false, retrievable: false,
  });

  async function runUser(s: Session, st: Start) {
    const user = st.user;
    const t = await s.c.launch(user, APP, { window: st.mode === "window", sites: st.sites, patient: st.patient });
    s.signedIn = s.c.signedIn ?? (st.mode === "window" ? undefined : user);
    const who = s.signedIn ?? user;
    const records = recordsOf(who);
    const patient = t.patient ?? st.patient ?? records[0]?.patient;
    s.patient = patient;
    if (!t.access_token) {
      const held = patient && records.some(r => r.patient === patient);
      s.status = held && t.error === "access_denied" ? "declined" : t.error === "access_denied" ? "no-access" : "failed";
      if (!patient) {
        s.headline = `No one shares any studies with ${first(who)}`;
        // Anyone who holds records with studies could share them.
        const offers = sandbox.catalog.linkedPatients().filter(p => studiesOf(p).length).flatMap(patient => sharersOf(patient).filter(x => x !== who).map(from => ({ from, patient })));
        s.empty = { text: `${first(who)} can see no one's studies, so there was nothing for ${first(who)} to let the app see.`, actions: offers.map(o => shareOffer(o.from, who, o.patient)) };
        s.tech = `The sign-in ended with ${t.error ?? "an error"}, and the app has no access token.`;
        return;
      }
      const x: any = await sandbox.explain({ client: APP, patient, user: who, fhirUser: USERS[who]?.fhirUser ?? "" });
      const snap = sandbox.store.patientSnapshot(ref("patient", patient)), me = ref("user", who);
      // With no row giving a route, the reason is the route's, which names no study.
      const anyRow = USERS[who]?.patient === patient || snap.relationships.some(r => r.subject === me) || snap.shares.some(sh => sh.with === me);
      const noRoute = !anyRow ? x.studies[0]?.why : undefined;
      if (s.status === "declined") {
        s.headline = `${first(who)} didn't approve the app`;
        s.empty = { text: `${first(who)} turned the ${APP_NAMES[APP]} down at sign-in, so it can't see ${possessive(patientFirst(patient))} studies.`, actions: [{ kind: "approve", label: `Sign in again and approve the ${APP_NAMES[APP]}` }] };
        s.tech = "The sign-in ended with access_denied, and the app has no access token.";
        return;
      }
      s.headline = `${first(who)} can't see ${possessive(patientFirst(patient))} studies`;
      s.tech = `The sign-in ended with ${t.error ?? "an error"}, and the app has no access token.`;
      s.empty = {
        text: noRoute ? `${first(who)} isn't ${possessive(patientFirst(patient))} guardian, and no one shares ${possessive(patientFirst(patient))} studies with ${first(who)}.` : `The sign-in didn't finish.`,
        actions: sharersOf(patient).filter(x => x !== who).map(from => shareOffer(from, who, patient)),
      };
      return;
    }
    s.token = t.access_token;
    s.signedIn = sandbox.auth.grantOf(t.access_token)?.sub ?? who;
    const search = await searchAll(s, new URLSearchParams({ patient: patient!, _include: "ImagingStudy:endpoint", _count: "100" }).toString(), "App");
    if (search.status !== 200) { s.status = search.status === 401 ? "token-rejected" : "failed"; s.headline = "The search was refused"; s.tech = `HTTP ${search.status}. ${search.body?.issue?.[0]?.diagnostics ?? ""}`.trim(); return; }
    const x: any = await sandbox.explain({ client: APP, patient: patient!, user: s.signedIn!, fhirUser: USERS[s.signedIn!]?.fhirUser ?? "" });
    const reached = reachedBy(s.signedIn!, patient!);
    s.knowable = reached;
    const rows = new Map<string, any>(x.studies.map((r: any) => [r.id, r]));
    const found = sheetsFrom(s, search.entries, rows);
    const foundIds = new Set(found.map(f => f.id));
    // Withheld from the app, but reached by a route: the person may know of these, and why the app doesn't see them.
    const withheld = x.studies.filter((r: any) => reached.has(r.id) && !foundIds.has(r.id)).map((r: any) => withheldSheet(r));
    s.sheets = [...found, ...withheld];
    s.status = "results";
    const via = records.find(r => r.patient === patient)?.via;
    // A viewer's headline never counts a patient's studies they may not know of.
    const total = s.sheets.length, app = APP_NAMES[APP]!;
    const self = via === "self", pname = patientFirst(patient!);
    const changeLabel = `Change what ${app} can see`;
    s.headline = total === 0 ? `${pname} has no studies on file` : self ? `${possessive(pname)} own studies` : `${possessive(pname)} studies ${first(s.signedIn!)} can see`;
    if (total) s.detail = found.length === total ? `The ${app} can see ${total === 1 ? "this one" : total === 2 ? "both" : `all ${total}`}.` : found.length ? `The ${app} can see ${found.length} of these ${total}.` : `The ${app} can see none of these.`;
    if (total === 0) s.empty = { text: `The search found nothing: ${pname} has no studies at any site.`, actions: otherPerson(s.signedIn!) };
    else if (!found.length) s.empty = { text: `${first(s.signedIn!)} hasn't let the ${app} see any of these.`, actions: [{ kind: "approve", label: changeLabel, sites: reachedSites(s.signedIn!, patient!), ticked: reachedSites(s.signedIn!, patient!) }] };
    // What this person can do from here.
    const sites = reachedSites(s.signedIn!, patient!);
    const approval = sandbox.store.personSnapshot(ref("user", s.signedIn!)).approvals.find(a => a.app === ref("app", APP) && a.patient === ref("patient", patient!));
    s.actions = sites.length ? [{ kind: "approve", label: changeLabel, sites, ticked: approval?.sites ?? sites }] : [];
    if ((via === "self" || via === "guardian") && nameable(s.signedIn!, patient!).length) {
      s.actions.push({ kind: "share", label: `Share ${possessive(pname)} studies with…`, from: s.signedIn, patient, sites: nameable(s.signedIn!, patient!), people: Object.keys(USERS).filter(id => id !== s.signedIn).map(id => ({ id, name: first(id) })) });
      for (const sh of sandbox.store.personSnapshot(ref("user", s.signedIn!)).shares.filter(x => x.from === ref("user", s.signedIn!) && x.patient === ref("patient", patient!))) {
        const to = sh.with.replace(/^user:/, "");
        s.actions.push({ kind: "unshare", label: `Stop sharing with ${first(to)}`, with: to });
      }
    }
    s.actions.push({ kind: "revoke-app", label: `Stop ${app}` });
  }

  async function runService(s: Session, st: ServiceStart) {
    const referral = referrals().find(r => r.id === st.referral);
    if (!referral) { s.status = "failed"; s.headline = "That referral isn't one the catalog makes"; return; }
    const cited = citedBy(referral.bundle);
    const base = `${sandbox.urls.clinicalFhir}/Patient/`;
    const onBase = !!cited.patientRef?.startsWith(base) && /^[A-Za-z0-9\-.]{1,64}$/.test(cited.patientRef.slice(base.length));
    recordEvent("app", { kind: "referral.checked", client: st.client, referral: referral.id, reference: cited.patientRef, authorizedBase: sandbox.urls.clinicalFhir, ok: onBase, accession: cited.accession, system: cited.system });
    if (!onBase || !cited.accession || !cited.system) { s.status = "failed"; s.headline = `${serviceName(st.client)} can't act on this referral`; s.empty = { text: !onBase ? `Its patient isn't on the clinical records server ${serviceName(st.client)} may use.` : "Its report doesn't say which study it's about.", actions: [] }; s.tech = !onBase ? `${cited.patientRef} isn't on ${sandbox.urls.clinicalFhir}` : "The report carries no accession number with a system."; return; }
    const patient = cited.patientRef!.slice(base.length);
    s.patient = patient;
    const t = await s.c.backendToken(st.client);
    if (!t.access_token) { s.status = "failed"; s.headline = `${serviceName(st.client)} couldn't sign in`; s.tech = t.error; return; }
    s.token = t.access_token;
    const query = new URLSearchParams({ patient: cited.patientRef!, identifier: `${cited.system}|${cited.accession}`, _include: "ImagingStudy:endpoint" }).toString();
    const search = await searchAll(s, query, st.client);
    const x: any = await sandbox.explain({ client: st.client, patient });
    // The study the referral cites: the service knows of it from the referral itself.
    const study = studiesOf(patient).find(c => c.accession === cited.accession);
    s.cited = study?.id;
    s.knowable = new Set(study ? [study.id] : []);
    const row = x.studies.find((r: any) => r.id === study?.id);
    const name = serviceName(st.client);
    const fix = study && applyFor(st.client, patient, study.id);
    if (search.status === 403) {
      s.status = "forbidden";
      s.headline = `${name} can't search ${possessive(patientFirst(patient))} studies`;
      s.empty = { text: `No imaging network rule lets the ${name.toLowerCase()} see ${possessive(patientFirst(patient))} studies, so its search is refused.`, actions: fix ? [fix] : referralToTry(st.client, st.referral) };
      s.tech = `HTTP 403. ${search.body?.issue?.[0]?.diagnostics ?? ""}`.trim();
      return;
    }
    if (search.status !== 200) { s.status = search.status === 401 ? "token-rejected" : "failed"; s.headline = "The search was refused"; s.tech = `HTTP ${search.status}. ${search.body?.issue?.[0]?.diagnostics ?? ""}`.trim(); return; }
    const rows = new Map<string, any>(x.studies.map((r: any) => [r.id, r]));
    const found = sheetsFrom(s, search.entries, rows);
    s.sheets = found.length ? found : row ? [withheldSheet(row, cited.report)] : [];
    s.status = "results";
    s.headline = found.length ? `${name} can see the study this referral cites` : `${name} can't see the study this referral cites`;
    if (!found.length) s.empty = { text: row ? `The search for the study the referral cites found nothing: ${row.why}.` : "No study matches the one the referral cites.", actions: fix ? [fix] : referralToTry(st.client, st.referral) };
    s.tech = `A FHIR search by patient and the report's accession number, ${cited.accession}.`;
  }
  /** Someone else to look as, for a view with nothing in it: the first person whose own records hold studies. */
  const otherPerson = (who: string) => Object.entries(USERS).filter(([id, u]) => id !== who && u.patient && studiesOf(u.patient).length).slice(0, 1).map(([id]) => ({ kind: "person", label: `See ${possessive(first(id))} studies`, user: id }));
  /** Another referral this service can act on: one whose study its policies, or one of its named rule sets, reach. */
  function referralToTry(client: string, not: string) {
    const r = referrals().find(x => {
      const st = sandbox.catalog.allStudies().find(c => c.id === x.study);
      return x.id !== not && st && (model.evaluate(sandbox.store.patientSnapshot(ref("patient", st.patient)), { client_id: client }, st).release !== "none" || !!applyFor(client, st.patient, st.id));
    });
    return r ? [{ kind: "referral", label: `Open the ${citedBy(r.bundle).report} referral`, referral: r.id }] : [];
  }
  /** A named rule set whose policy for this service would reach the study, checked with the reference model. */
  function applyFor(client: string, patient: string, study: string) {
    const doc = sandbox.store.snapshot();
    const studies = sandbox.catalog.allStudies().map(st => ({ id: st.id, patient: st.patient, site: st.site, labels: st.labels, date: st.date, modalities: [...new Set(st.series.map(x => x.modality))], seriesUids: st.series.map(x => x.uid) }));
    for (const set of RULE_SETS) {
      const rules = set.rules(sandbox.catalog)?.filter(r => r.service === `service:${client}`);
      if (!rules?.length) continue;
      const m = referenceModel({ doc: { ...doc, policies: [...doc.policies.filter(p => !rules.some(r => r.id === p.id)), ...rules] }, studies, now: sandbox.clock.now(), birthDate: p => patientAttributes(p)?.birthDate, patientOf: u => USERS[u]?.patient });
      if (m.serviceReach(client, patient).some(st => st.id === study)) return { kind: "apply-policy", label: `As the imaging network: ${RULE_SET_WORDS[set.id] ?? `add the rule "${set.label}"`}`, ruleSet: set.id, text: set.description };
    }
    return undefined;
  }

  /** Everything picking someone does: sign-in or the service's work, then the search. */
  async function run(s: Session) {
    const st = s.start;
    try {
      await act(s, st.kind === "user" ? `Explore: ${first(st.user)} signs in to the ${APP_NAMES[APP]}` : `Explore: ${serviceName(st.client)} works from a referral`, st.kind === "user" ? { user: st.user, patient: st.patient, mode: st.mode } : { client: st.client, referral: st.referral }, () => st.kind === "user" ? runUser(s, st) : runService(s, st));
    } catch (e) { s.status = "failed"; s.headline = "This didn't finish"; s.detail = String((e as Error).message ?? e); }
    finally {
      s.running = false; s.tokenHash = s.token ? ath(s.token).slice(0, 10) : undefined;
      // The chain holds only what this viewer may know of: with nothing known, there's no chain to show.
      if (s.patient) {
        const viewer = st.kind === "user" ? { user: s.signedIn ?? st.user, patient: s.patient, app: APP } : { service: st.client, patient: s.patient, cited: s.cited };
        try { s.chain = chainFor({ snap: sandbox.store.patientSnapshot(ref("patient", s.patient)), studies: sandbox.catalog.allStudies(), now: sandbox.clock.now(), viewer, known: new Set(knownOf(s)), title: st => reportTitle(st) }); } catch { s.chain = undefined; }
      }
    }
  }

  /** A new view. `keep` is the view it replaces, and `same` keeps its trace session, for a view an action on it restarts. */
  function begin(body: any, keep?: Session, same = false) {
    let start: Start | ServiceStart;
    const strings = (v: unknown) => Array.isArray(v) && v.every(x => typeof x === "string");
    if (typeof body.user === "string") {
      if (!Object.hasOwn(USERS, body.user)) return { error: "that isn't one of the demo accounts", status: 400 };
      if (body.patient !== undefined && !sandbox.catalog.linkedPatients().includes(body.patient)) return { error: "that patient isn't in the catalog's links", status: 400 };
      if (body.sites !== undefined && !strings(body.sites)) return { error: "sites must be a list", status: 400 };
      start = { kind: "user", user: body.user, mode: body.mode === "window" ? "window" : "scripted", ...(body.patient ? { patient: body.patient } : {}), ...(body.sites ? { sites: body.sites } : {}) };
    } else if (typeof body.client === "string") {
      if (!Object.hasOwn(clients, body.client)) return { error: "that isn't a registered backend client", status: 400 };
      const referral = typeof body.referral === "string" ? body.referral : referrals()[0]?.id;
      if (!referral || !referrals().some(r => r.id === referral)) return { error: "that isn't one of the referrals", status: 400 };
      start = { kind: "service", client: body.client, referral };
    } else return { error: "choose a user or a backend client", status: 400 };
    keep?.abort.abort();
    const id = keep?.id ?? randomBytes(24).toString("base64url");
    const c = new Ctx(sandbox, clients);
    const name = same && keep ? keep.name : sessionKey(sandbox.id, `explore-${start.kind === "user" ? start.user : start.client}-${hex(3)}`);
    c.session = name;
    const s: Session = { id, name, c, start, running: true, status: "signing-in", sheets: [], endpoints: new Map(), knowable: new Set(), actions: [], retrievals: new Map(), abort: new AbortController(), metadata: new Map() };
    sessions.delete(id);
    sessions.set(id, s);
    for (const k of sessions.keys()) { if (sessions.size <= MAX_SESSIONS) break; const old = sessions.get(k)!; if (old.running) continue; old.abort.abort(); sessions.delete(k); }
    run(s);
    return { session: s };
  }

  /** The diagram's title, from what it shows: who sees what, or who can't. */
  function whyTitle(s: Session) {
    const st = s.start, shown = s.sheets.filter(x => x.released).length, app = APP_NAMES[APP];
    if (st.kind === "service") return `Why the ${serviceName(st.client).toLowerCase()} finds ${shown ? "this study" : "nothing"}`;
    const who = first(s.signedIn ?? st.user), whose = s.patient ? possessive(patientFirst(s.patient)) : "anyone's";
    if (s.status !== "results") return `Why ${who} can't see ${whose} studies`;
    return shown ? `Why the ${app} sees ${shown === 1 ? "this study" : "these studies"}` : `Why the ${app} sees none of ${whose} studies`;
  }
  function view(s: Session) {
    const st = s.start;
    const who = st.kind === "user" ? { kind: "user", id: s.signedIn ?? st.user, name: first(s.signedIn ?? st.user), first: first(s.signedIn ?? st.user), asked: st.user } : { kind: "service", id: st.client, name: serviceName(st.client), first: serviceName(st.client), referral: st.referral };
    return {
      session: s.name, running: s.running, status: s.status, who, patient: s.patient, patientName: s.patient && patientFirst(s.patient),
      headline: s.running ? undefined : s.headline, detail: s.detail, tech: s.running ? undefined : s.tech, whyTitle: whyTitle(s), chain: s.running ? undefined : s.chain, sheets: s.sheets, empty: s.empty, actions: s.actions,
      authUrl: s.c.pendingAuthUrl ?? null, mode: st.kind === "user" ? st.mode : "scripted", tokenHash: s.tokenHash,
      activityUrl: `${sandbox.prefix}/activity?session=${encodeURIComponent(s.name)}`,
      retrievals: [...s.retrievals.values()],
    };
  }

  /** The instance a sheet's thumbnail shows, from the search result alone: the middle instance of the first image series. */
  function thumbOf(series: any[]) {
    const images = [...series].filter(x => !NOT_IMAGES.has(x.modality) && x.instances.length).sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
    const first = images[0];
    if (!first) return undefined;
    if (first.modality === "SM") return { series: first.uid, slide: true };
    const ordered = [...first.instances].sort((a: any, b: any) => (a.number ?? 0) - (b.number ?? 0));
    return { series: first.uid, instance: ordered[Math.floor((ordered.length - 1) / 2)].uid };
  }
  const tag = (o: any, t: string) => o?.[t]?.Value;
  /**
   * A slide's thumbnail instance, from its series metadata, read once a session. The pyramid's own
   * THUMBNAIL image, or else a VOLUME level of one frame. Never OVERVIEW, which can show the label,
   * and never a guess: a server that doesn't offer metadata, or a series with neither, gets none.
   */
  async function slideInstance(s: Session, study: string, series: string) {
    const ep = s.endpoints.get(study)!;
    let pending = s.metadata.get(series);
    if (!pending) {
      pending = (async () => {
        const r = await tfetch("app", "GET WADO-RS series metadata", `${ep.address}/studies/${ep.uid}/series/${series}/metadata`, { headers: { Authorization: `Bearer ${s.token}`, Accept: "application/dicom+json" } }, { study });
        if (!r.ok) { await r.body?.cancel(); return undefined; }
        return r.json() as Promise<any[]>;
      })().catch(() => undefined);
      s.metadata.set(series, pending);
    }
    const items = await pending;
    if (!items) return undefined;
    const typeOf = (i: any) => (tag(i, "00080008") ?? []) as string[];
    // The UID goes into a URL path, so only a well-formed one is used.
    const uidOf = (i: any) => { const v = tag(i, "00080018")?.[0]; return typeof v === "string" && DICOM_UID.test(v) ? v : undefined; };
    const thumb = items.find(i => typeOf(i)[2] === "THUMBNAIL" && uidOf(i));
    if (thumb) return uidOf(thumb);
    const levels = items.filter(i => typeOf(i)[2] === "VOLUME" && Number(tag(i, "00280008")?.[0] ?? 1) === 1 && uidOf(i)).sort((a, b) => Number(tag(a, "00280010")?.[0] ?? 0) * Number(tag(a, "00280011")?.[0] ?? 0) - Number(tag(b, "00280010")?.[0] ?? 0) * Number(tag(b, "00280011")?.[0] ?? 0));
    return levels[0] && uidOf(levels[0]);
  }

  /** One instance's bytes, retrieved through the proxy with this session's token, in its stored form. */
  async function thumbnail(s: Session, study: string, signal: AbortSignal): Promise<Response> {
    const ep = s.endpoints.get(study);
    const pick = ep && thumbOf(ep.series);
    if (!ep || !pick || !s.token) return json({ error: "this study has no picture to show here" }, 404);
    return runInSession(s.name, () => withSpan("user", "action", `Explore: draw the thumbnail for ${study}`, { study }, async () => {
      const instance = pick.slide ? await slideInstance(s, study, pick.series) : pick.instance;
      if (!instance) return json({ error: "the server offers no thumbnail image for this slide" }, 404);
      const res = await tfetch("app", "GET WADO-RS instance (thumbnail)", `${ep.address}/studies/${ep.uid}/series/${pick.series}/instances/${instance}`, { headers: { Authorization: `Bearer ${s.token}`, Accept: STORED_ANY, "Accept-Encoding": "zstd" }, decompress: false, signal } as any, { study });
      const boundary = boundaryOf(res.headers.get("content-type"));
      if (!res.ok || !boundary || !res.body) { await res.body?.cancel(); return json({ error: `the proxy answered ${res.status}` }, res.status === 200 ? 502 : res.status); }
      const decoded: ReadableStream<Uint8Array> = res.headers.get("content-encoding") === "zstd" ? res.body.pipeThrough(new DecompressionStream("zstd" as any) as any) : res.body;
      // The one part's bytes, as the page's decoder takes them.
      const parts = readMultipart(decoded as any, boundary)[Symbol.asyncIterator]();
      const body = new ReadableStream<Uint8Array>({
        async pull(c) {
          for (;;) {
            const n = await parts.next();
            if (n.done || n.value.type === "complete") { c.close(); return; }
            if (n.value.type === "truncated") { c.error(new Error("the response ended early")); return; }
            if (n.value.type === "data") { c.enqueue(n.value.bytes); return; }
          }
        },
        // The page went away: stop reading. The upstream fetch is aborted with it, so closing the
        // reader can reject, and that is the expected end, not an error.
        async cancel() { await parts.return?.(undefined)?.catch(() => {}); },
      });
      return new Response(body, { headers: { "content-type": "application/dicom", "cache-control": "no-store", "x-instance": instance, "x-modality": ep.series.find(x => x.uid === pick.series)?.modality ?? ep.modality } });
    }, { session: s.name, trace: hex(16) }));
  }

  /** The whole study, counted as it goes by, one chunk held at a time. */
  async function retrieve(s: Session, study: string, r: Retrieval) {
    const ep = s.endpoints.get(study)!;
    const started = performance.now();
    try {
      await act(s, `Explore: retrieve ${study}`, { study }, async () => {
        const res = await tfetch("app", "GET WADO-RS", `${ep.address}/studies/${ep.uid}`, { headers: { Authorization: `Bearer ${s.token}`, Accept: ACCEPT_ANY, "Accept-Encoding": "zstd" }, decompress: false, signal: s.abort.signal } as any, { study });
        r.status = res.status;
        r.authz = sandbox.proxy.events.findLast(e => e.path === new URL(`${ep.address}/studies/${ep.uid}`).pathname)?.authz;
        r.encoding = res.headers.get("content-encoding") ?? "identity";
        const boundary = boundaryOf(res.headers.get("content-type"));
        if (!res.ok || !boundary || !res.body) { await res.body?.cancel(); return; }
        const wire = res.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, out) { r.wireBytes += chunk.length; out.enqueue(chunk); } }));
        const decoded: ReadableStream<Uint8Array> = r.encoding === "zstd" ? wire.pipeThrough(new DecompressionStream("zstd" as any) as any) : wire;
        for await (const e of readMultipart(decoded as any, boundary)) {
          if (e.type === "start") r.parts++;
          else if (e.type === "data") r.dicomBytes += e.bytes.length;
          else if (e.type === "complete") r.complete = true;
        }
        if (!r.complete) r.error = "the response ended without its closing boundary";
      });
    } catch (e) { r.error = String((e as Error).message ?? e); }
    finally { r.ms = Math.round(performance.now() - started); r.running = false; }
  }

  /** The studies a session's viewer knows of beyond its events: what their routes reach, what's on their page, and the study a referral cites. */
  const knownOf = (s: Session) => [...s.knowable, ...s.sheets.map(x => x.id)];
  const idOfUid = (uid: string) => sandbox.catalog.studyByUid(uid)?.id;
  /** A session's events, or those given of it, as its viewer may see them. */
  function forSession(s: Session, events?: ReturnType<typeof stack.collector.store.events>) {
    const all = stack.collector.store.events({ session: s.name });
    return forViewer(events ?? all, viewerKnows(all, knownOf(s)), idOfUid);
  }
  /** What happened in this session, as recorded events, as its viewer may see them, and for a study, only what's about it: the same events the activity log shows for the session and study. */
  async function happened(s: Session, study?: string) {
    await traceSettled();
    const uid = study ? s.endpoints.get(study)?.uid ?? sandbox.catalog.allStudies().find(x => x.id === study)?.uid : undefined;
    const about = (e: any) => !e.links.some((l: string) => l.startsWith("uid:") || (l.startsWith("study:") && e.kind !== "search.returned")) || (study && (e.links.includes(`study:${study}`) || (uid && e.links.includes(`uid:${uid}`))));
    return forSession(s).filter(e => !study || about(e));
  }

  const sessionOf = (req: Request) => sessions.get(req.headers.get("cookie")?.match(new RegExp(`(?:^|; )${COOKIE}=([^;]+)`))?.[1] ?? "");
  const gone = () => json({ error: "This Explore session has ended. Pick someone to start again." }, 404);
  const waiting = (url: URL) => {
    const state = url.searchParams.get("state");
    if (!state) return undefined;
    for (const s of sessions.values()) if (s.c.pendingAuthUrl && new URL(s.c.pendingAuthUrl).searchParams.get("state") === state) return s;
    return undefined;
  };
  /** A change one person makes on the account page, then the same view again, as a new sign-in and search. */
  async function change(s: Session, name: string, fn: () => Promise<Response>) {
    let status = 0;
    await act(s, name, {}, async () => { const r = await fn(); status = r.status; });
    if (status !== 303) return json({ error: `the account page answered ${status}` }, 409);
    return undefined;
  }

  const byName = (name: string) => [...sessions.values()].find(s => s.name === name);
  return {
    /** What the viewer of this Explore session knows of beyond its events, if it's one of this sandbox's. */
    knownIn(name: string) { const s = byName(name); return s && knownOf(s); },
    receiveCallback(url: URL) { const s = waiting(url); s?.c.resolveCallback?.(url); return !!s; },
    callbackContext(url: URL) { return waiting(url)?.c.callbackContext; },
    async fetch(req: Request, url: URL): Promise<Response> {
      const p = url.pathname.slice("/api/explore".length);
      if (req.method === "GET") {
        if (p === "/options") return json(options());
        if (p === "/referrals") {
          const service = url.searchParams.get("service") ?? "";
          if (!Object.hasOwn(clients, service)) return json({ error: "name a registered backend service" }, 400);
          return json({ service, referrals: referralList() });
        }
        const s = sessionOf(req);
        if (p === "/session") return json({ session: s ? view(s) : null, sandbox: sandboxRef, backend: sandbox.backend });
        if (!s) return gone();
        if (p === "/happened") {
          // One line for a study's chain, and the link to it in the activity log.
          const study = url.searchParams.get("study") ?? "";
          if (!s.sheets.some(x => x.id === study)) return json({ error: "that study isn't on this page" }, 404);
          return json({ line: chainLine(await happened(s, study)), activityUrl: `${view(s).activityUrl}&study=${encodeURIComponent(study)}` });
        }
        if (p === "/thumbnail") {
          const study = url.searchParams.get("study") ?? "";
          // A withheld study, or one that isn't this session's, gets nothing fetched.
          if (!s.sheets.some(x => x.id === study && x.released && x.thumb)) return json({ error: "this study has no picture to show here" }, 404);
          return thumbnail(s, study, req.signal);
        }
        return new Response("not found", { status: 404 });
      }
      if (req.method !== "POST") return new Response("not found", { status: 404 });
      const refused = refuseWrite(req, url);
      if (refused) return refused;
      const body = await readJson(req);
      if (body === undefined || body === null || typeof body !== "object" || Array.isArray(body)) return json({ error: "the request body must be a JSON object" }, 400);
      const cookie = (s: Session) => ({ "Set-Cookie": `${COOKIE}=${s.id}; HttpOnly; SameSite=Strict; Path=${sandbox.prefix}/api/explore` });
      if (p === "/start") {
        const r = begin(body, sessionOf(req));
        if ("error" in r) return json({ error: r.error }, r.status);
        return json({ session: view(r.session), sandbox: sandboxRef, backend: sandbox.backend }, 202, cookie(r.session));
      }
      const s = sessionOf(req);
      if (!s) return gone();
      if (s.running && p !== "/cancel") return json({ error: "this view is still loading" }, 409);
      if (p === "/cancel") { s.c.cancelWindow?.(body.stopped ? "You stopped waiting for this sign-in." : "The sign-in window closed before it finished."); return json({ session: view(s) }); }
      const again = (extra: Record<string, unknown> = {}) => {
        const st = s.start;
        const r = begin(st.kind === "user" ? { user: st.user, mode: st.mode, patient: s.patient ?? st.patient, ...extra } : { client: st.client, referral: st.referral }, s, true);
        return "error" in r ? json({ error: r.error }, r.status) : json({ session: view(r.session) }, 202, cookie(r.session));
      };
      if (p === "/share") {
        // A share is made by the patient or a guardian, on their own account page, for the person this view is about or someone they choose.
        const from = String(body.from ?? ""), to = String(body.with ?? ""), patient = String(body.patient ?? "");
        const sites = Array.isArray(body.sites) ? body.sites.filter((x: unknown) => typeof x === "string") : [];
        const relationship = RELATIONSHIPS.includes(body.relationship) ? body.relationship : RELATIONSHIPS[0]!;
        if (!USERS[from] || !USERS[to] || from === to || !sharersOf(patient).includes(from)) return json({ error: "that share isn't one this page offers" }, 400);
        const failed = await change(s, `Explore: ${first(from)} shares with ${first(to)}`, () => withSpan("user", "action", `Browser: ${first(from)} signs in and shares with ${first(to)}`, { sites: sites.join(", ") }, () => submitDelegation(accountUrl(from, undefined, undefined, sandbox.urls), { user: from, delegate: to, relationship, sites, patient }, browserFetch)));
        return failed ?? again(s.start.kind === "user" && s.start.user === to ? { patient } : {});
      }
      if (s.start.kind !== "user" && p !== "/apply-policy" && p !== "/retrieve") return json({ error: "a service has no account page" }, 400);
      const user = s.signedIn ?? (s.start.kind === "user" ? s.start.user : "");
      if (p === "/unshare") {
        const to = String(body.with ?? "");
        if (!s.patient || !sandbox.store.shares().some(x => x.from === ref("user", user) && x.with === ref("user", to) && x.patient === ref("patient", s.patient!))) return json({ error: "there's no such share" }, 400);
        const failed = await change(s, `Explore: ${first(user)} stops sharing with ${first(to)}`, () => submitRevocation(accountUrl(user, undefined, undefined, sandbox.urls), { user, delegate: to, patient: s.patient }, browserFetch));
        return failed ?? again();
      }
      if (p === "/revoke-app") {
        const failed = await change(s, `Explore: ${first(user)} revokes the app`, () => submitAppRevocation(accountUrl(user, undefined, undefined, sandbox.urls), { user, client: APP, patient: s.patient }, browserFetch));
        return failed ?? again();
      }
      if (p === "/approve") {
        if (body.sites !== undefined && !(Array.isArray(body.sites) && body.sites.every((x: unknown) => typeof x === "string"))) return json({ error: "sites must be a list" }, 400);
        return again({ ...(body.sites ? { sites: body.sites } : {}), ...(body.mode === "window" ? { mode: "window" } : {}) });
      }
      if (p === "/apply-policy") {
        if (s.start.kind !== "service") return json({ error: "a service-access policy is for a service" }, 400);
        const set = RULE_SETS.find(r => r.id === body.ruleSet);
        const rules = set?.rules(sandbox.catalog)?.filter(r => r.service === `service:${(s.start as ServiceStart).client}`);
        if (!set || !rules?.length) return json({ error: "that isn't a policy set for this service" }, 400);
        await act(s, `Explore: the organization applies "${set.label}"`, { ruleSet: set.id }, async () => { for (const r of rules) await sandbox.policy.putPolicy(r); });
        return again();
      }
      if (p === "/retrieve") {
        const study = String(body.study ?? "");
        if (!s.token || !s.endpoints.has(study)) return json({ error: "this study has no Endpoint in the search results" }, 400);
        if ([...s.retrievals.values()].some(r => r.running)) return json({ error: "a retrieval is still running" }, 409);
        const r: Retrieval = { study, running: true, parts: 0, wireBytes: 0, dicomBytes: 0, complete: false };
        s.retrievals.set(study, r);
        retrieve(s, study, r);
        return json({ session: view(s) }, 202);
      }
      return new Response("not found", { status: 404 });
    },
  };
}
