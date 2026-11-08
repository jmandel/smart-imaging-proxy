// Tours and checks, through the demo server's own handler, and the reference model they're checked
// against: written apart from core's evaluation, it has to agree with it everywhere.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createModel, PolicyStore, ref, type AppApproval, type PolicyDocument, type Relationship, type Share } from "@smart-imaging-proxy/core";
import { startStack, type Stack } from "../src/stack";
import { registerClients } from "../src/flows";
import { createDemoServer } from "../src/demo-server";
import { CONFIG } from "../src/config";
import { USERS } from "../src/auth-server";
import { patientAttributes, ON_FILE } from "../src/stores";
import { nameOf } from "../src/world";
import { ageAt, cascade, referenceModel, type RefStudy } from "../src/reference-model";
import { RULE_SETS } from "../src/rule-presets";
import { Ctx } from "../src/flows/runtime";
import { refStudies, tourById } from "../src/tours";

const root = join(import.meta.dir, "..");
let stack: Stack; let demo: ReturnType<typeof createDemoServer>;
beforeAll(async () => { stack = await startStack(root); demo = createDemoServer(stack, registerClients(stack), root); });
afterAll(() => stack.stop());

const call = async (method: string, path: string, body?: unknown) => {
  const r = await demo.fetch(new Request(`${CONFIG.demoUrl}${path}`, { method, headers: { host: new URL(CONFIG.demoUrl).host, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  return { status: r.status, body: await r.json() as any };
};
const TOURS = ["own", "guardian", "caregiver", "revoke", "backend", "turns-18"];
async function start(tour: string) {
  const r = await call("POST", `/api/tours/${tour}/start`, {});
  expect(r.status).toBe(201);
  return r.body.scope.base as string;
}
async function runAll(tour: string) {
  const base = await start(tour);
  let state = (await call("GET", `${base}/api/tours/state?tour=${tour}`)).body;
  const expectedFirst = state.steps[0].expect;
  for (const s of state.steps) {
    const r = await call("POST", `${base}/api/tours/${tour}/steps/${s.id}`, { mode: "scripted" });
    expect([s.id, r.status]).toEqual([s.id, 200]);
    state = r.body;
  }
  return { base, state, expectedFirst };
}

describe("each tour", () => {
  for (const tour of TOURS) {
    test(`${tour}: every step's real answer matches the reference model, and each records what happened`, async () => {
      const { base, state, expectedFirst } = await runAll(tour);
      expect(expectedFirst).toBeTruthy();
      for (const s of state.steps) {
        expect([s.id, s.result.ok, s.result.actual]).toEqual([s.id, true, s.result.actual]);
        expect(s.result.expected).toBeTruthy();
        // Every step records events, but the clock's and a sign-in that ends with no token, which reach no service that records any.
        if (s.id !== "birthday" && !s.result.actual.includes("can't sign in")) expect([s.id, s.result.eventCount > 0]).toEqual([s.id, true]);
        // A step with no events says what it did instead of linking to none.
        expect([s.id, !!s.result.quiet]).toEqual([s.id, s.result.eventCount === 0]);
        // A step's events are in the log, filtered to the tour's session and that step.
        expect(s.result.activityUrl).toBe(`${base}/activity?session=${encodeURIComponent(state.session)}&trace=${s.result.trace}`);
        const logged = await call("GET", s.result.activityUrl.replace("/activity?", "/api/activity?"));
        expect([s.id, logged.body.events.length]).toEqual([s.id, s.result.eventCount]);
        expect(logged.body.events.every((e: any) => e.trace === s.result.trace)).toBe(true);
      }
      expect(state.scope.base).toBe(base);
      // A tour's scope is its own: saved policy has none of what it did.
      expect(stack.store.shares()).toEqual([]);
      expect(stack.store.policiesOf("service-access")).toEqual([]);
    }, 120000);
  }
  test("the shown expectation comes from the scope's policy at that moment", async () => {
    const base = await start("caregiver");
    const before = (await call("GET", `${base}/api/tours/state?tour=caregiver`)).body;
    expect(before.steps[0].expect).toBe("Sam can see Josh's studies at Lakeside and Northside");
    await call("POST", `${base}/api/tours/caregiver/steps/share`, {});
    await call("POST", `${base}/api/tours/caregiver/steps/launch`, {});
    const now = (await call("GET", `${base}/api/tours/state`)).body;
    expect(now.steps.find((s: any) => s.id === "search").expect).toBe("1 study: MRI brain without contrast");
    // Change the scope's policy behind the tour's back, and the model's expectation follows it.
    const world = (stack.scopes.resolve(base.slice(3)) as any).world;
    await world.policy.approveApp({ by: "user:sam-caregiver", app: "app:portal-app", patient: "patient:josh-example", sites: ["Lakeside Imaging", "Northside Pathology"] });
    expect((await call("GET", `${base}/api/tours/state`)).body.steps.find((s: any) => s.id === "search").expect).toBe("2 studies: MRI brain without contrast and Lung, digital slide, H&E");
  }, 60000);
  test("a step whose real answer isn't the model's says so", async () => {
    const base = await start("revoke");
    for (const s of ["share", "launch", "search", "revoke", "search-again"]) expect((await call("POST", `${base}/api/tours/revoke/steps/${s}`, {})).status).toBe(200);
    // Rotating the key ends the signed URL early, which the model, reading only policy and the clock, doesn't know.
    const world = (stack.scopes.resolve(base.slice(3)) as any).world;
    await world.rotateSigningKey();
    const r = await call("POST", `${base}/api/tours/revoke/steps/signed`, {});
    const step = r.body.steps.find((s: any) => s.id === "signed");
    expect(step.result.ok).toBe(false);
    expect(step.result.expected).toStartWith("The app gets");
    expect(step.result.actual).toStartWith("Refused");
    expect(step.result.detail).toStartWith("HTTP 404");
  }, 60000);
  /** Runs a tour with one of Ctx's actions replaced, and gives each step's result. */
  async function runWith(tour: string, method: "revokeDelegation" | "delegate", replacement: (real: any) => any) {
    const proto = Ctx.prototype as any, real = proto[method];
    proto[method] = replacement(real);
    try { return (await runAll(tour)).state.steps as any[]; } finally { proto[method] = real; }
  }
  test("a revoke that writes nothing fails its step, which says what it intended", async () => {
    const steps = await runWith("revoke", "revokeDelegation", () => async () => {});
    const revoke = steps.find(s => s.id === "revoke");
    expect(revoke.result.ok).toBe(false);
    expect(revoke.result.expected).toBe("Sam can see none of Josh's studies");
    expect(revoke.result.write).toContain("shares: it intended none, and the store holds");
  }, 120000);
  test("a share that writes nothing, or writes more than it should, fails its step", async () => {
    const none = await runWith("caregiver", "delegate", () => async () => 303);
    expect(none.find(s => s.id === "share").result).toMatchObject({ ok: false, write: expect.stringContaining("shares: it intended") });
    const more = await runWith("caregiver", "delegate", real => async function (this: any, ...args: any[]) {
      const status = await real.apply(this, args);
      await this.world.policy.share({ from: "user:josh", with: "user:alex-neighbor", patient: "patient:josh-example", sites: ["Lakeside Imaging"], label: "neighbor" });
      return status;
    });
    const share = more.find(s => s.id === "share").result;
    // Sam's records are what the model said, and the write still differs.
    expect(share.actual).toBe(share.expected);
    expect(share.ok).toBe(false);
    expect(share.write).toContain("user:alex-neighbor");
  }, 120000);
  test("reading a tour's state starts nothing", async () => {
    const base = await start("caregiver");
    for (let i = 0; i < 2; i++) {
      const state = (await call("GET", `${base}/api/tours/state?tour=caregiver`)).body;
      expect(state).toMatchObject({ session: null, activityUrl: null, tour: { id: "caregiver" } });
      expect(state.steps[0].expect).toBeTruthy();
    }
    expect((await call("GET", `${base}/api/tours`)).body.current).toBeNull();
    // The scope is still free for whichever tour runs a step first.
    expect((await call("POST", `${base}/api/tours/revoke/steps/share`, {})).status).toBe(200);
    expect((await call("GET", `${base}/api/tours`)).body.current).toBe("revoke");
  }, 60000);
  test("steps run in order, once, only in the tour's own scope", async () => {
    expect((await call("POST", "/api/tours/caregiver/steps/share", {})).status).toBe(409);
    expect((await call("POST", "/api/tours/nope/start", {})).status).toBe(404);
    const base = await start("caregiver");
    expect((await call("POST", `${base}/api/tours/caregiver/steps/search`, {})).status).toBe(409);
    expect((await call("POST", `${base}/api/tours/caregiver/steps/share`, {})).status).toBe(200);
    expect((await call("POST", `${base}/api/tours/caregiver/steps/share`, {})).status).toBe(409);
    expect((await call("POST", `${base}/api/tours/revoke/steps/share`, {})).status).toBe(409);
    const list = (await call("GET", "/api/tours")).body;
    expect(list.tours.map((t: any) => t.id)).toEqual(TOURS);
  }, 60000);
});

describe("checks", () => {
  test("each protocol flow is one line, run in a scope of its own, that opens its activity", async () => {
    const list = (await call("GET", "/api/tours")).body.checks.map((c: any) => c.id);
    expect(list).toEqual(["token-refresh", "viewer", "decision-outage", "attacks", "transfer-syntax", "truncation", "metadata", "paged-search"]);
    const r = await call("POST", "/api/checks/token-refresh", {});
    expect(r.body).toMatchObject({ id: "token-refresh", ok: true, failures: [] });
    expect(r.body.passed).toBeGreaterThan(0);
    expect(r.body.activityUrl).toMatch(new RegExp(`^/s/${r.body.scope}/activity\\?session=`));
    expect((await call("POST", "/api/checks/patient-sites", {})).status).toBe(404);
  }, 60000);
});

describe("the layer chain", () => {
  test("each card's chain, drawn with core's model, matches the reference model, and every study the outcome holds is in every row that grants", async () => {
    const list = (await call("GET", "/api/tours")).body;
    expect(list.tours.map((t: any) => t.id)).toEqual(TOURS);
    const world = stack.root;
    for (const card of list.tours) {
      const tour = tourById(card.id)!, v: any = typeof tour.viewer === "function" ? tour.viewer(world) : tour.viewer;
      const scenes = tour.change ? [tour.change.before(world), tour.scene(world)] : [tour.scene(world)];
      expect([card.id, card.chains.length]).toEqual([card.id, scenes.length]);
      scenes.forEach((scene, i) => {
        const chain = card.chains[i].chain;
        expect(chain.viewer).toBe(false);
        const m = referenceModel({ doc: scene.doc, studies: refStudies(world), now: scene.now ?? world.clock.now(), birthDate: p => patientAttributes(p)?.birthDate, patientOf: u => USERS[u]?.patient });
        const ids = (xs: { id: string }[]) => xs.map(x => x.id).sort();
        const mine = refStudies(world).filter(s => s.patient === v.patient);
        const all = ids(mine);
        expect([card.id, chain.columns.map((c: any) => c.id).sort()]).toEqual([card.id, all]);
        const approval = v.user && scene.doc.approvals.find(a => a.by === `user:${v.user}` && a.app === `app:${v.app}` && a.patient === `patient:${v.patient}`);
        const outcome = chain.rows.at(-1);
        expect([card.id, outcome.kind]).toEqual([card.id, "outcome"]);
        for (const row of chain.rows) {
          const has = [...row.has].sort();
          const want = row.kind === "records" ? all
            : row.kind === "label" ? has.filter((x: string) => mine.find(s => s.id === x)!.labels?.length)
            : row.kind === "referral" ? [v.cited]
            : ["relationship", "age"].includes(row.kind) ? []
            : row.missing ? []
            : row.kind === "guardian" || row.kind === "share" ? (row.route ? ids(m.userReach(row.by, v.patient, [row.route])) : [])
            : row.kind === "sharing" ? ids(m.userReach(scene.doc.shares.find(s => s.with === `user:${v.user}`)?.from.replace("user:", "") ?? "josh", v.patient))
            : row.kind === "approval" ? ids(mine.filter(s => !approval?.sites || approval.sites.includes(s.site ?? "")))
            : row.kind === "service" ? ids(m.serviceReach(v.service, v.patient))
            : v.service ? ids(m.serviceReach(v.service, v.patient)).filter(x => !v.cited || x === v.cited)
            : ids(m.appReach(v.user, v.app, v.patient));
          expect([card.id, row.name, has]).toEqual([card.id, row.name, want]);
          // What the outcome holds survives every row that holds or grants studies.
          if (!["relationship", "age", "label", "outcome"].includes(row.kind)) expect([card.id, row.name, outcome.has.every((x: string) => has.includes(x))]).toEqual([card.id, row.name, true]);
        }
      });
    }
    // The guardian card, a narrator's, shows the labeled study, locked, with its own fact row.
    const guardian = list.tours.find((t: any) => t.id === "guardian").chains[0].chain;
    expect(guardian.columns.filter((c: any) => c.locked).map((c: any) => c.id)).toEqual(["syn-riley-skin-slide-2023"]);
    expect(guardian.rows.find((r: any) => r.kind === "label").has).toEqual(["syn-riley-skin-slide-2023"]);
    // The revoke card shows before and after the change.
    expect(list.tours.find((t: any) => t.id === "revoke").chains.map((c: any) => [c.label, c.chain.rows.at(-1).has.length])).toEqual([["Before", 6], ["After Josh stops sharing", 0]]);
    // The service's rule grants its X-rays, and the outcome is the one the referral cites.
    const service = list.tours.find((t: any) => t.id === "backend").chains[0].chain;
    expect(service.rows.map((r: any) => [r.kind, r.has.length])).toEqual([["records", 6], ["referral", 1], ["service", 3], ["outcome", 1]]);
  });
});

describe("the reference model", () => {
  const studies = (): RefStudy[] => stack.catalog.allStudies().map(st => ({ id: st.id, patient: st.patient, site: st.site, labels: st.labels, date: st.date, modalities: [...new Set(st.series.map(x => x.modality))], seriesUids: st.series.map(x => x.uid) }));
  // What's on file, with the ids a store gives its rows, and a second guardian of Riley's, Josh.
  const onFile = () => new PolicyStore({ mode: "memory", onFile: { ...ON_FILE, relationships: [...ON_FILE.relationships, { subject: "user:josh", relation: "guardian_of", object: "patient:riley-example", recordedBy: "registration" }] }, patientOf: u => USERS[u]?.patient }).snapshot();
  const relId = (rels: Relationship[], subject: string) => rels.find(r => r.subject === subject && r.object === "patient:riley-example")!.id!;
  const shares = (rels: Relationship[]): Share[] => [
    { id: "share-1", from: "user:josh", with: "user:sam-caregiver", patient: "patient:josh-example", sites: ["Lakeside Imaging", "Riverside Hospital"], label: "caregiver", basis: "self" },
    { id: "share-2", from: "user:sam-caregiver", with: "user:alex-neighbor", patient: "patient:riley-example", sites: ["Lakeside Imaging"], label: "neighbor", basis: relId(rels, "user:sam-caregiver") },
    { id: "share-3", from: "user:sam-caregiver", with: "user:josh", patient: "patient:josh-example", sites: ["Northside Pathology"], label: "spouse", basis: "self" },
    // Made after Alex approved the app: Alex's approval doesn't rest on it.
    { id: "share-4", from: "user:josh", with: "user:alex-neighbor", patient: "patient:riley-example", sites: ["Northside Pathology"], label: "neighbor", basis: relId(rels, "user:josh") },
    // A share recording a route its sharer doesn't hold reaches nothing.
    { id: "share-5", from: "user:sam-caregiver", with: "user:robin", patient: "patient:riley-example", sites: ["Lakeside Imaging"], label: "aunt", basis: "self" },
  ];
  const approvals = (rels: Relationship[]): AppApproval[] => [
    { id: "approval-1", by: "user:sam-caregiver", app: "app:portal-app", patient: "patient:josh-example", sites: ["Riverside Hospital"], basis: ["share-1"] },
    { id: "approval-2", by: "user:josh", app: "app:portal-app", patient: "patient:josh-example", basis: ["self"] },
    { id: "approval-3", by: "user:alex-neighbor", app: "app:separate-viewer", patient: "patient:riley-example", basis: ["share-2"] },
    { id: "approval-4", by: "user:sam-caregiver", app: "app:portal-app", patient: "patient:riley-example", sites: ["Northside Pathology"], basis: [relId(rels, "user:sam-caregiver")] },
    // Josh holds Riley's records two ways, and approved through both.
    { id: "approval-5", by: "user:josh", app: "app:portal-app", patient: "patient:riley-example", basis: [relId(rels, "user:josh"), "share-6"] },
    { id: "approval-6", by: "user:robin", app: "app:portal-app", patient: "patient:riley-example", basis: ["share-5"] },
  ];
  const services = () => [...RULE_SETS.find(s => s.id === "all-three-services")!.rules(stack.catalog)!, { id: "any-ct", type: "service-access" as const, service: "service:research-donation", patients: "any" as const, allow: { modalities: ["CT", "MR"], since: "2021-01-01" } }];
  const withChoices = (policies: (d: PolicyDocument) => PolicyDocument["policies"]) => () => {
    const d = onFile();
    const sixth: Share = { id: "share-6", from: "user:sam-caregiver", with: "user:josh", patient: "patient:riley-example", sites: ["Lakeside Imaging", "Northside Pathology"], label: "aunt", basis: relId(d.relationships, "user:sam-caregiver") };
    return { relationships: d.relationships, policies: policies(d), shares: [...shares(d.relationships), sixth], approvals: approvals(d.relationships) } as PolicyDocument;
  };
  const docs: [string, () => PolicyDocument][] = [
    ["on file", () => ({ relationships: onFile().relationships, policies: onFile().policies, shares: [], approvals: [] }) as PolicyDocument],
    ["with choices and service policies", withChoices(d => [...d.policies, ...services()])],
    ["with no sharing policy", withChoices(d => d.policies.filter(p => p.type !== "sharing"))],
    // Josh's guardian relationship with Riley removed: what rested only on it goes, and his approval keeps the share it also rests on.
    ["with one of two routes removed", () => { const d = withChoices(x => x.policies)(); return cascade({ ...d, relationships: d.relationships.filter(r => r.id !== relId(d.relationships, "user:josh")) }); }],
  ];
  // Riley at 10, 15 and 19.
  const times = [Date.UTC(2021, 5, 1), Date.UTC(2026, 5, 1), Date.UTC(2030, 5, 1)].map(t => t / 1000);
  for (const [name, docOf] of docs) for (const now of times) {
    test(`agrees with core's evaluation ${name}, with Riley aged ${ageAt("2011-01-01", now)}`, () => {
      const doc = docOf();
      const m = referenceModel({ doc, studies: studies(), now, birthDate: p => patientAttributes(p)?.birthDate, patientOf: u => USERS[u]?.patient });
      const core = createModel({ patientOf: u => USERS[u]?.patient, attributesOf: patientAttributes, now: () => now, name: nameOf });
      const catalog = stack.catalog.allStudies();
      for (const patient of stack.catalog.linkedPatients()) {
        const snap = { ...doc, relationships: doc.relationships, policies: doc.policies, shares: doc.shares.filter(s => s.patient === ref("patient", patient)), approvals: doc.approvals.filter(a => a.patient === ref("patient", patient)) };
        const mine = catalog.filter(s => s.patient === patient);
        const ids = (xs: { id: string }[]) => xs.map(x => x.id).sort();
        for (const user of Object.keys(USERS)) {
          expect([user, patient, ids(m.userReach(user, patient))]).toEqual([user, patient, ids(core.visible(snap, ref("user", user), ref("patient", patient), mine))]);
          for (const app of ["portal-app", "separate-viewer"]) {
            const released = mine.filter(st => core.evaluate(snap, { client_id: app, sub: user, patient, fhirUser: USERS[user]!.fhirUser }, st).release !== "none");
            expect([user, app, patient, ids(m.appReach(user, app, patient))]).toEqual([user, app, patient, ids(released)]);
          }
        }
        for (const service of ["hand-referral-service", "outside-release-service", "research-donation"]) {
          const released = mine.filter(st => core.evaluate(snap, { client_id: service }, st).release !== "none");
          expect([service, patient, ids(m.serviceReach(service, patient))]).toEqual([service, patient, ids(released)]);
          expect(m.serviceMaySearch(service, patient)).toBe(core.preAuthorized(snap, service, patient).length > 0);
        }
      }
    });
  }
  test("the basis matters: a route gained after approving, and a route removed", () => {
    const now = Date.UTC(2021, 5, 1) / 1000;
    const doc = withChoices(d => d.policies)();
    const m = referenceModel({ doc, studies: studies(), now, birthDate: p => patientAttributes(p)?.birthDate, patientOf: u => USERS[u]?.patient });
    // Alex holds both of Riley's studies, through two shares, and approved the app through the first alone.
    expect(m.userReach("alex-neighbor", "riley-example").map(s => s.id).sort()).toEqual(["syn-riley-knee-mr-2022", "syn-riley-skin-slide-2023"]);
    expect(m.appReach("alex-neighbor", "separate-viewer", "riley-example").map(s => s.id)).toEqual(["syn-riley-knee-mr-2022"]);
    expect(m.userReach("robin", "riley-example")).toEqual([]);
    const removed = docs.find(([n]) => n === "with one of two routes removed")![1]();
    expect(removed.shares.map(s => s.id)).not.toContain("share-4");
    expect(removed.approvals.map(a => a.id)).toContain("approval-5");
  });
  test("deleting a row cascades as the store's deletion does, by ids alone", () => {
    const doc = withChoices(d => d.policies)();
    // Rows the store would refuse to write are left out: it records only bases their sharers hold.
    const valid = { ...doc, shares: doc.shares.filter(s => s.id !== "share-3" && s.id !== "share-5"), approvals: doc.approvals.filter(a => a.id !== "approval-6") };
    const ids = (d: Pick<PolicyDocument, "shares" | "approvals">) => ({ shares: d.shares.map(s => s.id).sort(), approvals: d.approvals.map(a => a.id).sort() });
    const removals: [string, (d: PolicyDocument) => PolicyDocument][] = [
      ...valid.relationships.map(r => [`relationship ${r.subject}`, (d: PolicyDocument) => ({ ...d, relationships: d.relationships.filter(x => x.id !== r.id) })] as [string, (d: PolicyDocument) => PolicyDocument]),
      ...valid.shares.map(s => [`share ${s.id}`, (d: PolicyDocument) => ({ ...d, shares: d.shares.filter(x => x.id !== s.id) })] as [string, (d: PolicyDocument) => PolicyDocument]),
    ];
    for (const [name, remove] of removals) {
      const store = new PolicyStore({ mode: "memory", onFile: { ...ON_FILE, relationships: [] }, patientOf: u => USERS[u]?.patient });
      store.setDocument(valid);
      const { revision: _, ...written } = store.snapshot();
      store.setDocument(remove(written as PolicyDocument));
      expect([name, ids(store.snapshot())]).toEqual([name, ids(cascade(remove(valid)))]);
    }
  });
  test("counts ages in whole years, and has none for a missing or future birth date", () => {
    const at = Date.UTC(2026, 0, 1) / 1000;
    expect(ageAt("2011-01-01", at)).toBe(15);
    expect(ageAt("2011-01-02", at)).toBe(14);
    expect(ageAt(undefined, at)).toBeUndefined();
    expect(ageAt("2030-01-01", at)).toBeUndefined();
  });
});
