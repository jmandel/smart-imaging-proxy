// What a viewer may see of the events a session recorded. Core's events are for operators: a search's
// `unreached` names studies the caller may not know exist, and a decision's reason can name a label.
// A viewer, the person or service a session acts as, sees a study only if they know of it: their
// routes reached it, or their own work names it, such as the study a referral cites. Explore's panel and
// the activity view of a session both go through `forViewer`.
import type { EventRecord } from "./trace";

type Listed = { study: string; why: string };

/** The studies a session's own events show its caller reaching: what search found, released, or withheld from the client although a route reached it. */
export function knownFromEvents(events: EventRecord[]): Set<string> {
  const known = new Set<string>();
  for (const e of events) {
    if (e.kind === "search.returned") {
      for (const s of (e.data.found as string[] | undefined) ?? []) known.add(s);
      for (const w of (e.data.withheld as Listed[] | undefined) ?? []) known.add(w.study);
    }
    if (e.kind === "context.signed" && typeof e.data.study === "string") known.add(e.data.study);
  }
  return known;
}

/** Every study a session's viewer knows of: what its events show them reaching, and what else they know of. */
export const viewerKnows = (sessionEvents: EventRecord[], also: Iterable<string> = []) => new Set([...knownFromEvents(sessionEvents), ...also]);

/**
 * The events a viewer may see, given every study they know of. A search keeps, in `withheld` and
 * `unreached`, only those studies, and any other event naming a study they don't know of, by id or by
 * UID, is left out whole. `idOfUid` maps a study UID to its id.
 */
export function forViewer(events: EventRecord[], known: ReadonlySet<string>, idOfUid: (uid: string) => string | undefined): EventRecord[] {
  const knows = (link: string) => link.startsWith("study:") ? known.has(link.slice("study:".length)) : link.startsWith("uid:") ? known.has(idOfUid(link.slice("uid:".length)) ?? "") : true;
  const out: EventRecord[] = [];
  for (const e of events) {
    if (e.kind === "search.returned") {
      const keep = (xs: unknown) => Array.isArray(xs) ? (xs as Listed[]).filter(x => known.has(x.study)) : undefined;
      const data = { ...e.data };
      for (const k of ["withheld", "unreached"] as const) { if (data[k] !== undefined) data[k] = keep(data[k]); }
      out.push({ ...e, links: e.links.filter(knows), data });
      continue;
    }
    const named = [...e.links, ...(typeof e.data.study === "string" ? [`study:${e.data.study}`] : []), ...(typeof e.data.studyUid === "string" ? [`uid:${e.data.studyUid}`] : [])];
    if (named.every(knows)) out.push(e);
  }
  return out;
}
