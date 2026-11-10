# What the site is now, and what could be simpler

November 2026, after the sandbox moved into the browser. Written to decide what to cut or merge, before more
changes.

## Pages

| Address | What it is | Notes |
|---|---|---|
| `/` | Your sandboxes: list, create | Only page at the root |
| `/s/{id}/` | Overview: the sandbox panel (name, share, delete), three paths, **and the viewer** | The viewer shares this address and the "Overview" menu item. Back from the viewer is confusing because of this |
| `/s/{id}/viewer` | The viewer's own address | Local commit `d805925`, not deployed |
| `/s/{id}/build` | Build a client: endpoints, sample logins | |
| `/s/{id}/connect` | Register an app | |
| `/s/{id}/tours` | Six policy stories, run step by step | |
| `/s/{id}/explore` | Pick a person or service, see what their app can see | |
| `/s/{id}/activity` | The activity log | |
| `/s/{id}/checks` | Eight protocol conformance checks | |
| `/s/{id}/servers` | Test your server: describe a server for the viewer | |
| `/s/{id}/trace/` | Live trace, span pages, log | Operator view, linked from Activity |
| `/llms.txt` | The guide for agents | |

## Ways a sign-in happens

1. **The viewer**, against this sandbox or your server: a real authorization code flow. The tab goes to the
   Authorization Server's picker and consent pages and back, so they're in the tab's history.
2. **Tours**: a real flow too. In automatic mode, the page walks the forms with `fetch`. In window mode, a
   popup.
3. **Explore**: no sign-in. The admin key mints the person's token.
4. **Agents and tests**: post the forms over HTTP.

A setting chooses automatic or window sign-in, and it affects only Tours.

## Server calls

- **Open:**
  - `POST /api/sandboxes`
  - `GET /api/sandbox/keys`
  - `GET /api/tours`
  - `POST /api/tours/{id}/start` at the root
  - `/api/activity*`
- **Admin token:** everything else under `/api/sandbox`:
  - settings: name, topology, storage, clock, reset, revoke, flush, rotate, faults
  - the policy API
  - clients
  - catalog
  - Explore's reads: cast, referrals, view, happened, rule-sets
  - tour steps: start, state, begin, finish
- **The SMART services:** discovery, authorize, token, FHIR, imaging FHIR, WADO-RS proxy.

## Things that exist mostly for history, or for tests

- **`src/flows`:** 16 server-side flows, 8 policy and 8 protocol, about 1,100 lines. No page runs them. Tests do, and the checks' titles come from them. The checks themselves were rewritten in `web/checks.js`.
- **Two policy models:** core's, which decides, and `src/reference-model.ts`, written apart from it for Tours' expectations and tests to check core against.
- **Seeded sandboxes:** `/s/~{encoded policy}`. Nothing in the pages or llms.txt uses them.
- **Three image stores:** static files, S3 and Orthanc, chosen in Settings. Proves the proxy works over each; most visitors won't care.
- **Topology:** separate or unified imaging server, in Settings.
- **The sign-in pages as plain forms:** needed so agents and tests can post them, not for browsers without script.

## Proposals

1. **The viewer is its own page,** at `/s/{id}/viewer`. The Overview is only the landing page: name, share, the three paths. "Try the viewer" goes to the viewer page, which has its own Connect, and its own place in the menu.
2. **Sign-in leaves no history.** Once the viewer has its own page, the viewer signs in in place, and finishes by replacing the sign-in steps in history (`location.replace` on return). The Authorization Server's pages stay plain forms, with no special script.
   - Or the viewer always signs in in a popup.
   - Either way, Back from the viewer lands on the landing page.
3. **One way to sign in, in Tours.** Drop the automatic or window setting. Tours walks the forms itself, and a person who wants to see the real pages can open them from the step.
4. **Move `src/flows` into the tests,** or replace them: the checks and stories now run from the pages, so the server needn't carry 16 flows.
5. **Drop seeded sandboxes,** unless you want shareable policy-in-a-URL.
6. **Hide or drop the Settings for image store and topology.** Keep them as management API calls for agents, but off the menu.

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

The home page asks who you are. Each audience has a short guide at the site's root, listing what matters for
its jobs, most important first, and linking to the pages that do them. The menu is just the guides, plus For
Agents: **Build an App · Run a Server · How It Works · Why It Matters · For Agents**.

- **Build an App:** get a sandbox; endpoints and sample logins; register; logs; the hard cases.
- **Run a Server:** what the server needs (advice and gotchas); register our viewer; add the server and
  connect; compare with a working sandbox and its logs; conformance (planned, issue #1).
- **How It Works:** the viewer on a sandbox; the parts; the Tour's stories; the live trace.
- **Why It Matters:** what it makes possible; watch it work; what it takes to implement.

Connectathon participants use the app and server guides. A registry of external test environments, and
connectathon support, come later.

A guide's links go to the sandbox you were last in. With none, the first link makes one.

### Inside a sandbox

A sandbox's pages show a trail, "Sandbox “name” › page", instead of sub-menus. The sandbox's home lists its
pages by what they're for: **Your app** (Start here, Register an app, Logs), **Try it** (Viewer, Tour, Explore),
**Your server** (Your servers, Conformance). Activity is called **Logs**.

**Sandbox Config** holds what makes the sandbox realistic, for the curious: the full policy editor, and the
settings (clock, storage, topology, resets, keys), out of the header.

### The viewer

Quiet and clean, with small annotations and details; it does this well already. It's both a reference client
and a demo.

It stays in a sandbox for now. A root viewer, with one fixed redirect URI to register with your server, needs
sign-in to work at the public root, which refuses it today.

### Cuts

- The Tours sign-in setting.
- `src/flows` moves into the tests.
- URL-seeded sandboxes.

### Order

1. The guides, the home page, the menu and the trail. Done, for Josh to look at.
2. Sandbox Config: the policy editor and settings, out of the header.
3. The sample-logins table shows each login's patients and studies.
4. The viewer at the root, with one redirect URI.
5. Cuts.
6. llms.txt, tests updated to the design, a screenshot review, then a deploy when Josh says so.
