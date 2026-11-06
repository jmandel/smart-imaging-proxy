import type { PlanItem } from "../accept";

// Operations take parsed UIDs and a transfer syntax plan. There is deliberately no field for
// client headers, so a backend cannot be handed the caller's SMART token.

export interface Scope { study: string; series?: string; instance?: string; onlySeries?: string[]; }

export type BackendErrorKind = "NotFound" | "NotAcceptable" | "Unavailable" | "CannotDecode" | "Unknown";
export class BackendError extends Error {
  constructor(public kind: BackendErrorKind, message?: string, public retryAfter?: number) { super(message ?? kind); }
}

/** One instance: a body stream plus the syntax the backend says it is, if it knows. */
export interface InstancePart { syntax?: string; sop?: string; body: AsyncIterable<Uint8Array>; }

/** A sequence of parts, ending in either completion or a truncation the proxy must surface. */
export interface PartStream { parts: AsyncGenerator<InstancePart, "complete" | "truncated">; }

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
  openInstances(scope: Scope, plan: PlanItem[]): Promise<PartStream>;
  /** DICOM JSON items. Bulk references are returned as `bulk:<ref>`, never as raw URLs. */
  getMetadata(scope: Scope): Promise<any[]>;
  openBulk(study: string, series: string, instance: string, ref: string): Promise<{ contentType: string; body: AsyncIterable<Uint8Array> }>;
  /** Raw upstream behavior, shown side by side in the demo. Absent on store-backed backends. */
  rawProbe?(path: string, accept: string): Promise<{ status: number; contentType: string | null; partSyntaxLabel: string | null; bodyPreview: string }>;
}
