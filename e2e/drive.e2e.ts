// What llms.txt promises an agent driving the site in a browser: every control in its table is found by role and
// accessible name, once, in the state the table names; `html[data-ready]` comes and goes with a page's content;
// and each page's HTML says what it is, and where llms.txt is, to anything that reads it without a script.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { createDemoServer } from "../src/demo-server";
import { registerClients } from "../src/flows";
import { CONFIG, PORTS } from "../src/config";
import { startStack, type Stack } from "../src/stack";
import { CONTROLS, type Where } from "../ui/drive";

setDefaultTimeout(120000);
const root = join(import.meta.dir, "..");
const DEMO = CONFIG.demoUrl;
let stack: Stack, server: ReturnType<typeof Bun.serve>, browser: Browser, context: BrowserContext;

beforeAll(async () => {
  stack = await startStack(root);
  server = Bun.serve({ port: PORTS.demo, hostname: "127.0.0.1", ...createDemoServer(stack, registerClients(stack), root) });
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium", headless: true });
});
afterAll(async () => { await context?.close(); await browser?.close(); server?.stop(true); stack?.stop(); });

/** Opens `path` and waits for its content. */
async function open(page: Page, path: string) {
  await page.goto(path.startsWith("http") ? path : `${DEMO}${path}`);
  await page.locator("html[data-ready]").waitFor();
}

test("every control in llms.txt's table is found by its role and name", async () => {
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  context.setDefaultTimeout(15000);
  const page = await context.newPage();
  const seen = new Set<Where>();
  const fill: Record<string, string> = { app: "Drive test app", person: "Josh Example", first: "Sam" };
  /** Each control listed for `where` is on the page, exactly once. */
  async function expectControls(p: Page, where: Where) {
    seen.add(where);
    for (const c of CONTROLS.filter(x => x.where === where)) {
      const name = c.name.replace(/\{(\w+)\}/g, (_, k: string) => fill[k] ?? `{${k}}`);
      const found = p.getByRole(c.role as Parameters<Page["getByRole"]>[0], { name, exact: true });
      await found.first().waitFor().catch(() => {});
      expect({ where, role: c.role, name, count: await found.count() }).toEqual({ where, role: c.role, name, count: 1 });
    }
  }

  await open(page, "/sandboxes");
  await expectControls(page, "sandboxes");
  await page.getByRole("button", { name: "Create a sandbox", exact: true }).click();
  await page.waitForURL(u => u.pathname.startsWith("/s/"));
  await page.locator("html[data-ready]").waitFor();
  const base = new URL(page.url()).pathname.replace(/\/$/, "");
  fill.sandbox = (await page.locator("#sandbox-name").textContent())!;

  await open(page, `${base}/explore`);
  await expectControls(page, "explore");
  await expectControls(page, "view-link");

  await open(page, `${base}/connect`);
  await expectControls(page, "register");
  await page.getByRole("textbox", { name: "App name", exact: true }).fill(fill.app!);
  await page.getByRole("textbox", { name: "Redirect URIs", exact: true }).fill("https://app.example/callback");
  await page.getByRole("button", { name: "Register", exact: true }).click();
  await page.waitForURL(u => u.searchParams.has("app"));
  const app = new URL(page.url()).searchParams.get("app")!;
  await expectControls(page, "registered");

  await open(page, "/build-an-app?step=sandbox");
  await expectControls(page, "wizard");
  await open(page, "/servers?add");
  await expectControls(page, "servers-form");

  await open(page, `${base}/app-check?app=${encodeURIComponent(app)}`);
  await expectControls(page, "app-check-setup");
  await page.getByRole("button", { name: "Start the run", exact: true }).click();
  await page.waitForURL(u => u.searchParams.has("run"));
  await page.locator("html[data-ready]").waitFor();
  await expectControls(page, "app-check-run");
  await page.getByRole("button", { name: "Abandon", exact: true }).click();

  // The server check runs on its own as far as the sign-in, and stops there for a person.
  await open(page, `/check?sandbox=${encodeURIComponent(base)}`);
  await page.getByRole("button", { name: "Sign in to continue", exact: true }).waitFor({ timeout: 60000 });
  await expectControls(page, "server-check");

  // The viewer, from its link: the server it names, then with `connect`, a sign-in in the same tab, and back.
  await open(page, `/viewer?sandbox=${encodeURIComponent(base)}`);
  await expectControls(page, "viewer");
  await page.goto(`${DEMO}/viewer?sandbox=${encodeURIComponent(base)}&connect`);
  await page.waitForURL(u => u.pathname.endsWith("/authorize"));
  await expectControls(page, "sign-in");
  await page.getByRole("radio", { name: "Josh Example", exact: true }).check();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Approve", exact: true }).waitFor();
  await expectControls(page, "consent");
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await page.waitForURL(u => u.pathname === "/viewer");
  await page.locator("html[data-ready]").waitFor();
  await page.locator("#studies .study-button").first().waitFor();

  // A control added to the table must be reached here too.
  expect([...new Set(CONTROLS.map(c => c.where))].filter(w => !seen.has(w))).toEqual([]);
});

test("data-ready leaves while a new view loads, and comes back with it", async () => {
  const c = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  c.setDefaultTimeout(15000);
  const page = await c.newPage();
  const r = await (await fetch(`${DEMO}/api/sandboxes`, { method: "POST" })).json();
  await open(page, `${r.base}/explore?user=josh`);
  // Watched from inside the page, so a moment too short for a poll still counts.
  await page.evaluate(() => {
    (window as any).__left = false;
    new MutationObserver(() => { if (!document.documentElement.dataset.ready) (window as any).__left = true; }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-ready"] });
  });
  await page.getByRole("button", { name: "Sam", exact: true }).click();
  await page.waitForURL(u => u.searchParams.get("user") === "sam-caregiver");
  await page.locator("html[data-ready]").waitFor();
  expect(await page.evaluate(() => (window as any).__left)).toBe(true);
  expect(await page.locator("#headline").textContent()).toContain("Sam");
  // Back returns to the view the address names.
  await page.goBack();
  await page.waitForURL(u => u.searchParams.get("user") === "josh");
  await page.locator("html[data-ready]").waitFor();
  expect(await page.locator("button[data-user=josh]").getAttribute("aria-pressed")).toBe("true");
  await c.close();
});

test("each page's HTML names it, links llms.txt, and says what to do without a script", async () => {
  const r = await (await fetch(`${DEMO}/api/sandboxes`, { method: "POST" })).json();
  const html = await (await fetch(`${DEMO}${r.base}/activity`)).text();
  expect(html).toContain("<title>Logs · SMART Imaging</title>");
  expect(html).toContain('<meta name="description" content="Every request, and why each was allowed or refused.">');
  expect(html).toContain(`<link rel="help" href="${r.base}/llms.txt"`);
  expect(html).toMatch(/<noscript>.*this sandbox's llms\.txt.*html\[data-ready\].*<\/noscript>/s);
  const site = await fetch(`${DEMO}/servers`);
  expect(await site.text()).toContain('<link rel="help" href="/llms.txt"');
  // A reload of an unchanged page can be answered from the browser's copy.
  expect((await fetch(`${DEMO}/servers`, { headers: { "if-none-match": site.headers.get("etag")! } })).status).toBe(304);
});
