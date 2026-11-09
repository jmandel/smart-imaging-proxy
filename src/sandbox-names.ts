// A friendly name for a sandbox, as a label. The sandbox's id stays its address, since whoever has that can use it.
const ADJECTIVES = ["Quiet", "Amber", "Bright", "Calm", "Cedar", "Clear", "Copper", "Golden", "Hidden", "Maple", "Misty", "Northern", "Silver", "Sunny", "Swift", "Willow"];
const NOUNS = ["Brook", "Canyon", "Cove", "Delta", "Field", "Grove", "Harbor", "Hollow", "Lake", "Meadow", "Mesa", "Prairie", "Ridge", "River", "Shore", "Valley"];
const pick = <T>(list: T[]) => list[Math.floor(Math.random() * list.length)]!;
export const friendlyName = () => `${pick(ADJECTIVES)} ${pick(NOUNS)}`;
