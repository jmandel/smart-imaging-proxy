// The demo's two policy stores, saved and scratch, and the guardians on file that both start with.
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

export type StoreName = "saved" | "scratch";
export const STORE_NAMES: StoreName[] = ["saved", "scratch"];
export const STORE_LABELS: Record<StoreName, string> = { saved: "Saved policy", scratch: "Flow scratch: reset when a flow starts" };

/**
 * The saved store holds configuration that outlives a flow. Flows run against a scratch store in
 * memory, so they can start from a known state every time without disturbing saved configuration.
 * The signing key lives only in the saved store, and URLs from both stores are signed with it.
 */
export function createStores(config: StoreConfig) {
  const saved = new PolicyStore({ guardians: STANDING_GUARDIANS, ...config, ...(config.mode === "file" ? { path: config.path ?? DEFAULT_POLICY_DB } : {}) });
  const scratch = new PolicyStore({ mode: "memory", guardians: STANDING_GUARDIANS });
  let activeName: StoreName = "saved";
  return {
    saved, scratch,
    get active() { return activeName === "saved" ? saved : scratch; },
    get activeName() { return activeName; },
    get activeLabel() { return STORE_LABELS[activeName]; },
    /** A store by the name the policy API knows it by. */
    named(name: string) { return name === "saved" ? saved : name === "scratch" ? scratch : undefined; },
    activate(name: StoreName) { activeName = name; },
    close() { saved.close(); scratch.close(); },
  };
}
export type Stores = ReturnType<typeof createStores>;
