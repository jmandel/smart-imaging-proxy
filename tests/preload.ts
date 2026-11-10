// Loaded before every test file (bunfig.toml). Every startStack builds Orthanc's catalog from QIDO-RS, about 55
// queries that take Orthanc about a second, and Orthanc's studies don't change while tests run. So the first build
// a process makes for a stack runs for real, and records what it published; a later stack's build publishes the
// same records into its own new, empty catalog, after checking each study still resolves to the same patient there.
// Only builds startStack makes are reused: one a test makes itself always queries Orthanc. Set
// ORTHANC_CATALOG_EACH_TIME=1 to query Orthanc for every stack as well.
import { mock } from "bun:test";
import * as core from "@smart-imaging-proxy/core";
import type { CatalogStore } from "@smart-imaging-proxy/core";

type Build = typeof core.catalogFromOrthanc;
interface Recorded { lookups: [string, string, string | undefined][]; publications: unknown[]; report: Awaited<ReturnType<Build>> }
const real = core.catalogFromOrthanc;
const builds = new Map<string, Recorded>();
const forStack = () => !process.env.ORTHANC_CATALOG_EACH_TIME && /\bopenCatalogs\b/.test(new Error().stack ?? "");

const catalogFromOrthanc: Build = async (catalog, orthanc, config) => {
  if (!forStack()) return real(catalog, orthanc, config);
  const key = JSON.stringify([orthanc.base, orthanc.user, config]);
  const done = builds.get(key);
  if (done && done.lookups.every(([source, id, patient]) => catalog.patientFor(source as any, id) === patient)) {
    for (const p of done.publications) catalog.publish(structuredClone(p) as any);
    return structuredClone(done.report);
  }
  const rec: Recorded = { lookups: [], publications: [], report: { published: [], unlinked: [] } };
  const recording = new Proxy(catalog, {
    get(target, prop) {
      if (prop === "patientFor") return (source: any, id: string) => { const p = target.patientFor(source, id); rec.lookups.push([source, id, p]); return p; };
      if (prop === "publish") return (p: any) => { rec.publications.push(structuredClone(p)); return target.publish(p); };
      const v = (target as any)[prop];
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as CatalogStore;
  rec.report = await real(recording, orthanc, config);
  builds.set(key, structuredClone(rec));
  return rec.report;
};

mock.module("@smart-imaging-proxy/core", () => ({ ...core, catalogFromOrthanc }));
