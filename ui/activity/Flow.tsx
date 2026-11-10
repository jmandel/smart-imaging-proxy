// One session, study by study: a card for each stretch of it, in time order, saying what changed and how the
// studies went, and under each card, every study's path across the four stages a study goes through. The same
// marks sum up each session in the list of sessions.
import { bytes, plural } from "../lib/format";
import type { EventWords } from "../lib/event-words";
import { LogLink, type Changes } from "./links";

export type StudyEnd = "sent" | "refused" | "linked" | "found" | "withheld" | "gone";
type Stage = "search" | "link" | "check" | "get";
interface StageStep { is: string; n: number; bytes?: number }
interface TimedStep extends StageStep { stage: Stage }
interface FlowStudy { study: string; title: string; site?: string; search: StageStep[]; links: number; check: StageStep[]; get: StageStep[]; steps: TimedStep[]; end: StudyEnd }
interface Phase { writes: Record<string, any>[]; from?: number; to?: number; studies: FlowStudy[] }
export interface SessionFlow {
  other: { tokens: number; referrals: number; refusedReferrals: number; writes: Record<string, number>; refusedWrites: number };
  phases: Phase[]; ends: StudyEnd[];
}

const num = (n: unknown) => Number(n ?? 0).toLocaleString();
const STAGES: { id: Stage; name: string; party: string; type: string }[] = [
  { id: "search", name: "Search", party: "Imaging Server", type: "searches" },
  { id: "link", name: "Link", party: "Imaging Server", type: "links" },
  { id: "check", name: "Check", party: "Proxy", type: "checks" },
  { id: "get", name: "Retrieve", party: "Proxy", type: "retrievals" },
];
const STAGE_NAME = Object.fromEntries(STAGES.map(st => [st.id, st.name])) as Record<Stage, string>;

// Where a study's path ended, in words that read after a count.
const ENDS: Record<StudyEnd, (n: number) => string> = { sent: () => "sent", refused: () => "refused", linked: () => "linked, not retrieved", found: n => `found, ${n === 1 ? "no link" : "no links"}`, withheld: () => "withheld", gone: () => "not found by the last search" };
const END_ORDER: StudyEnd[] = ["sent", "refused", "linked", "found", "withheld", "gone"];
export function endsLine(ends: StudyEnd[]) {
  const n: Partial<Record<StudyEnd, number>> = {};
  for (const e of ends) n[e] = (n[e] ?? 0) + 1;
  return END_ORDER.filter(e => n[e]).map(e => `${num(n[e])} ${ENDS[e](n[e]!)}`).join(", ");
}

/** A mark's kind: happened, sent, refused, withheld, or no longer found. */
export type MarkKind = "done" | "sent" | "refused" | "withheld" | "gone";
export function Dot({ kind, words }: { kind: MarkKind; words?: string }) {
  return <>
    <svg className={`fl-mark ${kind}`} viewBox="0 0 16 16" aria-hidden="true">
      {kind === "refused" ? <><circle cx="8" cy="8" r="6.5" /><path d="M5.3 5.3l5.4 5.4M10.7 5.3l-5.4 5.4" /></>
        : kind === "sent" ? <><circle cx="8" cy="8" r="6.5" /><path d="M4.8 8.3l2.2 2.1 4.2-4.6" /></>
        : <circle cx="8" cy="8" r={kind === "done" ? 5 : 5.5} />}
    </svg>
    {words && <span className="fl-word">{words}</span>}
  </>;
}

/** A session's row in the list: a mark per study for where its path ended. */
export function EndsStrip({ ends }: { ends: StudyEnd[] }) {
  if (!ends.length) return <span className="s-ends none">No study</span>;
  const sorted = [...ends].sort((a, b) => END_ORDER.indexOf(a) - END_ORDER.indexOf(b));
  return (
    <span className="s-ends" role="img" aria-label={endsLine(ends)}>
      <span className="s-marks">{sorted.map((e, i) => <Dot key={i} kind={e === "linked" || e === "found" ? "done" : e} />)}</span>
      <span>{endsLine(ends)}</span>
    </span>
  );
}

// What each outcome at a stage looks like, and says.
const SAY: Record<string, [MarkKind, string]> = {
  found: ["done", "found"], withheld: ["withheld", "withheld"], gone: ["gone", "not found"], unreached: ["gone", "not found"],
  instant: ["done", "link checked"], cached: ["done", "cached yes"], asked: ["done", "policy said yes"], refused: ["refused", "policy said no"], "no answer": ["refused", "no answer"],
};
const times = (n: number) => n === 1 ? "" : n === 2 ? " twice" : ` ${n} times`;
const said = (x: StageStep): [MarkKind, string] => { const [k, w] = SAY[x.is] ?? ["done", x.is]; return [k, `${w}${times(x.n)}`]; };

/** One study's four stages, each its outcomes in order, or null for a stage it never reached. */
function stagesOf(r: FlowStudy): ([MarkKind, string][] | null)[] {
  const steps = (list: StageStep[], say: (x: StageStep) => [MarkKind, string]) => list.length ? list.map(say) : null;
  return [
    steps(r.search, said),
    r.links ? [["done", plural(r.links, "link")]] : null,
    steps(r.check, said),
    steps(r.get, x => x.is === "sent" ? ["sent", `sent${x.bytes ? ` ${bytes(x.bytes)}` : ""}${times(x.n)}`] : ["refused", `refused${times(x.n)}`]),
  ];
}
/** A step in a study's time order: its mark, and a word or two. Retrieval's bytes add up across the studies on its line. */
function stepSay(x: TimedStep, sum: number): [MarkKind, string] {
  if (x.stage === "link") return ["done", x.n === 1 ? "link made" : `${num(x.n)} links made`];
  if (x.stage === "get") return x.is === "sent" ? ["sent", `sent${sum ? ` ${bytes(sum)}` : ""}${times(x.n)}`] : ["refused", `refused${times(x.n)}`];
  return said(x);
}

type Href = (changes: Changes) => string;

function StudyRow({ r, href }: { r: FlowStudy; href: Href }) {
  const st = stagesOf(r), reached = st.map((x, i) => x ? i : -1).filter(i => i >= 0);
  const first = reached[0] ?? 0, last = reached.at(-1) ?? 0;
  return (
    <li className={`fl-row end-${r.end}`}>
      <LogLink className="fl-study" to={href({ study: r.study, type: null })}><b>{r.title}</b>{r.site && <span>{r.site}</span>}</LogLink>
      {st.map((x, i) => {
        // The line between stages: in from the one before, out to the next.
        const line = `${i > first && i <= last ? " in" : ""}${i >= first && i < last ? " out" : ""}`;
        const words = x ? x.map(([, w]) => w).join(", then ") : "didn't happen", say = `${STAGES[i]!.name}: ${words}`;
        return (
          <LogLink key={i} className={`fl-cell${line}${x ? "" : " none"}${x?.at(-1)?.[0] === "refused" ? " stopped" : ""}`} to={href({ study: r.study, type: STAGES[i]!.type })} aria-label={say} title={say}>
            {x ? <><span className="fl-marks">{x.map(([k], j) => <Dot key={j} kind={k} />)}</span><span className="fl-word">{words}</span></> : <span className="fl-none" aria-hidden="true" />}
          </LogLink>
        );
      })}
    </li>
  );
}

function Grid({ studies, href }: { studies: FlowStudy[]; href: Href }) {
  return (
    <div className="fl-grid-wrap">
      <ol className="fl-grid" aria-label="Each study's path: search, link, check, retrieve">
        <li className="fl-head" aria-hidden="true"><span />{STAGES.map(st => <span key={st.id}><b>{st.name}</b>{st.party}</span>)}</li>
        {studies.map(r => <StudyRow key={r.study} r={r} href={href} />)}
      </ol>
      <p className="fl-key"><span className="fl-key-none"><span className="fl-none" />didn't happen</span> <span className="fl-key-line"><i />went on to the next stage</span> <span className="fl-key-line dotted"><i />skipped a stage</span></p>
    </div>
  );
}

/** Studies whose steps came out the same share a line. */
function groupsOf(studies: FlowStudy[]) {
  const groups = new Map<string, FlowStudy[]>();
  for (const r of studies) {
    const key = r.steps.map(x => `${x.stage}:${x.is}:${x.n}`).join(" ");
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.values()];
}

function Group({ rs, href }: { rs: FlowStudy[]; href: Href }) {
  const one = rs[0]!;
  return (
    <li>
      {rs.length === 1
        ? <LogLink className="fl-who" to={href({ study: one.study, type: null })}><b>{one.title}</b><span>{one.site ?? ""}</span></LogLink>
        : <div className="fl-who"><b>{plural(rs.length, "study", "studies")}</b><span>{[...new Set(rs.map(r => r.site).filter(Boolean))].join(", ")}</span></div>}
      <ol className="fl-chain">{one.steps.map((x, i) => {
        const sum = x.stage === "get" ? rs.reduce((t, r) => t + (r.steps[i]?.bytes ?? 0), 0) : 0;
        const [k, w] = stepSay(x, sum);
        return <li key={i} className={`fl-step ${k}`}><small>{STAGE_NAME[x.stage]}</small><span><Dot kind={k} />{w}</span></li>;
      })}</ol>
    </li>
  );
}

const KEY: [MarkKind, string][] = [["done", "happened"], ["sent", "sent to the app"], ["refused", "refused"], ["withheld", "withheld from the app"], ["gone", "not found by a later search"]];

export function Flow({ f, words, href, when }: { f: SessionFlow; words: EventWords; href: Href; when: (at: number) => string }) {
  const b = f.other, wrote = Object.values(b.writes).reduce((t, n) => t + n, 0);
  const start = f.phases[0]?.from;
  const any = f.phases.some(p => p.studies.length);
  return <>
    <figcaption>
      <span className="fl-title">How each study went</span>
      <span className="fl-sum">{f.ends.length ? `When the session ended, of ${plural(f.ends.length, "study", "studies")}: ${endsLine(f.ends)}` : "No study yet"}</span>
    </figcaption>
    {(b.tokens || b.referrals || wrote || b.refusedWrites) ? <p className="fl-other"><span>Also in this session:</span>{" "}
      {b.tokens > 0 && <LogLink to={href({ type: "tokens" })}>{plural(b.tokens, "token")} issued</LogLink>}
      {b.referrals > 0 && <LogLink to={href({ type: "referrals" })}>{plural(b.referrals, "referral")} checked{b.refusedReferrals ? `, ${num(b.refusedReferrals)} not on the server` : ""}</LogLink>}
      {wrote > 0 && <LogLink to={href({ type: "writes" })}>{plural(wrote, "policy change")}</LogLink>}
      {b.refusedWrites > 0 && <LogLink to={href({ type: "writes" })}>{plural(b.refusedWrites, "write")} refused</LogLink>}
    </p> : null}
    {any && <>
      <ol className="fl-cards">{f.phases.map((p, i) => {
        const changes = p.writes.map(d => { const w = words.written(d); return `${w.what}${Array.isArray(d.body?.sites) ? `, at ${w.sites}` : ""}`; });
        const did = (stage: Stage) => p.studies.some(r => r.steps.some(x => x.stage === stage));
        const title = changes.length ? changes.join("; ") : did("get") ? "The app searches and retrieves" : did("check") ? "The app searches and asks for studies" : "The app searches";
        // Later cards say how long after the first they began: a tour's run takes seconds.
        const gap = p.from && start ? p.from - start : 0;
        const at = !p.from ? "" : i === 0 || gap >= 60000 ? when(p.from) : gap < 1000 ? "a moment later" : `${Math.round(gap / 1000)} s later`;
        return (
          <li className="fl-card" key={i}>
            <p className="fl-when">{at && <time>{at}</time>}</p>
            <div className="fl-body">
              <p className="fl-kicker">{i === 0 ? "At first" : "Then"}{at && <> <time className="k-time">{at}</time></>}</p>
              <h3>{title}</h3>
              <p className="fl-outcome">{p.studies.length ? endsLine(p.studies.map(r => r.end)) : "Nothing reached a study after this."}</p>
              {p.studies.length > 0 && <>
                <ul className="fl-groups">{groupsOf(p.studies).map(rs => <Group key={rs[0]!.study} rs={rs} href={href} />)}</ul>
                <details className="fl-more"><summary>Each study, stage by stage</summary><Grid studies={p.studies} href={href} /></details>
              </>}
            </div>
          </li>
        );
      })}</ol>
      <p className="fl-key">{KEY.map(([k, w]) => <span className="fl-key-item" key={k}><Dot kind={k} words={w} /></span>)}</p>
    </>}
  </>;
}
