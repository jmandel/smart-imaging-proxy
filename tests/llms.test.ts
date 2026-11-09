// The guide for agents: it names the sandbox it's fetched from, and what it describes really works.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { createDemoServer } from "../src/demo-server";
import { registerClients } from "../src/flows";
import { CONFIG } from "../src/config";
import { startStack, type Stack } from "../src/stack";

const root = join(import.meta.dir, "..");
let stack: Stack, demo: ReturnType<typeof createDemoServer>;
beforeAll(async () => { stack = await startStack(root); demo = createDemoServer(stack, registerClients(stack), root); });
afterAll(() => stack.stop());
const guide = async (prefix: string) => { const r = await demo.fetch(new Request(`${CONFIG.demoUrl}${prefix}/llms.txt`)); return { r, text: await r.text() }; };
const action = (html: string, base: string) => new URL(html.match(/<form[^>]*action="([^"]+)"/)![1]!.replace(/&amp;/g, "&"), base).toString();
const form = (o: Record<string, string>) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o).toString(), redirect: "manual" as const });

test("from the root it says how to make a sandbox", async () => {
  const { r, text } = await guide("");
  expect(r.headers.get("content-type")).toContain("text/plain");
  expect(text).toContain("/api/sandboxes");
  expect(text).not.toContain("{{");
});
test("from a sandbox it names that sandbox, and keeps it out of indexes", async () => {
  const w = stack.sandboxes.mint();
  const { r, text } = await guide(w.prefix);
  expect(text).toContain(`SANDBOX=${w.urls.demo}`);
  expect(text).toContain(`](${w.urls.demo}/connect)`);
  expect(r.headers.get("x-robots-tag")).toBe("noindex");
  expect(text).not.toContain("{{");
});
test("the documented sign-in, reads, and management all work", async () => {
  const w = stack.sandboxes.mint(), S = w.urls.auth, redirect = "https://example.org/callback";
  const made = await (await demo.fetch(new Request(`${CONFIG.demoUrl}${w.prefix}/api/sandbox/clients`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Agent", redirectUris: [redirect] }) }))).json() as any;
  const verifier = randomBytes(32).toString("base64url"), challenge = createHash("sha256").update(verifier).digest("base64url");
  const url = new URL(`${S}/authorize`);
  Object.entries({ response_type: "code", client_id: made.id, redirect_uri: redirect, scope: "launch/patient patient/*.rs", aud: `${S}/fhir`, state: "x", code_challenge: challenge, code_challenge_method: "S256" }).forEach(([k, v]) => url.searchParams.set(k, v));
  const signIn = await fetch(url);
  const after = await fetch(action(await signIn.text(), url.toString()), form({ username: "josh" }));
  expect(after.status).toBe(303);
  const consentUrl = new URL(after.headers.get("location")!, S).toString();
  const consent = await fetch(consentUrl);
  const back = await fetch(action(await consent.text(), consentUrl), form({ decision: "approve", patient: "josh-example" }));
  expect(back.status).toBe(302);
  const code = new URL(back.headers.get("location")!).searchParams.get("code")!;
  const token: any = await (await fetch(`${S}/token`, form({ grant_type: "authorization_code", code, redirect_uri: redirect, client_id: made.id, code_verifier: verifier }))).json();
  expect(token.patient).toBe("josh-example");
  const auth = { headers: { authorization: `Bearer ${token.access_token}` } };
  expect((await fetch(`${S}/fhir/Patient/josh-example`, auth)).status).toBe(200);
  expect((await fetch(`${S}/fhir/Condition?patient=Patient/josh-example&clinical-status=active`, auth)).status).toBe(200);
  const studies: any = await (await fetch(`${w.urls.imaging}/fhir/ImagingStudy?patient=Patient/josh-example&_include=ImagingStudy:endpoint`, auth)).json();
  expect(studies.entry.filter((e: any) => e.resource.resourceType === "ImagingStudy").length).toBe(6);
  for (const path of ["/api/sandbox", "/api/sandbox/clients", "/api/sandbox/policy", "/api/sandbox", "/api/sandbox/storage"]) expect((await demo.fetch(new Request(`${CONFIG.demoUrl}${w.prefix}${path}`))).status).toBe(200);
});
