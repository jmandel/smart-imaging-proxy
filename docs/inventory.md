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

## Decided: the simpler site

Settled with Josh, November 2026. This replaces earlier plans.

### Menu inside a sandbox: Sandbox · Build an App · Test a Server · For Agents

The two sides are named by what the visitor is doing, so neither reads backwards.

**Sandbox** is what the sandbox is, and its first page is the landing page, where Back lands.

- **Data:** every patient, study and image, with no sign-in, as the operator sees them. The admin token can search and retrieve every study: a built-in rule for the admin client only.
- **Policy:** the rules, relationships, shares and app approvals, in plain words. Each part is editable through the policy API, and named scenarios set the whole document.
- **Settings:** the demo clock, image storage, topology, resets, ending access, and key rotation. There's no Settings button in the header.
- **Explore:** see what a person's app or a service sees, and why. Kept apart from Data: Data is what exists, Explore is one viewpoint on it. Revisit once Data is built.
- **Tour:** the guided stories. They always walk the sign-in forms themselves.
- **Activity:** everything that happened in the sandbox.

**Build an App** is for people building a client, against our servers: **Start here** (endpoints, sample logins) and **Register an app**.

**Test a Server** is for people with a server, using our client:

- **Viewer:** our general SMART app, against this sandbox or any server. Sign-in opens in a new tab. The redirect page posts its address back, and the viewer redeems the code, so its tab never navigates.
- **Your servers:** adding and editing servers for the viewer.
- **Conformance:** the checks, run by our client against a server. This sandbox now; yours later (issue #1).

### Cuts

- The Tours sign-in setting.
- `src/flows` moves into the tests.
- URL-seeded sandboxes.
- Sub-menus stay, one per area.

### Order

1. Menu, the viewer page and its sign-in tab, and Test a Server. Done.
2. Data, with the admin client's rule.
3. Settings, out of the header.
4. Policy, with scenarios.
5. Cuts.
6. llms.txt, tests updated to the design, a screenshot review, then a deploy when Josh says so.
