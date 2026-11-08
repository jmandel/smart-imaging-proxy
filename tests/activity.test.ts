import { describe, expect, test } from "bun:test";
import { sessionStudies } from "../src/activity";
import type { EventRecord } from "../src/trace";

let seq = 0;
const ev = (kind: string, data: Record<string, unknown>, outcome = "ok") => ({ seq: ++seq, at: seq, session: "s", trace: "t", service: "x", kind, outcome, data, links: [] }) as unknown as EventRecord;
const search = (found: string[], extra: Record<string, unknown> = {}) => ev("search.returned", { status: 200, query: "patient=josh-example", found, withheld: [], unreached: [], ...extra });
const write = (level = "choice") => ev("policy.written", { status: 200, level, operation: "DELETE /shares" });
const idOfUid = () => undefined;

describe("a session, study by study", () => {
  test("a policy write after the session touched a study starts a phase, and each stage keeps its outcomes in order", () => {
    const f = sessionStudies([
      write(), ev("token.issued", { client: "app" }),
      // Links are recorded before the search that made them.
      ev("context.signed", { study: "a" }), ev("context.signed", { study: "b" }), search(["a", "b"]),
      ev("proxy.fast-path", { study: "a", taken: true }), ev("stream.done", { study: "a", status: 200, complete: true, parts: 3, bytes: 900 }),
      write(),
      search([], { unreached: [{ study: "a" }, { study: "b" }] }),
      ev("proxy.fast-path", { study: "a", taken: true }), ev("stream.done", { study: "a", status: 200, complete: true, parts: 3, bytes: 900 }),
      ev("proxy.decision", { study: "a", via: "asked", allowed: false }, "denied"), ev("retrieval.answered", { study: "a", status: 404 }, "denied"),
    ], idOfUid);
    expect(f.other).toMatchObject({ tokens: 1, writes: { choice: 2 } });
    expect(f.phases.map(p => p.writes.length)).toEqual([0, 1]);
    const [before, after] = f.phases.map(p => Object.fromEntries(p.studies.map(r => [r.study, r])));
    expect(before!.a).toMatchObject({ search: [{ is: "found", n: 1 }], links: 1, check: [{ is: "instant", n: 1 }], get: [{ is: "sent", n: 1, bytes: 900 }], end: "sent" });
    expect(before!.b).toMatchObject({ links: 1, end: "linked" });
    expect(after!.a).toMatchObject({ search: [{ is: "gone", n: 1 }], check: [{ is: "instant", n: 1 }, { is: "refused", n: 1 }], get: [{ is: "sent", n: 1 }, { is: "refused", n: 1 }], end: "refused" });
    // Where each study stood when the session ended: a later search no longer found b.
    expect(after!.b).toMatchObject({ search: [{ is: "gone", n: 1 }], end: "gone" });
    expect(f.ends.sort()).toEqual(["gone", "refused"]);
  });
  test("a study withheld after it was found says so, and a search of another patient says nothing of it", () => {
    const f = sessionStudies([
      search(["a"]), ev("context.signed", { study: "a" }),
      ev("search.returned", { status: 200, query: "patient=riley-example", found: ["r"], withheld: [], unreached: [] }),
      search([], { withheld: [{ study: "a" }] }),
    ], idOfUid);
    const a = f.phases[0]!.studies.find(r => r.study === "a")!;
    expect(a.search).toEqual([{ is: "found", n: 1 }, { is: "withheld", n: 1 }]);
    expect(f.phases[0]!.studies.find(r => r.study === "r")!.search).toEqual([{ is: "found", n: 1 }]);
  });
});
