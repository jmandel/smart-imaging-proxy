import { policyFlows } from "./policy-flows";
import { protocolFlows } from "./protocol-flows";
import { Ctx, resetDemo, type Flow, type StepResult } from "./runtime";
import type { Stack } from "../stack";
import { DEMO_BACKEND_CLIENTS, DEMO_BACKEND_SCOPES, type BackendClient } from "../auth-server";
import { randomBytes } from "node:crypto";
import { flushTraces, runInSession, withSpan } from "../trace";

export const FLOWS: Flow[] = [...policyFlows, ...protocolFlows];
export const flowById = (id: string) => FLOWS.find(f => f.id === id);

export function registerClients(stack: Stack): Record<string, BackendClient> {
  const clients: Record<string, BackendClient> = {};
  for (const id of DEMO_BACKEND_CLIENTS) clients[id] = stack.auth.registerBackendClient(id, DEMO_BACKEND_SCOPES);
  return clients;
}

export async function startFlow(stack: Stack, clients: Record<string, BackendClient>, flow: Flow): Promise<Ctx> {
  resetDemo(stack);
  const c = new Ctx(stack, clients);
  c.session = `flow-${flow.number}-${flow.id}-${randomBytes(3).toString("hex")}`;
  await flow.setup?.(c);
  return c;
}

/** An error after someone chose another account says so, since the choice is the likely cause. */
async function runInSessionNoted<T>(c: Ctx, run: () => Promise<T>): Promise<T> {
  try { return await run(); }
  catch (e) { if (c.accountNote) (e as Error).message = `${(e as Error).message}. ${c.accountNote}`; throw e; }
}

export class BadStepInput extends Error {}
export async function runStep(c: Ctx, flow: Flow, stepId: string, inputs: Record<string, any>): Promise<StepResult> {
  const step = flow.steps.find(s => s.id === stepId);
  if (!step) throw new Error(`no step ${stepId}`);
  for (const i of step.inputs?.(c) ?? []) {
    const v = inputs[i.id];
    if (v === undefined) continue;
    const fits = i.type === "multi" ? Array.isArray(v) && v.every(x => typeof x === "string" && (!i.options || i.options.some(o => o.value === x))) : typeof v === "string" && (i.type !== "select" || !i.options || i.options.some(o => o.value === v));
    if (!fits) throw new BadStepInput(i.options?.length === 0 ? `There's nothing to choose for "${i.label}", because the earlier steps left none.` : `"${i.label}" isn't one of this step's choices.`);
  }
  c.beginStep();
  // A request can leave out a step's choices, and a step always has them.
  inputs = { ...defaultsFor(c, flow, stepId), ...inputs };
  const narrative = await runInSessionNoted(c, () => runInSession(c.session, () => withSpan("user", "action", `${flow.number}. ${step.title}`, { flow: flow.title, step: step.id, backend: c.backend, actor: step.actor, inputs }, async s => {
    const n = await step.run(c, inputs);
    const failed = c.checks.filter(k => !k.ok).length;
    s.end(failed ? "error" : "ok", { checks_passed: c.checks.length - failed, checks_failed: failed });
    return n;
  }, { session: c.session, trace: randomBytes(16).toString("hex") })));
  flushTraces();
  return c.endStep(narrative ?? undefined);
}

export const defaultsFor = (c: Ctx, flow: Flow, stepId: string) => {
  const step = flow.steps.find(s => s.id === stepId)!;
  const out: Record<string, any> = {};
  for (const i of step.inputs?.(c) ?? []) out[i.id] = i.default;
  return out;
};
