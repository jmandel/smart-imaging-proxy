// What only a real browser shows: focus, overflow, contrast, popups, thumbnails decoded in the page,
// and what the pages draw from real responses. Run with `bun run test:ui`. It starts its own stack in
// memory, reads the shared archive, and loads viewer-kit from its pinned download.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { BackendError } from "@smart-imaging-proxy/core";
import { createDemoServer } from "../src/demo-server";
import { registerClients } from "../src/flows";
import { CONFIG, PORTS } from "../src/config";
import { startStack, type Stack } from "../src/stack";

setDefaultTimeout(120000);
const root = join(import.meta.dir, "..");
const DEMO = CONFIG.demoUrl;
const DESKTOP = { width: 1440, height: 900 }, PHONE = { width: 390, height: 844 };
const SHEETS = { ct: "ct-abdomen-pelvis-2012", xr: "xr-wrist-left-2012", slide: "slide-lung-2023", mri: "mri-brain-2020" };

let stack: Stack, server: ReturnType<typeof Bun.serve>, browser: Browser, context: BrowserContext | undefined;
const problems: string[] = [];

beforeAll(async () => {
  stack = await startStack(root);
  server = Bun.serve({ port: PORTS.demo, hostname: "127.0.0.1", fetch: createDemoServer(stack, registerClients(stack), root).fetch });
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium", headless: true });
});
afterAll(async () => { await browser?.close(); server?.stop(true); stack?.stop(); });
beforeEach(async () => { problems.length = 0; await stack.resetAll(); });
afterEach(async () => { await context?.close(); context = undefined; });

async function open(path: string, opts: { viewport?: typeof DESKTOP; colorScheme?: "light" | "dark" } = {}): Promise<Page> {
  context = await browser.newContext({ viewport: opts.viewport ?? DESKTOP, colorScheme: opts.colorScheme ?? "light" });
  context.on("page", watch);
  const page = await context.newPage();
  await page.goto(path.startsWith("http") ? path : `${DEMO}${path}`);
  return page;
}
function watch(page: Page) {
  page.on("pageerror", e => problems.push(`${page.url()}: ${e.message}`));
  // A 404, or a 403 the protocol calls for, such as a service's refused search, is the browser logging an answer the page expects.
  page.on("console", m => { if (m.type() === "error" && !/status of 40[34]/.test(m.text())) problems.push(`${page.url()}: ${m.text()}`); });
}
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
const signIn = async (popup: Page, user: string, decision: "Approve" | "Deny" = "Approve") => {
  await popup.locator(`input[name=username][value=${user}]`).check();
  await popup.getByRole("button", { name: "Continue" }).click();
  await popup.getByRole("button", { name: decision }).click();
};
/** Does what starts a new Explore view, and waits until the view it started has loaded. */
async function settle(page: Page, act: () => Promise<unknown>) {
  await Promise.all([page.waitForResponse(r => new URL(r.url()).pathname.endsWith("/api/sandbox/explore/view")), act()]);
  await page.waitForFunction(() => { const h = document.querySelector("#view .headline h1"); return !!h && !h.querySelector(".spinner"); });
}
/** Waits for the view Explore opens on, Josh's, to load. */
const loaded = (page: Page) => page.waitForFunction(() => { const h = document.querySelector("#view .headline h1"); return !!h && !h.querySelector(".spinner") && !document.querySelector("#who button:disabled"); });
/** Picks someone the way a person on this screen would: the list on a desktop, the select on a phone. */
async function pick(page: Page, id: string, kind: "user" | "client" = "user") {
  await loaded(page);
  if (await page.locator("#who-select").isVisible()) await settle(page, () => page.locator("#who-select").selectOption(`${kind}:${id}`));
  else await settle(page, () => page.locator(`[data-${kind}="${id}"]`).click());
}
/** A drawn thumbnail's pixels vary: it isn't blank. */
const variance = (page: Page, study: string) => page.locator(`.thumb[data-study="${study}"][data-state=drawn] canvas`).first().evaluate((c: HTMLCanvasElement) => {
  const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
  let n = 0, sum = 0, sq = 0;
  for (let i = 0; i < d.length; i += 4) { const v = (d[i]! + d[i + 1]! + d[i + 2]!) / 3; n++; sum += v; sq += v * v; }
  return sq / n - (sum / n) ** 2;
});
const drawn = (page: Page, study: string) => page.locator(`.thumb[data-study="${study}"][data-state=drawn]`).first().waitFor({ timeout: 60000 });

/** WCAG contrast of an element's text on its nearest painted background. */
const contrast = (page: Page, selector: string) => page.locator(selector).first().evaluate(el => {
  const rgb = (c: string) => c.match(/[\d.]+/g)!.map(Number);
  const lum = ([r, g, b]: number[]) => { const f = (v: number) => { const s = v / 255; return s <= .03928 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4; }; return .2126 * f(r!) + .7152 * f(g!) + .0722 * f(b!); };
  let bgEl: Element | null = el;
  while (bgEl && (rgb(getComputedStyle(bgEl).backgroundColor)[3] === 0 || getComputedStyle(bgEl).backgroundColor === "transparent" || getComputedStyle(bgEl).backgroundImage !== "none")) bgEl = bgEl.parentElement;
  const a = lum(rgb(getComputedStyle(el).color)), b = lum(rgb(getComputedStyle(bgEl ?? document.body).backgroundColor));
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
});

describe("every page, on desktop and phone, in light and dark", () => {
  for (const [name, viewport] of [["desktop", DESKTOP], ["phone", PHONE]] as const) for (const colorScheme of ["light", "dark"] as const) {
    test(`${name} ${colorScheme}: no script or console errors, no sideways scrolling, and the header holds the menu and the settings`, async () => {
      for (const path of ["/", "/explore", "/activity", CONFIG.traceUrl, `${CONFIG.authUrl}/account`]) {
        const page = await open(path, { viewport, colorScheme });
        await page.waitForLoadState("networkidle");
        expect([path, await overflow(page)]).toEqual([path, 0]);
        if (!path.startsWith("http") && path !== "/") {
          expect(await page.locator(".pages a").allInnerTexts()).toEqual(["Overview", "Build a client", "Test your server", "For agents"]);
          expect(await page.locator(".subpages a").allInnerTexts()).toEqual(["Start here", "Register an app", "Tours", "Explore", "Activity"]);
          const box = await page.locator("#settings-button").boundingBox();
          expect(box!.y).toBeLessThan(60);
          expect(box!.height).toBeGreaterThanOrEqual(44);
        }
        await context!.close(); context = undefined;
      }
      expect(problems).toEqual([]);
    });
    test(`${name} ${colorScheme}: the story cards' small diagram text keeps its contrast on the film`, async () => {
      const page = await open("/tours", { viewport, colorScheme });
      await page.locator(".story .layers").first().waitFor();
      for (const sel of [".story .ly-site", ".story .ly-count", ".story .ly-box.off", ".story .ly-row.choice .ly-box.on", ".story .ly-row.outcome .ly-box.on", ".story .ly-box.linked", ".key .ly-row.outcome .ly-box", ".key .ly-legend p"]) {
        expect([sel, (await contrast(page, sel)) >= 4.5]).toEqual([sel, true]);
      }
      // A study in the result looks the same on the dark cards, in their key, and on a light page.
      const fill = (sel: string) => page.locator(sel).first().evaluate(el => getComputedStyle(el).backgroundColor);
      const onCard = await fill(".story .ly-row.outcome .ly-box.on");
      expect(await fill(".key .ly-row.outcome .ly-box")).toBe(onCard);
      await page.goto(`${DEMO}/explore`);
      await pick(page, "josh");
      expect(await fill(".why .ly-row.outcome .ly-box.on")).toBe(onCard);
      expect(await contrast(page, ".why .ly-row.outcome .ly-box.on")).toBeGreaterThanOrEqual(4.5);
      expect(problems).toEqual([]);
    });
    test(`${name} ${colorScheme}: Explore's text keeps its contrast, on the box, the chain and the film`, async () => {
      const page = await open("/explore", { viewport, colorScheme });
      await pick(page, "josh");
      for (const sel of [".headline h1", ".why .ly-name", ".why .ly-row.choice .ly-box.on", ".why .ly-row.outcome .ly-box.on", ".why .ly-legend p", ".sheet .title", ".sheet .site", ".sheet .date", ".sheet .status", ".actions .log-link"]) {
        expect([sel, (await contrast(page, sel)) >= 4.5]).toEqual([sel, true]);
      }
      expect(await overflow(page)).toBe(0);
      expect(problems).toEqual([]);
    });
  }
});

describe("Explore", () => {
  for (const [name, viewport] of [["desktop", DESKTOP], ["phone", PHONE]] as const) {
    test(`${name}: an opened study shows its images in the viewer, a series at a time, through this session`, async () => {
      const page = await open("/explore", { viewport });
      await pick(page, "josh");
      const asked: string[] = [];
      page.on("request", r => { const u = new URL(r.url()); if (u.pathname.includes("/instances/") && u.searchParams.size === 0 && r.headers()["authorization"]) asked.push(u.pathname.split("/").at(-1)!); });
      await page.locator(`[data-open="${SHEETS.mri}"]`).click();
      const stage = page.locator(".explore-viewer [data-v=stage]");
      await page.locator(".explore-viewer [data-v=note]:empty").waitFor({ state: "attached", timeout: 30000 });
      await page.locator(".explore-viewer [data-v=slider]:enabled").waitFor();
      // How much of the canvas isn't black, read through a screenshot, since a WebGL canvas can't be read back afterwards.
      const png = (await page.locator(".explore-viewer [data-v=canvas]").screenshot()).toString("base64");
      const lit = await page.evaluate(async b64 => {
        const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
        const c = new OffscreenCanvas(img.width, img.height), x = c.getContext("2d")!;
        x.drawImage(img, 0, 0);
        const d = x.getImageData(0, 0, img.width, img.height).data;
        let on = 0; for (let i = 0; i < d.length; i += 4) if (d[i]! > 24 || d[i + 1]! > 24 || d[i + 2]! > 24) on++;
        return on / (d.length / 4);
      }, png);
      expect(lit).toBeGreaterThan(0.05);
      const count = await page.locator(".explore-viewer [data-v=count]").innerText();
      await stage.focus(); await page.keyboard.press("ArrowDown");
      await page.waitForFunction(was => document.querySelector(".explore-viewer [data-v=count]")!.textContent !== was, count);
      expect(await page.locator(".explore-viewer [data-v=series] button").count()).toBeGreaterThan(5);
      await page.locator(".explore-viewer [data-v=series] button").nth(2).click();
      await page.locator(".explore-viewer [data-v=series] button[aria-pressed=true]").nth(0).waitFor();
      await page.locator(".explore-viewer [data-v=note]:empty").waitFor({ state: "attached", timeout: 30000 });
      expect(asked.length).toBeGreaterThan(2);
      // A re-render, from the chain line arriving, leaves the viewer where it was.
      await page.locator("#chain a").waitFor();
      expect(await page.locator(".explore-viewer [data-v=note]").innerText()).toBe("");
      await page.getByRole("button", { name: /^Back to/ }).click();
      expect(await page.locator(".explore-viewer").count()).toBe(0);
      expect(problems).toEqual([]);
    });
    test(`${name}: Josh's CT, X-ray and slide thumbnails are drawn from real pixels, decoded in the page`, async () => {
      const page = await open("/explore", { viewport });
      await pick(page, "josh");
      expect(await page.locator(".sheet").count()).toBe(6);
      for (const study of [SHEETS.ct, SHEETS.xr, SHEETS.slide]) {
        await page.locator(`.thumb[data-study="${study}"]`).scrollIntoViewIfNeeded();
        await drawn(page, study);
        expect([study, await variance(page, study)]).toEqual([study, expect.any(Number)]);
        expect([study, (await variance(page, study)) > 50]).toEqual([study, true]);
      }
      // The slide is in colour, not grey.
      const colour = await page.locator(`.thumb[data-study="${SHEETS.slide}"] canvas`).evaluate((c: HTMLCanvasElement) => {
        const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
        let spread = 0;
        for (let i = 0; i < d.length; i += 4) spread = Math.max(spread, Math.abs(d[i]! - d[i + 2]!));
        return spread;
      });
      expect(colour).toBeGreaterThan(40);
      expect(await overflow(page)).toBe(0);
      expect(problems).toEqual([]);
    });
  }
  test("a withheld study's sheet makes no request, and shows why it's withheld", async () => {
    stack.store.setDocument({ shares: [{ from: "user:josh", with: "user:sam-caregiver", patient: "patient:josh-example", sites: ["Lakeside Imaging", "Riverside Hospital"], label: "caregiver" }] });
    const page = await open("/explore");
    const asked: string[] = [];
    // Each image the page retrieves, by the study UID in its WADO-RS address, named by study once the view says which is which.
    page.on("request", r => { const m = new URL(r.url()).pathname.match(/\/studies\/([^/]+)\/series\/[^/]+\/instances\//); if (m) asked.push(m[1]!); });
    const named = async () => { const ids = await page.evaluate(() => Object.fromEntries(Object.values((0, eval)("view").studies).map((s: any) => [s.uid, s.id]))); return asked.map(u => ids[u] ?? u); };
    await pick(page, "sam-caregiver");
    await settle(page, () => page.locator("[data-whose=josh-example]").click());
    // Sam hasn't approved the app for Josh's records yet: the view's one next step is to.
    await page.locator(".empty").getByRole("button", { name: "Change what Health Records App can see" }).click();
    await page.locator("#action-form input[value='Riverside Hospital']").uncheck();
    // The previous view's thumbnails finish first: one still queued would be fetched after this, and counted here.
    await page.waitForFunction(() => !document.querySelector(".thumb[data-state=loading]"));
    asked.length = 0;
    await settle(page, () => page.getByRole("button", { name: "Approve", exact: true }).click());
    await page.locator(".sheet.withheld").first().waitFor();
    await drawn(page, SHEETS.mri);
    await page.waitForLoadState("networkidle");
    const withheld = await page.locator(".sheet.withheld .title").allInnerTexts();
    expect(withheld.length).toBe(4);
    expect(await page.locator(".sheet.withheld .status").first().innerText()).toContain("Withheld: Sam's approval of the Health Records App doesn't include Riverside Hospital");
    expect(await page.locator(".sheet.withheld .thumb[data-study]").count()).toBe(0);
    expect(await named()).toEqual([SHEETS.mri]);
    expect(await page.locator(".headline h1").innerText()).toBe("Josh's studies Sam can see");
    expect(await page.locator(".headline .note").innerText()).toBe("The Health Records App can see 1 of these 5.");
    expect(problems).toEqual([]);
  });
  test("with no metadata from the server, the slide shows its placeholder, and the other thumbnails still draw", async () => {
    const backend = stack.backends["static-files"];
    const real = backend.getMetadata.bind(backend);
    backend.getMetadata = async () => { throw new BackendError("NotFound"); };
    try {
      const page = await open("/explore");
      await pick(page, "josh");
      await page.locator(`.thumb[data-study="${SHEETS.slide}"][data-state=none]`).waitFor({ timeout: 30000 });
      expect(await page.locator(`.thumb[data-study="${SHEETS.slide}"] canvas`).count()).toBe(0);
      expect(await page.locator(`.thumb[data-study="${SHEETS.slide}"] .placeholder`).isVisible()).toBe(true);
      await drawn(page, SHEETS.xr);
      expect(await variance(page, SHEETS.xr)).toBeGreaterThan(50);
    } finally { backend.getMetadata = real; }
  });
  test("by keyboard: pick someone, open a study, retrieve it, read its chain in one line, go back, and follow it to the log", async () => {
    const page = await open("/explore");
    await loaded(page);
    await page.locator("[data-user=josh]").focus();
    await settle(page, () => page.keyboard.press("Enter"));
    await page.waitForFunction(() => document.activeElement?.id === "headline");
    const sheet = page.locator(`[data-open="${SHEETS.xr}"]`);
    await sheet.focus();
    await page.keyboard.press("Enter");
    await page.locator("#chain a").waitFor();
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("headline");
    expect(await page.locator("#headline").innerText()).toBe("XR wrist left, 3 views");
    // No event cards on the study: one line, and a link to the log.
    expect(await page.locator(".card, .cards").count()).toBe(0);
    await page.locator("#retrieve").focus();
    await page.keyboard.press("Enter");
    await page.locator(".retrieval h3", { hasText: "Retrieved" }).waitFor({ timeout: 60000 });
    await page.locator("#chain", { hasText: "3 parts" }).waitFor();
    expect(await page.locator("#chain").innerText()).toMatch(/^Searched, signed link made, checked by the proxy with no policy call; 3 parts, [\d.]+ [KMG]?B\. Activity log$/);
    const href = await page.locator("#chain a").getAttribute("href");
    expect(href).toMatch(new RegExp(`^/activity\\?session=explore-josh-[0-9a-f]{6}&study=${SHEETS.xr}$`));
    await page.locator("#back").focus();
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.open)).toBe(SHEETS.xr);
    // In the log, filtered to the session and study: the retrieval's row opens its exchange, with the signed link decoded.
    await page.goto(`${DEMO}${href}`);
    await page.locator(".tile[data-type=retrievals]").click();
    await page.waitForURL(/type=retrievals/);
    await page.locator("tr.ev", { hasText: "study" }).first().locator("td.t button").click();
    await page.locator("tr.detail details[data-exchange] summary").click();
    await page.locator("tr.detail .raw h4", { hasText: "Signed link, decoded" }).waitFor();
    expect(await page.locator("tr.detail .raw").innerText()).toContain('"ath"');
    expect(problems).toEqual([]);
  });
  test("an empty view offers the one action its reason calls for, and taking it is a real share", async () => {
    const page = await open("/explore");
    await pick(page, "sam-caregiver");
    await settle(page, () => page.locator("#other-records").selectOption("josh-example"));
    expect(await page.locator(".headline h1").innerText()).toBe("Sam can't see Josh's studies");
    // One obvious next step.
    expect(await page.locator(".empty .primary").count()).toBe(1);
    // The denial draws the diagram too: what's missing, and nothing at the end.
    expect(await page.locator(".why .ly-row.outcome .ly-name").innerText()).toBe("What the app can see: 0 studies");
    await page.getByRole("button", { name: "As Josh: share his studies with Sam" }).click();
    await page.locator("#action-form input[value='Northside Pathology']").uncheck();
    await settle(page, () => page.getByRole("button", { name: "Share", exact: true }).click());
    expect(await page.locator(".why .ly-row.choice .ly-name").first().innerText()).toBe("Josh shares his studies at Lakeside and Riverside with Sam");
    expect(stack.store.shares().map(s => s.sites.sort())).toEqual([["Lakeside Imaging", "Riverside Hospital"]]);
    expect(problems).toEqual([]);
  });
  test("a service starts from its referral, and the page applies the policy that lets it see the study", async () => {
    const page = await open("/explore");
    await pick(page, "hand-referral-service", "client");
    await settle(page, () => page.locator("#referral-select").selectOption("referral-xr-wrist-left-2012"));
    expect(await page.locator(".headline h1").innerText()).toBe("Hand referral service can't search Josh's studies");
    expect(await page.locator(".empty .primary").innerText()).toMatch(/^As the imaging network: /);
    await settle(page, () => page.locator(".empty .primary").click());
    expect(await page.locator(".headline h1").innerText()).toBe("Hand referral service can see the study this referral cites");
    await drawn(page, SHEETS.xr);
    expect(problems).toEqual([]);
  });
  test("the settings menu opens and closes by keyboard, and moves the demo clock", async () => {
    const page = await open("/explore");
    await page.locator("#settings-button").focus();
    await page.keyboard.press("Enter");
    await page.locator("#settings h2").waitFor();
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Settings");
    await page.getByRole("button", { name: "Ahead 1 hour" }).click();
    await page.locator("#settings .msg", { hasText: "The clock moved ahead." }).waitFor();
    expect(await page.locator("#settings").innerText()).toContain("Now +1 hours");
    await page.keyboard.press("Escape");
    expect(await page.locator("#settings").isHidden()).toBe(true);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("settings-button");
  });
});

describe("Tours", () => {
  test("the home page is the stories, each a card with the chain it ends on, the guardian's shows the locked study, and the revoke's shows before and after", async () => {
    const page = await open("/tours");
    expect(await page.locator(".story").count()).toBe(6);
    expect(await page.locator(".story .layers").count()).toBe(8);
    expect(await page.locator(".story", { hasText: "Sam, guardian of 15-year-old Riley" }).locator(".ly-box.locked").count()).toBeGreaterThan(0);
    expect(await page.locator(".story", { hasText: "Josh stops sharing with Sam" }).locator(".ly-pane-label").allInnerTexts()).toEqual(["Before Josh stops sharing", "After Josh stops sharing", "Once those study links expire"]);
    expect(await page.locator(".cast dt").allInnerTexts()).toContain("The imaging network");
    expect(await overflow(page)).toBe(0);
    expect(problems).toEqual([]);
  });
  for (const tour of ["own", "guardian", "caregiver", "revoke", "backend", "turns-18"]) {
    test(`${tour}: its card starts it in its own scope, it runs end to end, and every step matches the model`, async () => {
      const page = await open("/tours");
      await page.locator(`[data-start="${tour}"]`).first().click();
      await page.waitForURL(/\/s\/[^/]+\/tours\?tour=/);
      await page.locator(".step.next .what span", { hasText: "Expected:" }).waitFor();
      await page.locator(".tour-chain figure.layers").first().waitFor();
      await page.getByRole("button", { name: "Run the rest" }).click();
      await page.locator(".tour-buttons .verdict").waitFor({ timeout: 90000 });
      expect(await page.locator(".tour-buttons .verdict").innerText()).toBe("Every step went as expected");
      expect(await page.locator(".step .verdict.ok").count()).toBe(await page.locator(".step").count());
      // Steps carry no event cards: a link to their own events in the log.
      expect(await page.locator(".step .card").count()).toBe(0);
      expect(await page.locator(".step .result a").first().getAttribute("href")).toMatch(/\/activity\?session=.*&trace=[0-9a-f]{32}$/);
      expect(await overflow(page)).toBe(0);
      expect(problems).toEqual([]);
    });
  }
  test("in window mode, a sign-in step's button says Sign in, and opens the window the person signs in in", async () => {
    const page = await open("/tours");
    await page.evaluate(() => localStorage.setItem("smart-imaging-signin", "window"));
    await page.locator('[data-start="own"]').first().click();
    await page.waitForURL(/\/s\/[^/]+\/tours/);
    const launch = page.locator("[data-step=launch]");
    expect(await launch.innerText()).toBe("Sign in");
    const [popup] = await Promise.all([context!.waitForEvent("page"), launch.click()]);
    await popup.waitForURL(/\/authorize/, { timeout: 30000 });
    await popup.locator("input[name=username][value=josh]").check();
    await popup.getByRole("button", { name: "Continue" }).click();
    await popup.getByRole("button", { name: "Approve" }).click();
    await page.locator(".step .verdict").first().waitFor({ timeout: 30000 });
    expect(problems).toEqual([]);
  });
  test("automated runs open no window", async () => {
    const page = await open("/tours");
    let opened = 0;
    context!.on("page", () => { opened++; });
    await page.locator('[data-start="caregiver"]').first().click();
    await page.waitForURL(/\/s\/[^/]+\/tours/);
    await page.getByRole("button", { name: "Run the rest" }).click();
    await page.locator(".tour-buttons .verdict").waitFor({ timeout: 90000 });
    expect(opened).toBe(0);
  });
  test("Run checks runs the protocol flows as one pass or fail list, each opening its activity", async () => {
    const page = await open("/tours");
    await page.getByRole("button", { name: "Run all checks" }).click();
    await page.locator(".checks-panel .row .verdict", { hasText: "passed" }).waitFor({ timeout: 110000 });
    expect(await page.locator(".checks-panel .row .verdict").innerText()).toBe("8 of 8 passed");
    const link = page.locator(".check-list a").first();
    await link.click();
    await page.waitForURL(/\/activity\?session=/);
    await page.locator("tr.ev").first().waitFor();
    expect(problems).toEqual([]);
  });
});

describe("activity", () => {
  for (const [name, viewport] of [["desktop", DESKTOP], ["phone", PHONE]] as const) {
    test(`${name}: tiles roll up each type, a tile lists its type, a row opens its event, and a shared value links on`, async () => {
      const explore = await open("/explore", { viewport });
      await pick(explore, "josh");
      const page = await context!.newPage();
      await page.goto(`${DEMO}/activity`);
      await page.locator(".tile").first().waitFor();
      expect(await page.locator(".tile").count()).toBe(9);
      expect(await page.locator(".timeline svg title").first().textContent()).toContain("Events over time, by party");
      expect(await page.locator(".session-row").count()).toBeGreaterThan(0);
      await page.locator(".tile[data-type=searches]").click();
      await page.waitForURL(/type=searches/);
      // The URL changes first; the list redraws once its events arrive.
      await page.locator("#h-events", { hasText: /^Searches$/ }).waitFor();
      // A tile changes the list of events, so the page brings the list into sight.
      await page.waitForFunction(() => { const t = document.querySelector("#h-events")!.getBoundingClientRect().top; return t >= 0 && t < innerHeight; });
      expect(await page.locator(".events th").allInnerTexts()).toEqual(["Time", "Who", "Status", "Returned", "Withheld", "Query"]);
      await page.locator("tr.ev td.t button").first().click();
      await page.locator("tr.detail .ev-links a", { hasText: /^token / }).first().click();
      await page.waitForURL(/link=token/);
      await page.locator("tr.ev").first().waitFor();
      expect(await page.locator("tr.ev").count()).toBeGreaterThan(2);
      // Choosing a session filters the whole page to it.
      await page.locator(".session-row").first().click();
      await page.waitForURL(/session=/);
      await page.locator(".chosen li", { hasText: "Session:" }).waitFor();
      // The session in time order: a card per stretch, studies that went alike on one line, each line's steps in order.
      await page.locator(".fl-card").first().waitFor();
      expect(await page.locator(".fl-card").first().locator(".fl-step").first().innerText()).toMatch(/Search\s+found/);
      // Its detail: a row per study with its four stages, and a stage lists that study's events of its type.
      await page.locator(".fl-card").first().locator(".fl-more summary").click();
      await page.locator(".fl-row").first().waitFor();
      expect(await page.locator(".fl-row").first().locator(".fl-cell").count()).toBe(4);
      expect(await page.locator(".fl-row").first().locator(".fl-cell").first().getAttribute("aria-label")).toMatch(/^Search: found/);
      expect(await overflow(page)).toBe(0);
      await page.locator(".fl-row").first().locator(".fl-cell").first().click();
      await page.waitForURL(/study=.*type=searches|type=searches.*study=/);
      await page.locator("#h-events", { hasText: /^Searches$/ }).waitFor();
      expect(await overflow(page)).toBe(0);
      expect(problems).toEqual([]);
    });
  }
});
