// The protocol checks, run in the page as an app, an attacker or operations would act: each in a sandbox of its
// own, with real sign-ins and retrievals, and faults set and cleared through the sandbox's management API. Each
// check is a list of named steps, and each step a list of pass or fail lines.
import { hexOf, sandboxClient, STORED_ANY, type Found, type SandboxClient } from "../lib/sandbox-client";
import { patientFetch, type Bundle, type Resource } from "../lib/smart-imaging";

const EVRLE = "1.2.840.10008.1.2.1", JPEG_LOSSLESS = "1.2.840.10008.1.2.4.70", JPEG_BASELINE = "1.2.840.10008.1.2.4.50", J2K_LOSSLESS = "1.2.840.10008.1.2.4.90", PRIVATE_TEST_SYNTAX = "1.3.6.1.4.1.99999.1.2.3";
const isStandard = (uid: string) => uid === "1.2.840.10008.1.2" || uid.startsWith("1.2.840.10008.1.2.");
const part = (syntax: string, q?: number) => `multipart/related; type=application/dicom; transfer-syntax=${syntax}${q !== undefined ? `; q=${q}` : ""}`;
const WRIST = "xr-wrist-left-2012", SLIDE = "slide-lung-2023", MRI = "mri-brain-2020", RIVERSIDE = "Riverside Hospital";
const studiesOn = (b: Bundle | undefined): Resource[] => (b?.entry ?? []).filter(e => e.resource.resourceType === "ImagingStudy").map(e => e.resource);
/** The guide's rule for response-local Endpoints: each one is in the same Bundle as its study. */
const endpointsOnPage = (b: Bundle) => studiesOn(b).every(s => (s.endpoint ?? []).every((r: { reference: string }) => b.entry!.some(e => e.fullUrl === r.reference && e.resource.resourceType === "Endpoint")));
const b64json = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (s: string) => JSON.parse(atob(s.replace(/-/g, "+").replace(/_/g, "/")));
/** Ends a step that can't go on, as one failed line. */
const stop = (why: string): never => { throw new Error(why); };
const syntaxes = (parts: { syntax?: string }[]) => [...new Set(parts.map(p => p.syntax))].join(", ");

/** A check as the server names it. */
export interface CheckInfo { id: string; title: string; summary: string }
interface CatalogStudy { id: string; uid: string; site?: string }
type FoundStudy = Found["studies"][number];
type Page = Awaited<ReturnType<SandboxClient["searchPage"]>>;

/** What a check's steps work with: the sandbox's client, its catalog, what earlier steps found, and the lines that pass or fail. */
async function checkContext(base: string, session: string) {
  const client = sandboxClient(base, session);
  const [{ studies }, status] = await Promise.all([client.manage("GET", "/api/sandbox/catalog?patient=josh-example"), client.manage("GET", "/api/sandbox")]);
  const catalog: CatalogStudy[] = studies;
  const state: { token?: string; newToken?: string; studies?: Record<string, FoundStudy>; uri?: string; count?: number; query?: string; first?: Page } = {};
  const c = {
    client, state, catalog, lines: [] as { label: string; ok: boolean; detail?: string }[], backend: status.storage.current as string, trace: "",
    check(label: string, ok: unknown, detail?: unknown) { c.lines.push({ label, ok: !!ok, ...(detail !== undefined ? { detail: String(detail) } : {}) }); },
    study: (id: string) => catalog.find(s => s.id === id)!,
    siteOf: (id: string) => catalog.find(s => s.id === id)?.site,
    sites: () => [...new Set(catalog.map(s => s.site).filter((s): s is string => !!s))],
    found: (id: string): FoundStudy => state.studies?.[id] ?? stop(`An earlier search has to return ${id} first`),
    studyUrl: (address: string | undefined, uid: string | undefined, rest = "") => `${address}/studies/${uid}${rest}`,
    // A check reads the first answer: a 503 it provoked is what it's checking, not a reason to wait.
    retrieve: (token: string | undefined, url: string, accept?: string) => client.retrieve(token, url, c.trace, accept, false),
    decided: () => client.decided(c.trace),
    async signIn(user = "josh", o: { app?: string; sites?: string[] } = {}) {
      const t = await client.signIn({ user, ...o }, c.trace);
      if (!t.token) stop(`The sign-in ended with ${t.error}`);
      return t.accessToken!;
    },
    async loginAndSearch(user = "josh", sites?: string[]) {
      state.token = await c.signIn(user, sites ? { sites } : {});
      const r = await client.search(state.token, "patient=josh-example&_include=ImagingStudy:endpoint", c.trace);
      state.studies = Object.fromEntries(r.studies.map(s => [s.id!, s]));
      return r;
    },
  };
  return c;
}
type Context = Awaited<ReturnType<typeof checkContext>>;
type Step = [string, (c: Context) => Promise<void>];

const PAGE_CHECKS: Record<string, Step[]> = {
  "token-refresh": [
    ["Search, then retrieve", async c => {
      await c.loginAndSearch();
      const s = c.found(WRIST), r = await c.retrieve(c.state.token, c.studyUrl(s.base, s.uid));
      c.check("Instant", r.status === 200 && await c.decided() === "instant");
    }],
    ["Refresh the token and reuse the URL", async c => {
      c.state.newToken = await c.client.refresh("josh", c.trace);
      const s = c.found(WRIST), r = await c.retrieve(c.state.newToken, c.studyUrl(s.base, s.uid)), how = await c.decided();
      c.check("Accepted, after one call", r.status === 200 && how === "asked", `authorization: ${how}`);
    }],
    ["Retrieve again", async c => {
      const s = c.found(WRIST), r = await c.retrieve(c.state.newToken, c.studyUrl(s.base, s.uid)), how = await c.decided();
      c.check("Served from the cache", r.status === 200 && how === "cached", `authorization: ${how}`);
    }],
  ],
  viewer: [
    ["The app's own viewer retrieves", async c => {
      await c.loginAndSearch();
      const s = c.found(WRIST), r = await c.retrieve(c.state.token, c.studyUrl(s.base, s.uid));
      c.check("Instant", r.status === 200 && await c.decided() === "instant");
    }],
    ["A separate client gets the URL", async c => {
      const s = c.found(WRIST);
      for (const allowed of [true, false]) {
        const token = await c.signIn("josh", { app: "separate-viewer", ...(allowed ? {} : { sites: [] }) });
        const r = await c.retrieve(token, c.studyUrl(s.base, s.uid)), how = await c.decided();
        c.check(allowed ? "Released, after asking" : "Denied, after asking", r.status === (allowed ? 200 : 404) && how === "asked", `status ${r.status}, authorization: ${how}`);
      }
    }],
  ],
  "decision-outage": [
    ["Search while everything is up", async c => { await c.loginAndSearch(); c.check("Search succeeded", !!c.state.studies?.[WRIST]); }],
    ["The decision API goes down", async c => {
      const s = c.found(WRIST);
      await c.client.manage("POST", "/api/sandbox/faults", { decisionOutage: true }, c.trace);
      const a = await c.retrieve(c.state.token, c.studyUrl(s.base, s.uid));
      c.check("Still served", a.status === 200 && await c.decided() === "instant");
      c.state.newToken = await c.client.refresh("josh", c.trace);
      const b = await c.retrieve(c.state.newToken, c.studyUrl(s.base, s.uid));
      c.check("503, no data", b.status === 503 && b.parts.length === 0, `status ${b.status}`);
    }],
    ["The decision API returns", async c => {
      await c.client.manage("POST", "/api/sandbox/faults", { decisionOutage: false }, c.trace);
      const s = c.found(WRIST), r = await c.retrieve(c.state.newToken, c.studyUrl(s.base, s.uid)), how = await c.decided();
      c.check("Recovered", r.status === 200 && how === "asked", `authorization: ${how}`);
    }],
  ],
  attacks: [
    ["Get a valid URL", async c => {
      await c.loginAndSearch("josh", [RIVERSIDE]);
      const ids = Object.keys(c.state.studies ?? {});
      c.check("Only Riverside Hospital's studies returned", ids.length > 0 && ids.every(id => c.siteOf(id) === RIVERSIDE) && !!c.state.studies?.[WRIST], ids.join(", "));
    }],
    ["Substitute another Study UID", async c => {
      const s = c.found(WRIST), r = await c.retrieve(c.state.token, c.studyUrl(s.base, c.study(MRI).uid));
      c.check("404, no data", r.status === 404, `status ${r.status}`);
    }],
    ["Alter the signed context", async c => {
      const s = c.found(WRIST), [head, ctx = ""] = s.base!.split("/wado/"), parts = ctx.split(".");
      const forged = `${parts[0]}.${b64json({ ...unb64(parts[1]!), study: c.study(MRI).uid })}.${parts[2]}`;
      const r = await c.retrieve(c.state.token, c.studyUrl(`${head}/wado/${forged}`, c.study(MRI).uid));
      c.check("Rejected", r.status === 404, `status ${r.status}`);
      const none = `${b64json({ alg: "none", typ: "smart-imaging-context+jwt" })}.${parts[1]}.`;
      const rn = await c.retrieve(c.state.token, c.studyUrl(`${head}/wado/${none}`, s.uid)), how = await c.decided();
      c.check("alg:none doesn't take the fast path", how !== "instant", `authorization: ${how}, status ${rn.status}`);
    }],
    ["Use the URL with no token", async c => {
      const s = c.found(WRIST), r = await c.retrieve(undefined, c.studyUrl(s.base, s.uid));
      c.check("401", r.status === 401);
    }],
    ["Send malformed UIDs and overrides", async c => {
      const s = c.found(WRIST);
      const a = await c.retrieve(c.state.token, c.studyUrl(s.base, "abc"));
      c.check("400", a.status === 400, `status ${a.status}`);
      const b = await c.retrieve(c.state.token, `${c.studyUrl(s.base, s.uid)}?accept=application/zip`, part(EVRLE));
      c.check("The override is ignored", b.status === 200 && b.parts.every(p => p.syntax === EVRLE), `status ${b.status}`);
    }],
    ["Use an expired token", async c => {
      const s = c.found(WRIST);
      // Past the token's expiry: its lifetime is an hour, and the move is a day.
      await c.client.manage("POST", "/api/sandbox/clock", { advanceSeconds: 86400 }, c.trace);
      const r = await c.retrieve(c.state.token, c.studyUrl(s.base, s.uid)), how = await c.decided();
      c.check("401, with invalid_token", r.status === 401 && how === "asked", `status ${r.status}, authorization: ${how}`);
    }],
  ],
  "transfer-syntax": [
    ["Search", async c => { await c.loginAndSearch(); c.check("All studies available", Object.keys(c.state.studies ?? {}).length === c.catalog.length); }],
    ["Uncompressed, with no *", async c => {
      const s = c.found(WRIST), r = await c.retrieve(c.state.token, c.studyUrl(s.base, s.uid), part(EVRLE));
      c.check("Every part is .1.2.1, and labeled", r.status === 200 && r.parts.length > 0 && r.parts.every(p => p.syntax === EVRLE), `${r.parts.length} parts`);
    }],
    ["Lossless compression, by preference", async c => {
      const s = c.found(WRIST), r = await c.retrieve(c.state.token, c.studyUrl(s.base, s.uid), `${part(J2K_LOSSLESS)}, ${part(JPEG_LOSSLESS, 0.8)}, ${part(EVRLE, 0.6)}`);
      c.check("A listed syntax was returned, with labels", r.status === 200 && r.parts.every(p => [J2K_LOSSLESS, JPEG_LOSSLESS, EVRLE].includes(p.syntax ?? "")), syntaxes(r.parts));
      if (c.backend !== "orthanc") c.check("The store chose JPEG Lossless, its best available", r.parts.every(p => p.syntax === JPEG_LOSSLESS));
    }],
    ["As stored, with *", async c => {
      const s = c.found(SLIDE), r = await c.retrieve(c.state.token, c.studyUrl(s.base, s.uid), STORED_ANY);
      c.check("Each part keeps its stored syntax", r.status === 200 && r.parts.length === s.resource.numberOfInstances && r.parts.every(p => [EVRLE, JPEG_BASELINE].includes(p.syntax ?? "")) && r.parts.some(p => p.syntax === JPEG_BASELINE), syntaxes(r.parts));
    }],
    ["The lossy exception", async c => {
      const s = c.found(SLIDE), r = await c.retrieve(c.state.token, c.studyUrl(s.base, s.uid), part(EVRLE));
      if (c.backend === "orthanc") c.check("Either a correct 406, or .1.2.1 with labels", r.status === 406 || (r.status === 200 && r.parts.every(p => p.syntax === EVRLE)), `status ${r.status}`);
      else c.check("406, before any data", r.status === 406 && r.parts.length === 0, `status ${r.status}`);
    }],
    ["A syntax that can't be produced", async c => {
      const s = c.found(WRIST), r = await c.retrieve(c.state.token, c.studyUrl(s.base, s.uid), part("1.2.840.10008.1.2.4.203"));
      c.check("Either a correct 406, or only labeled parts", r.status === 406 || (r.status === 200 && r.parts.every(p => !!p.syntax)), `status ${r.status}`);
    }],
    ["No Accept header", async c => {
      // A browser sends */* when a request names no Accept, so the check sends an empty one, as the server's own check did.
      const s = c.found(WRIST), r = await c.retrieve(c.state.token, c.studyUrl(s.base, s.uid), "");
      c.check("406", r.status === 406, `status ${r.status}`);
    }],
    ["Private transfer syntaxes", async c => {
      const s = c.found(WRIST), r = await c.retrieve(c.state.token, c.studyUrl(s.base, s.uid), STORED_ANY);
      c.check("* never returns a private syntax", r.parts.every(p => p.syntax && isStandard(p.syntax)), syntaxes(r.parts));
      if (c.backend === "orthanc") { c.check("Fixture isn't loaded in Orthanc", true); return; }
      const listed = await c.retrieve(c.state.token, c.studyUrl(s.base, s.uid, `/series/${s.resource.series[0]!.uid}`), part(PRIVATE_TEST_SYNTAX));
      c.check("Listing it returns it", listed.status === 200 && listed.parts[0]?.syntax === PRIVATE_TEST_SYNTAX, listed.parts[0]?.syntax);
    }],
  ],
  truncation: [
    ["Search", async c => { await c.loginAndSearch(); c.check("MRI listed", c.found(MRI).resource.numberOfInstances > 0, `${c.found(MRI).resource.numberOfInstances} instances`); }],
    ["The backend fails partway", async c => {
      const s = c.found(MRI);
      await c.client.manage("POST", "/api/sandbox/faults", { truncateAfter: 50 }, c.trace);
      const r = await c.retrieve(c.state.token, c.studyUrl(s.base, s.uid));
      await c.client.manage("POST", "/api/sandbox/faults", { truncateAfter: null }, c.trace);
      c.check("The client sees it wasn't complete", !r.complete && r.failed, `${r.parts.length} parts, closing boundary: ${r.complete}`);
      c.check("Fewer parts than the manifest lists", r.parts.length < s.resource.numberOfInstances);
    }],
    ["Retry once the backend recovers", async c => {
      const s = c.found(MRI), r = await c.retrieve(c.state.token, c.studyUrl(s.base, s.uid));
      c.check("Complete, matching the manifest", r.complete && r.parts.length === s.resource.numberOfInstances, `${r.parts.length} parts`);
    }],
  ],
  metadata: [
    ["Retrieve metadata", async c => {
      await c.loginAndSearch();
      const s = c.found(WRIST);
      const r = await patientFetch(c.studyUrl(s.base, s.uid, "/metadata"), { headers: { authorization: `Bearer ${c.state.token}`, accept: "application/dicom+json", ...c.client.headersFor(c.trace) } });
      if (r.status !== 200) stop(`The proxy answered ${r.status} for the metadata, so there are no bulk data links to check`);
      const body = await r.json(), text = JSON.stringify(body);
      const uris = text.match(/"BulkDataURI":"[^"]+"/g)?.map(x => x.slice(15, -1)) ?? [];
      c.state.uri = uris.find(u => /7FE00010$/i.test(u)) ?? uris[0];
      c.check("Returned an item per instance", body.length === s.resource.numberOfInstances, `${body.length} items`);
      c.check("No internal hostnames", !text.includes(":4611") && !text.includes(":4610") && !text.includes("bulk:"));
      const proxy = new URL(s.base!).origin;
      c.check("Every bulk link goes through the proxy", uris.length > 0 && uris.every(u => u.startsWith(proxy)), `${uris.length} links`);
    }],
    ["Follow a bulk data link", async c => {
      const uri = c.state.uri ?? stop("The metadata has to give a bulk data link first");
      const res = await fetch(uri, { headers: { authorization: `Bearer ${c.state.token}`, accept: "multipart/related; type=application/octet-stream", ...c.client.headersFor(c.trace) } });
      const size = (await res.arrayBuffer()).byteLength;
      c.check("Bulk data returned", res.status === 200 && size > 1000, `${size} bytes`);
      const denied = await fetch(uri, { headers: c.client.headersFor(c.trace) });
      await denied.body?.cancel();
      c.check("It needs a token too", denied.status === 401, `status ${denied.status}`);
    }],
  ],
  "paged-search": [
    ["Ask for a small page", async c => {
      c.state.token = await c.signIn("josh");
      const count = c.state.count = 2;
      c.state.query = `${await c.client.imaging()}/ImagingStudy?patient=josh-example&_count=${count}`;
      const r = await c.client.searchPage(c.state.token, c.state.query, c.trace), all = c.catalog.length;
      c.state.first = r;
      c.check("The page holds what was asked for", studiesOn(r.body).length === Math.min(count, all), `${studiesOn(r.body).length} studies on this page`);
      c.check("total counts every study, across all pages", r.body.total === all, `total ${r.body.total}`);
      c.check("A next link is there when more remain", !!r.next === count < all);
      c.check("Each study's Endpoint is on the same page", endpointsOnPage(r.body));
    }],
    ["Follow next to the end", async c => {
      const first = c.state.first ?? stop("The first page has to be fetched first"), count = c.state.count!;
      const seen = studiesOn(first.body).map(s => s.id);
      let next = first.next, pages = 1, onSamePage = endpointsOnPage(first.body);
      while (next) { pages++; const r = await c.client.searchPage(c.state.token!, next, c.trace); seen.push(...studiesOn(r.body).map(s => s.id)); onSamePage &&= endpointsOnPage(r.body); next = r.next; }
      const expected = c.catalog.map(s => s.id);
      c.check("It took the expected number of pages", pages === Math.ceil(expected.length / count), `${pages} pages at ${count} per page`);
      c.check("Every study came back once, newest first", JSON.stringify(seen) === JSON.stringify(expected), seen.join(", "));
      c.check("Every page carried its own Endpoints", onSamePage);
    }],
    ["Policy changes between pages", async c => {
      const site = RIVERSIDE, token = c.state.token!;
      const first = await c.client.searchPage(token, c.state.query!, c.trace), onFirst = studiesOn(first.body).map(s => s.id);
      const remaining = c.catalog.filter(s => s.site !== site);
      // Josh narrows the app's approval, which takes effect at once.
      const approve = (sites: string[]) => c.client.manage("POST", "/api/sandbox/policy/app-approvals", { by: "user:josh", app: "app:portal-app", patient: "patient:josh-example", fhirUser: "Patient/josh-example", sites }, c.trace);
      await approve(c.sites().filter(s => s !== site));
      if (!first.next) { c.check("Everything fit on page 1, so there's no page 2 to change", true); await approve(c.sites()); return; }
      const second = await c.client.searchPage(token, first.next, c.trace), onSecond = studiesOn(second.body).map(s => s.id!);
      c.check(`Page 2 has nothing from ${site}`, second.status === 200 && onSecond.every(id => c.siteOf(id) !== site), onSecond.join(", ") || "no studies");
      c.check("total now counts only what this caller may see", second.body.total === remaining.length, `total ${second.body.total}`);
      c.check("Page 2 doesn't repeat page 1", onSecond.every(id => !onFirst.includes(id)));
      await approve(c.sites());
      const restored = await c.client.searchPage(token, first.next, c.trace);
      c.check("The same URL follows policy again", restored.status === 200 && restored.body.total === c.catalog.length && studiesOn(restored.body).length > 0, `total ${restored.body.total}`);
    }],
    ["Tamper with the cursor", async c => {
      const token = c.state.token!;
      const first = await c.client.searchPage(token, `${await c.client.imaging()}/ImagingStudy?patient=josh-example&_count=1`, c.trace);
      const next = new URL(first.next ?? stop("The search has to have a next link for its cursor to be tampered with"));
      const [payload = "", mac] = (next.searchParams.get("_cursor") ?? "").split(".");
      const forged = new URL(next);
      forged.searchParams.set("_cursor", `${b64json({ ...unb64(payload), p: 1 })}.${mac}`);
      const a = await c.client.searchPage(token, forged.toString(), c.trace);
      c.check("400, with an OperationOutcome", a.status === 400 && a.body?.resourceType === "OperationOutcome", `status ${a.status}`);
      const refiltered = new URL(next);
      refiltered.searchParams.set("identifier", "EXMRI2020");
      const b = await c.client.searchPage(token, refiltered.toString(), c.trace);
      c.check("A changed filter gets 400", b.status === 400 && b.body?.resourceType === "OperationOutcome", `status ${b.status}`);
      const robin = await c.signIn("robin");
      const d = await c.client.searchPage(robin, next.toString(), c.trace);
      c.check("The cursor grants nothing: 403", d.status === 403, `status ${d.status}`);
    }],
  ],
};

export interface Failure { step: string; label: string; detail?: string }
export interface CheckResult { ok: boolean; passed?: number; failures: Failure[]; sandbox?: string; activityUrl?: string }

/** One check, in a sandbox of its own: every step, each in a trace of its own, as one line of pass or fail. */
export async function runCheck(id: string): Promise<CheckResult> {
  const steps = PAGE_CHECKS[id];
  if (!steps) throw new Error(`This page has no check called ${id}.`);
  const made = await fetch("/api/sandboxes", { method: "POST" }).then(r => r.json());
  const sandboxId = made.base.slice("/s/".length), session = `check-${id}-${hexOf(3)}@${sandboxId}`;
  const c = await checkContext(made.base, session), failures: Failure[] = [];
  let passed = 0;
  for (const [step, run] of steps) {
    c.trace = hexOf(16); c.lines = [];
    try { await run(c); }
    catch (e) { failures.push({ step, label: (e as Error).message }); }
    for (const k of c.lines) if (k.ok) passed++; else failures.push({ step, label: k.label, detail: k.detail });
  }
  // A fault a step set is cleared, whatever happened.
  await c.client.manage("POST", "/api/sandbox/faults", { decisionOutage: false, truncateAfter: null }).catch(() => {});
  return { ok: failures.length === 0, passed, failures, sandbox: sandboxId, activityUrl: `${made.base}/activity?session=${encodeURIComponent(session)}` };
}
