// Explore's server side: what the sandbox says about a view, never the protocol. The page picks a person
// and patient, or a service and a referral, gets its own token, and searches and retrieves itself. Here are
// the cast, the referrals services work from, and a view explained from policy: its headline, the studies a
// viewer may know of with why each is or isn't released, the layer chain, and what could change it. All of
// it is the sandbox's management API, read with the admin token. Nothing here takes a token or a search.
import { createModel, ref, type CatalogStudy } from "@smart-imaging-proxy/core";
import { APP_NAMES, PATIENT_NAMES, RELATIONSHIPS, USERS, type BackendClient, DEMO_BACKEND_CLIENTS } from "./auth-server";
import { chainFor } from "./chain";
import { PEOPLE_LINES, SERVICE_LINES } from "./cast";
import { RULE_SETS } from "./rule-presets";
import { citedBy, referralsFrom, reportTitle } from "./referrals";
import { referenceModel } from "./reference-model";
import { nameOf, type Sandbox } from "./sandbox";
import { patientAttributes } from "./stores";
import { traceSettled } from "./trace";
import { forViewer, viewerKnows } from "./viewer-events";
import { chainLine } from "./activity";
import type { Stack } from "./stack";

const APP = "portal-app";
/** Explore's views the server has explained, at most this many, by their trace session: what each one's viewer may know of. */
const MAX_VIEWS = 200;

/** What adding a rule set does, said as the imaging network would. */
const RULE_SET_WORDS: Record<string, string> = {
  "hand-wrist-referral": "let the hand referral service see Josh's X-rays",
  "outside-release": "let the outside release service see Josh's CT scan, without its dose reports",
  "research-donation": "let the research donation service see all of Josh's studies",
};

const first = (user: string) => USERS[user]?.name.split(" ")[0] ?? user;
const patientFirst = (patient: string) => (PATIENT_NAMES[patient] ?? patient).split(" ")[0]!;
const possessive = (name: string) => `${name}'s`;
const cap = (s: string) => s ? s[0]!.toUpperCase() + s.slice(1) : s;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Explore's reads for one sandbox: the root, or a sandbox, whose policy they explain. */
export function createExplore(sandbox: Sandbox, clients: Record<string, BackendClient>, stack: Stack) {
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
        return { id, name: first(id), first: first(id), fhirUser: u.fhirUser, role: castOf(id), records, others, ...(own === undefined ? {} : { own }) };
      }),
      services: Object.keys(clients).map(id => {
        const mine = sandbox.store.policiesOf("service-access").filter(r => r.service === `service:${id}`);
        return { id, name: serviceName(id), role: SERVICE_LINES[id] ?? "A backend service", policies: mine.length };
      }),
      relationships: RELATIONSHIPS, sandbox: sandboxRef, backend: sandbox.backend, app: APP_NAMES[APP],
      names: { ...Object.fromEntries(Object.keys(USERS).map(id => [`user:${id}`, first(id)])), ...Object.fromEntries(Object.keys(PATIENT_NAMES).map(id => [`patient:${id}`, patientFirst(id)])), ...Object.fromEntries(Object.keys(clients).map(id => [`client:${id}`, serviceName(id)])), ...Object.fromEntries(Object.entries(APP_NAMES).map(([id, n]) => [`app:${id}`, `the ${n}`])) },
    };
  }

  /** The referrals a service works from: the report each cites, and the patient reference and accession number its search uses. */
  const referralList = () => referrals().map(r => { const c = citedBy(r.bundle); return { id: r.id, reason: c.reason, report: c.report, patient: patientFirst(r.bundle.entry[0].resource.subject.reference.split("/").pop()), patientRef: c.patientRef, accession: c.accession, system: c.system }; });

  const withheldSheet = (row: any, title?: string) => ({
    id: row.id, title: title ?? reportTitle(row), site: row.site, date: row.date ? `${row.date.slice(0, 4)}-${row.date.slice(4, 6)}-${row.date.slice(6, 8)}` : undefined,
    modalities: row.modalities, released: false, reason: row.why,
  });
  /** A person's view of a patient's studies, as their app would find it: from policy, the same evaluation search runs. */
  async function personView(user: string, asked?: string) {
    const records = recordsOf(user);
    const patient = asked ?? records[0]?.patient;
    if (!patient) {
      // Anyone who holds records with studies could share them.
      const offers = sandbox.catalog.linkedPatients().filter(p => studiesOf(p).length).flatMap(p => sharersOf(p).filter(x => x !== user).map(from => ({ from, patient: p })));
      return { status: "no-access", headline: `No one shares any studies with ${first(user)}`, empty: { text: `${first(user)} can see no one's studies, so there's nothing for ${first(user)}'s app to see.`, actions: offers.map(o => shareOffer(o.from, user, o.patient)) }, rows: [], actions: [], known: [] as string[] };
    }
    const x: any = await sandbox.explain({ client: APP, patient, user, fhirUser: USERS[user]?.fhirUser ?? "" });
    const reached = reachedBy(user, patient), held = records.find(r => r.patient === patient);
    const rows = new Map<string, any>(x.studies.map((r: any) => [r.id, r]));
    const released = x.studies.filter((r: any) => r.release !== "none");
    const app = APP_NAMES[APP]!, pname = patientFirst(patient);
    if (!held) return {
      patient, status: "no-access", headline: `${first(user)} can't see ${possessive(pname)} studies`, rows: [], actions: [], known: [...reached],
      empty: { text: `${first(user)} isn't ${possessive(pname)} guardian, and no one shares ${possessive(pname)} studies with ${first(user)}.`, actions: sharersOf(patient).filter(s => s !== user).map(from => shareOffer(from, user, patient)) },
    };
    // A viewer's headline never counts a patient's studies they may not know of.
    const shown = [...released.map((r: any) => sheetOf(r, true)), ...x.studies.filter((r: any) => reached.has(r.id) && r.release === "none").map((r: any) => sheetOf(r, false))];
    const total = shown.length, self = held.via === "self", sites = reachedSites(user, patient);
    const changeLabel = `Change what ${app} can see`;
    const approval = sandbox.store.personSnapshot(ref("user", user)).approvals.find(a => a.app === ref("app", APP) && a.patient === ref("patient", patient));
    const actions: any[] = sites.length ? [{ kind: "approve", label: changeLabel, sites, ticked: approval?.sites ?? sites }] : [];
    if ((held.via === "self" || held.via === "guardian") && nameable(user, patient).length) {
      actions.push({ kind: "share", label: `Share ${possessive(pname)} studies with…`, from: user, patient, sites: nameable(user, patient), people: Object.keys(USERS).filter(id => id !== user).map(id => ({ id, name: first(id) })) });
      for (const sh of sandbox.store.personSnapshot(ref("user", user)).shares.filter(s => s.from === ref("user", user) && s.patient === ref("patient", patient))) {
        const to = sh.with.replace(/^user:/, "");
        actions.push({ kind: "unshare", label: `Stop sharing with ${first(to)}`, with: to, patient });
      }
    }
    actions.push({ kind: "revoke-app", label: `Stop ${app}`, patient });
    return {
      patient, status: "results", rows: shown, actions, known: [...new Set([...reached, ...shown.map(r => r.id)])],
      headline: total === 0 ? `${pname} has no studies on file` : self ? `${possessive(pname)} own studies` : `${possessive(pname)} studies ${first(user)} can see`,
      ...(total ? { detail: released.length === total ? `The ${app} can see ${total === 1 ? "this one" : total === 2 ? "both" : `all ${total}`}.` : released.length ? `The ${app} can see ${released.length} of these ${total}.` : `The ${app} can see none of these.` } : {}),
      ...(total === 0 ? { empty: { text: `The search finds nothing: ${pname} has no studies at any site.`, actions: otherPerson(user) } }
        : !released.length ? { empty: { text: `${first(user)} hasn't let the ${app} see any of these.`, actions: [{ kind: "approve", label: changeLabel, sites, ticked: sites }] } } : {}),
    };
    function sheetOf(r: any, isReleased: boolean) {
      const withheldSeries = rows.get(r.id)?.withheldSeries?.length ?? 0;
      return { ...withheldSheet(r), released: isReleased, ...(isReleased ? { reason: undefined } : {}), ...(withheldSeries && isReleased ? { partial: `${plural(withheldSeries, "series", "series")} withheld` } : {}) };
    }
  }
  /** A service's view of the study a referral cites, as its search would find it. */
  async function serviceView(client: string, referralId: string) {
    const referral = referrals().find(r => r.id === referralId);
    if (!referral) return undefined;
    const cited = citedBy(referral.bundle), base = `${sandbox.urls.clinicalFhir}/Patient/`, name = serviceName(client);
    const patient = cited.patientRef?.startsWith(base) ? cited.patientRef.slice(base.length) : undefined;
    if (!patient) return { status: "failed", headline: `${name} can't act on this referral`, empty: { text: "Its patient isn't on the clinical records server the service may use.", actions: [] }, rows: [], actions: [], known: [] as string[] };
    const study = studiesOf(patient).find(c => c.accession === cited.accession);
    const x: any = await sandbox.explain({ client, patient });
    const row = x.studies.find((r: any) => r.id === study?.id);
    const fix = study && applyFor(client, patient, study.id);
    // The Imaging Server refuses a service's search outright when no rule pre-authorizes it for the patient.
    const covered = model.preAuthorized(sandbox.store.patientSnapshot(ref("patient", patient)), client, patient).length > 0;
    const known = study ? [study.id] : [];
    if (!covered) return { patient, cited: study?.id, status: "forbidden", headline: `${name} can't search ${possessive(patientFirst(patient))} studies`, rows: [], actions: [], known, empty: { text: `No imaging network rule lets the ${name.toLowerCase()} see ${possessive(patientFirst(patient))} studies, so its search is refused.`, actions: fix ? [fix] : referralToTry(client, referralId) } };
    const found = row && row.release !== "none";
    return {
      patient, cited: study?.id, status: "results", actions: [], known,
      headline: found ? `${name} can see the study this referral cites` : `${name} can't see the study this referral cites`,
      rows: row ? [{ ...withheldSheet(row, cited.report), released: !!found, ...(found ? { reason: undefined, ...(row.withheldSeries?.length ? { partial: `${plural(row.withheldSeries.length, "series", "series")} withheld` } : {}) } : {}) }] : [],
      ...(found ? {} : { empty: { text: row ? `The search for the study the referral cites finds nothing: ${row.why}.` : "No study matches the one the referral cites.", actions: fix ? [fix] : referralToTry(client, referralId) } }),
    };
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

  /** The diagram's title, from what it shows: who sees what, or who can't. */
  function whyTitle(v: { status: string; rows: any[] }, who: { user?: string; client?: string }, patient?: string) {
    const shown = v.rows.filter(r => r.released).length, app = APP_NAMES[APP];
    if (who.client) return `Why the ${serviceName(who.client).toLowerCase()} finds ${shown ? "this study" : "nothing"}`;
    const whose = patient ? possessive(patientFirst(patient)) : "anyone's";
    if (v.status !== "results") return `Why ${first(who.user!)} can't see ${whose} studies`;
    return shown ? `Why the ${app} sees ${shown === 1 ? "this study" : "these studies"}` : `Why the ${app} sees none of ${whose} studies`;
  }

  /** What each explained view's viewer may know of, by its trace session, for its activity. */
  const views = new Map<string, string[]>();
  const remember = (session: string, known: string[]) => { views.delete(session); views.set(session, known); for (const k of views.keys()) { if (views.size <= MAX_VIEWS) break; views.delete(k); } };
  const idOfUid = (uid: string) => sandbox.catalog.studyByUid(uid)?.id;
  /** What happened in a session, as its viewer may see it, and for a study, only what's about it: what the activity log shows for the session and study. */
  async function happened(session: string, study: string) {
    await traceSettled();
    const all = stack.collector.store.events({ session });
    const uid = sandbox.catalog.allStudies().find(x => x.id === study)?.uid;
    const about = (e: any) => !e.links.some((l: string) => l.startsWith("uid:") || (l.startsWith("study:") && e.kind !== "search.returned")) || e.links.includes(`study:${study}`) || (uid && e.links.includes(`uid:${uid}`));
    return forViewer(all, viewerKnows(all, views.get(session) ?? []), idOfUid).filter(about);
  }

  return {
    /** What the viewer of this Explore session knows of beyond its events, if it's one this sandbox explained. */
    knownIn(name: string) { return views.get(name); },
    /** The management API's Explore reads, under /api/sandbox/explore. */
    async fetch(req: Request, url: URL): Promise<Response> {
      const p = url.pathname.slice("/api/sandbox/explore".length), q = (k: string) => url.searchParams.get(k) ?? undefined;
      if (req.method !== "GET") return new Response(null, { status: 404 });
      if (p === "/cast") return json(options());
      if (p === "/referrals") return json({ referrals: referralList() });
      if (p === "/rule-sets") {
        // A client id or a Ref, as the rest of the API speaks: anything else is an error, never a quiet empty list.
        const asked = q("service") ?? "", service = asked.replace(/^service:/, "");
        if (!DEMO_BACKEND_CLIENTS.includes(service)) return json({ error: `no service "${asked}"`, hint: `Give a service's client id or Ref, one of: ${DEMO_BACKEND_CLIENTS.join(", ")}` }, 404);
        return json({ ruleSets: RULE_SETS.flatMap(set => { const rules = set.rules(sandbox.catalog)?.filter(r => r.service === `service:${service}`); return rules?.length ? [{ id: set.id, label: set.label, description: set.description, rules }] : []; }) });
      }
      if (p === "/view") {
        const session = q("session"), user = q("user"), client = q("client");
        if (!session) return json({ error: "name the trace session the view is for" }, 400);
        let v: any, who: { user?: string; client?: string };
        if (user) {
          if (!Object.hasOwn(USERS, user)) return json({ error: "that isn't one of the demo accounts" }, 400);
          const patient = q("patient");
          if (patient !== undefined && !sandbox.catalog.linkedPatients().includes(patient)) return json({ error: "that patient isn't in the catalog's links" }, 400);
          v = await personView(user, patient); who = { user };
        } else if (client) {
          if (!Object.hasOwn(clients, client)) return json({ error: "that isn't one of the sandbox's services" }, 400);
          v = await serviceView(client, q("referral") ?? referrals()[0]?.id ?? "");
          if (!v) return json({ error: "that isn't one of the referrals" }, 400);
          who = { client };
        } else return json({ error: "name a user or a service" }, 400);
        remember(session, v.known);
        // The chain holds only what this viewer may know of: with nothing known, there's no chain to show.
        const viewer = user ? { user, patient: v.patient, app: APP } : { service: client!, patient: v.patient, cited: v.cited };
        let chain;
        if (v.patient) { try { chain = chainFor({ snap: sandbox.store.patientSnapshot(ref("patient", v.patient)), studies: sandbox.catalog.allStudies(), now: sandbox.clock.now(), viewer, known: new Set(v.known), title: st => reportTitle(st) }); } catch { chain = undefined; } }
        const { known: _known, ...shown } = v;
        return json({ ...shown, app: APP, whyTitle: whyTitle(v, who, v.patient), chain, activityUrl: `${sandbox.prefix}/activity?session=${encodeURIComponent(session)}` });
      }
      if (p === "/happened") {
        const session = q("session") ?? "", study = q("study") ?? "";
        if (!views.has(session)) return json({ error: "that session has no view explained here" }, 404);
        return json({ line: chainLine(await happened(session, study)), activityUrl: `${sandbox.prefix}/activity?session=${encodeURIComponent(session)}&study=${encodeURIComponent(study)}` });
      }
      return new Response(null, { status: 404 });
    },
  };
}
