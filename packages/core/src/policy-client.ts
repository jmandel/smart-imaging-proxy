// A typed client for the policy API in policy-api.ts.
import { POLICY_API_PATH, type Access, type ApprovalRequest, type ExplainQuery, type Refusal, type ShareRequest } from "./policy-api";
import type { AppApproval, OrgPolicy, PolicyDocument, Relationship, Revision, Share } from "./policy-model";
import type { PolicyStore, Settings } from "./policy-store";

/** A call the API refused or failed. `errors` lists each problem with a policy, and `policy` names the one that refused a choice. */
export class PolicyApiError extends Error {
  constructor(public status: number, message: string, public errors?: string[], public policy?: string) { super(message); this.name = "PolicyApiError"; }
}

/** Each call, by name, so a caller's `fetch` can label it. */
export type PolicyOperation =
  | "get-document" | "set-document" | "relationships" | "put-relationship" | "remove-relationship"
  | "policies" | "put-policy" | "replace-policies" | "remove-policy"
  | "shares" | "share" | "remove-shares" | "approvals" | "approve-app" | "remove-approvals"
  | "access" | "explain" | "get-settings" | "set-settings" | "reset" | "info";

export interface PolicyClientOptions {
  /** The Imaging Server's service base: the API is at `${base}/policy/v2`. */
  base: string;
  /** The policy API's credential, which the Imaging Server's `policySecret` names. */
  policySecret: string;
  /** Makes each request. The platform's fetch by default. */
  fetch?: (operation: PolicyOperation, url: string, init: RequestInit & { headers: Record<string, string> }) => Promise<Response>;
}

/** A choice's outcome: made, with the revisions it raised, or refused by the policy named. */
export type ChoiceResult<T> = { ok: true; revision: Revision } & T | { ok: false; refusal: Refusal };

export function createPolicyClient(opts: PolicyClientOptions) {
  const send = opts.fetch ?? ((_op, url, init) => fetch(url, init));
  async function call(op: PolicyOperation, method: string, path: string, query: Record<string, string | undefined> = {}, body?: unknown): Promise<Response> {
    // An empty value means no filter, as an absent one does.
    const q = new URLSearchParams(Object.entries(query).filter((e): e is [string, string] => e[1] !== undefined && e[1] !== ""));
    const url = `${opts.base}${POLICY_API_PATH}${path}${q.size ? `?${q}` : ""}`;
    const headers: Record<string, string> = { Authorization: `Bearer ${opts.policySecret}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) };
    return send(op, url, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  }
  async function fail(r: Response): Promise<never> {
    const b: any = await r.json().catch(() => undefined);
    throw new PolicyApiError(r.status, typeof b?.error === "string" ? b.error : `the Imaging Server answered ${r.status}`, Array.isArray(b?.errors) ? b.errors : undefined, typeof b?.policy === "string" ? b.policy : undefined);
  }
  const read = async <T>(r: Response): Promise<T> => r.ok ? r.json() as Promise<T> : fail(r);
  const revision = async (r: Response) => (await read<{ revision: Revision }>(r)).revision;
  /** The revisions a removal raised, or undefined when nothing matched. */
  const removal = async (r: Response) => r.status === 404 ? (await r.body?.cancel(), undefined) : revision(r);
  /** A choice: its body, or the refusal a 403 carries. */
  const choice = async <T>(r: Response): Promise<ChoiceResult<T>> => r.status === 403 ? { ok: false, refusal: await r.json() as Refusal } : { ok: true, ...(await read<any>(r)) };

  return {
    getDocument: async () => read<PolicyDocument & { revision: Revision }>(await call("get-document", "GET", "/document")),
    /** Replaces the parts given, all or none. */
    setDocument: async (d: Partial<PolicyDocument>) => revision(await call("set-document", "PUT", "/document", {}, d)),

    relationships: async () => (await read<{ relationships: Relationship[] }>(await call("relationships", "GET", "/relationships"))).relationships,
    putRelationship: async (r: Relationship) => revision(await call("put-relationship", "PUT", "/relationships", {}, r)),
    removeRelationship: async (r: Pick<Relationship, "subject" | "relation" | "object">) => removal(await call("remove-relationship", "DELETE", "/relationships", { ...r })),

    policies: async (type?: OrgPolicy["type"]) => (await read<{ policies: OrgPolicy[] }>(await call("policies", "GET", "/policies", { type }))).policies,
    putPolicy: async (p: OrgPolicy) => revision(await call("put-policy", "PUT", `/policies/${encodeURIComponent(p.id)}`, {}, p)),
    /** Replaces every policy of one type. */
    replacePolicies: async (type: OrgPolicy["type"], ps: OrgPolicy[]) => revision(await call("replace-policies", "PUT", "/policies", { type }, ps)),
    removePolicy: async (id: string) => removal(await call("remove-policy", "DELETE", `/policies/${encodeURIComponent(id)}`)),

    shares: async () => (await read<{ shares: Share[] }>(await call("shares", "GET", "/shares"))).shares,
    /** A share, which organization policy may refuse. Its sites narrow to what the sharer may name. */
    share: async (s: ShareRequest) => choice<{ share: Share }>(await call("share", "POST", "/shares", {}, s)),
    removeShares: async (m: { with: string; from?: string; patient?: string }) => removal(await call("remove-shares", "DELETE", "/shares", m)),
    approvals: async () => (await read<{ approvals: AppApproval[] }>(await call("approvals", "GET", "/app-approvals"))).approvals,
    /** An app approval, which is refused when the user holds no record of the patient. */
    approveApp: async (a: ApprovalRequest) => choice<{ approval: AppApproval }>(await call("approve-app", "POST", "/app-approvals", {}, a)),
    removeApprovals: async (m: { by: string; app: string; patient?: string }) => removal(await call("remove-approvals", "DELETE", "/app-approvals", m)),

    access: async (user: string, fhirUser: string) => read<Access>(await call("access", "GET", "/access", { user, fhirUser })),
    explain: async (q: ExplainQuery) => read<any>(await call("explain", "GET", "/explain", { ...q })),
    getSettings: async () => read<Settings & { revision: Revision }>(await call("get-settings", "GET", "/settings")),
    setSettings: async (s: Partial<Settings>) => revision(await call("set-settings", "PATCH", "/settings", {}, s)),
    /** Clears shares, approvals and settings, and puts facts and policy back as they are on file. `tokens` clears token records too. */
    reset: async (o: { tokens?: boolean } = {}) => revision(await call("reset", "POST", "/reset", {}, o)),
    info: async () => read<ReturnType<PolicyStore["info"]>>(await call("info", "GET", "/store")),
  };
}
export type PolicyClient = ReturnType<typeof createPolicyClient>;
