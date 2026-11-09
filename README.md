# SMART Imaging Proxy

A working prototype of a SMART Imaging deployment: an Authorization Server, an Imaging Server holding policy and a study catalog, and a WADO-RS proxy that enforces study-level policy without holding any of it. It runs on ten studies across three patients. It implements the `focused-access-updates` branch of the [SMART Imaging Access guide](https://github.com/argonautproject/smart-imaging). It isn't production code.

The proxy, its backends, the archive, and the Imaging Server are a package of their own, [`packages/core`](packages/core/README.md), which knows nothing of the demo. The demo around it supplies the sign-in, the pages, the tours, the activity log and live trace, and the configuration.

## Get running

You need Bun (developed on 1.4.3), DCMTK (`dcmconv`, `dcmcjpeg`, `dcmodify`), `curl`, `tar`, and `unzip`. No containers: the S3 store ([RustFS](https://github.com/rustfs/rustfs)) and [Orthanc](https://www.orthanc-server.com/) run as plain processes, from release binaries the setup downloads and checks against pinned SHA-256 hashes. Orthanc's builds are for Linux on x86-64; elsewhere its backend reports itself unavailable. Allow roughly 3 GB of disk, an estimate from one machine's copy.

```sh
git clone https://github.com/jmandel/smart-imaging-proxy && cd smart-imaging-proxy
bun run up      # sets everything up, starts it in the background, and prints the URLs
bun run down    # stops the demo, the S3 store, and Orthanc, keeping their data
```

`bun run up` checks for the tools above, then runs each step below. The first run downloads about 750 MB of sample data. Later runs skip finished work, and restart a running demo so it serves the current code. Its log is `/tmp/smart-imaging-demo/demo.log`.

The same steps, one at a time:

```sh
bun install             # links the core package, and installs the browser test driver
bun run fetch-data      # downloads the sample data, verifying checksums
bun run ingest          # generates the synthetic studies, and builds the archive
bun scripts/backends.ts fetch   # downloads RustFS and Orthanc, checking their hashes
bun run viewer-kit      # downloads viewer-kit, checking its hash and every file's
bun scripts/backends.ts start   # runs both in the background, on loopback
bun run load            # copies the archive to the S3 bucket, and adds any study Orthanc lacks
bun run start           # builds any empty catalog, then prints the URLs, in the foreground
```

Each step is safe to repeat. Everything except the downloads lives under `/tmp/smart-imaging-demo` by default, so after a reboot, run `bun run up` again.

Then open http://127.0.0.1:4605/ and try these:

1. **The tours:** the home page, six stories as cards, each drawing the layer chain it ends on. Choosing one starts it, set up, in a sandbox of its own.
2. **Josh, the patient:** Explore opens on Josh, with all six of his studies, each with a thumbnail decoded in the page. Open one, retrieve it through the proxy, and follow its line into the activity log.
3. **Sam, a patient and a guardian:** "Whose records" switches between Sam's own and Riley's, as guardian. Each choice is a real new sign-in and search. Josh's aren't Sam's until Josh shares: choose Josh under Others, and the page offers Josh's share.
4. **A service:** picks a referral to work from, and gets a `403` until the page applies the service-access policy the referral needs.

## What's at each URL

Every service listens on `127.0.0.1`. If Tailscale is running, each one also listens on the tailnet IP and uses that IP in the URLs it issues, such as redirects and `Endpoint.address`.

Everything is at one origin, port 4605: the demo's pages, the live trace at `/trace/`, the clinical FHIR base at `/fhir`, and the Imaging Server at `/imaging/fhir`. Each service also keeps its own port. `DEMO_ONE_ORIGIN=0` gives people and apps those ports instead, the way separate systems would be deployed. Either way, each service answers CORS, so a browser app on another origin can call it.

| Port | Service | Paths |
|---|---|---|
| 4600 | Demo | `/` the tours, `/explore` Explore, `/activity` the activity log, `/api/activity/summary` its rollups, `/api/flows/...` the flows |
| 4601 | WADO-RS proxy | `/wado/{signed-context}/studies/...`, opaque to clients |
| 4602 | Imaging Server | `/fhir/ImagingStudy`, `/fhir/metadata`, `/access/v1/evaluation`, `/policy/v2/...`, `/.well-known/jwks.json`, `/.well-known/authzen-configuration` |
| 4603 | Authorization Server | `/fhir/.well-known/smart-configuration`, `/authorize`, `/token`, `/introspect`, `/revoke`, `/account`, `/fhir/Patient/{id}` (with a token for that patient) |
| 4604 | Live trace | `/` viewer, `/span.html` full exchange, `/log.html` HTTP log, `/api/sessions/{id}/export` |
| 4605 | One origin | `/imaging/...` Imaging Server, `/wado/...` proxy, `/trace/...` live trace, `/fhir/...`, `/authorize`, `/token`, `/introspect`, `/revoke`, and `/account` Authorization Server, and everything else the demo |
| 4610 | S3 store (RustFS) | Loopback only |
| 4611 | Orthanc | Loopback only |

`/s/{sandbox}` in front of any of these paths, on any of these ports, reaches a [sandbox](#sandboxes) instead.

- **The layer chain:** one component, `web/layers.js`, drawn from data the server computes with core's own model (`src/chain.ts`). Each row is a sentence at its level: a fact on file (a square), a rule the imaging network set (a diamond), or a person's choice (a circle), hollow when it's missing. Under it, one box per study, marked with its modality, in its site's column, filled when that row itself holds or grants the study. The last row is the outcome: what the app can see, or what a service found. A viewer's chain, in Explore, holds only the studies they may know of, never counts a patient's studies, and names no label. A narrator's, on the tours, shows a labeled study with a lock and a fact row of its own.
- **Explore:** at `/explore`, pick a person or a service, and for a person holding more than one record, whose records: the ones they hold, and apart from them, others' they don't. A service picks a referral, grouped by patient. The demo server runs a real launch, or for a service the work it starts from, then a real search, holding the token itself. It opens on Josh. The headline says what they can see, and the layer chain shows why. Studies are film sheets, with thumbnails decoded in the browser. A study a route reaches and the app doesn't shows as withheld, with its reason, and one no route reaches never shows. An empty view offers one next action first: a share, an approval, a service-access policy, another referral, or someone else's records. Sign-in is automatic, or, chosen in the settings menu, in a window that only a Sign in button opens. Opening a study retrieves it on request, and says in one line what happened, from the recorded events, with a link to them in the activity log. At `/explore` it works on saved policy, and at `/s/{sandbox}/explore`, on that sandbox's.
- **Services work from referrals:** the demo makes a consult referral for each sample study with an accession number: a `ServiceRequest` whose `subject` is the patient on the clinical FHIR server, as an absolute reference, and whose `supportingInfo` cites the imaging report, which carries the order's accession number with its system. The service checks the reference is on the FHIR base it's authorized for, searches `ImagingStudy?patient={reference}&identifier={system}|{accession}`, and retrieves. Its service-access policy decides what it sees. The page gets the referrals only once a service is chosen, from `/api/explore/referrals?service={id}`, so no person's view is sent a study's title.
- **Tours:** the home page, at `/`. Six stories: Josh sees his own records, a guardian at 15, each link narrows, revoking a share, a service with a referral, and Riley turns 18. Each card draws the chain the story ends on, from the policy on file with the story's rows added. Choosing one runs it in a sandbox minted for it, where the chain shows as it is now, and again on a step that changes it. A step is an action. What it should come to is computed before it runs by a reference model, `src/reference-model.ts`, written apart from core's evaluation, from the sandbox's policy and catalog at that moment, or for a step that changes policy, from the policy it intends. The step passes when the system's real answer matches, and for a step that changes policy, when the store then holds the policy it intended. Run checks runs the protocol flows, each in a sandbox of its own with its usual choices, as one pass or fail list. A person can sign in in a real window, and an automated run never opens one.
- **Settings menu:** in the header of every page: how people sign in, kept in the browser, and for the sandbox the page is in, where images come from, the demo clock, resetting policy, and ending access (revoking tokens, flushing decisions, rotating the key).
- **Activity log:** at `/activity`, in the header of every page. At a glance, a tile per type of event with its numbers rolled up (tokens by client, studies returned and withheld, proxy checks instant or by decision call, retrievals' parts and bytes, allows and denials, policy writes, and errors and denials), and a timeline laned by party. Below, one row per session or tour run, with who, which app or service, when, and its totals: choosing one filters the page to it. Choosing a tile lists that type as a table with its own columns, newest first, a page at a time. A policy write and a decision wear their level's mark. A row opens the event: its fields, the values it shares with other events, its raw payload, and the exchange behind it, with JWTs and signed links decoded, bundles laid out, multipart responses as parts, and tokens only as hashes. Filters are in the query string, `session`, `type`, `study`, `trace`, `link` and `scope`, so Explore and the tours link here filtered to a session, a study or a step. The rollups come from `/api/activity/summary`, over the newest 10,000 matching events.
- **One session's activity is its viewer's:** with a session, the log, its rollups, Explore's one line and a tour step's count show what the person or service the session acts as may see, all through one filter (`src/viewer-events.ts`). A study their routes don't reach, or one a label keeps from them, appears nowhere in it: not by id, title, site, label or reason, not in a count, and not in the exchanges its events open. Every session at once is the operator's view, which alone links to the live trace.
- **Flows:** 15 flows in `src/flows`, run through `/api/flows`, which Run checks and the tests use. Every run mints a sandbox of its own.
- **Account page:** at `/account`, a patient or guardian picks whose records to share, shares sites with a related person, and revokes people and apps.
- **Live trace:** spans from every service, with inline previews. They're kept in SQLite and survive a restart.

## Thumbnails

Film sheets show thumbnails decoded in the browser by [viewer-kit](https://github.com/jmandel/shlink-dicom), from jmandel/shlink-dicom, under the Apache License 2.0. The release is pinned in `src/vendor.ts`, by its tag and the tarball's SHA-256. `bun run viewer-kit`, which `bun run up` and the installer run, downloads it once into `$DEMO_STORAGE/vendor/`, checks the tarball and every file against its `SHA256SUMS`, and fails on any mismatch. The demo checks it again when it starts, and serves the files that check out at `/vendor/viewer-kit/`, from those bytes held in memory. If none do, those paths answer `404`, and thumbnails keep their placeholders. A download that finds a copy on disk that doesn't check out removes it before fetching again. It isn't in this repository.

- **Which instance:** the middle instance, by number, of the study's first image series, from the search result alone. For a slide, the series metadata is read once, for the image whose Image Type is `THUMBNAIL`, or failing that a one-frame `VOLUME` level, and never `OVERVIEW`. A server that doesn't offer metadata, or a slide with neither, shows the placeholder.
- **How:** Explore retrieves that one instance through the proxy, in its stored form, with the session's token, as any app would, so each appears in the activity. The page decodes it with one decoder pool, at a reduced scale, and draws it with the CPU renderer. A withheld study fetches nothing.

## Sandboxes

With no prefix, every service uses saved policy, the one real policy database. `/s/{sandbox}/` in front of any path gives a scratch sandbox: its own Authorization Server, Imaging Server and proxy, with their own policy store in memory, signing key, credentials, tokens, decision cache, and demo clock. Their URLs carry the prefix, so discovery, redirects, `Endpoint.address`, signed contexts, `next` links and bulk data links all stay in the sandbox. Only the catalog, the backends and the trace collector are shared. A token, code or signed URL from one sandbox fails in every other, and a policy change in one is invisible in the rest.

Each service's listener sends a sandbox path to that sandbox's own instance of the same service, with the prefix taken off, and the one origin forwards the prefix through, so sandboxes work the same with `DEMO_ONE_ORIGIN=0`. A sandbox's pages are its tour, Explore, its activity, its account page, and its live trace at `/s/{sandbox}/trace/`, which lists only its own sessions.

- **A minted id:** `POST /api/sandboxes` returns `{ sandbox, base, urls }`, with a random 22-character id, seeded from what's on file. So does starting a flow.
- **An inline seed:** `/s/~{seed}/`, where the seed is deflate-raw compressed JSON, base64url encoded: the policy API's document in all three levels, `{ relationships, policies, shares, approvals }`, with `contextLifetimeSeconds` and `maxSeriesInContext`, any part of it. The relationships and policies it names are that sandbox's on file, and a reset there puts them back. Where it names none, they're the ones on file. Labels are the catalog's, and birth dates the patient records'. The first request builds the sandbox from it, and later ones reuse it, along with any changes made there. A seed is at most 4,096 characters, and 64 KiB of JSON. One that doesn't validate gets a `400` saying why. `encodeSeed` in `src/sandboxes.ts` makes one.
- **Lifetimes:** a sandbox sits idle for 30 minutes at most. Minted sandboxes and seeds are separate pools, at most 64 of each, the least recently used going first, so seeds never push out a minted sandbox. An unknown or dropped minted id gets a `404` saying so. A dropped seed builds again from its document. A restart drops every scope.
- **A seed sandbox is shared** by everyone who uses the same seed: its policy changes, its tokens' effects, its live trace, and the response bodies the trace holds. Use a minted id for anything one person shouldn't see of another's.

## Connecting a browser app

The demo's own clients, `portal-app` and `separate-viewer`, are always registered. `DEMO_APP_CLIENTS` adds other public clients, as comma-separated `client_id=redirect_uri` pairs, with an id repeated for each of its redirect URIs. None are added by default.

For example, [SHLink DICOM Share](https://shlink-dicom.exe.xyz/share) signs in as `shlink-dicom-share`, so a deployment it should reach sets:

```sh
DEMO_APP_CLIENTS=shlink-dicom-share=https://shlink-dicom.exe.xyz/share/smart-callback/
```

That page accepts a portal on `https`, or on `http` only at `localhost` or `127.0.0.1`. To try it against this machine, run a second copy that stays on loopback. After `bun run up`, it shares the archive, the S3 store, and Orthanc, with its own SQLite files:

```sh
S=/tmp/smart-imaging-share; mkdir -p $S
DEMO_TAILNET=0 DEMO_PORT_OFFSET=100 DEMO_APP_CLIENTS=shlink-dicom-share=https://shlink-dicom.exe.xyz/share/smart-callback/ \
  POLICY_DB=$S/policy.sqlite TRACE_DB=$S/traces.sqlite CATALOG_DB=$S/catalog.sqlite bun run start
```

In a browser on the same machine, open the share page, choose **Connect to a patient portal**, and enter `http://127.0.0.1:4705/fhir`. Chrome asks once whether the page may reach this device: allow it. The app finds no `DiagnosticReport` here, and carries on without reports.

## Deploying

The one origin is what a host in front of the machine forwards to: give it the public origin with `DEMO_PUBLIC_URL`, and it listens on every interface, with the other services on loopback. Its URLs, discovery documents, and Host checks then use that origin, and nothing else about DNS is assumed.

- **Any Linux machine with systemd:** `DEMO_PUBLIC_URL=https://imaging.example.org deploy/install.sh` from a checkout. It installs DCMTK and a pinned Bun if they're missing, builds the data under `/var/lib/smart-imaging-proxy`, and runs the app, the S3 store, and Orthanc as the `smart-imaging-proxy`, `smart-imaging-proxy-s3`, and `smart-imaging-proxy-orthanc` services. Its settings go to `/etc/smart-imaging-proxy.env`. Repeating it updates the machine.
- **An exe.dev VM:** `scripts/deploy-exe.sh <vm-name>` creates the VM if it doesn't exist, copies this checkout's committed code, runs the installer with the VM's HTTPS URL from exe.dev's own listing, and points the VM's web proxy at port 4605. The proxy stays private, behind exe.dev's login, until you run `ssh exe.dev share set-public <vm-name>`. `DEMO_APP_CLIENTS` set when you run it goes to the VM.

The demo's pages, settings menu, and live trace have no login of their own. Anyone who can reach the origin can read traces and change saved policy, so choose who can reach it at the host.

## How it works

- **Instant path:** search signs its decision into `Endpoint.address`. The proxy checks the signature, expiry, study, series, and a hash of the token, with no network call.
- **Otherwise, it asks:** a refreshed token, a separate client, an expired context, or a `restricted` one leads to an [AuthZEN](https://openid.net/specs/authorization-api-1_0.html) evaluation at the Imaging Server. Allowed answers are cached as described under [Ending access](#ending-access). If that fails, no data is released.
- **Signing keys:** the proxy reads public keys from the Imaging Server's JWKS, holding them for 60 seconds. A retired key ends the instant path for its URLs, and current policy still decides through the evaluation.
- **App Launch:** discovery, authorization code with PKCE S256, required `state`, exact `redirect_uri`, single-use codes, and a consent page where the user picks a patient and sites.
- **Backend Services:** ES256 client assertions, with each check traced separately: registered key, algorithm, `iss` and `sub`, `aud`, expiry, `jti`, signature, and scope.
- **Three levels of policy:** facts (relationships, labels on studies, birth dates), organization policy (guardian access by age, who may share, and backend services' access), and people's choices within it (shares and app approvals). No fact grants anything alone, and no choice exceeds the chooser's own access. Policies and choices only grant: access is the union of every grant that applies, so adding one never takes access away, and revoking is deleting it. Guardian-access age bands never overlap. The model is in [packages/core/README.md](packages/core/README.md#policy).
- **Sharing:** a patient or guardian shares with a related person, who can give an app part of it. What a patient shares stops there, since the sharing policy lets only patients and guardians share: a share someone else makes gets a `403` naming that policy. A share follows what the sharer can see now, through the route it was made on. Each share and app approval records the rows it rests on, and revoking a row deletes what rests only on it, by id, so sharing again, or putting a guardian relationship back, brings nothing back. An approval covers the routes its user held when approving: one gained later needs a new approval.
- **Policy API:** the account page, consent, Explore, the tours, and the settings menu change policy only through the Imaging Server's policy API, at `/policy/v2`, with its own credential, which the proxy doesn't hold. The one origin doesn't forward it: callers use the Imaging Server's loopback port. Its calls are in [packages/core/README.md](packages/core/README.md#the-policy-api).
- **Guardians:** a `guardian_of` relationship from registration, in `data/patient.json`, which grants what the guardian-access policy for the patient's age allows. Guardians of patients under 13 see every study, the confidential label being one their policy knows, and guardians of 13- to 17-year-olds see all but those labeled `confidential-adolescent`. Riley is 15, and Riley's skin biopsy carries that label in `data/studies.source.json`, so search omits it for Sam, retrieval refuses it, and Sam's shares and apps can't include it. At 18 no guardian-access policy applies, and Sam holds nothing of Riley's. Age comes from the birth date and the sandbox's clock at each check, counted in UTC. Removing a guardian relationship also removes the shares made on it, and the app approvals resting only on what was removed. A share or approval goes quiet, not deleted, while no sharing or guardian-access policy covers it, such as after an 18th birthday, and comes back if one does again. A policy reset clears what people chose and puts what's on file back.
- **One patient to a token:** whoever holds several records picks one at each launch, which makes its own token and its own app approval. Searching for another patient gets `403`, and retrieving another patient's study gets `404`.
- **Search:** reads only the catalog, never a bucket. `_count` defaults to 20, with a maximum of 100. Each page's `next` link holds a signed cursor that grants nothing, because policy runs again on every page.
- **Retrieval:** the proxy reads from the backend only as the client takes bytes. On the file and S3 backends, it settles every `404`, `406`, and byte count from the indexes before opening an instance, and sends an exact `Content-Length`. A client sending `Accept-Encoding: zstd` gets stored zstd objects without decoding.
- **Failures:** a response that can't finish aborts with no closing boundary, so a partial study can't look complete.

## Ending access

After a token is revoked:

| Request | Result |
|---|---|
| Search | `401` at once |
| Signed URL | `200`, instant, until the context's `exp` |
| Plain or asked URL, already decided | `200`, cached, for the same time |
| Plain URL, not cached | `401` at once |

The window is `min(now + context lifetime, token exp)`, set when the context or decision is issued. Context lifetime is 300 seconds by default.

- **Flush decisions** ends the cached window only, not signed URLs.
- **Rotate the key,** with the proxy told, ends the signed-URL window at once. A revoked token then gets `401`, and a valid token still works by asking.
- **Revoking a share or an app** on the account page works the same way: search reflects it at once, and an uncached plain URL gets `404`, while a signed URL or cached decision already issued keeps working until it expires.
- **Ending access at once** takes all three, in the settings menu: revoke tokens, flush decisions, and rotate the key.

## The archive

Local files (`/tmp/smart-imaging-demo/archive`) and the S3 bucket `smart-imaging-archive` hold the same objects:

```
studies/{study}/current.json                                  { "version": 3 }
studies/{study}/v{version}/study.json.zst                     study document
studies/{study}/v{version}/series/{series}/index.json.zst     instances, offers, and bulk offsets
studies/{study}/v{version}/series/{series}/metadata.json.zst  DICOM JSON
content/{sha256}.dcm[.zst]                                    PS3.10 bytes, named by their hash
reports/quarantine.json                                       inputs left out of the last ingest, and why
```

**Ingest takes** the PS3.10 `.dcm` files listed through `data/studies.source.json`. It isn't a watched folder or a network receiver.

| Input | What ingest does |
|---|---|
| Explicit VR Little Endian or an encapsulated syntax | Keeps it as it is |
| Implicit VR, big endian, or deflated | Converts it to Explicit VR Little Endian |
| Lossy | Keeps it as it is, with a warning if (0028,2110) isn't `01` |
| Not PS3.10, or an element it can't read | Quarantines it |
| A missing or invalid Study, Series, or SOP Instance UID, or no SOP Class | Quarantines it |
| A private transfer syntax | Quarantines it. The left wrist study's private syntax is a synthetic fixture |
| Another study's instance, or a repeated SOP Instance | Quarantines it |

- **Publishing:** content goes first, then documents, then `current.json`, which is what makes a version live. Unchanged input writes nothing. Changed input writes the next version, and earlier ones stay. Documents in an earlier archive format are rewritten in the current one at their own version, when that version's content is the same.
- **Metadata:** Pixel Data, and any other binary value (OB, OD, OF, OL, OV, OW, UN) over 1 KiB at any depth, is a `BulkDataURI` rather than `InlineBinary`. A link names its element by path: a tag at the top level, and inside a sequence, the sequence's path, the item number counting from 1, and the tag, such as `00480105/1/00282000`, the slide's ICC profile. Orthanc names its links the same way. The proxy serves each at `.../instances/{instance}/bulk/{path}` as exactly that element's bytes, and from the file and S3 backends with an exact `Content-Length`.
- **Quarantine:** other inputs carry on. A study with a live version keeps it until its inputs are clean. A new study publishes its valid instances.
- **Compression:** an object gets a zstd wrapper only when that saves at least 5%, so incompressible instances stay byte-for-byte.
- **Not checked:** pixel data isn't decoded. Patient ID isn't compared across a study's instances, and study-level fields come from its last file.

**The catalog** is a rebuildable SQLite file, built at startup when it's empty. A study whose Patient ID has no link is skipped and reported. Ingest doesn't update the catalog, and a running server keeps the one it opened, so after changing the archive:

```sh
bun run build-catalog          # from the archive
bun run catalog-from-orthanc   # from Orthanc's QIDO-RS, plus data/orthanc-catalog.json
```

Then restart `bun run start`.

## Files

| Path | Purpose |
|---|---|
| `packages/core/` | The core package: the proxy and its backends, the archive and ingest, the catalog, the Imaging Server, the policy store, and the policy API and its client. See [its README](packages/core/README.md) |
| `src/main.ts`, `src/roles.ts`, `src/stack.ts` | Startup, all at once or by `--role`, and the listeners that send each sandbox its own requests |
| `src/config.ts` | Ports, addresses, storage paths, the Host check, and backend credentials |
| `src/stores.ts` | Saved policy's store, and what's on file: guardians and birth dates from `data/patient.json`, and the organization's guardian and sharing policies |
| `src/sandbox.ts` | One sandbox: an Authorization Server, Imaging Server and proxy, with their own policy, keys and clock |
| `src/sandboxes.ts` | Sandboxes: minting, inline seeds, idling out, and the `/s/{sandbox}` prefix |
| `src/gateway.ts`, `src/cors.ts` | The one origin apps are given, and the services' CORS |
| `src/auth-server.ts` | SMART launch and Backend Services, sign-in, consent, account page, introspection |
| `src/flows/` | The flows, shared by the web page and tests, and the launch client |
| `src/explore.ts` | Explore's sessions and API: sign-in, search, withheld studies, actions, thumbnails, and a study's chain in one line |
| `src/tours.ts`, `src/reference-model.ts` | The tours, their cards' scenes, and checks, and the reference model the tours are checked against |
| `src/chain.ts`, `web/layers.js` | The layer chain: computed with core's model, and drawn |
| `src/viewer-events.ts` | What a session's viewer may see of its events, for Explore, the tours and the activity log |
| `src/activity.ts` | The activity log's rollups: each type's numbers, the timeline, the sessions, and Explore's one line |
| `src/referrals.ts` | The referrals and reports the services work from |
| `src/settings-api.ts`, `src/rule-presets.ts` | The settings menu's API and the write guards, and named rule sets of service-access policies |
| `src/vendor.ts`, `scripts/viewer-kit.ts` | viewer-kit's pin, and its download |
| `src/trace.ts`, `src/trace-collector.ts`, `src/trace-store.ts` | Spans and redaction, the observer core reports to, the live stream, and SQLite storage |
| `src/clock.ts` | Demo clocks: the root's, and one for each sandbox, which the settings menu moves |
| `scripts/` | Fetch, synthetic study generation, ingest, load, catalog builds, the backends, and deploying |
| `deploy/` | The installer for a Linux machine with systemd |
| `data/` | Source list with checksums, patient links, and Orthanc's per-study settings |
| `web/` | All the pages |
| `tests/`, `e2e/` | The demo's tests, and the browser tests. Core's are in `packages/core/tests` |

## Configuration

Everything has a working default.

| Setting | Default | Purpose |
|---|---|---|
| `DEMO_TAILNET` | Detected | `0` stays on loopback |
| `DEMO_PORT_OFFSET` | `0` | Added to ports 4600-4605, to run a second copy |
| `DEMO_ONE_ORIGIN` | On | `0` gives people and apps each service's own port, rather than the one origin on 4605 |
| `DEMO_PUBLIC_URL` | None | The origin people and apps use, when a host in front of the machine gives it one. See [Deploying](#deploying) |
| `DEMO_APP_CLIENTS` | None | Public clients beyond the demo's own, as `client_id=redirect_uri` pairs. See [Connecting a browser app](#connecting-a-browser-app) |
| `DEMO_STORAGE` | `/tmp/smart-imaging-demo` | The default home of everything below, the S3 store's and Orthanc's data and binaries, and `bun run up`'s log |
| `S3_PORT`, `ORTHANC_PORT` | `4610`, `4611` | Where the S3 store and Orthanc listen, on loopback, and where the demo reaches them |
| `ARCHIVE_DIR` | `/tmp/smart-imaging-demo/archive` | The local archive |
| `S3_BUCKET` | `smart-imaging-archive` | The S3 store's bucket for the archive |
| `SOURCES_DIR` | `data/sources` | Where `bun run fetch-data` keeps the downloads, and ingest reads them |
| `INGEST_WORK` | The OS temp directory | Ingest's working files |
| `CATALOG_DB` | `/tmp/smart-imaging-demo/catalog.sqlite` | The archive catalog. Orthanc's sits beside it, named `-orthanc` |
| `POLICY_STORE` | `file` | `file` or `memory` |
| `POLICY_DB` | `/tmp/smart-imaging-demo/policy.sqlite` | Saved policy, the signing key, and token hashes. A file in another schema stops startup, with a message to reset saved policy by deleting it |
| `POLICY_DURABILITY` | `normal` | `off`, `normal`, or `full` |
| `TRACE_STORE` | `file` | `file` or `memory` |
| `TRACE_DB` | `/tmp/smart-imaging-demo/traces.sqlite` | Traces. A path that can't be opened falls back to memory |
| `TRACE_MAX_BYTES` | 512 MiB | Oldest sessions go first past this size, or past 100 sessions |

**Port offsets:** avoid these, which break the demo:

- **6 to 11** put a service on the S3 store's or Orthanc's port.
- **1396 to 1400** put a service on port 6000, which Chromium blocks. Check any large offset against the [Fetch standard's blocked ports](https://fetch.spec.whatwg.org/#port-blocking).

A second copy shares the S3 store, Orthanc, and the default SQLite files, so give it its own `POLICY_DB`, `CATALOG_DB`, and `TRACE_DB`. For its own backends too, give it its own `DEMO_STORAGE`, `S3_PORT`, and `ORTHANC_PORT`, and run `bun scripts/backends.ts start` with them.

**Splitting the services,** with each command in its own terminal the same `SERVICE_SECRET` in each, and `POLICY_SECRET` for `imaging` and `auth`. `gateway` is the one origin on 4605, and needs no credential:

```sh
bun src/main.ts --role imaging,auth,trace,gateway
PROXY_BACKEND=s3 bun src/main.ts --role proxy
```

| Setting | Default | Purpose |
|---|---|---|
| `--role` | `all` | `all`, `demo` (the same as `all`), or a comma-separated list of `proxy`, `imaging`, `auth`, `trace`, `gateway` |
| `SERVICE_SECRET` | None | Required for `proxy`, `imaging`, and `auth`, and the same in each. With `all`, it's generated. `trace` takes spans only with a credential derived from it, so give it the same one too |
| `POLICY_SECRET` | None | The policy API's credential. Required for `imaging` and `auth`, the same in both, and never given to `proxy`. With `all`, it's generated |
| `PROXY_BACKEND` | `static-files` | `static-files`, `s3`, or `orthanc`. Set `orthanc` on `imaging` too, to use Orthanc's catalog |
| `JWKS_TTL_SECONDS` | `60` | How long a split proxy trusts its copy of the keys |

Split services serve saved policy only, with no sandboxes, pages, or settings menu. `auth` registers the demo's Backend Services clients with keys derived from `SERVICE_SECRET` (`derivedBackendClient` in `src/auth-server.ts`), so anyone holding that secret can act as them.

## Real and simulated

| Real | Simulated |
|---|---|
| OAuth messages, PKCE, codes, refresh, revocation, introspection | **Authentication:** an account picklist with no passwords |
| Signed client assertions and token issuance | **Accounts and apps:** a fixed list in the code. Backend client keys are generated at each start |
| Ed25519 signed contexts, JWKS, and key rotation | **Patient matching:** an exact match on Patient ID, seeded from `data/patient.json` |
| Delegation and consent, enforced in search and retrieval | **Site names:** assigned in the data files, not read from DICOM |
| FHIR search and the AuthZEN API, over HTTP between services | **Clinical FHIR server:** a stub serving discovery and four `Patient` resources |
| WADO-RS streaming, with files, RustFS's S3 API, and Orthanc's DICOMweb | **Time:** a demo clock can jump ahead, to show expiry |
| zstd at rest and passthrough | **Faults:** the outage switch, and truncation injected at the backend boundary |
| SQLite stores and traces, which survive a restart | **Private transfer syntax:** a synthetic label on one instance |

Where the images come from:

| Patient | Studies | Source |
|---|---|---|
| Josh Example | 5 | A real patient's, de-identified as "Josh Example" and published in [jmandel/my-health-data](https://github.com/jmandel/my-health-data) |
| Josh Example | 1 | A public CC BY 4.0 slide from the NCI Imaging Data Commons, rewritten to the same patient. It isn't his tissue |
| Sam Example, Riley Example | 2 each | Fully synthetic. `scripts/generate-synthetic.ts` computes them, with no download, and the same bytes on every rebuild. Their `StudyDescription` and `SeriesDescription` start with `SYNTHETIC`, and no person's images are in them |
| Robin Example | None | A Patient ID with nothing linked to it, so a search is a real empty result |

Sam Example's and Riley Example's are invented people, and they're the only ones whose images are computed. Tokens are stored only as hashes, and traces hold only hash prefixes of them.

## Known limits

**Open access:** nothing here has a login. Anyone who can reach these ports can sign in as any account, change saved policy from the settings menu and Explore, and read every trace and event, including response bodies. Over a tailnet, that's anyone on it. Traffic is plain HTTP. Settings writes take named choices, and nothing there reaches the filesystem.

**Not tried:** other devices on the tailnet, AWS S3 (only RustFS), any cloud deployment, and real patient matching.

**Scale:** a tiny prototype on ten studies, with no load tests or scale proof. The design aims to have no obvious scaling blockers, and that's reasoning, not measurement.

**Decided against:**

- **Postgres:** every store is SQLite.
- **Conformance suites:** none will be run.
- **Lambda:** not suitable for study retrieval.
- **Presigned redirects:** not worth it.
- **HTJ2K at rest:** not built. zstd comes first, and an instance's offers leave room for it.

**DICOMweb:**

- `/rendered`, `/thumbnail`, and frames return `501`, and nothing is transcoded at serving time.
- One instance with no accepted representation makes the whole request `406`.
- With zstd passthrough, content digests are checked at ingest only, and serving checks length.
- `/metadata` is built whole in memory.

**Orthanc:** retrievals use chunked framing with no total `Content-Length`, as does encapsulated bulk data, and there's no zstd passthrough or study versioning. `bun run load` skips a study Orthanc already has, so a corrected study doesn't reach it.

**Ingest and storage:** ingest holds each file in memory, and nothing ever removes old versions or unreferenced content.

**Tradeoffs and restarts:**

- A revoked token keeps working on signed URLs and cached decisions for the windows under [Ending access](#ending-access).
- A restart loses sign-ins in progress, Explore, tour and account sessions, the proxy's cached decisions, and every scope.
- A restart also changes the paging key, so older `next` links get a `400`.

## Tests

```sh
bun test                         # every flow on every backend, core's tests, and the rest
BACKENDS=static-files bun test   # flows, Explore, rotation, and conformance on one backend
cd packages/core && bun test     # core alone, with no demo
```
`bun run test:ui` drives the pages in real Chromium: focus, overflow, contrast, popups, thumbnails decoded in the page, each tour run end to end, and what the pages draw from real responses. It runs its own stack in memory, at port offset 3000 unless `DEMO_PORT_OFFSET` says otherwise, and takes the browser from `CHROMIUM`, or `/usr/bin/chromium`.


The tests use the same ports as the demo, so stop the demo first, with `bun run down` or by ending `bun run start`, or give the test run its own `DEMO_PORT_OFFSET`. The suite also creates and deletes a temporary bucket in the S3 store it points at. They need the setup steps above, with the S3 store and Orthanc running, even with `BACKENDS` set. Spec checks read the guide's text from the `focused-access-updates` branch on GitHub, or from a local clone named by `SPEC_REPO`, at `SPEC_REF`.

## License

The code is under the [Apache License 2.0](LICENSE). The sample data isn't in this repository: `bun run fetch-data` downloads it under its own terms, listed in `data/studies.source.json`.
