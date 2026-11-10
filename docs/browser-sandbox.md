# The sandbox, driven from the browser

Settled with Josh, November 2026. Explore and Tours become browser apps. The page is a SMART Imaging client
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

## Progress

Done, committed locally, not yet deployed:

1. Per-sandbox keys and the admin client (`src/sandbox-keys.ts`).
2. The admin token on everything under `/api/sandbox`, the policy API at `/api/sandbox/policy/*`, and `GET /api/sandbox/keys`. Documented in llms.txt.
3. `web/smart-imaging.js`, shared by the demo app and Explore.
4. Explore in the browser. Its reads are under `/api/sandbox/explore/*`. `/api/explore/*` is gone.
- App approvals on file: Josh, and Sam for Sam and Riley, at every site.
- `traceSettled` waits for sends already in flight.

## Tours, in the browser

Each step is split three ways:

- **begin**, `POST /api/sandbox/tours/{id}/steps/{step}/begin`. The server computes the intended policy and the model's expected answer before anything happens. It does what only the sandbox does, such as moving the demo clock, and returns a **plan** and a trace id.
- **the action**, in the page, under the tour's trace session and that trace id. Plans:
  - `sign-in`: a real authorization code flow with PKCE as portal-app. Automatic mode walks the sign-in and consent forms. Window mode uses a popup, and the callback page posts its URL to the opener.
  - `search`, `retrieve`
  - `service-search` and `service-retrieve`, with the service's own key
  - `management`: policy API calls
  - `referral-check`
- **finish**, `POST .../finish {observed}`. The server turns what the page saw into the step's answer, as `act` did. It checks the store against the intended policy, and counts the step's events by its trace.

Tokens live only in the page. The server's run state keeps only what checks need: token expiry, which studies search found with their signed addresses, when it signed them, and each step's pick.

## Run checks, in the browser

Each of the eight protocol checks becomes a page-side scenario in its own new sandbox. Faults are management calls that set and clear them:

- `POST /api/sandbox/faults` `{"decisionOutage":true}`
- `POST /api/sandbox/faults` `{"truncateAfter":N}`

## Cleanup still to do

- Remove the HTTP flow runner: `/api/flows`, `/api/flow-state`, `/api/session`. No page uses them. `src/flows` stays as the tests' own harness.
- Remove the server-side tour runner and window callbacks once Tours runs in the page.
- Browser tests for Tours and checks.
- Screenshots at desktop, 390 px and 320 px. Then one deploy.
- Explain on the deployed site that saved sandboxes made before this have no app approvals on file until Reset.
