// The layer chain: why a person's app, or a service, sees what it sees of one patient's studies. Each
// row is one sentence at one level: a fact on file, a rule the imaging network set, or a choice a person
// made. A row's boxes are what that row itself holds or grants, and the last row, the outcome, is what
// they come to, computed with core's own model, the same evaluation search runs. A study stays in its
// column on every row, so a reader sees which studies survive to the outcome.
//
// With `known`, the chain is a viewer's: it holds only the studies they may know of, names no site of
// any other, has no fact row counting the patient's studies, and names no label. Without it, the chain
// is the narrator's, and shows a labeled study with its own fact row.
import { ageOn, bandText, createModel, ref, type CatalogStudy, type GuardianAccessPolicy, type ServiceAccessPolicy, type Snapshot } from "@smart-imaging-proxy/core";
import { APP_NAMES, PATIENT_NAMES, USERS } from "./auth-server";
import { patientAttributes } from "./stores";
import { nameOf } from "./world";

export type Level = "fact" | "policy" | "choice" | "outcome";
/** What a row checks, so a test can compare it with the reference model. */
export type RowKind = "records" | "relationship" | "age" | "label" | "referral" | "guardian" | "sharing" | "share" | "approval" | "service" | "outcome";
/**
 * One row. `has` is what this row itself holds or grants. `boxes: false` is a fact about people, which
 * holds no study. `missing` is a rule or choice that isn't on file, drawn hollow. `by` and `route` name,
 * for a guardian's or a share's row, whose route it is.
 */
export interface ChainRow { level: Level; kind: RowKind; name: string; has: string[]; boxes?: false; missing?: true; by?: string; route?: string; }
/** `cited` marks the study a referral cites, so its box can be told apart from others of its kind. */
export interface ChainColumn { id: string; site?: string; title: string; modality: string; locked?: true; cited?: true; }
/** `viewer` says the chain is a viewer's own, which counts only what they may know of. */
export interface Chain { columns: ChainColumn[]; rows: ChainRow[]; viewer: boolean; }
export type Viewer = { user: string; patient: string; app: string } | { service: string; patient: string; cited?: string };

/** How a label reads in a sentence. */
const LABEL_WORDS: Record<string, string> = { "confidential-adolescent": "confidential" };
/** What a modality's studies are called, as a service-access rule names them. */
const MODALITY_WORDS: Record<string, string> = { CR: "X-rays", DX: "X-rays", CT: "CT scans", MR: "MRI scans", SM: "pathology slides", US: "ultrasounds", MG: "mammograms" };
/** Series that hold no picture, and so don't name a study's modality. */
const NOT_IMAGES = new Set(["SR", "PR", "KO", "DOC", "SEG", "RTSTRUCT", "RTPLAN", "OT"]);

const first = (full: string | undefined, id: string) => full?.split(" ")[0] ?? id;
const userFirst = (u: string) => first(USERS[u]?.name, u);
const patientFirst = (p: string) => first(PATIENT_NAMES[p], p);
const list = (items: string[]) => items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
/** A site as a sentence names it: its first word. */
export const siteWord = (site: string) => site.split(" ")[0]!;
/** A study's title, quoted, as a sentence names it. */
const quoted = (s: string) => `“${s}”`;
/** The study's modality, from its first image series. */
export const modalityOf = (s: Pick<CatalogStudy, "series">) => s.series.map(x => x.modality).find(m => !NOT_IMAGES.has(m)) ?? s.series[0]?.modality ?? "OT";
/** The patient's studies, as a person names them: Josh is "he", and everyone else by name. */
const whose = (patient: string, speaker?: string) => speaker && USERS[speaker]?.patient === patient && speaker === "josh" ? "his" : `${patientFirst(patient)}'s`;

/**
 * The chain behind one viewer's access to one patient's studies, from a snapshot of policy at `now`.
 * `known`, for a viewer's own view, keeps only the studies they may know of.
 */
export function chainFor(input: { snap: Snapshot; studies: CatalogStudy[]; now: number; viewer: Viewer; known?: ReadonlySet<string>; title?: (s: CatalogStudy) => string }): Chain {
  const { snap, viewer, known } = input;
  const narrator = !known;
  const model = createModel({ patientOf: u => USERS[u]?.patient, attributesOf: patientAttributes, now: () => input.now, name: nameOf });
  const P = ref("patient", viewer.patient);
  const all = input.studies.filter(s => s.patient === viewer.patient && (!known || known.has(s.id)))
    .sort((a, b) => (a.site ?? "").localeCompare(b.site ?? "") || (a.date ?? "").localeCompare(b.date ?? ""));
  const titleOf = (s: CatalogStudy) => input.title?.(s) ?? s.title ?? s.id;
  const knownSites = new Set(all.flatMap(s => s.site ? [s.site] : []));
  const ids = (ok: (s: CatalogStudy) => boolean) => all.filter(ok).map(s => s.id);
  const atSites = (sites: string[] | undefined) => ids(s => !sites || sites.includes(s.site ?? ""));
  /** Sites as a sentence names them, only those the viewer may know of. */
  const sitesText = (sites: string[]) => list([...sites].sort().filter(x => !known || knownSites.has(x)).map(siteWord)) || "no site";
  const name = patientFirst(viewer.patient);
  const rows: ChainRow[] = [];
  const columns = (): ChainColumn[] => all.map(s => ({ id: s.id, site: s.site, title: titleOf(s), modality: modalityOf(s), ...(narrator && (s.labels ?? []).length ? { locked: true as const } : {}), ...("cited" in viewer && viewer.cited === s.id ? { cited: true as const } : {}) }));
  const done = (): Chain => ({ columns: columns(), rows, viewer: !narrator });
  // The narrator's chain starts from every study the patient has. A viewer's never counts them.
  if (narrator) rows.push({ level: "fact", kind: "records", name: `${name}'s studies: ${all.length}`, has: ids(() => true) });

  if ("service" in viewer) {
    const service = nameOf(ref("service", viewer.service));
    const cited = viewer.cited ? all.find(s => s.id === viewer.cited) : undefined;
    if (cited) rows.push({ level: "fact", kind: "referral", name: `The referral cites ${name}'s study ${quoted(titleOf(cited))}`, has: [cited.id] });
    const ps = model.preAuthorized(snap, viewer.service, viewer.patient) as ServiceAccessPolicy[];
    const t = { client_id: viewer.service };
    rows.push(ps.length
      ? { level: "policy", kind: "service", name: `Imaging network rule: ${service} can see ${ps.map(p => serviceWhat(p, name, all, titleOf)).join(", and ")}`, has: ids(s => model.evaluate(snap, t, s).release !== "none") }
      : { level: "policy", kind: "service", name: `No rule lets ${service} see ${name}'s studies`, has: [], missing: true });
    rows.push({ level: "outcome", kind: "outcome", name: cited ? "What the service found when it searched for that study" : "What the service found", has: ids(s => (!viewer.cited || s.id === viewer.cited) && model.evaluate(snap, t, s).release !== "none") });
    return done();
  }

  const U = ref("user", viewer.user);
  const fhirUser = USERS[viewer.user]?.fhirUser;
  const viewerName = userFirst(viewer.user);
  const isPatient = USERS[viewer.user]?.patient === viewer.patient;
  /** A guardian's route: the relationship on file, the patient's age, labels, and the rule for that age. */
  const guardianRows = (who: string) => {
    const rel = model.guardianOf(snap, ref("user", who), P);
    rows.push({ level: "fact", kind: "relationship", name: `${userFirst(who)} is on file as ${name}'s guardian`, has: [], boxes: false });
    const age = ageOn(patientAttributes(viewer.patient)?.birthDate, input.now);
    if (age !== undefined) rows.push({ level: "fact", kind: "age", name: `${name} is ${age}`, has: [], boxes: false });
    if (narrator) for (const s of all) for (const label of s.labels ?? []) rows.push({ level: "fact", kind: "label", name: `${name}'s study ${quoted(titleOf(s))} is labeled ${LABEL_WORDS[label] ?? label.replaceAll("-", " ")}`, has: [s.id] });
    const { policies } = model.guardianPolicies(snap, P);
    if (!policies.length) {
      rows.push({ level: "policy", kind: "guardian", name: age !== undefined && age >= 18 ? `No rule lets guardians see a patient's studies once the patient is 18` : age === undefined ? `No rule lets guardians see ${name}'s studies` : `No rule lets guardians see the studies of a patient aged ${age}`, has: [], missing: true, by: who, route: rel?.id });
      return;
    }
    const ok = (s: CatalogStudy) => model.baseline(snap, ref("user", who), P, s).ok;
    rows.push({ level: "policy", kind: "guardian", name: `Imaging network rule: ${guardianWhat(policies[0] as GuardianAccessPolicy)}`, has: ids(ok), by: who, route: rel?.id });
  };

  const share = snap.shares.find(s => s.with === U && s.patient === P);
  const guardian = model.guardianOf(snap, U, P);
  if (isPatient) { if (!narrator) rows.push({ level: "fact", kind: "relationship", name: `${viewerName} is the patient`, has: [], boxes: false }); }
  else if (guardian) guardianRows(viewer.user);
  else {
    // Someone else's studies reach this viewer only by a share, under the imaging network's sharing rule.
    const from = share?.from.replace(/^user:/, "") ?? Object.keys(USERS).find(u => USERS[u]!.patient === viewer.patient);
    const sharerIsPatient = !!from && USERS[from]?.patient === viewer.patient;
    if (share && !sharerIsPatient) guardianRows(from!);
    const sharing = model.sharingFor(snap, share?.from ?? ref("user", from ?? ""), P);
    const sharingPolicy = snap.policies.find(p => p.type === "sharing");
    const sharerSees = (s: CatalogStudy) => !!from && model.baseline(snap, ref("user", from), P, s).ok;
    rows.push(sharingPolicy
      ? { level: "policy", kind: "sharing", name: `Imaging network rule: ${sharingWho(sharingPolicy.allowedFrom)} can share the studies they can see`, has: sharing.policy ? ids(sharerSees) : [] }
      : { level: "policy", kind: "sharing", name: "No rule lets patients or guardians share their studies", has: [], missing: true });
    if (share) {
      const sharer = userFirst(from!), theirs = sharerIsPatient ? whose(viewer.patient, from) : `${name}'s`;
      // The narrator, who knows every site, says "all" for a share of every one of them.
      const every = narrator && [...knownSites].every(x => share.sites.includes(x));
      const what = every ? `all ${theirs} studies` : `${theirs} studies at ${sitesText(share.sites)}`;
      rows.push({ level: "choice", kind: "share", name: `${sharer} shares ${what} with ${viewerName}`, has: ids(s => model.userRoute(snap, U, P, s, fhirUser, [share.id ?? ""]).ok), by: viewer.user, route: share.id });
    } else rows.push({ level: "choice", kind: "share", name: sharerIsPatient ? `${userFirst(from!)} doesn't share ${whose(viewer.patient, from)} studies with ${viewerName}` : `No one shares ${name}'s studies with ${viewerName}`, has: [], missing: true });
  }
  // A person may let an app see only what they can see themselves: the approval says what that is.
  const sharer = share && userFirst(share.from.replace(/^user:/, ""));
  const within = isPatient ? "" : guardian ? `, out of what ${viewerName} can see as ${name}'s guardian` : share ? `, out of what ${sharer} shares with ${viewerName}` : "";
  const approval = snap.approvals.find(a => a.by === U && a.app === ref("app", viewer.app) && a.patient === P);
  const app = APP_NAMES[viewer.app] ?? viewer.app;
  const theirs = whose(viewer.patient, viewer.user);
  rows.push(approval
    ? { level: "choice", kind: "approval", name: `${viewerName} lets the ${app} see ${theirs} studies at ${approval.sites ? sitesText(approval.sites) : "every site"}${within}`, has: atSites(approval.sites) }
    : { level: "choice", kind: "approval", name: `No approval from ${viewerName} lets the ${app} see ${theirs} studies`, has: [], missing: true });
  const t = { client_id: viewer.app, sub: viewer.user, fhirUser, patient: viewer.patient };
  rows.push({ level: "outcome", kind: "outcome", name: "What the app can see", has: ids(s => model.evaluate(snap, t, s).release !== "none") });
  return done();
}

/** Who a sharing rule lets share. */
const sharingWho = (from: ("patient" | "guardian")[]) => from.length === 2 ? "patients and guardians" : from[0] === "guardian" ? "guardians" : "patients";
/**
 * A guardian-access rule as a sentence: the ages it covers, and what it lets guardians see. It's the
 * rule's general text, the same whether or not any study carries the label, so it names no study.
 */
function guardianWhat(p: GuardianAccessPolicy) {
  const band = bandText(p.when.age);
  const ages = band.startsWith("under") ? band : band.startsWith("aged") ? band : `aged ${band}`;
  const except = (p.except ?? []).map(l => `studies labeled ${LABEL_WORDS[l] ?? l.replaceAll("-", " ")}`);
  return `guardians of patients ${ages} can see ${except.length ? `everything except ${list(except)}` : "all the patient's studies"}`;
}
/** What a service-access rule lets a service see, as a sentence names it. */
function serviceWhat(p: ServiceAccessPolicy, name: string, all: CatalogStudy[], titleOf: (s: CatalogStudy) => string) {
  const a = p.allow;
  const parts: string[] = [];
  if (a.studies) { const named = all.filter(s => a.studies!.includes(s.id)).map(s => quoted(titleOf(s))); parts.push(named.length ? `${name}'s ${named.length === 1 ? "study" : "studies"} ${list(named)}` : `chosen studies of ${name}'s`); }
  else if (a.modalities) parts.push(`${name}'s ${list([...new Set(a.modalities.map(m => MODALITY_WORDS[m] ?? `${m} studies`))])}`);
  else parts.push(`all of ${name}'s studies`);
  if (a.sites) parts.push(`at ${list(a.sites.map(siteWord))}`);
  if (a.since) parts.push(`from ${a.since.slice(0, 4)} on`);
  if (p.withholdSeries?.length) parts.push("with some series held back");
  return parts.join(" ");
}
