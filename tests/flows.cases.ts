// Cases shared by the per-backend flow files. One all-backend file was a 35 s unit of work, so
// `--parallel` could never finish the suite faster than it; splitting keeps every test and lets
// the workers run the backends at once.
import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { startStack, type BackendName, type Stack } from "../src/stack";
import { defaultsFor, FLOWS, registerClients, runStep, startFlow } from "../src/flows";
import { Ctx } from "../src/flows/runtime";
import { CALLBACK, submitConsent, submitRevocation } from "../src/flows/oauth";
import type { BackendClient } from "../src/auth-server";

export interface FlowSuite { stack: Stack; clients: Record<string, BackendClient> }

/** The split files still respect BACKENDS: a backend it leaves out runs no cases at all. */
export function backendSelected(backend: BackendName): boolean {
  return (process.env.BACKENDS?.split(",") as BackendName[] | undefined ?? ["static-files", "s3", "orthanc"]).includes(backend);
}

export async function startFlowSuite(): Promise<FlowSuite> {
  const stack = await startStack(join(import.meta.dir, ".."));
  return { stack, clients: registerClients(stack) };
}

export function defineBackendFlows(ctx: Partial<FlowSuite>, backend: BackendName) {
  const stack = () => ctx.stack!;

  async function runAll(flowId: string, override: Record<string, Record<string, any>> = {}) {
    const flow = FLOWS.find(f => f.id === flowId)!;
    const c = await startFlow(stack(), ctx.clients!, flow);
    const failures: string[] = [];
    for (const step of flow.steps) {
      const inputs = { ...defaultsFor(c, flow, step.id), ...(override[step.id] ?? {}) };
      const r = await runStep(c, flow, step.id, inputs);
      expect(r.checks.length).toBeGreaterThan(0);
      for (const k of r.checks) if (!k.ok) failures.push(`${step.id}: ${k.label} (${k.detail ?? ""})`);
    }
    return failures;
  }

  describe(backend, () => {
    beforeAll(() => stack().setBackend(backend));
    test("backend self-test", async () => {
      stack().setBackend(backend);
      const r = await stack().selfTest(backend);
      expect(r.detail).toContain("series");
      expect(r.ok).toBe(true);
    });
    for (const flow of FLOWS) {
      test(`${flow.number}. ${flow.title}`, async () => {
        stack().setBackend(backend);
        expect(await runAll(flow.id)).toEqual([]);
      }, 240000);
    }
    test("variant: patient approves only Riverside", async () => {
      stack().setBackend(backend);
      expect(await runAll("patient-sites", { consent: { sites: ["Riverside Hospital"] }, unapproved: { study: "xr-hand-right-2012" } })).toEqual([]);
    }, 120000);
    test("variant: patient approves no sites", async () => {
      stack().setBackend(backend);
      expect(await runAll("patient-sites", { consent: { sites: [] } })).toEqual([]);
    }, 120000);
    test("variant: referral service also allowed MR", async () => {
      stack().setBackend(backend);
      expect(await runAll("backend-referral", { token: { modalities: ["CR", "MR"] }, outside: { study: "mri-brain-2020" } })).toEqual([]);
    }, 120000);
    test("variant: separate viewer not authorized", async () => {
      stack().setBackend(backend);
      expect(await runAll("viewer", { separate: { allowed: "no" } })).toEqual([]);
    }, 60000);
    test("variant: MRI series list fits in the URL", async () => {
      stack().setBackend(backend);
      expect(await runAll("complex-policy", { policy: { limit: "40" } })).toEqual([]);
    }, 120000);
    test("variant: truncation after 5 instances", async () => {
      stack().setBackend(backend);
      expect(await runAll("truncation", { fail: { after: "5" } })).toEqual([]);
    }, 120000);
  });
}

export function defineRedirectAndChoiceFlows(ctx: Partial<FlowSuite>) {
  const stack = () => ctx.stack!;
  const flowOf = (id: string) => FLOWS.find(f => f.id === id)!;
  /** Every Authorization header the stack sends while `fn` runs. */
  async function watchingBearers<T>(fn: (sent: string[]) => Promise<T>) {
    const real = globalThis.fetch, sent: string[] = [];
    globalThis.fetch = ((input: any, init: any = {}) => { const a = new Headers(init.headers ?? {}).get("authorization"); if (a) sent.push(a); return real(input, init); }) as typeof fetch;
    try { return { out: await fn(sent), sent }; } finally { globalThis.fetch = real; }
  }
  /** Runs a step that waits on a window, and does what a person would do there. */
  async function inWindow(c: Ctx, running: Promise<unknown>, act: (url: string) => Promise<URL | void>) {
    while (!c.pendingAuthUrl) await Bun.sleep(5);
    const back = await act(c.pendingAuthUrl);
    c.resolveCallback!(back ?? new URL(`${CALLBACK}?account=done`));
    return running;
  }
  const stopped = (p: Promise<unknown>) => p.then(() => "ran to the end", e => { expect(e.name).toBe("Error"); expect(e.message).not.toContain("undefined"); return String(e.message); });

  describe("a redirect back to the app", () => {
    test("a state that doesn't match stops the launch, and no token request goes out", async () => {
      stack().setBackend("static-files");
      const flow = flowOf("patient-sites");
      const c = await startFlow(stack(), ctx.clients!, flow);
      const launching = c.launch("josh", "portal-app", { window: true });
      while (!c.pendingAuthUrl) await Bun.sleep(5);
      c.resolveCallback!(new URL(`${CALLBACK}?state=attacker&code=attacker-code`));
      expect(await launching).toEqual({ error: "state_mismatch" });
      expect(c.checks.find(k => k.label === "Redirect's state matches the request")!.ok).toBe(false);
      expect(c.exchanges.map(x => x.title)).not.toContain("Exchange the code, with the PKCE verifier");
    });

    test("with nothing waiting, it's refused, and an account page's own redirect still ends its wait", async () => {
      const flow = flowOf("caregiver");
      const c = await startFlow(stack(), ctx.clients!, flow);
      expect(c.receiveCallback(new URL(`${c.urls.callback}?state=x&code=y`))).toBe(false);
      const running = runStep(c, flow, "delegate", { mode: "window" });
      while (!c.pendingAuthUrl) await Bun.sleep(5);
      expect(c.receiveCallback(new URL(`${c.urls.callback}?state=x&code=y`))).toBe(false);
      expect(c.pendingAuthUrl).toBeDefined();
      expect(c.receiveCallback(new URL(`${c.urls.callback}?account=done`))).toBe(false);
      expect(c.pendingAuthUrl).toBeDefined();
      // The account page's own link carries the wait's state, through its sign-in.
      const account = new URL(c.pendingAuthUrl!);
      const signedIn = await fetch(new URL(`${account.pathname}/signin${account.search}`, account), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "username=josh", redirect: "manual" });
      const page = await (await fetch(new URL(signedIn.headers.get("location")!, account), { headers: { cookie: signedIn.headers.get("set-cookie")!.split(";")[0]! } })).text();
      const link = page.match(/href="([^"]*account=done[^"]*)"/)![1]!.replaceAll("&amp;", "&");
      expect(c.receiveCallback(new URL(link))).toBe(true);
      expect((await running as any).checks.find((k: any) => k.label === "The Imaging Server holds the share").ok).toBe(false);
    });
  });

  describe("choices other than the defaults", () => {
    beforeAll(() => stack().setBackend("static-files"));
    test("Josh denying in the window ends the step with that explanation, and later steps send nothing", async () => {
      const flow = flowOf("patient-sites");
      const c = await startFlow(stack(), ctx.clients!, flow);
      const { out, sent } = await watchingBearers(async sent => {
        const running = runStep(c, flow, "consent", { mode: "window" });
        const consent = await stopped(inWindow(c, running, url => submitConsent(url, { user: "josh", approve: false })));
        const later: Record<string, string> = {};
        for (const step of ["search", "retrieve", "unapproved"]) { sent.length = 0; later[step] = await stopped(runStep(c, flow, step, {})); expect(sent).toEqual([]); }
        return { consent, later };
      });
      expect(out.consent).toBe("Josh chose not to approve the app, so it has no token");
      for (const why of Object.values(out.later)) expect(why).toBe("Josh chose not to approve the app, so it has no token");
      expect(sent.filter(a => a.includes("undefined"))).toEqual([]);
    });
    test("Alex signing in for Josh is explained in the same words as other wrong accounts", async () => {
      const flow = flowOf("patient-sites");
      const c = await startFlow(stack(), ctx.clients!, flow);
      const why = await stopped(inWindow(c, runStep(c, flow, "consent", { mode: "window" }), url => submitConsent(url, { user: "alex-neighbor" })));
      expect(why).toBe("No patient has shared records with Alex, so the app has no token. alex-neighbor signed in, and this step expected josh");
    });
    test("nothing shared with Sam stops at Sam's launch, and later steps explain the same way", async () => {
      const flow = flowOf("caregiver");
      const c = await startFlow(stack(), ctx.clients!, flow);
      const { out, sent } = await watchingBearers(async sent => {
        // Josh signs in on the account page, and comes back without sharing anything.
        await inWindow(c, runStep(c, flow, "delegate", { mode: "window" }), async url => { await submitRevocation(url, { user: "josh", delegate: "sam-caregiver" }); });
        const launch = await stopped(runStep(c, flow, "sam-launch", {}));
        const later: string[] = [];
        for (const step of ["searches", "revoke"]) { sent.length = 0; later.push(await stopped(runStep(c, flow, step, {}))); expect(sent).toEqual([]); }
        later.push(await stopped(runStep(c, flow, "shared-url", {})));
        return { launch, later };
      });
      expect(out.launch).toBe("Josh hasn't shared records with Sam, so the app has no token");
      expect(out.later).toEqual(["Josh hasn't shared records with Sam, so the app has no token", "Josh hasn't shared records with Sam, so the app has no token", "Josh's app and Sam's app have to search first"]);
      expect(sent.filter(a => a.includes("undefined"))).toEqual([]);
    });
    test("Alex signing in for Sam names who it was", async () => {
      const flow = flowOf("caregiver");
      const c = await startFlow(stack(), ctx.clients!, flow);
      await runStep(c, flow, "delegate", {});
      const why = await stopped(inWindow(c, runStep(c, flow, "sam-launch", { mode: "window" }), url => submitConsent(url, { user: "alex-neighbor" })));
      expect(why).toBe("No patient has shared records with Alex, so the app has no token. alex-neighbor signed in, and this step expected sam-caregiver");
    });
    test("Sam holding everything Josh does leaves no URL out of reach, and the flow says so", async () => {
      const flow = flowOf("caregiver");
      const all = stack().catalog.allStudies().map(s => s.site!).filter((s, i, a) => a.indexOf(s) === i);
      const c = await startFlow(stack(), ctx.clients!, flow);
      for (const step of flow.steps) {
        if (step.id === "searches" || step.id === "unrelated") { await runStep(c, flow, step.id, {}); continue; }
        const inputs = step.id === "delegate" || step.id === "sam-launch" ? { sites: all } : {};
        const r = await runStep(c, flow, step.id, inputs);
        if (step.id === "shared-url") expect(r.checks).toEqual([{ label: "Sam's app can see everything Josh's can, so no URL of Josh's is out of its reach", ok: true, detail: undefined }]);
      }
    });
    test("Sam giving the app only a site Sam doesn't hold leaves no URL to revoke, and the flow says so", async () => {
      const flow = flowOf("caregiver");
      const c = await startFlow(stack(), ctx.clients!, flow);
      await runStep(c, flow, "delegate", { sites: ["Lakeside Imaging"] });
      await runStep(c, flow, "sam-launch", { sites: ["Northside Pathology"] });
      const r = await runStep(c, flow, "revoke", {});
      expect(r.checks.map(k => k.label)).toEqual(["Search reflects it immediately", "Sam's app held no URL, so there's no revocation window to show"]);
      expect(r.checks.every(k => k.ok)).toBe(true);
    });
    test("a step sent with no choices uses its defaults", async () => {
      const flow = flowOf("backend-referral");
      const c = await startFlow(stack(), ctx.clients!, flow);
      await runStep(c, flow, "token", {});
      expect(c.state.modalities).toEqual(["CR"]);
      await runStep(c, flow, "search", {});
      expect((await runStep(c, flow, "outside", {})).checks.every(k => k.ok)).toBe(true);
    });
    // Each step alone stands in for every earlier step having been denied or failed: none left it anything.
    for (const flow of FLOWS) {
      test(`${flow.number}. ${flow.title}: each step, with nothing from the steps before it, explains itself and sends no blank credential`, async () => {
        for (const step of flow.steps) {
          const c = await startFlow(stack(), ctx.clients!, flow);
          const { sent, out } = await watchingBearers(() => stopped(runStep(c, flow, step.id, {})));
          expect([step.id, sent.filter(a => a.includes("undefined"))]).toEqual([step.id, []]);
          expect([step.id, /not an object|is not a function|Cannot read|undefined/.test(out)]).toEqual([step.id, false]);
        }
        stack().imaging.setOutage(false);
        stack().setTruncateAfter(undefined);
      }, 120000);
    }
  });
}
