// The App Launch flow is real, so it has to reject what a real Authorization Server rejects.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { startStack, type Stack } from "../src/stack";
import { CONFIG, serveOn } from "../src/config";
import { APP_NAMES, clientAssertion, createAuthServer, PATIENT_NAMES, USERS, type BackendClient } from "../src/auth-server";
import { b64url, PolicyStore } from "@smart-imaging-proxy/core";
import { advance, now, resetClock } from "../src/clock";
import { Ctx } from "../src/flows/runtime";
import { FLOWS, registerClients, runStep, startFlow } from "../src/flows";
import { accountUrl, buildAuthorization, CALLBACK, CLINICAL_FHIR, scriptedLaunch, submitConsent, submitDelegation, submitRevocation, tokenRequestBody } from "../src/flows/oauth";

let stack: Stack; let conf: any;
beforeAll(async () => { stack = await startStack(join(import.meta.dir, "..")); await stack.resetAll(); conf = await (await fetch(`${CLINICAL_FHIR}/.well-known/smart-configuration`)).json(); });
afterAll(() => stack.stop());
const post = (body: string) => fetch(conf.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
const mutate = (url: string, change: (q: URLSearchParams) => void) => { const u = new URL(url); change(u.searchParams); return u.toString(); };
const auth = () => buildAuthorization(conf.authorization_endpoint, "portal-app");
const statusOf = (url: string) => fetch(url, { redirect: "manual" });

describe("SMART discovery", () => {
  test("advertises authorization code with PKCE S256", () => {
    expect(conf.grant_types_supported).toContain("authorization_code");
    expect(conf.code_challenge_methods_supported).toEqual(["S256"]);
    expect(conf.authorization_endpoint).toContain("/authorize");
  });
});

describe("Authorization request", () => {
  test("unknown client gets an error page, with no redirect", async () => {
    const r = await statusOf(mutate(auth().url, q => q.set("client_id", "nobody")));
    expect(r.status).toBe(400);
    expect(r.headers.get("location")).toBeNull();
  });
  for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
    test(`client_id ${name} gets the unknown client page`, async () => {
      const r = await statusOf(mutate(auth().url, q => q.set("client_id", name)));
      expect(r.status).toBe(400);
      expect(r.headers.get("location")).toBeNull();
      expect(await r.text()).toContain("Unknown client");
    });
  }
  test("the tables looked up by request input have no inherited keys", () => {
    for (const lookup of [USERS, PATIENT_NAMES, APP_NAMES]) for (const key of ["constructor", "__proto__", "toString", "hasOwnProperty"]) expect(lookup[key]).toBeUndefined();
    expect(Object.keys(USERS)).toContain("josh");
    expect(PATIENT_NAMES["josh-example"]).toBe("Josh Example");
  });
  test("unregistered redirect URI gets an error page, with no redirect", async () => {
    const r = await statusOf(mutate(auth().url, q => q.set("redirect_uri", "https://evil.example/cb")));
    expect(r.status).toBe(400);
    expect(r.headers.get("location")).toBeNull();
  });
  for (const [name, change] of [
    ["missing PKCE", (q: URLSearchParams) => q.delete("code_challenge")],
    ["plain PKCE", (q: URLSearchParams) => q.set("code_challenge_method", "plain")],
    ["wrong aud", (q: URLSearchParams) => q.set("aud", "https://other.example/fhir")],
    ["missing state", (q: URLSearchParams) => q.delete("state")],
  ] as const) {
    test(`${name} redirects back with an error`, async () => {
      const r = await statusOf(mutate(auth().url, change));
      expect(r.status).toBe(302);
      expect(new URL(r.headers.get("location")!).searchParams.get("error")).toBeTruthy();
    });
  }
  test("a public client can't request system-level access", async () => {
    const r = await statusOf(mutate(auth().url, q => q.set("scope", "launch/patient system/ImagingStudy.rs")));
    expect(r.status).toBe(302);
    expect(new URL(r.headers.get("location")!).searchParams.get("error")).toBe("invalid_scope");
  });
  test("a user's token with a system scope and no patient gets nothing, even where a rule names its client", async () => {
    const store = stack.store;
    stack.store.setPolicy({ rules: [{ id: "names-client", when: { client: "separate-viewer" }, allow: { all: true } }] });
    store.putToken("user-system-token", "access", { client_id: "separate-viewer", scope: "system/ImagingStudy.rs", sub: "robin", fhirUser: "RelatedPerson/robin" }, Math.floor(Date.now() / 1000) + 300);
    const r = await fetch(`${CONFIG.imagingUrl}/fhir/ImagingStudy?patient=josh-example`, { headers: { Authorization: "Bearer user-system-token" } });
    expect(r.status).toBe(403);
    await stack.resetAll();
  });
  test("a request for the Imaging FHIR Server as aud is accepted", async () => {
    const r = await statusOf(mutate(auth().url, q => q.set("aud", conf.associated_endpoints[0].url)));
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("<form");
  });
});

describe("Consent", () => {
  test("denial redirects with access_denied and state, and no code", async () => {
    const a = auth();
    const back = await submitConsent(a.url, { user: "josh", approve: false });
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("state")).toBe(a.state);
    expect(back.searchParams.get("code")).toBeNull();
  });
  test("approval redirects to the registered URI with a code and state", async () => {
    const a = auth();
    const back = await submitConsent(a.url, { user: "josh" });
    expect(back.origin + back.pathname).toBe(CALLBACK);
    expect(back.searchParams.get("code")).toBeTruthy();
    expect(back.searchParams.get("state")).toBe(a.state);
  });
  test("site choice becomes policy, and doesn't change the token's scope", async () => {
    await stack.resetAll();
    const t = await scriptedLaunch("josh", "portal-app", { sites: ["Lakeside Imaging"] });
    expect(t.scope).toBe("launch/patient patient/ImagingStudy.rs online_access");
    expect(stack.store.getPolicy().appGrants[0]!.sites).toEqual(["Lakeside Imaging"]);
    const b: any = await (await fetch(`${conf.associated_endpoints[0].url}/ImagingStudy?patient=josh-example`, { headers: { Authorization: `Bearer ${t.access_token}` } })).json();
    expect(b.total).toBe(1);
    await stack.resetAll();
  });
});

describe("Code exchange", () => {
  const start = async () => { const a = auth(); const back = await submitConsent(a.url, { user: "josh" }); return { a, code: back.searchParams.get("code")! }; };
  test("the right verifier gets a token with patient context and a refresh token", async () => {
    const { a, code } = await start();
    const r = await post(tokenRequestBody(a, code));
    expect(r.status).toBe(200);
    const t: any = await r.json();
    expect(t.token_type).toBe("Bearer");
    expect(t.patient).toBe("josh-example");
    expect(t.scope).toContain("patient/ImagingStudy.rs");
    expect(t.refresh_token).toBeTruthy();
  });
  test("a wrong verifier fails, and burns the code", async () => {
    const { a, code } = await start();
    const wrong = { ...a, verifier: "x".repeat(43) };
    expect((await post(tokenRequestBody(wrong, code))).status).toBe(400);
    expect((await post(tokenRequestBody(a, code))).status).toBe(400);
  });
  test("a code works only once", async () => {
    const { a, code } = await start();
    expect((await post(tokenRequestBody(a, code))).status).toBe(200);
    expect((await post(tokenRequestBody(a, code))).status).toBe(400);
  });
  test("a different client or redirect URI fails", async () => {
    const s1 = await start();
    expect((await post(tokenRequestBody({ ...s1.a, client: "separate-viewer" }, s1.code))).status).toBe(400);
    const s2 = await start();
    expect((await post(tokenRequestBody({ ...s2.a, redirectUri: "https://evil.example/cb" }, s2.code))).status).toBe(400);
  });
  test("the challenge is the S256 of the verifier", () => {
    const a = auth();
    expect(new URL(a.url).searchParams.get("code_challenge")).toBe(createHash("sha256").update(a.verifier).digest("base64url"));
  });
});

describe("Sign-in", () => {
  test("an unknown account stops the flow, with no code", async () => {
    await expect(submitConsent(auth().url, { user: "nobody" })).rejects.toThrow("sign-in failed (HTTP 401)");
  });
  for (const name of ["constructor", "__proto__", ""]) {
    test(`the username "${name}" gets a 401, with the picker shown again`, async () => {
      const page = await (await statusOf(auth().url)).text();
      const action = page.match(/action="([^"]+)"/)![1]!.replaceAll("&amp;", "&");
      const r = await fetch(new URL(action, conf.authorization_endpoint), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ username: name }).toString(), redirect: "manual" });
      expect(r.status).toBe(401);
      const html = await r.text();
      expect(html).toContain('role="alert"');
      expect(html).toContain('name="username"');
    });
  }
  test("the account sign-in rejects an unknown account too, with no session", async () => {
    const r = await fetch(`${CLINICAL_FHIR.replace("/fhir", "")}/account/signin`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "username=nobody", redirect: "manual" });
    expect(r.status).toBe(401);
    expect(r.headers.get("set-cookie")).toBeNull();
  });
  test("signing in is bound to its authorization request", async () => {
    const r = await fetch(`${conf.authorization_endpoint}/signin?txn=made-up`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "username=josh", redirect: "manual" });
    expect(r.status).toBe(400);
  });
  test("consent can't be reached or submitted without signing in", async () => {
    const page = await (await statusOf(auth().url)).text();
    const txn = page.match(/txn=([^&"]+)/)![1];
    expect((await fetch(`${conf.authorization_endpoint}/consent?txn=${txn}`)).status).toBe(401);
    expect((await fetch(`${conf.authorization_endpoint}/decision?txn=${txn}`, { method: "POST", body: "decision=approve", redirect: "manual" })).status).toBe(401);
  });
});

describe("Account picker", () => {
  const ACCOUNTS = { josh: "Josh Example", robin: "Robin Example", "sam-caregiver": "Sam Example", "alex-neighbor": "Alex Neighbor" };
  const signInPage = async (hint?: string) => (await statusOf(buildAuthorization(conf.authorization_endpoint, "portal-app", undefined, undefined, hint).url)).text();
  const checked = (html: string) => [...html.matchAll(/<input type="radio" name="username" value="([^"]+)" checked/g)].map(m => m[1]);

  test("lists every account as a radio, with no password field and no script", async () => {
    const html = await signInPage();
    for (const [id, name] of Object.entries(ACCOUNTS)) {
      expect(html).toContain(`name="username" value="${id}"`);
      expect(html).toContain(name);
    }
    expect(html).toContain("Patient/robin-example");
    expect(html).toContain("picking an account stands in for real authentication");
    expect(html).not.toMatch(/password/i);
    expect(html).not.toContain("<script");
    expect(html.match(/<button/g)!.length).toBe(1);
    expect(html).toContain(">Continue</button>");
  });
  const roleOn = (html: string, id: string) => html.split(`value="${id}"`)[1]!.match(/<span class="role">([^<]*)</)![1];
  test("role lines come from what's in place when the page renders", async () => {
    await stack.resetAll();
    let html = await signInPage();
    expect(roleOn(html, "josh")).toBe("Patient");
    expect(roleOn(html, "robin")).toBe("Patient");
    expect(roleOn(html, "sam-caregiver")).toBe("Patient, and guardian for Riley Example");
    expect(roleOn(html, "alex-neighbor")).toBe("Related person, nothing shared yet");
    expect(html).not.toContain("Caregiver");
    expect(html).not.toContain("Neighbor of");

    await submitDelegation(accountUrl("josh"), { user: "josh", delegate: "sam-caregiver", relationship: "caregiver", sites: ["Lakeside Imaging"] });
    html = await signInPage();
    expect(roleOn(html, "sam-caregiver")).toBe("Patient, and guardian for Riley Example, caregiver for Josh Example");
    expect(roleOn(html, "alex-neighbor")).toBe("Related person, nothing shared yet");

    await submitDelegation(accountUrl("josh"), { user: "josh", delegate: "robin", relationship: "spouse", sites: ["Lakeside Imaging"] });
    expect(roleOn(await signInPage(), "robin")).toBe("Patient, and spouse for Josh Example");

    await submitRevocation(accountUrl("josh"), { user: "josh", delegate: "sam-caregiver" });
    expect(roleOn(await signInPage(), "sam-caregiver")).toBe("Patient, and guardian for Riley Example");
    await stack.resetAll();
  });
  test("the account page's role line comes from the same state", async () => {
    await stack.resetAll();
    const accountRole = async (user: string) => {
      const res = await fetch(`${CLINICAL_FHIR.replace("/fhir", "")}/account/signin`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `username=${user}`, redirect: "manual" });
      const html = await (await fetch(`${CLINICAL_FHIR.replace("/fhir", "")}/account`, { headers: { cookie: res.headers.get("set-cookie")!.split(";")[0]! } })).text();
      return html.match(/<p class="who">([^.]*)\. Signed in as/)![1];
    };
    expect(await accountRole("josh")).toBe("Patient");
    expect(await accountRole("alex-neighbor")).toBe("Related person, nothing shared yet");
    expect(await accountRole("sam-caregiver")).toBe("Patient, and guardian for Riley Example");
    await submitDelegation(accountUrl("josh"), { user: "josh", delegate: "sam-caregiver", relationship: "adult child", sites: ["Lakeside Imaging"] });
    expect(await accountRole("sam-caregiver")).toBe("Patient, and guardian for Riley Example, adult child for Josh Example");
    await stack.resetAll();
  });
  test("login_hint preselects the account, and nothing is selected without one", async () => {
    expect(checked(await signInPage())).toEqual([]);
    expect(checked(await signInPage("nobody"))).toEqual([]);
    expect(checked(await signInPage("sam-caregiver"))).toEqual(["sam-caregiver"]);
  });
  test("the account page's picker honors login_hint too", async () => {
    const html = await (await fetch(accountUrl("robin"))).text();
    expect(checked(html)).toEqual(["robin"]);
    expect(html).toContain("/account/signin");
  });
  test("sign-in answers with a 303 to consent", async () => {
    const page = await signInPage("josh");
    const action = page.match(/action="([^"]+)"/)![1]!.replaceAll("&amp;", "&");
    const r = await fetch(new URL(action, conf.authorization_endpoint), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "username=josh", redirect: "manual" });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toContain("/authorize/consent?txn=");
  });
  test("Robin signs in as a patient, and their own record shows zero studies", async () => {
    await stack.resetAll();
    const t = await scriptedLaunch("robin");
    expect(t.patient).toBe("robin-example");
    const r = await fetch(`${conf.associated_endpoints[0].url}/ImagingStudy?patient=robin-example&_include=ImagingStudy:endpoint`, { headers: { Authorization: `Bearer ${t.access_token}` } });
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.total).toBe(0);
    expect(b.entry).toBeUndefined();
  });
  test("Robin can't reach Josh's studies, by search or by retrieval", async () => {
    await stack.resetAll();
    const t = await scriptedLaunch("robin");
    expect((await fetch(`${conf.associated_endpoints[0].url}/ImagingStudy?patient=josh-example`, { headers: { Authorization: `Bearer ${t.access_token}` } })).status).toBe(403);
    const uid = stack.catalog.allStudies()[0]!.uid;
    expect((await fetch(`${CONFIG.proxyUrl}/wado/-/studies/${uid}`, { headers: { Authorization: `Bearer ${t.access_token}`, Accept: "multipart/related; type=application/dicom; transfer-syntax=*" } })).status).toBe(404);
  });
  test("Robin's consent and account pages say there's no imaging, and offer no sites", async () => {
    await stack.resetAll();
    const a = buildAuthorization(conf.authorization_endpoint, "portal-app", undefined, undefined, "robin");
    const page = await (await statusOf(a.url)).text();
    const action = page.match(/action="([^"]+)"/)![1]!.replaceAll("&amp;", "&");
    const signedIn = await fetch(new URL(action, conf.authorization_endpoint), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "username=robin", redirect: "manual" });
    const consent = await (await fetch(new URL(signedIn.headers.get("location")!, conf.authorization_endpoint))).text();
    expect(consent).toContain('<b>Robin Example</b><span class="role">your own records</span>');
    expect(consent).toContain("No imaging studies are on file");
    expect(consent).not.toContain('name="sites"');
    const res = await fetch(`${CLINICAL_FHIR.replace("/fhir", "")}/account/signin`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "username=robin", redirect: "manual" });
    expect(res.status).toBe(303);
    const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
    const acct = await (await fetch(`${CLINICAL_FHIR.replace("/fhir", "")}/account`, { headers: { cookie } })).text();
    expect(acct).toContain("No imaging studies on file");
    expect(acct).not.toContain("Policy in use");
    expect(acct).not.toContain('name="delegate"');
  });
  test("a window launch reports who actually signed in, not who was hinted", async () => {
    await stack.resetAll();
    const c = new Ctx(stack.root, {});
    const launching = c.launch("josh", "portal-app", { window: true });
    while (!c.pendingAuthUrl) await Bun.sleep(5);
    expect(new URL(c.pendingAuthUrl).searchParams.get("login_hint")).toBe("josh");
    c.resolveCallback!(await submitConsent(c.pendingAuthUrl, { user: "robin" }));
    const t = await launching;
    expect(t.patient).toBe("robin-example");
    const summary = c.exchanges.find(x => x.actor === "User's browser")!.summary!;
    expect(summary).toContain("robin signed in and approved");
    expect(summary).not.toContain("josh");
  });
  const inWindow = async (c: Ctx, drive: (url: string) => Promise<URL | void>) => {
    while (!c.pendingAuthUrl) await Bun.sleep(5);
    const back = await drive(c.pendingAuthUrl);
    c.resolveCallback!(back ?? new URL(`${CALLBACK}?account=done`));
  };
  test("picking another account in a window: failing checks name who signed in and who was expected", async () => {
    const flow = FLOWS.find(f => f.id === "patient-sites")!;
    const c = await startFlow(stack, registerClients(stack), flow);
    const running = runStep(c, flow, "consent", { mode: "window", sites: [] });
    await inWindow(c, url => submitConsent(url, { user: "robin" }));
    const failed = (await running).checks.filter(k => !k.ok);
    expect(failed.map(k => k.label)).toEqual(["Signed in with the account this step expects", "Token has the patient context from the launch"]);
    for (const k of failed) {
      expect(k.detail).toContain("robin signed in");
      expect(k.detail).toContain("this step expected josh");
    }
    // The next step's failure is explained the same way.
    const search = await runStep(c, flow, "search", {});
    const bad = search.checks.filter(k => !k.ok);
    expect(bad.length).toBeGreaterThan(0);
    for (const k of bad) expect(k.detail).toContain("robin signed in, and this step expected josh");
  });
  test("picking the expected account in a window passes that check, and adds no note", async () => {
    const flow = FLOWS.find(f => f.id === "patient-sites")!;
    const c = await startFlow(stack, registerClients(stack), flow);
    const running = runStep(c, flow, "consent", { mode: "window", sites: [] });
    await inWindow(c, url => submitConsent(url, { user: "josh" }));
    const r = await running;
    expect(r.checks.every(k => k.ok)).toBe(true);
    expect(r.checks.find(k => k.label === "Signed in with the account this step expects")!.detail).toBe("josh");
    expect(c.accountNote).toBeUndefined();
  });
  test("declining as someone else still names who it was, and an error in the step does too", async () => {
    const flow = FLOWS.find(f => f.id === "patient-sites")!;
    const c = await startFlow(stack, registerClients(stack), flow);
    const running = runStep(c, flow, "consent", { mode: "window", sites: [] });
    await inWindow(c, url => submitConsent(url, { user: "alex-neighbor" }));
    await expect(running).rejects.toThrow("alex-neighbor signed in, and this step expected josh");
  });
  test("delegating as someone else in a window names who it was", async () => {
    const flow = FLOWS.find(f => f.id === "caregiver")!;
    const c = await startFlow(stack, registerClients(stack), flow);
    const running = runStep(c, flow, "delegate", { mode: "window", sites: [] });
    await inWindow(c, async url => { await submitDelegation(url, { user: "alex-neighbor", delegate: "sam-caregiver", relationship: "caregiver", sites: ["Lakeside Imaging"] }); });
    const failed = (await running).checks.filter(k => !k.ok);
    expect(failed.map(k => k.label)).toEqual(["Signed in with the account this step expects", "The Imaging Server holds the delegation"]);
    for (const k of failed) expect(k.detail).toContain("alex-neighbor signed in, and this step expected josh");
  });
});

describe("Delegation: patient to related person to app", () => {
  const search = async (token: string) => (await (await fetch(`${conf.associated_endpoints[0].url}/ImagingStudy?patient=josh-example`, { headers: { Authorization: `Bearer ${token}` } })).json() as any);
  const sitesOf = (b: any) => (b.entry ?? []).filter((e: any) => e.resource.resourceType === "ImagingStudy").length;
  const share = (sites: string[]) => submitDelegation(accountUrl("josh"), { user: "josh", delegate: "sam-caregiver", relationship: "caregiver", sites });

  test("signing in isn't enough: a user with no delegation gets no code", async () => {
    await stack.resetAll();
    const t = await scriptedLaunch("alex-neighbor");
    expect(t.error).toBe("access_denied");
    expect(t.access_token).toBeUndefined();
    const sam = await scriptedLaunch("sam-caregiver", "portal-app", { patient: "josh-example" });
    expect(sam.error).toBe("access_denied");
    expect(sam.access_token).toBeUndefined();
  });
  test("a related person signs in with their own login, and sees the subset", async () => {
    await stack.resetAll();
    expect((await share(["Lakeside Imaging"])).status).toBe(303);
    const t = await scriptedLaunch("sam-caregiver", "portal-app", { patient: "josh-example" });
    expect(t.patient).toBe("josh-example");
    expect(t.scope).toBe("launch/patient patient/ImagingStudy.rs online_access");
    expect(sitesOf(await search(t.access_token))).toBe(1);
  });
  test("a related person's app holds only what both links allow", async () => {
    await stack.resetAll();
    await share(["Lakeside Imaging", "Riverside Hospital"]);
    const t = await scriptedLaunch("sam-caregiver", "portal-app", { sites: ["Riverside Hospital"], patient: "josh-example" });
    expect(sitesOf(await search(t.access_token))).toBe(4);
  });
  test("a related person can't give an app more than they hold", async () => {
    await stack.resetAll();
    await share(["Lakeside Imaging"]);
    const t = await scriptedLaunch("sam-caregiver", "portal-app", { sites: ["Lakeside Imaging", "Northside Pathology"], patient: "josh-example" });
    expect(stack.store.getPolicy().appGrants[0]!.sites).toEqual(["Lakeside Imaging"]);
    expect(sitesOf(await search(t.access_token))).toBe(1);
  });
  test("only a patient or their guardian can delegate", async () => {
    await stack.resetAll();
    expect((await submitDelegation(accountUrl("alex-neighbor"), { user: "alex-neighbor", delegate: "sam-caregiver", relationship: "neighbor", sites: ["Lakeside Imaging"] })).status).toBe(403);
    await share(["Lakeside Imaging"]);
    const r = await submitDelegation(accountUrl("sam-caregiver"), { user: "sam-caregiver", delegate: "alex-neighbor", relationship: "neighbor", sites: ["Lakeside Imaging"], patient: "josh-example" });
    expect(r.status).toBe(403);
    expect(stack.store.getPolicy().delegations.map(d => d.delegate)).toEqual(["sam-caregiver"]);
  });
  test("revoking the delegation ends what the related person's app can find", async () => {
    await stack.resetAll();
    await share(["Lakeside Imaging"]);
    const t = await scriptedLaunch("sam-caregiver", "portal-app", { patient: "josh-example" });
    expect((await submitRevocation(accountUrl("josh"), { user: "josh", delegate: "sam-caregiver" })).status).toBe(303);
    expect(sitesOf(await search(t.access_token))).toBe(0);
  });
  test("the account page needs a session, and shows what the user holds", async () => {
    await stack.resetAll();
    expect(await (await fetch(`${CLINICAL_FHIR.replace("/fhir", "")}/account`)).text()).toContain("Sign in");
    const denied = await fetch(`${CLINICAL_FHIR.replace("/fhir", "")}/account/delegations`, { method: "POST", body: "delegate=sam-caregiver" });
    expect(denied.status).toBe(401);
  });
});

describe("Backend Services", () => {
  const JWT_BEARER = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
  const part = (o: unknown) => b64url(JSON.stringify(o));
  const assertionBody = (assertion: string, scope = "system/ImagingStudy.rs") => new URLSearchParams({ grant_type: "client_credentials", scope, client_assertion_type: JWT_BEARER, client_assertion: assertion }).toString();
  const signed = (c: BackendClient, claims: Record<string, unknown>) => {
    const head = part({ alg: "ES256", kid: c.kid, typ: "JWT" });
    const body = part({ iss: c.client_id, sub: c.client_id, aud: conf.token_endpoint, jti: randomBytes(8).toString("hex"), exp: now() + 60, ...claims });
    return `${head}.${body}.${b64url(sign("sha256", Buffer.from(`${head}.${body}`), { key: c.privateKey, dsaEncoding: "ieee-p1363" }))}`;
  };
  const client = () => stack.auth.registerBackendClient(`test-${randomBytes(4).toString("hex")}`, ["system/ImagingStudy.rs"]);
  const refused = async (assertion: string) => {
    const r = await post(assertionBody(assertion));
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: "invalid_client" });
  };

  test("a replayed assertion is rejected", async () => {
    const body = assertionBody(clientAssertion(client(), conf.token_endpoint));
    expect((await post(body)).status).toBe(200);
    expect((await post(body)).status).toBe(401);
  });
  test("a malformed assertion is invalid_client", async () => {
    const c = client();
    const good = signed(c, {}).split(".");
    for (const bad of ["", "a", "a.b", "a.b.c", "..", "{}.{}.{}", `${part(null)}.${part(null)}.c`, `${part(1)}.${part("x")}.c`, `${part([])}.${part([])}.c`, `${good[0]}.a.${good[2]}`, `a.${good[1]}.${good[2]}`, `${good[0]}.${good[1]}.c`, `${good[0]}.${good[1]}.${b64url(randomBytes(64))}`, `${good[0]}.${good[1]}.${b64url(randomBytes(500))}`]) await refused(bad);
  });
  test("assertion fields of the wrong type are invalid_client", async () => {
    const c = client();
    for (const claims of [{ iss: {} }, { iss: "constructor", sub: "constructor" }, { iss: "__proto__", sub: "__proto__" }, { exp: "9999999999" }, { exp: null }, { exp: now() + 1.5 }, { jti: {} }, { jti: 1 }, { jti: "" }, { aud: [] }]) await refused(signed(c, claims));
  });
  test("an assertion's signature has to be from the registered key", async () => {
    const other = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
    const c = client();
    await refused(signed({ ...c, privateKey: other }, {}));
  });
  test("an assertion's exp can be at most five minutes ahead", async () => {
    const c = client();
    for (const ahead of [301, 400, 3600, 365 * 86400]) await refused(signed(c, { exp: now() + ahead }));
    // Two seconds' margin keeps this from depending on when the second turns over.
    expect((await post(assertionBody(signed(c, { exp: now() + 298 })))).status).toBe(200);
    expect((await post(assertionBody(clientAssertion(c, conf.token_endpoint)))).status).toBe(200);
  });
  test("an expired assertion is refused", async () => {
    const c = client();
    await refused(signed(c, { exp: now() - 1 }));
  });
});

describe("Token responses can't be cached", () => {
  const noStore = (r: Response) => {
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("pragma")).toBe("no-cache");
  };
  test("all three grants", async () => {
    const a = auth();
    const back = await submitConsent(a.url, { user: "josh" });
    const code = await post(tokenRequestBody(a, back.searchParams.get("code")!));
    expect(code.status).toBe(200);
    noStore(code);
    const t: any = await code.json();
    const refreshed = await post(new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: "portal-app" }).toString());
    expect(refreshed.status).toBe(200);
    noStore(refreshed);
    const c = stack.auth.registerBackendClient("no-store-test", ["system/ImagingStudy.rs"]);
    const backend = await post(new URLSearchParams({ grant_type: "client_credentials", scope: "system/ImagingStudy.rs", client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: clientAssertion(c, conf.token_endpoint) }).toString());
    expect(backend.status).toBe(200);
    noStore(backend);
  });
  test("errors", async () => {
    for (const body of ["grant_type=nonsense", "grant_type=authorization_code&code=x", "grant_type=refresh_token&refresh_token=x", "grant_type=client_credentials", "grant_type=client_credentials&client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer&client_assertion=a.b.c"]) {
      const r = await post(body);
      expect(r.status).toBeGreaterThanOrEqual(400);
      noStore(r);
    }
  });
});

describe("Refresh tokens", () => {
  const refresh = (token: string, client?: string) => post(new URLSearchParams({ grant_type: "refresh_token", refresh_token: token, ...(client ? { client_id: client } : {}) }).toString());
  const launch = async () => { await stack.resetAll(); return scriptedLaunch("josh"); };
  const liveAccess = (token: string) => !stack.store.getToken(token, "access")!.revoked;

  test("only the client it was issued to can use one, and a refused try doesn't spend it", async () => {
    const t = await launch();
    for (const client of ["separate-viewer", undefined, "constructor"]) {
      const r = await refresh(t.refresh_token, client);
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ error: "invalid_grant" });
    }
    expect(liveAccess(t.access_token)).toBe(true);
    expect((await refresh(t.refresh_token, "portal-app")).status).toBe(200);
  });
  test("replaying a used one revokes the rest of its family", async () => {
    const t = await launch();
    const next: any = await (await refresh(t.refresh_token, "portal-app")).json();
    const newer: any = await (await refresh(next.refresh_token, "portal-app")).json();
    const replay = await refresh(t.refresh_token, "portal-app");
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({ error: "invalid_grant" });
    expect((await refresh(newer.refresh_token, "portal-app")).status).toBe(400);
    for (const token of [t.access_token, next.access_token, newer.access_token]) expect(liveAccess(token)).toBe(false);
    expect((await fetch(`${conf.associated_endpoints[0].url}/ImagingStudy?patient=josh-example`, { headers: { Authorization: `Bearer ${newer.access_token}` } })).status).toBe(401);
  });
  test("another client replaying a used one changes nothing", async () => {
    const t = await launch();
    const next: any = await (await refresh(t.refresh_token, "portal-app")).json();
    expect((await refresh(t.refresh_token, "separate-viewer")).status).toBe(400);
    expect((await refresh(next.refresh_token, "portal-app")).status).toBe(200);
  });
  test("a replay doesn't reach another launch's tokens", async () => {
    const t = await launch();
    const other = await scriptedLaunch("josh");
    await refresh(t.refresh_token, "portal-app");
    expect((await refresh(t.refresh_token, "portal-app")).status).toBe(400);
    expect(liveAccess(other.access_token)).toBe(true);
    expect((await refresh(other.refresh_token, "portal-app")).status).toBe(200);
  });
  test("a used one is purged when it expires, and rotation keeps working", async () => {
    const t = await launch();
    stack.store.setSettings({ refreshTokenLifetimeSeconds: 100 });
    const next: any = await (await refresh(t.refresh_token, "portal-app")).json();
    expect(stack.store.getToken(t.refresh_token, "refresh")!.revoked).toBe(true);
    advance(30 * 86400 + 1);
    stack.purgeTokens();
    expect(stack.store.getToken(t.refresh_token, "refresh")).toBeUndefined();
    expect(stack.store.getToken(next.refresh_token, "refresh")).toBeUndefined();
    resetClock();
  });
  test("a family's id doesn't appear in anything a client or service reads", async () => {
    const t = await launch();
    expect(stack.store.getToken(t.access_token, "access")!.family).toBeTruthy();
    expect(JSON.stringify(t)).not.toContain(stack.store.getToken(t.access_token, "access")!.family!);
    expect(t.family).toBeUndefined();
  });
  test("replay detection survives a restart, in SQLite, holding only hashes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "refresh-family-"));
    const path = join(dir, "policy.sqlite");
    const open = () => {
      const store = new PolicyStore({ mode: "file", path });
      const none = async () => { throw new Error("not used"); };
      const server = createAuthServer({ issuer: CONFIG.authUrl, imagingFhirBase: "http://imaging/fhir", serviceSecret: "s", redirectUri: CALLBACK, store: () => store, storeLabel: () => "test", directory: { relationships: none, access: none, recordConsent: none, delegate: none, revokeDelegation: none, revokeApp: none } });
      const send = (token: string) => server.fetch(new Request(`${CONFIG.authUrl}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token, client_id: "portal-app" }) }));
      return { store, send, server };
    };
    try {
      let s = open();
      s.store.putToken("first-raw-refresh-value", "refresh", { client_id: "portal-app", scope: "launch/patient online_access", patient: "josh-example", family: "family-1" }, now() + 1000);
      s.store.putToken("unrelated-raw-refresh-value", "refresh", { client_id: "portal-app", scope: "online_access", family: "family-2" }, now() + 1000);
      const next: any = await (await s.send("first-raw-refresh-value")).json();
      s.store.close();

      s = open();
      expect((await s.send("first-raw-refresh-value")).status).toBe(400);
      s.store.close();

      s = open();
      expect((await s.send(next.refresh_token)).status).toBe(400);
      expect(s.store.getToken(next.access_token, "access")!.revoked).toBe(true);
      const live: any = await (await s.send("unrelated-raw-refresh-value")).json();
      const introspected: any = await (await s.server.fetch(new Request(`${CONFIG.authUrl}/introspect`, { method: "POST", headers: { Authorization: "Bearer s" }, body: new URLSearchParams({ token: live.access_token }) }))).json();
      expect(introspected.active).toBe(true);
      expect(introspected.family).toBeUndefined();
      s.store.close();

      const db = new Database(path);
      const rows = JSON.stringify(db.query("SELECT * FROM tokens").all());
      db.close();
      const onDisk = rows + readFileSync(path, "latin1");
      for (const raw of ["first-raw-refresh-value", "unrelated-raw-refresh-value", next.refresh_token, next.access_token]) expect(onDisk).not.toContain(raw);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("The Clinical FHIR Server's Patient", () => {
  const read = (id: string, token?: string) => fetch(`${CLINICAL_FHIR}/Patient/${id}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  test("needs a token", async () => {
    for (const r of [await read("josh-example"), await read("josh-example", "not-a-real-token")]) {
      expect(r.status).toBe(401);
      expect(r.headers.get("www-authenticate")).toStartWith("Bearer");
      expect(await r.text()).not.toContain("Josh");
    }
  });
  test("answers a token for that patient, and no other", async () => {
    await stack.resetAll();
    const josh = await scriptedLaunch("josh");
    const r = await read("josh-example", josh.access_token);
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).id).toBe("josh-example");
    expect((await read("robin-example", josh.access_token)).status).toBe(403);
    expect((await read("nobody", josh.access_token)).status).toBe(403);
    expect((await read("josh-example/extra", josh.access_token)).status).toBe(403);
  });
  test("refuses a refresh token, a revoked token, an expired one, or one with no patient", async () => {
    await stack.resetAll();
    const josh = await scriptedLaunch("josh");
    expect((await read("josh-example", josh.refresh_token)).status).toBe(401);
    const c = stack.auth.registerBackendClient("patient-read-test", ["system/ImagingStudy.rs"]);
    const backend: any = await (await post(new URLSearchParams({ grant_type: "client_credentials", scope: "system/ImagingStudy.rs", client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: clientAssertion(c, conf.token_endpoint) }).toString())).json();
    expect((await read("josh-example", backend.access_token)).status).toBe(403);
    stack.store.revokeToken(josh.access_token);
    expect((await read("josh-example", josh.access_token)).status).toBe(401);
    const later = await scriptedLaunch("josh");
    advance(3601);
    expect((await read("josh-example", later.access_token)).status).toBe(401);
    resetClock();
  });
});

describe("serveOn, for every service", () => {
  const start = (fetch: (req: Request) => Response | Promise<Response>) => serveOn(0, { fetch })[0]!;
  test("a failure answers with a generic 500, and shows no path, source or message", async () => {
    const quiet = console.error;
    const logged: unknown[] = [];
    console.error = (...a: unknown[]) => { logged.push(...a); };
    for (const handler of [() => { throw new Error("secret detail at /home/someone/src/thing.ts"); }, async () => { throw new Error("secret detail at /home/someone/src/thing.ts"); }]) {
      const s = start(handler);
      try {
        const r = await fetch(`http://127.0.0.1:${s.port}/boom`);
        expect(r.status).toBe(500);
        const text = await r.text();
        expect(text).toBe("Internal Server Error");
        expect(r.headers.get("content-type")).toStartWith("text/plain");
      } finally { s.stop(true); }
    }
    console.error = quiet;
    expect(String(logged[0])).toContain("secret detail");
  });
  test("a favicon request is a 204, without reaching the service", async () => {
    let reached = 0;
    const s = start(() => { reached++; return new Response("page"); });
    try {
      const r = await fetch(`http://127.0.0.1:${s.port}/favicon.ico`);
      expect(r.status).toBe(204);
      expect(reached).toBe(0);
      expect(await (await fetch(`http://127.0.0.1:${s.port}/other`)).text()).toBe("page");
      expect(reached).toBe(1);
    } finally { s.stop(true); }
  });
  test("a real request with no Host reaches the service, with an absolute URL", async () => {
    let seen = "";
    const s = start(req => { seen = req.url; return new Response("page"); });
    try {
      const reply = await new Promise<string>((resolve, reject) => {
        let text = "";
        Bun.connect({ hostname: "127.0.0.1", port: s.port, socket: { open(c) { c.write("GET /path?q=1 HTTP/1.0\r\n\r\n"); }, data(_c, d) { text += d.toString(); }, close() { resolve(text); }, error(_c, e) { reject(e); } } }).catch(reject);
      });
      expect(reply).toStartWith("HTTP/1.1 200");
      expect(seen).toStartWith("http://127.0.0.1:");
      expect(seen).toEndWith("/path?q=1");
    } finally { s.stop(true); }
  });
  test("each running service answers a favicon request", async () => {
    for (const base of [CONFIG.authUrl, CONFIG.imagingUrl, CONFIG.traceUrl]) expect((await fetch(`${base}/favicon.ico`)).status).toBe(204);
  });
});
