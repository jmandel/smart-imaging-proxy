// The policy API: version 2, under /policy/v2 on the Imaging Server. It reads and writes policy in its
// three levels: facts (relationships; labels are the catalog's, set with each study), organization
// policy, and people's choices (shares and app approvals). JSON in and out. Every call carries the
// policy credential as its bearer token, which the proxy never holds, and the API belongs on an
// internal address only. Every write answers with the revisions it made: the patient's, for a write
// about one patient, and the policy revision. A choice organization policy doesn't allow gets a 403
// naming the policy.
import { sameSecret } from "./jws";
import { PolicyValidationError, type PolicyStore, type Settings, type StillReaches } from "./policy-store";
import { bandText, idOf, POLICY_TYPES, ref, type Revision, type Share, type AppApproval, type GuardianAccessPolicy, type Namer, type OrgPolicy, type PolicyDocument, type SharingPolicy } from "./policy-model";
import type { Observer } from "./observer";

export const POLICY_API_PATH = "/policy/v2";

/** One record a user holds, and how. */
export interface HeldRecord { patient: string; via: "self" | "guardian" | "share"; relationship?: string; sites: string[]; }
/** What one signed-in user can see, and the choices they've made. */
export interface Access { records: HeldRecord[]; shares: Share[]; approvals: AppApproval[]; }
export interface ExplainQuery { client: string; user?: string; fhirUser?: string; patient: string; }
/** A share as a person asks for it. Sites narrow to what the sharer may name. */
export interface ShareRequest { from: string; with: string; patient: string; sites: string[]; label: string; }
/** An app approval as a person gives it. `fhirUser` says who they are. With no `sites`, an earlier choice of sites stays. */
export interface ApprovalRequest { by: string; app: string; patient: string; sites?: string[]; fhirUser?: string; }
/** Why a choice was refused: the organization policy, by id, or its type when no policy of it applies. */
export interface Refusal { error: string; policy: string; }

/** What the API needs from the Imaging Server's evaluation. Users and patients here are bare ids. */
export interface PolicyModelView {
  access(store: PolicyStore, user: string, fhirUser: string): Access;
  explain(store: PolicyStore, q: Partial<ExplainQuery>): unknown | { error: string };
  shareableSites(store: PolicyStore, user: string, patient: string): string[];
  visibleSites(store: PolicyStore, user: string, patient: string, fhirUser?: string): string[];
  sitesFor(patient: string): string[];
  sharingFor(store: PolicyStore, from: string, patient: string): { role?: "patient" | "guardian"; policy?: SharingPolicy };
  guardianPolicies(store: PolicyStore, patient: string): { age?: number; policies: GuardianAccessPolicy[] };
  isGuardian(store: PolicyStore, user: string, patient: string): boolean;
  /** Whether a user still has a route to a patient, which keeps their app approvals through a revocation. */
  stillReaches: StillReaches;
}

const json = (b: unknown, status = 200) => Response.json(b, { status });
const bad = (error: string, errors?: string[]) => json({ error, ...(errors ? { errors } : {}) }, 400);
const none = (status: number) => new Response(null, { status });
const isObject = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);
const bearerOf = (req: Request) => req.headers.get("authorization")?.match(/^bearer +(.+)$/i)?.[1];
const refused = (r: Refusal) => json(r, 403);
const isSites = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === "string");

export function createPolicyApi(deps: { policySecret: string; store: () => PolicyStore; check: Observer["check"]; model: PolicyModelView; name: Namer }) {
  const { check, model, name } = deps;
  const body = async (req: Request): Promise<unknown> => { const t = await req.text(); if (!t.trim()) return undefined; try { return JSON.parse(t); } catch { throw new SyntaxError("the request body must be JSON"); } };

  /** Why `from` may not share `patient`'s records, if they may not. */
  function shareRefusal(store: PolicyStore, from: string, patient: string): Refusal | undefined {
    const { role, policy } = model.sharingFor(store, ref("user", from), ref("patient", patient));
    const sharing = store.policies().filter(p => p.type === "sharing");
    if (!role) return { error: `${name(ref("user", from))} is neither ${name(ref("patient", patient))} nor a guardian, so has nothing to share`, policy: sharing[0]?.id ?? "sharing" };
    if (!policy) return { error: `no sharing policy lets ${role}s share`, policy: sharing[0]?.id ?? "sharing" };
    if (role === "guardian") return guardianRefusal(store, patient);
    return undefined;
  }
  /** Why a guardian has no access to this patient's records, if they have none. */
  function guardianRefusal(store: PolicyStore, patient: string): Refusal | undefined {
    const { age, policies } = model.guardianPolicies(store, ref("patient", patient));
    if (policies.length) return undefined;
    const g = store.policies().filter((p): p is GuardianAccessPolicy => p.type === "guardian-access");
    return { error: age === undefined ? `${name(ref("patient", patient))}'s birth date isn't on file as a valid past date, so no guardian-access policy applies` : `no guardian-access policy covers patients aged ${age}${g.length ? `: they cover ${g.map(p => `${p.id}, ${bandText(p.when.age)}`).join("; ")}` : ""}`, policy: g[0]?.id ?? "guardian-access" };
  }

  return async function policyApi(req: Request, url: URL): Promise<Response> {
    if (!sameSecret(bearerOf(req), deps.policySecret)) return none(401);
    const store = deps.store();
    const p = url.pathname.slice(POLICY_API_PATH.length), m = req.method;
    const q = (k: string) => url.searchParams.get(k) || undefined;
    const done = (revision: Revision | undefined, what = "nothing matched") => revision === undefined ? json({ error: what }, 404) : json({ revision });
    try {
      if (p === "/document" && m === "GET") return json(store.snapshot());
      if (p === "/document" && m === "PUT") { const b = await body(req); return json({ revision: store.setDocument((b === undefined ? {} : b) as Partial<PolicyDocument>, model.stillReaches) }); }

      // Level 1
      if (p === "/relationships" && m === "GET") return json({ revision: store.revision(), relationships: store.relationships() });
      if (p === "/relationships" && m === "PUT") return json({ revision: store.putRelationship(await body(req) as any) });
      if (p === "/relationships" && m === "DELETE") {
        const subject = q("subject"), relation = q("relation"), object = q("object");
        if (!subject || !relation || !object) return bad("subject, relation and object are required");
        return done(store.removeRelationship({ subject, relation, object }, model.stillReaches), "no such relationship");
      }

      // Level 2
      if (p === "/policies" && m === "GET") { const type = q("type"); return json({ revision: store.revision(), policies: store.policies().filter(x => !type || x.type === type) }); }
      if (p === "/policies" && m === "PUT") {
        const type = q("type");
        if (!type || !(POLICY_TYPES as readonly string[]).includes(type)) return bad(`type must be one of ${POLICY_TYPES.join(", ")}, to replace that type's policies`);
        const b = await body(req);
        if (!Array.isArray(b)) return bad("the body must be a list of policies");
        return json({ revision: store.replacePolicies(type as OrgPolicy["type"], b as OrgPolicy[]) });
      }
      const one = p.match(/^\/policies\/([^/]+)$/);
      if (one && m === "PUT") {
        const id = decodeURIComponent(one[1]!), b = await body(req);
        if (!isObject(b) || b.id !== id) return bad("the body must be a policy whose id is the one in the path");
        const held = store.policies().find(x => x.id === id);
        if (held && held.type !== b.type) return bad(`policy ${id} is a ${held.type} policy`);
        return json({ revision: store.putPolicy(b as OrgPolicy) });
      }
      if (one && m === "DELETE") return done(store.removePolicy(decodeURIComponent(one[1]!)), "no such policy");

      // Level 3
      if (p === "/shares" && m === "GET") return json({ revision: store.revision(), shares: store.shares() });
      if (p === "/shares" && m === "POST") {
        const s = await body(req) as ShareRequest;
        if (!isObject(s) || !["from", "with", "patient", "label"].every(k => typeof s[k as keyof ShareRequest] === "string" && s[k as keyof ShareRequest]) || !isSites(s.sites)) return bad("from, with, patient, sites and label are required, and sites is a list of strings");
        const from = idOf(s.from, "user"), patient = idOf(s.patient, "patient");
        if (!from || !patient) return bad("from is user:id, and patient is patient:id");
        const why = shareRefusal(store, from, patient);
        if (!check("policy", "organization policy lets this person share", !why, { from: s.from, patient: s.patient, policy: why?.policy, why: why?.error })) return refused(why!);
        // A share can only narrow what the sharer may name, whatever the form submitted.
        const known = new Set(model.shareableSites(store, from, patient));
        const sites = s.sites.filter(x => known.has(x));
        const revision = store.putShare({ from: s.from, with: s.with, patient: s.patient, sites, label: s.label });
        check("policy", "record a share", true, { from: s.from, with: s.with, label: s.label, sites: sites.join(", ") });
        return json({ revision, share: { ...s, sites } });
      }
      if (p === "/shares" && m === "DELETE") {
        const by = q("from"), to = q("with"), patient = q("patient");
        if (!to || !(by || patient)) return bad("with is required, with from, patient or both");
        const revision = store.removeShares({ with: to, from: by, patient }, model.stillReaches);
        check("policy", "revoke a share", true, { from: by, with: to, patient });
        return done(revision, "no such share");
      }
      if (p === "/app-approvals" && m === "GET") return json({ revision: store.revision(), approvals: store.approvals() });
      if (p === "/app-approvals" && m === "POST") {
        const a = await body(req) as ApprovalRequest;
        if (!isObject(a) || !["by", "app", "patient"].every(k => typeof a[k as keyof ApprovalRequest] === "string") || (a.sites !== undefined && !isSites(a.sites))) return bad("by, app and patient are required, and sites is a list of strings");
        const user = idOf(a.by, "user"), patient = idOf(a.patient, "patient");
        if (!user || !patient || !idOf(a.app, "app")) return bad("by is user:id, app is app:id, and patient is patient:id");
        const held = model.access(store, user, a.fhirUser ?? "").records.find(r => r.patient === patient);
        // A guardian holds nothing a guardian-access policy doesn't give them.
        const asGuardian = held?.via === "guardian" ? guardianRefusal(store, patient) : undefined;
        const why: Refusal | undefined = asGuardian ?? (held ? undefined
          : model.isGuardian(store, user, patient) ? guardianRefusal(store, patient) ?? { error: `${name(a.by)} holds no record of ${name(a.patient)}`, policy: "guardian-access" }
          : { error: `${name(a.by)} holds no record of ${name(a.patient)}: no one shared it, and they aren't the patient or a guardian`, policy: "sharing" });
        if (!check("policy", "user holds this patient's record", !why, { user: a.by, patient: a.patient, policy: why?.policy })) return refused(why!);
        const existing = store.approvals().find(x => x.app === a.app && x.by === a.by && x.patient === a.patient);
        let sites = existing?.sites;
        if (a.sites) {
          // An approval can only narrow what the user holds, whatever the form submitted.
          const narrowed = a.sites.filter(x => held!.sites.includes(x));
          // Everything the patient has is the same as no limit, which then covers later sites too.
          sites = narrowed.length > 0 && narrowed.length === model.sitesFor(patient).length ? undefined : narrowed;
          check("policy", "app's sites stay within what the user holds", narrowed.length === a.sites.length, { requested: a.sites.join(", "), held: held!.sites.join(", "), approved: narrowed.join(", ") });
        }
        const approval: AppApproval = { by: a.by, app: a.app, patient: a.patient, ...(sites ? { sites } : {}) };
        return json({ revision: store.putApproval(approval), approval });
      }
      if (p === "/app-approvals" && m === "DELETE") {
        const by = q("by"), app = q("app"), patient = q("patient");
        if (!by || !app) return bad("by and app are required, and patient narrows it to one patient");
        const revision = store.removeApprovals({ by, app, patient });
        check("policy", "revoke an app approval", true, { by, app, patient });
        return done(revision, "no such app approval");
      }

      // Reading decisions
      if (p === "/access" && m === "GET") return json(model.access(store, q("user") ?? "", q("fhirUser") ?? ""));
      if (p === "/explain" && m === "GET") {
        const r = model.explain(store, { client: q("client"), user: q("user"), fhirUser: q("fhirUser"), patient: q("patient") });
        return isObject(r) && typeof r.error === "string" ? json(r, 400) : json(r);
      }

      if (p === "/settings" && m === "GET") return json({ revision: store.revision(), ...store.getSettings() });
      if (p === "/settings" && m === "PATCH") { const b = await body(req); return json({ revision: store.setSettings((b === undefined ? {} : b) as Partial<Settings>) }); }
      if (p === "/reset" && m === "POST") {
        const b = await body(req) ?? {};
        if (!isObject(b) || Object.keys(b).some(k => k !== "tokens") || (b.tokens !== undefined && typeof b.tokens !== "boolean")) return bad("the body takes only tokens, true or false");
        return json({ revision: b.tokens ? store.resetAll() : store.resetPolicy() });
      }
      if (p === "/store" && m === "GET") return json(store.info());
      return new Response("not found", { status: 404 });
    } catch (e) {
      if (e instanceof PolicyValidationError) return bad(e.message, e.errors);
      if (e instanceof SyntaxError) return bad(e.message);
      throw e;
    }
  };
}
