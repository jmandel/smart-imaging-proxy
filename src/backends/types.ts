import type { PlanItem } from "../accept";

// Operations take parsed UIDs and a transfer syntax plan. There is deliberately no field for
// client headers, so a backend cannot be handed the caller's SMART token.

export interface Scope { study: string; series?: string; instance?: string; onlySeries?: string[]; /** The study version a signed context names. Absent means current. */ version?: number; }

/** What a retrieval can handle, beyond the transfer syntax plan. */
export interface OpenOptions { /** The client accepts `Content-Encoding: zstd`, so stored zstd objects can pass through. */ passthroughZstd?: boolean; }

/** A complete plan: known before anything is opened, so `Content-Length` is known up front. */
export interface PlannedPart { sop: string; syntax: string; encoding: "none" | "zstd"; /** Exact bytes this part's body yields. */ bytes: number; }

export type BackendErrorKind = "NotFound" | "NotAcceptable" | "Unavailable" | "CannotDecode" | "Unknown";
export class BackendError extends Error {
  constructor(public kind: BackendErrorKind, message?: string, public retryAfter?: number) { super(message ?? kind); }
}

/** One instance: a body stream plus the syntax the backend says it is, if it knows. */
export interface InstancePart { syntax?: string; sop?: string; body: AsyncIterable<Uint8Array>; /** The body's encoding. Absent means none. */ encoding?: "none" | "zstd"; /** Exact bytes the body yields, when known. */ bytes?: number; }

/** A sequence of parts, ending in either completion or a truncation the proxy must surface. */
export interface PartStream { parts: AsyncGenerator<InstancePart, "complete" | "truncated">; /** Present when the backend knows every part up front. Then `syntax` is authoritative, and File Meta needn't be read. */ plan?: PlannedPart[]; }

export interface Capabilities {
  name: string;
  /** Whether the backend picks a syntax per instance, or uses one per request. */
  selection: "per-instance" | "one-per-request";
  /** Whether the proxy, not the backend, has seen and can list every instance. */
  hasManifest: boolean;
  enforcesHierarchy: boolean;
  notes: string[];
}

export interface Backend {
  capabilities(): Capabilities;
  /** Which series are in a study, so a released subset can be stitched. */
  listSeries(study: string): Promise<string[]>;
  openInstances(scope: Scope, plan: PlanItem[], options?: OpenOptions): Promise<PartStream>;
  /** DICOM JSON items. Bulk references are returned as `bulk:<ref>`, never as raw URLs. */
  getMetadata(scope: Scope): Promise<any[]>;
  openBulk(study: string, series: string, instance: string, ref: string, /** The study version a signed context names. Absent means current. */ version?: number): Promise<{ contentType: string; body: AsyncIterable<Uint8Array> }>;
  /** Raw upstream behavior, shown side by side in the demo. Absent on store-backed backends. */
  rawProbe?(path: string, accept: string): Promise<{ status: number; contentType: string | null; partSyntaxLabel: string | null; bodyPreview: string }>;
}
