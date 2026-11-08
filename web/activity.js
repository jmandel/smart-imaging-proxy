// The activity log: one tile of rolled-up numbers per type of event, a timeline laned by party, one
// row per session, a session's studies each with its path through search, link, check and retrieval, and a table per type whose rows open the event in full. Filters live in the query
// string, so Explore and the tours link here already filtered. With a session, everything on the page
// is what that session's viewer may see. With none, it's the operator's view of every session.
const W = EventWords;
const TYPES = {
  tokens: { name: "Tokens issued", cols: ["Time", "Who", "Client", "How", "Scope", "Lasts", "Token"] },
  referrals: { name: "Referrals checked", cols: ["Time", "Service", "Patient reference", "Accession", "Result"] },
  searches: { name: "Searches", cols: ["Time", "Who", "Status", "Returned", "Withheld", "Query"] },
  links: { name: "Signed links made", cols: ["Time", "Study", "Form", "Series", "Expires", "Key"] },
  checks: { name: "Proxy checks", cols: ["Time", "Study", "How", "Result", "Why"] },
  retrievals: { name: "Retrievals", cols: ["Time", "Study", "Form", "Status", "Parts", "Bytes", "Encoding", "Decided by", "ms"] },
  decisions: { name: "Policy decisions", cols: ["Time", "Study", "Who", "Decision", "Why"] },
  writes: { name: "Policy writes", cols: ["Time", "What", "Level", "Status"] },
  problems: { name: "Errors and denials", cols: ["Time", "Type", "Party", "Summary"] },
};
const ALL_COLS = ["Time", "Type", "Party", "Summary"];
const KIND_WORDS = { "token.issued": "Token issued", "referral.checked": "Referral checked", "search.returned": "Search", "context.signed": "Signed link", "decision.answered": "Policy decision", "proxy.fast-path": "Proxy check", "proxy.decision": "Proxy check", "stream.done": "Retrieval", "retrieval.answered": "Retrieval", "policy.written": "Policy write" };
const PARTY = { "authorization-server": "Authorization Server", "imaging-fhir": "Imaging Server", policy: "Imaging Server policy", "dicomweb-proxy": "Proxy", app: "App" };
const AUTHZ = { instant: "signed link", cached: "cached answer", asked: "asked the Imaging Server", "no token": "no token" };
const LEVELS = { fact: "facts", policy: "organization policy", choice: "choices", settings: "settings", document: "whole document", reset: "resets" };

let names = {}, summary = null, events = [], more = false, before = null, openSeq = null;
const q = () => new URLSearchParams(location.search);
const href = (changes) => { const p = q(); for (const [k, v] of Object.entries(changes)) { if (v === null || v === undefined || v === "") p.delete(k); else p.set(k, v); } p.delete("event"); const s = p.toString(); return `${BASE}/activity${s ? `?${s}` : ""}`; };
const num = n => Number(n ?? 0).toLocaleString();
const clientName = c => c ? (names[`app:${c}`]?.replace(/^the /, "") ?? names[`client:${c}`] ?? c) : "";
const whoName = w => w ? W.nameOf(w) : "";
const when = at => { const d = new Date(at), today = new Date().toDateString() === d.toDateString(); return today ? W.time(at) : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${W.time(at)}`; };
const topOf = (m, n = 2, word = k => k) => { const e = Object.entries(m ?? {}).sort((a, b) => b[1] - a[1]); return e.slice(0, n).map(([k, v]) => `${num(v)} ${word(k)}`).join(", ") + (e.length > n ? `, and ${e.length - n} more` : ""); };

// Each tile: its count, a line or two of the numbers that matter, and a split bar where a split says something.
function tileParts(id, t) {
  switch (id) {
    case "tokens": return { lines: [t.count ? topOf(t.byClient, 2, k => `to ${clientName(k)}`) : "None issued"] };
    case "referrals": return { lines: [t.count ? `${num(t.ok)} on the authorized server, ${num(t.refused)} not` : "None checked"], split: [["On the server", t.ok, "a"], ["Not on it", t.refused, "bad"]] };
    case "searches": return { lines: [`${num(t.returned)} ${t.returned === 1 ? "study" : "studies"} returned, ${num(t.withheld)} withheld`, t.refused ? `${num(t.refused)} refused` : ""], split: [["Returned", t.returned, "a"], ["Withheld", t.withheld, "b"]] };
    case "links": return { lines: [t.count ? topOf(t.byForm, 3) : "None made"] };
    case "checks": return { lines: [t.count ? [t.instant && `${num(t.instant)} by the signed link alone`, t.cached && `${num(t.cached)} by a cached answer`, t.asked && `${num(t.asked)} asked the Imaging Server`].filter(Boolean).join(", ") : "None", t.refused ? `${num(t.refused)} refused` : ""], split: [["Signed link alone", t.instant, "a"], ["Cached answer", t.cached, "b"], ["Asked the Imaging Server", t.asked, "c"]] };
    case "retrievals": return { lines: [t.count ? (t.bytes ? `${bytes(t.bytes)} sent to apps` : "Nothing sent") : "None", [t.refused ? `${num(t.refused)} refused` : "", t.cut ? `${num(t.cut)} cut off` : ""].filter(Boolean).join(", ")] };
    case "decisions": return { lines: [`${num(t.allow)} allow, ${num(t.deny)} deny`], split: [["Allow", t.allow, "good"], ["Deny", t.deny, "bad"]] };
    case "writes": return { lines: [t.count ? `${num(t.ok)} written${t.refused ? `, ${num(t.refused)} refused` : ""}` : "None", t.count ? topOf(t.byLevel, 2, k => `to ${LEVELS[k] ?? k}`) : ""] };
    case "problems": return { lines: [`${num(t.denied)} denied, ${num(t.error)} failed`, t.count ? topOf(t.byKind, 2, k => KIND_WORDS[k]?.toLowerCase() ?? k) : ""] };
  }
  return { lines: [] };
}
function splitBar(split) {
  const parts = split.filter(([, v]) => v > 0), total = parts.reduce((n, [, v]) => n + v, 0);
  if (!total || parts.length < 2) return "";
  return `<div class="split" role="img" aria-label="${esc(parts.map(([k, v]) => `${k}: ${v}`).join(", "))}">${parts.map(([k, v, c]) => `<span class="split-seg ${c}" style="flex-grow:${v}" title="${esc(`${k}: ${num(v)}`)}"></span>`).join("")}</div>`;
}
function tilesHtml() {
  const chosen = q().get("type");
  return summary.types.map(id => {
    const t = summary.tiles[id], p = tileParts(id, t);
    return `<li><a class="tile ${t.count ? "" : "zero"} ${id === "problems" && t.count ? "alarm" : ""}" href="${esc(href({ type: id === chosen ? null : id }))}" ${id === chosen ? 'aria-current="true"' : ""} data-type="${id}">
      <span class="tile-name">${esc(TYPES[id].name)}</span><span class="tile-count">${num(t.count)}</span>
      ${p.lines.filter(Boolean).map(l => `<span class="tile-line">${esc(l)}</span>`).join("")}${p.split ? splitBar(p.split) : ""}</a></li>`;
  }).join("");
}

// The timeline: one lane per party, events counted in equal bins of time, with denials and failures on top.
function timelineHtml() {
  const tl = summary.timeline, box = $("#timeline");
  const width = Math.max(300, Math.round(box.clientWidth || 600)), label = width < 480 ? 92 : 150, right = 44;
  const laneH = 38, top = 8, plotW = width - label - right, step = plotW / tl.bins, bar = Math.max(1, Math.min(10, step - 2));
  const max = Math.max(1, ...tl.lanes.flatMap(l => l.counts));
  const h = top + tl.lanes.length * laneH + 26;
  const span = tl.to - tl.from, fmt = at => span > 864e5 ? new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : W.time(at);
  const binText = i => `${fmt(tl.from + i * span / tl.bins)} to ${fmt(tl.from + (i + 1) * span / tl.bins)}`;
  const lanes = tl.lanes.map((l, li) => {
    const base = top + (li + 1) * laneH - 6, total = l.counts.reduce((a, b) => a + b, 0);
    const bars = l.counts.map((n, i) => {
      if (!n) return "";
      const x = label + i * step + (step - bar) / 2, hh = Math.max(2, (n / max) * (laneH - 10)), bad = l.problems[i] ? Math.max(2, (l.problems[i] / n) * hh) : 0;
      return `<g><title>${esc(`${PARTY[l.party]}, ${binText(i)}: ${plural(n, "event")}${l.problems[i] ? `, ${l.problems[i]} denied or failed` : ""}`)}</title>
        <rect class="tl-bar" x="${x.toFixed(1)}" y="${(base - hh).toFixed(1)}" width="${bar.toFixed(1)}" height="${Math.max(0, hh - (bad ? bad + 1 : 0)).toFixed(1)}" rx="1"/>${bad ? `<rect class="tl-bad" x="${x.toFixed(1)}" y="${(base - hh).toFixed(1)}" width="${bar.toFixed(1)}" height="${bad.toFixed(1)}" rx="1"/>` : ""}</g>`;
    }).join("");
    return `<text class="tl-lane" x="0" y="${base - 4}">${esc(PARTY[l.party])}</text><line class="tl-base" x1="${label}" x2="${label + plotW}" y1="${base + .5}" y2="${base + .5}"/>${bars}<text class="tl-total" x="${width}" y="${base - 4}" text-anchor="end">${num(total)}</text>`;
  }).join("");
  const axisY = top + tl.lanes.length * laneH + 14;
  const axis = `<text class="tl-axis" x="${label}" y="${axisY}">${esc(fmt(tl.from))}</text>${plotW > 260 ? `<text class="tl-axis" x="${label + plotW / 2}" y="${axisY}" text-anchor="middle">${esc(fmt(tl.from + span / 2))}</text>` : ""}<text class="tl-axis" x="${label + plotW}" y="${axisY}" text-anchor="end">${esc(fmt(tl.to))}</text>`;
  const desc = tl.lanes.map(l => `${PARTY[l.party]}: ${l.counts.reduce((a, b) => a + b, 0)}`).join(", ");
  return `<figcaption><span>Events over time, by party</span><span class="tl-key"><i class="k-ok"></i>events <i class="k-bad"></i>denied or failed</span></figcaption>
    <svg width="${width}" height="${h}" viewBox="0 0 ${width} ${h}" role="img" aria-labelledby="tl-title tl-desc"><title id="tl-title">Events over time, by party, from ${esc(fmt(tl.from))} to ${esc(fmt(tl.to))}</title><desc id="tl-desc">${esc(desc)}</desc>${lanes}${axis}</svg>`;
}

// A session, study by study: one row per study, its path across the four stages a study goes through,
// and where that path ended. The same marks sum up each session in the list.
const STAGES = [
  { id: "search", name: "Search", party: "Imaging Server", type: "searches" },
  { id: "link", name: "Link", party: "Imaging Server", type: "links" },
  { id: "check", name: "Check", party: "Proxy", type: "checks" },
  { id: "get", name: "Retrieve", party: "Proxy", type: "retrievals" },
];
// Where a study's path ended, in words that read after a count.
const ENDS = { sent: () => "sent", refused: () => "refused", linked: () => "linked, not retrieved", found: n => `found, ${n === 1 ? "no link" : "no links"}`, withheld: () => "withheld", gone: () => "not found by the last search" };
const END_ORDER = ["sent", "refused", "linked", "found", "withheld", "gone"];
// A mark: happened, sent, refused, withheld, or no longer found.
const dot = (kind, words) => `<svg class="fl-mark ${kind}" viewBox="0 0 16 16" aria-hidden="true">${
  kind === "refused" ? `<circle cx="8" cy="8" r="6.5"/><path d="M5.3 5.3l5.4 5.4M10.7 5.3l-5.4 5.4"/>` : kind === "sent" ? `<circle cx="8" cy="8" r="6.5"/><path d="M4.8 8.3l2.2 2.1 4.2-4.6"/>` : `<circle cx="8" cy="8" r="${kind === "done" ? 5 : 5.5}"/>`}</svg>${words ? `<span class="fl-word">${esc(words)}</span>` : ""}`;
function endsLine(ends) {
  const n = {}; for (const e of ends) n[e] = (n[e] ?? 0) + 1;
  return END_ORDER.filter(e => n[e]).map(e => `${num(n[e])} ${ENDS[e](n[e])}`).join(", ");
}
// What each outcome at a stage looks like, and says.
const SAY = {
  found: ["done", "found"], withheld: ["withheld", "withheld"], gone: ["gone", "not found"], unreached: ["gone", "not found"],
  instant: ["done", "link checked"], cached: ["done", "cached yes"], asked: ["done", "policy said yes"], refused: ["refused", "policy said no"], "no answer": ["refused", "no answer"],
};
const times = n => n === 1 ? "" : n === 2 ? " twice" : ` ${n} times`;
// One study's four stages, each its outcomes in order: marks side by side, words joined by "then".
function stagesOf(r) {
  const steps = (list, say) => list.length ? list.map(x => [...say(x)]) : null;
  return [
    steps(r.search, x => [SAY[x.is][0], `${SAY[x.is][1]}${times(x.n)}`]),
    r.links ? [["done", plural(r.links, "link")]] : null,
    steps(r.check, x => [SAY[x.is][0], `${SAY[x.is][1]}${times(x.n)}`]),
    steps(r.get, x => x.is === "sent" ? ["sent", `sent${x.bytes ? ` ${bytes(x.bytes)}` : ""}${times(x.n)}`] : ["refused", `refused${times(x.n)}`]),
  ];
}
function flowHtml() {
  const f = summary.flow;
  if (!f) return "";
  const b = f.other, wrote = Object.entries(b.writes);
  const other = [
    b.tokens && `<a href="${esc(href({ type: "tokens" }))}">${esc(plural(b.tokens, "token"))} issued</a>`,
    b.referrals && `<a href="${esc(href({ type: "referrals" }))}">${esc(plural(b.referrals, "referral"))} checked${b.refusedReferrals ? `, ${num(b.refusedReferrals)} not on the server` : ""}</a>`,
    wrote.length && `<a href="${esc(href({ type: "writes" }))}">${esc(plural(wrote.reduce((t, [, n]) => t + n, 0), "policy change"))}</a>`,
    b.refusedWrites && `<a href="${esc(href({ type: "writes" }))}">${esc(plural(b.refusedWrites, "write"))} refused</a>`,
  ].filter(Boolean);
  const studyRow = r => {
    const st = stagesOf(r), reached = st.map((x, i) => x ? i : -1).filter(i => i >= 0);
    const first = reached[0], last = reached.at(-1);
    const cells = st.map((x, i) => {
      const line = `${i > first && i <= last ? " in" : ""}${i >= first && i < last ? " out" : ""}`;
      const words = x ? x.map(([, w]) => w).join(", then ") : "didn't happen", say = `${STAGES[i].name}: ${words}`;
      return `<a class="fl-cell${line}${x ? "" : " none"}${x?.at(-1)[0] === "refused" ? " stopped" : ""}" href="${esc(href({ study: r.study, type: STAGES[i].type }))}" aria-label="${esc(say)}" title="${esc(say)}">${x ? `<span class="fl-marks">${x.map(([k]) => dot(k)).join("")}</span><span class="fl-word">${esc(words)}</span>` : `<span class="fl-none" aria-hidden="true"></span>`}</a>`;
    }).join("");
    return `<li class="fl-row end-${esc(r.end)}"><a class="fl-study" href="${esc(href({ study: r.study, type: null }))}"><b>${esc(r.title)}</b>${r.site ? `<span>${esc(r.site)}</span>` : ""}</a>${cells}</li>`;
  };
  // A step in a study's time order: its stage, its mark, and a word or two.
  const stepSay = (x, sum) => {
    if (x.stage === "link") return ["done", x.n === 1 ? "link made" : `${num(x.n)} links made`];
    if (x.stage === "get") return x.is === "sent" ? ["sent", `sent${sum ? ` ${bytes(sum)}` : ""}${times(x.n)}`] : ["refused", `refused${times(x.n)}`];
    const [k, w] = SAY[x.is] ?? ["done", x.is];
    return [k, `${w}${times(x.n)}`];
  };
  const STAGE_NAME = Object.fromEntries(STAGES.map(st => [st.id, st.name]));
  // Studies whose steps came out the same share a line; bytes add up across them.
  const groupsOf = studies => {
    const groups = new Map();
    for (const r of studies) {
      const key = r.steps.map(x => `${x.stage}:${x.is}:${x.n}`).join(" ");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    return [...groups.values()];
  };
  const chain = rs => `<ol class="fl-chain">${rs[0].steps.map((x, i) => {
    const sum = x.stage === "get" ? rs.reduce((t, r) => t + (r.steps[i]?.bytes ?? 0), 0) : 0;
    const [k, w] = stepSay(x, sum);
    return `<li class="fl-step ${esc(k)}"><small>${esc(STAGE_NAME[x.stage])}</small><span>${dot(k)}${esc(w)}</span></li>`;
  }).join("")}</ol>`;
  const who = rs => rs.length === 1
    ? `<a class="fl-who" href="${esc(href({ study: rs[0].study, type: null }))}"><b>${esc(rs[0].title)}</b><span>${esc(rs[0].site ?? "")}</span></a>`
    : `<div class="fl-who"><b>${esc(plural(rs.length, "study", "studies"))}</b><span>${esc([...new Set(rs.map(r => r.site).filter(Boolean))].join(", "))}</span></div>`;
  const grid = studies => `<div class="fl-grid-wrap"><ol class="fl-grid" aria-label="Each study's path: search, link, check, retrieve">
      <li class="fl-head" aria-hidden="true"><span></span>${STAGES.map(st => `<span><b>${esc(st.name)}</b>${esc(st.party)}</span>`).join("")}</li>${studies.map(studyRow).join("")}</ol>
      <p class="fl-key"><span class="fl-key-none"><span class="fl-none"></span>didn't happen</span> <span class="fl-key-line"><i></i>went on to the next stage</span> <span class="fl-key-line dotted"><i></i>skipped a stage</span></p></div>`;
  // One card for each stretch of the session, in time order: what changed, then how the studies went.
  const cards = f.phases.map((p, i) => {
    const changes = p.writes.map(d => { const w = W.written(d); return `${w.what}${Array.isArray(d.body?.sites) ? `, at ${w.sites}` : ""}`; });
    const ends = p.studies.map(r => r.end);
    const did = stage => p.studies.some(r => r.steps.some(x => x.stage === stage));
    const title = changes.length ? changes.join("; ") : did("get") ? "The app searches and retrieves" : did("check") ? "The app searches and asks for studies" : "The app searches";
    // Later cards say how long after the first they began: a tour's run takes seconds.
    const start = f.phases[0]?.from, gap = p.from && start ? p.from - start : 0;
    const at = !p.from ? "" : i === 0 || gap >= 60000 ? when(p.from) : gap < 1000 ? "a moment later" : `${Math.round(gap / 1000)} s later`;
    return `<li class="fl-card">
      <p class="fl-when">${at ? `<time>${esc(at)}</time>` : ""}</p>
      <div class="fl-body">
        <p class="fl-kicker">${i === 0 ? "At first" : "Then"}${at ? ` <time class="k-time">${esc(at)}</time>` : ""}</p>
        <h3>${esc(title)}</h3>
        ${ends.length ? `<p class="fl-outcome">${esc(endsLine(ends))}</p>` : `<p class="fl-outcome">Nothing reached a study after this.</p>`}
        ${p.studies.length ? `<ul class="fl-groups">${groupsOf(p.studies).map(rs => `<li>${who(rs)}${chain(rs)}</li>`).join("")}</ul>
        <details class="fl-more"><summary>Each study, stage by stage</summary>${grid(p.studies)}</details>` : ""}
      </div></li>`;
  }).join("");
  const any = f.phases.some(p => p.studies.length);
  return `<figcaption><span class="fl-title">How each study went</span><span class="fl-sum">${esc(f.ends.length ? `When the session ended, of ${plural(f.ends.length, "study", "studies")}: ${endsLine(f.ends)}` : "No study yet")}</span></figcaption>
    ${other.length ? `<p class="fl-other"><span>Also in this session:</span> ${other.join("")}</p>` : ""}
    ${any ? `<ol class="fl-cards">${cards}</ol>
    <p class="fl-key">${[["done", "happened"], ["sent", "sent to the app"], ["refused", "refused"], ["withheld", "withheld from the app"], ["gone", "not found by a later search"]].map(([k, w]) => `<span class="fl-key-item">${dot(k, w)}</span>`).join("")}</p>` : ""}`;
}

// Sessions: one row each, who and with what, when, and a mark per study for where its path ended.
function endsStrip(ends) {
  if (!ends.length) return `<span class="s-ends none">No study</span>`;
  const sorted = [...ends].sort((a, b) => END_ORDER.indexOf(a) - END_ORDER.indexOf(b));
  return `<span class="s-ends" role="img" aria-label="${esc(endsLine(ends))}"><span class="s-marks">${sorted.map(e => dot(e === "linked" || e === "found" ? "done" : e)).join("")}</span><span>${esc(endsLine(ends))}</span></span>`;
}
function sessionsHtml() {
  const current = q().get("session");
  if (!summary.sessions.length) return `<p class="note">No sessions match these filters.</p>`;
  return `<ol class="session-list">${summary.sessions.map(r => {
    const who = whoName(r.who), client = r.client && `client:${r.client}` !== r.who ? clientName(r.client) : "";
    return `<li><a class="session-row" href="${esc(href({ session: r.session === current ? null : r.session, study: null, trace: null }))}" ${r.session === current ? 'aria-current="true"' : ""}>
      <span class="s-who"><b>${esc(who || "No one named")}</b>${client ? `<span> with ${esc(client)}</span>` : ""}</span><span class="s-when">${esc(when(r.to))}</span>
      <span class="s-label">${esc(r.label)}</span>
      ${endsStrip(r.ends)}${r.problems ? `<span class="s-problems">${esc(plural(r.problems, "denial or failure", "denials or failures"))}</span>` : ""}</a></li>`;
  }).join("")}</ol>`;
}

// The table: columns that suit the type, newest first. A row opens the event in full below it.
function cells(e, type) {
  const d = e.data, w = W.describe(e);
  const study = e.study ?? "";
  const status = (s, ok = s < 400) => html(`<span class="tag ${ok ? "ok" : "denied"}">${esc(s)}</span>`);
  switch (type) {
    case "tokens": return [whoName(e.who), clientName(d.client), d.grant?.replaceAll("_", " "), d.scope, d.expiresIn && `${Math.round(d.expiresIn / 60)} min`, d.tokenHash && html(`<code>${esc(d.tokenHash)}</code>`)];
    case "referrals": return [clientName(d.client), d.reference, d.accession, d.ok ? status("on the server", true) : status("not on it", false)];
    case "searches": return [whoName(e.who), status(d.status), d.found ? num(d.found.length) : "", d.withheld || d.unreached ? num((d.withheld?.length ?? 0) + (d.unreached?.length ?? 0)) : "", d.query && html(`<code>${esc(d.query)}</code>`)];
    case "links": return [study, d.form, d.series, d.exp && new Date(d.exp * 1000).toLocaleTimeString(), d.kid];
    case "checks": return e.kind === "proxy.fast-path"
      ? [study, d.taken ? "Instant, from the signed link" : "Fell through to a decision", d.taken ? status("allowed", true) : html(`<span class="tag info">next</span>`), d.failed]
      : [study, d.via === "cached" ? "Cached decision" : "Decision call", d.unavailable ? status("no answer", false) : status(d.allowed ? "allowed" : "refused", d.allowed), d.denial];
    case "retrievals": return [study, d.resource, status(d.status, d.status < 400 && (e.kind !== "stream.done" || d.complete)), e.kind === "stream.done" ? num(d.parts) : "", e.kind === "stream.done" ? bytes(d.bytes) : "", d.encoding, AUTHZ[d.authz] ?? d.authz, e.ms !== undefined ? num(Math.round(e.ms)) : ""];
    case "decisions": return [study, whoName(e.who) || clientName(d.client), status(d.decision ? "allow" : "deny", d.decision), d.why];
    case "writes": { const x = W.written(d); return [x.what, ["fact", "policy", "choice"].includes(d.level) ? html(`<span class="lvl">${Layers.mark(d.level)} ${esc(Layers.LEVEL[d.level])}</span>`) : LEVELS[d.level] ?? d.level, status(d.status)]; }
    default: return [KIND_WORDS[e.kind] ?? e.kind, PARTY[e.service] ?? e.service, html(`${e.outcome === "ok" || e.outcome === "info" ? "" : `<span class="tag ${esc(e.outcome)}">${esc(e.outcome === "error" ? "failed" : e.outcome)}</span> `}${esc(w.summary)}`)];
  }
}
// A cell's value is text, or markup made here and wrapped by `html`.
const html = s => ({ html: s });
const cell = v => v === undefined || v === null || v === false ? "" : typeof v === "object" ? v.html : esc(v);
const numeric = new Set(["Parts", "Bytes", "ms", "Returned", "Withheld", "Series"]);
function tableHtml() {
  const type = q().get("type"), cols = type ? TYPES[type].cols : ALL_COLS;
  if (!events.length) return `<p class="note">Nothing matches these filters yet.</p>`;
  const rows = [...events].reverse().map(e => {
    const open = String(e.seq) === String(openSeq);
    const values = cells(e, type ?? "all");
    return `<tr class="ev ${esc(e.outcome)}" data-seq="${esc(e.seq)}"><td class="t"><button type="button" aria-expanded="${open}" aria-controls="d-${esc(e.seq)}">${esc(when(e.at))}</button></td>${values.map((v, i) => `<td class="${numeric.has(cols[i + 1]) ? "n" : ""}">${cell(v)}</td>`).join("")}</tr>
      ${open ? `<tr class="detail" id="d-${esc(e.seq)}"><td colspan="${cols.length}">${detailHtml(e)}</td></tr>` : ""}`;
  }).join("");
  return `<div class="table-wrap"><table><thead><tr>${cols.map(c => `<th scope="col" class="${numeric.has(c) ? "n" : ""}">${esc(c)}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>`;
}
function detailHtml(e) {
  const w = W.describe(e);
  const links = W.linksOf(e);
  const keep = q().get("session");
  // A policy write's level, and a decision, which organization policy makes, wear the level's mark.
  const level = e.kind === "policy.written" ? (["fact", "policy", "choice"].includes(e.data.level) ? e.data.level : undefined) : e.kind === "decision.answered" ? "policy" : undefined;
  return `<div class="ev-detail"><p class="ev-summary">${level ? `${Layers.mark(level)} ` : ""}<b>${esc(w.summary)}</b> <span class="note">${esc(PARTY[e.service] ?? e.service)}, ${esc(new Date(e.at).toLocaleString())}</span></p>
    ${w.fields.length ? `<dl>${w.fields.map(([a, b]) => `<dt>${esc(a)}</dt><dd>${Array.isArray(b) ? (b.length ? studyList(b) : "none") : esc(b)}</dd>`).join("")}</dl>` : ""}
    ${links.length ? `<p class="ev-links">${links.map(l => `<a href="${esc(`${BASE}/activity?${new URLSearchParams({ ...(keep ? { session: keep } : {}), link: l.link })}`)}" title="${esc(l.title)}">${esc(l.words)}</a>`).join("")}</p>` : ""}
    <details><summary>Raw payload</summary><pre>${esc(JSON.stringify({ kind: e.kind, ...e.data }, null, 2))}</pre></details>
    ${e.span ? `<details data-exchange="${esc(e.seq)}"><summary>The exchange</summary><div class="raw"><p class="note">Loading…</p></div></details>` : ""}</div>`;
}

function filtersHtml() {
  const p = q();
  const chips = [];
  const row = p.get("session") && summary.sessions.find(r => r.session === p.get("session"));
  if (p.get("session")) chips.push(["session", `Session: ${row ? `${whoName(row.who) || "no one named"}, ${row.label}` : p.get("session")}`]);
  if (p.get("trace")) chips.push(["trace", "One step"]);
  if (p.get("type")) chips.push(["type", `Type: ${TYPES[p.get("type")]?.name ?? p.get("type")}`]);
  if (p.get("link")) chips.push(["link", `Shares ${p.get("link")}`]);
  const studySel = `<label>Study<select name="study"><option value="">Any study</option>${[...new Set([...summary.studies, ...(p.get("study") ? [p.get("study")] : [])])].map(s => `<option ${s === p.get("study") ? "selected" : ""}>${esc(s)}</option>`).join("")}</select></label>`;
  const scopeSel = summary.scopes?.length ? `<label>World<select name="scope"><option value="">Every world</option><option value="-" ${p.get("scope") === "-" ? "selected" : ""}>Saved policy</option>${summary.scopes.map(s => `<option value="${esc(s)}" ${p.get("scope") === s ? "selected" : ""}>Scope ${esc(s)}</option>`).join("")}</select></label>` : "";
  return `${scopeSel}${studySel}${chips.length ? `<ul class="chosen" aria-label="Filters in use">${chips.map(([k, words]) => `<li><span>${esc(words)}</span><a href="${esc(href({ [k]: null }))}" aria-label="${esc(`Remove the filter: ${words}`)}">×</a></li>`).join("")}</ul>` : ""}`;
}
function viewLine() {
  const who = summary.viewer && whoName(summary.sessions[0]?.who);
  if (summary.viewer) return `One session, showing only what ${esc(who || "its person or service")} may see. <a href="${esc(`${BASE}/activity`)}">Every session</a>`;
  return `Every session, as the operator sees it.${summary.traceUrl ? ` <a href="${esc(summary.traceUrl)}">Open the live trace</a>` : ""}`;
}

async function loadEvents(append = false) {
  const p = q(); p.delete("event"); p.set("limit", "100");
  if (append && before) p.set("before", before);
  const r = await api("GET", `/api/activity?${p}`);
  W.setTraceUrl(r.traceUrl);
  events = append ? [...r.events, ...events] : r.events;
  more = r.more; before = r.before;
}
function renderTable() {
  const type = q().get("type");
  $("#h-events").textContent = type ? TYPES[type]?.name ?? "Events" : "All events";
  $("#events").innerHTML = tableHtml();
  $("#more").hidden = !more;
}
async function load() {
  openSeq = q().get("event");
  try {
    const [s] = await Promise.all([api("GET", `/api/activity/summary?${q()}`), loadEvents()]);
    summary = s;
  } catch (e) { $("#events").innerHTML = `<p class="error" role="alert">${esc(e.message)}</p>`; return; }
  $("#view-line").innerHTML = viewLine();
  $("#filters").innerHTML = filtersHtml();
  $("#tiles").innerHTML = tilesHtml();
  // One session's events come seconds apart: the study-by-study picture shows their order instead of a timeline.
  $("#flow").innerHTML = flowHtml(); $("#flow").hidden = !summary.flow;
  $("#timeline").hidden = !!summary.flow; $(".glance").classList.toggle("one", !!summary.flow);
  if (!summary.flow) $("#timeline").innerHTML = timelineHtml();
  $("#capped").hidden = !summary.capped;
  $("#sessions").innerHTML = sessionsHtml();
  $("#h-sessions").textContent = summary.viewer ? "This session" : `Sessions, ${num(summary.sessions.length)}`;
  $(".log").classList.toggle("one-session", !!summary.viewer);
  renderTable();
  announce(`${plural(summary.total, "event")}`);
  if (openSeq) { const d = $(`#d-${CSS.escape(openSeq)}`); d?.scrollIntoView({ block: "nearest" }); }
}

// In-page navigation: every filter is a URL, so links and back both work without a reload.
document.addEventListener("click", e => {
  const a = e.target.closest("a[href]");
  if (a && a.closest("main") && a.origin === location.origin && a.pathname === `${BASE}/activity` && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
    e.preventDefault();
    // Where the change shows: a new session redraws the whole page from the top; a type, a study, or
    // a shared value changes the list of events, so the page goes to it if it's out of sight.
    const was = q(), next = new URL(a.href).searchParams;
    const to = was.get("session") !== next.get("session") ? "#title" : "#h-events";
    history.pushState(null, "", a.href);
    load().then(() => { const t = $(to), box = t?.getBoundingClientRect(); if (box && (box.top < 0 || box.top > innerHeight * .6)) t.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }); });
    return;
  }
  const row = e.target.closest("tr.ev");
  if (row && !e.target.closest("a, details")) {
    const seq = row.dataset.seq;
    openSeq = openSeq === seq ? null : seq;
    const p = q(); if (openSeq) p.set("event", openSeq); else p.delete("event");
    history.replaceState(null, "", `?${p}`);
    renderTable();
    $(`tr.ev[data-seq="${CSS.escape(seq)}"] button`)?.focus();
  }
});
document.addEventListener("toggle", async e => {
  const d = e.target;
  if (!d.matches?.("details[data-exchange]") || !d.open || d.dataset.loaded) return;
  d.dataset.loaded = "1";
  const ev = events.find(x => String(x.seq) === d.dataset.exchange);
  $(".raw", d).innerHTML = await W.exchangeHtml(ev);
}, true);
$("#filters").addEventListener("change", e => { history.pushState(null, "", href({ [e.target.name]: e.target.value || null })); load(); });
$("#more").addEventListener("click", async () => { await loadEvents(true); renderTable(); });
addEventListener("popstate", load);
let resized;
addEventListener("resize", () => { clearTimeout(resized); resized = setTimeout(() => { if (summary && !summary.flow) $("#timeline").innerHTML = timelineHtml(); }, 150); });
(async () => {
  try { names = (await api("GET", "/api/explore/options")).names; W.setNames(names); } catch {}
  await load();
})();
