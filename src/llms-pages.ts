// llms.txt's list of pages, from the same site map the pages' menus are drawn from, so the two can't disagree.
import { hrefOf, MENU, PAGES, SANDBOX_GROUPS, SITE_TOOLS, type PageId } from "../ui/sitemap";

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
