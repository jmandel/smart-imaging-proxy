import { CONFIG } from "../config";
import { siteOptions, studyOptions, type Flow, type Ctx } from "./runtime";

const WRIST = "xr-wrist-left-2012", SLIDE = "slide-lung-2023", MRI = "mri-brain-2020", CT = "ct-abdomen-pelvis-2012";
const SEARCH_DOC = `<p>Search follows the guide's <code>ImagingStudy?patient=...&amp;_include=ImagingStudy:endpoint</code>. Each returned study has a response-local Endpoint, whose <code>address</code> carries a signed context. The app treats it as an opaque base URL.</p>`;
const FAST_DOC = `<p>The proxy verifies the signature with a public key, checks expiry, checks the study is in the context, and compares the token's hash to <code>ath</code>. No network call is needed, so the label reads <b>instant</b>.</p>`;
const ASK_DOC = `<p>The proxy can't answer from the URL, so it calls <code>POST /access/v1/evaluation</code> on the Imaging Server, an <a href="https://openid.net/specs/authorization-api-1_0.html">AuthZEN</a> Access Evaluation. A denial becomes a <code>404</code>, the same as a study that doesn't exist.</p>`;

export const policyFlows: Flow[] = [
  {
    id: "patient-sites", number: 1, group: "policy", title: "Patient chooses sites",
    summary: "At consent, Josh picks which sites an app can see. The token's scope stays patient/ImagingStudy.rs either way.",
    shows: "A restriction the SMART scope language can't express, enforced consistently by search and retrieval.",
    steps: [
      {
        id: "consent", title: "Josh launches the app and approves sites", actor: "Patient", doc: `<p>A real SMART standalone launch. The app discovers the endpoints and sends an authorization request with a PKCE challenge. On the Authorization Server's own pages, Josh signs in and approves. It redirects back with a single-use code, which the app exchanges along with its PKCE verifier.</p><p>The site choice is kept as Imaging Server policy, so the token's scope is the same whatever Josh picks.</p>`,
        inputs: c => [
          { id: "mode", label: "Who signs in and approves", type: "select", options: [{ value: "window", label: "You, in a real window (Josh Example is preselected)" }, { value: "scripted", label: "Scripted, with the sites below" }], default: "scripted", clickDefault: "window" },
          { id: "sites", label: "Sites to approve, when scripted", type: "multi", options: siteOptions(c), default: ["Lakeside Imaging", "Northside Pathology"] },
        ],
        run: async (c, i) => {
          const t = await c.launch("josh", "portal-app", i.mode === "window" ? { window: true } : { sites: i.sites });
          c.state.token = t.access_token;
          const grant = c.stack.imaging.getPolicy().appGrants.find(g => g.client === "portal-app" && g.user === "josh");
          c.state.sites = grant?.sites ?? c.sites();
          c.check("Scope is unchanged by the choice", t.scope.includes("patient/ImagingStudy.rs") && !/site/i.test(t.scope), t.scope);
          c.check("Token has the patient context from the launch", t.patient === "josh-example", t.patient);
        },
      },
      {
        id: "search", title: "App searches for studies", actor: "App", doc: SEARCH_DOC,
        run: async c => {
          const r = await c.search(c.state.token);
          c.state.studies = r.studies;
          const expected = c.studies().filter(s => c.state.sites.includes(s.site)).length;
          c.check("Only studies from approved sites are returned", Object.keys(r.studies).length === expected && Object.keys(r.studies).every(id => c.state.sites.includes(c.siteOf(id))), `${Object.keys(r.studies).length} of ${c.studies().length} studies`);
        },
      },
      {
        id: "retrieve", title: "App retrieves an approved study", actor: "App", doc: FAST_DOC,
        inputs: c => { const ids = Object.keys(c.state.studies ?? {}); return [{ id: "study", label: "Study to retrieve", type: "select", options: studyOptions(c).filter((o: any) => ids.includes(o.value)), default: ids.includes(SLIDE) ? SLIDE : ids[0] }]; },
        run: async (c, i) => {
          if (!i.study) { c.check("Nothing approved, so nothing to retrieve", true); return; }
          const s = c.state.studies[i.study];
          const r = await c.retrieve("App", "Retrieve the study", c.studyUrl(s.base, s.uid), c.state.token);
          c.check("Served instantly, with no decision call", r.status === 200 && r.authz === "instant", `authorization: ${r.authz}`);
          c.check("The response is complete", r.complete);
        },
      },
      {
        id: "unapproved", title: "App asks for a study directly by UID", actor: "App", doc: `${ASK_DOC}<p>This uses a plain URL, as a client would after learning a UID elsewhere, such as from a report.</p>`,
        inputs: c => [{ id: "study", label: "Study to request", type: "select", options: studyOptions(c), default: CT }],
        run: async (c, i) => {
          const s = c.study(i.study);
          const r = await c.retrieve("App", "Request by Study UID", c.studyUrl(c.plainBase(), s.uid), c.state.token);
          const ok = c.state.sites.includes(c.siteOf(i.study));
          c.check(ok ? "Approved site: released" : "Unapproved site: 404, with no data", r.status === (ok ? 200 : 404), `status ${r.status}, authorization: ${r.authz}`);
        },
      },
    ],
  },
  {
    id: "caregiver", number: 2, group: "policy", title: "Related person, then app",
    summary: "Josh signs in and shares some sites with Sam, his caregiver. Sam signs in as Sam and gives an app some of what they hold.",
    shows: "Each link in patient, related person, app can only narrow access. All of it stays at the Imaging Server, and the proxy never learns any of it.",
    steps: [
      {
        id: "delegate", title: "Josh signs in and shares with Sam", actor: "Patient", doc: `<p>Josh signs in to the account page and picks which sites Sam can see. Sam has their own account, separate from Josh's. The Imaging Server keeps the delegation.</p>`,
        inputs: c => [
          { id: "mode", label: "Who signs in and shares", type: "select", options: [{ value: "window", label: "You, in a real window (Josh Example is preselected)" }, { value: "scripted", label: "Scripted, with the sites below" }], default: "scripted", clickDefault: "window" },
          { id: "sites", label: "Sites Sam can see, when scripted", type: "multi", options: siteOptions(c), default: ["Lakeside Imaging", "Riverside Hospital"] },
        ],
        run: async (c, i) => {
          await c.delegate("josh", "sam-caregiver", "caregiver", i.sites, { window: i.mode === "window" });
          const d = c.stack.imaging.getPolicy().delegations.find(x => x.delegate === "sam-caregiver");
          c.check("The Imaging Server holds the delegation", !!d, d?.sites.join(", "));
          c.state.delegated = d?.sites ?? [];
        },
      },
      {
        id: "unrelated", title: "Someone with no delegation tries", actor: "Alex", doc: `<p>Alex has an account, but Josh hasn't shared anything with them. Signing in isn't enough, so no code is issued.</p>`,
        run: async c => {
          const t = await c.launch("alex-neighbor");
          c.check("Alex can sign in, but gets no token", t.error === "access_denied" && !t.access_token, t.error);
        },
      },
      {
        id: "sam-launch", title: "Sam signs in and authorizes an app", actor: "Related person", doc: `<p>Sam runs a real SMART launch with their own account. The patient picker offers Josh, because of the delegation. Sam can give the app part of what they hold, and can't give it more: any site outside the delegation is dropped, even if a form submits it.</p>`,
        inputs: c => [
          { id: "mode", label: "Who signs in and approves", type: "select", options: [{ value: "window", label: "You, in a real window (Sam Example is preselected)" }, { value: "scripted", label: "Scripted, with the sites below" }], default: "scripted", clickDefault: "window" },
          { id: "sites", label: "Sites for the app, when scripted. Tick one Sam doesn't hold to see it dropped.", type: "multi", options: siteOptions(c), default: ["Lakeside Imaging", "Northside Pathology"] },
        ],
        run: async (c, i) => {
          const t = await c.launch("sam-caregiver", "portal-app", i.mode === "window" ? { window: true } : { sites: i.sites });
          c.state.sam = t.access_token;
          const g = c.stack.imaging.getPolicy().appGrants.find(x => x.user === "sam-caregiver");
          c.state.appSites = g?.sites ?? c.state.delegated;
          c.check("The app holds no more than Sam was given", c.state.appSites.every((s: string) => c.state.delegated.includes(s)), c.state.appSites.join(", "));
          c.check("The token names Josh as the patient, and no sites", t.patient === "josh-example" && !/site/i.test(t.scope ?? ""), t.scope);
        },
      },
      {
        id: "searches", title: "Josh's app and Sam's app search", actor: "App", doc: `${SEARCH_DOC}<p>Both tokens have the same patient and scope. The results differ because the chain differs.</p>`,
        run: async c => {
          c.state.josh = (await c.launch("josh")).access_token;
          const j = await c.search(c.state.josh, undefined, "App (Josh)");
          const s = await c.search(c.state.sam, undefined, "App (Sam)");
          c.state.joshStudies = j.studies;
          c.state.samStudies = s.studies;
          c.check("Josh sees every study", Object.keys(j.studies).length === c.studies().length);
          c.check("Sam's app sees only sites in both links", Object.keys(s.studies).every(id => c.state.appSites.includes(c.siteOf(id)) && c.state.delegated.includes(c.siteOf(id))) && Object.keys(s.studies).length < Object.keys(j.studies).length, Object.keys(s.studies).join(", "));
        },
      },
      {
        id: "shared-url", title: "Josh's URL reaches Sam", actor: "App (Sam)", doc: `<p>Say a URL issued to Josh reaches Sam through a shared device or log. Sam's token doesn't match <code>ath</code>, so the proxy asks rather than answering from the URL.</p>`,
        run: async c => {
          const id = Object.keys(c.state.joshStudies).find(k => !c.state.samStudies[k])!;
          const s = c.state.joshStudies[id];
          const r = await c.retrieve("App (Sam)", "Use Josh's URL with Sam's token", c.studyUrl(s.base, s.uid), c.state.sam);
          c.check("Denied, after asking", r.status === 404 && r.authz === "asked", `status ${r.status}, authorization: ${r.authz}`);
          const own = await c.retrieve("App (Josh)", "Josh uses the same URL", c.studyUrl(s.base, s.uid), c.state.josh);
          c.check("Josh still gets it, instantly", own.status === 200 && own.authz === "instant", `authorization: ${own.authz}`);
        },
      },
      {
        id: "revoke", title: "Josh revokes Sam", actor: "Patient", doc: `<p>Josh revokes the delegation on the account page. Search changes at once. A URL Sam already holds works until it expires, then the proxy asks and is refused. Removing one link ends everything after it, including Sam's app.</p>`,
        run: async c => {
          const before = await c.search(c.state.sam, undefined, "App (Sam)");
          const id = Object.keys(before.studies)[0]!;
          const s = before.studies[id];
          await c.revokeDelegation("josh", "sam-caregiver");
          const after = await c.search(c.state.sam, undefined, "App (Sam)");
          c.check("Search reflects it immediately", Object.keys(after.studies).length === 0);
          const inside = await c.retrieve("App (Sam)", "A URL Sam already holds", c.studyUrl(s.base, s.uid), c.state.sam);
          c.check("The existing URL still works until it expires", inside.status === 200 && inside.authz === "instant", "This is the revocation window");
          c.advanceClock(c.stack.imaging.getPolicy().contextLifetimeSeconds + 5);
          const later = await c.retrieve("App (Sam)", "The same URL, after expiry", c.studyUrl(s.base, s.uid), c.state.sam);
          c.check("Then the proxy asks, and access has ended", later.status === 404 && later.authz === "asked", `status ${later.status}, authorization: ${later.authz}`);
        },
      },
    ],
  },
  {
    id: "backend-referral", number: 3, group: "policy", title: "Backend referral service",
    summary: "A hand-surgery referral service is pre-authorized for specific imaging. Its system token names no patient.",
    shows: "The main Backend Services case: real client assertions, a system-scoped token, and policy the proxy never sees.",
    steps: [
      {
        id: "discover", title: "The service discovers the imaging endpoint", actor: "hand-referral-service", doc: `<p>Discovery follows the guide: <code>smart-imaging-access</code> and the Backend Services capability in <code>associated_endpoints</code>.</p>`,
        run: async c => {
          const r = await c.json("hand-referral-service", "Read SMART configuration", `${CONFIG.authUrl}/fhir/.well-known/smart-configuration`);
          const caps = r.body.associated_endpoints[0].capabilities;
          c.check("Imaging and Backend Services capabilities are advertised", caps.includes("smart-imaging-access") && caps.includes("http://fhir.org/argonaut/smart-imaging/capabilities/backend-services"));
          c.check("client_credentials is advertised", r.body.grant_types_supported.includes("client_credentials"));
        },
      },
      {
        id: "token", title: "It obtains a token, with policy set out of band", actor: "hand-referral-service", doc: `<p>The token comes from a signed client assertion, as in SMART Backend Services. What the service may see is configured separately, and you can choose it here. Nothing about it appears in the token.</p>`,
        inputs: () => [{ id: "modalities", label: "Modalities pre-authorized by the health system", type: "multi", options: [{ value: "CR", label: "CR (X-rays)" }, { value: "CT", label: "CT" }, { value: "MR", label: "MR" }, { value: "SM", label: "SM (pathology)" }], default: ["CR"] }],
        run: async (c, i) => {
          c.state.modalities = i.modalities;
          c.setRules([{ id: "hand-referral", description: "Referral program: pre-authorized modalities", when: { client: "hand-referral-service", patient: "josh-example" }, allow: { modalities: i.modalities } }]);
          const t = await c.backendToken("hand-referral-service");
          c.state.token = t.access_token;
          c.check("The token names no patient", t.patient === undefined);
          c.check("Scope is system/ImagingStudy.rs", t.scope === "system/ImagingStudy.rs", t.scope);
        },
      },
      {
        id: "search", title: "It searches for an authorized patient", actor: "hand-referral-service", doc: SEARCH_DOC,
        run: async c => {
          const r = await c.search(c.state.token, undefined, "hand-referral-service");
          c.state.studies = r.studies;
          const ok = Object.values<any>(r.studies).every(s => s.resource.modality.some((m: any) => c.state.modalities.includes(m.code)));
          c.check("Only pre-authorized modalities are returned", r.status === 200 && ok, `${Object.keys(r.studies).length} studies`);
        },
      },
      {
        id: "retrieve", title: "It retrieves a released study", actor: "hand-referral-service", doc: FAST_DOC,
        inputs: c => { const ids = Object.keys(c.state.studies ?? {}); return [{ id: "study", label: "Study", type: "select", options: studyOptions(c).filter((o: any) => ids.includes(o.value)), default: ids.includes(WRIST) ? WRIST : ids[0] }]; },
        run: async (c, i) => {
          if (!i.study) { c.check("Nothing released, so nothing to retrieve", true); return; }
          const s = c.state.studies[i.study];
          const r = await c.retrieve("hand-referral-service", "Retrieve", c.studyUrl(s.base, s.uid), c.state.token);
          c.check("Served instantly", r.status === 200 && r.authz === "instant" && r.complete, `authorization: ${r.authz}`);
        },
      },
      {
        id: "outside", title: "It tries something outside its access", actor: "hand-referral-service", doc: `${ASK_DOC}<p>A search for another patient gets <code>403</code>, as the guide specifies. A retrieval for an unreleased study gets <code>404</code>.</p>`,
        inputs: c => [{ id: "study", label: "Study to try", type: "select", options: studyOptions(c), default: MRI }],
        run: async (c, i) => {
          const s = c.study(i.study);
          const released = s.series.some((x: any) => c.state.modalities.includes(x.modality));
          const r = await c.retrieve("hand-referral-service", "Request by Study UID", c.studyUrl(c.plainBase(), s.uid), c.state.token);
          c.check(released ? "This study is pre-authorized, so it's released" : "Denied with 404", r.status === (released ? 200 : 404), `status ${r.status}, authorization: ${r.authz}`);
          const other = await c.search(c.state.token, "patient=robin-example", "hand-referral-service");
          c.check("Another patient: 403", other.status === 403);
        },
      },
    ],
  },
  {
    id: "hide-series", number: 4, group: "policy", title: "Hide specific series",
    summary: "An outside release service gets the CT, except for the series you choose to withhold.",
    shows: "A signed series list, a filtered study retrieval, and hidden series behaving as if they don't exist.",
    steps: [
      {
        id: "policy", title: "Choose series to withhold", actor: "Imaging Server", doc: `<p>The context lists released series only when disclosure is selective. A whole-study release has no <code>series</code> claim, which keeps URLs short.</p>`,
        inputs: c => { const s = c.study(CT).series; return [{ id: "withhold", label: "Series to withhold", type: "multi", options: s.map((x: any) => ({ value: x.uid, label: `${x.number}: ${x.description} (${x.instances.length})` })), default: s.filter((x: any) => /Clinical Documents|Dose Report/.test(x.description)).map((x: any) => x.uid) }]; },
        run: async (c, i) => {
          c.state.withhold = i.withhold;
          c.setRules([{ id: "outside-release", description: "Outside release excludes chosen series", when: { client: "outside-release-service", patient: "josh-example" }, allow: { studies: [CT] }, withholdSeries: i.withhold }]);
          c.state.token = (await c.backendToken("outside-release-service")).access_token;
          c.check("Policy recorded, and token issued", !!c.state.token);
        },
      },
      {
        id: "search", title: "Search reflects the subset", actor: "outside-release-service", doc: `<p><code>numberOfSeries</code>, <code>numberOfInstances</code> and the series list all reflect what's released, so the manifest and retrieval agree.</p>`,
        run: async c => {
          const r = await c.search(c.state.token, undefined, "outside-release-service");
          const s = r.studies[CT];
          c.state.s = s;
          const total = c.study(CT).series.length - c.state.withhold.length;
          if (!s) { c.check("Everything was withheld, so the study isn't returned", total === 0); return; }
          c.check("Series count reflects the subset", s.resource.numberOfSeries === total, `${s.resource.numberOfSeries} of ${c.study(CT).series.length}`);
          c.check("The signed context lists released series", c.state.withhold.length === 0 ? s.claims.series === undefined : s.claims.series?.length === total || s.claims.restricted === true);
        },
      },
      {
        id: "study", title: "Retrieve the whole study", actor: "outside-release-service", doc: `<p>The study-level request returns only released series. The proxy learned which ones from the URL.</p>`,
        run: async c => {
          if (!c.state.s) { c.check("No study to retrieve", true); return; }
          const r = await c.retrieve("outside-release-service", "Retrieve study", c.studyUrl(c.state.s.base, c.state.s.uid), c.state.token);
          c.check("Part count matches the search result", r.parts.length === c.state.s.resource.numberOfInstances, `${r.parts.length} parts, ${c.state.s.resource.numberOfInstances} in the manifest`);
          c.check("Instant, with a closing boundary", r.authz === "instant" && r.complete);
        },
      },
      {
        id: "direct", title: "Request a withheld series directly", actor: "outside-release-service", doc: `<p>The withheld series gets the same response as a series that doesn't exist, so a client can't infer that it does. PS3.18 §8.5 allows <code>404</code> for this.</p>`,
        run: async c => {
          if (!c.state.s || !c.state.withhold.length) { c.check("Nothing withheld to test", true); return; }
          const hidden = await c.retrieve("outside-release-service", "A withheld series", c.studyUrl(c.state.s.base, c.state.s.uid, `/series/${c.state.withhold[0]}`), c.state.token);
          const none = await c.retrieve("outside-release-service", "A series that doesn't exist", c.studyUrl(c.state.s.base, c.state.s.uid, "/series/1.2.3.4.5"), c.state.token);
          c.check("Withheld and nonexistent series look identical", hidden.status === 404 && none.status === 404, `${hidden.status} and ${none.status}`);
        },
      },
    ],
  },
  {
    id: "complex-policy", number: 5, group: "policy", title: "Too complex for the URL",
    summary: "When a release rule doesn't fit in a URL, the context only says restricted, and the proxy asks.",
    shows: "The other half of the design: an AuthZEN call, then a cached decision for the rest of the retrieval.",
    steps: [
      {
        id: "policy", title: "Set a long release rule", actor: "Imaging Server", doc: `<p>The Imaging Server decides per study whether to sign a series list or send <code>restricted: true</code>. Here, more released series than the limit below pushes it to <code>restricted</code>.</p>`,
        inputs: () => [{ id: "limit", label: "Most series allowed in a URL", type: "select", options: [{ value: "12", label: "12 (MRI goes through can_i)" }, { value: "40", label: "40 (MRI list fits in the URL)" }], default: "12" }],
        run: async (c, i) => {
          const s = c.study(MRI).series;
          c.state.hidden = s[0].uid;
          c.state.limit = Number(i.limit);
          c.stack.imaging.setPolicy({ maxSeriesInContext: c.state.limit });
          c.setRules([{ id: "long-rule", description: "One series withheld, leaving a long release list", when: { client: "outside-release-service", patient: "josh-example" }, allow: { studies: [MRI] }, withholdSeries: [c.state.hidden] }]);
          c.state.token = (await c.backendToken("outside-release-service")).access_token;
          c.check("Token issued", !!c.state.token);
        },
      },
      {
        id: "search", title: "Search returns the context", actor: "outside-release-service", doc: SEARCH_DOC,
        run: async c => {
          const r = await c.search(c.state.token, undefined, "outside-release-service");
          c.state.s = r.studies[MRI];
          c.state.released = c.state.s.resource.series.map((x: any) => x.uid);
          const restricted = c.state.released.length > c.state.limit;
          c.check(restricted ? "Context says restricted" : "Context lists the series", restricted ? c.state.s.claims.restricted === true : c.state.s.claims.series?.length === c.state.released.length, JSON.stringify({ ...c.state.s.claims, series: c.state.s.claims.series?.length, ath: "…" }));
        },
      },
      {
        id: "first", title: "First retrieval", actor: "outside-release-service", doc: ASK_DOC,
        run: async c => {
          const restricted = c.state.released.length > c.state.limit;
          const r = await c.retrieve("outside-release-service", "Retrieve a released series", c.studyUrl(c.state.s.base, c.state.s.uid, `/series/${c.state.released[0]}`), c.state.token);
          c.check(restricted ? "Asked the Imaging Server" : "Instant, since the list fit", r.status === 200 && r.authz === (restricted ? "asked" : "instant"), `authorization: ${r.authz}`);
        },
      },
      {
        id: "rest", title: "Rest of the retrieval", actor: "outside-release-service", doc: `<p>The answer covers the whole study, so instance and series requests can share it. Allow and deny have separate cache lifetimes, an idea borrowed from the Kubernetes webhook authorizer.</p>`,
        run: async c => {
          const restricted = c.state.released.length > c.state.limit;
          const r = await c.retrieve("outside-release-service", "Retrieve another series", c.studyUrl(c.state.s.base, c.state.s.uid, `/series/${c.state.released[1]}`), c.state.token);
          c.check(restricted ? "Served from the cached decision" : "Instant", r.status === 200 && r.authz === (restricted ? "cached" : "instant"), `authorization: ${r.authz}`);
          const hidden = await c.retrieve("outside-release-service", "The withheld series", c.studyUrl(c.state.s.base, c.state.s.uid, `/series/${c.state.hidden}`), c.state.token);
          c.check("The withheld series gets 404", hidden.status === 404);
          const whole = await c.retrieve("outside-release-service", "The whole study, filtered", c.studyUrl(c.state.s.base, c.state.s.uid), c.state.token);
          c.check("Study retrieval matches the released instances", whole.parts.length === c.state.s.resource.numberOfInstances && whole.complete, `${whole.parts.length} parts`);
        },
      },
    ],
  },
  {
    id: "consent-withdrawn", number: 6, group: "policy", title: "Consent withdrawn",
    summary: "A research donor withdraws mid-session. The fast path keeps working until the context expires.",
    shows: "The cost of instant responses: a bounded, documented revocation window.",
    steps: [
      {
        id: "enroll", title: "A research service is authorized", actor: "Imaging Server", doc: `<p>The context lifetime sets how long a signed decision can be reused. It's a tradeoff between callback load and revocation lag.</p>`,
        inputs: () => [{ id: "lifetime", label: "Context lifetime", type: "select", options: [{ value: "60", label: "1 minute" }, { value: "300", label: "5 minutes" }, { value: "1800", label: "30 minutes" }], default: "300" }],
        run: async (c, i) => {
          c.state.lifetime = Number(i.lifetime);
          c.stack.imaging.setPolicy({ contextLifetimeSeconds: c.state.lifetime });
          c.setRules([{ id: "research-consent", description: "Josh's research donation consent", when: { client: "research-donation", patient: "josh-example" }, allow: { all: true } }]);
          c.state.token = (await c.backendToken("research-donation")).access_token;
          const r = await c.search(c.state.token, undefined, "research-donation");
          c.state.s = r.studies[WRIST];
          c.check("Context expiry follows the chosen lifetime", c.state.s.claims.exp - Math.floor(Date.now() / 1000) <= c.state.lifetime + 60, `exp in about ${c.state.lifetime} seconds`);
          const g = await c.retrieve("research-donation", "Retrieve before withdrawal", c.studyUrl(c.state.s.base, c.state.s.uid), c.state.token);
          c.check("Served instantly", g.authz === "instant" && g.status === 200);
        },
      },
      {
        id: "withdraw", title: "Josh withdraws consent", actor: "Patient", doc: `<p>Policy changes immediately at the Imaging Server. New searches reflect it at once. The proxy hasn't heard, because it holds no policy and isn't told.</p>`,
        run: async c => {
          c.stack.imaging.updateRule("research-consent", { withdrawn: true });
          const r = await c.search(c.state.token, undefined, "research-donation");
          c.check("Search reflects it immediately", Object.keys(r.studies).length === 0);
          const g = await c.retrieve("research-donation", "Retrieve inside the window", c.studyUrl(c.state.s.base, c.state.s.uid), c.state.token);
          c.check("The existing URL still works until it expires", g.status === 200 && g.authz === "instant", "This is the revocation window");
        },
      },
      {
        id: "expire", title: "The context expires", actor: "Clock", doc: `<p>This moves the demo clock forward. Once <code>exp</code> passes, the fast path no longer applies, the proxy asks, and the answer reflects the withdrawal.</p>`,
        run: async c => {
          c.advanceClock(c.state.lifetime + 5);
          const g = await c.retrieve("research-donation", "Retrieve after expiry", c.studyUrl(c.state.s.base, c.state.s.uid), c.state.token);
          c.check("Access has ended", g.status === 404 && g.authz === "asked", `status ${g.status}, authorization: ${g.authz}`);
        },
      },
    ],
  },
];
export type { Ctx };
