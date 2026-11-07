# SMART Imaging Sandbox

A working prototype of a SMART Imaging deployment: an Authorization Server, an Imaging Server holding policy and a study catalog, and a WADO-RS proxy that enforces study-level policy without holding any of it. It runs on ten studies across three patients. It implements the `focused-access-updates` branch of the [SMART Imaging Access guide](https://github.com/argonautproject/smart-imaging). It isn't production code.

## Get running

You need Bun (developed on 1.4.3), Docker with Compose, DCMTK (`dcmconv`, `dcmcjpeg`, `dcmodify`), `curl`, and `tar`. Allow roughly 3 GB of disk, an estimate from one machine's copy.

```sh
git clone https://github.com/jmandel/smart-imaging-sandbox && cd smart-imaging-sandbox
bun run up      # sets everything up, starts it in the background, and prints the URLs
bun run down    # stops the demo, MinIO, and Orthanc, keeping their data
```

`bun run up` checks for the tools above, then runs each step below. The first run downloads about 750 MB of sample data. Later runs skip finished work, and restart a running demo so it serves the current code. Its log is `/tmp/smart-imaging-demo/demo.log`.

The same steps, one at a time:

```sh
bun install             # the browser test driver
bun run fetch-data      # downloads the sample data, verifying checksums
bun run ingest          # generates the synthetic studies, and builds the archive
docker compose up -d    # MinIO and Orthanc
bun run load            # copies the archive to MinIO, and adds any study Orthanc lacks
bun run start           # builds any empty catalog, then prints the URLs, in the foreground
```

Each step is safe to repeat. Everything except the downloads lives under `/tmp/smart-imaging-demo` by default, so after a reboot, run `bun run up` again.

Then open http://127.0.0.1:4600/browse and try these:

1. **Josh, the patient:** shows all six of his studies. Retrieve one through the proxy, and follow its link to the live trace.
2. **Sam, a patient and a caregiver:** right under Sam, choose Sam's own records or Riley's as guardian. Each choice is a real new sign-in and search. Josh's aren't Sam's until Josh shares: choose "Josh Example hasn't shared with Sam", and the page offers to share, and then Josh is a third choice, showing only the shared sites.
3. **A backend client:** gets a `403` until you apply a rule set at `/admin`.

## What's at each URL

Every service listens on `127.0.0.1`. If Tailscale is running, each one also listens on the tailnet IP and uses that IP in the URLs it issues, such as redirects and `Endpoint.address`.

| Port | Service | Paths |
|---|---|---|
| 4600 | Demo | `/` flow player, `/browse` Browse, `/admin` admin screen |
| 4601 | WADO-RS proxy | `/wado/{signed-context}/studies/...`, opaque to clients |
| 4602 | Imaging Server | `/fhir/ImagingStudy`, `/fhir/metadata`, `/access/v1/evaluation`, `/.well-known/jwks.json`, `/.well-known/authzen-configuration` |
| 4603 | Authorization Server | `/fhir/.well-known/smart-configuration`, `/authorize`, `/token`, `/introspect`, `/revoke`, `/account`, `/fhir/Patient/{id}` (with a token for that patient) |
| 4604 | Live trace | `/` viewer, `/span.html` full exchange, `/log.html` HTTP log, `/api/sessions/{id}/export` |
| 4610 | MinIO | Loopback only |
| 4611 | Orthanc | Loopback only |

- **Flow player:** 15 flows, each a series of steps showing real requests and responses, on any backend. Flows run against a scratch policy store that goes back to the guardians on file when a flow starts.
- **Browse:** pick an account or a backend client, and, for a person holding more than one record, whose records. The demo server runs a real launch or token request, then a real paged search, holding the token itself. Starting a session switches to saved policy. A panel shows the Imaging Server's reason for each study, which a real app would never see.
- **Admin:** policy store, guardians on file, delegations and app grants, rule sets, settings, demo clock, backend, decision outage, token revocation, decision flush, and key rotation.
- **Account page:** at `/account`, a patient or guardian picks whose records to share, shares sites with a related person, and revokes people and apps.
- **Live trace:** spans from every service, with inline previews. They're kept in SQLite and survive a restart.

## How it works

- **Instant path:** search signs its decision into `Endpoint.address`. The proxy checks the signature, expiry, study, series, and a hash of the token, with no network call.
- **Otherwise, it asks:** a refreshed token, a separate client, an expired context, or a `restricted` one leads to an [AuthZEN](https://openid.net/specs/authorization-api-1_0.html) evaluation at the Imaging Server. Allowed answers are cached as described under [Ending access](#ending-access). If that fails, no data is released.
- **Signing keys:** the proxy reads public keys from the Imaging Server's JWKS, holding them for 60 seconds. A retired key ends the instant path for its URLs, and current policy still decides through the evaluation.
- **App Launch:** discovery, authorization code with PKCE S256, required `state`, exact `redirect_uri`, single-use codes, and a consent page where the user picks a patient and sites.
- **Backend Services:** ES256 client assertions, with each check traced separately: registered key, algorithm, `iss` and `sub`, `aud`, expiry, `jti`, signature, and scope.
- **Delegation:** patient or guardian to related person to app, where each link can only narrow what the last one allows. What a patient shares with someone stops there: they can give an app part of it, and can't pass it on, since the Imaging Server honors a share only from the patient or a guardian. The Imaging Server holds all of it.
- **Guardians:** a standing relationship in the policy store, seeded from `data/patient.json`, that covers a patient's record, apart from any study marked confidential from that guardian, with no one sharing first. Riley's skin biopsy is confidential from Sam: search omits it, retrieval refuses it, and Sam's shares and apps can't include it. The Imaging Server evaluates it like any other link. A policy reset clears what people chose and puts guardians back, and what a guardian shared ends if they stop being the guardian.
- **One patient to a token:** whoever holds several records picks one at each launch, which makes its own token and its own app grant. Searching for another patient gets `403`, and retrieving another patient's study gets `404`.
- **Search:** reads only the catalog, never a bucket. `_count` defaults to 20, with a maximum of 100. Each page's `next` link holds a signed cursor that grants nothing, because policy runs again on every page.
- **Retrieval:** the proxy reads from the backend only as the client takes bytes. On the file and MinIO backends, it settles every `404`, `406`, and byte count from the indexes before opening an instance, and sends an exact `Content-Length`. A client sending `Accept-Encoding: zstd` gets stored zstd objects without decoding.
- **Failures:** a response that can't finish aborts with no closing boundary, so a partial study can't look complete.

## Ending access

After a token is revoked:

| Request | Result |
|---|---|
| Search | `401` at once |
| Signed URL | `200`, instant, until the context's `exp` |
| Plain or asked URL, already decided | `200`, cached, for the same time |
| Plain URL, not cached | `401` at once |

The window is `min(now + context lifetime, token exp)`, set when the context or decision is issued. Context lifetime is 300 seconds by default, and the admin screen offers up to 1,800.

- **Flush decisions** ends the cached window only, not signed URLs.
- **Rotate the key,** with the proxy told, ends the signed-URL window at once. A revoked token then gets `401`, and a valid token still works by asking.
- **Revoking a share or an app** on the account page works the same way: search reflects it at once, and an uncached plain URL gets `404`, while a signed URL or cached decision already issued keeps working until it expires.
- **Ending access at once** takes all three on `/admin`: revoke tokens, flush decisions, and rotate the key.

## The archive

Local files (`/tmp/smart-imaging-demo/archive`) and the MinIO bucket `smart-imaging-archive` hold the same objects:

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

- **Publishing:** content goes first, then documents, then `current.json`, which is what makes a version live. Unchanged input writes nothing. Changed input writes the next version, and earlier ones stay.
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
| `src/main.ts`, `src/roles.ts`, `src/stack.ts` | Startup, all at once or by `--role` |
| `src/config.ts` | Ports, addresses, and backend credentials |
| `src/auth-server.ts` | SMART launch and Backend Services, sign-in, consent, account page, introspection |
| `src/imaging-server.ts` | Search, policy evaluation, signed contexts, the decision API, JWKS |
| `src/policy-store.ts` | SQLite policy, signing key, and hashed tokens, with saved and scratch stores |
| `src/proxy.ts`, `src/jwks.ts`, `src/serve-streaming.ts` | The proxy, its key source, and the server that keeps its `Content-Length` |
| `src/accept.ts`, `src/multipart.ts`, `src/zstd-frames.ts`, `src/dicom.ts` | `Accept` plans, multipart framing, raw zstd frames, and PS3.10 parsing |
| `src/catalog.ts`, `src/catalog-archive.ts`, `src/catalog-orthanc.ts` | The catalog and its two builders |
| `src/archive/` | The archive format, reader, object stores, and ingest |
| `src/backends/` | Files and MinIO (`archive.ts`), Orthanc (`orthanc.ts`), and fault injection |
| `src/flows/` | The flows, shared by the web page and tests, and the launch client |
| `src/browse.ts` | The Browse page's sessions and API |
| `src/admin-api.ts`, `src/rule-presets.ts` | The admin API, and its named rule sets |
| `src/trace.ts`, `src/trace-collector.ts`, `src/trace-store.ts` | Spans and redaction, the live stream, and SQLite storage |
| `scripts/` | Fetch, synthetic study generation, ingest, load, and catalog builds |
| `data/` | Source list with checksums, patient links, and Orthanc's per-study settings |
| `web/` | All the pages |
| `tests/` | The test suite |

## Configuration

Everything has a working default.

| Setting | Default | Purpose |
|---|---|---|
| `DEMO_TAILNET` | Detected | `0` stays on loopback |
| `DEMO_PORT_OFFSET` | `0` | Added to ports 4600-4604, to run a second copy |
| `DEMO_STORAGE` | `/tmp/smart-imaging-demo` | The default home of everything below, the Compose volumes, and `bun run up`'s log |
| `MINIO_PORT`, `ORTHANC_PORT` | `4610`, `4611` | Where Compose publishes MinIO and Orthanc, and where the demo reaches them |
| `ARCHIVE_DIR` | `/tmp/smart-imaging-demo/archive` | The local archive |
| `INGEST_WORK` | The OS temp directory | Ingest's working files |
| `CATALOG_DB` | `/tmp/smart-imaging-demo/catalog.sqlite` | The archive catalog. Orthanc's sits beside it, named `-orthanc` |
| `POLICY_STORE` | `file` | `file` or `memory` |
| `POLICY_DB` | `/tmp/smart-imaging-demo/policy.sqlite` | Saved policy, the signing key, and token hashes |
| `POLICY_DURABILITY` | `normal` | `off`, `normal`, or `full` |
| `TRACE_STORE` | `file` | `file` or `memory` |
| `TRACE_DB` | `/tmp/smart-imaging-demo/traces.sqlite` | Traces. A path that can't be opened falls back to memory |
| `TRACE_MAX_BYTES` | 512 MiB | Oldest sessions go first past this size, or past 100 sessions |

**Port offsets:** avoid these, which break the demo:

- **6 to 11** put a service on MinIO's or Orthanc's port.
- **1396 to 1400** put a service on port 6000, which Chromium blocks. Check any large offset against the [Fetch standard's blocked ports](https://fetch.spec.whatwg.org/#port-blocking).

A second copy shares MinIO, Orthanc, and the default SQLite files, so give it its own `POLICY_DB`, `CATALOG_DB`, and `TRACE_DB`. For its own backends too, run `docker compose -p {name} up -d` with its own `DEMO_STORAGE`, `MINIO_PORT`, and `ORTHANC_PORT`, and its own `ARCHIVE_DIR`.

**Splitting the services,** with each command in its own terminal and the same `SERVICE_SECRET` in both:

```sh
bun src/main.ts --role imaging,auth,trace
PROXY_BACKEND=minio bun src/main.ts --role proxy
```

| Setting | Default | Purpose |
|---|---|---|
| `--role` | `all` | `all`, `demo` (the same as `all`), or a comma-separated list of `proxy`, `imaging`, `auth`, `trace` |
| `SERVICE_SECRET` | None | Required for `proxy`, `imaging`, and `auth`, and the same in each. With `all`, it's generated |
| `PROXY_BACKEND` | `static-files` | `static-files`, `minio`, or `orthanc`. Set `orthanc` on `imaging` too, to use Orthanc's catalog |
| `JWKS_TTL_SECONDS` | `60` | How long a split proxy trusts its copy of the keys |

Split services have no flow player, Browse, or admin screen. `auth` registers the demo's Backend Services clients with keys derived from `SERVICE_SECRET` (`derivedBackendClient` in `src/auth-server.ts`), so anyone holding that secret can act as them.

## Real and simulated

| Real | Simulated |
|---|---|
| OAuth messages, PKCE, codes, refresh, revocation, introspection | **Authentication:** an account picklist with no passwords |
| Signed client assertions and token issuance | **Accounts and apps:** a fixed list in the code. Backend client keys are generated at each start |
| Ed25519 signed contexts, JWKS, and key rotation | **Patient matching:** an exact match on Patient ID, seeded from `data/patient.json` |
| Delegation and consent, enforced in search and retrieval | **Site names:** assigned in the data files, not read from DICOM |
| FHIR search and the AuthZEN API, over HTTP between services | **Clinical FHIR server:** a stub serving discovery and four `Patient` resources |
| WADO-RS streaming, with files, MinIO's S3 API, and Orthanc's DICOMweb | **Time:** a demo clock can jump ahead, to show expiry |
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

**Open access:** nothing here has a login. Anyone who can reach these ports can sign in as any account, use `/admin`, and read every trace, including its response bodies. Over a tailnet, that's anyone on it. Traffic is plain HTTP. `/admin` writes take named choices or identify an existing row, and nothing there reaches the filesystem. The flow player's policy panel accepts any valid policy JSON, for the scratch store only.

**Not tried:** other devices on the tailnet, real S3 (only MinIO), any cloud deployment, and real patient matching.

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
- A restart loses sign-ins in progress, Browse and account sessions, and the proxy's cached decisions.
- A restart also changes the paging key, so older `next` links get a `400`.

## Tests

```sh
bun test                         # every flow on every backend, and the rest
BACKENDS=static-files bun test   # flows, Browse, rotation, and conformance on one backend
```
`bun run test:ui` drives the pages in real Chromium: focus, overflow, contrast, popups, and what the pages draw from real responses. It runs its own stack in memory, and takes the browser from `CHROMIUM`, or `/usr/bin/chromium`.


The tests use the same ports as the demo, so stop the demo first, with `bun run down` or by ending `bun run start`, or give the test run its own `DEMO_PORT_OFFSET`. The suite also creates and deletes a temporary bucket in the MinIO it points at. They need the setup steps above, including Docker, even with `BACKENDS` set. Spec checks read the guide's text from the `focused-access-updates` branch on GitHub, or from a local clone named by `SPEC_REPO`, at `SPEC_REF`.
