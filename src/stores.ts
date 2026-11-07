// The root's policy store, and the guardians on file that every world starts with.
import { DURABILITIES, PolicyStore, type Durability, type Guardian, type StoreConfig } from "@smart-imaging-proxy/core";
import { DEFAULT_POLICY_DB } from "./config";
import people from "../data/patient.json";

/** The guardians on file in `data/patient.json`, which stands in for a registration office. */
export const STANDING_GUARDIANS: Guardian[] = people.otherPatients.flatMap((p: { id: string; guardians?: { account: string; relationship: string; excludedStudies?: string[] }[] }) => (p.guardians ?? []).map(g => ({ patient: p.id, guardian: g.account, relationship: g.relationship, ...(g.excludedStudies ? { excludedStudies: g.excludedStudies } : {}) })));

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
  new PolicyStore({ guardians: STANDING_GUARDIANS, ...config, ...(config.mode === "file" ? { path: config.path ?? DEFAULT_POLICY_DB } : {}) });
