// The layer chain, one component everywhere it appears. Each row is a sentence: a fact on file (a
// square), a rule the imaging network set (a diamond), or a choice a person made (a circle), hollow
// when it's missing. Under each sentence, one box per study, in the column of the site that holds it,
// filled when the row includes the study. The last row is the outcome. A study keeps its column on
// every row, so a reader sees which studies survive to the outcome.
const Layers = (() => {
  const LEVEL = { fact: "Fact on file", policy: "Imaging network rule", choice: "A person's choice", outcome: "The result" };
  const SHAPE = {
    fact: `<rect x="2" y="2" width="10" height="10" rx="1.5"/>`,
    policy: `<path d="M7 1.2 12.8 7 7 12.8 1.2 7Z"/>`,
    choice: `<circle cx="7" cy="7" r="5.2"/>`,
    outcome: `<path d="M1.5 4.2h11v2h-11zM1.5 7.8h11v2h-11z"/>`,
  };
  const LOCK = `<svg class="ly-lock" viewBox="0 0 10 12" aria-hidden="true"><path d="M2.5 5V3.6a2.5 2.5 0 0 1 5 0V5h.7c.4 0 .8.4.8.8v4.4c0 .4-.4.8-.8.8H1.8c-.4 0-.8-.4-.8-.8V5.8c0-.4.4-.8.8-.8zm1.3 0h2.4V3.6a1.2 1.2 0 0 0-2.4 0z"/></svg>`;
  const mark = (level, missing = false) => `<svg class="ly-mark ${esc(level)} ${missing ? "missing" : ""}" viewBox="0 0 14 14" role="img" aria-label="${esc(missing ? `Missing: ${(LEVEL[level] ?? level).toLowerCase()}` : LEVEL[level] ?? level)}"><title>${esc(missing ? `Missing ${(LEVEL[level] ?? level).toLowerCase()}` : LEVEL[level] ?? level)}</title>${SHAPE[level] ?? ""}</svg>`;
  const studies = n => `${n} ${n === 1 ? "study" : "studies"}`;

  /** Groups the chain's columns by site, in their order. */
  function groups(columns) {
    const out = [];
    for (const c of columns) { const g = out.at(-1); if (g && g.site === c.site) g.cols.push(c); else out.push({ site: c.site, cols: [c] }); }
    return out;
  }
  const box = (x, state, level) => `<span class="ly-box ${state} ${x.locked ? "locked" : ""}" role="img" aria-label="${esc(`${x.title}${x.locked ? ", labeled confidential" : ""}: ${state === "on" ? "included" : "not included"}`)}" title="${esc(`${x.title}${x.locked ? " (labeled confidential)" : ""}`)}">${esc(x.modality ?? "")}${x.locked ? LOCK : ""}</span>`;
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
      const outcome = r.level === "outcome";
      const count = outcome ? (c.viewer ? studies(has.size) : `${has.size} of ${studies(total)}`)
        : c.viewer || r.boxes === false || ["records", "label", "referral"].includes(r.kind) || r.missing ? "" : `${has.size} of ${studies(total)}`;
      const cells = boxes && r.boxes !== false ? `<span class="ly-boxes">${gs.map(g => `<span class="ly-group" ${groupStyle(g)}>${g.cols.map(x => box(x, has.has(x.id) ? "on" : "off", r.level)).join("")}</span>`).join("")}</span>` : "";
      return `<li class="ly-row ${esc(r.level)} ${r.missing ? "missing" : ""} ${cells ? "" : "bare"}">
        <span class="ly-say">${mark(r.level, r.missing)}<span class="ly-name">${esc(outcome ? `${r.name}:` : r.name)}${outcome ? ` <b class="ly-total">${esc(count)}</b>` : ""}</span>${!outcome && count ? `<span class="ly-count">${esc(count)}</span>` : ""}</span>
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
  function legend({ film = false, locked = false } = {}) {
    const sample = (state, extra = "") => `<span class="ly-box ${state} ${extra}" aria-hidden="true">MR${extra ? LOCK : ""}</span>`;
    return `<div class="ly-legend ${film ? "film" : ""}" role="note" aria-label="How to read these diagrams">
      <ul>${["fact", "policy", "choice"].map(l => `<li>${mark(l)}<span>${esc(LEVEL[l])}</span></li>`).join("")}<li>${mark("policy", true)}<span>Hollow: missing</span></li><li>${mark("outcome")}<span>Last row: the result</span></li></ul>
      <ul><li><span class="layers"><span class="ly-row fact">${sample("on")}</span></span><span>A study the row includes</span></li><li><span class="layers"><span class="ly-row fact">${sample("off")}</span></span><span>A study it leaves out</span></li>${locked ? `<li><span class="layers"><span class="ly-row fact">${sample("off", "locked")}</span></span><span>Labeled confidential</span></li>` : ""}</ul>
      <p>Each box is one study, marked with its kind of image (MR: MRI, CR: X-ray, CT: CT scan, SM: pathology slide), under the site that holds it. The imaging network is the organization that runs these sites and sets the rules.</p></div>`;
  }
  return { chain, chains, legend, mark, LEVEL };
})();
