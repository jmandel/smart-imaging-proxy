// The background demo process that `bun run up` starts and `bun run down` stops, tracked by a PID file.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { PORTS, STORAGE } from "../src/config";

export const PID_FILE = `${STORAGE}/demo.pid`;
export const LOG_FILE = `${STORAGE}/demo.log`;

/** Something answers on the demo's port. */
export async function demoPortAnswers(): Promise<boolean> {
  try { await fetch(`http://127.0.0.1:${PORTS.demo}/`, { signal: AbortSignal.timeout(2000) }); return true; } catch { return false; }
}

/** The PID in the PID file, if that process is still this demo. */
function trackedPid(): number | undefined {
  if (!existsSync(PID_FILE)) return undefined;
  const pid = Number(readFileSync(PID_FILE, "utf8").trim());
  try {
    const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return cmd.includes("src/main.ts") ? pid : undefined;
  } catch {
    // No /proc, as on macOS: trust the file if the process exists.
    try { process.kill(pid, 0); return pid; } catch { return undefined; }
  }
}

/** Stops the demo this script started. Returns false when there was none. */
export async function stopDemo(): Promise<boolean> {
  const pid = trackedPid();
  rmSync(PID_FILE, { force: true });
  if (!pid) return false;
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 40 && await demoPortAnswers(); i++) await Bun.sleep(250);
  return true;
}
