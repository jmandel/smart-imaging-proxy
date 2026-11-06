// Runs every flow against every backend, using the same definitions as the web demo.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { startStack, type BackendName, type Stack } from "../src/stack";
import { defaultsFor, FLOWS, registerClients, runStep, startFlow } from "../src/flows";

const BACKENDS: BackendName[] = (process.env.BACKENDS?.split(",") as BackendName[]) ?? ["static-files", "minio", "orthanc"];
let stack: Stack; let clients: any;
beforeAll(async () => { stack = await startStack(join(import.meta.dir, "..")); clients = registerClients(stack); });
afterAll(() => stack.stop());

async function runAll(flowId: string, override: Record<string, Record<string, any>> = {}) {
  const flow = FLOWS.find(f => f.id === flowId)!;
  const c = await startFlow(stack, clients, flow);
  const failures: string[] = [];
  for (const step of flow.steps) {
    const inputs = { ...defaultsFor(c, flow, step.id), ...(override[step.id] ?? {}) };
    const r = await runStep(c, flow, step.id, inputs);
    expect(r.checks.length).toBeGreaterThan(0);
    for (const k of r.checks) if (!k.ok) failures.push(`${step.id}: ${k.label} (${k.detail ?? ""})`);
  }
  return failures;
}

for (const backend of BACKENDS) {
  describe(backend, () => {
    beforeAll(() => stack.setBackend(backend));
    test("backend self-test", async () => {
      stack.setBackend(backend);
      const r = await stack.selfTest(backend);
      expect(r.detail).toContain("series");
      expect(r.ok).toBe(true);
    });
    for (const flow of FLOWS) {
      test(`${flow.number}. ${flow.title}`, async () => {
        stack.setBackend(backend);
        expect(await runAll(flow.id)).toEqual([]);
      }, 240000);
    }
    test("variant: patient approves only Riverside", async () => {
      stack.setBackend(backend);
      expect(await runAll("patient-sites", { consent: { sites: ["Riverside Hospital"] }, unapproved: { study: "xr-hand-right-2012" } })).toEqual([]);
    }, 120000);
    test("variant: patient approves no sites", async () => {
      stack.setBackend(backend);
      expect(await runAll("patient-sites", { consent: { sites: [] } })).toEqual([]);
    }, 120000);
    test("variant: referral service also allowed MR", async () => {
      stack.setBackend(backend);
      expect(await runAll("backend-referral", { token: { modalities: ["CR", "MR"] }, outside: { study: "mri-brain-2020" } })).toEqual([]);
    }, 120000);
    test("variant: separate viewer not authorized", async () => {
      stack.setBackend(backend);
      expect(await runAll("viewer", { separate: { allowed: "no" } })).toEqual([]);
    }, 60000);
    test("variant: MRI series list fits in the URL", async () => {
      stack.setBackend(backend);
      expect(await runAll("complex-policy", { policy: { limit: "40" } })).toEqual([]);
    }, 120000);
    test("variant: truncation after 5 instances", async () => {
      stack.setBackend(backend);
      expect(await runAll("truncation", { fail: { after: "5" } })).toEqual([]);
    }, 120000);
  });
}
