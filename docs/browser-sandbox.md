# The sandbox, driven from the browser

Settled with Josh, November 2026. Explore becomes a browser app. (Tours were removed later: what's left of this
plan is Explore, the server check and the app check.) The page is a SMART Imaging client
like the demo app. Sandbox setup and policy go through one documented management API, which the sandbox's
admin key controls. No server endpoint does protocol work on a page's behalf.

## What each part is

| Part | Today | After |
|---|---|---|
| Acting as a person in Explore | The server walks the sign-in and consent forms, and holds the token | The sandbox admin key mints a token for a user, patient and app. The page holds it |
| The three backend services | Site-wide keys. The server signs their assertions | Regular Backend Services clients, each with its own key per sandbox, derived from the sandbox ID. The page signs |
| Search, Endpoints, thumbnails, viewer, whole-study retrieval | The server, through `/api/explore/*` | The page, with the demo app's code, against the sandbox's FHIR and WADO-RS |
| Shares, stop sharing, stop the app, app site approvals in Explore | The server posts the account pages | The management API |
| A tour's grant (the app approval a story turns on) | The server walks sign-in and consent | A real authorization code flow in the browser: sign-in, consent, code, token |
| A tour's rules, sharing policies, shares, clock | The server writes them directly | The management API |
| The "why" diagram, a tour's expected answer, the proxy's decision | Built on the server | Read-only management calls, which never take a token |
| Checks that need a fault (decision service down, an image store stopping partway) | The server sets the fault | Management calls that set and clear the fault |

## The admin key

- Each sandbox has an admin client, a SMART Backend Services client whose ES256 key is derived from the sandbox ID.
  The sandbox's URL is already its access, so this gives no one more than the URL does.
- The admin key gets tokens with `client_credentials` and a signed assertion, as any backend service does.
  - **Scope `sandbox/admin`** is for the management API.
  - **Acting as someone** adds sandbox-only parameters: `user`, `patient` and `app` for a person, giving a token as that app would get at sign-in.
- The management API takes the admin token as its bearer token. It is the policy API (`/policy/v2`: relationships,
  policies, shares, app approvals, explain), the sandbox settings (`/api/sandbox`), and the read-only explanations.
- The page gets the admin private key from the sandbox as sample credentials, and llms.txt documents all of it.

## Order of work

1. Per-sandbox keys: the admin client and the three services, derived from the sandbox ID.
2. The admin token, and the management API behind it, documented in llms.txt.
3. A shared browser module, `web/smart-imaging.js`, taken from the demo app: PKCE, assertions, retries, search
   paging, Endpoint resolution, WADO-RS retrieval.
4. Explore in the browser. Delete `/api/explore/*` protocol routes and server sessions.
5. Tours in the browser: steps, checks against the reference model's answers, and faults. Delete the server flow
   runner where nothing uses it.
6. Tests at each step, then one deploy.

## Status

All of it is done:

- Each sandbox's keys, and its admin client.
- The admin token on everything under `/api/sandbox`, with the policy API behind it.
- `web/smart-imaging.js` and `web/sandbox-client.js`.
- Explore, the tour stories, and the eight protocol checks, all run in the browser.

The server's Explore sessions, tour actions, check runner and HTTP flow runner are gone. `src/flows` stays as the tests' own harness.

Stores saved before app approvals were on file get them once, the first time they're opened.

What changed for people using the site:

- Explore no longer shows a sign-in. Its tokens come from the admin key. Tours and the demo app still sign in for real.
- The viewer's sign-in tab hands its address back to the viewer, which checks the state, so a forged redirect is ignored. Tours and Conformance walk the sign-in forms themselves.
- The redirect's own request isn't tied to a trace session, because no server flow is waiting for it any more.
