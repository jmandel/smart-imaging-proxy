// The app check, in a real browser: a run started on its page, the banner on the sandbox's pages, our own viewer
// as the app under test, signed in as josh through every staged condition and graded with every requirement met;
// then an app driven by fetch that ignores next links and builds its own addresses, graded so. SHOTS saves the page.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { createDemoServer } from "../src/demo-server";
import { registerClients } from "../src/flows";
import { CONFIG, PORTS } from "../src/config";
import { addClient } from "../src/clients";
import { startStack, type Stack } from "../src/stack";
import type { Sandbox } from "../src/sandbox";
import { fetchApp } from "../tests/app-check-client";

setDefaultTimeout(180000);
const ORIGIN = CONFIG.demoUrl, SHOTS = process.env.SHOTS;
let stack: Stack, server: ReturnType<typeof Bun.serve>, browser: Browser;
beforeAll(async () => {
  const root = join(import.meta.dir, "..");
  stack = await startStack(root);
  server = Bun.serve({ port: PORTS.demo, hostname: "127.0.0.1", ...createDemoServer(stack, registerClients(stack), root) });
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium", headless: true });
});
afterAll(async () => { await browser?.close(); server?.stop(true); stack?.stop(); });

/** A sandbox with an app our viewer can sign in as, and the test's own redirect too. */
function sandboxWithApp(): { w: Sandbox; id: string } {
  const w = stack.sandboxes.mint({ saved: true });
  const c = addClient(w.store, { name: "Test viewer", redirectUris: [`${new URL(ORIGIN).origin}/viewer`, w.urls.callback] });
  if ("error" in c) throw new Error(c.error);
  return { w, id: c.id };
}
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
async function shots(page: Page, name: string) {
  if (!SHOTS) return;
  for (const [label, width, big] of [["desktop", 1280, false], ["phone", 390, false], ["phone-150", 390, true]] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.addStyleTag({ content: big ? "html{font-size:150%}" : "html{font-size:100%}" });
    await page.waitForTimeout(150);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `${SHOTS}/app-check-${name}-${label}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addStyleTag({ content: "html{font-size:100%}" });
}
/** Starts a run on the App check page for the app, with every condition, and gives the page. */
async function startRun(page: Page, base: string, client: string) {
  await page.goto(`${ORIGIN}${base}/app-check`);
  await page.locator("label.server", { hasText: client }).locator("input").check();
  await shots(page, "setup");
  await page.locator("#start-run").click();
  await page.locator("#end-run").waitFor();
  await page.locator("#app-check-banner").waitFor();
  return page;
}

describe("the app check", () => {
  test("our viewer, signed in as josh through every staged condition, meets every requirement", async () => {
    const { w, id } = sandboxWithApp();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    context.setDefaultTimeout(30000);
    const problems: string[] = [];
    const check = await context.newPage();
    check.on("pageerror", e => problems.push(e.message));
    await startRun(check, w.prefix, id);
    expect(await check.locator("#app-check-banner").innerText()).toContain("Search pages hold at most 2 studies");
    await shots(check, "running");
    // Build an App's Try it step links here, and opens our viewer as the app.
    // This browser knows the sandbox, as one that made it would.
    await context.addInitScript(base => { if (!localStorage.getItem("smart-imaging-client:sandboxes")) localStorage.setItem("smart-imaging-client:sandboxes", JSON.stringify([{ base, joined: true }])); }, w.prefix);
    const viewer = await context.newPage();
    viewer.on("pageerror", e => problems.push(e.message));
    await viewer.goto(`${ORIGIN}${w.prefix}/`);
    await viewer.locator("#app-check-banner").waitFor();
    await viewer.goto(`${ORIGIN}/build-an-app?step=try&app=${id}`);
    expect(await viewer.getByRole("link", { name: "Check Test viewer" }).getAttribute("href")).toBe(`${w.prefix}/app-check?app=${id}`);
    const [tab] = await Promise.all([context.waitForEvent("page"), viewer.getByRole("button", { name: "Try it in our viewer" }).click()]);
    await tab.waitForURL(/\/authorize/);
    await tab.locator("input[name=username][value=josh]").check();
    await tab.getByRole("button", { name: "Continue" }).click();
    await tab.getByRole("button", { name: "Approve" }).click();
    await viewer.locator("#app").waitFor();
    // Six studies, on three pages of two; open each, waiting out its staged 503.
    await viewer.locator(".study-button").nth(5).waitFor();
    for (let i = 0; i < 6; i++) {
      await viewer.locator(`.study-button[data-i="${i}"]`).click();
      await viewer.locator(`.study-button[data-i="${i}"][aria-pressed=true]`).waitFor();
      await viewer.locator("#stage-note:empty").waitFor({ state: "attached", timeout: 30000 });
    }
    await check.bringToFront();
    await check.locator("#end-run").click();
    await check.locator("#requirements").waitFor();
    const states = await check.locator(".check-step").evaluateAll(els => els.map(e => `${e.querySelector(".what b")!.textContent}: ${e.getAttribute("data-state")}`));
    expect(states).toEqual([
      "Signed in as josh for josh-example: pass", "Approved everything offered: pass", "Searched for josh-example's studies: pass", "Found every study the server released: pass", "Opened every study it found: pass",
      "Each retrieval sends the token of the search that gave its address: pass", "Each retrieval uses its study's Endpoint.address as given: pass", "Endpoints in every form are resolved: pass", "Each retrieval sends an Accept header: pass",
    ]);
    expect(await check.locator("#check-summary").innerText()).toBe("All 4 requirements checked were met. The app did what the script asked.");
    // Ended, the sandbox is back as it was, and says so on every page.
    expect(w.faults()).toEqual({ decisionOutage: false, truncateAfter: null, pageSize: null, searchRetryAfter: null, retrievalRetryAfter: null, endpointForms: false });
    await check.locator("#app-check-banner").waitFor({ state: "detached" });
    await shots(check, "passed");
    expect(problems).toEqual([]);
    await context.close();
  });

  test("an app that ignores next links and builds its own addresses is graded so, with notes", async () => {
    const { w, id } = sandboxWithApp();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    context.setDefaultTimeout(20000);
    const page = await startRun(await context.newPage(), w.prefix, id);
    await fetchApp(w.urls, id, "josh", undefined, { followNext: false, buildUrl: true });
    await page.locator("#end-run").click();
    await page.locator("#requirements").waitFor();
    const step = (title: string) => page.locator(".check-step", { hasText: title });
    expect(await step("Found every study").getAttribute("data-state")).toBe("fail");
    expect(await step("Found every study").innerText()).toContain("Found 2 of the 6 studies the server released.");
    expect(await step("Endpoint.address as given").getAttribute("data-state")).toBe("fail");
    // A failed requirement opens on its source and the requests behind it, which link to the log in a new tab.
    const failed = step("Endpoint.address as given");
    expect(await failed.locator(".app-check-sources a").first().getAttribute("href")).toBe("https://build.fhir.org/ig/argonautproject/smart-imaging/specification.html#retrieving-images");
    expect(await failed.locator(".app-check-request a").first().getAttribute("target")).toBe("_blank");
    expect(await page.locator("#notes li b").allInnerTexts()).toContain("Relied on one page of results");
    expect(await page.locator("#check-summary").innerText()).toContain("The app stopped short of the script: found 2 of the 6 studies");
    await shots(page, "failed");
    await context.close();
  });
});
