// The inline preview of one span in the live trace: how each kind of event reads. An HTTP call is recognized by its
// path, and shows what matters about that kind of call; a span with no HTTP shows its own fields.
import { Fragment, useMemo, type ReactNode } from "react";
import {
  contextOf, decodeJwt, displayPath, fmtBytes, fmtEpoch, fmtMs, fullHref, hexDump, logHref, pageTexts, pageValues, parseForm,
  parseJson, parsePage, pretty, queryText, shortUid, shortUids, urlOf, yesNo, type Http, type Jwt, type Message, type Span,
} from "./model";

type Row = [string, unknown];
const isBlank = (v: unknown) => v === undefined || v === null || v === "" || (typeof v === "object" && !Object.keys(v as object).length);
const present = (n: ReactNode) => n !== null && n !== undefined && n !== false && n !== "";

/** Name and value pairs, leaving out what wasn't recorded. Nothing at all when none was. */
function kv(rows: Row[]): ReactNode {
  const shown = rows.filter(([, v]) => !isBlank(v));
  if (!shown.length) return null;
  return <dl className="kv">{shown.map(([k, v], i) => <KvPair key={i} k={k} v={typeof v === "object" ? JSON.stringify(v) : String(v)} />)}</dl>;
}
const KvPair = ({ k, v }: { k: string; v: string }) => <><dt>{k}</dt><dd>{v}</dd></>;
/** A titled part of a preview, shown only when it has something in it. */
function section(title: string, ...body: ReactNode[]): ReactNode {
  if (!body.some(present)) return null;
  return <section className="pv"><h4>{title}</h4>{body.map((b, i) => <Fragment key={i}>{b}</Fragment>)}</section>;
}
const muted = (text: string) => <p className="muted">{text}</p>;

const urlFrom = (location: string | undefined, base: string) => { try { return location ? new URL(location, base) : undefined; } catch { return undefined; } };
const redirectOf = (h: Http) => urlFrom(h.response?.headers?.location, h.url);
const whereTo = (back: URL | undefined, u: URL) => back && (back.origin === u.origin ? back.pathname : back.origin + back.pathname);
const sitesChosen = (form: URLSearchParams | undefined) => form?.get("sites_shown") ? form.getAll("sites").join(", ") || "none" : undefined;

const describeContext = (c: Record<string, any> | undefined) => c ? (c.restricted ? "restricted: every retrieval asks the Imaging Server" : c.series ? `${c.series.length} series listed` : "whole study") : undefined;
const SYNTAXES: Record<string, string> = {
  "1.2.840.10008.1.2.1": "Explicit VR Little Endian", "1.2.840.10008.1.2": "Implicit VR Little Endian",
  "1.2.840.10008.1.2.4.50": "JPEG Baseline", "1.2.840.10008.1.2.4.70": "JPEG Lossless", "1.2.840.10008.1.2.4.80": "JPEG-LS Lossless",
  "1.2.840.10008.1.2.4.90": "JPEG 2000 Lossless", "1.2.840.10008.1.2.4.91": "JPEG 2000", "1.2.840.10008.1.2.4.203": "HTJ2K", "1.3.6.1.4.1.99999.1.2.3": "private demo syntax",
};
const syntaxName = (uid: string) => SYNTAXES[uid] ? `${SYNTAXES[uid]} (${uid})` : uid;
const AUTHZ: Record<string, string> = { instant: "instant: the signed context covers it, with no network call", cached: "cached: reused an earlier can_i decision", asked: "asked: the proxy called can_i" };

function contextRows(ctx: Jwt | undefined): Row[] {
  if (!ctx) return [["Signed context", "none in this URL"]];
  const c = ctx.claims;
  return [["Signed context", describeContext(c)], ["Context study", shortUid(c.study)], ["Bound token hash", c.ath ? `${c.ath.slice(0, 10)}…` : undefined], ["Context expires", fmtEpoch(c.exp)], ["Signed with", [ctx.header?.alg, ctx.header?.kid].filter(Boolean).join(", ")]];
}
/** The first check under this span that stopped the work. A failed fast-path test isn't one: the proxy just asks. */
const stoppedAt = (related: Span[]) => related.find(c => c.kind === "check" && c.status && c.status !== "ok" && !/^fast path|^decision cache|^expected:/.test(c.name))?.name;

function studyTable(bundle: any, related: Span[]): ReactNode {
  const entries: any[] = bundle.entry ?? [];
  const studies = entries.filter(e => e.resource?.resourceType === "ImagingStudy").map(e => e.resource);
  const issues = entries.filter(e => e.resource?.resourceType === "OperationOutcome").flatMap(e => e.resource.issue ?? []);
  const evaluations = new Map(related.filter(c => c.name.startsWith("policy evaluation:")).map(c => [c.attrs.study, c.attrs]));
  const endpointFor = (study: any) => {
    const ref = study.endpoint?.[0]?.reference;
    return entries.find(e => e.resource?.resourceType === "Endpoint" && (e.fullUrl === ref || `Endpoint/${e.resource.id}` === ref))?.resource;
  };
  const withheld = [...evaluations.values()].filter(a => a.release === "none");
  const notes = <>
    {issues.map((i: any, n: number) => <p className="muted" key={n}>Search outcome ({i.severity ?? "note"}): {i.diagnostics ?? i.code ?? ""}</p>)}
    {withheld.length > 0 && muted(`Withheld by policy: ${withheld.map(a => a.study).join(", ")}`)}
  </>;
  if (!studies.length) return <>{muted("No studies returned.")}{notes}</>;
  return <>
    <div className="scroll">
      <table>
        <thead><tr><th>Study</th><th>Site</th><th>Date</th><th>Mod.</th><th>Series</th><th>Inst.</th><th>Endpoint's signed context</th></tr></thead>
        <tbody>
          {studies.map((r: any) => (
            <tr key={r.id}>
              <td>{r.description ?? r.id}<br /><span className="muted">{r.id}</span></td>
              <td>{evaluations.get(r.id)?.site ?? ""}</td><td>{r.started ?? ""}</td>
              <td>{(r.modality ?? []).map((m: any) => m.code).join(", ")}</td><td>{r.numberOfSeries ?? ""}</td><td>{r.numberOfInstances ?? ""}</td>
              <td>{describeContext(contextOf(endpointFor(r)?.address)?.claims) ?? "no context found"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    {notes}
  </>;
}

/** What a retrieval shows, whichever side of the call you're looking at. */
function wadoRows(url: string | undefined, accept: string | undefined, span: Span, related: Span[]): Row[] {
  // An HTTP client can retry on its own after a reset connection, so one call can reach the proxy more than once.
  const received = span.kind === "server" ? [span] : related.filter(c => c.kind === "server" && c.attrs?.authz !== undefined);
  const server = received.at(-1);
  const within = server && server !== span ? related.filter(c => c.parent === server.span) : related;
  const stream = within.find(c => c.name === "stream multipart response");
  const partChecks = within.filter(c => /^part \d+:/.test(c.name));
  const counts: Record<string, number> = {};
  for (const p of partChecks) if (p.attrs?.syntax) counts[p.attrs.syntax] = (counts[p.attrs.syntax] ?? 0) + 1;
  const syntaxes = Object.entries(counts).map(([k, n]) => `${syntaxName(k)} × ${n}`).join(", ");
  const fastPathMiss = within.find(c => c.name.startsWith("fast path:") && c.status === "denied")?.name.replace("fast path: ", "");
  const parts = stream?.attrs?.parts ?? span.attrs?.parts ?? (partChecks.length || undefined);
  const boundary = stream?.attrs?.closing_boundary ?? span.attrs?.closing_boundary;
  return [
    ["Accept", accept ?? "none sent"], ["Plan from Accept", within.find(c => c.name === "Accept compiled into a plan")?.attrs?.plan],
    ...contextRows(contextOf(url)),
    ["Context signature", fastPathMiss === "signature verifies" ? "doesn't verify, so its claims aren't trusted" : undefined],
    ["Received", received.length > 1 ? `${received.length} times: the HTTP client retried by itself. This shows the last.` : undefined],
    ["Authorization", AUTHZ[server?.attrs?.authz] ?? server?.attrs?.authz],
    ["Fast path stopped at", fastPathMiss],
    ["Authorized", yesNo(server?.attrs?.allowed)],
    ["Denial", server?.attrs?.denial],
    ["Parts", parts],
    ["Transfer syntaxes", syntaxes || stream?.attrs?.syntaxes?.split(", ").map(syntaxName).join(", ")],
    ["Closing boundary", (parts || boundary) ? yesNo(boundary) : undefined],
    ["Stream stopped", stream?.attrs?.reason],
    ["Failed check", stoppedAt(within)],
  ];
}

/** Recognizes an exchange by its path, and shows what matters about that kind of call. */
function httpPreview(span: Span, related: Span[]): ReactNode {
  const h = span.http!, u = urlOf(h);
  if (!u) return null;
  const q = u.searchParams, path = u.pathname, res = parseJson(h.response), form = parseForm(h.request), sent = parseJson(h.request);
  const back = redirectOf(h), page = parsePage(h.response);
  const stopped = () => span.status === "ok" ? undefined : stoppedAt(related);

  if (path === "/authorize") {
    const err = back?.searchParams.get("error");
    const heading = pageTexts(page, "h1")[0] ?? pageTexts(page, "title")[0];
    const result = err ? `redirected back with error ${err}` : back ? `redirected to ${whereTo(back, u)}` : h.status === 200 ? `showed the page “${heading ?? "sign in"}”` : h.status && `refused with ${h.status}${heading ? `: ${heading}` : ""}. It doesn't redirect, since the target can't be trusted.`;
    return section("Authorization request", kv([["Client", q.get("client_id")], ["Redirect URI", q.get("redirect_uri")], ["Scope", q.get("scope")], ["aud", q.get("aud")], ["state", q.get("state")], ["PKCE challenge", q.get("code_challenge")], ["PKCE method", q.get("code_challenge_method")], ["Login hint", q.get("login_hint")], ["Accounts offered", pageValues(page, "input[name=username][type=radio]").join(", ")], ["Result", result], ["Failed check", stoppedAt(related)]]));
  }
  if (path.endsWith("/signin")) {
    const reason = pageTexts(page, ".error")[0] ?? pageTexts(page, "h1")[0];
    const result = back ? `signed in, on to ${whereTo(back, u)}` : h.status && `rejected with ${h.status}${reason ? `: ${reason}` : ""}`;
    return section("Sign-in", kv([["User", form?.get("username")], ["Session cookie", h.response?.headers?.["set-cookie"] ? "set, not recorded" : undefined], ["Result", result], ["Failed check", stopped()]]));
  }
  if (path === "/authorize/consent") {
    const whose = page ? [...page.querySelectorAll("input[name=patient]")].map(i => i.closest("label")?.textContent?.trim().replace(/\s+/g, " ")).filter(Boolean).join("; ") : undefined;
    return section("Consent page", kv([["Page", pageTexts(page, "h1")[0]], ["User", pageTexts(page, ".who")[0]], ["Whose records", whose], ["Permissions", pageTexts(page, "fieldset li").join(", ")], ["Sites offered", pageValues(page, "input[name=sites]").join(", ")], ["Result", h.status === 200 ? "shown to the user" : h.status && `refused with ${h.status}: ${pageTexts(page, "h1")[0] ?? "no page"}`], ["Failed check", stopped()]]));
  }
  if (path === "/authorize/decision") {
    const approved = form?.get("decision") === "approve", refused = back?.searchParams.get("error");
    return section("User's decision", kv([["Decision", form?.get("decision")], ["Patient", form?.get("patient")], ["Sites for the app", sitesChosen(form) ?? (approved && !refused ? "not narrowed" : undefined)], ["Redirects to", whereTo(back, u)], ["Code", back?.searchParams.get("code")], ["state", back?.searchParams.get("state")], ["Error", refused], ["Refused", !back && (h.status ?? 0) >= 400 ? pageTexts(page, "h1")[0] ?? `status ${h.status}` : undefined], ["Failed check", stoppedAt(related)]]));
  }
  if (path === "/oauth/callback") return section("Back at the app's redirect URI", kv([["Code", q.get("code")], ["state", q.get("state")], ["Error", q.get("error")], ["Account page", q.get("account")]]));
  if (path.startsWith("/account")) {
    if (h.method === "GET") {
      const signedOut = !!page?.querySelector('form[action*="/account/signin"]');
      const listed: Row[] = page ? [...page.querySelectorAll("section")].map(sec => [pageTexts(sec, "h2")[0] ?? "Section", pageTexts(sec, ".rows li > span").join("; ") || pageTexts(sec, ":scope > .note")[0]]) : [];
      return section("Account page", kv([["Page", pageTexts(page, "h1")[0]], ["Session", signedOut ? `signed out${h.request?.headers?.cookie ? ": the cookie it sent is no longer valid" : ""}` : page ? "signed in" : undefined], ["User", pageTexts(page, ".who")[0]], ["Accounts offered", pageValues(page, "input[name=username][type=radio]").join(", ")], ...listed, ["Failed check", stopped()]]));
    }
    const actions: Record<string, string> = { "/account/delegations": "Share records", "/account/delegations/revoke": "Revoke a related person", "/account/apps/revoke": "Revoke an app", "/account/signout": "Sign out" };
    return section(`Account: ${actions[path] ?? path}`, kv([["Share with", path === "/account/delegations" ? form?.get("delegate") : undefined], ["Revoke access for", path.endsWith("/delegations/revoke") ? form?.get("delegate") : undefined], ["Relationship", form?.get("relationship")], ["Sites", sitesChosen(form)], ["App", form?.get("client")], ["Session cookie", h.response?.headers?.["set-cookie"] ? "changed, not recorded" : undefined], ["Redirects to", whereTo(back, u)], ["Result", !back && h.status ? `refused with ${h.status}: ${pageTexts(page, "h1")[0] ?? "no page"}` : undefined], ["Failed check", stoppedAt(related)]]));
  }
  if (path === "/token") {
    const a = decodeJwt(form?.get("client_assertion"));
    return <>
      {section("Token request", kv([["Grant", form?.get("grant_type")], ["Client", form?.get("client_id") ?? a?.claims.iss], ["Scope asked", form?.get("scope")], ["Code", form?.get("code")], ["PKCE verifier", form?.get("code_verifier")], ["Redirect URI", form?.get("redirect_uri")], ["Refresh token", form?.get("refresh_token")]]))}
      {a && section("Client assertion, decoded", kv([["alg", a.header.alg], ["kid", a.header.kid], ["typ", a.header.typ], ["iss", a.claims.iss], ["sub", a.claims.sub], ["aud", a.claims.aud], ["jti", a.claims.jti], ["exp", fmtEpoch(a.claims.exp)], ["Signature", "not recorded"]]))}
      {h.status !== undefined && section(h.status === 200 ? "Token response" : "Token error", kv([["Error", res?.error], ["Description", res?.error_description], ["Access token", res?.access_token], ["Type", res?.token_type], ["Expires in", res?.expires_in === undefined ? undefined : `${res.expires_in} s`], ["Scope", res?.scope], ["Patient", res?.patient], ["Refresh token", res?.refresh_token], ["Failed check", stopped()]]))}
    </>;
  }
  if (path === "/introspect") {
    return section("Token introspection", kv([["Token", form?.get("token")], ["Active", res ? String(res.active) : undefined], ["Client", res?.client_id], ["Scope", res?.scope], ["Patient", res?.patient], ["User", res?.sub], ["fhirUser", res?.fhirUser], ["Expires", fmtEpoch(res?.exp)]]));
  }
  if (path.endsWith("/.well-known/smart-configuration")) {
    return section("SMART discovery", kv([["Issuer", res?.issuer], ["Authorization endpoint", res?.authorization_endpoint], ["Token endpoint", res?.token_endpoint], ["Introspection endpoint", res?.introspection_endpoint], ["Grants", res?.grant_types_supported?.join(", ")], ["PKCE", res?.code_challenge_methods_supported?.join(", ")], ["Client auth", res?.token_endpoint_auth_methods_supported?.join(", ")], ["Capabilities", res?.capabilities?.join(", ")], ["Associated endpoints", res?.associated_endpoints?.map((e: any) => e.url).join(", ")]]));
  }
  if (path.endsWith("/ImagingStudy")) {
    const cut = h.response?.truncated && !res;
    const total = res?.total ?? (cut ? h.response!.body?.match(/"total":\s*(\d+)/)?.[1] : undefined);
    const refused = res?.resourceType === "OperationOutcome" ? res.issue?.map((i: any) => `${i.severity ?? "error"}, ${i.code ?? "unknown"}: ${i.diagnostics ?? ""}`).join("; ") : undefined;
    return section("ImagingStudy search",
      kv([["Query", queryText(u)], ["Studies matched", total], ["OperationOutcome", refused], ["Failed check", stopped()]]),
      res?.resourceType === "Bundle" ? studyTable(res, related) : cut ? muted(`The captured Bundle stops at ${fmtBytes(h.response!.body!.length)} of ${fmtBytes(h.response!.bytes)}, so there's no study table. Open the full response to read what was kept.`) : null);
  }
  if (path === "/access/v1/evaluation") {
    const signed = decodeJwt(sent?.context?.signed_context);
    const release = res?.context?.release;
    const why = related.find(c => c.name.startsWith("decision:"))?.attrs?.why;
    return <>
      {section("can_i request (AuthZEN)", kv([["Subject type", sent?.subject?.type], ["Token", sent?.subject?.properties?.access_token], ["Token hash (ath)", sent?.subject?.id ? `${sent.subject.id.slice(0, 10)}…` : undefined], ["Action", sent?.action?.name], ["Resource type", sent?.resource?.type], ["Study", shortUid(sent?.resource?.id)], ...(sent ? contextRows(signed) : [])]))}
      {h.status !== undefined && section("can_i response", res?.decision === undefined ? muted(`No decision: status ${h.status}. The proxy fails closed with a 503.`) : kv([["Decision", res.decision ? "allow" : "deny"], ["Why", why], ["Release", release === "study" ? "whole study" : release?.series ? `${release.series.length} series` : release], ["Denial", res.context?.denial], ["Cacheable for", res.context?.max_age_seconds === undefined ? undefined : `${res.context.max_age_seconds} s`], ["Decision ID", res.context?.decision_id]]))}
    </>;
  }
  if (path.startsWith("/policy/v2/")) {
    const fields: Record<string, unknown> = sent ?? Object.fromEntries([...q].filter(([k]) => !k.startsWith("demo_")));
    const listed: Row[] = Object.entries(fields).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : v]);
    const title = `Policy ${h.method === "GET" ? "lookup" : h.method === "DELETE" ? "removal" : "update"}: ${path.replace("/policy/v2/", "")}`;
    const answer: Row[] = res?.records ? [
      ["Records", res.records.map((r: any) => `${r.patient} via ${r.via}: ${r.sites.join(", ")}`).join("; ") || "none"],
      ["Shares", res.shares?.map((d: any) => `${d.with} (${d.label}): ${(d.sites ?? []).join(", ")}`).join("; ")],
      ["App approvals", res.approvals?.map((a: any) => `${a.app}${a.sites ? `: ${a.sites.join(", ")}` : ""}`).join("; ")],
    ] : res ? Object.entries(res) : [];
    return section(title, kv([...listed, ...answer, ["Result", h.status === 204 ? "recorded" : undefined], ["Failed check", stopped()]]));
  }
  if (path.includes("/wado/")) {
    const what = /\/metadata$/.test(path) ? "metadata" : /\/bulk\//.test(path) ? "bulk data" : /\/instances\//.test(path) ? "one instance" : /\/series\//.test(path) ? "one series" : "a whole study";
    return section("DICOMweb retrieval", kv([["Request for", what], ["Query", queryText(u)], ...wadoRows(h.url, h.request?.headers?.accept, span, related)]));
  }
  if (span.service === "backend") return section("Upstream call to the backend", kv([["Accept", h.request?.headers?.accept], ["Query", queryText(u)]]));
  return section(`${h.method} ${displayPath(u)}`, kv([["Query", queryText(u)], ["Accept", h.request?.headers?.accept]]));
}

/** The one-line form of a call: every HTTP preview starts with it. */
function CallLine({ span }: { span: Span }) {
  const h = span.http!, u = urlOf(h);
  const outcome = h.status ?? (span.end ? "no response" : "waiting");
  const type = (h.response?.headers?.["content-type"] ?? h.contentType)?.split(";")[0];
  const size = h.response?.bytes ?? h.bytes;
  const facts = [type, size ? fmtBytes(size) : undefined, span.end ? fmtMs(span.end - span.start) : "still running"].filter(Boolean).join(" · ");
  const cls = span.status === "ok" ? "good" : !span.status ? "" : span.status === "denied" ? "warn" : "bad";
  return <p className="call-line"><b>{h.method}</b> {u ? u.host + displayPath(u) : h.url} <b className={cls}>→ {outcome}</b> <span className="muted">{facts}</span></p>;
}

/** A shortened look at a body. The full exchange opens in its own tab. */
function BodySnippet({ label, m }: { label: string; m: Message | undefined }) {
  if (!m?.body) return null;
  const text = m.encoding === "hex" ? hexDump(m.body, 96) : pretty(m).replace(/<style>[\s\S]*?<\/style>/g, "<style>…</style>");
  const short = text.split("\n").slice(0, 14).join("\n").slice(0, 1500);
  return <details className="snippet"><summary>{label} body{m.bytes ? `, ${fmtBytes(m.bytes)}` : ""}</summary><pre>{short}{short.length < text.length ? "\n…" : ""}</pre></details>;
}

const attrRows = (attrs: Record<string, any> | undefined, skip: string[] = []): Row[] => Object.entries(attrs ?? {})
  .filter(([k]) => k !== "streaming" && !skip.includes(k))
  .map(([k, v]) => [k.replaceAll("_", " "), k === "exp" || k === "now" ? fmtEpoch(v) : v]);

function checkPreview(span: Span): ReactNode {
  const a = span.attrs ?? {}, passed = span.status === "ok";
  if (span.name.startsWith("policy evaluation:")) {
    const chain = a.because ? <><h4>Because: facts, policy and choices</h4><ol className="because">{String(a.because).split(" → ").map((step, i) => <li key={i}>{step}</li>)}</ol></> : null;
    return section(passed ? "Policy releases this study" : "Policy withholds this study", kv([["Study", a.study], ["Site", a.site], ["Release", a.release], ["Why", a.why], ["Policy", a.policy === "(none)" ? undefined : a.policy], ["Client", a.client], ["User", a.user], ["Patient context", a.patient_context]]), chain);
  }
  if (span.name.startsWith("decision:")) return section(`Decision: ${passed ? "allow" : "deny"}`, kv([["Why", a.why], ...attrRows(a, ["why"])]));
  if (span.name.startsWith("expected:")) {
    return section(passed ? "What the demo expected, and got" : "What the demo expected, and didn't get", kv([["Expected", span.name.replace("expected: ", "")], ["Saw", a.detail]]));
  }
  const routine = span.name.startsWith("fast path:") || span.name.startsWith("decision cache");
  return section(passed ? "Check passed" : "Check didn't pass", kv([["Check", span.name], ...attrRows(a)]), !passed && routine ? muted("Not an error: the proxy asks the Imaging Server instead.") : null);
}

/** What a span with no HTTP of its own shows. */
function plainPreview(span: Span, related: Span[]): ReactNode {
  const a = span.attrs ?? {};
  if (span.kind === "check") return checkPreview(span);
  if (span.kind === "action") {
    const inputs = Object.entries(a.inputs ?? {}).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`).join("; ");
    const judged = a.checks_passed === undefined ? undefined : `${a.checks_passed} passed, ${a.checks_failed ?? 0} failed`;
    return section("User action", kv([["Flow", a.flow], ["Step", a.step], ["Actor", a.actor], ["User", a.user], ["Sites", a.sites], ["Backend", a.backend], ["Choices", inputs], ["Expected results", judged]]));
  }
  if (span.kind === "client" && (a.accept !== undefined || a.url?.includes("/wado/"))) {
    const sent = related.find(c => c.http?.url.includes("/wado/"));
    return section("Retrieval, as the app saw it", kv([["Actor", a.actor], ["URL", shortUids(a.url)], ["Status", a.status], ...wadoRows(sent?.http!.url, a.accept, span, related), ["Failed partway", a.failed ? "yes" : undefined]]));
  }
  if (span.service === "backend") {
    const viaHttp = related.some(c => c.http);
    return section(`Backend read: ${a.backend ?? span.name}`, kv(attrRows(a, ["backend", "error"]).map(([k, v]) => [k, typeof v === "string" ? shortUids(v) : v])), muted(viaHttp ? "The nested rows are the HTTP calls this read made." : "Read through a storage client, so there's no HTTP exchange to show."));
  }
  if (span.name === "stream multipart response") {
    return section("Streamed multipart response", kv([["Backend", a.backend], ["Study", shortUid(a.study)], ["Parts", a.parts], ["Transfer syntaxes", a.syntaxes?.split(", ").map(syntaxName).join(", ")], ["Closing boundary", yesNo(a.closing_boundary)], ["Aborted", a.aborted ? "yes: no closing boundary, so the client can't mistake this for a complete study" : undefined], ["Reason", a.reason]]));
  }
  if (a.header && a.claims) {
    return section("Client assertion, as signed", kv([...Object.entries(a.header) as Row[], ...Object.entries(a.claims).map(([k, v]): Row => [k, k === "exp" ? fmtEpoch(v) : v]), ["Signature", "not recorded"]]));
  }
  return section(span.name, kv(attrRows(a, ["error"])) ?? muted("Nothing further recorded for this step. Rows nested under it show the work."));
}

/** The other side of the same HTTP call, when the trace holds both. */
export interface Pair { label: string; isClient: boolean }

/** The inline preview for any span. `related` is everything nested under it, `pair` the other side of the same call. */
export function Preview({ span, related, pair }: { span: Span; related: Span[]; pair?: Pair }) {
  // Reading a captured page means parsing it, so it's read again only when the span or its nested work changes.
  const body = useMemo(() => span.http ? httpPreview(span, related) : plainPreview(span, related), [span, related]);
  const error = span.attrs?.error ?? (span.attrs?.aborted ? span.attrs.reason : undefined);
  const h = span.http;
  const exchange = h ? span : span.kind === "client" && span.service !== "backend" ? related.find(c => c.http) : undefined;
  return (
    <>
      {error && <p className="callout bad"><b>Failed:</b> {String(error)}</p>}
      {h && <CallLine span={span} />}
      {body}
      {h && kv([["WWW-Authenticate", h.response?.headers?.["www-authenticate"]], ["Retry-After", h.response?.headers?.["retry-after"]]])}
      {h && pair && muted(pair.isClient ? `The nested ${pair.label} row is this same call, as it was received.` : `This is the call in the row above, as ${pair.label} received it.`)}
      {h && <BodySnippet label="Request" m={h.request} />}
      {h && <BodySnippet label="Response" m={h.response} />}
      {!span.end ? muted("Still running.")
        : h && h.status !== undefined && !h.response && h.bytes === undefined ? muted("The span has ended. The response is still being sent, and its size and body appear here once the receiver has read it all.") : null}
      <p className="links">
        {exchange && <a href={fullHref(exchange)} target="_blank" rel="noopener">Open full request and response ↗</a>}
        <a href={logHref(span)} target="_blank" rel="noopener">HTTP log for this trace ↗</a>
      </p>
    </>
  );
}
