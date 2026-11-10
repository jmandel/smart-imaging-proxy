// Typed events: what core did, as records with a stable kind and payload, for an embedder's audit or
// activity view. Each kind's fields are fixed, so a viewer can render one card per kind. Tokens appear
// only as `tokenHash`, the first 10 characters of the base64url SHA-256 the signed context's `ath`
// holds, and signed contexts only as `contextHash`, the same of the context.
import { createHash } from "node:crypto";

/** A short hash that names a token or context in events, and never reveals it. */
export const shortHash = (value: string) => createHash("sha256").update(value).digest("base64url").slice(0, 10);

/** A context's form, as signed into it. */
export type ContextForm = "whole study" | "series list" | "restricted";
/** How a search Bundle carries a study's Endpoint: a response-local entry, contained in the study, or an entry with its own address. */
export type EndpointForm = "response-local" | "contained" | "separate";
/** How the proxy decided a retrieval. */
export type Authz = "instant" | "cached" | "asked" | "no token";

export interface ContextSigned { kind: "context.signed"; study: string; studyUid: string; kid: string; form: ContextForm; series?: number; exp: number; tokenHash: string; contextHash: string; }
export interface SearchReturned {
  kind: "search.returned"; status: number; client?: string; user?: string; patient?: string; tokenHash?: string;
  /** The query, without `_cursor`. */
  query: string;
  /** For a 200: this page's studies, and every study the caller may see. */
  found?: string[]; total?: number;
  /** For a 200: the studies the user reaches by a route of their own and this client isn't released, such as one outside an app approval's sites, each with its reason. */
  withheld?: { study: string; why: string }[];
  /**
   * For a 200: every other study policy didn't release, which no route or policy of the caller's
   * reaches, such as one a label keeps from a guardian, or one outside a share's sites. It names
   * studies the caller may not know exist: it's for operators, and a view shown to the caller leaves it out.
   */
  unreached?: { study: string; why: string }[];
  /** For anything else: why. */
  reason?: string;
  /** When Endpoints are staged in every form: each study's form, by id. */
  endpointForms?: Record<string, EndpointForm>;
}
export interface DecisionAnswered {
  kind: "decision.answered"; study?: string; studyUid?: string; client?: string; user?: string; patient?: string; tokenHash?: string; contextHash?: string;
  decision: boolean; why: string;
  /** The AuthZEN request, with the subject's id, its access token and the signed context each replaced by a short hash. */
  request: unknown;
  response: unknown;
}
export interface FastPath { kind: "proxy.fast-path"; studyUid: string; tokenHash: string; contextHash?: string; taken: boolean; /** The first check that failed, when not taken. */ failed?: string; }
export interface DecisionAsked { kind: "proxy.decision"; studyUid: string; tokenHash: string; contextHash?: string; via: "cached" | "asked"; allowed: boolean; denial?: string; unavailable?: boolean; }
export interface StreamDone {
  kind: "stream.done"; studyUid: string; resource: string; status: number; authz?: Authz; tokenHash?: string; contextHash?: string;
  parts: number; bytes: number; encoding: "zstd" | "identity"; syntaxes: string[]; complete: boolean; note?: string;
  /** The request had no Accept header. */
  noAccept?: true;
}
export interface RetrievalAnswered { kind: "retrieval.answered"; studyUid?: string; resource: string; status: number; authz?: Authz; denial?: string; note?: string; tokenHash?: string; contextHash?: string; noAccept?: true; }
export interface PolicyWritten {
  kind: "policy.written"; operation: string; level: "fact" | "policy" | "choice" | "settings" | "document" | "reset";
  /** The request body and query, which hold no secrets. */
  body?: unknown; query?: Record<string, string>;
  status: number; revision?: unknown; error?: string; patient?: string;
}

export type CoreEvent = ContextSigned | SearchReturned | DecisionAnswered | FastPath | DecisionAsked | StreamDone | RetrievalAnswered | PolicyWritten;
export type CoreEventKind = CoreEvent["kind"];
export const CORE_EVENT_KINDS: CoreEventKind[] = ["context.signed", "search.returned", "decision.answered", "proxy.fast-path", "proxy.decision", "stream.done", "retrieval.answered", "policy.written"];
