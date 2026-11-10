# Test times after (2026-11-10)

Same environment as `test-times-before.md`. To compare like with like, both columns below were run on the same commit (b2582ff) in a clean worktree: "before" as committed, "after" with only this change applied (tests/preload.ts, bunfig.toml, tests/app-check-client.ts, tests/llms-smoke.test.ts, e2e/layout.e2e.ts, e2e/browser.e2e.ts). Both unit runs have 1,069 tests and 36,155 expect() calls. The only failure in either is the `DEFAULT_POLICY_DB` test, which fails because of `DEMO_STORAGE` (see the before file).

## Totals

| Suite | Before | After | Saved |
|---|---|---|---|
| `bun test tests` | 203.4 s | 155.1 s | 48.3 s |
| e2e/client.e2e.ts | 39.3 s | 39.6 s | none (not changed) |
| e2e/browser.e2e.ts | 74.4 s | 63.3 s | 11.1 s |
| e2e/layout.e2e.ts | 41.6 s | 21.7 s (22.2, 22.3 on two reruns) | 19.9 s |
| e2e/spec.e2e.ts | 15.4 s | 16.9 s | none (not changed; noise) |
| e2e/app-check.e2e.ts | 24.4 s | 23.3 s | 1.1 s (its fetch-app test: 6.8 s to 4.9 s) |
| e2e together | 195.1 s | 164.8 s | 30.3 s |
| `bunx tsc -p ui/tsconfig.json` | passes | passes | |

## What saved the time

| Saved | Change |
|---|---|
| about 38 s, unit | tests/preload.ts (loaded by bunfig.toml): Orthanc's catalog is built for real by the first stack in a process, and later stacks publish the recorded studies into their own new catalogs. A full run starts a stack 42 times; a reused build takes 17-26 ms against 907-945 ms. policy-store alone: 13.1 s to 2.3 s. |
| about 10 s, unit | tests/app-check-client.ts retrieves the six studies at once, so their staged 2 s 503s are waited out together: app-check.test.ts 21.4 s to 9.3 s ("a compliant app" 14.2 s to 4.2 s, "ignores next" 6.0 s to 4.0 s). |
| about 1 s, unit | tests/llms-smoke.test.ts runs its three smoke.mjs runs at once (`test.concurrent`), each in its own sandbox: 9.7 s to 8.6 s. |
| 19.9 s, e2e | e2e/layout.e2e.ts runs desktop and phone at once (`test.concurrent`), each in its own context and sandbox. Every report still waits its 1.2 s. |
| 11.1 s, e2e | e2e/browser.e2e.ts: the four "no script or console errors, no sideways scrolling" tests load their five pages at once, each in its own context: about 4.4 s to 1.6 s each. |
| about 2 s, e2e | e2e/app-check.e2e.ts's fetch-app test, through the same tests/app-check-client.ts change. |

## Evidence the same code still runs

- Catalog reuse: a probe started two stacks and compared Orthanc's catalog (every study and its hierarchy, 95,361 characters of JSON): identical. A reused build is used only if every patient lookup the real build made gives the same answer in the new catalog, and only for builds `openCatalogs` makes. catalog.test.ts's three direct `catalogFromOrthanc` calls, including "it's built with QIDO-RS alone", still query Orthanc. `ORTHANC_CATALOG_EACH_TIME=1` turns reuse off.
- Concurrent retrievals: in "a compliant app", the run's progress reads `{"tokens":1,"searches":4,"retrievals":12}`: one 503 and three pages for the search, and six staged 503s plus six repeats. The test's `notes` stay `[]`, so none was repeated before Retry-After had passed and none was dropped.
- Layout: the largest layout shift in a report is 0.008 before and 0.005, 0.008 and 0.008 in three runs after (limit 0.03). One earlier concurrent run measured 0.016 for "desktop viewer load". Running at once can show more shift, not less.

## Slowest 15 unit files after (each run alone, so each still pays one real Orthanc build)

| s | File |
|---|---|
| 35.09 | tests/flows.test.ts |
| 25.63 | tests/metadata-bulk.test.ts |
| 22.50 | tests/spec-conformance.test.ts |
| 15.95 | tests/rotation.test.ts |
| 14.61 | tests/trace.test.ts |
| 9.31 | tests/app-check.test.ts |
| 8.70 | tests/llms-smoke.test.ts |
| 6.27 | tests/patients.test.ts |
| 3.53 | tests/explore.test.ts |
| 2.74 | tests/catalog.test.ts |
| 2.61 | tests/proxy-separate.test.ts |
| 2.53 | tests/tours.test.ts |
| 2.31 | tests/policy-store.test.ts |
| 2.24 | packages/core/tests/proxy-streaming.test.ts |
| 2.18 | tests/sandboxes.test.ts |

## Slowest 25 tests after (junit; hooks not included)

| s | File | Test |
|---|---|---|
| 20.22 | e2e/layout.e2e.ts | desktop (runs alongside phone) |
| 20.14 | e2e/layout.e2e.ts | phone (runs alongside desktop) |
| 16.44 | e2e/app-check.e2e.ts | our viewer, signed in as josh through every staged condition, meets every requirement |
| 11.02 | tests/metadata-bulk.test.ts | orthanc: every bulk link, at every level, gives exactly its element's bytes |
| 10.46 | e2e/browser.e2e.ts | changes nothing in the sandbox: every page only reads until someone acts |
| 10.19 | tests/flows.test.ts | orthanc: 11. Asking for image formats |
| 7.85 | tests/trace.test.ts | everything a flow does appears in its session |
| 7.64 | tests/llms-smoke.test.ts | with every condition an app check stages |
| 7.34 | tests/spec-conformance.test.ts | orthanc: the lossy exception is used or the data is decoded |
| 6.51 | e2e/browser.e2e.ts | the server check on a sandbox runs the checks only a sandbox can run |
| 6.48 | tests/metadata-bulk.test.ts | s3: every bulk link ... |
| 6.04 | tests/metadata-bulk.test.ts | static-files: every bulk link ... |
| 4.87 | e2e/app-check.e2e.ts | an app that ignores next links and builds its own addresses is graded so |
| 4.20 | tests/app-check.test.ts | a compliant app, driven by fetch, meets every requirement |
| 4.04 | tests/app-check.test.ts | an app that ignores next and builds its own addresses is graded so |
| 3.99 | e2e/browser.e2e.ts | activity, phone: tiles roll up each type ... |
| 3.43 | e2e/client.e2e.ts | from Connect to a picture, with the protocol shown |
| 3.35 | e2e/browser.e2e.ts | Explore, by keyboard ... |
| 3.21 | tests/rotation.test.ts | orthanc: each control alone leaves a path open ... |
| 2.71 | e2e/client.e2e.ts | on a phone, the picture is on the first screen |
| 2.66 | e2e/browser.e2e.ts | activity, desktop ... |
| 2.50 | e2e/spec.e2e.ts | retry: signs in, lists every study, shows an image |
| 2.47 | tests/trace.test.ts | no raw secret reaches a span ... |
| 2.37 | e2e/client.e2e.ts | a server described on Your servers ... connected with PKCE |
| 2.24 | e2e/client.e2e.ts | a confidential app registered on /connect signs in and proves its key |
