// A store-backed backend: Part 10 objects plus a manifest. Files and MinIO differ only in
// how an object is read.
import { join } from "node:path";
import type { PlanItem } from "../accept";
import { isStandard } from "../syntax";
import { BackendError, type Backend, type Capabilities, type InstancePart, type PartStream, type Scope } from "./types";

export interface ObjectSource {
  name: string;
  read(key: string): AsyncIterable<Uint8Array>;
  readRange(key: string, start: number, length: number): AsyncIterable<Uint8Array>;
  text(key: string): Promise<string>;
}

/** Spec flowchart: walk the plan by weight, for each instance. */
export function chooseRepresentation(inst: any, plan: PlanItem[]): any | undefined {
  const reps: any[] = inst.representations;
  for (const item of plan) {
    if (item.syntax === "*") {
      const stored = reps.find(r => r.stored);
      if (stored && isStandard(stored.syntax)) return stored;
      // Private syntaxes are returned only when listed. Offer a standard one instead.
      const standard = reps.find(r => isStandard(r.syntax));
      if (standard) return standard;
      continue;
    }
    const match = reps.find(r => r.syntax === item.syntax);
    if (match) return match;
  }
  return undefined;
}

export class StoreBackend implements Backend {
  private byUid = new Map<string, any>();
  constructor(private manifest: any, private source: ObjectSource) {
    for (const s of manifest.studies) this.byUid.set(s.uid, s);
  }
  capabilities(): Capabilities {
    return {
      name: this.source.name, selection: "per-instance", hasManifest: true, enforcesHierarchy: true,
      notes: ["Serves stored representations only: no runtime transcoding.", "The first instance of the left wrist study carries a synthetic private syntax label."],
    };
  }
  private select(scope: Scope): any[] {
    const study = this.byUid.get(scope.study);
    if (!study) throw new BackendError("NotFound");
    let series: any[] = study.series;
    if (scope.onlySeries) series = series.filter(s => scope.onlySeries!.includes(s.uid));
    if (scope.series) { series = series.filter(s => s.uid === scope.series); if (!series.length) throw new BackendError("NotFound"); }
    const out: any[] = [];
    for (const s of series) for (const i of s.instances) {
      if (scope.instance && i.uid !== scope.instance) continue;
      out.push({ series: s, inst: i });
    }
    if (scope.instance && !out.length) throw new BackendError("NotFound");
    return out;
  }
  async listSeries(study: string) {
    const s = this.byUid.get(study);
    if (!s) throw new BackendError("NotFound");
    return s.series.map((x: any) => x.uid);
  }
  async openInstances(scope: Scope, plan: PlanItem[]): Promise<PartStream> {
    const items = this.select(scope);
    // Preflight, so a 406 can be sent before any data. The spec leaves mixed results open;
    // this demo refuses the whole request, and the app can then ask for smaller resources.
    const chosen = items.map(({ inst }) => ({ inst, rep: chooseRepresentation(inst, plan) }));
    if (chosen.some(c => !c.rep)) throw new BackendError("NotAcceptable", "an instance has no representation in an accepted transfer syntax");
    const source = this.source;
    async function* gen(): AsyncGenerator<InstancePart, "complete" | "truncated"> {
      for (const c of chosen) yield { syntax: c.rep.syntax, sop: c.inst.uid, body: source.read(c.rep.key) };
      return "complete";
    }
    return { parts: gen() };
  }
  async getMetadata(scope: Scope) {
    const items = this.select(scope);
    const out: any[] = [];
    for (const { series, inst } of items) {
      const d = JSON.parse(await this.source.text(`${scope.study}/${series.uid}/${inst.uid}.json`));
      out.push({ ...d, __path: { series: series.uid, instance: inst.uid } });
    }
    return out;
  }
  async openBulk(study: string, series: string, instance: string, ref: string) {
    const [{ inst }] = this.select({ study, series, instance });
    const element = inst.bulk?.[ref.toUpperCase()];
    if (!element) throw new BackendError("NotFound");
    // Offsets refer to the file as ingested, not to any added representation.
    const rep = inst.representations.find((r: any) => r.key.endsWith(`/${inst.uid}.dcm`));
    return { contentType: "application/octet-stream", body: this.source.readRange(rep.key, element.offset, element.length) };
  }
}

export function fileSource(dir: string): ObjectSource {
  return {
    name: "static-files",
    read: key => Bun.file(join(dir, key)).stream() as any,
    readRange: (key, start, length) => Bun.file(join(dir, key)).slice(start, start + length).stream() as any,
    text: key => Bun.file(join(dir, key)).text(),
  };
}

export function s3Source(client: any, ): ObjectSource {
  return {
    name: "minio",
    read: key => client.file(key).stream(),
    readRange: (key, start, length) => client.file(key).slice(start, start + length).stream(),
    text: key => client.file(key).text(),
  };
}

/** A backend that stops after a number of parts. Used by the truncated upstream flow. */
export function withTruncation(inner: Backend, afterParts: () => number | undefined): Backend {
  return new Proxy(inner, {
    get(target, prop, recv) {
      if (prop !== "openInstances") return Reflect.get(target, prop, recv);
      return async (scope: Scope, plan: PlanItem[]) => {
        const stream = await target.openInstances(scope, plan);
        const limit = afterParts();
        if (limit === undefined) return stream;
        async function* gen(): AsyncGenerator<InstancePart, "complete" | "truncated"> {
          let n = 0;
          for await (const p of stream.parts) { if (n++ >= limit!) return "truncated"; yield p; }
          return "truncated";
        }
        return { parts: gen() };
      };
    },
  });
}
