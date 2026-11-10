# Test times before (2026-11-10)

All runs: `DEMO_PORT_OFFSET=3100 DEMO_STORAGE=$HOME/hobby/.agent-scratch/run-1 DEMO_TAILNET=0`, bun 1.4.3, one at a time.

## Totals

| Suite | Wall |
|---|---|
| `bun test tests` (1,067 tests, 46 files, 36,147 expect() calls) | 209.0 s |
| e2e/client.e2e.ts (25 tests) | 41.7 s |
| e2e/browser.e2e.ts (38 tests) | 74.5 s |
| e2e/layout.e2e.ts (2 tests) | 41.5 s |
| e2e/spec.e2e.ts (10 tests) | 15.3 s |
| e2e/app-check.e2e.ts (2 tests) | 24.6 s |
| e2e together | 197.7 s |

One unit test fails in every run, before and after, because of the required environment: policy-store's "the configuration comes from the environment" expects `DEFAULT_POLICY_DB` to be `/tmp/smart-imaging-demo/policy.sqlite`, and `DEMO_STORAGE` moves it to `run-1/policy.sqlite`. It passes without `DEMO_STORAGE`.

## Startup cost, measured

`startStack(root)` takes 1.28-1.37 s, and `stop()` takes 0-1 ms (probe: three starts in a row). Of that, the archive catalog's rebuild takes 11-12 ms and Orthanc's catalog build takes 920-980 ms: about 55 QIDO-RS queries, sequential, where an instance-level query averages 19 ms and one takes about 210 ms. Issuing all 54 at once takes 1.24 s instead of 0.87 s, so Orthanc, not the client, is the limit. A full unit run starts a stack 42 times (counted by instrumenting the build), so Orthanc's catalog build is about 39 s of the 209 s.

## Slowest 15 unit files (each run alone, wall clock including hooks and bun's start)

| s | File | Why |
|---|---|---|
| 36.5 | tests/flows.test.ts | 30 flows and variants x 3 backends. 10.0 s is one test, orthanc "11. Asking for image formats": its "lossy exception" step asks for the whole-slide study as Explicit VR LE, which Orthanc answers by decoding every JPEG Baseline tile (static-files and s3 answer the same step with a quick 406: 0.86 s and 1.05 s for the whole flow). The rest is about 0.5-1.4 s per flow, real HTTP work. |
| 26.8 | tests/metadata-bulk.test.ts | "every bulk link" fetches each of 771 bulk links per backend (2,313 in all) and every series. Instrumented: series retrievals 8.8 s, bulk fetches 13.3 s of wall at about 5.8 ms a link. Raising the test's concurrency from 6 to 16 or 32 changes nothing (24.8, 24.6, 25.1 s), so the cost is CPU in the proxy and backend serving each link (for a zstd object the archive backend decodes from the object's start up to the element, per link); the test's own walking and hashing is 0.6 s. |
| 23.4 | tests/spec-conformance.test.ts | 7.8 s is orthanc "the lossy exception is used or the data is decoded": the same slide-as-EVRLE request, decoded by Orthanc. The rest are 0.3-1.3 s retrievals across three backends. |
| 21.4 | tests/app-check.test.ts | Real waits for staged 503s, run one after another. "a compliant app" (14.2 s): the app check stages `Retry-After: 2` on the first search and on each of 6 studies' first retrieval, and tests/app-check-client.ts retrieved the six studies one at a time, so 7 x 2 s of sleeping. "ignores next" (6.0 s): one search and 2 studies, 3 x 2 s. |
| 20.4 | tests/rotation.test.ts | 5 stack starts (about 5 s); the rest is full-study retrievals through the proxy repeated under each control, 3 backends. |
| 14.1 | tests/trace.test.ts | Runs flows end to end, plus fixed sleeps that let spans reach the collector: about 4.6 s of sleeps (150 ms per run(), 7 runs; 150 ms per flow in "everything a flow does", 15 flows; 200-250 ms elsewhere). |
| 13.1 | tests/policy-store.test.ts | 14 stack starts, about 0.9 s each, nearly all Orthanc's catalog build; the tests themselves take milliseconds. |
| 9.7 | tests/llms-smoke.test.ts | The faults run (7.6 s) is node running smoke.mjs against `Retry-After: 1` on the first search and each of 6 retrievals, which smoke.mjs waits out one study at a time (7 x 1 s). The plain run is about 1 s. |
| 7.1 | tests/patients.test.ts | Flow 2 for each person Sam can act on (1.9 s), the generator's rebuild (1.0 s), one stack start. |
| 3.8 | tests/explore.test.ts | One stack start plus 30 small HTTP tests. |
| 3.0 | tests/catalog.test.ts | Builds Orthanc's catalog 3 more times for real (about 1 s each, deliberate: it tests that build). |
| 2.9 | tests/proxy-separate.test.ts | Starts the roles as separate processes and polls until they answer (1.8 s). |
| 2.7 | tests/tours.test.ts | One stack start, tours run end to end. |
| 2.4 | tests/sandboxes.test.ts | One stack start; 70 seed sandboxes; idle-drop timers (25 ms waits, tested). |
| 2.2 | packages/core/tests/proxy-streaming.test.ts | 64 streaming tests against a fake backend. |

Every other file takes 0.01-2 s; for most of those with a stack, about 1 s is its one stack start.

## Slowest 25 tests (unit and e2e, from junit; hooks not included)

| s | File | Test | Why |
|---|---|---|---|
| 20.02 | e2e/layout.e2e.ts | desktop | 13 reports, each a fixed 1.2 s `waitForTimeout` so late layout shifts are counted (15.6 s of waiting), plus 1.0 s more of fixed waits. The wait is what's tested. |
| 19.89 | e2e/layout.e2e.ts | phone | The same, at phone size, run after desktop. |
| 16.23 | e2e/app-check.e2e.ts | our viewer ... meets every requirement | Our viewer opens 6 studies one after another by click, each waiting out a staged `Retry-After: 2`, after a search that waits 2 s too: 14 s of the product's staged waits. |
| 14.22 | tests/app-check.test.ts | a compliant app, driven by fetch ... | 7 sequential 2 s Retry-After waits (above). |
| 13.33 | tests/metadata-bulk.test.ts | orthanc: every bulk link ... | Serving 771 bulk links, CPU bound in proxy and backend (above). |
| 10.76 | e2e/browser.e2e.ts | changes nothing in the sandbox | 11 sandbox pages, each in a new context and each waited to `networkidle` (at least 500 ms with no requests), then the policy compared. |
| 10.01 | tests/flows.test.ts | orthanc: 11. Asking for image formats | Orthanc decoding the slide to EVRLE (above). |
| 7.80 | tests/spec-conformance.test.ts | orthanc: the lossy exception ... | The same Orthanc decode. |
| 7.61 | tests/trace.test.ts | everything a flow does appears in its session | Runs all 15 flows, with 150 ms after each so a stray span would arrive before the check (2.25 s of the 7.6 s). |
| 7.59 | tests/llms-smoke.test.ts | with every condition an app check stages | 7 sequential 1 s waits in smoke.mjs (above). |
| 7.33 | tests/metadata-bulk.test.ts | s3: every bulk link ... | As orthanc, CPU bound. |
| 6.81 | e2e/app-check.e2e.ts | an app that ignores next links ... | The fetch app's search wait and 2 sequential retrieval waits, 3 x 2 s. |
| 6.53 | e2e/browser.e2e.ts | the server check on a sandbox ... | Runs the sandbox's whole server check in the page. |
| 6.20 | tests/metadata-bulk.test.ts | static-files: every bulk link ... | As above. |
| 6.04 | tests/app-check.test.ts | an app that ignores next ... | 3 sequential 2 s waits. |
| 4.57 | e2e/browser.e2e.ts | desktop dark: no script or console errors ... | 5 pages, each a new context waited to `networkidle`. |
| 4.55 | e2e/browser.e2e.ts | desktop light: ... | The same. |
| 4.42 | e2e/client.e2e.ts | from Connect to a picture, with the protocol shown | Sign-in in a popup, search, image decode in the page. |
| 4.25 | e2e/browser.e2e.ts | phone dark: ... | 5 pages to `networkidle`. |
| 4.21 | e2e/browser.e2e.ts | phone light: ... | The same. |
| 4.12 | e2e/browser.e2e.ts | activity, phone: tiles roll up each type ... | Runs flows to fill the activity, then drives the page. |
| 3.27 | e2e/browser.e2e.ts | activity, desktop: ... | The same. |
| 3.25 | tests/rotation.test.ts | orthanc: each control alone leaves a path open ... | 14 full-study retrievals through the proxy from Orthanc. |
| 3.10 | e2e/browser.e2e.ts | Explore, by keyboard: ... | Many page steps, each waiting for a view to load. |
| 3.10 | tests/rotation.test.ts | a rotation survives a restart | Two file-backed stack starts and a restart of the shared one (3 starts, about 2.8 s). |
