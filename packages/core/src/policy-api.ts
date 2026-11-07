// The policy API: version 1, under /policy/v1 on the Imaging Server. It's how an Authorization Server,
// an account page, or an operator's tools change who may see what: guardians, delegations, app grants,
// backend-client rules, and settings. JSON in and out. Every call carries the policy credential as
// its bearer token, which the proxy never holds, and the API belongs on an internal address only. A deployment holding more than one policy store names one with `?store=`; without
// it, a call acts on the store search and decisions use.
import { sameSecret } from "./jws";
import { PolicyValidationError, type AppGrant, type Delegation, type Guardian, type Policy, type PolicyStore, type Rule, type Settings } from "./policy-store";
import type { Observer } from "./observer";

export const POLICY_API_PATH = "/policy/v1";

/** One record a user holds, and how. */
export interface HeldRecord { patient: string; via: "self" | "guardian" | "delegation"; relationship?: string; sites: string[]; }
/** What one signed-in user can see and has shared. */
export interface Access { records: HeldRecord[]; delegations: Delegation[]; apps: AppGrant[]; }
export interface Relationship { patient: string; delegate: string; relationship: string; }
/** A share by a patient, or a guardian, with a related person. `fhirUser` is the grantor's. */
export interface DelegationRequest { patient: string; grantedBy: string; fhirUser: string; delegate: string; relationship: string; sites: string[]; }
/** A user's approval of an app for one patient. With no `sites`, an earlier choice of sites stays. */
export interface AppGrantRequest { client: string; user: string; fhirUser: string; patient: string; sites?: string[]; }
export interface ExplainQuery { client: string; user?: string; fhirUser?: string; patient: string; }

/** What the API needs from the Imaging Server's policy evaluation. */
export interface PolicyModel {
  access(store: PolicyStore, user: string, fhirUser: string): Access;
  /** Why each of a patient's studies is or isn't released, or why the query can't be answered. */
  explain(store: PolicyStore, q: Partial<ExplainQuery>): unknown | { error: string };
  /** The sites a guardian can choose among, which leave out any only a confidential study is at. */
  guardianSites(g: Guardian): string[];
  sitesFor(patient: string): string[];
}

const json = (b: unknown, status = 200) => Response.json(b, { status });
const bad = (error: string, errors?: string[]) => json({ error, ...(errors ? { errors } : {}) }, 400);
const none = (status = 204) => new Response(null, { status });
const isText = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isTextList = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === "string");
const isObject = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);
const bearerOf = (req: Request) => req.headers.get("authorization")?.match(/^bearer +(.+)$/i)?.[1];

export function createPolicyApi(deps: { policySecret: string; store: () => PolicyStore; namedStore?: (name: string) => PolicyStore | undefined; check: Observer["check"]; model: PolicyModel }) {
  const { check, model } = deps;
  const body = async (req: Request): Promise<unknown> => { const t = await req.text(); if (!t.trim()) return undefined; try { return JSON.parse(t); } catch { throw new SyntaxError("the request body must be JSON"); } };

  return async function policyApi(req: Request, url: URL): Promise<Response> {
    if (!sameSecret(bearerOf(req), deps.policySecret)) return none(401);
    const named = url.searchParams.get("store");
    const store = named === null ? deps.store() : deps.namedStore?.(named);
    if (!store) return json({ error: `no policy store named "${named}"` }, 404);
    const p = url.pathname.slice(POLICY_API_PATH.length), m = req.method;
    const q = (k: string) => url.searchParams.get(k) ?? undefined;
    try {
      if (p === "/relationships" && m === "GET") return json([...store.guardians().map(g => ({ patient: g.patient, delegate: g.guardian, relationship: g.relationship })), ...store.delegations().map(d => ({ patient: d.patient, delegate: d.delegate, relationship: d.relationship }))] satisfies Relationship[]);
      if (p === "/access" && m === "GET") return json(model.access(store, q("user") ?? "", q("fhirUser") ?? ""));
      if (p === "/explain" && m === "GET") {
        const r = model.explain(store, { client: q("client"), user: q("user"), fhirUser: q("fhirUser"), patient: q("patient") });
        return isObject(r) && typeof r.error === "string" ? json(r, 400) : json(r);
      }

      if (p === "/delegations" && m === "POST") {
        const d = await body(req);
        if (!isObject(d) || !["patient", "grantedBy", "fhirUser", "delegate", "relationship"].every(k => isText(d[k])) || !isTextList(d.sites)) return bad("patient, grantedBy, fhirUser, delegate, relationship and sites are required");
        const self = d.fhirUser === `Patient/${d.patient}`;
        const guardian = self ? undefined : store.guardians().find(g => g.guardian === d.grantedBy && g.patient === d.patient);
        if (!check("policy", "only the patient or their guardian can delegate their records", self || !!guardian, { user: d.grantedBy, patient: d.patient })) return none(403);
        const known = new Set(guardian ? model.guardianSites(guardian) : model.sitesFor(d.patient));
        const sites = d.sites.filter((s: string) => known.has(s));
        store.putDelegation({ patient: d.patient, grantedBy: d.grantedBy, delegate: d.delegate, relationship: d.relationship, sites, ...(self ? {} : { asGuardian: true }) });
        check("policy", "record delegation to a related person", true, { from: d.grantedBy, to: d.delegate, relationship: d.relationship, sites: sites.join(", ") });
        return none();
      }
      if (p === "/delegations" && m === "DELETE") {
        const by = q("grantedBy"), to = q("delegate"), patient = q("patient");
        if (!to || !(by || patient)) return bad("delegate is required, with grantedBy, patient or both");
        const removed = store.removeDelegations({ grantedBy: by, delegate: to, patient });
        check("policy", "revoke delegation", true, { from: by, to, patient });
        return removed ? none() : json({ error: "no such delegation" }, 404);
      }

      if (p === "/app-grants" && m === "POST") {
        const c = await body(req);
        if (!isObject(c) || !["client", "user", "fhirUser", "patient"].every(k => isText(c[k])) || (c.sites !== undefined && !isTextList(c.sites))) return bad("client, user, fhirUser and patient are required, and sites is a list");
        const held = model.access(store, c.user, c.fhirUser).records.find(r => r.patient === c.patient);
        if (!check("policy", "user has access to this patient", !!held, { user: c.user, patient: c.patient })) return none(403);
        const existing = store.appGrants().find(x => x.client === c.client && x.user === c.user && x.patient === c.patient);
        let sites: string[] | undefined = existing?.sites;
        if (c.sites) {
          // A choice can only narrow what the user holds, whatever the form submitted.
          const narrowed = (c.sites as string[]).filter(s => held!.sites.includes(s));
          // Everything the patient has is the same as no limit, which then covers later sites too.
          const all = model.sitesFor(c.patient).length;
          sites = narrowed.length > 0 && narrowed.length === all ? undefined : narrowed;
          check("policy", "app's sites stay within what the user holds", narrowed.length === c.sites.length, { requested: c.sites.join(", "), held: held!.sites.join(", "), granted: narrowed.join(", ") });
        }
        store.putAppGrant({ client: c.client, user: c.user, patient: c.patient, ...(sites ? { sites } : {}) });
        return none();
      }
      if (p === "/app-grants" && m === "DELETE") {
        const client = q("client"), user = q("user"), patient = q("patient");
        if (!client || !user) return bad("client and user are required, and patient narrows it to one patient");
        const removed = store.removeAppGrants({ client, user, patient });
        check("policy", "revoke app authorization", true, { client, user, patient });
        return removed ? none() : json({ error: "no such app grant" }, 404);
      }

      if (p === "/policy" && m === "GET") return json(store.getPolicy());
      if (p === "/policy" && m === "PUT") { const b = await body(req); store.setPolicy((b === undefined ? {} : b) as Partial<Policy>); return none(); }
      if (p === "/guardians" && m === "PUT") {
        const b = await body(req);
        if (!Array.isArray(b)) return bad("the body must be a list of guardians");
        store.setPolicy({ guardians: b as Guardian[] });
        return none();
      }
      if (p === "/rules" && m === "PUT") {
        const b = await body(req);
        if (!Array.isArray(b)) return bad("the body must be a list of rules");
        store.setPolicy({ rules: b as Rule[] });
        return none();
      }
      const rule = p.match(/^\/rules\/([^/]+)$/);
      if (rule && m === "PATCH") {
        const id = decodeURIComponent(rule[1]!), b = await body(req);
        if (!isObject(b)) return bad("the body must be a JSON object");
        if (!store.rules().some(r => r.id === id)) return json({ error: "no such rule" }, 404);
        store.updateRule(id, b as Partial<Rule>);
        return none();
      }
      if (p === "/settings" && m === "GET") return json(store.getSettings());
      if (p === "/settings" && m === "PATCH") { const b = await body(req); store.setSettings((b === undefined ? {} : b) as Partial<Settings>); return none(); }
      if (p === "/reset" && m === "POST") {
        const b = await body(req) ?? {};
        if (!isObject(b) || Object.keys(b).some(k => k !== "tokens") || (b.tokens !== undefined && typeof b.tokens !== "boolean")) return bad("the body takes only tokens, true or false");
        if (b.tokens) store.resetAll(); else store.resetPolicy();
        return none();
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
