import { tfetch } from "../trace";
import { EVRLE, JPEG_BASELINE, JPEG_LOSSLESS, J2K_LOSSLESS, PRIVATE_DEMO, isStandard } from "../syntax";
import { ACCEPT_ANY, siteOptions, StepStopped, studyOptions, type Flow, type Ctx } from "./runtime";
import { CONFIG } from "../config";

const WRIST = "xr-wrist-left-2012", SLIDE = "slide-lung-2023", MRI = "mri-brain-2020";
const part = (s: string, q?: number) => `multipart/related; type=application/dicom; transfer-syntax=${s}${q !== undefined ? `; q=${q}` : ""}`;

async function loginAndSearch(c: Ctx, user = "josh") {
  const t = await c.launch(user);
  c.state.token = c.launched(t);
  const r = await c.search(c.state.token);
  c.state.refresh = t.refresh_token;
  c.state.studies = r.studies;
  return r;
}
const studiesOn = (b: any): any[] => (b?.entry ?? []).filter((e: any) => e.resource.resourceType === "ImagingStudy").map((e: any) => e.resource);
/** The guide's rule for response-local Endpoints: each one is in the same Bundle as its study. */
const endpointsOnPage = (b: any) => studiesOn(b).every(s => s.endpoint.every((r: any) => b.entry.some((e: any) => e.fullUrl === r.reference && e.resource.resourceType === "Endpoint")));
const labelled = (r: { parts: { syntax?: string }[] }) => r.parts.every(p => !!p.syntax);

export const protocolFlows: Flow[] = [
  {
    id: "token-refresh", number: 7, group: "protocol", title: "Token refresh",
    summary: "The app refreshes its token and keeps using the same Endpoint URL.",
    shows: "Why the token hash doesn't burden clients: a different valid token just takes the slower path once.",
    steps: [
      { id: "start", title: "Search, then retrieve", actor: "App", doc: `<p>The token matches <code>ath</code>, so the proxy serves instantly.</p>`, run: async c => {
        await loginAndSearch(c);
        const s = c.found(WRIST);
        const r = await c.retrieve("App", "Retrieve", c.studyUrl(s.base, s.uid), c.state.token);
        c.check("Instant", r.authz === "instant" && r.status === 200);
      } },
      { id: "refresh", title: "Refresh the token and reuse the URL", actor: "App", doc: `<p>The guide requires servers to accept any currently valid token covering the study. The new token has a different hash, so the proxy asks once. The client changes nothing.</p>`, run: async c => {
        const n = await c.refresh(c.state.refresh);
        c.state.newToken = n.access_token;
        const s = c.found(WRIST);
        const r = await c.retrieve("App", "Same URL, new token", c.studyUrl(s.base, s.uid), c.state.newToken);
        c.check("Accepted, after one call", r.status === 200 && r.authz === "asked", `authorization: ${r.authz}`);
      } },
      { id: "again", title: "Retrieve again", actor: "App", doc: `<p>The decision is cached by token hash, context hash, study and operation, and never outlives the token.</p>`, run: async c => {
        const s = c.found(WRIST);
        const r = await c.retrieve("App", "Same URL, same new token", c.studyUrl(s.base, s.uid), c.state.newToken);
        c.check("Served from the cache", r.status === 200 && r.authz === "cached", `authorization: ${r.authz}`);
      } },
    ],
  },
  {
    id: "viewer", number: 8, group: "protocol", title: "Handing a URL to a viewer",
    summary: "A viewer inside the app uses the app's token. A separate client needs its own authorization.",
    shows: "The Endpoint URL can be handed around safely, because it isn't a credential.",
    steps: [
      { id: "embedded", title: "The app's own viewer retrieves", actor: "App viewer", doc: `<p>A viewer that's part of the app is the app, so it uses the app's token and gets the fast path.</p>`, run: async c => {
        await loginAndSearch(c);
        const s = c.found(WRIST);
        const r = await c.retrieve("App viewer", "Retrieve with the app's token", c.studyUrl(s.base, s.uid), c.state.token);
        c.check("Instant", r.authz === "instant" && r.status === 200);
      } },
      { id: "separate", title: "A separate client gets the URL", actor: "Separate viewer", doc: `<p>The app passes the Endpoint address and study UID to a client registered separately, which uses its own token. Whether it's authorized is up to the Imaging Server.</p>`,
        inputs: () => [{ id: "allowed", label: "Is this client authorized for Josh?", type: "select", options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }], default: "yes" }],
        run: async (c, i) => {
          const s = c.found(WRIST);
          c.setRules([{ id: "separate-viewer", description: "Policy for the separate viewer", when: { client: "separate-viewer" }, allow: i.allowed === "yes" ? { all: true } : {} }]);
          const t = await c.launch("josh", "separate-viewer");
          const r = await c.retrieve("Separate viewer", "Same URL, the viewer's own token", c.studyUrl(s.base, s.uid), c.launched(t));
          const ok = i.allowed === "yes";
          c.check(ok ? "Released, after asking" : "Denied, after asking", r.status === (ok ? 200 : 404) && r.authz === "asked", `status ${r.status}, authorization: ${r.authz}`);
        } },
    ],
  },
  {
    id: "decision-outage", number: 9, group: "protocol", title: "Decision service down",
    summary: "With the Imaging Server's decision API unavailable, the fast path keeps serving and everything else fails closed.",
    shows: "An availability benefit of the fast path, and failing closed rather than guessing.",
    steps: [
      { id: "setup", title: "Search while everything is up", actor: "App", doc: `<p>The app has a valid token and signed URLs.</p>`, run: async c => {
        await loginAndSearch(c);
        c.check("Search succeeded", !!c.state.studies[WRIST]);
      } },
      { id: "outage", title: "The decision API goes down", actor: "Operations", doc: `<p>The fast path uses only a public key, so it isn't affected. A request needing a decision can't get one. The response is <code>503</code> with <code>Retry-After</code>, which the guide allows, and no data.</p>`, run: async c => {
        const s = c.found(WRIST);
        c.stack.imaging.setOutage(true);
        const a = await c.retrieve("App", "Fast path during the outage", c.studyUrl(s.base, s.uid), c.state.token);
        c.check("Still served", a.status === 200 && a.authz === "instant");
        const n = await c.refresh(c.state.refresh);
        c.state.newToken = n.access_token;
        const b = await c.retrieve("App", "New token during the outage", c.studyUrl(s.base, s.uid), c.state.newToken);
        c.check("503, no data", b.status === 503 && b.parts.length === 0, `status ${b.status}`);
      } },
      { id: "restore", title: "The decision API returns", actor: "Operations", doc: `<p>Failures aren't cached, so the next request succeeds.</p>`, run: async c => {
        c.stack.imaging.setOutage(false);
        const s = c.found(WRIST);
        const r = await c.retrieve("App", "Retry", c.studyUrl(s.base, s.uid), c.state.newToken);
        c.check("Recovered", r.status === 200 && r.authz === "asked", `authorization: ${r.authz}`);
      } },
    ],
  },
  {
    id: "attacks", number: 10, group: "protocol", title: "Attempts to get around the checks",
    summary: "Attempts to get around the URL and token checks.",
    shows: "Griffin's warning about treating URLs as secrets: the URL alone never grants anything.",
    setup: c => { c.setRules([{ id: "wrist-only", description: "This app may see only the left wrist", when: { client: "portal-app", user: "josh" }, allow: { studies: [WRIST] } }]); },
    steps: [
      { id: "setup", title: "Get a valid URL", actor: "App", doc: `<p>The policy here lets the app see only the left wrist study.</p>`, run: async c => {
        await loginAndSearch(c);
        c.check("One study returned", Object.keys(c.state.studies).length === 1);
      } },
      { id: "substitute", title: "Substitute another Study UID", actor: "Attacker", doc: `<p>The signed context names one study. Appending a different UID fails the fast path, and the decision service refuses it.</p>`, inputs: c => [{ id: "study", label: "Study UID to substitute", type: "select", options: studyOptions(c).filter((o: any) => o.value !== WRIST), default: MRI }], run: async (c, i) => {
        const s = c.found(WRIST);
        const other = c.need(c.study(i.study), `There's no study ${i.study}`);
        const r = await c.retrieve("Attacker", "Valid URL, other study", c.studyUrl(s.base, other.uid), c.state.token);
        c.check("404, no data", r.status === 404, `status ${r.status}`);
      } },
      { id: "alter", title: "Alter the signed context", actor: "Attacker", doc: `<p>Changing the payload breaks the signature. The algorithm is pinned to EdDSA, so a forged header doesn't help.</p>`, run: async c => {
        const s = c.found(WRIST);
        const [head, ctx] = s.base.split("/wado/");
        const parts = ctx.split(".");
        const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString());
        claims.study = c.study(MRI).uid;
        const forged = `${parts[0]}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${parts[2]}`;
        const r = await c.retrieve("Attacker", "Edited context", c.studyUrl(`${head}/wado/${forged}`, c.study(MRI).uid), c.state.token);
        c.check("Rejected", r.status === 404, `status ${r.status}`);
        const none = `${Buffer.from(JSON.stringify({ alg: "none", typ: "smart-imaging-context+jwt" })).toString("base64url")}.${parts[1]}.`;
        const rn = await c.retrieve("Attacker", "alg: none", c.studyUrl(`${head}/wado/${none}`, s.uid), c.state.token);
        c.check("alg:none doesn't take the fast path", rn.authz !== "instant", `authorization: ${rn.authz}, status ${rn.status}`);
      } },
      { id: "no-token", title: "Use the URL with no token", actor: "Attacker", doc: `<p>The URL isn't a credential.</p>`, run: async c => {
        const s = c.found(WRIST);
        const r = await c.retrieve("Attacker", "URL only", c.studyUrl(s.base, s.uid), null);
        c.check("401", r.status === 401);
      } },
      { id: "bad-input", title: "Send malformed UIDs and overrides", actor: "Attacker", doc: `<p>UIDs are validated by grammar before any backend sees them, and client query parameters are dropped. Research found dcm4chee's <code>?accept=</code> overrides the header.</p>`, run: async c => {
        const s = c.found(WRIST);
        const a = await c.retrieve("Attacker", "Non-numeric UID", c.studyUrl(s.base, "abc"), c.state.token);
        c.check("400", a.status === 400, `status ${a.status}`);
        const b = await c.retrieve("Attacker", "Query override ignored", `${c.studyUrl(s.base, s.uid)}?accept=application/zip`, c.state.token, part(EVRLE));
        c.check("The override is ignored", b.status === 200 && b.parts.every(p => p.syntax === EVRLE), `status ${b.status}`);
      } },
      { id: "expired", title: "Use an expired token", actor: "Attacker", doc: `<p>This moves the clock past the token's expiry. <code>exp</code> is capped at the token's lifetime, so the fast path has ended too, and the proxy asks.</p>`, run: async c => {
        const s = c.found(WRIST);
        c.advanceClock(4000);
        const r = await c.retrieve("Attacker", "Expired token", c.studyUrl(s.base, s.uid), c.state.token);
        c.check("401, with invalid_token", r.status === 401 && r.authz === "asked", `status ${r.status}, authorization: ${r.authz}`);
      } },
    ],
  },
  {
    id: "transfer-syntax", number: 11, group: "protocol", title: "Asking for image formats",
    summary: "What the guide says each Accept should produce, and what the backend does underneath.",
    shows: "Griffin's points: clients needn't send *, 406 is real, parts are labeled, private syntaxes stay hidden, and lossy data is the exception.",
    steps: [
      { id: "setup", title: "Search", actor: "App", doc: `<p>Stored data: most instances are Explicit VR Little Endian (<code>.1.2.1</code>). The slide is JPEG Baseline. The left wrist also has a JPEG Lossless variant on the store-backed backends.</p>`, run: async c => {
        await loginAndSearch(c);
        c.check("All studies available", Object.keys(c.state.studies).length === c.studies().length);
      } },
      { id: "uncompressed", title: "Uncompressed, with no *", actor: "App", doc: `<p>A client that lists only what it decodes never gets an unusable download. This was Griffin's central point.</p>`, run: async c => {
        const s = c.found(WRIST);
        const r = await c.retrieve("App", "Accept .1.2.1", c.studyUrl(s.base, s.uid), c.state.token, part(EVRLE));
        c.check("Every part is .1.2.1, and labeled", r.status === 200 && r.parts.length > 0 && r.parts.every(p => p.syntax === EVRLE), `${r.parts.length} parts`);
      } },
      { id: "preference", title: "Lossless compression, by preference", actor: "App", doc: `<p>Items are tried from highest <code>q</code> to lowest. Orthanc uses only the top item, so the proxy retries down the list for it.</p>`, run: async c => {
        const s = c.found(WRIST);
        const accept = `${part(J2K_LOSSLESS)}, ${part(JPEG_LOSSLESS, 0.8)}, ${part(EVRLE, 0.6)}`;
        const r = await c.retrieve("App", "Prefer compression", c.studyUrl(s.base, s.uid), c.state.token, accept);
        c.check("A listed syntax was returned, with labels", r.status === 200 && r.parts.every(p => [J2K_LOSSLESS, JPEG_LOSSLESS, EVRLE].includes(p.syntax ?? "")), [...new Set(r.parts.map(p => p.syntax))].join(", "));
        if (c.backend !== "orthanc") c.check("The store chose JPEG Lossless, its best available", r.parts.every(p => p.syntax === JPEG_LOSSLESS));
      } },
      { id: "as-stored", title: "As stored, with *", actor: "App", doc: `<p>The whole-slide study mixes JPEG Baseline tile levels with uncompressed images. Under <code>*</code>, each instance keeps its own stored syntax, with no added lossy compression, and each part says which it is.</p>`, run: async c => {
        const s = c.found(SLIDE);
        const r = await c.retrieve("App", "Accept *", c.studyUrl(s.base, s.uid), c.state.token, ACCEPT_ANY);
        const stored = [EVRLE, JPEG_BASELINE];
        c.check("Each part keeps its stored syntax", r.status === 200 && r.parts.length === s.resource.numberOfInstances && r.parts.every(p => stored.includes(p.syntax ?? "")) && r.parts.some(p => p.syntax === JPEG_BASELINE), [...new Set(r.parts.map(p => p.syntax))].join(", "));
      } },
      { id: "lossy", title: "The lossy exception", actor: "App", doc: `<p>The guide excuses servers from <code>.1.2.1</code> when pixel data is available only in a standard lossy syntax. Some of this study's instances are JPEG Baseline, and the store-backed backends use that exception, so a <code>.1.2.1</code>-only request for the study gets <code>406</code>. Orthanc can decode it, which also conforms.</p>`, run: async c => {
        const s = c.found(SLIDE);
        const r = await c.retrieve("App", "Accept .1.2.1 for a lossy study", c.studyUrl(s.base, s.uid), c.state.token, part(EVRLE));
        if (c.backend === "orthanc") c.check("Either a correct 406, or .1.2.1 with labels", r.status === 406 || (r.status === 200 && r.parts.every(p => p.syntax === EVRLE)), `status ${r.status}`);
        else c.check("406, before any data", r.status === 406 && r.parts.length === 0, `status ${r.status}`);
      } },
      { id: "unsupported", title: "A syntax that can't be produced", actor: "App", doc: `<p>Research found Orthanc answers with <code>400</code> or <code>500</code> here, and dcm4chee with <code>500</code>. The proxy turns those into <code>406</code>. If an instance can't be provided, this demo refuses the whole request. The guide leaves mixed results open, and an app can then ask for smaller resources.</p>`,
        inputs: () => [{ id: "accept", label: "Accept header", type: "text", default: part("1.2.840.10008.1.2.4.203"), help: "Try your own. Omit transfer-syntax to get the default." }],
        run: async (c, i) => {
          const s = c.found(WRIST);
          const r = await c.retrieve("App", "Your Accept header", c.studyUrl(s.base, s.uid), c.state.token, i.accept);
          c.check("Either a correct 406, or only labeled parts", r.status === 406 || (r.status === 200 && labelled(r)), `status ${r.status}`);
          if (c.backend === "orthanc") {
            const raw = await c.stack.backends.orthanc.rawProbe!(`/studies/${s.uid}`, `multipart/related; type="application/dicom"; transfer-syntax=${i.accept.match(/transfer-syntax=([^;,\s]+)/)?.[1] ?? "*"}`);
            c.exchanges.push({ title: "What Orthanc itself returned", actor: "Proxy (for comparison)", method: "GET", url: `${CONFIG.orthanc.base}/dicom-web/studies/…`, requestHeaders: {}, status: raw.status, responseHeaders: raw.contentType ? { "content-type": raw.contentType } : {}, summary: raw.partSyntaxLabel ? `First part header: ${raw.partSyntaxLabel}` : undefined, body: raw.status >= 400 ? raw.bodyPreview : undefined });
          }
        } },
      { id: "no-accept", title: "No Accept header", actor: "App", doc: `<p>PS3.18 §8.7.5 says a request without an <code>Accept</code> header gets <code>406</code>. Research found both Orthanc and dcm4chee return <code>200</code> instead.</p>`, run: async c => {
        const s = c.found(WRIST);
        const res = await tfetch("app", "Retrieve with an empty Accept header", c.studyUrl(s.base, s.uid), { headers: { Authorization: `Bearer ${c.state.token}`, Accept: "" } });
        await res.body?.cancel();
        c.exchanges.push({ title: "Empty Accept", actor: "App", method: "GET", url: "(study URL)", requestHeaders: {}, status: res.status, responseHeaders: {} });
        c.check("406", res.status === 406, `status ${res.status}`);
      } },
      { id: "private", title: "Private transfer syntaxes", actor: "App", doc: `<p>One instance on the store-backed backends has a synthetic private syntax label. Under <code>*</code>, the client gets a standard syntax. It gets the private one only by listing it. Orthanc wasn't given this fixture.</p>`, run: async c => {
        const s = c.found(WRIST);
        const r = await c.retrieve("App", "Accept *", c.studyUrl(s.base, s.uid), c.state.token, ACCEPT_ANY);
        c.check("* never returns a private syntax", r.parts.every(p => p.syntax && isStandard(p.syntax)), [...new Set(r.parts.map(p => p.syntax))].join(", "));
        if (c.backend === "orthanc") { c.check("Fixture isn't loaded in Orthanc", true); return; }
        const series = s.resource.series[0].uid;
        const listed = await c.retrieve("App", "Accept the private syntax explicitly", c.studyUrl(s.base, s.uid, `/series/${series}`), c.state.token, part(PRIVATE_DEMO));
        c.check("Listing it returns it", listed.status === 200 && listed.parts[0]?.syntax === PRIVATE_DEMO, listed.parts[0]?.syntax);
      } },
    ],
  },
  {
    id: "truncation", number: 12, group: "protocol", title: "A backend stops partway",
    summary: "The backend stops partway through a study. The client has to be able to tell.",
    shows: "Research found Orthanc and dcm4chee end cleanly with no closing boundary, so a byte-copying proxy makes a broken study look complete.",
    steps: [
      { id: "setup", title: "Search", actor: "App", doc: `<p>The instance list from search is what lets a client confirm it got everything.</p>`, run: async c => {
        await loginAndSearch(c);
        c.check("MRI listed", c.found(MRI).resource.numberOfInstances > 0, `${c.found(MRI).resource.numberOfInstances} instances`);
      } },
      { id: "fail", title: "The backend fails partway", actor: "Backend", doc: `<p>A fault injected at the backend boundary ends the stream early. The proxy aborts the connection, with no closing boundary, so the failure is visible. Status was already sent, so only the transport can signal it.</p>`,
        inputs: () => [{ id: "after", label: "Instances before failure", type: "select", options: ["5", "50", "200"].map(v => ({ value: v, label: v })), default: "50" }],
        run: async (c, i) => {
          const s = c.found(MRI);
          c.stack.setTruncateAfter(Number(i.after));
          const r = await c.retrieve("App", "Retrieve during the failure", c.studyUrl(s.base, s.uid), c.state.token);
          c.stack.setTruncateAfter(undefined);
          c.check("The client sees it wasn't complete", !r.complete && r.failed, `${r.parts.length} parts, closing boundary: ${r.complete}`);
          c.check("Fewer parts than the manifest lists", r.parts.length < s.resource.numberOfInstances);
        } },
      { id: "retry", title: "Retry once the backend recovers", actor: "App", doc: `<p>The same request now succeeds, with a closing boundary.</p>`, run: async c => {
        const s = c.found(MRI);
        const r = await c.retrieve("App", "Retry", c.studyUrl(s.base, s.uid), c.state.token);
        c.check("Complete, matching the manifest", r.complete && r.parts.length === s.resource.numberOfInstances, `${r.parts.length} parts`);
      } },
    ],
  },
  {
    id: "metadata", number: 13, group: "protocol", title: "Metadata links through the proxy",
    summary: "WADO-RS metadata can expose internal hostnames, and its bulk data links have to work through the proxy.",
    shows: "Research found Orthanc and dcm4chee return absolute internal URLs. No static setting can add the per-request signed prefix.",
    steps: [
      { id: "get", title: "Retrieve metadata", actor: "App", doc: `<p>The proxy rewrites <code>BulkDataURI</code> values recursively, including inside sequences, to its own route under the same signed base.</p>`, run: async c => {
        await loginAndSearch(c);
        const s = c.found(WRIST);
        const url = c.studyUrl(s.base, s.uid, "/metadata");
        const r = await c.json("App", "GET /metadata", url, { headers: { Authorization: `Bearer ${c.state.token}`, Accept: "application/dicom+json" } });
        if (r.status !== 200) throw new StepStopped(`The proxy answered ${r.status} for the metadata, so there are no bulk data links to check`);
        const text = JSON.stringify(r.body);
        const uris: string[] = text.match(/"BulkDataURI":"[^"]+"/g)?.map(x => x.slice(15, -1)) ?? [];
        c.state.uri = uris.find(u => /7FE00010$/i.test(u)) ?? uris[0];
        c.exchanges[c.exchanges.length - 1]!.body = { items: r.body.length, sample: { "00080018": r.body[0]["00080018"], "7FE00010": r.body[0]["7FE00010"] } };
        c.check("Returned an item per instance", r.status === 200 && r.body.length === s.resource.numberOfInstances, `${r.body.length} items`);
        c.check("No internal hostnames", !text.includes(":4611") && !text.includes(":4610") && !text.includes("bulk:"));
        c.check("Every bulk link goes through the proxy", uris.length > 0 && uris.every(u => u.startsWith(CONFIG.proxyUrl)), `${uris.length} links`);
        if (c.backend === "orthanc") {
          const raw = await c.stack.backends.orthanc.rawProbe!(`/studies/${s.uid}/metadata`, "application/dicom+json");
          c.exchanges.push({ title: "What Orthanc itself returned", actor: "Proxy (for comparison)", method: "GET", url: `${CONFIG.orthanc.base}/dicom-web/studies/…/metadata`, requestHeaders: {}, status: raw.status, responseHeaders: {}, summary: "Orthanc's own BulkDataURI values are absolute internal URLs." });
        }
      } },
      { id: "bulk", title: "Follow a bulk data link", actor: "App", doc: `<p>A bulk route has the same authorization as everything else. Without one, the rewritten links would <code>404</code>.</p>`, run: async c => {
        c.need(c.state.uri, "The metadata has to give a bulk data link first");
        const start = performance.now();
        const res = await tfetch("app", "Retrieve the BulkDataURI", c.state.uri, { headers: { Authorization: `Bearer ${c.state.token}`, Accept: "multipart/related; type=application/octet-stream" } });
        const bytes = (await res.arrayBuffer()).byteLength;
        c.exchanges.push({ title: "Follow BulkDataURI", actor: "App", method: "GET", url: c.state.uri.replace(/\/wado\/([^/]{16})[^/]*\//, "/wado/$1…/"), requestHeaders: { Accept: "multipart/related; type=application/octet-stream" }, status: res.status, responseHeaders: Object.fromEntries(res.headers), summary: `${(bytes / 1e6).toFixed(1)} MB of bulk data`, ms: Math.round(performance.now() - start) });
        c.check("Bulk data returned", res.status === 200 && bytes > 1000, `${bytes} bytes`);
        const denied = await tfetch("app", "Retrieve the BulkDataURI with no token", c.state.uri);
        await denied.body?.cancel();
        c.check("It needs a token too", denied.status === 401, `status ${denied.status}`);
      } },
    ],
  },
  {
    id: "paged-search", number: 14, group: "protocol", title: "Paged search",
    summary: "The app asks for a few studies at a time and follows next links, while policy runs again on every page.",
    shows: "A cursor says where a search got to and grants nothing: changing policy between pages changes the next page, and a tampered cursor is refused.",
    steps: [
      { id: "first", title: "Ask for a small page", actor: "App", doc: `<p><code>_count</code> sets the page size. The default is 20, and the most a page holds is 100. <code>total</code> counts every study this caller may see, across all pages. A page always carries the Endpoint for each study on it, even when the request omits <code>_include</code>.</p>`,
        inputs: () => [{ id: "count", label: "Studies per page", type: "select", options: ["1", "2", "3", "6"].map(v => ({ value: v, label: v })), default: "2" }],
        run: async (c, i) => {
          c.state.token = c.launched(await c.launch("josh"));
          c.state.count = Number(i.count);
          c.state.query = `${CONFIG.imagingUrl}/fhir/ImagingStudy?patient=josh-example&_count=${c.state.count}`;
          const r = await c.searchPage("First page", c.state.token, c.state.query);
          const all = c.studies().length;
          c.state.first = r;
          c.check("The page holds what was asked for", studiesOn(r.body).length === Math.min(c.state.count, all), `${studiesOn(r.body).length} studies on this page`);
          c.check("total counts every study, across all pages", r.body.total === all, `total ${r.body.total}`);
          c.check("A next link is there when more remain", !!r.next === c.state.count < all);
          c.check("Each study's Endpoint is on the same page", endpointsOnPage(r.body));
        } },
      { id: "follow", title: "Follow next to the end", actor: "App", doc: `<p>The app treats the <code>next</code> URL as opaque. Studies come newest first, in a stable order, and each page is evaluated when it's asked for.</p>`, run: async c => {
        c.need(c.state.first, "The first page has to be fetched first");
        const seen: string[] = studiesOn(c.state.first.body).map(s => s.id);
        let next = c.state.first.next as string | undefined, pages = 1, onSamePage = endpointsOnPage(c.state.first.body);
        while (next) {
          pages++;
          const r = await c.searchPage(`Page ${pages}`, c.state.token, next);
          seen.push(...studiesOn(r.body).map(s => s.id));
          onSamePage &&= endpointsOnPage(r.body);
          next = r.next;
        }
        const expected = [...c.studies()].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "") || b.pk - a.pk).map(s => s.id);
        c.check("It took the expected number of pages", pages === Math.ceil(expected.length / c.state.count), `${pages} pages at ${c.state.count} per page`);
        c.check("Every study came back once, newest first", JSON.stringify(seen) === JSON.stringify(expected), seen.join(", "));
        c.check("Every page carried its own Endpoints", onSamePage);
      } },
      { id: "policy", title: "Policy changes between pages", actor: "Imaging Server", doc: `<p>The app reads page 1, and then a site is taken away from this app. The cursor in the <code>next</code> link was issued before that, and it makes no difference: policy runs again, so page 2 and its <code>total</code> reflect the change. Putting the site back makes the same URL return those studies again.</p>`,
        inputs: c => [{ id: "site", label: "Site to take away after page 1", type: "select", options: siteOptions(c), default: "Riverside Hospital" }],
        run: async (c, i) => {
          const first = await c.searchPage("Page 1, before the change", c.state.token, c.state.query);
          const onFirst = studiesOn(first.body).map(s => s.id);
          const remaining = c.studies().filter(s => s.site !== i.site);
          c.setRules([{ id: "site-removed", description: `This app may no longer see ${i.site}`, when: { client: "portal-app", user: "josh" }, allow: { sites: c.sites().filter(s => s !== i.site) } }]);
          if (!first.next) { c.check("Everything fit on page 1, so there's no page 2 to change", true); c.setRules([]); return; }
          const second = await c.searchPage("Page 2, after the change", c.state.token, first.next);
          const onSecond = studiesOn(second.body).map(s => s.id);
          c.check(`Page 2 has nothing from ${i.site}`, second.status === 200 && onSecond.every(id => c.siteOf(id) !== i.site), onSecond.join(", ") || "no studies");
          c.check("total now counts only what this caller may see", second.body.total === remaining.length, `total ${second.body.total}`);
          c.check("Page 2 doesn't repeat page 1", onSecond.every(id => !onFirst.includes(id)));
          c.setRules([]);
          const restored = await c.searchPage("The same next URL, with the site back", c.state.token, first.next);
          c.check("The same URL follows policy again", restored.status === 200 && restored.body.total === c.studies().length && studiesOn(restored.body).length > 0, `total ${restored.body.total}`);
        } },
      { id: "tamper", title: "Tamper with the cursor", actor: "Attacker", doc: `<p>A cursor is signed with a key only the Imaging Server holds, and it carries a hash of the search's filters. An edited cursor gets <code>400</code>, and so does a valid cursor sent with different filters. A valid cursor doesn't help a caller who can't search this patient.</p>`, run: async c => {
        const first = await c.searchPage("Get a next link", c.state.token, `${CONFIG.imagingUrl}/fhir/ImagingStudy?patient=josh-example&_count=1`);
        const next = new URL(c.need(first.next, "The search has to have a next link for its cursor to be tampered with"));
        const cursor = next.searchParams.get("_cursor")!;
        const [payload, mac] = cursor.split(".");
        const claims = JSON.parse(Buffer.from(payload!, "base64url").toString());
        const forged = new URL(next);
        forged.searchParams.set("_cursor", `${Buffer.from(JSON.stringify({ ...claims, p: 1 })).toString("base64url")}.${mac}`);
        const a = await c.searchPage("An edited position", c.state.token, forged.toString(), "Attacker");
        c.check("400, with an OperationOutcome", a.status === 400 && a.body.resourceType === "OperationOutcome", `status ${a.status}`);
        const refiltered = new URL(next);
        refiltered.searchParams.set("identifier", "EXMRI2020");
        const b = await c.searchPage("A valid cursor with a changed filter", c.state.token, refiltered.toString(), "Attacker");
        c.check("A changed filter gets 400", b.status === 400 && b.body.resourceType === "OperationOutcome", `status ${b.status}`);
        const robin = c.launched(await c.launch("robin"));
        const d = await c.searchPage("A valid cursor with someone else's token", robin, next.toString(), "Attacker");
        c.check("The cursor grants nothing: 403", d.status === 403, `status ${d.status}`);
      } },
    ],
  },
];
