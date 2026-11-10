// What the viewer keeps in this tab: its session, a sign-in under way, and the steps it took, so a reload or a
// sign-in that came back to this tab carries on where it was.
import type { PrivateJwk } from "../lib/api";
import { VIEWER_SESSION } from "../lib/servers";
import { session as tab } from "../lib/store";
import type { Step } from "./trail";

/** A connection: the token, whose chart it opens, and where the images are. */
export interface Session { token: string; patient: string; imaging: string; iss: string; label: string; backend?: boolean }
/** A sign-in under way: what the token exchange will need when the code comes back. */
export interface Pending { verifier: string; state: string; config: any; iss: string; clientId: string; imaging?: string; label: string; jwk?: PrivateJwk }
export interface Saved { session?: Session; pending?: Pending; trail?: Step[] }

export const saved = (): Saved => { try { return JSON.parse(tab.get(VIEWER_SESSION) ?? "{}"); } catch { return {}; } };
export const save = (patch: Saved) => tab.set(VIEWER_SESSION, JSON.stringify({ ...saved(), ...patch }));
export const forget = () => tab.set(VIEWER_SESSION, null);
/** Where a connection keeps what it saves. The viewer keeps it in this tab; the server check, only in memory, so it never leaves the viewer connected. */
export interface Keeper { saved(): Saved; save(patch: Saved): void }
export const viewerKeeper: Keeper = { saved, save };
export function memoryKeeper(): Keeper {
  let kept: Saved = {};
  return { saved: () => kept, save: patch => { kept = { ...kept, ...patch }; } };
}
