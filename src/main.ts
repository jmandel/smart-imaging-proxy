// Starts the demo, or some of its services for a deployment that splits them.
//
//   bun src/main.ts [--role all|demo|proxy|imaging|auth|trace]
//
// A role can be a comma-separated list, as in `--role imaging,auth,trace`. `all` is the default, and
// runs every service in this process. `demo` is the same: the flow player and admin screen work
// directly on the stores, the decision log, the proxy's event log and the clock, so they run with
// the services they drive.
//
// Every service reads its own address and the others' from CONFIG in src/config.ts, so all the
// processes need the same DEMO_PORT_OFFSET and DEMO_TAILNET. When split, a process also reads:
//
//   SERVICE_SECRET    Required, except for `trace` alone. The credential the proxy, the Imaging Server
//                     and the Authorization Server use with one another. All must hold the same one.
//   PROXY_BACKEND     For `proxy`: static-files (default), minio, or orthanc.
//   JWKS_TTL_SECONDS  For `proxy`: how long it trusts its copy of the public keys. Default 60.
//   POLICY_STORE, POLICY_DB, POLICY_DURABILITY  For `imaging` and `auth`.
//   TRACE_STORE, TRACE_DB, TRACE_MAX_BYTES      For `trace`.
//
// A proxy uses only the Imaging Server's JWKS, its decision URL, its backend, and SERVICE_SECRET. Like
// every service, it also sends its spans to the trace service, and carries on if that's down.
import { join } from "node:path";
import { startStack } from "./stack";
import { registerClients } from "./flows";
import { createDemoServer } from "./demo-server";
import { storeConfigFromEnv } from "./policy-store";
import { traceStoreConfigFromEnv } from "./trace-store";
import { CONFIG, PORTS, serveOn, TAILNET } from "./config";
import { ROLES, startRoles, type Role } from "./roles";

const root = join(import.meta.dir, "..");

const at = process.argv.indexOf("--role");
const asked = at === -1 ? ["all"] : (process.argv[at + 1] ?? "").split(",").filter(Boolean);
const whole = asked.includes("all") || asked.includes("demo");
const unknown = asked.filter(r => r !== "all" && r !== "demo" && !ROLES.includes(r as Role));
if (!asked.length || unknown.length || (whole && asked.length > 1)) {
  console.error(`--role takes all, demo, or a comma-separated list of ${ROLES.join(", ")}. Got: ${process.argv[at + 1] ?? "nothing"}`);
  process.exit(2);
}

let stopping: () => void;
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => { stopping?.(); process.exit(0); });

if (whole) {
  const stack = await startStack(root, { store: storeConfigFromEnv(), traces: traceStoreConfigFromEnv() });
  const demo = createDemoServer(stack, registerClients(stack), root);
  const demoServers = serveOn(PORTS.demo, { idleTimeout: 240, fetch: demo.fetch });
  stopping = () => { demoServers.forEach(s => s.stop(true)); stack.stop(); };
  const info = stack.stores.saved.info();
  console.log(`SMART Imaging proxy demo: ${CONFIG.demoUrl}${TAILNET ? " (tailnet)" : ""}`);
  console.log(`Admin: ${CONFIG.demoUrl}/admin`);
  console.log(`Live trace: ${CONFIG.traceUrl}`);
  console.log(`Traces: ${stack.collector.store.path ?? "in memory"}`);
  console.log(`Saved policy: ${info.mode === "file" ? `${info.path} (durability ${info.durability})` : "in memory"}`);
} else {
  const services = await startRoles(root, asked as Role[]);
  stopping = () => services.stop();
  console.log(`Running ${asked.join(", ")}: proxy ${CONFIG.proxyUrl}, imaging ${CONFIG.imagingUrl}, auth ${CONFIG.authUrl}, trace ${CONFIG.traceUrl}`);
}
