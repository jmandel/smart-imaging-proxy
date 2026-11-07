# @smart-imaging-proxy/core

The parts of a SMART Imaging Access deployment that don't depend on how people sign in: a WADO-RS proxy that enforces study-level policy without holding any, its backends, an archive format with ingest, and an Imaging Server that holds policy and a study catalog, searches it, signs contexts into `Endpoint.address`, and answers AuthZEN decisions. Policy changes reach it through a small versioned HTTP API, the policy API.

It's TypeScript for Bun (developed on 1.4.3), with SQLite from `bun:sqlite` and S3 from `bun`. It has no other dependencies, and imports nothing from outside this package: `tests/boundary.test.ts` checks that.

The demo at the repository root embeds it. Core knows nothing of the demo's accounts, pages, tracing, ports, or data files.

## Embedding

Everything comes in through factory and constructor options. Nothing is held at module level, so two instances built side by side share only what they're given: one catalog or backend can serve several, while each keeps its own policy store, signing key, caches, clock, observer, and URLs. `tests/instances.test.ts` runs two in one process.

```ts
import { ArchiveBackend, createCatalog, createImagingServer, createPolicyClient, createProxy, fileStore, PolicyStore, rebuildFromArchive, serveStreaming } from "@smart-imaging-proxy/core";

const secret = process.env.SERVICE_SECRET!;            // the proxy and the Imaging Server's decision API
const policySecret = process.env.POLICY_SECRET!;       // the policy API only: never given to the proxy
const store = new PolicyStore({ mode: "file", path: "/var/lib/imaging/policy.sqlite", guardians: [] });
const catalog = createCatalog("/var/lib/imaging/catalog.sqlite", { accessionSystem: "urn:oid:1.2.3.4.5" });
await rebuildFromArchive(fileStore("/var/lib/imaging/archive"), catalog);

const imaging = createImagingServer({
  base: "https://imaging.example.org/imaging/fhir",    // every URL it issues starts here or at proxyBase
  clinicalFhirBase: "https://imaging.example.org/fhir",
  proxyBase: () => "https://imaging.example.org",
  introspect: token => introspectAtYourAuthorizationServer(token),
  patientOf: user => patientIdOfAccount(user),
  serviceSecret: secret, policySecret, catalog: () => catalog, keyStore: store, store: () => store,
});
const backend = new ArchiveBackend(fileStore("/var/lib/imaging/archive"));
const proxy = createProxy({
  publicBase: () => "https://imaging.example.org",
  jwksUrl: "http://127.0.0.1:8002/.well-known/jwks.json",
  decisionUrl: "http://127.0.0.1:8002/access/v1/evaluation",
  serviceSecret: secret,
  backend: () => backend,
});

Bun.serve({ port: 8002, hostname: "127.0.0.1", fetch: imaging.fetch });
await serveStreaming(8001, proxy.fetch, { hosts: ["127.0.0.1"] });

const policy = createPolicyClient({ base: "http://127.0.0.1:8002", policySecret });
await policy.setRules([{ id: "referral", when: { client: "referral-service", patient: "p1" }, allow: { modalities: ["CR"] } }]);
```

Each service answers at its own root: the Imaging Server at `/fhir/...`, `/access/v1/evaluation`, `/policy/v1/...` and `/.well-known/...`, whatever `base` it issues URLs under. A host in front of it maps its public paths to those. Keep `/policy/v1` and the proxy's `/internal/...` on internal addresses: don't expose them.

The proxy is served with `serveStreaming`, not `Bun.serve`, which replaces a stream's `Content-Length` with chunked framing. `serveStreaming(port, handler, { hosts, stallSeconds, foreignHost })` listens on `hosts` (loopback by default), cancels a body the client stops reading for `stallSeconds` (240), and answers `403` to a request whose `Host` `foreignHost(host, port)` says isn't its own.

## Observer and clock

Each factory takes an optional `observer` and `clock`.

- **`Clock`** is `{ now(): number }`, in seconds. It decides context and decision expiry and the cache's freshness. The default, `systemClock`, is real time. The JWKS source's TTL takes its own `jwksClock`, in milliseconds, which is always real time unless given.
- **`Observer`** receives what core does, and makes its outbound requests. The default, `noopObserver`, records nothing and fetches with the platform's `fetch`, not following redirects.

| Method | Called for |
|---|---|
| `serve(service, handler)` | Wrapping each HTTP service. The handler gets a `ServerSpan` |
| `span(service, kind, name, attrs)` | A span core ends itself, such as a stream's |
| `withSpan(service, kind, name, attrs, fn)` | A backend call, ended when `fn` settles |
| `check(service, name, ok, attrs)` | Each check on a request: a signature, a cache lookup, a policy evaluation. Returns `ok` |
| `fetch(service, name, url, init, attrs)` | Every outbound request: AuthZEN evaluations, the JWKS, and Orthanc |

A `Span` has `set(attrs)`, `end(status, attrs)`, and `within(fn)`, which runs `fn` as part of the span, for work a response stream does after its handler returned. A `ServerSpan` also has `streaming()`, saying the handler ends it when its stream finishes, and `creditTo(service)`, which the Imaging Server uses for its `policy` routes. Services are `imaging-fhir`, `policy`, `dicomweb-proxy`, and `backend`. Statuses are `ok`, `error`, and `denied`.

## The proxy

`createProxy(options)` returns `{ fetch, events, reset(), flushDecisions(), refreshKeys(), cachedDecisions }`.

| Option | Purpose |
|---|---|
| `publicBase()` | The proxy's own base, for rewritten `BulkDataURI`s |
| `jwksUrl`, `jwksTtlSeconds` (60), `jwksCooldownSeconds` (10), `jwksClock` | The Imaging Server's public keys. Or `keys`, a fixed map |
| `decisionUrl` | The Imaging Server's AuthZEN evaluation endpoint |
| `serviceSecret` | Sent to `decisionUrl`, and required on `/internal/keys/refresh` |
| `backend()` | The backend to read from, asked per request |
| `maxDecisions` (10,000), `maxEvents` (500) | Bounds on the decision cache and the event log |
| `observer`, `clock` | See above |

It serves `GET /wado/{context}/studies/{study}[/series/{series}[/instances/{instance}]][/metadata|/bulk/{tag}]`, where `{context}` is a signed context or `-`, and `POST /internal/keys/refresh`, which refetches the keys now. A signed context that verifies, covers the request and hasn't expired is decided with no call. Anything else asks `decisionUrl`, and caches an allowed answer for its `max_age_seconds`. A failed decision releases nothing.

## Backends

A `Backend` (`backends/types.ts`) lists series, opens instances in a transfer syntax the `Accept` plan allows, reads metadata, and opens bulk data. One that knows every part up front returns a plan, which lets the proxy send an exact `Content-Length`.

- **`ArchiveBackend(source)`** reads the archive from any `ObjectSource`: `fileStore(dir)` or `s3Store(new S3Client(...))`. It plans every part from the indexes, and passes stored zstd through to a client that sends `Accept-Encoding: zstd`.
- **`OrthancBackend({ base, user, password }, { observer })`** reads Orthanc's DICOMweb API, one syntax per request, labeling each part from its File Meta.
- **`withTruncation(backend, afterParts)`** ends a stream after a number of parts, for showing what a client sees.

## The archive

```
studies/{study}/current.json                                  { "version": 3 }
studies/{study}/v{version}/study.json.zst                     study document
studies/{study}/v{version}/series/{series}/index.json.zst     instances, offers, and bulk offsets
studies/{study}/v{version}/series/{series}/metadata.json.zst  DICOM JSON
content/{sha256}.dcm[.zst]                                    PS3.10 bytes, named by their hash
reports/quarantine.json                                       inputs left out of the last ingest, and why
```

`archiveKeys` builds these keys. `ArchiveReader` reads them, with a byte-bounded cache. `ingestStudies(store, studies)` publishes PS3.10 inputs to an `ObjectStore`: content first, then documents, then `current.json`. It converts Implicit VR, big endian and deflated inputs to Explicit VR Little Endian with DCMTK (`runTool`), quarantines what it can't use, writes nothing for unchanged input, and gives an object a zstd wrapper only when that saves 5% (`wrapperPaysOff`).

## The Imaging Server

`createImagingServer(options)` returns `{ fetch, jwks(), publicKeys, signingKid, rotateSigningKey(), setOutage(on), outage, decisions, reset() }`.

| Option | Purpose |
|---|---|
| `base` | Its FHIR base, ending in `/fhir` |
| `clinicalFhirBase` | The clinical FHIR server whose `Patient` references search takes and issues |
| `proxyBase()` | The proxy's public base, for `Endpoint.address` |
| `introspect(token)` | Token introspection at the Authorization Server |
| `patientOf(user)` | The patient a user account is, if any |
| `serviceSecret` | The credential the proxy presents to the decision API |
| `policySecret` | The credential policy API callers present. Give it to the Authorization Server and administration tools, never the proxy |
| `catalog()` | The catalog to search, asked per request |
| `keyStore` | The `PolicyStore` holding the signing key |
| `store()` | The `PolicyStore` search and decisions use |
| `namedStore(name)` | Other stores the policy API can name with `?store=` |
| `cursorKey`, `pageBytes` | The paging cursor key, which processes behind one address share, and a page's byte budget (5 MiB) |
| `observer`, `clock` | See above |

It serves:

| Path | |
|---|---|
| `GET /fhir/ImagingStudy` | Search by `patient`, `identifier`, `based-on:identifier`, `_lastUpdated`, `_count` and `_cursor`, with an Endpoint per available study |
| `GET /fhir/metadata` | Its CapabilityStatement |
| `POST /access/v1/evaluation` | AuthZEN evaluation, for the proxy |
| `GET /.well-known/jwks.json`, `/.well-known/authzen-configuration` | Its public keys, and where to ask |
| `/policy/v1/...` | The policy API |

Policy is evaluated against the store's rows: the patient or a guardian on file, then a delegation to a related person, then the app grant, where each link can only narrow the last, and then any rule matching the client, user and patient. A study confidential from a guardian is outside everything that guardian holds or shares.

## The catalog

`createCatalog(path)` opens a SQLite catalog, in memory by default. It holds no policy and is always rebuildable: `rebuildFromArchive(source, catalog)` builds it from the archive, and `catalogFromOrthanc(catalog, orthanc, config)` from Orthanc's QIDO-RS API, with `config` naming each study's id, title and site. `seedPatientLinks(catalog, people)` links Patient IDs to patients first: a study whose Patient ID has no link is skipped and reported.

## The policy store

`new PolicyStore({ mode, path, durability, guardians })` holds policy (rules, delegations, guardians, app grants, settings), the signing keys, and the Authorization Server's token records, all in one SQLite file, or in memory. `durability` is `off`, `normal` or `full`, SQLite's `synchronous`. A file store is WAL and mode `0600`. `guardians` are the ones on file: a new database starts with them, and a reset puts them back. The schema is versioned, at `SCHEMA_VERSION`, and a store from an older version is upgraded when it opens. Every write is validated, and all or none: `PolicyValidationError` lists each problem.

## The policy API

Version 1, at `/policy/v1` on the Imaging Server. JSON in and out. Every call carries `Authorization: Bearer {policySecret}`, or gets `401`, and the service credential doesn't work here. It belongs on an internal address only. Every call takes `?store={name}` to act on a store `namedStore` knows, or `404`, and otherwise acts on `store()`. A body that isn't JSON, or a policy that doesn't validate, gets `400` with `error` and, for a policy, `errors`, naming each field.

| Call | Body or query | Answer |
|---|---|---|
| `GET /relationships` | | `[{ patient, delegate, relationship }]`: guardians on file, then delegations |
| `GET /access` | `user`, `fhirUser` | `{ records, delegations, apps }`: the records the user holds and how (`self`, `guardian` or `delegation`), with the sites they can choose among, and what they've shared |
| `GET /explain` | `client`, `patient`, and for a launch `user` and `fhirUser` | Each of the patient's studies, with its release, reason and chain, as search decides it |
| `POST /delegations` | `{ patient, grantedBy, fhirUser, delegate, relationship, sites }` | `204`. Only the patient (`fhirUser` is `Patient/{patient}`) or a guardian on file can share: anyone else gets `403`. Sites narrow to those the grantor can give. A guardian's share lasts while they're the guardian |
| `DELETE /delegations` | `delegate`, with `grantedBy`, `patient` or both | `204`, or `404` if none matched |
| `POST /app-grants` | `{ client, user, fhirUser, patient, sites? }` | `204`, or `403` if the user holds no record of that patient. Sites narrow to what the user holds, and all of the patient's sites is no limit. With no `sites`, an earlier choice stays |
| `DELETE /app-grants` | `client`, `user`, and optionally `patient` | `204`, or `404` |
| `GET /policy` | | `{ rules, delegations, guardians, appGrants, contextLifetimeSeconds, maxSeriesInContext }` |
| `PUT /policy` | Any of those parts | `204`. Replaces the parts given |
| `PUT /guardians` | `[{ patient, guardian, relationship, excludedStudies? }]` | `204`. Delegations a former guardian made as guardian end |
| `PUT /rules` | `[{ id, description?, when: { client?, user?, patient? }, allow: { all?, sites?, modalities?, studies?, since? }, withholdSeries?, contextForm?, withdrawn? }]` | `204`. Rules match in order |
| `PATCH /rules/{id}` | Fields to change | `204`, or `404` |
| `GET /settings` | | `{ contextLifetimeSeconds, maxSeriesInContext, tokenLifetimeSeconds, refreshTokenLifetimeSeconds }` |
| `PATCH /settings` | Any of those | `204` |
| `POST /reset` | `{ tokens?: boolean }` | `204`. Clears delegations, app grants, rules and settings, and puts the guardians on file back. `tokens: true` clears token records too. The signing key stays |
| `GET /store` | | The store's mode, path, durability, journal mode, schema version, and row counts |

`createPolicyClient({ base, policySecret, store?, fetch? })` calls it, with a method for each call: `relationships`, `access`, `explain`, `delegate`, `removeDelegations`, `grantApp`, `removeAppGrants`, `getPolicy`, `setPolicy`, `setGuardians`, `setRules`, `updateRule`, `getSettings`, `setSettings`, `reset`, and `info`, and `withStore(name)` for a client on another store. `delegate` and `grantApp` answer `false` for a `403`, and the removals and `updateRule` `false` for a `404`. Anything else that fails throws `PolicyApiError`, with its `status`, message and `errors`. `fetch(operation, url, init)` makes each request, so a caller can name and trace it.

## Tests

```sh
cd packages/core && bun test
```

They run without the demo, from fixtures, temporary stores, a clock moved by hand, and an observer that records (`tests/support.ts`, `tests/fake-backend.ts`). The S3 tests make and delete a temporary bucket at `S3_ENDPOINT`, or `http://127.0.0.1:${S3_PORT}` with port 4610 by default, with `S3_ACCESS_KEY` and `S3_SECRET_KEY`. Ingest's conversion tests need DCMTK.
