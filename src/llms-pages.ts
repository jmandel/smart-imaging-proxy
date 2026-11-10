// llms.txt's list of pages, from the same site map the pages' menus are drawn from, so the two can't disagree.
import { hrefOf, MENU, PAGES, SANDBOX_GROUPS, SITE_TOOLS, type PageId } from "../ui/sitemap";
import { CONTROLS, NAMED, VIEW_LINKS } from "../ui/drive";

/** The "Pages" section, for a sandbox at `site` on `origin`. */
export function pagesSection(origin: string, site: string): string {
  const base = site.slice(origin.length);
  const link = (id: PageId) => `[${PAGES[id].name}](${origin}${hrefOf(id, base)})`;
  return [
    "## Pages",
    "",
    "The menu is a guide for each audience, at the site's root. Each lists what matters, most important first.",
    "",
    ...MENU.map(id => `- ${link(id)}: ${PAGES[id].blurb}`),
    "",
    "The site's own tools, at its root, for any server:",
    "",
    ...SITE_TOOLS.map(id => `- ${link(id)}: ${PAGES[id].blurb}`),
    "",
    "A sandbox's own pages, by what they're for. Its viewer is the site's, opened on the sandbox.",
    "",
    `- ${link("sandbox")}: ${PAGES.sandbox.blurb}`,
    ...SANDBOX_GROUPS.map(g => `- **${g.title}:** ${g.pages.map(id => `${link(id)} (${PAGES[id].blurb.replace(/\.$/, "").replace(/^./, c => c.toLowerCase())})`).join(", ")}.`),
  ].join("\n");
}

/** An address as llms.txt writes it: a sandbox page's under `$SANDBOX`, a site page's at the origin. */
const addressOf = (origin: string, id: PageId, query = "") => `${PAGES[id].level === "sandbox" ? "$SANDBOX" : origin}${PAGES[id].path}${query}`;

/** The "Links to a view" section: every view an address opens, from the list the pages follow. */
export function viewLinksSection(origin: string): string {
  return [
    "## Links to a view",
    "",
    "Every state worth showing someone is in the page's address, and survives a reload, so you can hand a person the exact view: a story, a filtered log, a person's studies. A link holds nothing secret beyond the sandbox's own URL. Explore, the logs and the live trace have a Link to this view button that copies it. A saved server is named by `{iss}|{client id}`, URL-encoded, and opens only in the browser that saved it.",
    "",
    "| Page | Address | What it opens |",
    "|---|---|---|",
    // A bar in a cell, even in code, would end the cell.
    ...VIEW_LINKS.map(v => `| ${PAGES[v.page].name} | \`${addressOf(origin, v.page, v.query)}\` | ${v.opens} |`.replaceAll("}|{", "}\\|{")),
  ].join("\n");
}

/** The controls an agent can find by role and accessible name, as a table. */
export function controlsTable(): string {
  return [
    "| Page | Control | Role | Name |",
    "|---|---|---|---|",
    ...CONTROLS.map(c => `| ${c.page} | ${c.control} | \`${c.role}\` | \`${c.name}\` |`),
    "",
    `In a name, ${Object.entries(NAMED).map(([k, v]) => `\`{${k}}\` is ${v}`).join("; ")}.`,
  ].join("\n");
}

/** llms.txt's parts, by its top-level headings, each with the id `?part=` names it by. */
export const LLMS_PARTS: Record<string, string> = { "Shared background": "shared", "Building an app": "app", "Testing your server": "server", "The management API": "management", "References": "references" };
export function llmsParts(text: string): { opening: string; parts: { id: string; title: string; text: string }[] } {
  const at = [...text.matchAll(/^# (.+)$/gm)].filter(m => m[1]! in LLMS_PARTS);
  return {
    opening: text.slice(0, at[0]?.index ?? text.length),
    parts: at.map((m, i) => ({ id: LLMS_PARTS[m[1]!]!, title: m[1]!, text: text.slice(m.index!, at[i + 1]?.index ?? text.length) })),
  };
}
