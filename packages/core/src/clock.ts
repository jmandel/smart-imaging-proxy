/** The time core decides by: context and decision expiry, and token `exp` checks. */
export interface Clock {
  /** Seconds since the epoch. */
  now(): number;
}

export const systemClock: Clock = { now: () => Math.floor(Date.now() / 1000) };
