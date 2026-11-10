// The site's pages, in one place. The server routes and titles them from this, and llms.txt lists them; in the
// browser, the header, a sandbox's bar and home page, and the footer all draw from it, so they can't disagree.

/** Where a page lives: at the site's root only, or in every sandbox. */
export type Level = "site" | "sandbox";

export interface Page {
  id: PageId;
  level: Level;
  /** Its path, after the sandbox's base for a sandbox page. */
  path: string;
  /** Its name, in menus and its title. */
  name: string;
  /** One line on what it's for. */
  blurb: string;
}

export type PageId =
  | "home" | "build-an-app" | "run-a-server" | "how-it-works" | "why-it-matters" | "viewer" | "servers"
  | "sandbox" | "tours" | "explore" | "build" | "connect" | "activity" | "trace" | "config" | "checks";

const pages: Page[] = [
  { id: "home", level: "site", path: "/", name: "SMART Imaging Access", blurb: "A public sandbox and test client for the SMART Imaging Access guide." },
  { id: "build-an-app", level: "site", path: "/build-an-app", name: "Build an App", blurb: "Connect your SMART app to a sandbox health system with sample patients and studies." },
  { id: "run-a-server", level: "site", path: "/run-a-server", name: "Run a Server", blurb: "Connect our known-good viewer to your server, and see what it needs." },
  { id: "how-it-works", level: "site", path: "/how-it-works", name: "How It Works", blurb: "Watch one sign-in reach a patient's records and images, part by part." },
  { id: "why-it-matters", level: "site", path: "/why-it-matters", name: "Why It Matters", blurb: "What patients, caregivers and health systems get from imaging interoperability." },
  { id: "viewer", level: "site", path: "/viewer", name: "Viewer", blurb: "Our SMART app, signed in to one of your sandboxes or to your own server." },
  { id: "servers", level: "site", path: "/servers", name: "Your servers", blurb: "Describe your server for the viewer, and how it signs in." },
  { id: "sandbox", level: "sandbox", path: "/", name: "Home", blurb: "This sandbox: its name, sharing, and its pages." },
  { id: "tours", level: "sandbox", path: "/tours", name: "Tour", blurb: "Sharing, guardians and referrals, played out step by step." },
  { id: "explore", level: "sandbox", path: "/explore", name: "Explore", blurb: "What each sample person and service can reach, and why." },
  { id: "build", level: "sandbox", path: "/build", name: "Start here", blurb: "Endpoints, scopes, and sample people to sign in as." },
  { id: "connect", level: "sandbox", path: "/connect", name: "Register an app", blurb: "A public app, a confidential app, or a backend service." },
  { id: "activity", level: "sandbox", path: "/activity", name: "Logs", blurb: "Every request, and why each was allowed or refused." },
  { id: "trace", level: "sandbox", path: "/trace/", name: "Live trace", blurb: "Every request between the services, as it happens." },
  { id: "config", level: "sandbox", path: "/config", name: "Sandbox Config", blurb: "The demo clock, image storage, topology, resets, and ending access." },
  { id: "checks", level: "sandbox", path: "/checks", name: "Conformance", blurb: "This sandbox's servers, checked against the guide, in the page." },
];

export const PAGES = Object.fromEntries(pages.map(p => [p.id, p])) as Record<PageId, Page>;

/** The menu in every page's header: a guide for each audience, then the guide for agents. */
export const MENU: PageId[] = ["build-an-app", "run-a-server", "how-it-works", "why-it-matters"];

/** The site's own pages beyond the guides. */
export const SITE_TOOLS: PageId[] = ["viewer", "servers"];

/** A sandbox's pages, by what they're for. The viewer is the site's, opened on the sandbox. */
export const SANDBOX_GROUPS: { title: string; pages: (PageId)[] }[] = [
  { title: "Try it", pages: ["viewer", "tours", "explore"] },
  { title: "Your app", pages: ["build", "connect", "activity", "trace"] },
  { title: "Under the hood", pages: ["config", "checks"] },
];

export const REPO = "https://github.com/jmandel/smart-imaging-proxy";
export const CONFORMANCE_PLAN = `${REPO}/issues/1`;
export const REFERENCES: [string, string][] = [
  ["SMART Imaging Access", "https://build.fhir.org/ig/argonautproject/smart-imaging/"],
  ["SMART App Launch", "https://build.fhir.org/ig/HL7/smart-app-launch/"],
  ["FHIR ImagingStudy", "https://build.fhir.org/imagingstudy.html"],
  ["FHIR Endpoint", "https://build.fhir.org/endpoint.html"],
  ["DICOMweb WADO-RS", "https://www.dicomstandard.org/using/dicomweb/retrieve-wado-rs-and-wado-uri"],
];

/** The page at `path`, at a level: a sandbox's, or the site's root. */
export function pageAt(level: Level, path: string): Page | undefined {
  return pages.find(p => p.level === level && p.path === path);
}
/** A page's address: in `base`'s sandbox for a sandbox page. */
export const hrefOf = (id: PageId, base = "") => PAGES[id].level === "site" ? PAGES[id].path : `${base}${PAGES[id].path}`;
