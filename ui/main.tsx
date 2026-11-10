// The site's pages, one app. React Router draws the page each address names, from the site map: the site's own
// pages at the root, and a sandbox's under /s/{id}. The server serves this same shell at every page's address,
// so a reload anywhere draws the same page, and moving between pages happens in place.
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";
import { api } from "./lib/api";
import { router } from "./router";

// A sign-in tab the viewer opened hands its address back to the viewer, and closes.
if (location.pathname === "/viewer" && /[?&](code|error)=/.test(location.search) && window.opener) {
  window.opener.postMessage({ signedIn: location.href }, location.origin);
  window.close();
} else {
  // For automation and the browser console: the management API, with the shown page's sandbox and its admin token.
  Object.assign(window, { sandboxApi: api });
  createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
}
