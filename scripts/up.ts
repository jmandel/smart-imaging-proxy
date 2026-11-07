// From a fresh clone to a running deployment in one command. Checks what it needs, runs each setup
// step, starts the S3 store and Orthanc as plain processes, and starts the demo in the background. Every step is safe to
// repeat, and a demo this script started is restarted, so it serves the current code.
import { closeSync, mkdirSync, openSync } from "node:fs";
import { CONFIG, STORAGE } from "../src/config";
import { LOG_FILE, PID_FILE, demoPortAnswers, stopDemo } from "./demo-process";

const root = `${import.meta.dir}/..`;
const fail = (message: string): never => { console.error(`\n${message}`); process.exit(1); };

const missing = ["dcmconv", "dcmcjpeg", "dcmodify", "curl", "tar", "unzip"].filter(t => !Bun.which(t));
if (missing.length) fail(`Install these first: ${missing.join(", ")}. DCMTK provides the dcm* tools.`);

async function step(title: string, cmd: string[]) {
  console.log(`\n== ${title}`);
  const p = Bun.spawn(cmd, { cwd: root, stdout: "inherit", stderr: "inherit" });
  if ((await p.exited) !== 0) fail(`"${title}" failed. Fix the error above, then run \`bun run up\` again: finished steps are skipped quickly.`);
}

mkdirSync(STORAGE, { recursive: true });
if (await stopDemo()) console.log("Stopped the running demo, to restart it on the current code.");
if (await demoPortAnswers()) fail(`Something else is using port ${new URL(CONFIG.demoUrl).port}. Stop it, or set DEMO_PORT_OFFSET.`);

await step("Install the browser test driver, and link the core package", ["bun", "install", "--frozen-lockfile"]);
await step("Download the sample data, verifying checksums", ["bun", "scripts/fetch-data.ts"]);
await step("Generate the synthetic studies, and build the archive", ["bun", "scripts/ingest.ts"]);
await step("Download the S3 store and Orthanc, checking each against its pinned SHA-256", ["bun", "scripts/backends.ts", "fetch"]);
await step("Download viewer-kit, the browser DICOM decoder, checking its pinned SHA-256 and every file", ["bun", "scripts/viewer-kit.ts"]);
await step("Start the S3 store and Orthanc", ["bun", "scripts/backends.ts", "start"]);
await step("Copy the archive to the S3 bucket, and add any study Orthanc lacks", ["bun", "scripts/load-backends.ts"]);

console.log("\n== Start the demo");
const log = openSync(LOG_FILE, "w");
const demo = Bun.spawn(["bun", "src/main.ts"], { cwd: root, stdin: "ignore", stdout: log, stderr: log, detached: true });
closeSync(log);
demo.unref();
await Bun.write(PID_FILE, `${demo.pid}\n`);
// The first start builds the catalogs, which takes a little while.
for (let i = 0; i < 240; i++) {
  if (demo.exitCode !== null) fail(`The demo exited. Its log is ${LOG_FILE}:\n\n${await Bun.file(LOG_FILE).text()}`);
  try { if ((await fetch(`${CONFIG.demoUrl}/`, { signal: AbortSignal.timeout(2000) })).ok) break; } catch {}
  await Bun.sleep(500);
}
if (!(await demoPortAnswers())) fail(`The demo didn't answer within two minutes. Its log is ${LOG_FILE}.`);

console.log(`
Running.

  Explore     ${CONFIG.demoUrl}/
  Tours       ${CONFIG.demoUrl}/tours
  Live trace  ${CONFIG.traceUrl}
  FHIR base   ${CONFIG.authUrl}/fhir, for apps

Log: ${LOG_FILE}
Stop with \`bun run down\`.`);
process.exit(0);
