// The viewer against servers shaped the many ways the SMART Imaging guide allows, on another origin. A small
// fixture reshapes a real sandbox's answers, and has a trap that must never see the token.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { addClient } from "../src/clients";
import { createDemoServer } from "../src/demo-server";
import { registerClients } from "../src/flows";
import { CONFIG, PORTS } from "../src/config";
import { startStack, type Stack } from "../src/stack";

setDefaultTimeout(30000);
const CAPS = ["smart-imaging-access", "http://fhir.org/argonaut/smart-imaging/capabilities/app-launch"];
let stack: Stack, demo: ReturnType<typeof Bun.serve>, fixture: ReturnType<typeof Bun.serve>, browser: Browser, world: ReturnType<Stack["scopes"]["mint"]>;
let clientId = "", FIX = "", trapHits = 0;
const retried = new Set<string>();
const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, accept, content-type", "access-control-allow-methods": "GET, POST" };
const json = (b: unknown, init: ResponseInit = {}) => Response.json(b, { ...init, headers: { ...cors, ...(init.headers ?? {}) } });

function reshape(kind: string, b: any, url: URL) {
  const entries: any[] = b.entry ?? [], studies = entries.filter(e => e.resource.resourceType === "ImagingStudy"), endpoints = entries.filter(e => e.resource.resourceType === "Endpoint");
  const endpointOf = (st: any) => endpoints.find(e => e.fullUrl === st.resource.endpoint?.[0]?.reference);
  const trap = { resourceType: "Endpoint", id: "qido", status: "active", connectionType: { code: "dicom-qido-rs" }, address: `${FIX}/trap` };
  if (kind === "contained") return { ...b, entry: studies.map(e => { const ep = endpointOf(e)!.resource; return { ...e, resource: { ...e.resource, contained: [trap, { ...ep, id: "wado" }], endpoint: [{ reference: "#qido" }, { reference: "#wado" }] } }; }) };
  if (kind === "qido-first") return { ...b, entry: [...entries.map(e => e.resource.resourceType !== "ImagingStudy" ? e : { ...e, resource: { ...e.resource, endpoint: [{ reference: "urn:uuid:qido" }, ...e.resource.endpoint] } }), { fullUrl: "urn:uuid:qido", resource: trap, search: { mode: "include" } }] };
  if (kind === "relative") return { ...b, entry: entries.map(e => e.resource.resourceType === "Endpoint" ? { ...e, fullUrl: `${FIX}/relative/imaging/fhir/Endpoint/${e.resource.id}` } : { ...e, resource: { ...e.resource, endpoint: [{ reference: `Endpoint/${endpointOf(e)!.resource.id}` }] } }) };
  if (kind === "series-endpoint") return { ...b, entry: entries.map(e => e.resource.resourceType !== "ImagingStudy" ? e : { ...e, resource: { ...e.resource, series: e.resource.series.map((s: any) => ({ ...s, endpoint: e.resource.endpoint })) } }) };
  if (kind === "incomplete") return { ...b, entry: [...entries, { resource: { resourceType: "OperationOutcome", issue: [{ severity: "warning", code: "incomplete" }] }, search: { mode: "outcome" } }] };
  if (kind === "paged") {
    const page = Number(url.searchParams.get("page") ?? 1), mine = studies.slice((page - 1) * 3, page * 3);
    const keep = new Set(mine.flatMap(s => s.resource.endpoint.map((r: any) => r.reference)));
    const link = page < 2 ? [{ relation: "next", url: `${FIX}/paged/imaging/fhir/ImagingStudy?${url.searchParams}&page=${page + 1}` }] : [];
    return { ...b, link, entry: [...mine, ...endpoints.filter(e => keep.has(e.fullUrl))] };
  }
  return b;
}

beforeAll(async () => {
  const root = join(import.meta.dir, "..");
  stack = await startStack(root);
  demo = Bun.serve({ port: PORTS.demo, hostname: "127.0.0.1", fetch: createDemoServer(stack, registerClients(stack), root).fetch });
  world = stack.scopes.mint();
  clientId = (addClient(world.store, { name: "Spec test", redirectUris: [`${CONFIG.demoUrl}/`] }) as any).id;
  fixture = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const url = new URL(req.url), [, kind, ...rest] = url.pathname.split("/"), path = `/${rest.join("/")}`;
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (kind === "trap") { if (req.headers.has("authorization")) trapHits++; return json({}); }
    const real = world.urls.auth, auth = { headers: { authorization: req.headers.get("authorization") ?? "", accept: "application/fhir+json" } };
    if (path === "/fhir/.well-known/smart-configuration") {
      const c: any = await (await fetch(`${real}/fhir/.well-known/smart-configuration`)).json();
      const base = { ...c, authorization_endpoint: `${FIX}/${kind}/authorize` }; delete base.associated_endpoints;
      if (kind === "unified") return json({ ...base, capabilities: [...c.capabilities, ...CAPS] });
      if (kind === "no-launch") return json({ ...base, associated_endpoints: [{ url: `${FIX}/${kind}/imaging/fhir`, capabilities: ["smart-imaging-access"] }] });
      return json({ ...base, associated_endpoints: [{ url: `${FIX}/${kind}/imaging/fhir`, capabilities: CAPS }] });
    }
    if (path === "/authorize") { const to = new URL(`${real}/authorize${url.search}`); to.searchParams.set("aud", `${real}/fhir`); return Response.redirect(to.toString(), 302); }
    if (path.endsWith("/ImagingStudy")) {
      if (kind === "retry" && !retried.has(kind)) { retried.add(kind); return new Response(null, { status: 503, headers: { ...cors, "retry-after": "1", "access-control-expose-headers": "retry-after" } }); }
      const q = new URLSearchParams(url.search); q.delete("page"); q.set("_count", "100");
      const answer: any = await (await fetch(`${world.urls.imaging}/fhir/ImagingStudy?${q}`, auth)).json();
      return json(reshape(kind!, answer, url));
    }
    if (path.startsWith("/fhir/")) { const r = await fetch(`${real}${path}${url.search}`, auth); return new Response(r.body, { status: r.status, headers: { ...cors, "content-type": "application/fhir+json" } }); }
    return new Response("not found", { status: 404, headers: cors });
  } });
  FIX = `http://127.0.0.1:${fixture.port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium", headless: true, timeout: 15000 });
});
afterAll(async () => { await browser?.close(); fixture?.stop(true); demo?.stop(true); stack?.stop(); });

async function connect(kind: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  context.setDefaultTimeout(10000);
  const page = await context.newPage();
  await page.goto(`${CONFIG.demoUrl}/`);
  await page.locator("#configure summary").click();
  await page.locator("#servers-json").fill(JSON.stringify([{ label: kind, iss: `${FIX}/${kind}/fhir`, clientId }]));
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByText("Saved 1 server of your own.").waitFor();
  await page.getByRole("radio", { name: new RegExp(`^${kind}`) }).check();
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  return page;
}
async function signIn(page: Page) {
  await page.locator("input[name=username][value=josh]").check();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Approve" }).click();
  await page.locator("#app").waitFor({ state: "visible" });
}
const showsImages = async (page: Page) => {
  await page.locator(".study-button").nth(5).waitFor();
  expect(await page.locator(".study-button:enabled").count()).toBe(6);
  await page.locator("#overlay", { hasText: "×" }).waitFor({ timeout: 15000 });
  await page.locator("#stage-note:empty").waitFor({ state: "attached", timeout: 15000 });
};

describe("a viewer on another origin from its servers", () => {
  for (const kind of ["separate", "unified", "contained", "qido-first", "relative", "series-endpoint", "paged", "retry"]) {
    test(`${kind}: signs in, lists every study, shows an image`, async () => {
      const page = await connect(kind);
      await signIn(page);
      await showsImages(page);
      expect(trapHits).toBe(0);
      await page.context().close();
    });
  }
  test("incomplete results are shown, and flagged", async () => {
    const page = await connect("incomplete");
    await signIn(page);
    await showsImages(page);
    await page.getByText("these results are incomplete").waitFor();
    await page.context().close();
  });
  test("a server without the App Launch capability isn't used", async () => {
    const page = await connect("no-launch");
    await page.getByText("doesn't advertise SMART Imaging with App Launch").waitFor();
    await page.context().close();
  });
});
