import { policyFlows } from "./policy-flows";
import { protocolFlows } from "./protocol-flows";
import { Ctx, type Flow, type StepResult } from "./runtime";
import type { Stack } from "../stack";
import type { World } from "../world";
import type { BackendClient } from "../auth-server";
import { randomBytes } from "node:crypto";
import { flushTraces, inScope, runInSession, sessionKey, withSpan } from "../trace";

export const FLOWS: Flow[] = [...policyFlows, ...protocolFlows];
export const flowById = (id: string) => FLOWS.find(f => f.id === id);

/** The demo's Backend Services clients, which every world has registered with the same keys. */
export function registerClients(stack: Stack): Record<string, BackendClient> { return stack.root.clients; }

/** Starts a flow in a new scope of its own, seeded from the guardians on file. */
export function startFlow(stack: Stack, clients: Record<string, BackendClient>, flow: Flow): Promise<Ctx> {
  return startFlowIn(stack.scopes.mint(), clients, flow);
}
/** Starts a flow in `world`, which is a fresh scope. */
export async function startFlowIn(world: World, clients: Record<string, BackendClient>, flow: Flow): Promise<Ctx> {
  const session = sessionKey(world.scope, `flow-${flow.number}-${flow.id}-${randomBytes(3).toString("hex")}`);
  const c = new Ctx(world, clients);
  c.session = session;
  // Setup makes policy API calls, which belong to the flow's session.
  await inScope(world.scope, () => runInSession(session, () => withSpan("demo", "action", `${flow.number}. Start in a new scope`, { flow: flow.title, scope: world.scope }, async () => { await flow.setup?.(c); })));
  flushTraces();
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
  const narrative = await runInSessionNoted(c, () => inScope(c.world.scope, () => runInSession(c.session, () => withSpan("user", "action", `${flow.number}. ${step.title}`, { flow: flow.title, step: step.id, backend: c.backend, actor: step.actor, inputs }, async s => {
    const n = await step.run(c, inputs);
    const failed = c.checks.filter(k => !k.ok).length;
    s.end(failed ? "error" : "ok", { checks_passed: c.checks.length - failed, checks_failed: failed });
    return n;
  }, { session: c.session, trace: randomBytes(16).toString("hex"), ...(c.world.scope ? { scope: c.world.scope } : {}) }))));
  flushTraces();
  return c.endStep(narrative ?? undefined);
}

export const defaultsFor = (c: Ctx, flow: Flow, stepId: string) => {
  const step = flow.steps.find(s => s.id === stepId)!;
  const out: Record<string, any> = {};
  for (const i of step.inputs?.(c) ?? []) out[i.id] = i.default;
  return out;
};
