// What an agent driving the site in a browser can count on: the views an address opens, and the controls it can
// find by role and accessible name. llms.txt's tables are written from these, and an e2e test finds every control
// listed, so the tables, the pages and the test can't drift apart.
import type { PageId } from "./sitemap";

/** A view that an address opens, exactly, on a reload or in someone else's browser. */
export interface ViewLink { page: PageId; query: string; opens: string }

/** `{x}` in a query stands for a value to fill in. A sandbox page's address is under `$SANDBOX`. */
export const VIEW_LINKS: ViewLink[] = [
  { page: "build-an-app", query: "?step=try&app={client id}", opens: "The wizard at a step (`sandbox`, `app`, `connect`, `try`), with an app chosen" },
  { page: "run-a-server", query: "?how=confidential", opens: "Registering the viewer as a `public`, `confidential` or `backend` client" },
  { page: "servers", query: "?add&how=backend", opens: "The form for a new server, with a way of connecting chosen" },
  { page: "servers", query: "?edit={iss}|{client id}", opens: "The form for a saved server" },
  { page: "check", query: "?sandbox=/s/{id}", opens: "The server check, run on a sandbox; `?server={iss}|{client id}` runs it on a saved server" },
  { page: "check", query: "?run={run id}", opens: "A server check an agent started" },
  { page: "viewer", query: "?sandbox=/s/{id}&connect", opens: "The viewer with a sandbox chosen; with `connect` it signs in at once, in the same tab. `?server={iss}|{client id}` chooses a saved server" },
  { page: "app-check", query: "?app={client id}", opens: "An app check set up for an app; `?run={run id}` opens a run" },
  { page: "tours", query: "?tour={tour id}", opens: "A story, as it stands in this sandbox" },
  { page: "explore", query: "?user=sam-caregiver&patient=riley-example", opens: "A person looking at someone's studies; `&study={study id}` opens one" },
  { page: "explore", query: "?client={service id}&referral={referral id}", opens: "A service working from a referral" },
  { page: "connect", query: "?type=backend", opens: "The form with a kind of app chosen; `?app={client id}` shows a registered app" },
  { page: "activity", query: "?session={session}&type=searches&study={study id}", opens: "The log filtered by session, `type`, `study`, `link` and `sandbox`; `&event={seq}` opens one event" },
  { page: "trace", query: "?session={session}&span={span id}", opens: "The live trace held on one session, with a span's preview open" },
  { page: "trace-span", query: "?session={session}&span={span id}", opens: "One HTTP exchange in full" },
  { page: "trace-log", query: "?session={session}&trace={trace id}&filter={text}", opens: "A trace's HTTP log, filtered" },
  { page: "config", query: "?panel=clock", opens: "The settings, scrolled to one panel: `storage`, `topology`, `clock`, `reset` or `end`" },
];

/** Where a control is found: the state a page is in when it shows it. The e2e test opens each of these. */
export type Where =
  | "sandboxes" | "wizard" | "register" | "registered" | "servers-form" | "server-check" | "app-check-setup" | "app-check-run"
  | "tour-preview" | "tour-run" | "viewer" | "sign-in" | "consent" | "explore" | "view-link";

/** A control. `{x}` in its name is the name of the thing itself, as `NAMED` says. */
export interface Control { where: Where; page: string; control: string; role: string; name: string }
export const NAMED: Record<string, string> = {
  app: "the app's name", sandbox: "the sandbox's name", person: "the person's name, as under Sample accounts", first: "a person's first name, or a service's name",
};

export const CONTROLS: Control[] = [
  { where: "sandboxes", page: "My Sandboxes", control: "Make a sandbox", role: "button", name: "Create a sandbox" },
  { where: "wizard", page: "Build an App", control: "A step, once it can be reached", role: "link", name: "Your app" },
  { where: "wizard", page: "Build an App", control: "The next step", role: "button", name: "Next: Your app" },
  { where: "register", page: "Register an app", control: "Its name", role: "textbox", name: "App name" },
  { where: "register", page: "Register an app", control: "Its kind", role: "radio", name: "Confidential app" },
  { where: "register", page: "Register an app", control: "Its redirect URI", role: "textbox", name: "Redirect URI" },
  { where: "register", page: "Register an app", control: "Register it", role: "button", name: "Register" },
  { where: "registered", page: "Register an app", control: "Sign in as it in the viewer", role: "button", name: "Try it in the viewer" },
  { where: "registered", page: "Register an app", control: "Remove it", role: "button", name: "Remove {app}" },
  { where: "servers-form", page: "Your servers", control: "The server's FHIR base", role: "textbox", name: "FHIR base URL" },
  { where: "servers-form", page: "Your servers", control: "Read its discovery", role: "button", name: "Check discovery" },
  { where: "servers-form", page: "Your servers", control: "How the viewer connects", role: "radio", name: "Backend service" },
  { where: "servers-form", page: "Your servers", control: "The viewer's client ID there", role: "textbox", name: "Client ID" },
  { where: "servers-form", page: "Your servers", control: "Save it, then check it", role: "button", name: "Save and check" },
  { where: "server-check", page: "Server check", control: "Sign in, when the check stops for it", role: "button", name: "Sign in to continue" },
  { where: "server-check", page: "Server check", control: "Run it again", role: "button", name: "Run again" },
  { where: "app-check-setup", page: "App check", control: "The app to grade", role: "radio", name: "{app}" },
  { where: "app-check-setup", page: "App check", control: "Start grading", role: "button", name: "Start the run" },
  { where: "app-check-run", page: "App check", control: "Stop and grade", role: "button", name: "End the run and grade" },
  { where: "tour-preview", page: "Tour", control: "Run the chosen story", role: "button", name: "Run this story" },
  { where: "tour-run", page: "Tour", control: "Run the next step", role: "button", name: "Run" },
  { where: "tour-run", page: "Tour", control: "Run every step left", role: "button", name: "Run the rest" },
  { where: "viewer", page: "Viewer", control: "The server to connect to, such as a sandbox", role: "radio", name: "{sandbox}" },
  { where: "viewer", page: "Viewer", control: "Connect", role: "button", name: "Connect" },
  { where: "sign-in", page: "Sign-in (Authorization Server)", control: "The account", role: "radio", name: "{person}" },
  { where: "sign-in", page: "Sign-in (Authorization Server)", control: "Sign in", role: "button", name: "Continue" },
  { where: "consent", page: "Consent (Authorization Server)", control: "Whose records", role: "radio", name: "{person}" },
  { where: "consent", page: "Consent (Authorization Server)", control: "Allow the app", role: "button", name: "Approve" },
  { where: "consent", page: "Consent (Authorization Server)", control: "Refuse it", role: "button", name: "Deny" },
  { where: "explore", page: "Explore", control: "A sample person, or a service", role: "button", name: "{first}" },
  { where: "view-link", page: "Explore, Logs, Live trace", control: "Copy the address of the view shown", role: "button", name: "Link to this view" },
];
