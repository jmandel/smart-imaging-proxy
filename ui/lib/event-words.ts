// Recorded events in words, for the log: each kind's one-line summary and the fields that matter, the values
// events share, and the pieces of a raw exchange worth decoding. People and services are named from the sandbox's
// cast, so the words come from `wordsFor(names)`.
import { bytes, plural } from "./format";

/** An event as the log lists it: the study it names, by id, and how long its exchange took, added by the server. */
export interface LogEvent {
  seq: number; session: string; trace: string; span?: string; sandbox?: string; service: string; at: number;
  kind: string; outcome: "ok" | "denied" | "error" | "info"; who?: string; links: string[]; data: Record<string, any>;
  study?: string; ms?: number;
}
/** Display names, by reference: `user:josh`, `client:…`, `patient:…`, `app:…`. */
export type Names = Record<string, string>;
/** A field's value: words, or a list of studies, which is never joined into one line. */
export type FieldValue = string | string[];

export const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
export const SERVICE: Record<string, string> = { "authorization-server": "Authorization Server", "imaging-fhir": "Imaging Server", policy: "Imaging Server, policy", "dicomweb-proxy": "Proxy", app: "The app", demo: "Demo", user: "Browser" };
export const LEVEL_WORDS: Record<string, string> = { fact: "A fact", policy: "Organization policy", choice: "A person's choice", settings: "Settings", document: "The whole document", reset: "A reset" };
const LINK_WORDS: Record<string, string> = { token: "token", context: "link", study: "study", uid: "study UID", patient: "patient", user: "person", client: "service" };

// The proxy's fast-path checks, by name, as what went wrong when one fails.
const LINK_FAILED: Record<string, string> = {
  "URL carries a signed context": "the request carries no signed link",
  "signature verifies": "its signature doesn't verify",
  "context isn't marked restricted": "it's marked restricted",
  "context hasn't expired": "it has expired",
  "requested study is in the context": "it doesn't cover this study",
  "token hash matches ath": "it was made for another token",
  "requested series is released": "it doesn't release this series",
  "study version is understood": "it names a study version the proxy doesn't know",
};
const linkFailed = (f: unknown) => { const k = String(f ?? "").replace(/^fast path: /, ""); return LINK_FAILED[k] ?? (k || "it didn't cover the request"); };
const sitesOf = (sites: unknown) => Array.isArray(sites) ? (sites.length ? sites.join(", ") : "no sites") : undefined;

export interface Written { who?: string; what: string; sites?: string }
export interface Described { summary: string; fields: [string, FieldValue][] }
export interface SharedValue { link: string; kind: string; words: string; title: string }

/** The words for events, naming people and services from `names`. */
export function wordsFor(names: Names) {
  const nameOf = (who: string | undefined) => { if (!who) return ""; const id = who.slice(who.indexOf(":") + 1); return names[who] ?? names[id] ?? id; };

  /** A policy write in words: who did what, and at which sites. */
  function written(d: Record<string, any>): Written {
    const b = d.body ?? {}, q = d.query ?? {}, op: string = d.operation ?? "";
    const whose = (p?: string) => p ? `${nameOf(p)}'s records` : "records";
    if (op === "POST /shares") return { who: nameOf(b.from), what: `${nameOf(b.from)} shares ${whose(b.patient)} with ${nameOf(b.with)}${b.label ? `, as ${b.label}` : ""}`, sites: sitesOf(b.sites) };
    if (op === "DELETE /shares") return { who: q.from ? nameOf(q.from) : undefined, what: `${q.from ? nameOf(q.from) : "Everyone"} stops sharing ${q.patient ? `${whose(q.patient)} ` : ""}with ${nameOf(q.with)}` };
    if (op === "POST /app-approvals") return { who: nameOf(b.by), what: `${nameOf(b.by)} approves ${nameOf(b.app)} for ${whose(b.patient)}`, sites: b.sites ? sitesOf(b.sites) : "Every site, or the sites chosen before" };
    if (op === "DELETE /app-approvals") return { who: nameOf(q.by), what: `${nameOf(q.by)} revokes ${nameOf(q.app)}${q.patient ? ` for ${whose(q.patient)}` : ""}` };
    if (op === "PUT /relationships") return { what: `Recorded: ${nameOf(b.subject)} ${String(b.relation ?? "").replaceAll("_", " ")} ${nameOf(b.object)}` };
    if (op === "DELETE /relationships") return { what: `Removed: ${nameOf(q.subject)} ${String(q.relation ?? "").replaceAll("_", " ")} ${nameOf(q.object)}` };
    if (op.startsWith("PUT /policies")) return { what: Array.isArray(b) ? `Organization policies of type ${q.type ?? "?"} set: ${b.map((x: any) => x.id).join(", ") || "none"}` : `Organization policy ${b.id ?? op.slice("PUT /policies/".length)} set`, sites: sitesOf(b.allow?.sites) };
    if (op.startsWith("DELETE /policies/")) return { what: `Organization policy ${op.slice("DELETE /policies/".length)} removed` };
    if (op === "PATCH /settings") return { what: `Settings changed: ${Object.keys(b).join(", ")}` };
    if (op === "POST /reset") return { what: b.tokens ? "Policy reset, with tokens" : "Policy reset" };
    if (op === "PUT /document") return { what: `Policy document written: ${Object.keys(b).join(", ")}` };
    return { what: `Policy written: ${op}` };
  }

  /** Each kind's summary and fields, before empty ones are left out. */
  const KINDS: Record<string, (e: LogEvent) => { summary: string; fields: [string, unknown][] }> = {
    "token.issued": ({ data: d }) => ({ summary: `Token issued${d.user ? ` to ${nameOf(`user:${d.user}`)}` : ` to ${nameOf(`client:${d.client}`)}`}${d.patient ? `, for ${nameOf(`patient:${d.patient}`)}` : ""}`,
      fields: [["How", d.grant?.replaceAll("_", " ")], ["Client", d.client], ["Scope", d.scope], ["Lasts", d.expiresIn && `${Math.round(d.expiresIn / 60)} minutes`], ["Token", d.tokenHash && `sha256:${d.tokenHash}…`]] }),
    "referral.checked": ({ data: d }) => ({ summary: d.ok ? "The referral's patient is on the FHIR server the service may use" : "The referral's patient isn't on the FHIR server the service may use",
      fields: [["Patient", d.reference], ["Authorized for", d.authorizedBase], ["Accession", d.accession && `${d.system}|${d.accession}`]] }),
    "search.returned": ({ data: d }) => d.status === 200
      ? { summary: `Search returned ${plural(d.total ?? 0, "study", "studies")}${d.withheld?.length ? `, with ${d.withheld.length} withheld` : ""}`,
          fields: [["Query", d.query], ["Found", d.found ?? []], ...((d.withheld ?? []) as { study: string; why: string }[]).map((w): [string, unknown] => [`Withheld ${w.study}`, w.why])] }
      : { summary: `Search answered ${d.status}`, fields: [["Why", d.reason], ["Query", d.query]] },
    "context.signed": ({ data: d }) => ({ summary: `Signed link made for ${d.study}`, fields: [["Form", d.form], ["Series listed", d.series], ["Expires", d.exp && new Date(d.exp * 1000).toLocaleTimeString()], ["Key", d.kid]] }),
    "decision.answered": ({ data: d }) => ({ summary: `The Imaging Server ${d.decision ? "allowed" : "refused"} ${d.study ?? d.studyUid ?? "the request"}`,
      fields: [["Why", d.why], ["Release", typeof d.response?.context?.release === "object" ? `${d.response.context.release.series.length} series` : d.response?.context?.release], ["Denial", d.response?.context?.denial], ["Good for", d.response?.context?.max_age_seconds !== undefined && `${d.response.context.max_age_seconds} s`]] }),
    "proxy.fast-path": ({ data: d }) => ({ summary: d.taken ? "The proxy checked the signed link, with no network call" : `The signed link wasn't enough (${linkFailed(d.failed)}), so the proxy asks the Imaging Server`, fields: [["Study", d.studyUid], ["Check that failed", d.failed]] }),
    "proxy.decision": ({ data: d }) => ({ summary: `The proxy ${d.via === "cached" ? "used a cached decision" : "asked the Imaging Server"}: ${d.unavailable ? "no answer" : d.allowed ? "allowed" : "refused"}`, fields: [["Denial", d.denial], ["Study", d.studyUid]] }),
    "stream.done": ({ data: d }) => ({ summary: `${bytes(d.bytes)} sent to the app${d.complete ? "" : ", cut off before the end"}`,
      fields: [["What", d.resource], ["Parts", d.parts], ["Encoding", d.encoding], ["Decided", d.authz], ["Syntaxes", (d.syntaxes ?? []).join(", ")], ["Note", d.note]] }),
    "retrieval.answered": ({ data: d }) => ({ summary: d.status >= 400 ? `Retrieval refused (HTTP ${d.status})` : `Retrieval answered HTTP ${d.status}`, fields: [["What", d.resource], ["Decided", d.authz], ["Denial", d.denial], ["Note", d.note]] }),
    "policy.written": ({ data: d }) => { const w = written(d); return { summary: `${d.status < 300 ? "" : "Refused: "}${w.what}`, fields: [["Who", w.who], ["Sites", w.sites], ["Patient", d.patient && nameOf(`patient:${d.patient}`)], ["Level", LEVEL_WORDS[d.level] ?? d.level], ["Why", d.error], ["Call", d.operation]] }; },
  };

  /** An event's summary and its readable fields, with empty ones left out. */
  function describe(e: LogEvent): Described {
    const k = (KINDS[e.kind] ?? (x => ({ summary: x.kind, fields: Object.entries(x.data).map(([a, b]): [string, unknown] => [a, typeof b === "object" ? JSON.stringify(b) : b]) })))(e);
    return { summary: k.summary, fields: k.fields.filter(([, v]) => v !== undefined && v !== null && v !== false && v !== "").map(([a, v]) => [a, Array.isArray(v) ? v.map(String) : String(v)]) };
  }

  /** The values an event shares with others: a search's found list stays in its fields. */
  function linksOf(e: LogEvent): SharedValue[] {
    const studies = e.links.filter(l => l.startsWith("study:"));
    return e.links.filter(l => !l.startsWith("uid:") && (studies.length < 2 || !l.startsWith("study:"))).map(l => {
      const kind = l.slice(0, l.indexOf(":")), v = l.slice(l.indexOf(":") + 1), word = LINK_WORDS[kind] ?? kind;
      return { link: l, kind, words: `${word} ${kind === "user" || kind === "client" ? nameOf(l) : v}`, title: `Every event with this ${word}` };
    });
  }

  return { nameOf, written, describe, linksOf };
}
export type EventWords = ReturnType<typeof wordsFor>;

// Decoding a raw exchange: JWTs and signed contexts. Secrets arrive as hashes already.
const b64json = (part: string) => { try { return JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/"))); } catch { return undefined; } };
/** A JWT's header and claims, if `v` is one. */
export function jwt(v: string): { header: unknown; claims: unknown } | undefined {
  const [h, p] = String(v).split(".");
  const header = b64json(h ?? ""), claims = b64json(p ?? "");
  return header && claims ? { header, claims } : undefined;
}
/** The part headers a captured multipart body holds, as far as the capture reaches. */
export function multipartHeaders(hex: string, contentType: string): string[] | undefined {
  const boundary = contentType.match(/boundary="?([^";]+)"?/)?.[1];
  if (!boundary) return undefined;
  const text = (hex.match(/../g) ?? []).map(h => String.fromCharCode(parseInt(h, 16))).join("");
  return text.split(`--${boundary}`).slice(1).filter(p => !p.startsWith("--")).map(p => p.split("\r\n\r\n")[0]!.trim()).filter(Boolean);
}
