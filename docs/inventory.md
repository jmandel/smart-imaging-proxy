# The site: who it's for, how it's built, and what's next

November 2026. The design settled with Josh, and the app as built.

## How it's built

- **One React and TypeScript app**, in `ui/`. `ui/sitemap.ts` lists every page: its address, level (the site's
  own, at the root, or every sandbox's, under `/s/{id}`), name and one-line purpose. Everything that lists pages
  reads it: the server's routes, React Router's routes, the header, a sandbox's bar and home page, the footer,
  and llms.txt (`src/llms-pages.ts`).
- **Served by Bun's HTML import.** `ui/index.html` is the entry; `uiRoutes()` in `src/demo-server.ts` serves it
  at every page's address, and Bun bundles it and serves its scripts and styles. A reload anywhere draws the same
  page, and React Router moves between pages in place.
- **Shared code** in `ui/lib/`: the management API with the sandbox's admin token (`api.ts`), what the browser
  remembers (`store.ts`, whose sandbox list every open tab sees change), the viewer's servers (`servers.ts`), the
  SMART Imaging client (`smart-imaging.ts`), and the client the server check acts with (`sandbox-client.ts`).
  The server check's steps and report are in `ui/check/`; its API for agents is `src/check-runs.ts`. The app
  check's grading is `src/app-check.ts`.
  Components shared by pages are in `ui/components/` (the layer chain, the image viewer, thumbnails).
- **Styles** in `ui/styles/`, and the trace's own in `ui/trace/trace.css`, scoped to its pages.
- **The trace service keeps only data:** its API, stream and span intake. Its pages are the app's, at `/trace/`,
  `/trace/span` and `/trace/log`.

## Ways a sign-in happens

1. **The viewer**, against a sandbox or your server: a real authorization code flow, in a tab of its own, which
   hands the code back to the viewer.
2. **The server check**: a real flow, whose forms the page walks itself with `fetch`.
3. **Explore**: no sign-in. The admin key mints the person's token.
4. **Agents and tests**: post the forms over HTTP.

## Purpose: who it's for, and what each part is for

Agreed with Josh, November 2026. The structure follows from this.

**Who it's for.** Equally, from the start:

- Connectathon participants, testing together.
- Vendors, app or server, on their own.
- People reading the spec, who want to see it work.
- Policy makers deciding whether to invest in imaging interoperability.
- AI agents, through llms.txt.

**The viewer** is both a reference client, so a server developer can tell a server bug from a client bug, and a demo of what an imaging app looks like. Neither role comes first.

**The sandbox** gives an app developer a realistic health system. The policy exists to make refusals, expiry and guardians behave like a real hospital's. It isn't a goal, and most visitors won't care about it. It's there for the curious, and for whoever runs a sandbox.

**Server developers** don't need our servers. But they're offered, from the pages they're already on:

- implementation advice and gotchas;
- what happened, in the logs.

**Agents** can use, and combine, everything the site does: build an app, test a server, explain the spec, drive the sandbox. Ordinary purposes and new ones alike. So every capability is an API first, and llms.txt documents it.

## Decided: the simpler site

Settled with Josh, November 2026. This replaces earlier plans.

### A guide for each audience

The home page shows what SMART Imaging adds, as one diagram, and the two ways in. The menu is the guides, your
sandboxes, and For Agents: **Build an App · Build a Server · Why SMART Imaging · My Sandboxes · For Agents**.

- **Build an App:** a wizard, one step at a time, with the step in the address: choose a sandbox, choose or
  register the app in place, see where to point it, then try it. It never sends you elsewhere to finish a step.
- **Build a Server:** the same wizard, for the other side, and the one page for your servers: the servers this
  browser has, right at the top, each to check, open in the viewer, edit or remove, with the wizard below it to
  add another (register our viewer with it, from the client metadata ready to copy, describe the server in
  place, then check it). Its last step hands the server to the server check. With none described, the page is
  the wizard alone. `/run-a-server` and `/servers` redirect here.
- **Why SMART Imaging:** what it makes possible, how it works (the diagram), see it work, what it takes.
- **My Sandboxes:** the sandboxes this browser made or joined, and Create.

Pages that hold a list open on the list (My Sandboxes, and Build a Server's); adding or editing is a step away,
in the address, and with nothing saved the page is the form. Numbered steps are kept for real
sequences: the wizards, the server check, an app check's script. Links to the logs from the middle of a task open in a
new tab, so the task keeps its place.

Connectathon participants use the app and server guides. A registry of external test environments, and
connectathon support, come later.

A guide's links go to the sandbox you were last in. With none, the first link makes one.

### Inside a sandbox

A sandbox's pages have its bar under the header: its name, and its pages by what they're for, the same groups
its home page and the footer list: **Try it** (Viewer, Explore, Server check, App check), **Your app** (Start here,
Register an app, Logs, Live trace), **Under the hood** (Sandbox Config). On a phone, the pages open from a button.
The Viewer is a page of the sandbox's own (`/s/{id}/viewer`), so the sandbox's bar stays around it; it's also the
site's at `/viewer`, for servers of your own. The Server check is the site's page, opened on the sandbox with
`?sandbox=`. There is no separate Conformance page: its old address opens the check.
Activity is called **Logs**.

**Sandbox Config** holds what makes the sandbox realistic, for the curious: the settings (clock, storage,
topology, resets, ending access), with room for the full policy editor still to come. Nothing is in the header.

### The viewer

Quiet and clean, with small annotations and details; it does this well already. It's both a reference client
and a demo.

It lives at the site's root, `/viewer`, beside **Build a Server**, and belongs to no sandbox. Its
own address is its redirect URI, the same for every server, and the sign-in tab it opens hands the code back to
it. A sandbox is one more server in its list, signed in to with the sandbox's built-in public client,
`demo-client`, whose one redirect URI is the viewer. A link from a sandbox opens the viewer with that sandbox
chosen. It signs in all three ways, to a sandbox or to your server: a public app with PKCE, a confidential
app with `private_key_jwt`, and a backend service.

### Surfaces for agents

Settled with Josh, November 2026. Each thing an agent can do is offered one way, so no second surface has to be
kept in step or second-guessed. There are three, each for a different job:

1. **The HTTP API, mapped by llms.txt.** Everything an agent can do, browser or not: a sandbox's state, its
   activity log (and in it, the steps a person takes), `contract.json`, check runs. A capability that exists
   only in the UI is a gap to close here, as per-study approval at sign-in was.
2. **Links.** How to hand a person an exact view, or put something in their browser: every state worth showing
   someone is a link. Browser-only data, such as Your servers, arrives by a link that fills in its form, with
   the values after `#` so they never reach the server, not by a JavaScript API.
3. **The pages, driven as a person would drive them.** By role and accessible name, with `html[data-ready]`
   once a page's data has loaded. Anything else a driver needs to read, such as a tab's session, is a plain
   attribute on the page, not a JavaScript object.

So there's no documented in-browser API: `window.sandboxApi` is a helper for this site's own tests. What a
person does is recorded once, on the server: the activity log holds the API calls each action makes, which is
enough to see what they did. Actions aren't named or tagged on top of that. `contract.json`'s `state` stays a small
read-only summary of what the management API owns, so "is this sandbox clean?" needs no token, and doesn't
grow into a second management API.

### Done

- The guides, the home page, the menu, the sandbox bar and the footer, from one site map.
- The viewer at the root, with one redirect URI.
- The whole UI rewritten as a React and TypeScript app.
- Sandbox Config, with the settings out of the header.

### Still to do

1. Sandbox Config's policy editor: see, edit, and named scenarios.
2. The sample-logins table shows each login's patients and studies.
3. Cuts: `src/flows` moves into the tests; URL-seeded sandboxes go (done).
4. More of the sandbox's checks against your own server, where a client alone can do them (issue #1).

#### What's in the address

The list llms.txt prints under "Links to a view" is `VIEW_LINKS` in `ui/drive.ts`. Pages that change their own
query stay mounted and follow it (`FOLLOWS_QUERY` in `ui/router.tsx`); a choice that leads the address by a
moment is held in the page too, so a radio changes as it's pressed.

| Page | In the address | Since |
|---|---|---|
| Build an App | `?step=`, `?app=` | before |
| Build a Server | `?step=` (`register`, `server`, `check`), `?how=` (the way the viewer connects), `?server=` | Nov 2026 |
| Server check | `?sandbox=`, `?server=`, `?run=` | before |
| Viewer | `?sandbox=` or `?server=`; `&connect` signs in at once, in the same tab | Nov 2026 |
| App check | `?app=`, `?run=` | before |
| Explore | `?user=&patient=`, or `?client=&referral=`; `&study=` for one opened | Nov 2026 |
| Register an app | `?type=` (the form's kind of app), `?app=` (one registered, brought into sight) | Nov 2026 |
| Logs | `session`, `type`, `study`, `link`, `sandbox`, `trace`, `event` | before |
| Live trace | `?session=` (held still on), `&span=` (its preview open) | Nov 2026 |
| HTTP log | `?session=&trace=`, and `&filter=` | `filter` since Nov 2026 |
| Sandbox Config | `?panel=` (scrolled to it) | Nov 2026 |
| Endpoints, Home pages, My Sandboxes | nothing: no state of their own | |

Nothing in a link is secret beyond the sandbox's URL: a saved server is named by its address and client ID, and
opens only in the browser that saved it.

#### For a browser that drives the site

- **Each page's HTML** has its title, a `<meta name="description">` from the site map, `<link rel="help">` to
  llms.txt (the sandbox's own in a sandbox), and a short `<noscript>` note. `uiRoutes()` reads Bun's bundled
  shell from `/_shell` and fills these in per page; in production the shell is read once, in development each
  time, so hot reload still works. Its ETag is of the page as sent.
- **`html[data-ready]`** is `ui/lib/ready.ts`. The router drops it as the address changes; it comes back once
  the page at that address is drawn and every `useReady(done)` in it is done. A page with no data of its own
  needs no call.
- **Controls by role and name**: `CONTROLS` in `ui/drive.ts`, printed in llms.txt, and found one by one by
  `e2e/drive.e2e.ts`. Radios and person buttons are named by their label alone, their line below as the
  description (`Choice` in `ui/lib/format.tsx`), so a name stays short when its description changes.
