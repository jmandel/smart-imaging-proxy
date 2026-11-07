// A typed client for the policy API in policy-api.ts.
import { POLICY_API_PATH, type Access, type AppGrantRequest, type DelegationRequest, type ExplainQuery, type Relationship } from "./policy-api";
import type { Guardian, Policy, PolicyStore, Rule, Settings } from "./policy-store";

/** A call the API refused or failed. `errors` lists each problem with a policy, when it says. */
export class PolicyApiError extends Error {
  constructor(public status: number, message: string, public errors?: string[]) { super(message); this.name = "PolicyApiError"; }
}

/** Each call, by name, so a caller's `fetch` can label it. */
export type PolicyOperation =
  | "relationships" | "access" | "explain" | "delegate" | "remove-delegations" | "grant-app" | "remove-app-grants"
  | "get-policy" | "set-policy" | "set-guardians" | "set-rules" | "update-rule" | "get-settings" | "set-settings" | "reset" | "info";

export interface PolicyClientOptions {
  /** The Imaging Server's service base: the API is at `${base}/policy/v1`. */
  base: string;
  serviceSecret: string;
  /** The store to act on, by the name the server knows it by. Without it, the one in use. */
  store?: string;
  /** Makes each request. The platform's fetch by default. */
  fetch?: (operation: PolicyOperation, url: string, init: RequestInit & { headers: Record<string, string> }) => Promise<Response>;
}

export function createPolicyClient(opts: PolicyClientOptions) {
  const send = opts.fetch ?? ((_op, url, init) => fetch(url, init));
  async function call(op: PolicyOperation, method: string, path: string, query: Record<string, string | undefined> = {}, body?: unknown): Promise<Response> {
    const q = new URLSearchParams(Object.entries({ ...query, store: opts.store }).filter((e): e is [string, string] => e[1] !== undefined));
    const url = `${opts.base}${POLICY_API_PATH}${path}${q.size ? `?${q}` : ""}`;
    const headers: Record<string, string> = { Authorization: `Bearer ${opts.serviceSecret}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) };
    return send(op, url, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  }
  async function fail(r: Response): Promise<never> {
    const b: any = await r.json().catch(() => undefined);
    throw new PolicyApiError(r.status, typeof b?.error === "string" ? b.error : `the Imaging Server answered ${r.status}`, Array.isArray(b?.errors) ? b.errors : undefined);
  }
  const read = async <T>(r: Response): Promise<T> => r.ok ? r.json() as Promise<T> : fail(r);
  const done = async (r: Response) => { if (!r.ok) await fail(r); await r.body?.cancel(); };
  /** True when the server did it, false when it answered `when`. */
  const outcome = async (r: Response, when: number) => { if (r.status === when) { await r.body?.cancel(); return false; } await done(r); return true; };

  return {
    /** Who is related to whom: guardians on file and delegations. */
    relationships: async () => read<Relationship[]>(await call("relationships", "GET", "/relationships")),
    access: async (user: string, fhirUser: string) => read<Access>(await call("access", "GET", "/access", { user, fhirUser })),
    explain: async (q: ExplainQuery) => read<any>(await call("explain", "GET", "/explain", { ...q })),
    /** False when the grantor is neither the patient nor their guardian. */
    delegate: async (d: DelegationRequest) => outcome(await call("delegate", "POST", "/delegations", {}, d), 403),
    /** False when nothing matched. */
    removeDelegations: async (m: { delegate: string; grantedBy?: string; patient?: string }) => outcome(await call("remove-delegations", "DELETE", "/delegations", m), 404),
    /** False when the user holds no record of this patient. */
    grantApp: async (g: AppGrantRequest) => outcome(await call("grant-app", "POST", "/app-grants", {}, g), 403),
    removeAppGrants: async (m: { client: string; user: string; patient?: string }) => outcome(await call("remove-app-grants", "DELETE", "/app-grants", m), 404),
    getPolicy: async () => read<Policy>(await call("get-policy", "GET", "/policy")),
    /** Replaces the parts given, all or none. */
    setPolicy: async (p: Partial<Policy>) => done(await call("set-policy", "PUT", "/policy", {}, p)),
    setGuardians: async (g: Guardian[]) => done(await call("set-guardians", "PUT", "/guardians", {}, g)),
    setRules: async (rules: Rule[]) => done(await call("set-rules", "PUT", "/rules", {}, rules)),
    /** False when there's no rule with this id. */
    updateRule: async (id: string, patch: Partial<Rule>) => outcome(await call("update-rule", "PATCH", `/rules/${encodeURIComponent(id)}`, {}, patch), 404),
    getSettings: async () => read<Settings>(await call("get-settings", "GET", "/settings")),
    setSettings: async (s: Partial<Settings>) => done(await call("set-settings", "PATCH", "/settings", {}, s)),
    /** Clears delegations, app grants, rules and settings, and puts the guardians on file back. `tokens` clears token records too. */
    reset: async (o: { tokens?: boolean } = {}) => done(await call("reset", "POST", "/reset", {}, o)),
    info: async () => read<ReturnType<PolicyStore["info"]>>(await call("info", "GET", "/store")),
    /** The same client, acting on another named store. */
    withStore: (store: string) => createPolicyClient({ ...opts, store }),
  };
}
export type PolicyClient = ReturnType<typeof createPolicyClient>;
