// The App Launch flow is real, so it has to reject what a real Authorization Server rejects.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { startStack, type Stack } from "../src/stack";
import { CONFIG } from "../src/config";
import { Ctx } from "../src/flows/runtime";
import { FLOWS, registerClients, runStep, startFlow } from "../src/flows";
import { accountUrl, buildAuthorization, CALLBACK, CLINICAL_FHIR, scriptedLaunch, submitConsent, submitDelegation, submitRevocation, tokenRequestBody } from "../src/flows/oauth";

let stack: Stack; let conf: any;
beforeAll(async () => { stack = await startStack(join(import.meta.dir, "..")); stack.resetAll(); conf = await (await fetch(`${CLINICAL_FHIR}/.well-known/smart-configuration`)).json(); });
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
    const store = stack.stores.active;
    stack.imaging.setPolicy({ rules: [{ id: "names-client", when: { client: "separate-viewer" }, allow: { all: true } }] });
    store.putToken("user-system-token", "access", { client_id: "separate-viewer", scope: "system/ImagingStudy.rs", sub: "robin", fhirUser: "RelatedPerson/robin" }, Math.floor(Date.now() / 1000) + 300);
    const r = await fetch(`${CONFIG.imagingUrl}/fhir/ImagingStudy?patient=josh-example`, { headers: { Authorization: "Bearer user-system-token" } });
    expect(r.status).toBe(403);
    stack.resetAll();
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
    stack.resetAll();
    const t = await scriptedLaunch("josh", "portal-app", { sites: ["Lakeside Imaging"] });
    expect(t.scope).toBe("launch/patient patient/ImagingStudy.rs online_access");
    expect(stack.imaging.getPolicy().appGrants[0]!.sites).toEqual(["Lakeside Imaging"]);
    const b: any = await (await fetch(`${conf.associated_endpoints[0].url}/ImagingStudy?patient=josh-example`, { headers: { Authorization: `Bearer ${t.access_token}` } })).json();
    expect(b.total).toBe(1);
    stack.resetAll();
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
    stack.resetAll();
    let html = await signInPage();
    expect(roleOn(html, "josh")).toBe("Patient");
    expect(roleOn(html, "robin")).toBe("Patient");
    expect(roleOn(html, "sam-caregiver")).toBe("Related person, nothing shared yet");
    expect(roleOn(html, "alex-neighbor")).toBe("Related person, nothing shared yet");
    expect(html).not.toContain("Caregiver");
    expect(html).not.toContain("Neighbor of");

    await submitDelegation(accountUrl("josh"), { user: "josh", delegate: "sam-caregiver", relationship: "caregiver", sites: ["Lakeside Imaging"] });
    html = await signInPage();
    expect(roleOn(html, "sam-caregiver")).toBe("Caregiver for Josh Example");
    expect(roleOn(html, "alex-neighbor")).toBe("Related person, nothing shared yet");

    await submitDelegation(accountUrl("josh"), { user: "josh", delegate: "robin", relationship: "spouse", sites: ["Lakeside Imaging"] });
    expect(roleOn(await signInPage(), "robin")).toBe("Patient");

    await submitRevocation(accountUrl("josh"), { user: "josh", delegate: "sam-caregiver" });
    expect(roleOn(await signInPage(), "sam-caregiver")).toBe("Related person, nothing shared yet");
    stack.resetAll();
  });
  test("the account page's role line comes from the same state", async () => {
    stack.resetAll();
    const accountRole = async (user: string) => {
      const res = await fetch(`${CLINICAL_FHIR.replace("/fhir", "")}/account/signin`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `username=${user}`, redirect: "manual" });
      const html = await (await fetch(`${CLINICAL_FHIR.replace("/fhir", "")}/account`, { headers: { cookie: res.headers.get("set-cookie")!.split(";")[0]! } })).text();
      return html.match(/<p class="who">([^.]*)\. Signed in as/)![1];
    };
    expect(await accountRole("josh")).toBe("Patient");
    expect(await accountRole("sam-caregiver")).toBe("Related person, nothing shared yet");
    await submitDelegation(accountUrl("josh"), { user: "josh", delegate: "sam-caregiver", relationship: "adult child", sites: ["Lakeside Imaging"] });
    expect(await accountRole("sam-caregiver")).toBe("Adult child for Josh Example");
    stack.resetAll();
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
    stack.resetAll();
    const t = await scriptedLaunch("robin");
    expect(t.patient).toBe("robin-example");
    const r = await fetch(`${conf.associated_endpoints[0].url}/ImagingStudy?patient=robin-example&_include=ImagingStudy:endpoint`, { headers: { Authorization: `Bearer ${t.access_token}` } });
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.total).toBe(0);
    expect(b.entry).toEqual([]);
  });
  test("Robin can't reach Josh's studies, by search or by retrieval", async () => {
    stack.resetAll();
    const t = await scriptedLaunch("robin");
    expect((await fetch(`${conf.associated_endpoints[0].url}/ImagingStudy?patient=josh-example`, { headers: { Authorization: `Bearer ${t.access_token}` } })).status).toBe(403);
    const uid = stack.catalog.allStudies()[0]!.uid;
    expect((await fetch(`${CONFIG.proxyUrl}/wado/-/studies/${uid}`, { headers: { Authorization: `Bearer ${t.access_token}`, Accept: "multipart/related; type=application/dicom; transfer-syntax=*" } })).status).toBe(404);
  });
  test("Robin's consent and account pages say there's no imaging, and offer no sites", async () => {
    stack.resetAll();
    const a = buildAuthorization(conf.authorization_endpoint, "portal-app", undefined, undefined, "robin");
    const page = await (await statusOf(a.url)).text();
    const action = page.match(/action="([^"]+)"/)![1]!.replaceAll("&amp;", "&");
    const signedIn = await fetch(new URL(action, conf.authorization_endpoint), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "username=robin", redirect: "manual" });
    const consent = await (await fetch(new URL(signedIn.headers.get("location")!, conf.authorization_endpoint))).text();
    expect(consent).toContain("Robin Example: your own records");
    expect(consent).toContain("No imaging studies are on file");
    expect(consent).not.toContain('name="sites"');
    const res = await fetch(`${CLINICAL_FHIR.replace("/fhir", "")}/account/signin`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "username=robin", redirect: "manual" });
    expect(res.status).toBe(303);
    const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
    const acct = await (await fetch(`${CLINICAL_FHIR.replace("/fhir", "")}/account`, { headers: { cookie } })).text();
    expect(acct).toContain("No imaging studies on file");
    expect(acct).toContain("Policy in use: Flow scratch: reset when a flow starts");
    expect(acct).not.toContain('name="delegate"');
  });
  test("a window launch reports who actually signed in, not who was hinted", async () => {
    stack.resetAll();
    const c = new Ctx(stack, {});
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
    stack.resetAll();
    const t = await scriptedLaunch("sam-caregiver");
    expect(t.error).toBe("access_denied");
    expect(t.access_token).toBeUndefined();
  });
  test("a related person signs in with their own login, and sees the subset", async () => {
    stack.resetAll();
    expect((await share(["Lakeside Imaging"])).status).toBe(303);
    const t = await scriptedLaunch("sam-caregiver");
    expect(t.patient).toBe("josh-example");
    expect(t.scope).toBe("launch/patient patient/ImagingStudy.rs online_access");
    expect(sitesOf(await search(t.access_token))).toBe(1);
  });
  test("a related person's app holds only what both links allow", async () => {
    stack.resetAll();
    await share(["Lakeside Imaging", "Riverside Hospital"]);
    const t = await scriptedLaunch("sam-caregiver", "portal-app", { sites: ["Riverside Hospital"] });
    expect(sitesOf(await search(t.access_token))).toBe(4);
  });
  test("a related person can't give an app more than they hold", async () => {
    stack.resetAll();
    await share(["Lakeside Imaging"]);
    const t = await scriptedLaunch("sam-caregiver", "portal-app", { sites: ["Lakeside Imaging", "Northside Pathology"] });
    expect(stack.imaging.getPolicy().appGrants[0]!.sites).toEqual(["Lakeside Imaging"]);
    expect(sitesOf(await search(t.access_token))).toBe(1);
  });
  test("only a patient can delegate", async () => {
    stack.resetAll();
    const r = await submitDelegation(accountUrl("sam-caregiver"), { user: "sam-caregiver", delegate: "alex-neighbor", relationship: "neighbor", sites: ["Lakeside Imaging"] });
    expect(r.status).toBe(403);
    expect(stack.imaging.getPolicy().delegations).toEqual([]);
  });
  test("revoking the delegation ends what the related person's app can find", async () => {
    stack.resetAll();
    await share(["Lakeside Imaging"]);
    const t = await scriptedLaunch("sam-caregiver");
    expect((await submitRevocation(accountUrl("josh"), { user: "josh", delegate: "sam-caregiver" })).status).toBe(303);
    expect(sitesOf(await search(t.access_token))).toBe(0);
  });
  test("the account page needs a session, and shows what the user holds", async () => {
    stack.resetAll();
    expect(await (await fetch(`${CLINICAL_FHIR.replace("/fhir", "")}/account`)).text()).toContain("Sign in");
    const denied = await fetch(`${CLINICAL_FHIR.replace("/fhir", "")}/account/delegations`, { method: "POST", body: "delegate=sam-caregiver" });
    expect(denied.status).toBe(401);
  });
});

describe("Backend Services", () => {
  test("a replayed assertion is rejected", async () => {
    const { clientAssertion } = await import("../src/auth-server");
    const client = stack.auth.registerBackendClient("replay-test", ["system/ImagingStudy.rs"]);
    const body = new URLSearchParams({ grant_type: "client_credentials", scope: "system/ImagingStudy.rs", client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: clientAssertion(client, conf.token_endpoint) }).toString();
    expect((await post(body)).status).toBe(200);
    expect((await post(body)).status).toBe(401);
  });
});
