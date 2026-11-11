// Every filter of the log is in its address, so Explore links here already filtered, and links and
// Back both move between views in place.
import type { ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { BASE } from "../lib/api";

export type Changes = Record<string, string | null | undefined>;
/** Where the page brings into sight once a link's view has loaded: its top, or the list of events. */
export type Show = "title" | "events";

/** The log's address with `changes` made to the filters in `search`. An open event closes. */
export function logHref(search: string, changes: Changes) {
  const p = new URLSearchParams(search);
  for (const [k, v] of Object.entries(changes)) { if (v === null || v === undefined || v === "") p.delete(k); else p.set(k, v); }
  p.delete("event");
  const s = p.toString();
  return `${BASE}/activity${s ? `?${s}` : ""}`;
}
/**
 * A link to another view of the log. A new session redraws the whole page, so the page goes to its top; a
 * type, a study or a shared value changes the list of events, so the page goes to that.
 */
export function LogLink({ to, children, ...rest }: { to: string; children: ReactNode; className?: string; title?: string; "aria-label"?: string; "aria-current"?: "true"; "data-type"?: string }) {
  const { search } = useLocation();
  const next = new URL(to, location.origin).searchParams.get("session");
  const show: Show = new URLSearchParams(search).get("session") !== next ? "title" : "events";
  return <Link to={to} state={{ show }} {...rest}>{children}</Link>;
}
