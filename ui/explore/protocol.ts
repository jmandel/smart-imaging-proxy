// The protocol, as an app does it. For a person, Explore gets a token from the sandbox's admin key, as that
// person's app would hold after sign-in. A service signs its own assertion with its key. Then it searches and
// retrieves with the token, as any app would. Every request carries the view's trace session, so the activity
// log shows what it did.
import { BASE, backendToken, keysOf } from "../lib/api";
import { fhirHeaders, patientFetch, searchAll, studiesFrom, WADO_ACCEPT, type Study } from "../lib/smart-imaging";
import type { Retrieval, Row, Sheet, View } from "./types";

/** The app a person's view looks through. */
export const APP = "portal-app";
const hex = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, "0")).join("");
/** A new trace session for a view, named as the server names its own. */
export const newSession = (who: string) => { const id = BASE.slice("/s/".length); return `explore-${who}-${hex(3)}${id ? `@${id}` : ""}`; };
/** What ties a request to the view's session: a new trace for each, under the session. */
export const traceHeaders = (view: Pick<View, "session"> | undefined): Record<string, string> =>
  view?.session ? { traceparent: `00-${hex(16)}-${hex(8)}-01`, baggage: `demo.session=${encodeURIComponent(view.session)}` } : {};

let discovery: { base: string; config: Promise<unknown> } | undefined;
/** The sandbox's SMART configuration, asked once per sandbox. */
export function discover(): Promise<unknown> {
  if (discovery?.base !== BASE) {
    const base = BASE;
    discovery = { base, config: fetch(`${base}/fhir/.well-known/smart-configuration`).then(r => r.json()).catch(e => { discovery = undefined; throw e; }) };
  }
  return discovery.config;
}

/** One request this view made, for its technical detail. */
const noted = (view: View, what: string, status: number) => view.tech.push(`${what}: HTTP ${status}`);

/** A token as the person's app would hold it after sign-in, from the sandbox's admin key. */
export async function personToken(view: View, user: string, patient: string, appName: string) {
  const keys = await keysOf();
  const t = await backendToken(keys.admin, keys.tokenEndpoint, { user, patient, app: APP }, keys.now, traceHeaders(view));
  noted(view, `Token for the ${appName} as ${view.who.name}, from the sandbox's admin key`, 200);
  return t.access_token;
}
/** A service's own token: SMART Backend Services, with its key. */
export async function serviceToken(view: View, client: string) {
  const keys = await keysOf(), mine = keys.services.find(s => s.client_id === client);
  if (!mine) throw new Error(`The sandbox has no key for ${client}.`);
  const t = await backendToken(mine, keys.tokenEndpoint, { scope: mine.scope }, keys.now, traceHeaders(view));
  noted(view, `Backend Services token for ${client}, signed with its own key`, 200);
  return t.access_token;
}
/** Every page of a search, with this view's token. Gives the studies, or the refusal's status. */
export async function search(view: View, token: string, imaging: string, query: string): Promise<{ status: number; studies: Study[] }> {
  let refused: number | undefined;
  const { entries } = await searchAll(`${imaging}/ImagingStudy?${query}`, async url => {
    const r = await patientFetch(url, { headers: { ...fhirHeaders(token), ...traceHeaders(view) } });
    const u = new URL(url);
    noted(view, `GET ${u.pathname.split("/").slice(-1)[0]}${u.search.slice(0, 80)}`, r.status);
    if (!r.ok) { refused = r.status; return {}; }
    return r.json();
  });
  return refused ? { status: refused, studies: [] } : { status: 200, studies: studiesFrom(entries) };
}

/** The sheets: what search found, each with the sandbox's title for it, then what it withholds from what this viewer may know of. */
export function sheetsOf(found: Study[], rows: Row[]): Sheet[] {
  const byId = new Map(rows.map(r => [r.id, r]));
  const released = found.map((st): Sheet => {
    const row = byId.get(st.id ?? "");
    return {
      id: st.id ?? "", title: row?.title ?? st.description ?? st.id ?? "", site: row?.site, date: st.started, modalities: (st.modality ?? []).map((m: { code: string }) => m.code), released: true,
      instanceCount: st.numberOfInstances, seriesCount: st.numberOfSeries, partial: row?.partial, thumb: !!(st.address && st.uid),
    };
  });
  const ids = new Set(found.map(st => st.id));
  return [...released, ...rows.filter(r => !r.released && !ids.has(r.id))];
}

/**
 * The whole study, from its WADO-RS address, counted as it arrives: parts, bytes, and how long it took. `progress`
 * hears each count, and the last is the result.
 */
export async function retrieveWhole(view: View, st: Study, progress: (r: Retrieval) => void): Promise<void> {
  const r: Retrieval = { running: true, parts: 0, bytes: 0 };
  progress({ ...r });
  const url = `${st.address}/studies/${st.uid}`, t0 = performance.now();
  try {
    const res = await patientFetch(url, { headers: { authorization: `Bearer ${view.token}`, accept: WADO_ACCEPT, ...traceHeaders(view) } });
    r.status = res.status;
    const boundary = res.headers.get("content-type")?.match(/boundary="?([^";]+)/)?.[1];
    if (res.ok && boundary && res.body) {
      // Each part starts after a delimiter line, and the body ends at the closing one.
      const delimiter = new TextEncoder().encode(`--${boundary}`), reader = res.body.getReader();
      let carry = new Uint8Array(0), delimiters = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        r.bytes += value.length;
        const buf = new Uint8Array(carry.length + value.length); buf.set(carry); buf.set(value, carry.length);
        for (let i = 0; i + delimiter.length <= buf.length; i++) if (delimiter.every((c, k) => buf[i + k] === c)) { delimiters++; i += delimiter.length - 1; }
        carry = buf.slice(Math.max(0, buf.length - delimiter.length + 1));
        r.parts = Math.max(0, delimiters - 1);
        progress({ ...r });
      }
      r.complete = delimiters >= 2;
      const timing = performance.getEntriesByName(url).at(-1) as PerformanceResourceTiming | undefined;
      if (timing?.encodedBodySize) r.wire = timing.encodedBodySize;
    } else await res.body?.cancel();
  } catch (e) { r.error = (e as Error).message; }
  r.ms = Math.round(performance.now() - t0); r.running = false;
  progress({ ...r });
}
