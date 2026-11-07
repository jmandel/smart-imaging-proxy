// What core's tests use in place of an embedder: a clock they move by hand, an observer that records
// what it's told, and small catalog fixtures.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { publicationFor, type Attrs, type CatalogStore, type Clock, type CoreService, type Observer, type ServerSpan, type SpanKind, type SpanStatus, type StudyDocument, type StudyHierarchy } from "../src";

export function manualClock(start = Math.floor(Date.now() / 1000)): Clock & { advance(seconds: number): void; set(seconds: number): void; reset(): void } {
  let t = start;
  return { now: () => t, advance(seconds) { t += seconds; }, set(seconds) { t = seconds; }, reset() { t = start; } };
}

export interface Recorded { id: string; parent?: string; service: CoreService; kind: SpanKind; name: string; attrs: Attrs; status?: SpanStatus; start: number; end?: number; }

/** Records every span, with its parent taken from the span the work runs in. */
export function recordingObserver() {
  const spans: Recorded[] = [];
  const als = new AsyncLocalStorage<string>();
  const begin = (service: CoreService, kind: SpanKind, name: string, attrs: Attrs = {}) => {
    const r: Recorded = { id: randomUUID(), parent: als.getStore(), service, kind, name, attrs: { ...attrs }, start: performance.now() };
    spans.push(r);
    let streaming = false;
    const span: ServerSpan = {
      set: a => { Object.assign(r.attrs, a); },
      end: (status = "ok", a) => { if (r.end !== undefined) return; r.end = performance.now(); r.status = status; if (a) Object.assign(r.attrs, a); },
      within: fn => als.run(r.id, fn),
      streaming: () => { streaming = true; },
      creditTo: s => { r.service = s; },
    };
    return { r, span, isStreaming: () => streaming };
  };
  const observer: Observer = {
    serve: (service, handler) => async req => {
      const { span, isStreaming } = begin(service, "server", `${req.method} ${new URL(req.url).pathname}`);
      const res = await span.within(() => handler(req, span));
      if (!isStreaming()) span.end(res.status >= 500 ? "error" : res.status >= 400 ? "denied" : "ok", { status: res.status });
      return res;
    },
    span: (service, kind, name, attrs) => begin(service, kind, name, attrs).span,
    withSpan: async (service, kind, name, attrs, fn) => {
      const { span } = begin(service, kind, name, attrs);
      try { const out = await span.within(() => fn(span)); span.end("ok"); return out; } catch (e) { span.end("error"); throw e; }
    },
    check: (service, name, ok, attrs) => { begin(service, "check", name, attrs).span.end(ok ? "ok" : "denied"); return ok; },
    fetch: async (service, name, url, init = {}, attrs) => {
      const { span } = begin(service, "client", name, { url, ...attrs });
      try { const res = await fetch(url, { ...init, redirect: init.redirect ?? "manual" }); span.end(res.status >= 400 ? "denied" : "ok", { status: res.status }); return res; }
      catch (e) { span.end("error"); throw e; }
    },
  };
  return { observer, spans, named: (name: string) => spans.filter(s => s.name === name) };
}

export const hierarchyOf = (uid: string, modality = "CT", instances = 2): StudyHierarchy => ({
  series: [{ uid: `${uid}.1`, number: 1, modality, description: "first", instances: Array.from({ length: instances }, (_, i) => ({ uid: `${uid}.1.${i}`, number: i + 1, sopClass: "1.2.840.10008.5.1.4.1.1.2" })) }],
});
export function documentOf(uid: string, o: Partial<StudyDocument> = {}, modality = "CT"): StudyDocument {
  return { format: 1, uid, id: `study-${uid}`, version: 1, date: "20200101", accession: `ACC${uid}`, sourcePatientId: "MRN1", site: "Site A", series: [{ uid: `${uid}.1`, number: 1, modality, instanceCount: 2 }], ...o };
}
export const put = (c: CatalogStore, uid: string, o: Partial<StudyDocument> = {}, patient = "p1", modality = "CT") => c.publish(publicationFor(documentOf(uid, o, modality), patient, hierarchyOf(uid, modality), c.accessionSystem));
