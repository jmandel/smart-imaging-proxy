// Demo clocks, so flows can show expiry without waiting. The root's is this module's; each scope has its own.
import type { Clock } from "@smart-imaging-proxy/core";

/** A clock running at an offset from real time, which the demo can move. */
export interface DemoClock extends Clock {
  advance(seconds: number): void;
  offset(): number;
  setOffset(seconds: number): void;
  reset(): void;
}
export function createDemoClock(): DemoClock {
  let offset = 0;
  return {
    now: () => Math.floor(Date.now() / 1000) + offset,
    advance: seconds => { offset += seconds; },
    offset: () => offset,
    setOffset: seconds => { offset = seconds; },
    reset: () => { offset = 0; },
  };
}

/** The root's clock, which the admin screen moves. */
export const demoClock = createDemoClock();
export const now = () => demoClock.now();
export const advance = (seconds: number) => demoClock.advance(seconds);
export const clockOffset = () => demoClock.offset();
export const setClockOffset = (seconds: number) => demoClock.setOffset(seconds);
export const resetClock = () => demoClock.reset();
