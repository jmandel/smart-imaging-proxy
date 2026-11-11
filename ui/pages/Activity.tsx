// The log: one tile of rolled-up numbers per type of event, a timeline laned by party, one row per session, a
// session's studies each with its path through search, link, check and retrieval, and a table per type whose rows
// open the event in full. Filters live in the address, so Explore links here already filtered. With a
// session, everything on the page is what that session's viewer may see. With none, it's the operator's view of
// every session.
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import { api, BASE } from "../lib/api";
import { wordsFor, time, type EventWords, type LogEvent, type Names } from "../lib/event-words";
import { announce, bytes, LinkToView, plural, StudyList } from "../lib/format";
import { useReady } from "../lib/ready";
import { LEVEL, Mark } from "../components/Layers";
import { Exchange } from "../activity/Exchange";
import { EndsStrip, Flow, type SessionFlow, type StudyEnd } from "../activity/Flow";
import { PARTY, Timeline, type TimelineData } from "../activity/Timeline";
import { LogLink, logHref, type Changes, type Show } from "../activity/links";

type TypeId = "tokens" | "referrals" | "searches" | "links" | "checks" | "retrievals" | "decisions" | "writes" | "problems";
const TYPES: Record<TypeId, { name: string; cols: string[] }> = {
  tokens: { name: "Tokens issued", cols: ["Time", "Who", "Client", "How", "Sandbox", "Lasts", "Token"] },
  referrals: { name: "Referrals checked", cols: ["Time", "Service", "Patient reference", "Accession", "Result"] },
  searches: { name: "Searches", cols: ["Time", "Who", "Status", "Returned", "Withheld", "Query"] },
  links: { name: "Signed links made", cols: ["Time", "Study", "Form", "Series", "Expires", "Key"] },
  checks: { name: "Proxy checks", cols: ["Time", "Study", "How", "Result", "Why"] },
  retrievals: { name: "Retrievals", cols: ["Time", "Study", "Form", "Status", "Parts", "Bytes", "Encoding", "Decided by", "ms"] },
  decisions: { name: "Policy decisions", cols: ["Time", "Study", "Who", "Decision", "Why"] },
  writes: { name: "Policy writes", cols: ["Time", "What", "Level", "Status"] },
  problems: { name: "Errors and denials", cols: ["Time", "Type", "Party", "Summary"] },
};
const typeOf = (id: string | null) => id && id in TYPES ? TYPES[id as TypeId] : undefined;
const ALL_COLS = ["Time", "Type", "Party", "Summary"];
const NUMERIC = new Set(["Parts", "Bytes", "ms", "Returned", "Withheld", "Series"]);
const KIND_WORDS: Record<string, string> = { "token.issued": "Token issued", "referral.checked": "Referral checked", "search.returned": "Search", "context.signed": "Signed link", "decision.answered": "Policy decision", "proxy.fast-path": "Proxy check", "proxy.decision": "Proxy check", "stream.done": "Retrieval", "retrieval.answered": "Retrieval", "policy.written": "Policy write" };
const AUTHZ: Record<string, string> = { instant: "signed link", cached: "cached answer", asked: "asked the Imaging Server", "no token": "no token" };
const LEVELS: Record<string, string> = { fact: "facts", policy: "organization policy", choice: "choices", settings: "settings", document: "whole document", reset: "resets" };
/** The levels a policy write has a mark for. */
const MARKED = (level: unknown): level is "fact" | "policy" | "choice" => level === "fact" || level === "policy" || level === "choice";

interface SessionRow { session: string; who?: string; client?: string; label: string; to: number; ends: StudyEnd[]; problems: number }
interface Summary {
  viewer: boolean; total: number; capped: boolean; types: TypeId[]; tiles: Record<TypeId, Record<string, any>>;
  timeline: TimelineData; sessions: SessionRow[]; studies: string[]; flow?: SessionFlow; sandboxes?: string[]; traceUrl?: string;
}
interface EventPage { events: LogEvent[]; more: boolean; before: number | null; traceUrl?: string }

const num = (n: unknown) => Number(n ?? 0).toLocaleString();
const when = (at: number) => {
  const d = new Date(at);
  return new Date().toDateString() === d.toDateString() ? time(at) : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time(at)}`;
};
const topOf = (m: Record<string, number> | undefined, n = 2, word = (k: string) => k) => {
  const e = Object.entries(m ?? {}).sort((a, b) => b[1] - a[1]);
  return e.slice(0, n).map(([k, v]) => `${num(v)} ${word(k)}`).join(", ") + (e.length > n ? `, and ${e.length - n} more` : "");
};

/** Names a session's client, or anyone, from the cast. */
function namers(names: Names, words: EventWords) {
  return {
    client: (c?: string) => c ? (names[`app:${c}`]?.replace(/^the /, "") ?? names[`client:${c}`] ?? c) : "",
    who: (w?: string) => w ? words.nameOf(w) : "",
  };
}
type Namers = ReturnType<typeof namers>;

// Each tile: its count, a line or two of the numbers that matter, and a split bar where a split says something.
type Split = [string, number, string][];
function tileParts(id: TypeId, t: Record<string, any>, n: Namers): { lines: string[]; split?: Split } {
  switch (id) {
    case "tokens": return { lines: [t.count ? topOf(t.byClient, 2, k => `to ${n.client(k)}`) : "None issued"] };
    case "referrals": return { lines: [t.count ? `${num(t.ok)} on the authorized server, ${num(t.refused)} not` : "None checked"], split: [["On the server", t.ok, "a"], ["Not on it", t.refused, "bad"]] };
    case "searches": return { lines: [`${num(t.returned)} ${t.returned === 1 ? "study" : "studies"} returned, ${num(t.withheld)} withheld`, t.refused ? `${num(t.refused)} refused` : ""], split: [["Returned", t.returned, "a"], ["Withheld", t.withheld, "b"]] };
    case "links": return { lines: [t.count ? topOf(t.byForm, 3) : "None made"] };
    case "checks": return { lines: [t.count ? [t.instant && `${num(t.instant)} by the signed link alone`, t.cached && `${num(t.cached)} by a cached answer`, t.asked && `${num(t.asked)} asked the Imaging Server`].filter(Boolean).join(", ") : "None", t.refused ? `${num(t.refused)} refused` : ""], split: [["Signed link alone", t.instant, "a"], ["Cached answer", t.cached, "b"], ["Asked the Imaging Server", t.asked, "c"]] };
    case "retrievals": return { lines: [t.count ? (t.bytes ? `${bytes(t.bytes)} sent to apps` : "Nothing sent") : "None", [t.refused ? `${num(t.refused)} refused` : "", t.cut ? `${num(t.cut)} cut off` : ""].filter(Boolean).join(", ")] };
    case "decisions": return { lines: [`${num(t.allow)} allow, ${num(t.deny)} deny`], split: [["Allow", t.allow, "good"], ["Deny", t.deny, "bad"]] };
    case "writes": return { lines: [t.count ? `${num(t.ok)} written${t.refused ? `, ${num(t.refused)} refused` : ""}` : "None", t.count ? topOf(t.byLevel, 2, k => `to ${LEVELS[k] ?? k}`) : ""] };
    case "problems": return { lines: [`${num(t.denied)} denied, ${num(t.error)} failed`, t.count ? topOf(t.byKind, 2, k => KIND_WORDS[k]?.toLowerCase() ?? k) : ""] };
  }
}
function SplitBar({ split }: { split: Split }) {
  const parts = split.filter(([, v]) => v > 0);
  if (parts.length < 2) return null;
  return (
    <div className="split" role="img" aria-label={parts.map(([k, v]) => `${k}: ${v}`).join(", ")}>
      {parts.map(([k, v, c]) => <span key={k} className={`split-seg ${c}`} style={{ flexGrow: v }} title={`${k}: ${num(v)}`} />)}
    </div>
  );
}
function Tiles({ summary, chosen, n, href }: { summary: Summary; chosen: string | null; n: Namers; href: (c: Changes) => string }) {
  return (
    <ul className="tiles" id="tiles" aria-label="Each type of event, rolled up. Choose one to list it.">
      {summary.types.map(id => {
        const t = summary.tiles[id], p = tileParts(id, t, n);
        return (
          <li key={id}>
            <LogLink className={`tile ${t.count ? "" : "zero"} ${id === "problems" && t.count ? "alarm" : ""}`} to={href({ type: id === chosen ? null : id })} data-type={id} {...(id === chosen ? { "aria-current": "true" as const } : {})}>
              <span className="tile-name">{TYPES[id].name}</span><span className="tile-count">{num(t.count)}</span>
              {p.lines.filter(Boolean).map((l, i) => <span className="tile-line" key={i}>{l}</span>)}
              {p.split && <SplitBar split={p.split} />}
            </LogLink>
          </li>
        );
      })}
    </ul>
  );
}

// Sessions: one row each, who and with what, when, and a mark per study for where its path ended.
function Sessions({ summary, current, n, href }: { summary: Summary; current: string | null; n: Namers; href: (c: Changes) => string }) {
  if (!summary.sessions.length) return <p className="note">No sessions match these filters.</p>;
  return (
    <ol className="session-list">
      {summary.sessions.map(r => {
        const who = n.who(r.who), client = r.client && `client:${r.client}` !== r.who ? n.client(r.client) : "";
        return (
          <li key={r.session}>
            <LogLink className="session-row" to={href({ session: r.session === current ? null : r.session, study: null, trace: null })} {...(r.session === current ? { "aria-current": "true" as const } : {})}>
              <span className="s-who"><b>{who || "No one named"}</b>{client && <span> with {client}</span>}</span><span className="s-when">{when(r.to)}</span>
              <span className="s-label">{r.label}</span>
              <EndsStrip ends={r.ends} />{r.problems > 0 && <span className="s-problems">{plural(r.problems, "denial or failure", "denials or failures")}</span>}
            </LogLink>
          </li>
        );
      })}
    </ol>
  );
}

// The table's cells: columns that suit the type.
const Status = ({ s, ok = Number(s) < 400 }: { s: ReactNode; ok?: boolean }) => <span className={`tag ${ok ? "ok" : "denied"}`}>{s}</span>;
function cells(e: LogEvent, type: TypeId | "all", words: EventWords, n: Namers): ReactNode[] {
  const d = e.data, study = e.study ?? "";
  switch (type) {
    case "tokens": return [n.who(e.who), n.client(d.client), d.grant?.replaceAll("_", " "), d.sandbox, d.expiresIn && `${Math.round(d.expiresIn / 60)} min`, d.tokenHash && <code>{d.tokenHash}</code>];
    case "referrals": return [n.client(d.client), d.reference, d.accession, d.ok ? <Status s="on the server" ok /> : <Status s="not on it" ok={false} />];
    case "searches": return [n.who(e.who), <Status s={d.status} />, d.found ? num(d.found.length) : "", d.withheld || d.unreached ? num((d.withheld?.length ?? 0) + (d.unreached?.length ?? 0)) : "", d.query && <code>{d.query}</code>];
    case "links": return [study, d.form, d.series, d.exp && new Date(d.exp * 1000).toLocaleTimeString(), d.kid];
    case "checks": return e.kind === "proxy.fast-path"
      ? [study, d.taken ? "Instant, from the signed link" : "Fell through to a decision", d.taken ? <Status s="allowed" ok /> : <span className="tag info">next</span>, d.failed]
      : [study, d.via === "cached" ? "Cached decision" : "Decision call", d.unavailable ? <Status s="no answer" ok={false} /> : <Status s={d.allowed ? "allowed" : "refused"} ok={!!d.allowed} />, d.denial];
    case "retrievals": return [study, d.resource, <Status s={d.status} ok={d.status < 400 && (e.kind !== "stream.done" || !!d.complete)} />, e.kind === "stream.done" ? num(d.parts) : "", e.kind === "stream.done" ? bytes(d.bytes) : "", d.encoding, AUTHZ[d.authz] ?? d.authz, e.ms !== undefined ? num(Math.round(e.ms)) : ""];
    case "decisions": return [study, n.who(e.who) || n.client(d.client), <Status s={d.decision ? "allow" : "deny"} ok={!!d.decision} />, d.why];
    case "writes": return [words.written(d).what, MARKED(d.level) ? <span className="lvl"><Mark level={d.level} /> {LEVEL[d.level]}</span> : LEVELS[d.level] ?? d.level, <Status s={d.status} />];
    default: return [KIND_WORDS[e.kind] ?? e.kind, PARTY[e.service] ?? e.service, <>{e.outcome !== "ok" && e.outcome !== "info" && <><span className={`tag ${e.outcome}`}>{e.outcome === "error" ? "failed" : e.outcome}</span> </>}{words.describe(e).summary}</>];
  }
}
/** A cell shows nothing for a value that's missing or false. */
const shown = (v: ReactNode) => v === undefined || v === null || v === false ? "" : v;

function Detail({ e, words, session, traceUrl }: { e: LogEvent; words: EventWords; session: string | null; traceUrl?: string }) {
  const w = words.describe(e), links = words.linksOf(e);
  // A policy write's level, and a decision, which organization policy makes, wear the level's mark.
  const level = e.kind === "policy.written" ? (MARKED(e.data.level) ? e.data.level : undefined) : e.kind === "decision.answered" ? "policy" as const : undefined;
  return (
    <div className="ev-detail">
      <p className="ev-summary">{level && <><Mark level={level} /> </>}<b>{w.summary}</b> <span className="note">{PARTY[e.service] ?? e.service}, {new Date(e.at).toLocaleString()}</span></p>
      {w.fields.length > 0 && <dl>{w.fields.map(([a, b]) => <Fragment key={a}><dt>{a}</dt><dd>{Array.isArray(b) ? (b.length ? <StudyList items={b} /> : "none") : b}</dd></Fragment>)}</dl>}
      {links.length > 0 && <p className="ev-links">{links.map(l => <LogLink key={l.link} to={`${BASE}/activity?${new URLSearchParams({ ...(session ? { session } : {}), link: l.link })}`} title={l.title}>{l.words}</LogLink>)}</p>}
      <details><summary>Raw payload</summary><pre>{JSON.stringify({ kind: e.kind, ...e.data }, null, 2)}</pre></details>
      {e.span && <Exchange e={e} traceUrl={traceUrl} />}
    </div>
  );
}

function EventsTable({ events, type, openSeq, toggle, words, n, session, traceUrl }: { events: LogEvent[]; type: TypeId | null; openSeq: string | null; toggle: (seq: string) => void; words: EventWords; n: Namers; session: string | null; traceUrl?: string }) {
  if (!events.length) return <p className="note">Nothing matches these filters yet.</p>;
  const cols = type ? TYPES[type].cols : ALL_COLS;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr>{cols.map(c => <th key={c} scope="col" className={NUMERIC.has(c) ? "n" : ""}>{c}</th>)}</tr></thead>
        <tbody>
          {[...events].reverse().map(e => {
            const seq = String(e.seq), open = seq === openSeq;
            return (
              <Fragment key={seq}>
                {/* A click anywhere on the row opens it, except on a link or a disclosure inside it. */}
                <tr className={`ev ${e.outcome}`} data-seq={seq} onClick={x => { if (!(x.target as Element).closest("a, details, button")) toggle(seq); }}>
                  <td className="t"><button type="button" aria-expanded={open} aria-controls={`d-${seq}`} onClick={() => toggle(seq)}>{when(e.at)}</button></td>
                  {cells(e, type ?? "all", words, n).map((v, i) => <td key={i} className={NUMERIC.has(cols[i + 1] ?? "") ? "n" : ""}>{shown(v)}</td>)}
                </tr>
                {open && <tr className="detail" id={`d-${seq}`}><td colSpan={cols.length}><Detail e={e} words={words} session={session} traceUrl={traceUrl} /></td></tr>}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Filters({ summary, params, n, href }: { summary: Summary; params: URLSearchParams; n: Namers; href: (c: Changes) => string }) {
  const navigate = useNavigate();
  const chips: [string, string][] = [];
  const session = params.get("session"), row = session ? summary.sessions.find(r => r.session === session) : undefined;
  if (session) chips.push(["session", `Session: ${row ? `${n.who(row.who) || "no one named"}, ${row.label}` : session}`]);
  if (params.get("trace")) chips.push(["trace", "One step"]);
  if (params.get("type")) chips.push(["type", `Type: ${typeOf(params.get("type"))?.name ?? params.get("type")}`]);
  if (params.get("link")) chips.push(["link", `Shares ${params.get("link")}`]);
  const study = params.get("study") ?? "", sandbox = params.get("sandbox") ?? "";
  const studies = [...new Set([...summary.studies, ...(study ? [study] : [])])];
  const choose = (name: string, value: string) => navigate(href({ [name]: value || null }));
  return (
    <form className="filters" id="filters" aria-label="Filter the log" onSubmit={e => e.preventDefault()}>
      {summary.sandboxes && summary.sandboxes.length > 0 && <label>Sandbox<select name="sandbox" value={sandbox} onChange={e => choose("sandbox", e.target.value)}>
        <option value="">Every sandbox</option><option value="-">Saved policy</option>
        {summary.sandboxes.map(s => <option key={s} value={s}>Sandbox {s}</option>)}
      </select></label>}
      <label>Study<select name="study" value={study} onChange={e => choose("study", e.target.value)}>
        <option value="">Any study</option>{studies.map(s => <option key={s} value={s}>{s}</option>)}
      </select></label>
      {chips.length > 0 && <ul className="chosen" aria-label="Filters in use">{chips.map(([k, words]) => <li key={k}><span>{words}</span><LogLink to={href({ [k]: null })} aria-label={`Remove the filter: ${words}`}>×</LogLink></li>)}</ul>}
    </form>
  );
}

export default function Activity() {
  const { search, state } = useLocation();
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const href = (changes: Changes) => logHref(search, changes);
  const type = typeOf(params.get("type")) ? params.get("type") as TypeId : null, session = params.get("session");
  const [names, setNames] = useState<Names>({});
  const [summary, setSummary] = useState<Summary>();
  const [page, setPage] = useState<EventPage>();
  const [error, setError] = useState<string>();
  // The open event is in the address too, so a reload opens it again, but opening one isn't a new view.
  const [openSeq, setOpenSeq] = useState(params.get("event"));
  const words = useMemo(() => wordsFor(names), [names]);
  const n = useMemo(() => namers(names, words), [names, words]);
  const title = useRef<HTMLHeadingElement>(null), eventsHead = useRef<HTMLHeadingElement>(null);

  const eventsQuery = (before?: number | null) => {
    const p = new URLSearchParams(search); p.delete("event"); p.set("limit", "100");
    if (before) p.set("before", String(before));
    return `/api/activity?${p}`;
  };
  useEffect(() => {
    // The cast names people and services; without it, the log shows their ids.
    api<{ names: Names }>("GET", "/api/sandbox/explore/cast").then(r => setNames(r.names ?? {}), () => {});
    const q = new URLSearchParams(search); q.delete("event");
    Promise.all([api<Summary>("GET", `/api/activity/summary?${q}`), api<EventPage>("GET", eventsQuery())])
      .then(([s, p]) => { setSummary(s); setPage(p); announce(plural(s.total, "event")); }, e => setError((e as Error).message));
  }, []);

  // Once the view has loaded, the page brings into sight what the link that opened it changed, or the open event.
  useEffect(() => {
    if (!summary) return;
    const show = (state as { show?: Show } | null)?.show;
    const t = show === "title" ? title.current : show === "events" ? eventsHead.current : null, box = t?.getBoundingClientRect();
    if (t && box && (box.top < 0 || box.top > innerHeight * .6)) t.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    else if (openSeq) document.getElementById(`d-${openSeq}`)?.scrollIntoView({ block: "nearest" });
  }, [summary]);

  const toggle = (seq: string) => {
    const next = openSeq === seq ? null : seq;
    setOpenSeq(next);
    const p = new URLSearchParams(location.search);
    if (next) p.set("event", next); else p.delete("event");
    // Straight to the browser's history, keeping the router's entry: opening an event isn't a new view of the log.
    history.replaceState(history.state, "", `${location.pathname}${p.size ? `?${p}` : ""}`);
  };
  const older = async () => {
    const p = await api<EventPage>("GET", eventsQuery(page!.before));
    setPage({ ...p, events: [...p.events, ...page!.events] });
  };

  useReady(!!error || (!!summary && !!page));
  const one = !!summary?.flow;
  return (
    <main className={`log${summary?.viewer ? " one-session" : ""}`}>
      <div className="log-head">
        <h1 id="title" tabIndex={-1} ref={title}>Logs</h1>
        <LinkToView />
        <p className="note" id="view-line">{summary && (summary.viewer
          ? <>One session, showing only what {n.who(summary.sessions[0]?.who) || "its person or service"} may see. <LogLink to={`${BASE}/activity`}>Every session</LogLink></>
          : <>Every session, as the operator sees it.{summary.traceUrl && <> <a href={summary.traceUrl}>Open the live trace</a></>}</>)}</p>
        {summary && <Filters summary={summary} params={params} n={n} href={href} />}
      </div>
      <section className={`glance${one ? " one" : ""}`} aria-labelledby="h-glance">
        <h2 id="h-glance" className="sr-only">At a glance</h2>
        {/* One session's events come seconds apart: the study-by-study picture shows their order instead of a timeline. */}
        {summary?.flow && <figure className="flow" id="flow"><Flow f={summary.flow} words={words} href={href} when={when} /></figure>}
        {summary && <Tiles summary={summary} chosen={type} n={n} href={href} />}
        {summary && !one && <Timeline tl={summary.timeline} />}
      </section>
      {summary?.capped && <p className="note" id="capped">These rollups cover the newest 10,000 events that match.</p>}
      <div className="log-body">
        <section className="sessions" aria-labelledby="h-sessions">
          <h2 id="h-sessions">{!summary ? "Sessions" : summary.viewer ? "This session" : `Sessions, ${num(summary.sessions.length)}`}</h2>
          <div id="sessions">{summary ? <Sessions summary={summary} current={session} n={n} href={href} /> : !error && <p className="note">Loading…</p>}</div>
        </section>
        <section className="events" aria-labelledby="h-events">
          <h2 id="h-events" ref={eventsHead}>{type ? TYPES[type].name : "All events"}</h2>
          <div id="events">{error ? <p className="error" role="alert">{error}</p> : !page ? <p className="note">Loading…</p>
            : <EventsTable events={page.events} type={type} openSeq={openSeq} toggle={toggle} words={words} n={n} session={session} traceUrl={page.traceUrl} />}</div>
          {page?.more && <button type="button" className="secondary" id="more" onClick={older}>Show older events</button>}
        </section>
      </div>
    </main>
  );
}
