// Stops what `bun run up` started: the demo, then MinIO and Orthanc. Data stays under DEMO_STORAGE,
// so the next `bun run up` is quick.
import { STORAGE } from "../src/config";
import { compose, demoPortAnswers, stopDemo } from "./demo-process";

console.log(await stopDemo() ? "Stopped the demo." : "No demo started by `bun run up` is running.");
if (await demoPortAnswers()) console.log("Something else still answers on the demo's port. This script only stops a demo it started.");
await compose(["down"]);
console.log(`Data is kept in ${STORAGE}.`);
