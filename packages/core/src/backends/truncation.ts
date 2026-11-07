import type { PlanItem } from "../accept";
import type { Backend, InstancePart, OpenOptions, Scope } from "./types";

/** A backend that stops after a number of parts, for showing what a client sees of a truncated upstream. */
export function withTruncation(inner: Backend, afterParts: () => number | undefined): Backend {
  return new Proxy(inner, {
    get(target, prop, recv) {
      if (prop !== "openInstances") return Reflect.get(target, prop, recv);
      return async (scope: Scope, plan: PlanItem[], options?: OpenOptions) => {
        const stream = await target.openInstances(scope, plan, options);
        const limit = afterParts();
        if (limit === undefined) return stream;
        async function* gen(): AsyncGenerator<InstancePart, "complete" | "truncated"> {
          let n = 0;
          for await (const p of stream.parts) { if (n++ >= limit!) return "truncated"; yield p; }
          return "truncated";
        }
        // The plan stays what was promised, so a client sees a short response, not a short promise.
        return { parts: gen(), plan: stream.plan };
      };
    },
  });
}
