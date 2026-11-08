// The activity log's rollups: one tile of numbers per type of event, a timeline laned by party, one
// line per session, and Explore's one-line account of a study's chain. Everything here is computed
// from events already filtered for whoever is looking, so a count can't say more than the events do.
import type { EventRecord } from "./trace";

/** The log's types: each is one or more event kinds, or for problems, every denied or failed event. */
export const ACTIVITY_TYPES = [
  { id: "tokens", kinds: ["token.issued"] },
  { id: "referrals", kinds: ["referral.checked"] },
  { id: "searches", kinds: ["search.returned"] },
  { id: "links", kinds: ["context.signed"] },
  { id: "checks", kinds: ["proxy.fast-path", "proxy.decision"] },
  { id: "retrievals", kinds: ["stream.done", "retrieval.answered"] },
  { id: "decisions", kinds: ["decision.answered"] },
  { id: "writes", kinds: ["policy.written"] },
  { id: "problems", outcomes: ["denied", "error"] },
] as const satisfies readonly { id: string; kinds?: readonly string[]; outcomes?: readonly string[] }[];
export type ActivityType = typeof ACTIVITY_TYPES[number]["id"];
export const activityType = (id: string | null | undefined) => ACTIVITY_TYPES.find(t => t.id === id);

/** The parties the timeline lays out, one lane each, by the service that recorded the event. */
export const PARTIES = ["authorization-server", "imaging-fhir", "policy", "dicomweb-proxy", "app"] as const;

const count = (m: Record<string, number>, k: string | undefined, n = 1) => { if (k !== undefined) m[k] = (m[k] ?? 0) + n; };
const isProblem = (e: EventRecord) => e.outcome === "denied" || e.outcome === "error";
type Listed = { study: string }[] | undefined;

/** Each type's key numbers. */
export function tiles(events: EventRecord[]) {
  const t = {
    tokens: { count: 0, byClient: {} as Record<string, number>, byGrant: {} as Record<string, number> },
    referrals: { count: 0, ok: 0, refused: 0 },
    searches: { count: 0, answered: 0, refused: 0, returned: 0, withheld: 0 },
    links: { count: 0, byForm: {} as Record<string, number> },
    checks: { count: 0, instant: 0, cached: 0, asked: 0, refused: 0, fellThrough: 0 },
    retrievals: { count: 0, streams: 0, parts: 0, bytes: 0, zstd: 0, cut: 0, refused: 0, byAuthz: {} as Record<string, number> },
    decisions: { count: 0, allow: 0, deny: 0 },
    writes: { count: 0, ok: 0, refused: 0, byLevel: {} as Record<string, number> },
    problems: { count: 0, denied: 0, error: 0, byKind: {} as Record<string, number> },
  };
  const returned = new Set<string>(), withheld = new Set<string>();
  for (const e of events) {
    const d = e.data as any;
    if (isProblem(e)) { t.problems.count++; e.outcome === "denied" ? t.problems.denied++ : t.problems.error++; count(t.problems.byKind, e.kind); }
    switch (e.kind) {
      case "token.issued": t.tokens.count++; count(t.tokens.byClient, d.client); count(t.tokens.byGrant, d.grant); break;
      case "referral.checked": t.referrals.count++; d.ok ? t.referrals.ok++ : t.referrals.refused++; break;
      case "search.returned":
        t.searches.count++;
        if (d.status === 200) {
          t.searches.answered++;
          for (const s of (d.found as string[] | undefined) ?? []) returned.add(s);
          for (const w of [...((d.withheld as Listed) ?? []), ...((d.unreached as Listed) ?? [])]) withheld.add(w.study);
        } else t.searches.refused++;
        break;
      case "context.signed": t.links.count++; count(t.links.byForm, d.form); break;
      case "proxy.fast-path": if (d.taken) { t.checks.count++; t.checks.instant++; } else t.checks.fellThrough++; break;
      case "proxy.decision": t.checks.count++; d.via === "cached" ? t.checks.cached++ : t.checks.asked++; if (!d.allowed) t.checks.refused++; break;
      case "stream.done":
        t.retrievals.count++; t.retrievals.streams++; t.retrievals.parts += d.parts ?? 0; t.retrievals.bytes += d.bytes ?? 0;
        if (d.encoding === "zstd") t.retrievals.zstd++;
        if (!d.complete) t.retrievals.cut++;
        count(t.retrievals.byAuthz, d.authz ?? "no token");
        break;
      case "retrieval.answered": t.retrievals.count++; if (d.status >= 400) t.retrievals.refused++; count(t.retrievals.byAuthz, d.authz ?? "no token"); break;
      case "decision.answered": t.decisions.count++; d.decision ? t.decisions.allow++ : t.decisions.deny++; break;
      case "policy.written": t.writes.count++; d.status < 300 ? t.writes.ok++ : t.writes.refused++; count(t.writes.byLevel, d.level); break;
    }
  }
  // A study that one search returned and another withheld counts once, as returned.
  for (const s of returned) withheld.delete(s);
  t.searches.returned = returned.size; t.searches.withheld = withheld.size;
  return t;
}

/** Events over time, in equal bins, one lane per party, with each bin's denials and failures. */
export function timeline(events: EventRecord[], bins = 60) {
  const ats = events.map(e => e.at);
  let from = ats.length ? Math.min(...ats) : Date.now(), to = ats.length ? Math.max(...ats) : from;
  // A burst that takes no time still gets a minute of axis, centred on it.
  if (to - from < 60000) { const mid = (from + to) / 2; from = mid - 30000; to = mid + 30000; }
  const width = (to - from) / bins;
  const lanes = PARTIES.map(party => ({ party, counts: new Array<number>(bins).fill(0), problems: new Array<number>(bins).fill(0) }));
  for (const e of events) {
    const lane = lanes.find(l => l.party === e.service);
    if (!lane) continue;
    const i = Math.min(bins - 1, Math.floor((e.at - from) / width));
    lane.counts[i]!++;
    if (isProblem(e)) lane.problems[i]!++;
  }
  return { from, to, bins, lanes };
}

/** One line per session: who, with which client, when, and its totals. Newest first. */
export function sessionRows(events: EventRecord[], labelOf: (session: string) => string) {
  const rows = new Map<string, any>();
  for (const e of events) {
    let r = rows.get(e.session);
    if (!r) rows.set(e.session, r = { session: e.session, ...(e.scope ? { scope: e.scope } : {}), label: labelOf(e.session), from: e.at, to: e.at, events: 0, tokens: 0, searches: 0, studies: new Set<string>(), links: 0, retrievals: 0, bytes: 0, problems: 0 });
    const d = e.data as any;
    r.from = Math.min(r.from, e.at); r.to = Math.max(r.to, e.at); r.events++;
    if (isProblem(e)) r.problems++;
    // The person or service it acts as is the first one an event names; the client, the first token's.
    if (e.kind === "token.issued") { r.tokens++; r.client ??= d.client; r.who ??= d.user ? `user:${d.user}` : d.client ? `client:${d.client}` : undefined; }
    r.who ??= e.who;
    if (e.kind === "search.returned") { r.searches++; for (const s of (d.found as string[] | undefined) ?? []) r.studies.add(s); }
    if (e.kind === "context.signed") r.links++;
    if (e.kind === "stream.done" || e.kind === "retrieval.answered") r.retrievals++;
    if (e.kind === "stream.done") r.bytes += d.bytes ?? 0;
  }
  return [...rows.values()].sort((a, b) => b.to - a.to).map(r => ({ ...r, studies: r.studies.size }));
}

/** The studies the events name, by id: what a viewer may pick to filter by. */
export function studiesNamed(events: EventRecord[], idOfUid: (uid: string) => string | undefined) {
  const out = new Set<string>();
  for (const e of events) for (const l of e.links) {
    if (l.startsWith("study:")) out.add(l.slice("study:".length));
    else if (l.startsWith("uid:")) { const id = idOfUid(l.slice("uid:".length)); if (id) out.add(id); }
  }
  return [...out].sort();
}

const bytesText = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${(n / 1e3).toFixed(1)} KB` : `${n} B`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * One plain line for a study's chain, from its session's events about it: whether it was searched and
 * signed, and how the proxy decided and what it sent the last time the whole study was retrieved.
 */
export function chainLine(events: EventRecord[]): string {
  const steps: string[] = [];
  const searched = events.some(e => e.kind === "search.returned" && (e.data as any).status === 200);
  if (searched) steps.push("searched");
  if (events.some(e => e.kind === "context.signed")) steps.push("signed link made");
  const last = events.findLast(e => (e.kind === "stream.done" || e.kind === "retrieval.answered") && (e.data as any).resource === "study");
  let tail: string;
  if (!last) tail = "not retrieved yet";
  else {
    const same = events.filter(e => e.trace === last.trace);
    const asked = same.find(e => e.kind === "proxy.decision") as any;
    if (same.some(e => e.kind === "proxy.fast-path" && (e.data as any).taken)) steps.push("checked by the proxy with no policy call");
    else if (asked?.data.via === "cached") steps.push("the proxy used a cached decision");
    else if (asked) steps.push("the proxy asked the Imaging Server");
    const d = last.data as any;
    tail = last.kind === "stream.done"
      ? `${plural(d.parts ?? 0, "part")}, ${bytesText(d.bytes ?? 0)}${d.complete ? "" : ", cut off"}`
      : `the proxy answered ${d.status}`;
  }
  const head = steps.length ? steps.join(", ") : "nothing recorded before retrieval";
  return `${head[0]!.toUpperCase()}${head.slice(1)}; ${tail}.`;
}
