// Search through the catalog against responses captured from the code before it. Additions are
// allowed, and removed here: `ver` in a signed context, `version` in a decision. Entry order is
// compared by what's in it, because results are now newest first, which has its own test. Anything
// else that differs fails, and should be reported rather than recaptured.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { startStack, type BackendName, type Stack } from "../src/stack";
import { registerClients } from "../src/flows";
import { runScenarios } from "./golden/scenarios";

const golden = await Bun.file(join(import.meta.dir, "golden/search.json")).json();
const ids = (e: any) => e.fullUrl;

/** `anyOrder` is for a catalog whose source doesn't keep the archive's series and instance order. */
function canonical(value: any, anyOrder: boolean): any {
  const v = structuredClone(value);
  for (const d of v?.decisions ?? []) {
    delete d.context.version;
    if (anyOrder && d.context.release?.series) d.context.release.series.sort();
  }
  const b = v?.body;
  if (b?.resourceType === "Bundle") {
    b.entry = [...b.entry].sort((x: any, y: any) => (ids(x) < ids(y) ? -1 : 1));
    for (const e of b.entry) {
      if (e.context) { delete e.context.ver; if (anyOrder) e.context.series?.sort(); }
      if (anyOrder && e.resource.series) {
        e.resource.series.sort((x: any, y: any) => (x.uid < y.uid ? -1 : 1));
        for (const s of e.resource.series) delete s.instances;
      }
    }
  }
  return v;
}

let stack: Stack; let clients: any;
const runs: Partial<Record<BackendName, any>> = {};
beforeAll(async () => { stack = await startStack(join(import.meta.dir, "..")); clients = registerClients(stack); });
afterAll(() => stack.stop());

for (const [backend, anyOrder] of [["static-files", false], ["orthanc", true]] as [BackendName, boolean][]) {
  describe(`golden search, reading the ${backend} backend's catalog`, () => {
    beforeAll(async () => { stack.setBackend(backend); runs[backend] = await runScenarios(stack, clients); }, 120000);
    for (const name of Object.keys(golden)) {
      test(name, () => {
        expect(canonical(runs[backend][name], anyOrder)).toEqual(canonical(golden[name], anyOrder));
      });
    }
    test("no scenario appeared or disappeared", () => {
      expect(Object.keys(runs[backend]).sort()).toEqual(Object.keys(golden).sort());
    });
    test("the additions are there: ver in a context, version in a decision, and newest first", () => {
      const all = runs[backend]["josh: all, with _include"].body;
      for (const e of all.entry) if (e.context) expect(e.context.ver).toBe(1);
      expect(runs[backend]["can_i: allowed"].decisions[0].context.version).toBe(1);
      const dates = all.entry.filter((e: any) => e.resource.resourceType === "ImagingStudy").map((e: any) => e.resource.started);
      expect(dates).toEqual([...dates].sort().reverse());
      expect(all.link.some((l: any) => l.relation === "next")).toBe(false);
    });
  });
}
