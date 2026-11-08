// The layer chain, one component everywhere it appears: a patient's studies as frames, grouped by
// site, and one row per link of policy, each letting through the same frames or fewer. A row's mark
// says its level: a square for a fact, a diamond for organization policy, a circle for a choice. A
// frame a label cuts out shows as a cut only in a chain the server sent for a narrator.
const Layers = (() => {
  const LEVEL = { fact: "Fact", policy: "Organization policy", choice: "Choice" };
  const SHAPE = {
    fact: `<rect x="2" y="2" width="10" height="10" rx="1.5"/>`,
    policy: `<path d="M7 1.2 12.8 7 7 12.8 1.2 7Z"/>`,
    choice: `<circle cx="7" cy="7" r="5.4"/>`,
  };
  const mark = level => `<svg class="ly-mark ${esc(level)}" viewBox="0 0 14 14" role="img" aria-label="${esc(LEVEL[level] ?? level)}"><title>${esc(LEVEL[level] ?? level)}</title>${SHAPE[level] ?? ""}</svg>`;
  const siteWord = site => site ? site.split(" ")[0] : "No site";

  /** Groups the chain's columns by site, in their order. */
  function groups(columns) {
    const out = [];
    for (const c of columns) { const g = out.at(-1); if (g && g.site === c.site) g.cols.push(c); else out.push({ site: c.site, cols: [c] }); }
    return out;
  }
  /**
   * One chain as HTML. `film` draws it on a film sheet. `compact` leaves out each row's detail line.
   * `label` names the whole figure for assistive technology.
   */
  function chain(c, { film = false, compact = false, label = "How access narrows" } = {}) {
    if (!c?.columns?.length) return "";
    const gs = groups(c.columns), total = c.columns.length;
    const sites = `<div class="ly-sites" aria-hidden="true">${gs.map(g => `<span style="flex-grow:${g.cols.length}" title="${esc(g.site ?? "")}">${esc(siteWord(g.site))}</span>`).join("")}</div>`;
    const rows = c.rows.map(r => {
      const has = new Set(r.has), cut = new Set(r.cut ?? []);
      const names = c.columns.filter(x => has.has(x.id)).map(x => x.title);
      const cells = gs.map(g => `<span class="ly-group" style="flex-grow:${g.cols.length}">${g.cols.map(x => {
        const state = has.has(x.id) ? "on" : cut.has(x.id) ? "cut" : "off";
        return `<i class="ly-cell ${state}" title="${esc(`${x.title}${state === "cut" ? ", cut out by a label" : state === "off" ? ", not let through" : ""}`)}"></i>`;
      }).join("")}</span>`).join("");
      const count = r.kind === "records" ? plural(total, "study", "studies") : `${has.size} of ${total}`;
      return `<li class="ly-row ${esc(r.level)} ${has.size ? "" : "none"}">
        <span class="ly-head">${mark(r.level)}<span class="ly-name">${esc(r.name)}</span><span class="ly-count">${esc(count)}</span></span>
        ${!compact && r.detail ? `<span class="ly-detail">${esc(r.detail)}</span>` : ""}
        <span class="ly-cells" aria-hidden="true">${cells}</span>
        <span class="sr-only">${esc(names.length ? `Lets through ${names.join(", ")}.` : "Lets nothing through.")}${cut.size ? ` ${plural(cut.size, "study", "studies")} cut out by a label.` : ""}</span></li>`;
    }).join("");
    return `<figure class="layers ${film ? "film" : ""}" aria-label="${esc(label)}">${sites}<ol class="ly-rows">${rows}</ol></figure>`;
  }
  /** The three levels' marks, with their names. */
  const legend = (film = false) => `<ul class="ly-legend ${film ? "film" : ""}" aria-label="Levels of policy">${["fact", "policy", "choice"].map(l => `<li>${mark(l)}<span>${esc(LEVEL[l])}</span></li>`).join("")}</ul>`;
  return { chain, legend, mark, LEVEL };
})();
