// What the sandbox's Explore API answers, as the page reads it, and the view the page builds from it.
import type { LayerChain } from "../components/Layers";
import type { Study } from "../lib/smart-imaging";
import type { Pictures } from "../components/Thumbnail";

export interface Records { patient: string; name: string; via: "self" | "guardian" | "share"; relationship?: string }
export interface Person { id: string; name: string; first: string; fhirUser?: string; role: string; records: Records[]; others: { patient: string; name: string }[]; own?: number }
export interface Service { id: string; name: string; role: string; policies: number }
/** Who can look, from `/api/sandbox/explore/cast`. */
export interface Cast { people: Person[]; services: Service[]; relationships: string[]; app: string; names: Record<string, string> }
export interface Referral { id: string; reason?: string; report: string; patient?: string; patientRef: string; accession: string; system: string }

/** A next step the view offers: a change to policy, or another view. */
export type Action = { label: string } & (
  | { kind: "approve"; sites: string[]; ticked?: string[] }
  | { kind: "share"; from: string; with?: string; patient?: string; sites: string[]; people?: { id: string; name: string }[] }
  | { kind: "unshare"; with: string; patient?: string }
  | { kind: "revoke-app"; patient?: string }
  | { kind: "apply-policy"; ruleSet: string; text?: string }
  | { kind: "person"; user: string }
  | { kind: "referral"; referral: string }
);

/** A study as the sandbox explains it: released, or withheld and why. */
export interface Row { id: string; title: string; site?: string; date?: string; modalities?: string[]; released: boolean; reason?: string; partial?: string }
/** A view, explained from policy, from `/api/sandbox/explore/view`. */
export interface Explained {
  patient?: string; status: string; headline?: string; detail?: string; rows?: Row[]; actions?: Action[];
  empty?: { text: string; actions: Action[] }; whyTitle?: string; chain?: LayerChain; activityUrl: string; cited?: string;
}
/** A study's sheet: what search found, or what's withheld from what this viewer may know of. */
export interface Sheet extends Row { instanceCount?: number; seriesCount?: number; thumb?: boolean }

/** Who's looking: a person, or a service working from a referral. */
export type Who = { kind: "user"; id: string; name: string; first: string } | { kind: "service"; id: string; name: string; first: string; referral?: string };
export type Choice = { user: string; patient?: string; client?: undefined; referral?: undefined } | { client: string; referral?: string; user?: undefined; patient?: undefined };

/** A view as the page shows it: the explanation, then what the app's own token found. */
export interface View extends Partial<Explained> {
  running: boolean; session: string; who: Who; tech: string[];
  studies: Record<string, Study>; sheets?: Sheet[]; token?: string; searchStatus?: number; patientName?: string; pictures?: Pictures;
}
/** The whole study's retrieval, counted as it arrives. */
export interface Retrieval { running: boolean; parts: number; bytes: number; status?: number; complete?: boolean; wire?: number; ms?: number; error?: string }
/** A study's chain in one line, from the same events the activity log shows. */
export interface ChainLine { line: string; activityUrl: string }
