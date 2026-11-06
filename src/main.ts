// Starts the demo: the services, then the flow player and admin screen, on loopback and the tailnet.
import { join } from "node:path";
import { startStack } from "./stack";
import { registerClients } from "./flows";
import { createDemoServer } from "./demo-server";
import { storeConfigFromEnv } from "./policy-store";
import { traceStoreConfigFromEnv } from "./trace-store";
import { CONFIG, PORTS, serveOn, TAILNET } from "./config";

const root = join(import.meta.dir, "..");
const stack = await startStack(root, { store: storeConfigFromEnv(), traces: traceStoreConfigFromEnv() });
const demo = createDemoServer(stack, registerClients(stack), root);
serveOn(PORTS.demo, { idleTimeout: 240, fetch: demo.fetch });
const info = stack.stores.saved.info();
console.log(`SMART Imaging proxy demo: ${CONFIG.demoUrl}${TAILNET ? " (tailnet)" : ""}`);
console.log(`Admin: ${CONFIG.demoUrl}/admin`);
console.log(`Live trace: ${CONFIG.traceUrl}`);
console.log(`Traces: ${stack.collector.store.path ?? "in memory"}`);
console.log(`Saved policy: ${info.mode === "file" ? `${info.path} (durability ${info.durability})` : "in memory"}`);
