// Demo clocks, so flows can show expiry without waiting. The root's is this module's; each scope has its own.
import type { Clock } from "@smart-imaging-proxy/core";

/** A clock running at an offset from real time, which the demo can move. */
export interface DemoClock extends Clock {
  advance(seconds: number): void;
  offset(): number;
  setOffset(seconds: number): void;
  reset(): void;
}
export function createDemoClock(initial = 0, onChange?: (offset: number) => void): DemoClock {
  let offset = initial;
  const set = (value: number) => { offset = value; onChange?.(offset); };
  return {
    now: () => Math.floor(Date.now() / 1000) + offset,
    advance: seconds => set(offset + seconds),
    offset: () => offset,
    setOffset: set,
    reset: () => set(0),
  };
}

/** The root's clock, which the admin screen moves. */
export const demoClock = createDemoClock();
export const now = () => demoClock.now();
export const advance = (seconds: number) => demoClock.advance(seconds);
export const clockOffset = () => demoClock.offset();
export const setClockOffset = (seconds: number) => demoClock.setOffset(seconds);
export const resetClock = () => demoClock.reset();
