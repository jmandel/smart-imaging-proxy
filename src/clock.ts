// A demo clock, so flows can show expiry without waiting.
import type { Clock } from "@smart-imaging-proxy/core";

let offset = 0;
export const now = () => Math.floor(Date.now() / 1000) + offset;
export const advance = (seconds: number) => { offset += seconds; };
export const clockOffset = () => offset;
export const setClockOffset = (seconds: number) => { offset = seconds; };
export const resetClock = () => { offset = 0; };
/** The demo clock, in the form core takes. */
export const demoClock: Clock = { now };
