// The site's pages: one React bundle, built by Bun when the server starts, and the HTML shell each page loads
// it from, titled from the site map.
import { join } from "node:path";
import { PAGES, type PageId } from "../ui/sitemap";

export interface UiBundle { files: Map<string, { body: Uint8Array; type: string }> }

let built: Promise<UiBundle> | undefined;
/** The bundle, built once per process. A build error stops the page, not the server, and says why. */
export function uiBundle(root: string): Promise<UiBundle> {
  return built ??= (async () => {
    const out = await Bun.build({ entrypoints: [join(root, "ui", "main.tsx")], target: "browser", minify: true, sourcemap: "linked", naming: "app.[ext]", define: { "process.env.NODE_ENV": JSON.stringify("production") } });
    if (!out.success) { built = undefined; throw new AggregateError(out.logs, "The UI didn't build"); }
    const files = new Map<string, { body: Uint8Array; type: string }>();
    for (const o of out.outputs) files.set(`/${o.path.replace(/^\.\//, "")}`, { body: new Uint8Array(await o.arrayBuffer()), type: o.type });
    return { files };
  })();
}

/** A built file of the bundle, at the site's root, or nothing. */
export async function uiFile(root: string, path: string): Promise<Response | undefined> {
  if (!/^\/app\.(js|js\.map)$/.test(path)) return undefined;
  const f = (await uiBundle(root)).files.get(path);
  return f && new Response(f.body, { headers: { "content-type": f.type, "cache-control": "no-cache" } });
}

const ICON = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20'%3E%3Crect width='20' height='20' rx='3' fill='%230f2a3d'/%3E%3Ccircle cx='10' cy='10' r='4' fill='%23e8f1f6'/%3E%3C/svg%3E`;
/** The HTML every page starts as: its title, the styles, and the bundle that draws it. */
export function shellHtml(page: PageId, styles: string[] = ["/styles.css", "/client.css"]): Response {
  const title = page === "home" ? PAGES.home.name : `${PAGES[page].name} · SMART Imaging`;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="icon" href="${ICON}">
<link rel="preload" href="/fonts/atkinson-next.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/atkinson-mono.woff2" as="font" type="font/woff2" crossorigin>
${styles.map(s => `<link rel="stylesheet" href="${s}">`).join("\n")}
<script type="module" src="/app.js"></script>
</head>
<body><div id="root"></div></body>
</html>
`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}
