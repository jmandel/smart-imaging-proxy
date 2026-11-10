// The site's pages, one app. React Router draws the page each address names, from the site map: the site's own
// pages at the root, and a sandbox's under /s/{id}. The server serves this same shell at every page's address,
// so a reload anywhere draws the same page, and moving between pages happens in place.
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Outlet, RouterProvider, ScrollRestoration, useLocation, useParams, type RouteObject } from "react-router";
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
const page = (id: PageId, path: string): RouteObject => ({ path, element: <PageAt id={id} /> });
/** Around every page: a new page starts at the top, and Back or Forward returns to where it was. */
function Layout() {
  return <><ScrollRestoration /><Outlet /></>;
}
const router = createBrowserRouter([{
  element: <Layout />,
  children: [
    ...pages.filter(p => p.level === "site").map(p => page(p.id, p.path)),
    ...pages.filter(p => p.level === "sandbox").map(p => page(p.id, `/s/:sandbox${p.path === "/" ? "" : p.path}`)),
    // A local root is a sandbox too, for development: its pages, except where the site has its own.
    ...pages.filter(p => p.level === "sandbox" && !pageAt("site", p.path)).map(p => page(p.id, p.path)),
  ],
}]);

// A sign-in tab the viewer opened hands its address back to the viewer, and closes.
if (location.pathname === "/viewer" && /[?&](code|error)=/.test(location.search) && window.opener) {
  window.opener.postMessage({ signedIn: location.href }, location.origin);
  window.close();
} else {
  // For automation and the browser console: the management API, with the shown page's sandbox and its admin token.
  Object.assign(window, { sandboxApi: api });
  createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
}
