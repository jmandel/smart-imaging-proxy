// The site's pages, one bundle. The address says which page: the site's own at the root, or a sandbox's.
import { createRoot } from "react-dom/client";
import type { ComponentType } from "react";
import { api, BASE } from "./lib/api";
import { pageAt, type PageId } from "./sitemap";
import { Shell } from "./shell/Shell";
import { UI_PAGES } from "./pages";

// A sign-in tab the viewer opened hands its address back to the viewer, and closes.
const signInReturn = location.pathname === "/viewer" && /[?&](code|error)=/.test(location.search) && window.opener;
if (signInReturn) {
  window.opener.postMessage({ signedIn: location.href }, location.origin);
  window.close();
} else {
  // For automation and the browser console: the management API, with this page's sandbox and its admin token.
  Object.assign(window, { sandboxApi: api });
  const rest = location.pathname.slice(BASE.length) || "/";
  const page = (BASE ? pageAt("sandbox", rest) : pageAt("site", rest) ?? pageAt("sandbox", rest))?.id;
  const Page: ComponentType | undefined = page && UI_PAGES[page];
  if (page && Page) createRoot(document.getElementById("root")!).render(<Shell page={page as PageId}><Page /></Shell>);
}
