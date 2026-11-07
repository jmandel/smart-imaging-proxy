// What core reports as it works, and how it makes outbound requests. An embedder plugs in its own
// tracing; the default records nothing. Each service instance takes its own, so two side by side
// share an observer only when given the same one.

/** The services core's spans are credited to. */
export type CoreService = "imaging-fhir" | "policy" | "dicomweb-proxy" | "backend";
export type SpanKind = "server" | "client" | "internal" | "check";
export type SpanStatus = "ok" | "error" | "denied";
export type Attrs = Record<string, unknown>;

export interface Span {
  set(attrs: Attrs): void;
  /** Ends the span. A second call does nothing. */
  end(status?: SpanStatus, attrs?: Attrs): void;
  /** Runs `fn` as part of this span, for work a stream does after its handler returned. */
  within<T>(fn: () => T): T;
}
export interface ServerSpan extends Span {
  /** The response streams, and the handler ends this span itself once the stream finishes. */
  streaming(): void;
  /** Credits the span to another service, for routes one server answers on behalf of another. */
  creditTo(service: CoreService): void;
}

export interface Observer {
  /** Wraps an HTTP handler, giving each request a server span. */
  serve(service: CoreService, handler: (req: Request, span: ServerSpan) => Promise<Response> | Response): (req: Request) => Promise<Response>;
  span(service: CoreService, kind: SpanKind, name: string, attrs?: Attrs): Span;
  /** Runs `fn` in a new span, ending it when `fn` settles. */
  withSpan<T>(service: CoreService, kind: SpanKind, name: string, attrs: Attrs, fn: (span: Span) => Promise<T> | T): Promise<T>;
  /** A point-in-time check with its outcome. Returns `ok`. */
  check(service: CoreService, name: string, ok: boolean, attrs?: Attrs): boolean;
  /** An outbound request. Redirects aren't followed unless `init.redirect` says so. */
  fetch(service: CoreService, name: string, url: string, init?: RequestInit & { headers?: Record<string, string> }, attrs?: Attrs): Promise<Response>;
}

const quietSpan: ServerSpan = { set() {}, end() {}, within: fn => fn(), streaming() {}, creditTo() {} };

/** Records nothing, and fetches with the platform's fetch. */
export const noopObserver: Observer = {
  serve: (_service, handler) => async req => handler(req, quietSpan),
  span: () => quietSpan,
  withSpan: async (_service, _kind, _name, _attrs, fn) => fn(quietSpan),
  check: (_service, _name, ok) => ok,
  fetch: (_service, _name, url, init = {}) => fetch(url, { ...init, redirect: init.redirect ?? "manual" }),
};
