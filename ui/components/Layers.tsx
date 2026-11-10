// The layer chain, one component everywhere it appears. Each row is a sentence: a fact on file (a square), a
// rule the imaging network set (a diamond), or a choice a person made (a circle), hollow when it's missing.
// Under each sentence, one box per study, in the column of the site that holds it, filled when the row includes
// the study. The last row is the outcome. A study keeps its column on every row, so a reader sees which studies
// survive to the outcome.
import type { CSSProperties, ReactNode } from "react";

export type Level = "fact" | "policy" | "choice" | "outcome" | "links";
export const LEVEL: Record<Level, string> = { fact: "Fact on file", policy: "Imaging network rule", choice: "A person's choice", outcome: "The result", links: "Study links already given out" };

/** A study's column: the site that holds it, its kind of image, and whether it's labeled or cited. */
export interface ChainColumn { id: string; site?: string; title: string; modality?: string; locked?: boolean; cited?: boolean }
export interface ChainRow { level: Level; kind?: string; name: string; has: string[]; missing?: boolean; boxes?: boolean }
/** A chain as the server explains it. `viewer` says the studies are only what the viewer may know of. */
export interface LayerChain { rows: ChainRow[]; columns?: ChainColumn[]; viewer?: boolean }

const SHAPE: Record<Level, ReactNode> = {
  fact: <rect x="2" y="2" width="10" height="10" rx="1.5" />,
  policy: <path d="M7 1.2 12.8 7 7 12.8 1.2 7Z" />,
  choice: <circle cx="7" cy="7" r="5.2" />,
  outcome: <path d="M1.5 4.2h11v2h-11zM1.5 7.8h11v2h-11z" />,
  links: <path d="M7 1.2a5.8 5.8 0 1 0 0 11.6A5.8 5.8 0 0 0 7 1.2Zm0 1.6a4.2 4.2 0 1 1 0 8.4 4.2 4.2 0 0 1 0-8.4ZM6.3 4v3.4l2.6 1.6.7-1.1-2-1.2V4Z" />,
};
/** The clock on a study whose link still works, until it expires. */
const Clock = () => <svg className="ly-clock" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 1.2a5.8 5.8 0 1 0 0 11.6A5.8 5.8 0 0 0 7 1.2Zm0 1.6a4.2 4.2 0 1 1 0 8.4 4.2 4.2 0 0 1 0-8.4ZM6.3 4v3.4l2.6 1.6.7-1.1-2-1.2V4Z" /></svg>;
const Lock = () => <svg className="ly-lock" viewBox="0 0 10 12" aria-hidden="true"><path d="M2.5 5V3.6a2.5 2.5 0 0 1 5 0V5h.7c.4 0 .8.4.8.8v4.4c0 .4-.4.8-.8.8H1.8c-.4 0-.8-.4-.8-.8V5.8c0-.4.4-.8.8-.8zm1.3 0h2.4V3.6a1.2 1.2 0 0 0-2.4 0z" /></svg>;
/** The star that tells the cited study's box apart from others of its kind, here and in its row's sentence. */
const Star = () => <span className="ly-star" aria-hidden="true">★</span>;

export function Mark({ level, missing = false }: { level: Level; missing?: boolean }) {
  const name = LEVEL[level] ?? level;
  return (
    <svg className={`ly-mark ${level} ${missing ? "missing" : ""}`} viewBox="0 0 14 14" role="img" aria-label={missing ? `Missing: ${name.toLowerCase()}` : name}>
      <title>{missing ? `Missing ${name.toLowerCase()}` : name}</title>
      {SHAPE[level]}
    </svg>
  );
}

const studies = (n: number) => `${n} ${n === 1 ? "study" : "studies"}`;
/** The chain's columns, grouped by site, in their order. */
function groups(columns: ChainColumn[]) {
  const out: { site?: string; cols: ChainColumn[] }[] = [];
  for (const c of columns) { const g = out.at(-1); if (g && g.site === c.site) g.cols.push(c); else out.push({ site: c.site, cols: [c] }); }
  return out;
}
/** A group's width: its boxes, or for one box, enough for a site's name to wrap in. */
const groupStyle = (n: number) => ({ "--n": n }) as CSSProperties;

type BoxState = "on" | "off" | "linked";
function Box({ x, state }: { x: ChainColumn; state: BoxState }) {
  const label = `${x.title}${x.locked ? ", labeled confidential" : ""}${x.cited ? ", the study the referral cites" : ""}: ${state === "on" ? "included" : state === "linked" ? "its link works until it expires" : "not included"}`;
  return (
    <span className={`ly-box ${state} ${x.locked ? "locked" : ""} ${x.cited ? "cited" : ""}`} role="img" aria-label={label} title={`${x.title}${x.locked ? " (labeled confidential)" : ""}`}>
      {x.modality ?? ""}{x.locked && <Lock />}{x.cited && <Star />}{state === "linked" && <Clock />}
    </span>
  );
}

/** One chain. `film` draws it on a film sheet. `label` names the whole figure for assistive technology. Rows that hold no study have no boxes. */
export function Chain({ c, film = false, label = "Why the app sees what it sees" }: { c?: LayerChain; film?: boolean; label?: string }) {
  if (!c?.rows?.length) return null;
  const gs = groups(c.columns ?? []), total = c.columns?.length ?? 0, boxes = gs.length > 0;
  return (
    <figure className={`layers ${film ? "film" : ""}`} aria-label={label}>
      <div className="ly-sheet">
        {boxes && <div className="ly-sites" aria-hidden="true">{gs.map((g, i) => <span key={i} className="ly-site" style={groupStyle(g.cols.length)}>{g.site ?? "No site"}</span>)}</div>}
        <ol className="ly-rows">
          {c.rows.map((r, i) => {
            const has = new Set(r.has);
            // Study links already given out are a second outcome: what still works, until it expires.
            const links = r.kind === "links", outcome = r.level === "outcome" && !links;
            const ofTotal = c.viewer ? studies(has.size) : `${has.size} of ${studies(total)}`;
            const count = outcome || links ? ofTotal : c.viewer || r.boxes === false || ["records", "label", "referral"].includes(r.kind ?? "") || r.missing ? "" : ofTotal;
            const cells = boxes && r.boxes !== false;
            return (
              <li key={i} className={`ly-row ${r.level} ${links ? "links" : ""} ${r.missing ? "missing" : ""} ${cells ? "" : "bare"}`}>
                <span className="ly-say">
                  <Mark level={links ? "links" : r.level} missing={r.missing} />
                  <span className="ly-name">{outcome ? `${r.name}:` : r.name}{r.kind === "referral" && <> <Star /></>}{outcome && <> <b className="ly-total">{count}</b></>}</span>
                  {!outcome && count && <span className="ly-count">{count}</span>}
                </span>
                {cells && <span className="ly-boxes">{gs.map((g, gi) => <span key={gi} className="ly-group" style={groupStyle(g.cols.length)}>{g.cols.map(x => <Box key={x.id} x={x} state={has.has(x.id) ? (links ? "linked" : "on") : "off"} />)}</span>)}</span>}
              </li>
            );
          })}
        </ol>
      </div>
    </figure>
  );
}

/** Chains side by side, each under its own label, such as before and after a change. */
export function Chains({ list, film, label }: { list: { label?: string; chain: LayerChain }[]; film?: boolean; label?: string }) {
  if (list.length === 1 && !list[0]!.label) return <Chain c={list[0]!.chain} film={film} label={label} />;
  return (
    <div className="ly-pair">
      {list.map((x, i) => <div className="ly-pane" key={i}><p className="ly-pane-label">{x.label}</p><Chain c={x.chain} film={film} label={`${x.label}: ${label ?? "why the app sees what it sees"}`} /></div>)}
    </div>
  );
}

/** What the marks and boxes mean, in one compact key. `locked`, `cited` and `linked` add those marks, for a chain that shows them. */
export function Legend({ film = false, locked = false, cited = false, linked = false }: { film?: boolean; locked?: boolean; cited?: boolean; linked?: boolean }) {
  const Sample = ({ state, extra = "" }: { state: BoxState; extra?: "" | "locked" | "cited" }) => (
    <span className={`ly-box ${state} ${extra}`} aria-hidden="true">{extra === "cited" ? "CR" : "MR"}{extra === "locked" && <Lock />}{extra === "cited" && <Star />}{state === "linked" && <Clock />}</span>
  );
  const L = film ? "layers film" : "layers";
  return (
    <div className={`ly-legend ${film ? "film" : ""}`} role="note" aria-label="How to read these diagrams">
      <ul>
        {(["fact", "policy", "choice"] as const).map(l => <li key={l}><Mark level={l} /><span>{LEVEL[l]}</span></li>)}
        <li><Mark level="policy" missing /><Mark level="choice" missing /><span>Hollow: a rule or choice that isn't there</span></li>
        <li><Mark level="outcome" /><span>Below the line: the result, what the rules and choices above all allow</span></li>
      </ul>
      <ul>
        <li><span className={`${L} ly-samples`}><span className="ly-row fact"><Sample state="on" /></span><span className="ly-row policy"><Sample state="on" /></span><span className="ly-row choice"><Sample state="on" /></span></span><span>A study the row includes, in the row's color</span></li>
        <li><span className={L}><span className="ly-row outcome"><Sample state="on" /></span></span><span>A study in the result</span></li>
        {linked && <li><span className={L}><span className="ly-row outcome links"><Sample state="linked" /></span></span><span>A study whose link the app already had: it works until the link expires</span></li>}
        <li><span className={L}><span className="ly-row fact"><Sample state="off" /></span></span><span>A study the row leaves out</span></li>
        {locked && <li><span className={L}><span className="ly-row fact"><Sample state="off" extra="locked" /></span></span><span>Labeled confidential</span></li>}
        {cited && <li><span className={L}><span className="ly-row fact"><Sample state="off" extra="cited" /></span></span><span>The study a referral cites</span></li>}
      </ul>
      <p>Each box is one study, marked with its kind of image (MR: MRI, CR: X-ray, which titles call XR, CT: CT scan, SM: pathology slide), under the site that holds it. The imaging network is the organization that runs these sites and sets the rules.</p>
    </div>
  );
}
