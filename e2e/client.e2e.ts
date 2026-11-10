// The public demo client, in a real browser, through the one origin: Connect, sign in, approve, the
// chart, the study list, and a picture on the canvas. BASE_URL points it at a deployment instead of
// the stack it starts itself, and SHOTS saves what it saw.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { createDemoServer } from "../src/demo-server";
import { registerClients } from "../src/flows";
import { CONFIG, PORTS } from "../src/config";
import { startStack, type Stack } from "../src/stack";

setDefaultTimeout(40000);
const ORIGIN = process.env.BASE_URL ?? CONFIG.demoUrl;
const SHOTS = process.env.SHOTS;
let stack: Stack | undefined, servers: ReturnType<typeof Bun.serve>[] = [], browser: Browser;

beforeAll(async () => {
  if (!process.env.BASE_URL) {
    const root = join(import.meta.dir, "..");
    stack = await startStack(root);
    servers = [
      Bun.serve({ port: PORTS.demo, hostname: "127.0.0.1", fetch: createDemoServer(stack, registerClients(stack), root).fetch }),
    ];
  }
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium", headless: true, args: process.env.HOST_RULES ? [`--host-resolver-rules=${process.env.HOST_RULES}`] : [] });
});
afterAll(async () => { await browser?.close(); servers.forEach(s => s.stop(true)); stack?.stop(); });

/** How many canvas pixels aren't black, read through a screenshot, since a WebGL canvas can't be read back afterwards. */
async function litPixels(page: Page) {
  const png = await page.locator("#canvas").screenshot();
  return page.evaluate(async b64 => {
    const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const c = new OffscreenCanvas(img.width, img.height), x = c.getContext("2d")!;
    x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, img.width, img.height).data;
    let lit = 0; for (let i = 0; i < d.length; i += 4) if (d[i]! > 24 || d[i + 1]! > 24 || d[i + 2]! > 24) lit++;
    return lit / (d.length / 4);
  }, png.toString("base64"));
}
/** A missing element fails in seconds, not half a minute. */
const newContext = async (o: Parameters<Browser["newContext"]>[0]) => { const c = await browser.newContext(o); c.setDefaultTimeout(10000); return c; };
const shot = async (page: Page, name: string) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }); };

/** From the home page, a new sandbox, entered. Its path is returned. */
async function enterSandbox(page: Page) {
  await page.goto(`${ORIGIN}/`);
  await page.getByRole("button", { name: "Create a sandbox" }).click();
  await page.waitForURL(u => /^\/s\/[^/]+\/$/.test(u.pathname));
  await page.locator("#sandbox-name").waitFor();
  return new URL(page.url()).pathname.replace(/\/$/, "");
}
async function signIn(page: Page, user: string) {
  await enterSandbox(page);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator(`input[name=username][value=${user}]`).check();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Approve" }).click();
  await page.locator("#app").waitFor({ state: "visible" });
}

describe("the demo client", () => {
  test("from Connect to a picture, with the protocol shown", async () => {
    const context = await newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
    const page = await context.newPage();
    const problems: string[] = [];
    page.on("pageerror", e => problems.push(e.message));
    await signIn(page, "josh");
    expect(new URL(page.url()).pathname).toMatch(/^\/s\/[^/]+\/$/);
    await expect(page.locator(".who").textContent()).resolves.toBe("Josh Example");
    await page.getByRole("heading", { name: "Conditions" }).waitFor();
    await page.locator("#c-Condition li", { hasText: "Migraine" }).waitFor();
    await page.locator("#c-MedicationRequest li").first().waitFor();
    await page.locator("#c-AllergyIntolerance li").first().waitFor();
    expect(await page.locator("#c-Condition li", { hasText: "wrist" }).count()).toBe(0); // resolved, so not active
    await page.locator(".study-button").nth(5).waitFor();
    expect(await page.locator(".study-button").count()).toBe(6);
    await page.locator("#stage-note:empty").waitFor({ state: "attached", timeout: 15000 });
    expect(await litPixels(page)).toBeGreaterThan(0.01);
    expect(await page.locator("#overlay").textContent()).toMatch(/\d+ × \d+/);
    for (const stage of ["discover", "authorize", "clinical", "imaging", "retrieve"]) await page.locator(`[data-stage=${stage}][data-state=done]`).waitFor();
    expect(await page.locator("[data-state=failed]").count()).toBe(0);
    await page.locator("[data-stage=imaging] .fact", { hasText: "Studies" }).locator("dd", { hasText: "6" }).waitFor();
    // Reports sit beside the images, and lead to them.
    await page.locator(".report").nth(5).waitFor();
    const brainReport = page.locator(".report", { hasText: /MRI BRAIN/i });
    await brainReport.locator("summary").click();
    await brainReport.getByRole("button", { name: "View images" }).click();
    await page.locator('.study-button[aria-pressed="true"]', { hasText: "BRAIN" }).waitFor();
    // A stack: the middle image first, then scrolling, the slider, and another series.
    await page.locator(".study-button", { hasText: "BRAIN" }).click();
    await page.locator("#slice:enabled").waitFor({ timeout: 15000 });
    await page.locator("#stage-note:empty").waitFor({ state: "attached", timeout: 15000 });
    const before = await page.locator("#slice-out").textContent();
    expect(Number(before!.split("/")[0]!.trim())).toBeGreaterThan(1);
    await page.locator("#stage").focus(); await page.keyboard.press("ArrowDown");
    await page.waitForFunction(b => document.querySelector("#slice-out")!.textContent !== b, before);
    const box0 = (await page.locator("#stage").boundingBox())!;
    const afterKey = await page.locator("#slice-out").textContent();
    await page.mouse.move(box0.x + 50, box0.y + 50); await page.mouse.wheel(0, 120);
    await page.waitForFunction(b => document.querySelector("#slice-out")!.textContent !== b, afterKey);
    await page.locator("#slice").fill("0");
    await page.waitForFunction(() => document.querySelector("#slice-out")!.textContent!.startsWith("1 /"));
    expect(await litPixels(page)).toBeGreaterThanOrEqual(0);
    expect(await page.locator("#series button").count()).toBeGreaterThan(1);
    const uid = await page.locator('#series button[aria-pressed="false"]').first().getAttribute("data-uid");
    await page.locator(`#series button[data-uid="${uid}"]`).click();
    await page.locator(`#series button[data-uid="${uid}"][aria-pressed="true"]`).waitFor();
    await page.locator("#stage-note:empty").waitFor({ state: "attached", timeout: 15000 });
    expect(await litPixels(page)).toBeGreaterThan(0.01);
    await page.getByRole("button", { name: "Zoom in" }).click();
    await page.locator("#overlay", { hasText: "Zoom 125%" }).waitFor();
    await page.getByRole("button", { name: "Pan" }).click();
    await expect(page.getByRole("button", { name: "Pan" }).getAttribute("aria-pressed")).resolves.toBe("true");
    const box = (await page.locator("#stage").boundingBox())!;
    await page.mouse.move(box.x + 200, box.y + 200); await page.mouse.down(); await page.mouse.move(box.x + 260, box.y + 230); await page.mouse.up();
    await page.getByRole("button", { name: "Window" }).click();
    await page.mouse.move(box.x + 200, box.y + 200); await page.mouse.down(); await page.mouse.move(box.x + 300, box.y + 260); await page.mouse.up();
    expect(await litPixels(page)).toBeGreaterThan(0.005);
    await shot(page, "desktop-study");
    await page.getByRole("button", { name: "Reset view" }).click();
    await page.locator("#overlay", { hasText: "Zoom 100%" }).waitFor();
    await page.locator(".study-button", { hasText: "SM" }).click();
    await page.locator("#overlay", { hasText: "×" }).waitFor({ timeout: 15000 });
    await page.locator("#stage-note:empty").waitFor({ state: "attached", timeout: 15000 });
    expect(await litPixels(page)).toBeGreaterThan(0.01);
    await shot(page, "desktop-slide");
    await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
    await page.locator("[data-stage=clinical] details.calls > summary").click();
    await page.locator("details.call", { hasText: "Search Condition" }).locator("summary").click();
    const detail = page.locator("details.call[open]", { hasText: "Search Condition" });
    await detail.locator("pre", { hasText: "Bearer …" }).waitFor();
    await detail.getByText("Clinical FHIR server").waitFor();
    await detail.getByRole("button", { name: "Copy as curl" }).click();
    await detail.getByRole("button", { name: /Copied|Couldn't copy/ }).waitFor();
    await shot(page, "desktop-request");
    const panelText = await page.locator("#trail").textContent();
    const token = await page.evaluate(() => JSON.parse(Object.entries(sessionStorage).find(([k]) => k.startsWith("smart-imaging-client"))![1]).session.token);
    expect(token.length).toBeGreaterThan(10);
    expect(panelText).not.toContain(token);
    expect(panelText).toContain("Imaging server");
    expect(await page.getByText("server-side trace").count()).toBe(0);
    await shot(page, "desktop-protocol");
    expect(problems).toEqual([]);
    await context.close();
  });
  // A deployment's root is read-only, so it can't stand in for another server. There, this needs a real one.
  test.skipIf(!!process.env.BASE_URL && !process.env.EXTERNAL_ISS)("a server described on Test your server, checked by its own discovery, then connected with PKCE", async () => {
    const context = await newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true });
    const page = await context.newPage();
    const base = await enterSandbox(page);
    await page.getByRole("link", { name: /Test your server/ }).first().click();
    await page.waitForURL(u => u.pathname === `${base}/servers`);
    await page.getByText("None yet.").waitFor();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByText('This server needs a name ("label").').waitFor();
    const ext = process.env.EXTERNAL_ISS ? { iss: process.env.EXTERNAL_ISS, clientId: process.env.EXTERNAL_CLIENT! } : { iss: `${ORIGIN}${base}/fhir`, clientId: "demo-client" };
    await page.getByLabel("FHIR base URL").fill(ext.iss);
    await page.getByLabel("FHIR base URL").blur();
    expect(await page.getByLabel("Name", { exact: true }).inputValue()).toBe(new URL(ext.iss).host);
    await page.getByRole("button", { name: "Check discovery" }).click();
    await page.locator("#discovery li", { hasText: "SMART Imaging" }).waitFor();
    if (!process.env.EXTERNAL_ISS) expect(await page.locator("#discovery li[data-state=bad]").count()).toBe(0);
    await page.locator("#register-facts").getByText(`${ORIGIN}${base}/`, { exact: true }).waitFor();
    await page.getByLabel("Name", { exact: true }).fill("Another server");
    await page.getByLabel("Client ID").fill(ext.clientId);
    await shot(page, "server-builder");
    await page.getByRole("button", { name: "Save and connect" }).click();
    await page.locator("input[name=username][value=josh]").check();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Approve" }).click();
    await page.locator("#app").waitFor({ state: "visible" });
    expect(new URL(page.url()).pathname).toBe(`${base}/`);
    await page.getByText("Connected to Another server").waitFor();
    await page.locator(".who").waitFor();
    await page.locator("#stage-note:empty").waitFor({ state: "attached", timeout: 15000 });
    await page.locator(".study-button").nth(5).waitFor();
    expect(await page.locator(".study-button").count()).toBe(6);
    expect(await litPixels(page)).toBeGreaterThan(0.01);
    await shot(page, process.env.EXTERNAL_ISS ? "external-server" : "configured-server");
    // Saved: offered again, editable, and removable.
    await page.goto(`${ORIGIN}${base}/servers`);
    await page.getByRole("heading", { name: "Another server" }).waitFor();
    await page.getByRole("button", { name: "Edit" }).click();
    await page.getByRole("heading", { name: "Edit Another server" }).waitFor();
    expect(await page.getByLabel("Client ID").inputValue()).toBe(ext.clientId);
    await page.getByRole("button", { name: "Remove Another server" }).click();
    await page.getByText("None yet.").waitFor();
    expect(await page.getByRole("heading", { name: "Add a server" }).count()).toBe(1);
    await context.close();
  });
  test("a confidential client made on Test your server signs with the key it generated", async () => {
    const context = await newContext({ viewport: { width: 390, height: 844 }, ignoreHTTPSErrors: true });
    const page = await context.newPage();
    const base = await enterSandbox(page);
    await page.goto(`${ORIGIN}${base}/servers`);
    await page.getByLabel("FHIR base URL").fill(`${ORIGIN}${base}/fhir`);
    await page.getByRole("radio", { name: /confidential app/ }).check();
    await page.getByRole("button", { name: "Save and connect" }).click();
    await page.getByText("Generate a key pair, or paste a private key").waitFor();
    await page.getByRole("button", { name: "Generate a key pair" }).click();
    const jwk = JSON.parse((await page.getByRole("button", { name: "Copy JWK" }).getAttribute("data-copy"))!);
    expect(jwk.d).toBeUndefined();
    await page.getByRole("button", { name: "Check discovery" }).click();
    await page.locator("#discovery li", { hasText: "Signed assertions" }).waitFor();
    expect(await page.locator("#discovery li[data-state=bad]").count()).toBe(0);
    // Registered in this sandbox as a developer would at their own server: the redirect URI and public key shown.
    const made = await (await page.request.post(`${ORIGIN}${base}/api/sandbox/clients`, { data: { name: "Builder test", type: "confidential", redirectUris: [`${ORIGIN}${base}/`], jwk } })).json();
    await page.getByLabel("Name", { exact: true }).fill("Signed in");
    await page.getByLabel("Client ID").fill(made.id);
    await shot(page, "server-builder-confidential");
    await page.getByRole("button", { name: "Save and connect" }).click();
    await page.locator("input[name=username][value=josh]").check();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Approve" }).click();
    await page.locator("#app").waitFor({ state: "visible" });
    await page.locator(".study-button").nth(5).waitFor();
    expect(await page.locator("#connected").textContent()).toBe("Connected to Signed in");
    await context.close();
  });
  test("home lists this browser's sandboxes, and deleting one removes it", async () => {
    const context = await newContext({ viewport: { width: 390, height: 844 }, ignoreHTTPSErrors: true });
    const page = await context.newPage();
    page.on("dialog", d => d.accept());
    await page.goto(`${ORIGIN}/`);
    await page.getByText("You don't have any yet.").waitFor();
    expect(await page.locator("nav.pages a:visible").count()).toBe(1);
    const first = await enterSandbox(page), second = await enterSandbox(page);
    await page.goto(`${ORIGIN}/`);
    await page.locator(`.sandbox-list a[href="${first}/"]`).waitFor();
    await page.locator(`.sandbox-list a[href="${second}/"]`).waitFor();
    await shot(page, "home");
    await page.locator(`.sandbox-list a[href="${first}/"]`).click();
    await page.waitForURL(u => u.pathname === `${first}/`);
    await page.getByRole("button", { name: "Delete" }).click();
    await page.waitForURL(u => u.pathname === "/");
    await page.locator(`.sandbox-list a[href="${second}/"]`).waitFor();
    expect(await page.locator(`.sandbox-list a[href="${first}/"]`).count()).toBe(0);
    expect((await page.request.get(`${ORIGIN}${first}/api/sandbox`)).status()).toBe(404);
    await context.close();
  });
  test("a page brought back with Back shows where things are now", async () => {
    const context = await newContext({ viewport: { width: 390, height: 844 }, ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/`);
    // What Back restores: a button left disabled by the click, and the list from before.
    await page.evaluate(() => { (document.querySelector("#create") as HTMLButtonElement).disabled = true; });
    const base = await page.evaluate(async () => (await (await fetch("/api/sandboxes", { method: "POST" })).json()).base);
    await page.evaluate(b => localStorage.setItem("smart-imaging-client:sandboxes", JSON.stringify([{ base: b, joined: false }])), base);
    await page.evaluate(() => dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    await page.locator(`.sandbox-list a[href="${base}/"]`).waitFor();
    expect(await page.locator("#create").isEnabled()).toBe(true);
    // And in a sandbox, a page left saying "Connecting…" on the way to sign-in.
    await page.goto(`${ORIGIN}${base}/`);
    await page.evaluate(() => { document.documentElement.classList.add("connecting"); (document.querySelector("#connect") as HTMLButtonElement).disabled = true; dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })); });
    await page.locator("#landing").waitFor({ state: "visible" });
    expect(await page.locator("#connect").isEnabled()).toBe(true);
    await context.close();
  });
  test("inside a sandbox every menu link stays in it, and the old pages at the root go home", async () => {
    const context = await newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true });
    const page = await context.newPage();
    const base = await enterSandbox(page);
    for (const path of [`${base}/`, `${base}/build`, `${base}/servers`, `${base}/tours`, `${base}/explore`, `${base}/activity`, `${base}/connect`]) {
      await page.goto(`${ORIGIN}${path}`);
      const hrefs = await page.locator("nav.pages a, nav.subpages a, a.path").evaluateAll(as => as.map(a => a.getAttribute("href")));
      expect(hrefs.every(h => h!.startsWith(`${base}/`))).toBe(true);
      expect(hrefs).toContain(`${base}/llms.txt`);
      expect(await page.locator("a.mark").getAttribute("href")).toBe("/");
    }
    await page.goto(`${ORIGIN}${base}/build`);
    await page.locator("#endpoints").getByText(`${ORIGIN}${base}/fhir`, { exact: true }).waitFor();
    await page.goto(`${ORIGIN}/`);
    expect(await page.locator("a", { hasText: "For agents" }).getAttribute("href")).toBe("/llms.txt");
    await context.close();
  });
  test("an app registered on /connect shows what its developer needs", async () => {
    const context = await newContext({ viewport: { width: 390, height: 844 }, ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await signIn(page, "josh");
    const base = new URL(page.url()).pathname.replace(/\/$/, "");
    await page.goto(`${ORIGIN}${base}/connect`);
    await page.getByLabel("App name").fill("My test app");
    await page.getByLabel("Redirect URI").fill("https://app.example/callback");
    await page.getByRole("button", { name: "Register" }).click();
    await page.getByRole("heading", { name: "My test app" }).waitFor();
    await page.getByText(`${ORIGIN}${base}/fhir`).first().waitFor();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    await shot(page, "connect");
    await page.reload();
    await page.getByRole("heading", { name: "My test app" }).waitFor();
    await page.getByRole("button", { name: "Remove My test app" }).click();
    await page.getByText("None yet.").waitFor();
    await context.close();
  });
  test("unticking one study approves the rest of that site", async () => {
    const context = await newContext({ viewport: { width: 390, height: 844 }, ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await enterSandbox(page);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator("input[name=username][value=josh]").check();
    await page.getByRole("button", { name: "Continue" }).click();
    const row = page.locator(".site-row", { hasText: "Riverside Hospital" });
    await row.locator("summary").click();
    await row.getByRole("checkbox", { name: /CT ABDOMEN/ }).uncheck();
    await shot(page, "consent-studies");
    await page.getByRole("button", { name: "Approve" }).click();
    await page.locator("#app").waitFor({ state: "visible" });
    await page.locator(".study-button").first().waitFor();
    expect(await page.locator(".study-button").count()).toBe(5);
    expect(await page.locator(".study-button", { hasText: "CT ABDOMEN" }).count()).toBe(0);
    await context.close();
  });
  test("a sandbox can be named, shared, joined, and left without ending it", async () => {
    const owner = await newContext({ viewport: { width: 390, height: 844 }, ignoreHTTPSErrors: true });
    const page = await owner.newPage();
    page.on("dialog", d => d.accept("Team demo"));
    const base = await enterSandbox(page);
    await page.getByRole("button", { name: "Rename" }).click();
    await page.locator("#sandbox-name", { hasText: "Team demo" }).waitFor();
    await page.getByRole("button", { name: "Share" }).click();
    const link = await page.locator("#share-link").inputValue();
    expect(link).toBe(`${ORIGIN}${base}/`);
    await page.locator("#share-note", { hasText: "Anyone with" }).waitFor();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    await shot(page, "sandbox-share");
    const guest = await newContext({ viewport: { width: 390, height: 844 }, ignoreHTTPSErrors: true });
    const other = await guest.newPage();
    await other.goto(link);
    await other.getByText("Join “Team demo”?").waitFor();
    await other.getByRole("button", { name: "Join this sandbox" }).click();
    await other.getByRole("button", { name: "Leave" }).click();
    await other.waitForURL(u => u.pathname === "/");
    await other.getByText("You don't have any yet.").waitFor();
    await page.reload();
    await page.locator("#sandbox-name", { hasText: "Team demo" }).waitFor();
    await guest.close(); await owner.close();
  });
  test("a sandbox set to unified imaging still works end to end", async () => {
    const context = await newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await signIn(page, "josh");
    const base = new URL(page.url()).pathname.replace(/\/$/, "");
    await page.locator(".study-button").first().waitFor();
    await page.evaluate(async b => { await fetch(`${b}/api/sandbox`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ topology: "unified" }) }); }, base);
    await page.evaluate(() => sessionStorage.clear());
    await page.goto(`${ORIGIN}${base}/`);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator("input[name=username][value=josh]").check();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Approve" }).click();
    await page.locator(".study-button").nth(5).waitFor();
    await page.locator("[data-stage=discover] .fact", { hasText: "this server" }).waitFor();
    await page.locator("#stage-note:empty").waitFor({ state: "attached", timeout: 15000 });
    await context.close();
  });
  test.skipIf(!!process.env.BASE_URL)("a backend service registered on /connect works in the viewer with no sign-in", async () => {
    const context = await newContext({ viewport: { width: 390, height: 844 }, ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await signIn(page, "josh");
    const base = new URL(page.url()).pathname.replace(/\/$/, "");
    await page.goto(`${ORIGIN}${base}/connect`);
    await page.getByLabel("App name").fill("Referral service");
    await page.getByRole("radio", { name: /Backend service/ }).check();
    await page.getByRole("button", { name: "Register" }).click();
    await page.getByRole("heading", { name: "Referral service" }).waitFor();
    await shot(page, "connect-backend");
    await page.getByRole("button", { name: "Try it in the viewer" }).click();
    await page.getByText("Backend service: no one signed in").waitFor();
    await page.locator(".study-button").nth(5).waitFor();
    await page.locator("[data-stage=authorize]", { hasText: "signed assertion" }).waitFor();
    expect(await page.locator("[data-stage=clinical]").count()).toBe(0);
    await page.locator("#stage-note:empty").waitFor({ state: "attached", timeout: 15000 });
    await shot(page, "backend-viewer");
    await context.close();
  });
  test.skipIf(!!process.env.BASE_URL)("a confidential app registered on /connect signs in and proves its key", async () => {
    const context = await newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await signIn(page, "josh");
    const base = new URL(page.url()).pathname.replace(/\/$/, "");
    await page.goto(`${ORIGIN}${base}/connect`);
    await page.getByLabel("App name").fill("Confidential one");
    await page.getByRole("radio", { name: /Confidential app/ }).check();
    await page.getByLabel("Redirect URI").fill(`${ORIGIN}${base}/`);
    await page.getByRole("button", { name: "Register" }).click();
    await page.getByRole("button", { name: "Try it in the viewer" }).click();
    await page.locator("input[name=username][value=josh]").check();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Approve" }).click();
    await page.locator(".study-button").nth(5).waitFor();
    await page.locator("#stage-note:empty").waitFor({ state: "attached", timeout: 15000 });
    await context.close();
  });
  test("passing through on the way to sign-in shows one steady state", async () => {
    const context = await newContext({ viewport: { width: 390, height: 844 }, ignoreHTTPSErrors: true });
    const page = await context.newPage();
    const base = await enterSandbox(page);
    await page.route("**/.well-known/smart-configuration", async route => { await new Promise(r => setTimeout(r, 700)); await route.continue(); });
    await page.goto(`${ORIGIN}${base}/?connect=1`, { waitUntil: "commit" });
    await page.locator("#connecting").waitFor({ state: "visible" });
    expect(await page.locator("#landing").isVisible()).toBe(false);
    await page.locator("input[name=username]").first().waitFor();
    await context.close();
  });
  test("a server that can't be reached brings the landing page back with the error", async () => {
    const context = await newContext({ viewport: { width: 390, height: 844 }, ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await enterSandbox(page);
    await page.route("**/.well-known/smart-configuration", route => route.abort());
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator("#connect-error").waitFor({ state: "visible" });
    expect(await page.locator("#landing").isVisible()).toBe(true);
    await context.close();
  });
  test("a browser that saved its sandbox under an old key still lists it", async () => {
    const context = await newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true });
    const page = await context.newPage();
    const base = await enterSandbox(page);
    await page.evaluate(b => { localStorage.clear(); localStorage.setItem("smart-imaging-client:world", b); }, base);
    await page.goto(`${ORIGIN}/`);
    await page.locator(`.sandbox-list a[href="${base}/"]`).waitFor();
    expect(await page.evaluate(() => localStorage.getItem("smart-imaging-client:world"))).toBeNull();
    await context.close();
  });
  test("a patient with no studies gets a real empty result", async () => {
    const context = await newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await signIn(page, "robin");
    await page.getByText("This patient has no studies this app can see.").waitFor();
    await page.locator("#c-Condition .none", { hasText: "None active." }).waitFor();
    await context.close();
  });
  test("on a phone, the picture is on the first screen", async () => {
    const context = await newContext({ viewport: { width: 390, height: 844 }, ignoreHTTPSErrors: true, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    const page = await context.newPage();
    await signIn(page, "sam-caregiver");
    await page.locator("#stage-note:empty").waitFor({ state: "attached", timeout: 15000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    const stage = (await page.locator("#stage").boundingBox())!;
    expect(stage.y).toBeLessThan(160);
    expect(stage.y + stage.height).toBeLessThan(844);
    // Two fingers: the zoom follows their spread, and the point between them stays put.
    const touch = (type: string, id: number, x: number, y: number) => page.evaluate(([t, i, cx, cy]) => {
      document.querySelector("#stage")!.dispatchEvent(new PointerEvent(t as string, { pointerId: i as number, pointerType: "touch", clientX: cx as number, clientY: cy as number, bubbles: true }));
    }, [type, id, x, y] as const);
    const cx = stage.x + stage.width / 2, cy = stage.y + stage.height / 2;
    await touch("pointerdown", 11, cx - 40, cy); await touch("pointerdown", 12, cx + 40, cy);
    await touch("pointermove", 11, cx - 80, cy); await touch("pointermove", 12, cx + 80, cy);
    await page.locator("#overlay", { hasText: "Zoom 200%" }).waitFor();
    await touch("pointermove", 11, cx - 50, cy + 30); await touch("pointermove", 12, cx + 110, cy + 30);
    const moved = await page.evaluate(() => { const v = (0, eval)("viewer").state(); return [v.panX, v.panY]; });
    expect(moved[0]).toBeGreaterThan(0); expect(moved[1]).toBeGreaterThan(0);
    await touch("pointerup", 11, cx - 50, cy + 30); await touch("pointerup", 12, cx + 110, cy + 30);
    // One finger then pans, after choosing the Pan tool.
    await page.getByRole("button", { name: "Pan", exact: true }).click();
    await touch("pointerdown", 13, cx, cy); await touch("pointermove", 13, cx + 20, cy);
    const after = await page.evaluate(() => (0, eval)("viewer").state().panX);
    expect(after).toBeGreaterThan(moved[0]!);
    await touch("pointerup", 13, cx + 20, cy);
    await shot(page, "phone-390");
    await context.close();
  });
  test("fits a narrow phone with large text", async () => {
    const context = await newContext({ viewport: { width: 320, height: 640 }, ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/`);
    await page.addStyleTag({ content: "html{font-size:150%}" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    await shot(page, "phone-landing");
    await signIn(page, "sam-caregiver");
    await page.addStyleTag({ content: "html{font-size:150%}" });
    await page.locator("#stage-note:empty").waitFor({ state: "attached", timeout: 15000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    await shot(page, "phone-app");
    await context.close();
  });
});
