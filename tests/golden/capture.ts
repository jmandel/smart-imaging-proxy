// Writes tests/golden/search.json. Run this only to record a deliberate change in search behavior,
// and report what changed: DEMO_PORT_OFFSET=1100 bun tests/golden/capture.ts
import { join } from "node:path";
import { startStack } from "../../src/stack";
import { registerClients } from "../../src/flows";
import { runScenarios } from "./scenarios";

const stack = await startStack(join(import.meta.dir, "../.."));
stack.setBackend("static-files");
const out = await runScenarios(stack, registerClients(stack));
await Bun.write(join(import.meta.dir, "search.json"), `${JSON.stringify(out, null, 1)}\n`);
console.log(`${Object.keys(out).length} scenarios`);
stack.stop();
process.exit(0);
