// Explore's API, through the real services. Each test goes through the demo server's own handler, with
// a cookie as a browser would hold it.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { BackendError } from "@smart-imaging-proxy/core";
import { startStack, type BackendName, type Stack } from "../src/stack";
import { registerClients } from "../src/flows";
import { createDemoServer } from "../src/demo-server";
import { submitConsent } from "../src/flows/oauth";
import { resetClock } from "../src/clock";
import { CONFIG, ONE_ORIGIN, PORTS } from "../src/config";
import { traceSettled } from "../src/trace";
import { RULE_SETS } from "../src/rule-presets";

const root = join(import.meta.dir, "..");
const BACKENDS: BackendName[] = (process.env.BACKENDS?.split(",") as BackendName[]) ?? ["static-files", "s3", "orthanc"];
const ALL = ["ct-abdomen-pelvis-2012", "mri-brain-2020", "slide-lung-2023", "xr-hand-right-2012", "xr-hand-wrist-right-2012", "xr-wrist-left-2012"];
const LAKESIDE_RIVERSIDE = ALL.filter(s => s !== "slide-lung-2023");
const SMALL = "xr-wrist-left-2012";
const CONFIDENTIAL = "syn-riley-skin-slide-2023";

let stack: Stack; let demo: ReturnType<typeof createDemoServer>;
const realFetch = globalThis.fetch;
const issued = new Set<string>();
beforeAll(async () => {
  // Watches every token response, so a test can look for them in what the page received.
  globalThis.fetch = (async (input: any, init: any) => {
    const r = await realFetch(input, init);
    if (String(input).endsWith("/token") && r.ok) { const t: any = await r.clone().json(); if (t.access_token) issued.add(t.access_token); if (t.refresh_token) issued.add(t.refresh_token); }
    return r;
  }) as typeof fetch;
  stack = await startStack(root);
  demo = createDemoServer(stack, registerClients(stack), root);
});
afterAll(() => { stack.stop(); globalThis.fetch = realFetch; });
beforeEach(async () => { await stack.resetSaved(); resetClock(); stack.setBackend("static-files"); });

/** One browser: its cookie, and everything it has been sent. With `base`, it's on that scope's pages. */
function browser(base = "") {
  let cookie = "";
  const seen: string[] = [];
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await demo.fetch(new Request(`${CONFIG.demoUrl}${base}${path}`, { method, headers: { host: new URL(CONFIG.demoUrl).host, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    const set = r.headers.get("set-cookie");
    if (set) { cookie = set.split(";")[0]!; seen.push(set); }
    const bytes = new Uint8Array(await r.arrayBuffer());
    const text = r.headers.get("content-type")?.includes("json") || r.headers.get("content-type")?.includes("text") ? new TextDecoder().decode(bytes) : "";
    seen.push(text);
    return { status: r.status, text, bytes, json: () => JSON.parse(text), headers: r.headers, set };
  };
  const session = async () => (await call("GET", "/api/explore/session")).json().session;
  const settled = async (done = (s: any) => !s.running && !s.retrievals.some((r: any) => r.running)) => {
    for (let i = 0; i < 2400; i++) { const s = await session(); if (s && done(s)) return s; await Bun.sleep(25); }
    throw new Error("never settled");
  };
  const post = async (path: string, body: any) => { const r = await call("POST", `/api/explore${path}`, body); expect([path, r.status]).toEqual([path, 202]); return settled(); };
  const pick = (user: string, extra: any = {}) => post("/start", { user, mode: "scripted", ...extra });
  const service = (client: string, referral: string) => post("/start", { client, referral });
  const released = (s: any) => s.sheets.filter((x: any) => x.released).map((x: any) => x.id).sort();
  const withheld = (s: any) => s.sheets.filter((x: any) => !x.released).map((x: any) => x.id).sort();
  const retrieve = async (study: string) => {
    const r = await call("POST", "/api/explore/retrieve", { study });
    expect(r.status).toBe(202);
    return (await settled()).retrievals.find((x: any) => x.study === study);
  };
  const events = async (study?: string) => (await call("GET", `/api/explore/events${study ? `?study=${study}` : ""}`)).json().events as any[];
  return { call, session, settled, post, pick, service, released, withheld, retrieve, events, seen, get cookie() { return cookie; } };
}
const SHARE = ["Lakeside Imaging", "Riverside Hospital"];
const rule = (client: string, allow: any = { all: true }, extra: any = {}) => ({ id: `${client}-rule`, type: "service-access" as const, service: `service:${client}`, patients: "patient:josh-example", allow, ...extra });
const share = (sites: string[]) => ({ from: "user:josh", with: "user:sam-caregiver", patient: "patient:josh-example", sites, label: "caregiver" });
const setSaved = (x: { rules?: any[]; shares?: any[] }) => {
  if (x.rules) stack.store.replacePolicies("service-access", x.rules);
  if (x.shares) stack.store.setDocument({ shares: x.shares });
};

/** Every study a view shows as released is one explain releases, and every study it reaches and explain releases is shown. */
async function expectExplainMatches(s: any, explain: any) {
  const shown = new Map(s.sheets.map((x: any) => [x.id, x.released]));
  for (const row of explain.studies) if (shown.has(row.id)) expect([row.id, shown.get(row.id)]).toEqual([row.id, row.release !== "none"]);
  for (const row of explain.studies.filter((r: any) => r.release !== "none")) expect([row.id, shown.has(row.id)]).toEqual([row.id, true]);
}

for (const backend of BACKENDS) {
  describe(`each person, on ${backend}`, () => {
    beforeEach(() => stack.setBackend(backend));
    test("Josh sees every study, through a real launch and search, with a reason at each level that applies", async () => {
      const b = browser();
      const s = await b.pick("josh");
      expect(s.status).toBe("results");
      expect(b.released(s)).toEqual(ALL);
      expect(s.headline).toBe("Josh can see all 6 of their own studies");
      expect(s.why).toEqual([{ level: "fact", text: "Josh is the patient" }, { level: "choice", text: "Josh approved the Health Records App for all sites" }]);
      const mri = s.sheets.find((x: any) => x.id === "mri-brain-2020");
      expect(mri).toMatchObject({ site: "Lakeside Imaging", modalities: ["MR"], seriesCount: 18, instanceCount: 267, date: "2020-07-29", retrievable: true, thumb: true });
      const kinds = (await b.events()).map(e => e.kind);
      for (const k of ["policy.written", "token.issued", "search.returned", "context.signed"]) expect(kinds).toContain(k);
    }, 60000);
    test("a study's retrieval is real, and what happened is built from the recorded events", async () => {
      const b = browser();
      const s = await b.pick("josh");
      const sheet = s.sheets.find((x: any) => x.id === SMALL);
      const r = await b.retrieve(SMALL);
      expect(r).toMatchObject({ status: 200, complete: true, parts: sheet.instanceCount, authz: "instant", running: false });
      expect(r.dicomBytes).toBeGreaterThan(0);
      expect(r.encoding).toBe(backend === "orthanc" ? "identity" : "zstd");
      const happened = await b.events(SMALL);
      const kinds = happened.map(e => e.kind);
      for (const k of ["token.issued", "search.returned", "context.signed", "proxy.fast-path", "stream.done"]) expect(kinds).toContain(k);
      // What happened to this study, not the others.
      expect(happened.filter(e => e.kind === "context.signed").map(e => e.data.study)).toEqual([SMALL]);
      const done = happened.filter(e => e.kind === "stream.done").at(-1);
      expect(done.data).toMatchObject({ resource: "study", parts: sheet.instanceCount, complete: true });
      expect(done.links).toContain(`token:${s.tokenHash}`);
    }, 120000);
    test("Sam sees nothing of Josh's until Josh shares, then what Josh shared, then what Sam gave the app", async () => {
      const b = browser();
      const before = await b.pick("sam-caregiver", { patient: "josh-example" });
      expect(before.status).toBe("no-access");
      expect(before.sheets).toEqual([]);
      expect(before.empty.actions).toEqual([{ kind: "share", label: "Have Josh share with Sam", from: "josh", with: "sam-caregiver", patient: "josh-example", sites: expect.arrayContaining([...SHARE, "Northside Pathology"]) }]);
      const shared = await b.post("/share", { from: "josh", with: "sam-caregiver", patient: "josh-example", sites: SHARE, relationship: "caregiver" });
      expect(shared.status).toBe("results");
      expect(b.released(shared)).toEqual(LAKESIDE_RIVERSIDE);
      expect(shared.why).toEqual([
        { level: "fact", text: "Josh is the patient" },
        { level: "policy", text: "Patients and guardians may share what they can see" },
        { level: "choice", text: "Josh shared Lakeside Imaging and Riverside Hospital with Sam, as caregiver; Sam approved the Health Records App for all sites" },
      ]);
      // A study at a site Josh didn't share isn't Sam's to see, or to hear about.
      expect(b.withheld(shared)).toEqual([]);
      await expectExplainMatches(shared, await stack.explain({ client: "portal-app", user: "sam-caregiver", fhirUser: "Patient/sam-example", patient: "josh-example" }));

      const narrowed = await b.post("/approve", { sites: ["Lakeside Imaging"] });
      expect(b.released(narrowed)).toEqual(["mri-brain-2020"]);
      expect(narrowed.headline).toBe("Sam can see 1 of Josh's 5 studies");
      // Withheld from the app, at a site Sam holds: Sam may know of these, and why.
      expect(b.withheld(narrowed)).toEqual(LAKESIDE_RIVERSIDE.filter(x => x !== "mri-brain-2020"));
      expect(narrowed.sheets.find((x: any) => x.id === SMALL).reason).toBe("Sam's approval of the Health Records App doesn't include Riverside Hospital");
      expect(narrowed.actions.find((a: any) => a.kind === "approve")).toMatchObject({ sites: expect.arrayContaining(SHARE), ticked: ["Lakeside Imaging"] });
    }, 120000);
  });
}

describe("people", () => {
  test("Robin signs in and finds no studies, with nothing to do about it", async () => {
    const s = await browser().pick("robin");
    expect(s.status).toBe("results");
    expect(s.sheets).toEqual([]);
    expect(s.headline).toBe("Robin has no studies on file");
    expect(s.empty.text).toContain("no study in the catalog links to Robin Example");
  }, 60000);
  test("Alex's launch ends with no token and no search, and the page offers the shares that could change that", async () => {
    const b = browser();
    const s = await b.pick("alex-neighbor");
    expect(s.status).toBe("no-access");
    expect(s.headline).toBe("No one has shared records with Alex yet");
    expect(s.empty.actions.map((o: any) => o.label)).toEqual(["Have Josh share with Alex", "Have Sam share Riley's records with Alex", "Have Sam share with Alex"]);
    expect((await b.events()).map(e => e.kind)).not.toContain("search.returned");
  }, 60000);
  test("a guardian never sees, or hears the reason for, a study a label keeps from them", async () => {
    const b = browser();
    for (const sites of [undefined, [], ["Lakeside Imaging"]]) {
      const s = sites === undefined ? await b.pick("sam-caregiver", { patient: "riley-example" }) : await b.post("/approve", { sites });
      expect(s.status).toBe("results");
      const text = JSON.stringify(s) + JSON.stringify(await b.events());
      for (const hidden of ["Labeled", "keeps it from guardians", CONFIDENTIAL, "SKIN BIOPSY", "Skin biopsy", "Northside Pathology"]) expect([hidden, text.includes(hidden)]).toEqual([hidden, false]);
      expect(s.why[0].text).toBe("Sam is Riley's guardian");
    }
  }, 60000);
  test("a guardian's share shows its recipient only what the share reaches", async () => {
    stack.store.putShare({ from: "user:sam-caregiver", with: "user:josh", patient: "patient:riley-example", sites: ["Lakeside Imaging"], label: "aunt" });
    const s = await browser().pick("josh", { patient: "riley-example" });
    expect(s.sheets.map((x: any) => x.id)).toEqual(["syn-riley-knee-mr-2022"]);
    for (const hidden of [CONFIDENTIAL, "Northside Pathology", "doesn't reach"]) expect(JSON.stringify(s)).not.toContain(hidden);
  }, 60000);
  test("sharing and stopping are real account page writes, and stopping takes the app's access with it", async () => {
    const b = browser();
    await b.pick("josh");
    const shared = await b.post("/share", { from: "josh", with: "alex-neighbor", patient: "josh-example", sites: ["Lakeside Imaging"], relationship: "neighbor" });
    expect(stack.store.shares()).toEqual([{ id: expect.any(String), from: "user:josh", with: "user:alex-neighbor", patient: "patient:josh-example", sites: ["Lakeside Imaging"], label: "neighbor", basis: "self" }]);
    expect(shared.actions.map((a: any) => a.label)).toContain("Stop sharing with Alex");
    const alex = browser();
    expect(alex.released(await alex.pick("alex-neighbor"))).toEqual(["mri-brain-2020"]);
    await b.post("/unshare", { with: "alex-neighbor" });
    expect(stack.store.shares()).toEqual([]);
    expect(stack.store.approvals().filter(a => a.by === "user:alex-neighbor")).toEqual([]);
    const writes = (await b.events()).filter(e => e.kind === "policy.written").map(e => e.data.operation);
    expect(writes).toEqual(expect.arrayContaining(["POST /shares", "DELETE /shares"]));
  }, 60000);
  test("revoking the app is a real account page write, and the next sign-in approves it again", async () => {
    const b = browser();
    await b.pick("josh");
    await b.post("/revoke-app", {});
    expect((await b.events()).some(e => e.kind === "policy.written" && e.data.operation === "DELETE /app-approvals")).toBe(true);
  }, 60000);
  test("asking for a patient the account doesn't hold says so, and offers shares only from those who could", async () => {
    const s = await browser().pick("josh", { patient: "robin-example" });
    expect(s.status).toBe("no-access");
    expect(s.headline).toBe("Josh can't see Robin's studies");
    expect(s.empty.actions.map((a: any) => a.label)).toEqual(["Have Robin share with Josh"]);
  }, 60000);
});

describe("services", () => {
  test("every referral cites its report, with the order's accession number and system, and names the patient absolutely", async () => {
    const o = (await browser().call("GET", "/api/explore/options")).json();
    expect(o.referrals.length).toBe(10);
    expect(o.services.map((x: any) => [x.id, x.name])).toEqual([["hand-referral-service", "Hand referral service"], ["outside-release-service", "Outside release service"], ["research-donation", "Research donation"]]);
    const { referralsFrom, citedBy } = await import("../src/referrals");
    for (const r of referralsFrom(stack.catalog, stack.root.urls.clinicalFhir)) {
      const c = citedBy(r.bundle);
      expect(c.patientRef).toMatch(new RegExp(`^${stack.root.urls.clinicalFhir}/Patient/[a-z-]+$`));
      expect(c.system).toBe(stack.catalog.accessionSystem);
      expect(c.accession).toBe(stack.catalog.allStudies().find(s => s.id === r.study)!.accession);
    }
  });
  test("with no service-access policy, the real 403, and applying one from the page lets it see what the referral cites", async () => {
    const b = browser();
    const s = await b.service("hand-referral-service", "referral-xr-wrist-left-2012");
    expect(s.status).toBe("forbidden");
    expect(s.headline).toBe("Hand referral service can't search Josh's records");
    expect(s.sheets).toEqual([]);
    expect(s.empty.actions).toEqual([{ kind: "apply-policy", label: 'Apply the policy "Referral service: hand and wrist X-rays"', ruleSet: "hand-wrist-referral", text: expect.any(String) }]);
    const checked = (await b.events()).find(e => e.kind === "referral.checked");
    expect(checked.data).toMatchObject({ ok: true, referral: "referral-xr-wrist-left-2012", authorizedBase: stack.root.urls.clinicalFhir });
    const search = (await b.events()).find(e => e.kind === "search.returned");
    expect(search.data.query).toContain(`identifier=${encodeURIComponent(`${stack.catalog.accessionSystem}|EXCR2012A`)}`);
    expect(search.data.query).toContain(`patient=${encodeURIComponent(`${stack.root.urls.clinicalFhir}/Patient/josh-example`)}`);
    const after = await b.post("/apply-policy", { ruleSet: "hand-wrist-referral" });
    expect(after.status).toBe("results");
    expect(after.headline).toBe("Hand referral service can see the study this referral cites");
    expect(b.released(after)).toEqual([SMALL]);
    expect(after.why).toEqual([{ level: "policy", text: "The hand referral service may see Josh's CR studies" }]);
    expect(stack.store.policiesOf("service-access").map(p => p.id)).toEqual(["hand-referral"]);
    expect((await b.retrieve(SMALL)).status).toBe(200);
  }, 120000);
  test("a study the policy doesn't cover shows as withheld, with its reason, from what the referral itself says", async () => {
    setSaved({ rules: RULE_SETS.find(s => s.id === "hand-wrist-referral")!.rules(stack.catalog)! });
    const b = browser();
    const s = await b.service("hand-referral-service", "referral-ct-abdomen-pelvis-2012");
    expect(s.headline).toBe("Hand referral service can't see the study this referral cites");
    expect(s.sheets).toEqual([expect.objectContaining({ id: "ct-abdomen-pelvis-2012", released: false, title: "CT abdomen and pelvis with oral and IV contrast", reason: "hand-referral: study is outside what it allows", thumb: false })]);
    // Only the study the referral cites: never another of the patient's.
    expect(JSON.stringify(s)).not.toContain("mri-brain-2020");
  }, 60000);
  test("with a rule withholding series, the sheet says so, and retrieval brings only the rest", async () => {
    const ct = stack.catalog.allStudies().find(x => x.id === "ct-abdomen-pelvis-2012")!;
    setSaved({ rules: [rule("outside-release-service", { studies: [ct.id] }, { withholdSeries: [ct.series[0]!.uid] })] });
    const b = browser();
    const s = await b.service("outside-release-service", "referral-ct-abdomen-pelvis-2012");
    const sheet = s.sheets[0];
    expect(sheet).toMatchObject({ id: ct.id, released: true, seriesCount: ct.series.length - 1, partial: "1 series withheld" });
    expect((await b.retrieve(ct.id)).parts).toBe(ct.instanceCount - ct.series[0]!.instanceCount);
  }, 120000);
  test("a restricted rule makes the proxy ask, and then use its cache", async () => {
    setSaved({ rules: [rule("research-donation", { studies: [SMALL] }, { contextForm: "restricted" })] });
    const b = browser();
    await b.service("research-donation", "referral-xr-wrist-left-2012");
    expect((await b.retrieve(SMALL)).authz).toBe("asked");
    expect((await b.retrieve(SMALL)).authz).toBe("cached");
  }, 60000);
  test("a start names a known person, service and referral, and a person's patient must be one the catalog links", async () => {
    const b = browser();
    for (const body of [{ client: "research-donation", referral: "nobody" }, { client: "mallory" }, { user: "mallory" }, { user: "josh", patient: "nobody" }, {}]) expect((await b.call("POST", "/api/explore/start", body)).status).toBe(400);
    const o = (await b.call("GET", "/api/explore/options")).json();
    expect(o.people.map((p: any) => p.id)).toEqual(["josh", "robin", "sam-caregiver", "alex-neighbor"]);
    expect(o.people.find((p: any) => p.id === "sam-caregiver").role).toBe("Patient, and guardian for Riley Example");
    expect(o.people.find((p: any) => p.id === "alex-neighbor").role).toBe("Related person, nothing shared yet");
  });
});

describe("thumbnails", () => {
  test("each image study's thumbnail is one instance, retrieved through the proxy in its stored form", async () => {
    const b = browser();
    const s = await b.pick("josh");
    for (const id of ["xr-wrist-left-2012", "ct-abdomen-pelvis-2012", "mri-brain-2020"]) {
      const r = await b.call("GET", `/api/explore/thumbnail?study=${id}`);
      expect([id, r.status, r.headers.get("content-type")]).toEqual([id, 200, "application/dicom"]);
      expect(new TextDecoder().decode(r.bytes.slice(128, 132))).toBe("DICM");
      const instance = r.headers.get("x-instance");
      // The middle instance of the first image series, by numbers, from the search result alone.
      const study = stack.catalog.allStudies().find(x => x.id === id)!;
      const first = stack.catalog.hierarchies([study.pk]).get(study.pk)!.series.filter(x => !["SR", "PR", "KO", "DOC"].includes(x.modality)).sort((a, z) => a.number - z.number)[0]!;
      const ordered = [...first.instances].sort((a, z) => a.number - z.number);
      expect(instance).toBe(ordered[Math.floor((ordered.length - 1) / 2)]!.uid);
    }
    await traceSettled();
    const happened = await b.events("ct-abdomen-pelvis-2012");
    expect(happened.some(e => e.kind === "stream.done" && e.data.resource === "instance")).toBe(true);
    expect(happened.some(e => e.kind === "retrieval.answered" && e.data.resource === "metadata")).toBe(false);
    expect(s.sheets.every((x: any) => x.thumb)).toBe(true);
  }, 60000);
  test("a slide's is its THUMBNAIL image, found in the series metadata, which is read once", async () => {
    const b = browser();
    await b.pick("josh");
    const r = await b.call("GET", "/api/explore/thumbnail?study=slide-lung-2023");
    expect(r.status).toBe(200);
    expect(r.headers.get("x-modality")).toBe("SM");
    expect(r.bytes.length).toBeLessThan(4_000_000);
    await b.call("GET", "/api/explore/thumbnail?study=slide-lung-2023");
    await traceSettled();
    const happened = await b.events("slide-lung-2023");
    expect(happened.filter(e => e.kind === "retrieval.answered" && e.data.resource === "metadata").length).toBe(1);
    expect(happened.filter(e => e.kind === "stream.done" && e.data.resource === "instance").length).toBe(2);
  }, 60000);
  test("with no metadata from the server, a slide gets no thumbnail and no guess, and the others still do", async () => {
    const backend = stack.backends["static-files"];
    const real = backend.getMetadata.bind(backend);
    backend.getMetadata = async () => { throw new BackendError("NotFound"); };
    try {
      const b = browser();
      await b.pick("josh");
      const r = await b.call("GET", "/api/explore/thumbnail?study=slide-lung-2023");
      expect(r.status).toBe(404);
      expect((await b.call("GET", "/api/explore/thumbnail?study=xr-wrist-left-2012")).status).toBe(200);
      await traceSettled();
      expect((await b.events("slide-lung-2023")).some(e => e.kind === "stream.done")).toBe(false);
    } finally { backend.getMetadata = real; }
  }, 60000);
  test("a withheld study's sheet fetches nothing, and nor does a study the session didn't find", async () => {
    setSaved({ shares: [share(SHARE)] });
    const b = browser();
    await b.pick("sam-caregiver", { patient: "josh-example" });
    const s = await b.post("/approve", { sites: ["Lakeside Imaging"] });
    expect(s.sheets.find((x: any) => x.id === SMALL)).toMatchObject({ released: false, thumb: false });
    const before = stack.proxy.events.length;
    expect((await b.call("GET", `/api/explore/thumbnail?study=${SMALL}`)).status).toBe(404);
    expect((await b.call("GET", `/api/explore/thumbnail?study=${CONFIDENTIAL}`)).status).toBe(404);
    expect((await browser().call("GET", "/api/explore/thumbnail?study=mri-brain-2020")).status).toBe(404);
    expect(stack.proxy.events.length).toBe(before);
  }, 60000);
});

describe("a real window", () => {
  test("the page gets the sign-in URL, and the redirect back finishes the launch", async () => {
    const b = browser();
    await b.call("POST", "/api/explore/start", { user: "josh", mode: "window" });
    const waiting = await b.settled(s => !!s.authUrl);
    expect(waiting.running).toBe(true);
    expect(waiting.authUrl).toContain("/authorize?");
    const back = await submitConsent(waiting.authUrl, { user: "josh" });
    expect(await (await demo.fetch(new Request(back.toString()))).text()).toContain("Back in the app");
    const s = await b.settled();
    expect(s.status).toBe("results");
    expect(b.released(s)).toEqual(ALL);
  }, 60000);
  test("someone else signing in shows as that person", async () => {
    setSaved({ shares: [share(["Lakeside Imaging"])] });
    const b = browser();
    await b.call("POST", "/api/explore/start", { user: "josh", mode: "window" });
    const waiting = await b.settled(s => !!s.authUrl);
    await demo.fetch(new Request((await submitConsent(waiting.authUrl, { user: "sam-caregiver", patient: "josh-example" })).toString()));
    const s = await b.settled();
    expect(s.who).toMatchObject({ id: "sam-caregiver", asked: "josh" });
    expect(b.released(s)).toEqual(["mri-brain-2020"]);
  }, 60000);
  test("closing the window stops the wait", async () => {
    const b = browser();
    await b.call("POST", "/api/explore/start", { user: "josh", mode: "window" });
    await b.settled(s => !!s.authUrl);
    await b.call("POST", "/api/explore/cancel", {});
    const s = await b.settled();
    expect(s.status).toBe("failed");
    expect(s.detail).toContain("window closed");
  }, 60000);
  test("declining in a window offers to sign in again and approve", async () => {
    const b = browser();
    await b.call("POST", "/api/explore/start", { user: "josh", mode: "window" });
    const waiting = await b.settled(s => !!s.authUrl);
    expect((await demo.fetch(new Request(await submitConsent(waiting.authUrl, { user: "josh", approve: false })))).status).toBe(200);
    const s = await b.settled();
    expect(s.status).toBe("declined");
    expect(s.headline).toBe("Josh didn't approve the app");
    expect(s.empty.actions.map((a: any) => a.kind)).toEqual(["approve"]);
  }, 60000);
  test("a redirect with an unknown state goes nowhere", async () => {
    const b = browser();
    await b.call("POST", "/api/explore/start", { user: "josh", mode: "window" });
    await b.settled(s => !!s.authUrl);
    expect((await demo.fetch(new Request(`${CONFIG.demoUrl}/oauth/callback?code=x&state=wrong`))).status).toBe(400);
    expect((await b.session()).running).toBe(true);
    await b.call("POST", "/api/explore/cancel", {});
    await b.settled();
  }, 60000);
});

describe("saved policy and scopes", () => {
  const post = (path: string, body: unknown = {}) => demo.fetch(new Request(`${CONFIG.demoUrl}${path}`, { method: "POST", headers: { host: new URL(CONFIG.demoUrl).host, "content-type": "application/json" }, body: JSON.stringify(body) }));
  test("a session at the root works on saved policy, and one in a scope on that scope's", async () => {
    await browser().pick("josh");
    expect(stack.store.approvals().some(g => g.by === "user:josh")).toBe(true);
    const { base, scope } = await (await post("/api/scopes")).json() as any;
    const world = (stack.scopes.resolve(scope) as any).world;
    const b = browser(base);
    const s = await b.pick("sam-caregiver");
    expect(s.status).toBe("results");
    expect(s.activityUrl).toBe(`${base}/activity?session=${encodeURIComponent(s.session)}`);
    expect(world.store.approvals().some((g: any) => g.by === "user:sam-caregiver")).toBe(true);
    expect(stack.store.approvals().some(g => g.by === "user:sam-caregiver")).toBe(false);
    expect((await browser().call("GET", "/api/explore/session")).json().session).toBeNull();
    // A scope's activity lists only its own events.
    const activity = (await b.call("GET", "/api/activity")).json();
    expect(activity.events.length).toBeGreaterThan(0);
    expect(activity.events.every((e: any) => e.scope === scope)).toBe(true);
  }, 60000);
  test("starting a flow leaves an Explore session alone", async () => {
    const b = browser();
    await b.pick("josh");
    expect((await post("/api/flows/patient-sites/start")).status).toBe(200);
    expect((await b.retrieve(SMALL)).status).toBe(200);
  }, 60000);
  test("a revoked token keeps its signed URLs until they expire, and then gets 401", async () => {
    const b = browser();
    await b.pick("josh");
    stack.store.revokeAllTokens();
    expect(await b.retrieve(SMALL)).toMatchObject({ status: 200, authz: "instant" });
    stack.root.clock.advance(stack.store.getSettings().contextLifetimeSeconds + 1);
    expect((await b.retrieve(SMALL)).status).toBe(401);
  }, 60000);
  test("writes from another origin or host are refused", async () => {
    const send = (headers: Record<string, string>) => demo.fetch(new Request(`${CONFIG.demoUrl}/api/explore/start`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ user: "josh" }) }));
    expect((await send({ host: "evil.example" })).status).toBe(403);
    expect((await send({ host: new URL(CONFIG.demoUrl).host, origin: "http://evil.example" })).status).toBe(403);
  });
});

describe("explain", () => {
  test("is service-authenticated, and only on the Imaging Server's own port", async () => {
    const q = "/policy/v2/explain?client=portal-app&patient=josh-example";
    expect((await realFetch(`http://127.0.0.1:${PORTS.imaging}${q}`)).status).toBe(401);
    if (ONE_ORIGIN) expect((await realFetch(`${CONFIG.imagingUrl}${q}`)).status).toBe(404);
  });
});

describe("the token stays on the server", () => {
  test("no token in any response, in the page, or in the recorded events", async () => {
    issued.clear();
    const b = browser();
    const josh = await b.pick("josh");
    await b.retrieve(SMALL);
    await b.call("GET", `/api/explore/thumbnail?study=${SMALL}`);
    await b.call("GET", "/api/explore/options");
    await b.events(SMALL);
    await b.pick("alex-neighbor");
    setSaved({ rules: [rule("research-donation")] });
    await b.service("research-donation", "referral-xr-wrist-left-2012");
    for (const path of ["/", "/explore.js", "/styles.css", "/tours", `/api/activity?session=${encodeURIComponent(josh.session)}`]) await b.call("GET", path);
    expect(issued.size).toBeGreaterThanOrEqual(3);
    const sent = b.seen.join("\n");
    for (const token of issued) expect(sent.includes(token)).toBe(false);
    expect(sent).not.toContain("Bearer ");
  }, 120000);
  test("the cookie is HttpOnly, and holds the session's secret rather than its trace name", async () => {
    const b = browser();
    const r = await b.call("POST", "/api/explore/start", { user: "robin" });
    expect(r.set).toContain("HttpOnly");
    expect(r.set).toContain("SameSite=Strict");
    expect(r.set).toContain("Path=/api/explore");
    const s = await b.settled();
    expect(s.session).toMatch(/^explore-robin-[0-9a-f]{6}$/);
    expect(b.cookie).not.toContain(s.session);
    expect((await browser().call("GET", "/api/explore/session")).json().session).toBeNull();
  }, 60000);
  test("no one else's session can be read or acted on", async () => {
    for (const [method, path] of [["GET", "/api/explore/events"], ["GET", `/api/explore/thumbnail?study=${SMALL}`], ["POST", "/api/explore/retrieve"], ["POST", "/api/explore/revoke-app"]] as const) {
      expect((await browser().call(method, path, method === "POST" ? { study: SMALL } : undefined)).status).toBe(404);
    }
  });
});
