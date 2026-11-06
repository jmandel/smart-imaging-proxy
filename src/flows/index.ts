import { policyFlows } from "./policy-flows";
import { protocolFlows } from "./protocol-flows";
import { Ctx, resetDemo, type Flow, type StepResult } from "./runtime";
import type { Stack } from "../stack";
import type { BackendClient } from "../auth-server";
import { randomBytes } from "node:crypto";
import { flushTraces, runInSession, withSpan } from "../trace";

export const FLOWS: Flow[] = [...policyFlows, ...protocolFlows];
export const flowById = (id: string) => FLOWS.find(f => f.id === id);

export function registerClients(stack: Stack): Record<string, BackendClient> {
  const clients: Record<string, BackendClient> = {};
  for (const id of ["hand-referral-service", "outside-release-service", "research-donation"]) clients[id] = stack.auth.registerBackendClient(id, ["system/ImagingStudy.rs"]);
  return clients;
}

export async function startFlow(stack: Stack, clients: Record<string, BackendClient>, flow: Flow): Promise<Ctx> {
  resetDemo(stack);
  const c = new Ctx(stack, clients);
  c.session = `flow-${flow.number}-${flow.id}-${randomBytes(3).toString("hex")}`;
  await flow.setup?.(c);
  return c;
}

export async function runStep(c: Ctx, flow: Flow, stepId: string, inputs: Record<string, any>): Promise<StepResult> {
  const step = flow.steps.find(s => s.id === stepId);
  if (!step) throw new Error(`no step ${stepId}`);
  c.beginStep();
  const narrative = await runInSession(c.session, () => withSpan("user", "action", `${flow.number}. ${step.title}`, { flow: flow.title, step: step.id, backend: c.backend, actor: step.actor, inputs }, async s => {
    const n = await step.run(c, inputs);
    const failed = c.checks.filter(k => !k.ok).length;
    s.end(failed ? "error" : "ok", { checks_passed: c.checks.length - failed, checks_failed: failed });
    return n;
  }, { session: c.session, trace: randomBytes(16).toString("hex") }));
  flushTraces();
  return c.endStep(narrative ?? undefined);
}

export const defaultsFor = (c: Ctx, flow: Flow, stepId: string) => {
  const step = flow.steps.find(s => s.id === stepId)!;
  const out: Record<string, any> = {};
  for (const i of step.inputs?.(c) ?? []) out[i.id] = i.default;
  return out;
};
