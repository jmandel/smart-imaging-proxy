// Tours and checks, through the demo server's own handler, and the reference model they're checked
// against: written apart from core's evaluation, it has to agree with it everywhere.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createModel, ref, type PolicyDocument } from "@smart-imaging-proxy/core";
import { startStack, type Stack } from "../src/stack";
import { registerClients } from "../src/flows";
import { createDemoServer } from "../src/demo-server";
import { CONFIG } from "../src/config";
import { USERS } from "../src/auth-server";
import { patientAttributes, ON_FILE } from "../src/stores";
import { nameOf } from "../src/world";
import { ageAt, referenceModel, type RefStudy } from "../src/reference-model";
import { RULE_SETS } from "../src/rule-presets";

const root = join(import.meta.dir, "..");
let stack: Stack; let demo: ReturnType<typeof createDemoServer>;
beforeAll(async () => { stack = await startStack(root); demo = createDemoServer(stack, registerClients(stack), root); });
afterAll(() => stack.stop());

const call = async (method: string, path: string, body?: unknown) => {
  const r = await demo.fetch(new Request(`${CONFIG.demoUrl}${path}`, { method, headers: { host: new URL(CONFIG.demoUrl).host, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  return { status: r.status, body: await r.json() as any };
};
const TOURS = ["caregiver", "app-consent", "revoke", "backend"];
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
        expect(s.result.events.length).toBeGreaterThan(0);
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
    expect(before.steps[0].expect).toBe("Sam holds Josh Example's records at Lakeside Imaging and Northside Pathology");
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
    expect(step.result.expected).toStartWith("200");
    expect(step.result.actual).toStartWith("404");
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

describe("the reference model", () => {
  const studies = (): RefStudy[] => stack.catalog.allStudies().map(st => ({ id: st.id, patient: st.patient, site: st.site, labels: st.labels, date: st.date, modalities: [...new Set(st.series.map(x => x.modality))], seriesUids: st.series.map(x => x.uid) }));
  const shares = [
    { from: "user:josh", with: "user:sam-caregiver", patient: "patient:josh-example", sites: ["Lakeside Imaging", "Riverside Hospital"], label: "caregiver" },
    { from: "user:sam-caregiver", with: "user:alex-neighbor", patient: "patient:riley-example", sites: ["Lakeside Imaging", "Northside Pathology"], label: "neighbor" },
    { from: "user:sam-caregiver", with: "user:josh", patient: "patient:josh-example", sites: ["Northside Pathology"], label: "spouse" },
  ];
  const approvals = [
    { by: "user:sam-caregiver", app: "app:portal-app", patient: "patient:josh-example", sites: ["Riverside Hospital"] },
    { by: "user:josh", app: "app:portal-app", patient: "patient:josh-example" },
    { by: "user:alex-neighbor", app: "app:separate-viewer", patient: "patient:riley-example" },
    { by: "user:sam-caregiver", app: "app:portal-app", patient: "patient:riley-example", sites: ["Northside Pathology"] },
  ];
  const services = () => [...RULE_SETS.find(s => s.id === "all-three-services")!.rules(stack.catalog)!, { id: "any-ct", type: "service-access" as const, service: "service:research-donation", patients: "any" as const, allow: { modalities: ["CT", "MR"], since: "2021-01-01" } }];
  const docs: [string, () => PolicyDocument][] = [
    ["on file", () => ({ ...ON_FILE, shares: [], approvals: [] }) as PolicyDocument],
    ["with choices and service policies", () => ({ relationships: ON_FILE.relationships, policies: [...ON_FILE.policies, ...services()], shares, approvals }) as PolicyDocument],
    ["with no sharing policy", () => ({ relationships: ON_FILE.relationships, policies: ON_FILE.policies.filter(p => p.type !== "sharing"), shares, approvals }) as PolicyDocument],
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
  test("counts ages in whole years, and has none for a missing or future birth date", () => {
    const at = Date.UTC(2026, 0, 1) / 1000;
    expect(ageAt("2011-01-01", at)).toBe(15);
    expect(ageAt("2011-01-02", at)).toBe(14);
    expect(ageAt(undefined, at)).toBeUndefined();
    expect(ageAt("2030-01-01", at)).toBeUndefined();
  });
});
