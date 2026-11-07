// The full activity: recorded events as cards, newest first, filtered by scope, person, kind and outcome, and by the
// session or a linked value an action or a card points here with.
const FILTERS = ["scope", "who", "kind", "outcome"];
const LABELS = { scope: "Scope", who: "Person or service", kind: "Kind", outcome: "Outcome" };
const KIND_WORDS = { "token.issued": "Token issued", "referral.checked": "Referral checked", "search.returned": "Search", "context.signed": "Signed link made", "decision.answered": "Decision", "proxy.fast-path": "Fast path", "proxy.decision": "Proxy asked", "stream.done": "Stream done", "retrieval.answered": "Retrieval answered", "policy.written": "Policy written" };
let names = {};

const query = () => new URLSearchParams(location.search);
async function load() {
  const q = query();
  const r = await api("GET", `/api/activity?${q}`);
  Cards.setTraceUrl(r.traceUrl);
  const facets = { scope: r.facets.scopes ?? [], who: r.facets.who, kind: r.facets.kinds, outcome: r.facets.outcomes };
  const word = (f, v) => f === "kind" ? KIND_WORDS[v] ?? v : f === "who" ? names[v] ?? v : f === "scope" ? v : v;
  $("#filters").innerHTML = FILTERS.filter(f => f !== "scope" || facets.scope.length).map(f => `<label>${esc(LABELS[f])}<select name="${f}"><option value="">Any</option>${f === "scope" ? `<option value="-" ${q.get(f) === "-" ? "selected" : ""}>Saved policy</option>` : ""}${facets[f].map(v => `<option value="${esc(v)}" ${q.get(f) === v ? "selected" : ""}>${esc(word(f, v))}</option>`).join("")}</select></label>`).join("")
    + `<div class="chosen">${["session", "link", "trace"].filter(k => q.get(k)).map(k => `<span class="tag">${esc(k === "session" ? "One session" : k === "link" ? q.get(k) : "One step")}</span>`).join("")}${["session", "link", "trace"].some(k => q.get(k)) ? `<a href="${esc(`${BASE}/activity`)}">Show everything</a>` : ""}</div>`;
  // Newest first.
  $("#events").innerHTML = Cards.list([...r.events].reverse(), "Nothing matches these filters yet.");
  Cards.wire($("#events"));
  announce(`${plural(r.events.length, "event")}`);
}
$("#filters").addEventListener("change", e => {
  const q = query();
  if (e.target.value) q.set(e.target.name, e.target.value); else q.delete(e.target.name);
  history.replaceState(null, "", `?${q}`);
  load();
});
(async () => {
  try { names = (await api("GET", "/api/explore/options")).names; Cards.setNames(names); } catch {}
  try { await load(); } catch (e) { $("#events").innerHTML = `<p class="error" role="alert">${esc(e.message)}</p>`; }
})();
