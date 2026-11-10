// The site's pages, one app. React Router draws the page each address names, from the site map: the site's own
// pages at the root, and a sandbox's under /s/{id}. The server serves this same shell at every page's address,
// so a reload anywhere draws the same page, and moving between pages happens in place.
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes, useLocation, useParams } from "react-router";
import { api, setBase } from "./lib/api";
import { pageAt, PAGES, type PageId } from "./sitemap";
import { Shell } from "./shell/Shell";
import { UI_PAGES } from "./pages";

/** A page of the map, in its sandbox when the route names one. A new address starts the page afresh. */
function PageAt({ id }: { id: PageId }) {
  const { sandbox } = useParams(), { pathname, search } = useLocation();
  setBase(sandbox ? `/s/${sandbox}` : "");
  const Page = UI_PAGES[id]!;
  return <Shell key={sandbox ?? ""} page={id}><Page key={`${pathname}${search}`} /></Shell>;
}

const pages = Object.values(PAGES);
function App() {
  return (
    <Routes>
      {pages.filter(p => p.level === "site").map(p => <Route key={`site-${p.id}`} path={p.path} element={<PageAt id={p.id} />} />)}
      {pages.filter(p => p.level === "sandbox").map(p => <Route key={`sandbox-${p.id}`} path={`/s/:sandbox${p.path === "/" ? "" : p.path}`} element={<PageAt id={p.id} />} />)}
      {/* A local root is a sandbox too, for development: its pages, except where the site has its own. */}
      {pages.filter(p => p.level === "sandbox" && !pageAt("site", p.path)).map(p => <Route key={`root-${p.id}`} path={p.path} element={<PageAt id={p.id} />} />)}
    </Routes>
  );
}

// A sign-in tab the viewer opened hands its address back to the viewer, and closes.
if (location.pathname === "/viewer" && /[?&](code|error)=/.test(location.search) && window.opener) {
  window.opener.postMessage({ signedIn: location.href }, location.origin);
  window.close();
} else {
  // For automation and the browser console: the management API, with the shown page's sandbox and its admin token.
  Object.assign(window, { sandboxApi: api });
  createRoot(document.getElementById("root")!).render(<BrowserRouter><App /></BrowserRouter>);
}
