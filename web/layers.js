// The layer chain, one component everywhere it appears. Each row is a sentence: a fact on file (a
// square), a rule the imaging network set (a diamond), or a choice a person made (a circle), hollow
// when it's missing. Under each sentence, one box per study, in the column of the site that holds it,
// filled when the row includes the study. The last row is the outcome. A study keeps its column on
// every row, so a reader sees which studies survive to the outcome.
const Layers = (() => {
  const LEVEL = { fact: "Fact on file", policy: "Imaging network rule", choice: "A person's choice", outcome: "The result", links: "Study links already given out" };
  const SHAPE = {
    fact: `<rect x="2" y="2" width="10" height="10" rx="1.5"/>`,
    policy: `<path d="M7 1.2 12.8 7 7 12.8 1.2 7Z"/>`,
    choice: `<circle cx="7" cy="7" r="5.2"/>`,
    outcome: `<path d="M1.5 4.2h11v2h-11zM1.5 7.8h11v2h-11z"/>`,
    links: `<path d="M7 1.2a5.8 5.8 0 1 0 0 11.6A5.8 5.8 0 0 0 7 1.2Zm0 1.6a4.2 4.2 0 1 1 0 8.4 4.2 4.2 0 0 1 0-8.4ZM6.3 4v3.4l2.6 1.6.7-1.1-2-1.2V4Z"/>`,
  };
  /** The clock on a study whose link still works, until it expires. */
  const CLOCK = `<svg class="ly-clock" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 1.2a5.8 5.8 0 1 0 0 11.6A5.8 5.8 0 0 0 7 1.2Zm0 1.6a4.2 4.2 0 1 1 0 8.4 4.2 4.2 0 0 1 0-8.4ZM6.3 4v3.4l2.6 1.6.7-1.1-2-1.2V4Z"/></svg>`;
  const LOCK = `<svg class="ly-lock" viewBox="0 0 10 12" aria-hidden="true"><path d="M2.5 5V3.6a2.5 2.5 0 0 1 5 0V5h.7c.4 0 .8.4.8.8v4.4c0 .4-.4.8-.8.8H1.8c-.4 0-.8-.4-.8-.8V5.8c0-.4.4-.8.8-.8zm1.3 0h2.4V3.6a1.2 1.2 0 0 0-2.4 0z"/></svg>`;
  const mark = (level, missing = false) => `<svg class="ly-mark ${esc(level)} ${missing ? "missing" : ""}" viewBox="0 0 14 14" role="img" aria-label="${esc(missing ? `Missing: ${(LEVEL[level] ?? level).toLowerCase()}` : LEVEL[level] ?? level)}"><title>${esc(missing ? `Missing ${(LEVEL[level] ?? level).toLowerCase()}` : LEVEL[level] ?? level)}</title>${SHAPE[level] ?? ""}</svg>`;
  const studies = n => `${n} ${n === 1 ? "study" : "studies"}`;

  /** Groups the chain's columns by site, in their order. */
  function groups(columns) {
    const out = [];
    for (const c of columns) { const g = out.at(-1); if (g && g.site === c.site) g.cols.push(c); else out.push({ site: c.site, cols: [c] }); }
    return out;
  }
  /** The star that tells the cited study's box apart from others of its kind, here and in its row's sentence. */
  const STAR = `<span class="ly-star" aria-hidden="true">★</span>`;
  const box = (x, state, level) => `<span class="ly-box ${state} ${x.locked ? "locked" : ""} ${x.cited ? "cited" : ""}" role="img" aria-label="${esc(`${x.title}${x.locked ? ", labeled confidential" : ""}${x.cited ? ", the study the referral cites" : ""}: ${state === "on" ? "included" : state === "linked" ? "its link works until it expires" : "not included"}`)}" title="${esc(`${x.title}${x.locked ? " (labeled confidential)" : ""}`)}">${esc(x.modality ?? "")}${x.locked ? LOCK : ""}${x.cited ? STAR : ""}${state === "linked" ? CLOCK : ""}</span>`;
  /** A group's width: its boxes, or for one box, enough for a site's name to wrap in. */
  const groupStyle = g => `style="--n:${g.cols.length}"`;

  /**
   * One chain as HTML. `film` draws it on a film sheet. `label` names the whole figure for assistive
   * technology. Rows that hold no study have no boxes.
   */
  function chain(c, { film = false, label = "Why the app sees what it sees" } = {}) {
    if (!c?.rows?.length) return "";
    const gs = groups(c.columns ?? []), total = c.columns?.length ?? 0;
    const boxes = gs.length > 0;
    const sites = boxes ? `<div class="ly-sites" aria-hidden="true">${gs.map(g => `<span class="ly-site" ${groupStyle(g)}>${esc(g.site ?? "No site")}</span>`).join("")}</div>` : "";
    const rows = c.rows.map(r => {
      const has = new Set(r.has);
      // Study links already given out are a second outcome: what still works, until it expires.
      const links = r.kind === "links", outcome = r.level === "outcome" && !links;
      const count = outcome ? (c.viewer ? studies(has.size) : `${has.size} of ${studies(total)}`)
        : links ? (c.viewer ? studies(has.size) : `${has.size} of ${studies(total)}`)
        : c.viewer || r.boxes === false || ["records", "label", "referral"].includes(r.kind) || r.missing ? "" : `${has.size} of ${studies(total)}`;
      const cells = boxes && r.boxes !== false ? `<span class="ly-boxes">${gs.map(g => `<span class="ly-group" ${groupStyle(g)}>${g.cols.map(x => box(x, has.has(x.id) ? (links ? "linked" : "on") : "off", r.level)).join("")}</span>`).join("")}</span>` : "";
      return `<li class="ly-row ${esc(r.level)} ${links ? "links" : ""} ${r.missing ? "missing" : ""} ${cells ? "" : "bare"}">
        <span class="ly-say">${mark(links ? "links" : r.level, r.missing)}<span class="ly-name">${esc(outcome ? `${r.name}:` : r.name)}${r.kind === "referral" ? ` ${STAR}` : ""}${outcome ? ` <b class="ly-total">${esc(count)}</b>` : ""}</span>${!outcome && count ? `<span class="ly-count">${esc(count)}</span>` : ""}</span>
        ${cells}</li>`;
    }).join("");
    return `<figure class="layers ${film ? "film" : ""}" aria-label="${esc(label)}"><div class="ly-sheet">${sites}<ol class="ly-rows">${rows}</ol></div></figure>`;
  }
  /** Chains side by side, each under its own label, such as before and after a change. */
  const chains = (list, opts = {}) => list.length === 1 && !list[0].label ? chain(list[0].chain, opts)
    : `<div class="ly-pair">${list.map(x => `<div class="ly-pane"><p class="ly-pane-label">${esc(x.label)}</p>${chain(x.chain, { ...opts, label: `${x.label}: ${opts.label ?? "why the app sees what it sees"}` })}</div>`).join("")}</div>`;
  /**
   * What the marks and boxes mean, in one compact key. `locked` adds the confidential label's mark,
   * for a narrator's chain that shows one.
   */
  function legend({ film = false, locked = false, cited = false, linked = false } = {}) {
    const sample = (state, extra = "") => `<span class="ly-box ${state} ${extra}" aria-hidden="true">${extra === "cited" ? "CR" : "MR"}${extra === "locked" ? LOCK : extra === "cited" ? STAR : ""}${state === "linked" ? CLOCK : ""}</span>`;
    const L = film ? "layers film" : "layers";
    return `<div class="ly-legend ${film ? "film" : ""}" role="note" aria-label="How to read these diagrams">
      <ul>${["fact", "policy", "choice"].map(l => `<li>${mark(l)}<span>${esc(LEVEL[l])}</span></li>`).join("")}<li>${mark("policy", true)}${mark("choice", true)}<span>Hollow: a rule or choice that isn't there</span></li><li>${mark("outcome")}<span>Last row: the result, what the rules and choices above all allow</span></li></ul>
      <ul><li><span class="${L} ly-samples"><span class="ly-row fact">${sample("on")}</span><span class="ly-row policy">${sample("on")}</span><span class="ly-row choice">${sample("on")}</span></span><span>A study the row includes, in the row's color</span></li><li><span class="layers ${film ? "film" : ""}"><span class="ly-row outcome">${sample("on")}</span></span><span>A study in the result</span></li>${linked ? `<li><span class="${L}"><span class="ly-row outcome links">${sample("linked")}</span></span><span>A study whose link the app already had: it works until the link expires</span></li>` : ""}<li><span class="layers ${film ? "film" : ""}"><span class="ly-row fact">${sample("off")}</span></span><span>A study the row leaves out</span></li>${locked ? `<li><span class="layers ${film ? "film" : ""}"><span class="ly-row fact">${sample("off", "locked")}</span></span><span>Labeled confidential</span></li>` : ""}${cited ? `<li><span class="${L}"><span class="ly-row fact">${sample("off", "cited")}</span></span><span>The study a referral cites</span></li>` : ""}</ul>
      <p>Each box is one study, marked with its kind of image (MR: MRI, CR: X-ray, which titles call XR, CT: CT scan, SM: pathology slide), under the site that holds it. The imaging network is the organization that runs these sites and sets the rules.</p></div>`;
  }
  return { chain, chains, legend, mark, LEVEL };
})();
