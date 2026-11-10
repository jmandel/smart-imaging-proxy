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
  /** For a site page a sandbox links to: the query that opens it on that sandbox, holding the sandbox's base. */
  sandboxParam?: string;
}

export type PageId =
  | "home" | "build-an-app" | "run-a-server" | "about" | "sandboxes" | "viewer" | "servers" | "check"
  | "sandbox" | "tours" | "explore" | "build" | "connect" | "activity" | "trace" | "trace-span" | "trace-log" | "config";

const pages: Page[] = [
  { id: "home", level: "site", path: "/", name: "SMART Imaging Access", blurb: "A public sandbox and test client for the SMART Imaging Access guide." },
  { id: "build-an-app", level: "site", path: "/build-an-app", name: "Build an App", blurb: "Connect your SMART app to a sandbox health system with sample patients and studies." },
  { id: "run-a-server", level: "site", path: "/run-a-server", name: "Run a Server", blurb: "Connect our known-good viewer to your server, and see what it needs." },
  { id: "about", level: "site", path: "/about", name: "Why SMART Imaging", blurb: "What imaging interoperability makes possible, how it works, and what it takes." },
  { id: "sandboxes", level: "site", path: "/sandboxes", name: "My Sandboxes", blurb: "The sandboxes this browser has made or joined, and a new one." },
  { id: "viewer", level: "site", path: "/viewer", name: "Viewer", blurb: "Our SMART app, signed in to one of your sandboxes or to your own server." },
  { id: "servers", level: "site", path: "/servers", name: "Your servers", blurb: "Describe your server for the viewer, and how it signs in." },
  { id: "check", level: "site", path: "/check", name: "Server check", blurb: "Every step of the guide, run against your server, saying how far it got and why it stopped.", sandboxParam: "sandbox" },
  { id: "sandbox", level: "sandbox", path: "/", name: "Home", blurb: "This sandbox: its name, sharing, and its pages." },
  { id: "tours", level: "sandbox", path: "/tours", name: "Tour", blurb: "Sharing, guardians and referrals, played out step by step." },
  { id: "explore", level: "sandbox", path: "/explore", name: "Explore", blurb: "What each sample person and service can reach, and why." },
  { id: "build", level: "sandbox", path: "/build", name: "Endpoints", blurb: "This sandbox's addresses, scopes, and sample people to sign in as." },
  { id: "connect", level: "sandbox", path: "/connect", name: "Register an app", blurb: "A public app, a confidential app, or a backend service." },
  { id: "activity", level: "sandbox", path: "/activity", name: "Logs", blurb: "Every request, and why each was allowed or refused." },
  { id: "trace", level: "sandbox", path: "/trace/", name: "Live trace", blurb: "Every request between the services, as it happens." },
  // The trace's own sub-pages, opened from its rows: in no group, so in no menu.
  { id: "trace-span", level: "sandbox", path: "/trace/span", name: "HTTP exchange", blurb: "One HTTP call's headers and bodies, as one side recorded it." },
  { id: "trace-log", level: "sandbox", path: "/trace/log", name: "HTTP log", blurb: "Every HTTP call in a trace, each with its full exchange." },
  { id: "config", level: "sandbox", path: "/config", name: "Sandbox Config", blurb: "The demo clock, image storage, topology, resets, and ending access." },
];

export const PAGES = Object.fromEntries(pages.map(p => [p.id, p])) as Record<PageId, Page>;

/** The menu in every page's header: the two ways in, what it's all for, your sandboxes; then the guide for agents. */
export const MENU: PageId[] = ["build-an-app", "run-a-server", "about", "sandboxes"];

/** The site's own pages beyond the guides. */
export const SITE_TOOLS: PageId[] = ["servers", "check", "viewer"];

/** A sandbox's pages, by what they're for. The viewer is the site's, opened on the sandbox. */
export const SANDBOX_GROUPS: { title: string; pages: (PageId)[] }[] = [
  { title: "Try it", pages: ["viewer", "tours", "explore", "check"] },
  { title: "Your app", pages: ["build", "connect", "activity", "trace"] },
  { title: "Under the hood", pages: ["config"] },
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
/** A page's address: in `base`'s sandbox for a sandbox page, and for a site page a sandbox links to, opened on it. */
export function hrefOf(id: PageId, base = ""): string {
  const p = PAGES[id];
  if (p.level === "sandbox") return `${base}${p.path}`;
  return p.sandboxParam && base ? `${p.path}?${p.sandboxParam}=${encodeURIComponent(base)}` : p.path;
}
