import { afterAll, beforeAll } from "bun:test";
import { backendSelected, defineBackendFlows, defineRedirectAndChoiceFlows, startFlowSuite, type FlowSuite } from "./flows.cases";

const ctx: Partial<FlowSuite> = {};
beforeAll(async () => { Object.assign(ctx, await startFlowSuite()); });
afterAll(() => ctx.stack?.stop());

if (backendSelected("static-files")) defineBackendFlows(ctx, "static-files");
defineRedirectAndChoiceFlows(ctx);
