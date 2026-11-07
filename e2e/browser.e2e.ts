// What only a real browser shows: focus, overflow, contrast, popups, and what the pages draw from real
// responses. Run with `bun run test:ui`. It starts its own stack in memory, and reads the shared archive.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { createDemoServer } from "../src/demo-server";
import { registerClients } from "../src/flows";
import { CONFIG, PORTS } from "../src/config";
import { startStack, type Stack } from "../src/stack";

setDefaultTimeout(90000);
const root = join(import.meta.dir, "..");
const DEMO = `http://127.0.0.1:${PORTS.demo}`;
const DESKTOP = { width: 1440, height: 900 }, PHONE = { width: 390, height: 844 };

let stack: Stack, server: ReturnType<typeof Bun.serve>, browser: Browser, context: BrowserContext | undefined;
const problems: string[] = [];

beforeAll(async () => {
  stack = await startStack(root);
  server = Bun.serve({ port: PORTS.demo, hostname: "127.0.0.1", fetch: createDemoServer(stack, registerClients(stack), root).fetch });
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium", headless: true });
});
afterAll(async () => { await browser?.close(); server?.stop(true); stack?.stop(); });
beforeEach(async () => {
  problems.length = 0;
  stack.resetAll();
  await fetch(`${DEMO}/api/admin/store/activate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ store: "saved" }) });
});
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
  page.on("console", m => { if (m.type() === "error") problems.push(`${page.url()}: ${m.text()}`); });
}
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
const focusName = (page: Page) => page.evaluate(() => { const a = document.activeElement as HTMLElement; return a.dataset.fid ?? a.id ?? a.tagName; });
const signIn = async (popup: Page, user: string, decision: "Approve" | "Deny" = "Approve") => {
  await popup.locator(`input[name=username][value=${user}]`).check();
  await popup.getByRole("button", { name: "Continue" }).click();
  await popup.getByRole("button", { name: decision }).click();
};

/** WCAG contrast of an element's text on its nearest painted background. */
const contrast = (page: Page, selector: string) => page.locator(selector).first().evaluate(el => {
  const rgb = (c: string) => c.match(/[\d.]+/g)!.map(Number);
  const lum = ([r, g, b]: number[]) => { const f = (v: number) => { const s = v / 255; return s <= .03928 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4; }; return .2126 * f(r!) + .7152 * f(g!) + .0722 * f(b!); };
  let bgEl: Element | null = el;
  while (bgEl && (rgb(getComputedStyle(bgEl).backgroundColor)[3] === 0 || getComputedStyle(bgEl).backgroundColor === "transparent")) bgEl = bgEl.parentElement;
  const a = lum(rgb(getComputedStyle(el).color)), b = lum(rgb(getComputedStyle(bgEl ?? document.body).backgroundColor));
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
});

describe("every page, on desktop and phone, in light and dark", () => {
  for (const [name, viewport] of [["desktop", DESKTOP], ["phone", PHONE]] as const) for (const colorScheme of ["light", "dark"] as const) {
    test(`${name} ${colorScheme}: no script or console errors, and no sideways scrolling`, async () => {
      for (const path of ["/", "/browse", "/admin", CONFIG.traceUrl, `${CONFIG.authUrl}/account`]) {
        const page = await open(path, { viewport, colorScheme });
        await page.waitForLoadState("networkidle");
        expect([path, await overflow(page)]).toEqual([path, 0]);
        await context!.close(); context = undefined;
      }
      expect(problems).toEqual([]);
    });
  }
});

describe("overview", () => {
  test("the route buttons switch the route and say why", async () => {
    const page = await open("/");
    const route = page.locator(".route.wide");
    await page.getByRole("button", { name: "Anything else" }).click();
    expect(await route.getAttribute("data-route")).toBe("asked");
    expect(await page.locator("#route-why").innerText()).toContain("can_i");
    await page.getByRole("button", { name: "Signed URL checks out" }).click();
    expect(await route.getAttribute("data-route")).toBe("instant");
    expect(await page.locator("#route-why").innerText()).toContain("no network call");
  });
  test("flows are grouped with what each does, and a phone moves between them without the list", async () => {
    const page = await open("/", { viewport: PHONE });
    expect(await page.locator(".flow-groups h3").allInnerTexts()).toEqual(["Who can see what", "How the proxy decides", "What comes back"]);
    expect(await page.locator(".flow-choice").count()).toBe(15);
    expect(await page.locator(".flow-choice .what span").first().innerText()).toContain("Josh picks");
    expect(await page.locator("#flow-list").isVisible()).toBe(false);
    expect(await overflow(page)).toBe(0);
    await page.locator(".flow-choice").first().click();
    await page.locator("[data-next]").click();
    await page.locator(".flow-title", { hasText: "2. Related person" }).waitFor();
    expect(await page.locator("#flow-list").isVisible()).toBe(false);
    await page.getByRole("link", { name: "All flows" }).click();
    await page.locator(".hero").waitFor();
  });
  test("the route's dot fades out when its run ends, on both routes, after a real wait", async () => {
    for (const viewport of [DESKTOP, PHONE]) {
      const page = await open("/", { viewport });
      const route = viewport === DESKTOP ? ".route.wide" : ".route.tall";
      const dot = (name: string) => page.locator(`${route} .${name}-pulse`).evaluate(el => { const a = el.getAnimations()[0]; return { opacity: getComputedStyle(el).opacity, state: a?.playState, distance: getComputedStyle(el).offsetDistance }; });
      await page.waitForTimeout(2000);
      expect(await dot("instant")).toEqual({ opacity: "0", state: "finished", distance: "100%" });
      await page.getByRole("button", { name: "Anything else" }).click();
      await page.waitForTimeout(3000);
      expect(await dot("asked")).toEqual({ opacity: "0", state: "finished", distance: "100%" });
      expect((await dot("instant")).opacity).toBe("0");
      await context!.close(); context = undefined;
    }
  });
  test("the link shows the overview during a flow, and a reload returns to the flow", async () => {
    const page = await open("/");
    await page.locator(".flow-choice").first().click();
    await page.locator(".flow-title").waitFor();
    await page.reload();
    await page.locator(".flow-title").waitFor();
    await page.getByRole("link", { name: "Overview" }).click();
    await page.locator(".hero").waitFor();
    expect(await page.locator(".flow-title").count()).toBe(0);
  });
});

describe("browse", () => {
  const signedIn = async (opts?: Parameters<typeof open>[1]) => {
    const page = await open("/browse", opts);
    await page.locator("[data-user=josh]").click();
    await page.locator("article.study").first().waitFor();
    return page;
  };
  test("frames match the series and counts in the real Bundle", async () => {
    const page = await signedIn();
    const bundle: any = await page.evaluate(async () => (await fetch("/api/browse/bundle")).json());
    for (const { resource: s } of bundle.entry.filter((e: any) => e.resource.resourceType === "ImagingStudy")) {
      const frames = page.locator(`article[data-study="${s.id}"] .frame`);
      const shown = await frames.evaluateAll(all => all.map(f => [f.querySelector(".mod")!.textContent, f.querySelector(".no")!.textContent, f.querySelector(".count")!.textContent]));
      expect(shown).toEqual(s.series.map((x: any) => [x.modality.code, String(x.number), String(x.numberOfInstances)]).sort((a: any, b: any) => Number(a[1]) - Number(b[1])));
    }
  });
  test("the selected person stays readable under the mouse", async () => {
    const page = await signedIn();
    await page.locator("button.who[aria-current=true]").hover();
    expect(await contrast(page, "button.who[aria-current=true] b")).toBeGreaterThan(4.5);
  });
  test("withheld series are hatched with their counts, on a phone too", async () => {
    const admin = await open("/admin");
    await admin.locator("#rule-set-select").selectOption("outside-release");
    await admin.locator("#apply-rule-set").click();
    await admin.locator("#rules-current", { hasText: "Outside release" }).waitFor();
    await context!.close();
    const page = await open("/browse", { viewport: PHONE });
    await page.locator("[data-client=outside-release-service]").click();
    await page.locator(".frame.withheld").first().waitFor();
    expect(await page.locator(".frame.withheld").count()).toBe(3);
    expect(await page.locator(".frame.withheld .count").first().isVisible()).toBe(true);
    const clash = await page.locator(".frame.withheld").first().evaluate(f => { const a = f.querySelector(".gone")!.getBoundingClientRect(), b = f.querySelector(".count")!.getBoundingClientRect(); return a.bottom > b.top && a.right > b.left; });
    expect(clash).toBe(false);
    expect(await overflow(page)).toBe(0);
  });
  test("keyboard focus survives paging and retrieval, and both retrievals complete", async () => {
    const page = await signedIn();
    await page.locator("[data-fid=to-next]").first().focus();
    await page.keyboard.press("Enter");
    await page.getByText(/Studies 6.6 of 6/).first().waitFor();
    expect(await focusName(page)).not.toBe("BODY");
    expect(await focusName(page)).not.toBe("");
    for (const [zstd, encoding] of [["1", "zstd"], ["0", "identity"]] as const) {
      const button = page.locator(`[data-retrieve][data-zstd="${zstd}"]`).first();
      await button.focus();
      const fid = await button.getAttribute("data-fid");
      await page.keyboard.press("Enter");
      const result = page.locator(".retrieved").filter({ hasText: zstd === "1" ? "With zstd" : "Without zstd" }).first();
      await result.getByText("received", { exact: true }).waitFor({ timeout: 60000 });
      expect(await focusName(page)).toBe(fid!);
      void encoding;
    }
    expect(problems).toEqual([]);
  });
});

describe("whose records, as Sam", () => {
  const SAM = "sam-caregiver";
  beforeEach(() => { stack.resetSaved(); });
  const choice = (page: Page, patient: string) => page.locator(`[data-records=${SAM}] [data-whose=${patient}]`);
  const shown = (page: Page) => page.locator("article.study").evaluateAll(all => all.map(a => (a as HTMLElement).dataset.study).sort());
  const whose = (page: Page, patient: string) => page.locator(`.whose-line[data-whose-shown=${patient}]`).waitFor();
  const choices = (page: Page) => page.locator(`[data-records=${SAM}] [data-whose]`).evaluateAll(all => all.map(b => (b as HTMLElement).dataset.whose));
  for (const [name, viewport] of [["desktop", DESKTOP], ["phone", PHONE]] as const) {
    test(`${name}: picks directly, each pick a new sign-in, and Josh joins once he shares`, async () => {
      const page = await open("/browse", { viewport });
      await choice(page, "sam-example").waitFor();
      expect(await choices(page)).toEqual(["sam-example", "riley-example"]);
      expect(await page.locator("[data-records=josh]").count()).toBe(0);
      // The choice is on show under Sam, with no menu to open, and big enough to tap.
      const box = await choice(page, "riley-example").boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);

      await choice(page, "riley-example").click();
      await whose(page, "riley-example");
      await page.locator("article.study").first().waitFor();
      expect(await shown(page)).toEqual(["syn-riley-knee-mr-2022"]);
      expect(await page.locator(".whose-line").innerText()).toBe("Riley Example's records, which Sam holds as guardian");
      expect(await page.locator(".outcome").innerText()).toContain("Sam is Riley's guardian, on file");
      await page.locator("details.raw", { hasText: "only some sites" }).locator("summary").click();
      expect(await page.locator("#app-sites").innerText()).not.toContain("Northside Pathology");
      expect(await page.locator(".outcome").innerText()).not.toContain("confidential");
      expect(await choice(page, "riley-example").getAttribute("aria-current")).toBe("true");
      expect(await page.locator("article.study h3").first().innerText()).toStartWith("SYNTHETIC");
      const first: any = await page.evaluate(async () => (await (await fetch("/api/browse/session")).json()).session.name);

      await choice(page, "sam-example").click();
      await whose(page, "sam-example");
      await page.locator('article.study[data-study="syn-sam-ct-sinus-2024"]').waitFor();
      expect(await shown(page)).toEqual(["syn-sam-chest-xr-2021", "syn-sam-ct-sinus-2024"]);
      expect(await page.evaluate(async () => (await (await fetch("/api/browse/session")).json()).session.name)).not.toBe(first);
      expect(await choice(page, "riley-example").getAttribute("aria-current")).toBe("false");
      expect(await overflow(page)).toBe(0);

      await page.locator(`[data-records=${SAM}] [data-whose-unshared=josh-example]`).click();
      await page.locator(".outcome.denied").waitFor();
      expect(await page.locator(".outcome").innerText()).toContain("Sam doesn't hold Josh Example's records");
      await page.locator(`[data-share=${SAM}]`).click();
      await whose(page, "josh-example");
      await page.locator("article.study").first().waitFor();
      expect(await page.locator(".whose-line").innerText()).toBe("Josh Example's records, shared with Sam as caregiver");
      await choice(page, "josh-example").waitFor();
      expect(await choices(page)).toEqual(["sam-example", "riley-example", "josh-example"]);
      expect(await page.locator("[data-whose-unshared]").count()).toBe(0);
      expect(await choice(page, "josh-example").getAttribute("aria-current")).toBe("true");
      expect(await overflow(page)).toBe(0);
      expect(problems).toEqual([]);
    });
    test(`${name}: in a real window, the consent page has the pick selected, and a different pick there is what counts`, async () => {
      const page = await open("/browse", { viewport });
      await choice(page, "riley-example").waitFor();
      await page.locator("#options summary").click();
      await page.locator("input[name=mode][value=window]").check();
      const [popup] = await Promise.all([context!.waitForEvent("page"), choice(page, "riley-example").click()]);
      await popup.waitForURL(/\/authorize/);
      await popup.setViewportSize(viewport);
      await popup.locator(`input[name=username][value=${SAM}]`).check();
      await popup.getByRole("button", { name: "Continue" }).click();
      const radio = (patient: string) => popup.locator(`input[name=patient][value=${patient}]`);
      await radio("riley-example").waitFor();
      expect(await radio("riley-example").isChecked()).toBe(true);
      expect(await popup.getByText("People you hold records for").isVisible()).toBe(true);
      expect(await popup.locator("[data-sites-for=riley-example]").isVisible()).toBe(true);
      expect(await popup.locator("[data-sites-for=sam-example]").isVisible()).toBe(false);
      expect(await popup.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
      await radio("sam-example").check();
      expect(await popup.locator("[data-sites-for=sam-example]").isVisible()).toBe(true);
      expect(await popup.locator("[data-sites-for=riley-example]").isVisible()).toBe(false);
      await popup.getByRole("button", { name: "Approve" }).click();
      await whose(page, "sam-example");
      await page.locator("article.study").first().waitFor();
      expect(await shown(page)).toEqual(["syn-sam-chest-xr-2021", "syn-sam-ct-sinus-2024"]);
      expect(await choice(page, "sam-example").getAttribute("aria-current")).toBe("true");
      expect(problems).toEqual([]);
    });
    test(`${name}: the account page shares the chosen person's records, and says what stops at Sam`, async () => {
      await fetch(`${DEMO}/api/browse/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ user: SAM, client: "portal-app", mode: "scripted", count: 5, share: { delegate: SAM, sites: ["Lakeside Imaging"] } }) });
      const shared = async () => { for (let i = 0; i < 400; i++) { if (stack.stores.saved.delegations().length) return; await Bun.sleep(25); } throw new Error("Josh never shared"); };
      await shared();
      const page = await open(`${CONFIG.authUrl}/account?login_hint=${SAM}`, { viewport });
      await page.locator(`input[name=username][value=${SAM}]`).check();
      await page.getByRole("button", { name: "Continue" }).click();
      await page.locator("[data-record=riley-example]").waitFor();
      expect(await page.locator("[data-record=sam-example]").innerText()).toContain("your own records");
      expect(await page.locator("[data-record=riley-example]").innerText()).toContain("you're their guardian");
      expect(await page.locator("[data-record=josh-example]").innerText()).toContain("shared with you as caregiver");
      expect(await page.getByText("can't pass it on").isVisible()).toBe(true);
      expect(await page.locator("input[type=radio][name=patient][value=josh-example]").count()).toBe(0);
      expect(await page.locator("[data-sites-for=sam-example]").isVisible()).toBe(true);
      expect(await page.locator("[data-sites-for=riley-example]").isVisible()).toBe(false);
      await page.locator("input[name=patient][value=riley-example]").check();
      expect(await page.locator("[data-sites-for=sam-example]").isVisible()).toBe(false);
      await page.locator("select[name=delegate]").selectOption("alex-neighbor");
      await page.locator("select[name=relationship]").selectOption("neighbor");
      expect(await page.locator('input[name="sites@riley-example"][value="Northside Pathology"]').count()).toBe(0);
      await page.getByRole("button", { name: "Share", exact: true }).click();
      await page.getByText("Riley Example's records: Lakeside Imaging").waitFor();
      expect(stack.stores.saved.delegations().find(d => d.delegate === "alex-neighbor")).toMatchObject({ patient: "riley-example", sites: ["Lakeside Imaging"], asGuardian: true });
      expect(await overflow(page)).toBe(0);
      expect(problems).toEqual([]);
    });
  }
  test("the admin screen shows the guardian on file, and a reset leaves it", async () => {
    const page = await open("/admin");
    const row = page.locator(`#guardians [data-guardian=${SAM}]`);
    await row.waitFor();
    expect(await row.innerText()).toContain("guardian of patient riley-example");
    page.on("dialog", d => d.accept());
    await page.locator("#reset-saved").click();
    await page.locator("#store-msg", { hasText: "Guardians on file" }).waitFor();
    await row.waitFor();
    expect(problems).toEqual([]);
  });
  for (const [name, viewport] of [["desktop", DESKTOP], ["phone", PHONE]] as const) test(`${name}: flow 15 runs through, in its group, with every check passing`, async () => {
    const page = await open("/", { viewport });
    const groups = page.locator(".flow-groups > div");
    expect(await groups.first().locator(".flow-choice b").allInnerTexts()).toContain("Caregiver picks whose records");
    await groups.first().locator(".flow-choice", { hasText: "Caregiver picks whose records" }).click();
    await page.locator(".flow-title", { hasText: "15. Caregiver" }).waitFor();
    await page.locator("[data-run=own]").waitFor();
    await page.locator('[data-step=own] select[data-input=mode]').selectOption("scripted");
    await page.locator("[data-run=own]").click();
    await page.locator("[data-run=guardian]").waitFor({ timeout: 30000 });
    await page.locator('[data-step=guardian] select[data-input=mode]').selectOption("scripted");
    await page.locator("#run-rest").click();
    await page.locator("[data-step=share] ul.checks").waitFor({ timeout: 60000 });
    expect(await page.locator("ul.checks .bad").count()).toBe(0);
    expect(await page.locator("ul.checks .ok").count()).toBeGreaterThan(15);
    expect(await page.locator("#chain").innerText()).toContain("riley-example's guardian");
    expect(await overflow(page)).toBe(0);
    expect(problems).toEqual([]);
  });
  test("flow 2 offers whose records Sam acts on, and a different choice explains itself", async () => {
    const page = await open("/");
    await page.locator(".flow-choice", { hasText: "Related person, then app" }).click();
    await page.locator('[data-step=delegate] select[data-input=mode]').selectOption("scripted");
    await page.locator("[data-run=delegate]").click();
    await page.locator("[data-run=unrelated]").click();
    await page.locator("[data-step=sam-launch] select[data-input=whose]").selectOption("riley-example");
    await page.locator('[data-step=sam-launch] select[data-input=mode]').selectOption("scripted");
    await page.locator("#run-rest").click();
    await page.locator("[data-step=revoke] ul.checks").waitFor({ timeout: 60000 });
    expect(await page.locator("ul.checks .bad").count()).toBe(0);
    expect(await page.locator("[data-step=searches]").innerText()).toContain("Sam's app sees only Riley's records");
    expect(await page.locator("[data-step=revoke]").innerText()).toContain("Riley's records don't depend on Josh");
    expect(problems).toEqual([]);
  });
});

describe("flows, in real windows", () => {
  const consent = async (page: Page) => { await page.locator(".flow-choice").first().click(); await page.locator("[data-run=consent]").waitFor(); };
  test("signing in and approving in the window passes the step", async () => {
    const page = await open("/");
    await consent(page);
    const [popup] = await Promise.all([context!.waitForEvent("page"), page.locator("[data-run=consent]").click()]);
    await popup.waitForURL(/\/authorize/);
    await signIn(popup, "josh");
    await page.locator('[data-step=consent] ul.checks').waitFor();
    expect(await page.locator('[data-step=consent] ul.checks .bad').count()).toBe(0);
  });
  test("denying explains itself, with no script error", async () => {
    const page = await open("/");
    await consent(page);
    const [popup] = await Promise.all([context!.waitForEvent("page"), page.locator("[data-run=consent]").click()]);
    await popup.waitForURL(/\/authorize/);
    await signIn(popup, "josh", "Deny");
    await page.locator('[data-step=consent] .result').getByText(/\S/).first().waitFor();
    const text = await page.locator("[data-step]").first().innerText();
    expect(text).not.toContain("TypeError");
    expect(text).not.toContain("undefined");
  });
  test("closing the window ends the wait, and the step can run again", async () => {
    const page = await open("/");
    await consent(page);
    const [popup] = await Promise.all([context!.waitForEvent("page"), page.locator("[data-run=consent]").click()]);
    await popup.waitForURL(/\/authorize/);
    await popup.close();
    await page.locator("[data-step=consent] .result").getByText("window closed").waitFor({ timeout: 15000 });
    expect(await page.locator("[data-run=consent]").isEnabled()).toBe(true);
  });
  test("signing out on the account page keeps the way back to the flow", async () => {
    const page = await open("/");
    await page.locator('.flow-choice[data-id=caregiver]').click();
    await page.locator("[data-run=delegate]").waitFor();
    const [popup] = await Promise.all([context!.waitForEvent("page"), page.locator("[data-run=delegate]").click()]);
    await popup.waitForURL(/\/account/);
    await popup.locator("input[name=username][value=josh]").check();
    await popup.getByRole("button", { name: "Continue" }).click();
    await popup.getByRole("link", { name: /Done, back to the demo/ }).waitFor();
    expect(await popup.locator("select[name=delegate]").inputValue()).toBe("sam-caregiver");
    await popup.getByRole("button", { name: "Sign out" }).click();
    expect(await popup.locator("input[name=username][value=josh]").isChecked()).toBe(true);
    await popup.getByRole("button", { name: "Continue" }).click();
    await popup.getByRole("link", { name: /Done, back to the demo/ }).waitFor();
  });
  test("a patient who approves no sites can still finish the flow", async () => {
    const page = await open("/");
    await consent(page);
    await page.locator("[data-step=consent] select[data-input=mode]").selectOption("scripted");
    await page.locator("[data-step=consent] [data-input=sites] input:checked").evaluateAll(all => all.forEach(b => { (b as HTMLInputElement).checked = false; }));
    await page.locator("[data-run=consent]").click();
    await page.locator("[data-run=search]").click();
    await page.locator("[data-run=retrieve]").click();
    await page.locator("[data-step=retrieve] .result").getByText("Nothing approved, so nothing to retrieve").waitFor();
    expect(await page.locator("[data-step=retrieve] select").count()).toBe(0);
    await page.locator("[data-run=unapproved]").waitFor();
    expect(problems).toEqual([]);
  });
  test("an open exchange doesn't make a phone page scroll sideways", async () => {
    const page = await open("/", { viewport: PHONE });
    await consent(page);
    await page.locator('[data-step=consent] select[data-input=mode]').selectOption("scripted").catch(() => {});
    await page.locator("[data-run=consent]").click();
    await page.locator("[data-step=consent] .exchange details").first().waitFor();
    await page.locator("[data-step=consent] .exchange details").evaluateAll(all => all.forEach(d => { (d as HTMLDetailsElement).open = true; }));
    expect(await overflow(page)).toBe(0);
  });
});

describe("admin and trace", () => {
  test("controls act, and the trace viewer previews what a search did", async () => {
    const admin = await open("/admin");
    const before = await admin.locator("#clock-now").innerText();
    await admin.locator("[data-advance]").first().click();
    await admin.waitForFunction(old => document.querySelector("#clock-now")!.textContent !== old, before);
    await admin.locator("#clock-reset").click();
    await admin.locator("#self-test").click();
    await admin.locator("#self-test-results .ok").first().waitFor({ timeout: 30000 });
    const browse = await context!.newPage();
    await browse.goto(`${DEMO}/browse`);
    await browse.locator("[data-user=josh]").click();
    await browse.locator("article.study").first().waitFor();
    const trace = await context!.newPage();
    await trace.goto(CONFIG.traceUrl);
    await trace.locator(".row .name").first().waitFor();
    await trace.locator(".row .name").first().click();
    await trace.locator(".preview").first().waitFor();
  });
});
