// The layer chain: how a person's or service's access narrows from a patient's records, link by link,
// through the three levels of policy. Each row is one link, at one level, with the studies it lets
// through, and no row lets through more than the one before it. Rows are computed with core's own
// model, the same evaluation search runs. With `known`, the chain is a viewer's: it holds only the
// studies they may know of, and names no site of any other.
import { bandText, createModel, ref, type CatalogStudy, type Snapshot } from "@smart-imaging-proxy/core";
import { APP_NAMES, PATIENT_NAMES, USERS } from "./auth-server";
import { patientAttributes } from "./stores";
import { nameOf } from "./world";

export type Level = "fact" | "policy" | "choice";
/** What a row checks, so a test can compare it with the reference model. */
export type RowKind = "records" | "guardian" | "sharing" | "share" | "approval" | "service";
/** `by` and `route` name, for a guardian's or a share's row, whose route it is, by its row's id. */
export interface ChainRow { level: Level; kind: RowKind; name: string; detail?: string; has: string[]; cut?: string[]; by?: string; route?: string; }
export interface Chain { columns: { id: string; site?: string; title: string }[]; rows: ChainRow[]; }
export type Viewer = { user: string; patient: string; app: string } | { service: string; patient: string };

const first = (full: string | undefined, id: string) => full?.split(" ")[0] ?? id;
const userFirst = (u: string) => first(USERS[u]?.name, u);
const patientFirst = (p: string) => first(PATIENT_NAMES[p], p);
const sitesText = (sites: string[]) => sites.length ? sites.join(", ") : "no sites";

/**
 * The chain behind one viewer's access to one patient's records, from a snapshot of policy at `now`.
 * `known`, for a viewer's own view, keeps only the studies they may know of; with none, the chain is
 * the narrator's, and shows a study a label cuts out of a guardian's view.
 */
export function chainFor(input: { snap: Snapshot; studies: CatalogStudy[]; now: number; viewer: Viewer; known?: ReadonlySet<string>; title?: (s: CatalogStudy) => string }): Chain {
  const { snap, viewer, known } = input;
  const model = createModel({ patientOf: u => USERS[u]?.patient, attributesOf: patientAttributes, now: () => input.now, name: nameOf });
  const P = ref("patient", viewer.patient);
  const all = input.studies.filter(s => s.patient === viewer.patient && (!known || known.has(s.id)))
    .sort((a, b) => (a.site ?? "").localeCompare(b.site ?? "") || (a.date ?? "").localeCompare(b.date ?? ""));
  const knownSites = new Set(all.flatMap(s => s.site ? [s.site] : []));
  const sites = (xs: string[] | undefined) => xs ? sitesText(xs.filter(x => !known || knownSites.has(x))) : "every site";
  const ids = (ok: (s: CatalogStudy) => boolean) => all.filter(ok).map(s => s.id);
  const rows: ChainRow[] = [];
  const whose = `${patientFirst(viewer.patient)}'s records`;

  if ("service" in viewer) {
    rows.push({ level: "fact", kind: "records", name: whose, has: ids(() => true) });
    const ps = model.preAuthorized(snap, viewer.service, viewer.patient);
    const t = { client_id: viewer.service };
    rows.push(ps.length
      ? { level: "policy", kind: "service", name: "Service access", detail: ps.map(p => p.description ?? p.id).join("; "), has: ids(s => model.evaluate(snap, t, s).release !== "none") }
      : { level: "policy", kind: "service", name: "No service access", has: [] });
    return { columns: all.map(s => ({ id: s.id, site: s.site, title: input.title?.(s) ?? s.title ?? s.id })), rows };
  }

  const U = ref("user", viewer.user);
  const fhirUser = USERS[viewer.user]?.fhirUser;
  const isPatient = USERS[viewer.user]?.patient === viewer.patient;
  /** A person's own route as a guardian, as a policy row: what the band covering the patient's age lets through, and what a label cuts out. */
  const guardianRow = (who: string): ChainRow => {
    const { age, policies } = model.guardianPolicies(snap, P);
    const rel = model.guardianOf(snap, ref("user", who), P);
    if (!policies.length) return { level: "policy", kind: "guardian", name: age === undefined ? "No guardian access" : `No guardian access at ${age}`, has: [], by: who, route: rel?.id };
    const ok = (s: CatalogStudy) => model.baseline(snap, ref("user", who), P, s).ok;
    // A label's cut shows only in the narrator's chain: a viewer's holds no study they may not know of.
    const cut = known ? [] : ids(s => !ok(s) && (s.labels ?? []).length > 0);
    return { level: "policy", kind: "guardian", name: `Guardian access, ${bandText(policies[0]!.when.age)}`, detail: `${userFirst(who)} is ${patientFirst(viewer.patient)}'s guardian`, has: ids(ok), ...(cut.length ? { cut } : {}), by: who, route: rel?.id };
  };

  const share = snap.shares.find(s => s.with === U && s.patient === P);
  const guardian = model.guardianOf(snap, U, P);
  if (isPatient) rows.push({ level: "fact", kind: "records", name: `${userFirst(viewer.user)}'s own records`, detail: `${userFirst(viewer.user)} is the patient`, has: ids(() => true), route: "self" });
  else {
    rows.push({ level: "fact", kind: "records", name: whose, has: ids(() => true) });
    if (guardian) rows.push(guardianRow(viewer.user));
    else if (share) {
      const from = share.from.replace(/^user:/, "");
      const sharerIsPatient = USERS[from]?.patient === viewer.patient;
      if (!sharerIsPatient) rows.push(guardianRow(from));
      const sharing = model.sharingFor(snap, share.from, P);
      const before = rows.at(-1)!.has;
      rows.push(sharing.policy
        ? { level: "policy", kind: "sharing", name: "Sharing", detail: `${sharing.policies.map(p => p.description ?? p.id).join("; ")}`, has: before }
        : { level: "policy", kind: "sharing", name: "No sharing policy", has: [] });
      rows.push({ level: "choice", kind: "share", name: `${userFirst(from)}'s share`, detail: sites(share.sites), has: ids(s => model.userRoute(snap, U, P, s, fhirUser, [share.id ?? ""]).ok), by: viewer.user, route: share.id });
    } else rows.push({ level: "choice", kind: "share", name: "No share", has: [] });
  }
  const approval = snap.approvals.find(a => a.by === U && a.app === ref("app", viewer.app) && a.patient === P);
  const t = { client_id: viewer.app, sub: viewer.user, fhirUser, patient: viewer.patient };
  rows.push(approval
    ? { level: "choice", kind: "approval", name: "App approval", detail: `${APP_NAMES[viewer.app] ?? viewer.app}, ${sites(approval.sites)}`, has: ids(s => model.evaluate(snap, t, s).release !== "none") }
    : { level: "choice", kind: "approval", name: "No app approval", has: [] });
  return { columns: all.map(s => ({ id: s.id, site: s.site, title: input.title?.(s) ?? s.title ?? s.id })), rows };
}
