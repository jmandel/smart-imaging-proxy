// Explore, as its page drives it: the sandbox explains a view from policy, and the page gets its own token,
// from the admin key for a person or a service's own key, then searches with it under the view's trace
// session. These tests do the same, through the demo server's handler and the real services, and check that
// what the sandbox says is what the search finds, and that a viewer is never told of what they may not know.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { boundaryOf, readMultipart } from "@smart-imaging-proxy/core";
import { startStack, type BackendName, type Stack } from "../src/stack";
import { registerClients } from "../src/flows";
import { createDemoServer } from "../src/demo-server";
import { resetClock } from "../src/clock";
import { CONFIG } from "../src/config";
import { traceSettled } from "../src/trace";
import { RULE_SETS } from "../src/rule-presets";
import { USERS } from "../src/auth-server";
import { adminToken, assertion, keysOf } from "./admin-token";

const root = join(import.meta.dir, "..");
const BACKENDS: BackendName[] = (process.env.BACKENDS?.split(",") as BackendName[]) ?? ["static-files", "s3", "orthanc"];
const ALL = ["ct-abdomen-pelvis-2012", "mri-brain-2020", "slide-lung-2023", "xr-hand-right-2012", "xr-hand-wrist-right-2012", "xr-wrist-left-2012"];
const LAKESIDE_RIVERSIDE = ALL.filter(s => s !== "slide-lung-2023");
const SMALL = "xr-wrist-left-2012";
const CONFIDENTIAL = "syn-riley-skin-slide-2023";
const SHARE = ["Lakeside Imaging", "Riverside Hospital"];
const STORED_ANY = "multipart/related; type=application/dicom; transfer-syntax=*";

let stack: Stack; let demo: ReturnType<typeof createDemoServer>;
beforeAll(async () => { stack = await startStack(root); demo = createDemoServer(stack, registerClients(stack), root); });
afterAll(() => stack.stop());
beforeEach(async () => { await stack.resetSaved(); resetClock(); stack.setBackend("static-files"); });

const hex = (n: number) => randomBytes(n).toString("hex");
const rule = (client: string, allow: any = { all: true }, extra: any = {}) => ({ id: `${client}-rule`, type: "service-access" as const, service: `service:${client}`, patients: "patient:josh-example", allow, ...extra });
const share = (sites: string[]) => ({ from: "user:josh", with: "user:sam-caregiver", patient: "patient:josh-example", sites, label: "caregiver" });
const setSaved = (x: { rules?: any[]; shares?: any[] }) => {
  if (x.rules) stack.store.replacePolicies("service-access", x.rules);
  if (x.shares) stack.store.setDocument({ shares: x.shares });
};

/** One browser on Explore's page, in a sandbox or at the root: what the page asks the sandbox, and does with its own token. */
function page(prefix = "") {
  const sandbox = prefix ? (stack.sandboxes.resolve(prefix.slice(3)) as any).sandbox : stack.root;
  let admin: string | undefined, session = "";
  const trace = () => session ? { traceparent: `00-${hex(16)}-${hex(8)}-01`, baggage: `demo.session=${encodeURIComponent(session)}` } : {};
  const call = async (method: string, path: string, body?: unknown) => {
    const auth = path.startsWith("/api/sandbox") ? { authorization: `Bearer ${admin ??= await adminToken(demo, prefix)}` } : {};
    const r = await demo.fetch(new Request(`${CONFIG.demoUrl}${prefix}${path}`, { method, headers: { host: new URL(CONFIG.demoUrl).host, "content-type": "application/json", ...auth, ...trace() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    const text = await r.text();
    return { status: r.status, text, json: () => JSON.parse(text) };
  };
  const ok = async (method: string, path: string, body?: unknown) => { const r = await call(method, path, body); expect([path, r.status]).toEqual([path, 200]); return r.json(); };
  /** A token as the page gets one: a person's from the admin key, a service's with its own key. */
  async function tokenFor(who: { user?: string; client?: string }, patient: string) {
    if (who.user) return adminToken(demo, prefix, { user: who.user, patient }, undefined, trace());
    const k = await keysOf(demo, prefix), svc = k.services.find(s => s.client_id === who.client)!;
    const r: any = await (await fetch(k.tokenEndpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...trace() }, body: new URLSearchParams({ grant_type: "client_credentials", scope: svc.scope, client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: assertion(svc.client_id, svc.jwk, k.tokenEndpoint, k.now) }) })).json();
    return r.access_token as string;
  }
  /** Every page of a search, with the token, under the view's session. */
  async function search(token: string, query: string) {
    let url: string | undefined = `${sandbox.urls.imaging}/fhir/ImagingStudy?${query}`, status = 200;
    const entries: any[] = [];
    while (url) {
      const r = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: "application/fhir+json", ...trace() } });
      status = r.status;
      if (!r.ok) break;
      const b: any = await r.json();
      entries.push(...(b.entry ?? []));
      url = b.link?.find((l: any) => l.relation === "next")?.url;
    }
    return { status, entries };
  }
  /** A view, as the page makes it: the sandbox's explanation, then the token and the search. */
  async function view(choice: { user?: string; patient?: string; client?: string; referral?: string }) {
    session = `explore-${choice.user ?? choice.client}-${hex(3)}${prefix ? `@${prefix.slice(3)}` : ""}`;
    const q = new URLSearchParams({ session, ...(choice.user ? { user: choice.user, ...(choice.patient ? { patient: choice.patient } : {}) } : { client: choice.client!, ...(choice.referral ? { referral: choice.referral } : {}) }) });
    const v = await ok("GET", `/api/sandbox/explore/view?${q}`);
    let found: any[] = [], token: string | undefined, searchStatus: number | undefined;
    if (v.patient) {
      token = await tokenFor(choice, v.patient);
      const r = choice.referral && referrals().find(x => x.id === choice.referral) || (choice.client ? referrals()[0] : undefined);
      const query = choice.client ? new URLSearchParams({ patient: r.patientRef, identifier: `${r.system}|${r.accession}`, _include: "ImagingStudy:endpoint" }) : new URLSearchParams({ patient: v.patient, _include: "ImagingStudy:endpoint", _count: "100" });
      const s = await search(token, query.toString());
      searchStatus = s.status;
      found = s.entries.filter(e => e.resource.resourceType === "ImagingStudy").map(e => ({ ...e.resource, address: s.entries.find(x => x.fullUrl === e.resource.endpoint?.[0]?.reference)?.resource.address }));
    }
    return { ...v, session, token, searchStatus, found };
  }
  let referralList: any[] = [];
  const referrals = () => referralList;
  return {
    call, ok, sandbox,
    get session() { return session; },
    async pick(user: string, extra: { patient?: string } = {}) { return view({ user, ...extra }); },
    async service(client: string, referral: string) { referralList = (await ok("GET", "/api/sandbox/explore/referrals")).referrals; return view({ client, referral }); },
    policy: (method: string, path: string, body?: unknown) => ok(method, `/api/sandbox/policy${path}`, body),
    released: (v: any) => v.found.map((x: any) => x.id).sort(),
    withheld: (v: any) => v.rows.filter((r: any) => !r.released).map((r: any) => r.id).sort(),
    /** The whole study, with the view's token: its status, parts and how the proxy decided, from the recorded events. */
    async retrieve(v: any, study: string) {
      const st = v.found.find((x: any) => x.id === study);
      const uid = st.identifier[0].value.replace("urn:oid:", "");
      const r = await fetch(`${st.address}/studies/${uid}`, { headers: { authorization: `Bearer ${v.token}`, accept: STORED_ANY, ...trace() } });
      let parts = 0, complete = false;
      const boundary = boundaryOf(r.headers.get("content-type"));
      if (r.ok && boundary && r.body) for await (const e of readMultipart(r.body as any, boundary)) { if (e.type === "start") parts++; if (e.type === "complete") complete = true; }
      else await r.body?.cancel();
      await traceSettled();
      const done = stack.collector.store.events({ session }).filter(e => e.kind === "stream.done" || e.kind === "retrieval.answered").at(-1);
      return { status: r.status, parts, complete, authz: (done?.data as any)?.authz };
    },
    /** The session's events as the activity log lists them. */
    async events() { await traceSettled(); return (await ok("GET", `/api/activity?${new URLSearchParams({ session, limit: "500" })}`)).events as any[]; },
    happened: (study: string) => ok("GET", `/api/sandbox/explore/happened?${new URLSearchParams({ session, study })}`),
  };
}

for (const backend of BACKENDS) {
  describe(`each person, on ${backend}`, () => {
    beforeEach(() => stack.setBackend(backend));
    test("Josh sees every study, through his app's token and a real search, with a reason at each level that applies", async () => {
      const b = page();
      const s = await b.pick("josh");
      expect(s.status).toBe("results");
      expect(b.released(s)).toEqual(ALL);
      expect(s.rows.filter((r: any) => r.released).map((r: any) => r.id).sort()).toEqual(ALL);
      expect([s.headline, s.detail]).toEqual(["Josh's own studies", "The Health Records App can see all 6."]);
      expect(s.chain.rows.map((r: any) => [r.level, r.name, r.has.length])).toEqual([["fact", "Josh is the patient", 0], ["policy", "Imaging network rule: anyone can share what they can see with an app that acts for them. What Josh can see:", 6], ["choice", "Josh lets the Health Records App act for him on his studies at every site", 6], ["outcome", "What the app can see", 6]]);
      expect(s.rows.find((x: any) => x.id === "mri-brain-2020")).toMatchObject({ site: "Lakeside Imaging", title: expect.any(String) });
      const kinds = (await b.events()).map(e => e.kind);
      for (const k of ["token.issued", "search.returned", "context.signed"]) expect(kinds).toContain(k);
    }, 60000);
    test("a study's retrieval is real, and Explore's line for it is built from the recorded events", async () => {
      const b = page();
      const s = await b.pick("josh");
      const count = s.found.find((x: any) => x.id === SMALL).numberOfInstances;
      expect(await b.retrieve(s, SMALL)).toMatchObject({ status: 200, complete: true, parts: count, authz: "instant" });
      const chain = await b.happened(SMALL);
      expect(chain.line).toMatch(new RegExp(`^Searched, signed link made, checked by the proxy with no policy call; ${count} parts, [0-9.]+ [KMG]?B\\.$`));
      expect(chain.activityUrl).toBe(`/activity?session=${encodeURIComponent(s.session)}&study=${SMALL}`);
    }, 120000);
    test("Sam sees nothing of Josh's until Josh shares, then what Josh shared, then what Sam gave the app", async () => {
      const b = page();
      const before = await b.pick("sam-caregiver", { patient: "josh-example" });
      expect(before.status).toBe("no-access");
      expect([before.rows, before.found]).toEqual([[], []]);
      expect(before.empty.actions).toEqual([{ kind: "share", label: "As Josh: share his studies with Sam", from: "josh", with: "sam-caregiver", patient: "josh-example", sites: expect.arrayContaining([...SHARE, "Northside Pathology"]) }]);
      await b.policy("POST", "/shares", share(SHARE));
      // Sam's approval on file covers Sam's own records; for Josh's, Sam approves the app as a sign-in would.
      await b.policy("POST", "/app-approvals", { by: "user:sam-caregiver", app: "app:portal-app", patient: "patient:josh-example" });
      const shared = await b.pick("sam-caregiver", { patient: "josh-example" });
      expect(shared.status).toBe("results");
      expect(b.released(shared)).toEqual(LAKESIDE_RIVERSIDE);
      expect(shared.chain.rows.map((r: any) => [r.level, r.name, r.has.length])).toEqual([
        ["policy", "Imaging network rule: patients and guardians can share the studies they can see with another person", 5],
        ["choice", "Josh shares his studies at Lakeside and Riverside with Sam", 5],
        ["policy", "Imaging network rule: anyone can share what they can see with an app that acts for them. What Sam can see:", 5],
        ["choice", "Sam lets the Health Records App act for Sam on what Josh shares at every site", 5],
        ["outcome", "What the app can see", 5],
      ]);
      // A study at a site Josh didn't share isn't Sam's to see, or to hear about.
      expect(b.withheld(shared)).toEqual([]);
      await b.policy("POST", "/app-approvals", { by: "user:sam-caregiver", app: "app:portal-app", patient: "patient:josh-example", sites: ["Lakeside Imaging"] });
      const narrowed = await b.pick("sam-caregiver", { patient: "josh-example" });
      expect(b.released(narrowed)).toEqual(["mri-brain-2020"]);
      expect([narrowed.headline, narrowed.detail]).toEqual(["Josh's studies Sam can see", "The Health Records App can see 1 of these 5."]);
      // Withheld from the app, at a site Sam holds: Sam may know of these, and why.
      expect(b.withheld(narrowed)).toEqual(LAKESIDE_RIVERSIDE.filter(x => x !== "mri-brain-2020"));
      expect(narrowed.rows.find((x: any) => x.id === SMALL).reason).toBe("Sam's approval of the Health Records App doesn't include Riverside Hospital");
      expect(narrowed.actions.find((a: any) => a.kind === "approve")).toMatchObject({ sites: expect.arrayContaining(SHARE), ticked: ["Lakeside Imaging"] });
    }, 120000);
  });
}

describe("people", () => {
  test("Robin's app finds no studies, and the one way on is someone else's records", async () => {
    const s = await page().pick("robin");
    expect(s.status).toBe("results");
    expect([s.rows, s.found]).toEqual([[], []]);
    expect(s.headline).toBe("Robin has no studies on file");
    expect(s.empty.text).toBe("The search finds nothing: Robin has no studies at any site.");
    expect(s.empty.actions).toEqual([{ kind: "person", label: "See Josh's studies", user: "josh" }]);
    expect(s.chain.columns).toEqual([]);
  }, 60000);
  test("with no one's records, Alex's view has no patient and no search, and offers the shares that could change that", async () => {
    const b = page();
    const s = await b.pick("alex-neighbor");
    expect([s.status, s.patient, s.token]).toEqual(["no-access", undefined, undefined]);
    expect(s.headline).toBe("No one shares any studies with Alex");
    expect(s.empty.actions.map((o: any) => o.label)).toEqual(["As Josh: share his studies with Alex", "As Sam: share Riley's studies with Alex", "As Sam: share Sam's studies with Alex"]);
  }, 60000);
  test("a guardian never sees, or hears the reason for, a study a label keeps from them", async () => {
    const b = page();
    for (const sites of [undefined, [], ["Lakeside Imaging"]]) {
      if (sites) await b.policy("POST", "/app-approvals", { by: "user:sam-caregiver", app: "app:portal-app", patient: "patient:riley-example", sites });
      const s = await b.pick("sam-caregiver", { patient: "riley-example" });
      expect(s.status).toBe("results");
      const text = JSON.stringify({ ...s, token: undefined }) + JSON.stringify(await b.events());
      for (const hidden of ["Labeled", "keeps it from guardians", CONFIDENTIAL, "SKIN BIOPSY", "Skin biopsy", "Northside Pathology"]) expect([hidden, text.includes(hidden)]).toEqual([hidden, false]);
      // The chain behind the view holds only the study Sam may know of, locks none, and counts none of Riley's.
      expect(s.chain.columns.map((c: any) => [c.id, c.locked])).toEqual([["syn-riley-knee-mr-2022", undefined]]);
      expect(s.chain.rows.map((r: any) => [r.kind, r.has.length])).toEqual([["relationship", 0], ["age", 0], ["guardian", 1], ["app-rule", 1], ["approval", sites?.length === 0 ? 0 : 1], ["outcome", sites?.length === 0 ? 0 : 1]]);
    }
  }, 60000);
  test("a guardian's share shows its recipient only what the share reaches", async () => {
    stack.store.putShare({ from: "user:sam-caregiver", with: "user:josh", patient: "patient:riley-example", sites: ["Lakeside Imaging"], label: "aunt" });
    const b = page();
    await b.policy("POST", "/app-approvals", { by: "user:josh", app: "app:portal-app", patient: "patient:riley-example" });
    const s = await b.pick("josh", { patient: "riley-example" });
    expect(b.released(s)).toEqual(["syn-riley-knee-mr-2022"]);
    for (const hidden of [CONFIDENTIAL, "Northside Pathology", "doesn't reach"]) expect(JSON.stringify({ ...s, token: undefined })).not.toContain(hidden);
  }, 60000);
  test("sharing and stopping are management writes, the view follows, and stopping takes the app's access with it", async () => {
    const b = page();
    await b.pick("josh");
    await b.policy("POST", "/shares", { from: "user:josh", with: "user:alex-neighbor", patient: "patient:josh-example", sites: ["Lakeside Imaging"], label: "neighbor" });
    expect(stack.store.shares()).toEqual([{ id: expect.any(String), from: "user:josh", with: "user:alex-neighbor", patient: "patient:josh-example", sites: ["Lakeside Imaging"], label: "neighbor", basis: "self" }]);
    expect((await b.pick("josh")).actions.map((a: any) => a.label)).toContain("Stop sharing with Alex");
    const alex = page();
    await alex.policy("POST", "/app-approvals", { by: "user:alex-neighbor", app: "app:portal-app", patient: "patient:josh-example" });
    expect(alex.released(await alex.pick("alex-neighbor", { patient: "josh-example" }))).toEqual(["mri-brain-2020"]);
    await b.policy("DELETE", `/shares?${new URLSearchParams({ from: "user:josh", with: "user:alex-neighbor", patient: "patient:josh-example" })}`);
    expect(stack.store.shares()).toEqual([]);
    expect(stack.store.approvals().filter(a => a.by === "user:alex-neighbor")).toEqual([]);
    const writes = (await b.events()).filter(e => e.kind === "policy.written").map(e => e.data.operation);
    expect(writes).toEqual(expect.arrayContaining(["DELETE /shares"]));
  }, 60000);
  test("stopping the app takes Josh's studies from it, and approving brings them back", async () => {
    const b = page();
    await b.policy("DELETE", `/app-approvals?${new URLSearchParams({ by: "user:josh", app: "app:portal-app", patient: "patient:josh-example" })}`);
    const stopped = await b.pick("josh");
    expect([b.released(stopped), stopped.empty.text]).toEqual([[], "Josh hasn't let the Health Records App see any of these."]);
    await b.policy("POST", "/app-approvals", { by: "user:josh", app: "app:portal-app", patient: "patient:josh-example", sites: stopped.empty.actions[0].sites, fhirUser: USERS.josh!.fhirUser });
    expect(b.released(await b.pick("josh"))).toEqual(ALL);
  }, 60000);
  test("asking for a patient the account doesn't hold says so, and offers shares only from those who could", async () => {
    const s = await page().pick("josh", { patient: "robin-example" });
    expect(s.status).toBe("no-access");
    expect(s.headline).toBe("Josh can't see Robin's studies");
    expect(s.empty.actions.map((a: any) => a.label)).toEqual(["As Robin: share Robin's studies with Josh"]);
    expect(s.found).toEqual([]);
  }, 60000);
});

/** Everything a viewer could be shown of the skin biopsy a label keeps from guardians. */
const BIOPSY_TRACES = () => {
  const st = stack.catalog.allStudies().find(x => x.id === CONFIDENTIAL)!;
  return [CONFIDENTIAL, st.uid, st.title!, "skin biopsy", "Skin biopsy", "SKIN BIOPSY", "Northside", "confidential-adolescent", "confidential adolescent", "keeps it from guardians", "doesn't reach"].filter(Boolean);
};
/** The text of everything a session's activity log gives: its events, its rollups, each exchange behind an event, and Explore's line for each study. */
async function activityText(b: ReturnType<typeof page>, v: any) {
  const session = v.session;
  const r = await b.call("GET", `/api/activity?session=${encodeURIComponent(session)}&limit=500`);
  expect(r.status).toBe(200);
  const body = r.json();
  expect(body.events.some((e: any) => e.kind === "search.returned")).toBe(true);
  // A viewer's view doesn't link into the live trace.
  expect(body.traceUrl).toBeUndefined();
  const texts = [r.text];
  for (const e of body.events.filter((x: any) => x.span)) {
    const span = await b.call("GET", `/api/activity/span?session=${encodeURIComponent(session)}&span=${encodeURIComponent(e.span)}`);
    expect([e.kind, span.status]).toEqual([e.kind, 200]);
    texts.push(span.text);
  }
  // The rollups, whole and for each type, and with a study filter for the hidden one: none may count it.
  const summary = await b.call("GET", `/api/activity/summary?session=${encodeURIComponent(session)}`);
  expect(summary.status).toBe(200);
  texts.push(summary.text);
  for (const type of summary.json().types) texts.push((await b.call("GET", `/api/activity?session=${encodeURIComponent(session)}&type=${type}`)).text, (await b.call("GET", `/api/activity/summary?session=${encodeURIComponent(session)}&type=${type}`)).text);
  const hidden = await b.call("GET", `/api/activity/summary?session=${encodeURIComponent(session)}&study=${CONFIDENTIAL}`);
  expect(hidden.json().tiles.searches.withheld).toBe(summary.json().tiles.searches.withheld);
  for (const row of v.rows) texts.push((await b.call("GET", `/api/sandbox/explore/happened?${new URLSearchParams({ session, study: row.id })}`)).text);
  return texts.join("\n");
}
const expectNoTrace = (who: string, text: string) => { for (const hidden of BIOPSY_TRACES()) expect([who, hidden, text.includes(hidden)]).toEqual([who, hidden, false]); };

describe("a viewer's own chain", () => {
  test("never names the confidential study, locks nothing, and counts none of a patient's studies", async () => {
    stack.store.putShare({ from: "user:sam-caregiver", with: "user:alex-neighbor", patient: "patient:riley-example", sites: ["Lakeside Imaging", "Northside Pathology"], label: "neighbor" });
    const views = [
      await page().pick("sam-caregiver", { patient: "riley-example" }),
      await page().pick("alex-neighbor", { patient: "riley-example" }),
      await page().pick("josh"),
      await page().pick("sam-caregiver", { patient: "josh-example" }),
      await page().service("hand-referral-service", "referral-xr-wrist-left-2012"),
    ];
    for (const v of views.filter(x => x.chain)) {
      expect(v.chain.viewer).toBe(true);
      expect(v.chain.rows.some((r: any) => r.kind === "records" || r.kind === "label")).toBe(false);
      expect(v.chain.columns.some((c: any) => c.locked)).toBe(false);
      expect(v.chain.rows.at(-1).kind).toBe("outcome");
    }
    for (const v of views.slice(0, 2)) expectNoTrace("a Riley view", JSON.stringify(v.chain ?? {}));
  }, 60000);
});

describe("the activity of a viewer's session", () => {
  test("as Sam, guardian of 15-year-old Riley, holds no trace of the study a label keeps from guardians", async () => {
    const b = page();
    const s = await b.pick("sam-caregiver", { patient: "riley-example" });
    expect(s.status).toBe("results");
    await traceSettled();
    expectNoTrace("Sam", await activityText(b, s));
    const sam = (await b.call("GET", `/api/activity/summary?session=${encodeURIComponent(s.session)}`)).json();
    expect(sam.tiles.searches).toMatchObject({ returned: s.found.length, withheld: 0 });
    expect(sam.studies).not.toContain(CONFIDENTIAL);
    // The operator's view of every session holds it, which is what the filter takes out.
    expect((await b.call("GET", `/api/activity?session=&limit=500`)).text).toContain(CONFIDENTIAL);
  }, 60000);
  test("as Alex, after Sam shares Lakeside, holds no trace of it either", async () => {
    stack.store.putShare({ from: "user:sam-caregiver", with: "user:alex-neighbor", patient: "patient:riley-example", sites: ["Lakeside Imaging"], label: "neighbor" });
    const b = page();
    await b.policy("POST", "/app-approvals", { by: "user:alex-neighbor", app: "app:portal-app", patient: "patient:riley-example" });
    const s = await b.pick("alex-neighbor", { patient: "riley-example" });
    expect(b.released(s)).toEqual(["syn-riley-knee-mr-2022"]);
    expect(s.chain.columns.map((c: any) => c.id)).toEqual(["syn-riley-knee-mr-2022"]);
    expect(s.chain.rows.map((r: any) => r.kind)).toEqual(["relationship", "age", "guardian", "sharing", "share", "app-rule", "approval", "outcome"]);
    expectNoTrace("Alex's view", JSON.stringify({ ...s, token: undefined }));
    await traceSettled();
    const text = await activityText(b, s);
    expectNoTrace("Alex", text);
    expect(text).toContain("syn-riley-knee-mr-2022");
    expect((await b.call("GET", `/api/activity/span?session=${encodeURIComponent(s.session)}&span=nope`)).status).toBe(404);
  }, 60000);
  test("the cast every viewer is sent names no study", async () => {
    const text = (await page().call("GET", "/api/sandbox/explore/cast")).text;
    for (const st of stack.catalog.allStudies()) for (const v of [st.id, st.title, st.description].filter(Boolean)) expect([v, text.includes(v!)]).toEqual([v, false]);
  });
});

describe("services", () => {
  test("every referral cites its report, with the order's accession number and system, and names the patient absolutely", async () => {
    const b = page();
    const o = await b.ok("GET", "/api/sandbox/explore/cast");
    expect(o.services.map((x: any) => [x.id, x.name])).toEqual([["hand-referral-service", "Hand referral service"], ["outside-release-service", "Outside release service"], ["research-donation", "Research donation"]]);
    const { referrals } = await b.ok("GET", "/api/sandbox/explore/referrals");
    expect(referrals.length).toBe(10);
    for (const r of referrals) {
      expect(r.patientRef).toMatch(new RegExp(`^${stack.root.urls.clinicalFhir}/Patient/[a-z-]+$`));
      expect(r.system).toBe(stack.catalog.accessionSystem);
      expect(r.accession).toBe(stack.catalog.allStudies().find(s => `referral-${s.id}` === r.id)!.accession);
    }
  });
  test("with no service-access policy, the real 403, and applying the rule set lets it see what the referral cites", async () => {
    const b = page();
    const s = await b.service("hand-referral-service", "referral-xr-wrist-left-2012");
    expect([s.status, s.searchStatus]).toEqual(["forbidden", 403]);
    expect(s.headline).toBe("Hand referral service can't search Josh's studies");
    expect(s.chain.rows.map((r: any) => [r.kind, r.has, r.missing ?? false])).toEqual([["referral", [SMALL], false], ["service", [], true], ["outcome", [], false]]);
    expect(s.rows).toEqual([]);
    expect(s.empty.actions).toEqual([{ kind: "apply-policy", label: "As the imaging network: let the hand referral service see Josh's X-rays", ruleSet: "hand-wrist-referral", text: expect.any(String) }]);
    const search = (await b.events()).find(e => e.kind === "search.returned");
    expect(search.data.query).toContain(`identifier=${encodeURIComponent(`${stack.catalog.accessionSystem}|EXCR2012A`)}`);
    // The organization adds the rule set's rules, as the page does, through the policy API.
    const { ruleSets } = await b.ok("GET", "/api/sandbox/explore/rule-sets?service=hand-referral-service");
    for (const r of ruleSets.find((x: any) => x.id === "hand-wrist-referral").rules) await b.policy("PUT", `/policies/${encodeURIComponent(r.id)}`, r);
    const after = await b.service("hand-referral-service", "referral-xr-wrist-left-2012");
    expect([after.status, after.searchStatus]).toEqual(["results", 200]);
    expect(after.headline).toBe("Hand referral service can see the study this referral cites");
    expect(b.released(after)).toEqual([SMALL]);
    expect(after.chain.rows.map((r: any) => [r.level, r.name, r.has])).toEqual([["fact", "The referral cites Josh's study “XR wrist left, 3 views”", [SMALL]], ["policy", "Imaging network rule: the hand referral service can see Josh's X-rays", [SMALL]], ["outcome", "What the service found when it searched for that study", [SMALL]]]);
    expect(stack.store.policiesOf("service-access").map(p => p.id)).toEqual(["hand-referral"]);
    expect((await b.retrieve(after, SMALL)).status).toBe(200);
  }, 120000);
  test("a study the policy doesn't cover shows as withheld, with its reason, from what the referral itself says", async () => {
    setSaved({ rules: RULE_SETS.find(s => s.id === "hand-wrist-referral")!.rules(stack.catalog)! });
    const s = await page().service("hand-referral-service", "referral-ct-abdomen-pelvis-2012");
    expect(s.headline).toBe("Hand referral service can't see the study this referral cites");
    expect(s.rows).toEqual([expect.objectContaining({ id: "ct-abdomen-pelvis-2012", released: false, title: "CT abdomen and pelvis with oral and IV contrast", reason: "hand-referral: study is outside what it allows" })]);
    expect(s.found).toEqual([]);
    expect(JSON.stringify({ ...s, token: undefined })).not.toContain("mri-brain-2020");
  }, 60000);
  test("with a rule withholding series, the row says so, and retrieval brings only the rest", async () => {
    const ct = stack.catalog.allStudies().find(x => x.id === "ct-abdomen-pelvis-2012")!;
    setSaved({ rules: [rule("outside-release-service", { studies: [ct.id] }, { withholdSeries: [ct.series[0]!.uid] })] });
    const b = page();
    const s = await b.service("outside-release-service", "referral-ct-abdomen-pelvis-2012");
    expect(s.rows[0]).toMatchObject({ id: ct.id, released: true, partial: "1 series withheld" });
    expect(s.found[0].numberOfSeries).toBe(ct.series.length - 1);
    expect((await b.retrieve(s, ct.id)).parts).toBe(ct.instanceCount - ct.series[0]!.instanceCount);
  }, 120000);
  test("a restricted rule makes the proxy ask, and then use its cache", async () => {
    setSaved({ rules: [rule("research-donation", { studies: [SMALL] }, { contextForm: "restricted" })] });
    const b = page();
    const s = await b.service("research-donation", "referral-xr-wrist-left-2012");
    expect((await b.retrieve(s, SMALL)).authz).toBe("asked");
    expect((await b.retrieve(s, SMALL)).authz).toBe("cached");
  }, 60000);
  test("a view names a known person, service and referral, and a person's patient must be one the catalog links", async () => {
    const b = page();
    for (const q of ["client=research-donation&referral=nobody", "client=mallory", "user=mallory", "user=josh&patient=nobody", "", "user=josh"]) expect([q, (await b.call("GET", `/api/sandbox/explore/view?${q}${q.endsWith("josh") ? "" : "&session=x"}`)).status]).toEqual([q, 400]);
    const o = await b.ok("GET", "/api/sandbox/explore/cast");
    expect(o.people.map((p: any) => p.id)).toEqual(["josh", "robin", "sam-caregiver", "alex-neighbor"]);
    expect(o.people.map((p: any) => p.name)).toEqual(["Josh", "Robin", "Sam", "Alex"]);
    expect(o.people.find((p: any) => p.id === "alex-neighbor").role).toStartWith("Josh's neighbor,");
    for (const x of [...o.people, ...o.services]) expect(x.role.length).toBeGreaterThan(20);
  });
});

describe("what the sandbox says and what search finds", () => {
  test("agree, for each person and service Explore shows", async () => {
    setSaved({ shares: [share(SHARE)], rules: [rule("hand-referral-service", { modalities: ["CR"] }), rule("outside-release-service", { studies: ["ct-abdomen-pelvis-2012"] }), rule("research-donation", { since: "2020-01-01" })] });
    stack.store.putShare({ from: "user:sam-caregiver", with: "user:alex-neighbor", patient: "patient:riley-example", sites: ["Lakeside Imaging"], label: "neighbor" });
    const b = page();
    await b.policy("POST", "/app-approvals", { by: "user:sam-caregiver", app: "app:portal-app", patient: "patient:josh-example" });
    await b.policy("POST", "/app-approvals", { by: "user:alex-neighbor", app: "app:portal-app", patient: "patient:riley-example" });
    const said = (v: any) => v.rows.filter((r: any) => r.released).map((r: any) => r.id).sort();
    for (const [user, patient] of [["josh", "josh-example"], ["sam-caregiver", "josh-example"], ["sam-caregiver", "sam-example"], ["sam-caregiver", "riley-example"], ["alex-neighbor", "riley-example"], ["robin", undefined]] as const) {
      const s = await b.pick(user, patient ? { patient } : {});
      expect([user, s.patient, b.released(s)]).toEqual([user, s.patient, said(s)]);
    }
    const { referrals } = await b.ok("GET", "/api/sandbox/explore/referrals");
    for (const client of ["hand-referral-service", "outside-release-service", "research-donation"]) for (const r of referrals.filter((x: any) => x.patient === "Josh")) {
      const s = await b.service(client, r.id);
      expect([client, r.id, b.released(s)]).toEqual([client, r.id, said(s)]);
    }
  }, 180000);
});

describe("sandboxes", () => {
  test("a view in a sandbox works on that sandbox's policy, and its activity is its own", async () => {
    const made: any = await (await demo.fetch(new Request(`${CONFIG.demoUrl}/api/sandboxes`, { method: "POST", headers: { host: new URL(CONFIG.demoUrl).host } }))).json();
    const b = page(made.base);
    await b.policy("DELETE", `/app-approvals?${new URLSearchParams({ by: "user:sam-caregiver", app: "app:portal-app", patient: "patient:sam-example" })}`);
    const s = await b.pick("sam-caregiver");
    expect([s.status, b.released(s)]).toEqual(["results", []]);
    expect(s.activityUrl).toBe(`${made.base}/activity?session=${encodeURIComponent(s.session)}`);
    // The root's approval is untouched.
    expect(stack.store.approvals().some(a => a.by === "user:sam-caregiver" && a.patient === "patient:sam-example")).toBe(true);
    await traceSettled();
    const activity = (await b.call("GET", "/api/activity")).json();
    expect(activity.events.length).toBeGreaterThan(0);
    expect(activity.events.every((e: any) => e.sandbox === made.sandbox)).toBe(true);
  }, 60000);
  test("a revoked token keeps its signed URLs until they expire, and then gets 401", async () => {
    const b = page();
    const s = await b.pick("josh");
    stack.store.revokeAllTokens();
    expect(await b.retrieve(s, SMALL)).toMatchObject({ status: 200, authz: "instant" });
    stack.root.clock.advance(stack.store.getSettings().contextLifetimeSeconds + 1);
    expect((await b.retrieve(s, SMALL)).status).toBe(401);
  }, 60000);
  test("Explore's reads need the admin token", async () => {
    for (const path of ["/api/sandbox/explore/cast", "/api/sandbox/explore/referrals", "/api/sandbox/explore/view?user=josh&session=x"]) expect((await demo.fetch(new Request(`${CONFIG.demoUrl}${path}`))).status).toBe(401);
    for (const path of ["/api/explore/options", "/api/explore/start", "/api/explore/thumbnail"]) expect((await demo.fetch(new Request(`${CONFIG.demoUrl}${path}`))).status).toBe(404);
  });
});
