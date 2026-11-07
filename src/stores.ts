// The root's policy store, and what's on file that every world starts with: the guardians registration
// recorded in data/patient.json, the organization's guardian and sharing policies, and patient
// attributes, such as birth dates, which policy by age reads.
import { DURABILITIES, PolicyStore, validateDocument, validateSetting, type Durability, type OnFile, type OrgPolicy, type PatientAttributes, type PolicyDocument, type Relationship, type Settings, type StoreConfig } from "@smart-imaging-proxy/core";
import { DEFAULT_POLICY_DB } from "./config";
import people from "../data/patient.json";

type Person = { id: string; birthDate?: string; guardians?: { account: string }[] };
const everyone: Person[] = [people as Person, ...(people.otherPatients as Person[])];

/** The guardians on file: facts registration recorded, which grant nothing without a guardian-access policy. */
export const GUARDIANS_ON_FILE: Relationship[] = everyone.flatMap(p => (p.guardians ?? []).map(g => ({ subject: `user:${g.account}`, relation: "guardian_of", object: `patient:${p.id}`, recordedBy: "registration" })));
/** The organization's policy on file: what guardians see by the patient's age, and who may share. */
export const POLICIES_ON_FILE: OrgPolicy[] = [
  { id: "guardians-under-13", type: "guardian-access", description: "Guardians of children under 13 see all their studies", when: { age: { max: 12 } }, allow: "all" },
  { id: "guardians-13-to-17", type: "guardian-access", description: "Guardians of 13- to 17-year-olds see all but confidential adolescent care", when: { age: { min: 13, max: 17 } }, allow: "all", except: ["confidential-adolescent"] },
  { id: "patients-and-guardians-share", type: "sharing", description: "Patients and guardians may share what they can see", allowedFrom: ["patient", "guardian"] },
];
export const ON_FILE: OnFile = { relationships: GUARDIANS_ON_FILE, policies: POLICIES_ON_FILE };
/** A patient's record, as policy reads it. */
export const patientAttributes = (patient: string): PatientAttributes | undefined => { const p = everyone.find(x => x.id === patient); return p && { birthDate: p.birthDate }; };

/** The policy settings a flow's panel and a seed carry beside the document. */
export const PANEL_SETTINGS = ["contextLifetimeSeconds", "maxSeriesInContext"] as const;
type PanelSettings = Partial<Pick<Settings, (typeof PANEL_SETTINGS)[number]>>;
/** What a flow's policy panel shows and takes, and what a seed holds: the three levels, and those settings. */
export type Panel = Partial<PolicyDocument> & PanelSettings;
/** A panel's document and settings, or every reason it isn't one. */
export function splitPanel(x: unknown): { document: Partial<PolicyDocument>; settings: PanelSettings; errors: string[] } {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return { document: {}, settings: {}, errors: ["the document must be a JSON object"] };
  const document: Record<string, unknown> = {}, settings: Record<string, unknown> = {}, errors: string[] = [];
  for (const [k, v] of Object.entries(x)) {
    if ((PANEL_SETTINGS as readonly string[]).includes(k)) { settings[k] = v; validateSetting(k as keyof Settings, v, errors); }
    else document[k] = v;
  }
  errors.push(...validateDocument(document));
  return { document: document as Partial<PolicyDocument>, settings: settings as PanelSettings, errors };
}
/** A store's panel: the document, without its revision, and the settings. */
export function panelOf(store: PolicyStore): Panel {
  const { revision: _, ...document } = store.snapshot();
  const s = store.getSettings();
  return { ...document, contextLifetimeSeconds: s.contextLifetimeSeconds, maxSeriesInContext: s.maxSeriesInContext };
}

/** Reads POLICY_STORE, POLICY_DB and POLICY_DURABILITY. A bad value stops startup with a clear message. */
export function storeConfigFromEnv(env: Record<string, string | undefined> = process.env): StoreConfig {
  const mode = env.POLICY_STORE ?? "file";
  if (mode !== "file" && mode !== "memory") throw new Error(`POLICY_STORE must be file or memory, not "${mode}"`);
  const durability = env.POLICY_DURABILITY ?? "normal";
  if (!DURABILITIES.includes(durability as Durability)) throw new Error(`POLICY_DURABILITY must be off, normal or full, not "${durability}"`);
  return { mode, path: env.POLICY_DB || DEFAULT_POLICY_DB, durability: durability as Durability };
}

/** The root's store: the one real policy database, or memory with no configuration. */
export const openRootStore = (config: StoreConfig = { mode: "memory" }) =>
  new PolicyStore({ onFile: ON_FILE, ...config, ...(config.mode === "file" ? { path: config.path ?? DEFAULT_POLICY_DB } : {}) });
