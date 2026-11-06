// A demo clock, so flows can show expiry without waiting.
let offset = 0;
export const now = () => Math.floor(Date.now() / 1000) + offset;
export const advance = (seconds: number) => { offset += seconds; };
export const resetClock = () => { offset = 0; };
