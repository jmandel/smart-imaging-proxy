// contract.json, checked against what the sandbox actually does: for every person and patient it lists, an app
// signed in through the forms and approved for every site finds exactly the studies and reports it says, and the
// studies it says are withheld read as 404 for that app.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { createDemoServer } from "../src/demo-server";
import { registerClients } from "../src/flows";
import { CONFIG, PORTS } from "../src/config";
import { startStack, type Stack } from "../src/stack";
import { adminHeaders } from "./admin-token";
import type { Contract } from "../src/contract";

setDefaultTimeout(60000);
const root = join(import.meta.dir, ".."), b64 = (b: Buffer) => b.toString("base64url");
let stack: Stack, demo: ReturnType<typeof Bun.serve>, base = "", contract: Contract, clientId = "";
const REDIRECT = "http://localhost:8123/callback";
const S = () => `${CONFIG.demoUrl}${base}`;
const formAction = async (r: Response) => new URL((await r.text()).match(/<form[^>]*action="([^"]+)"/)![1]!.replaceAll("&amp;", "&"), r.url);

/** A token as an app gets one: the forms walked as `user`, choosing `patient`, approving every site. */
async function signIn(user: string, patient: string) {
  const conf: any = await (await fetch(`${S()}/fhir/.well-known/smart-configuration`)).json();
  const verifier = b64(randomBytes(32)), auth = new URL(conf.authorization_endpoint);
  for (const [n, v] of Object.entries({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, scope: "launch/patient patient/*.rs", aud: `${S()}/fhir`, state: "c", code_challenge: b64(createHash("sha256").update(verifier).digest()), code_challenge_method: "S256" })) auth.searchParams.set(n, v);
  const signInAt = await formAction(await fetch(auth));
  const consent = new URL((await fetch(signInAt, { method: "POST", body: new URLSearchParams({ username: user }), redirect: "manual" })).headers.get("location")!, signInAt);
  const back = new URL((await fetch(await formAction(await fetch(consent)), { method: "POST", body: new URLSearchParams({ decision: "approve", patient }), redirect: "manual" })).headers.get("location")!);
  const t: any = await (await fetch(conf.token_endpoint, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code: back.searchParams.get("code")!, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier }) })).json();
  return { token: t.access_token as string, imaging: conf.associated_endpoints.find((e: any) => e.capabilities.includes("smart-imaging-access")).url as string };
}

beforeAll(async () => {
  stack = await startStack(root);
  demo = Bun.serve({ port: PORTS.demo, hostname: "127.0.0.1", ...createDemoServer(stack, registerClients(stack), root) });
  base = ((await (await fetch(`${CONFIG.demoUrl}/api/sandboxes`, { method: "POST" })).json()) as any).base;
  const app: any = await (await fetch(`${S()}/api/sandbox/clients`, { method: "POST", headers: { ...await adminHeaders({ fetch: r => fetch(r) }, base), "content-type": "application/json" }, body: JSON.stringify({ name: "Contract test", redirectUris: [REDIRECT] }) })).json();
  clientId = app.id;
  contract = await (await fetch(`${S()}/contract.json`)).json() as Contract;
});
afterAll(() => { demo?.stop(true); stack?.stop(); });

test("contract.json lists the four views llms.txt describes, and the sites", () => {
  expect(contract.sites).toEqual(["Lakeside Imaging", "Northside Pathology", "Riverside Hospital"]);
  expect(contract.expected.map(v => [v.user, v.patient, v.studies.length, v.withheld.length])).toEqual([
    ["josh", "josh-example", 6, 0], ["robin", "robin-example", 0, 0], ["sam-caregiver", "sam-example", 2, 0], ["sam-caregiver", "riley-example", 1, 1],
  ]);
});

test("every view it lists is what an app actually sees", async () => {
  for (const v of contract.expected) {
    const { token, imaging } = await signIn(v.user, v.patient), bearer = { authorization: `Bearer ${token}` };
    const found: string[] = [];
    for (let next: string | undefined = `${imaging}/ImagingStudy?patient=Patient/${v.patient}`; next;) {
      const page: any = await (await fetch(next, { headers: bearer })).json();
      found.push(...(page.entry ?? []).filter((e: any) => e.resource.resourceType === "ImagingStudy").map((e: any) => e.resource.id));
      next = page.link?.find((l: any) => l.relation === "next")?.url;
    }
    expect([v.user, v.patient, found.sort()]).toEqual([v.user, v.patient, v.studies.map(s => s.id).sort()]);
    const reports: any = await (await fetch(`${S()}/fhir/DiagnosticReport?patient=Patient/${v.patient}`, { headers: bearer })).json();
    expect([v.user, v.patient, reports.entry?.length ?? 0]).toEqual([v.user, v.patient, v.reports]);
    for (const w of v.withheld) expect([w.id, (await fetch(`${S()}/fhir/DiagnosticReport/report-${w.id}`, { headers: bearer })).status]).toEqual([w.id, 404]);
  }
});

test("llms.txt's table of expected answers is drawn from it", async () => {
  const doc = await (await fetch(`${S()}/llms.txt`)).text();
  expect(doc).not.toContain("{{EXPECTED_TABLE}}");
  for (const v of contract.expected) expect(doc).toContain(`| \`${v.user}\` | \`${v.patient}\` |`);
});
