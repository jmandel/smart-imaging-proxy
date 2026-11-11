import { afterAll, beforeAll } from "bun:test";
import { backendSelected, defineBackendFlows, startFlowSuite, type FlowSuite } from "./flows.cases";

if (backendSelected("orthanc")) {
  const ctx: Partial<FlowSuite> = {};
  beforeAll(async () => { Object.assign(ctx, await startFlowSuite()); });
  afterAll(() => ctx.stack?.stop());
  defineBackendFlows(ctx, "orthanc");
}
