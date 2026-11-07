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
const store = new PolicyStore({ mode: "file", path: "/var/lib/imaging/policy.sqlite", onFile: { relationships: guardiansFromRegistration(), policies: [] } });
const catalog = createCatalog("/var/lib/imaging/catalog.sqlite", { accessionSystem: "urn:oid:1.2.3.4.5" });
await rebuildFromArchive(fileStore("/var/lib/imaging/archive"), catalog);

const imaging = createImagingServer({
  base: "https://imaging.example.org/imaging/fhir",    // every URL it issues starts here or at proxyBase
  clinicalFhirBase: "https://imaging.example.org/fhir",
  proxyBase: () => "https://imaging.example.org",
  introspect: token => introspectAtYourAuthorizationServer(token),
  patientOf: user => patientIdOfAccount(user),
  patientAttributes: patient => ({ birthDate: birthDateOf(patient) }),
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
await policy.putPolicy({ id: "referral", type: "service-access", service: "service:referral-service", patients: "patient:p1", allow: { modalities: ["CR"] } });
```

Each service answers at its own root: the Imaging Server at `/fhir/...`, `/access/v1/evaluation`, `/policy/v2/...` and `/.well-known/...`, whatever `base` it issues URLs under. A host in front of it maps its public paths to those. Keep `/policy/v2` and the proxy's `/internal/...` on internal addresses: don't expose them.

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
| `patientAttributes(patient)` | What policy reads of a patient's record: `{ birthDate }`, for ages |
| `name(ref)` | A reference's display name, for the text of reasons. The default is its id |
| `timeZone` | The organization's time zone, an IANA name, which ages are counted in. UTC unless given. An unknown one throws |
| `serviceSecret` | The credential the proxy presents to the decision API |
| `policySecret` | The credential policy API callers present. Give it to the Authorization Server and administration tools, never the proxy |
| `catalog()` | The catalog to search, asked per request |
| `keyStore` | The `PolicyStore` holding the signing key |
| `store()` | The `PolicyStore` search and decisions use |
| `cursorKey`, `pageBytes` | The paging cursor key, which processes behind one address share, and a page's byte budget (5 MiB) |
| `observer`, `clock` | See above |

It serves:

| Path | |
|---|---|
| `GET /fhir/ImagingStudy` | Search by `patient`, `identifier`, `based-on:identifier`, `_lastUpdated`, `_count` and `_cursor`, with an Endpoint per available study |
| `GET /fhir/metadata` | Its CapabilityStatement |
| `POST /access/v1/evaluation` | AuthZEN evaluation, for the proxy |
| `GET /.well-known/jwks.json`, `/.well-known/authzen-configuration` | Its public keys, and where to ask |
| `/policy/v2/...` | The policy API |

## Policy

Policy has three levels, and references are written `kind:id`, such as `user:sam`, `patient:riley`, `app:portal-app` or `service:referral-service`.

1. **Facts.** Relationships, `{ subject, relation, object, recordedBy? }`, such as `user:sam guardian_of patient:riley`. Labels on studies, such as `confidential-adolescent`, which are catalog data, set from each study's data when it's published. Patient attributes, a birth date, from `patientAttributes`. No fact grants anything alone.
2. **Organization policy.** A fixed list of types, each with an `id` and parameters. Each one grants: none denies.
   - `guardian-access`: `when: { age: { min?, max? } }`, whole years with both ends included and at least one end given, `allow: "all"`, `except`, labels whose studies it doesn't reach, and `knownLabels`, labels it reaches. Bands never overlap: a write that would leave two overlapping gets `400` naming both, so one policy decides what a guardian sees at each age, and adding one can only grant for ages no band covered.
   - `sharing`: `allowedFrom`, `patient`, `guardian` or both: who may share a patient's records.
   - `service-access`: a backend service's access, `service`, `patients` (`any` or one patient), and `allow` (`all`, `sites`, `modalities`, `studies`, `since`), with `withholdSeries`, series it doesn't reach, and `contextForm`.
3. **People's choices**, within level 2. Shares, `{ from, with, patient, sites, label }`, one for each patient, sharer and recipient, where the label is how the person is related, such as caregiver. App approvals, `{ by, app, patient, sites? }`, where no `sites` means everything `by` can see.

Access is the union of every grant that applies. Policies and choices only grant: adding a policy, relationship or choice never takes access away, and their order doesn't matter. Policies may overlap, and their result is the union. Restriction lives only inside a grant's own reach:

- A user's routes to a patient's study are being the patient; being a guardian, once for each `guardian-access` policy whose band holds the patient's age, reaching every study but those with a label it excepts; and each share with them, reaching what the sharer sees now as the patient or a guardian, in a role a `sharing` policy lets them share in, at the sites shared. A share's reach is computed from the sharer's own grants, never from shares they received.
- An app approval narrows: the app gets the user's access, at the approval's sites.
- A backend service gets the union of every `service-access` policy for it and the patient, with no choices. A series one policy withholds and another reaches is released.

Revoking is deleting the grant, by a single removal or by a document write that leaves it out. Removing a guardian relationship removes, in the same write, that guardian's shares for the patient. Removing a share removes the app approvals its recipient made on that patient, so sharing again never brings an app's access back. A guardian whose relationship goes loses their own approvals for the patient too. An approval stays while its maker still has a route to the patient: as the patient, as a guardian a `guardian-access` policy covers, or through another share.

Some grants go quiet rather than being deleted, and come back when their cause does: shares and approvals while no `sharing` policy allows the sharer's role, or no `guardian-access` policy covers the patient's age, including when a patient ages out of a band or their birth date changes.

Labels are facts a grant's reach checks. A study's labels are trimmed and lowercased before matching. A label name is lowercase letters and digits in hyphenated words, and policies' `except` and `knownLabels` take only those. The `guardian-access` policy covering the patient's age decides alone: a study label it neither excepts nor knows, or one that isn't a label name, keeps the study from guardians. Other policies' labels never count. This fails closed at check time, and ingest doesn't refuse the study. A patient's own access, shares from the patient, and services aren't affected.

A birth date is `YYYY-MM-DD` and a real calendar date. A missing, invalid or future one gives no `guardian-access` grant. Age is whole years on today's date in the organization's time zone, the Imaging Server's `timeZone` option, an IANA name, UTC unless given, computed at each check from the clock.

Each decision is a release, a `why`, and `because`: the reasons from every grant that contributed, `{ level, ref, text }`, with `level` one of `fact`, `policy` or `choice`, and for a service, `policies`, the ones that contributed. The text comes from one template per type and level. A share's recipient isn't told why the sharer can't see a study: it may be a label.

Revisions are counted per patient and for policy. A write about one patient's relationships, shares or approvals raises that patient's revision. A write to organization policy or settings, or a reset, raises the policy revision, and the revision of every patient it touches. The decision API returns both in its context, as `policy_revision` and `patient_revision`, and explain returns them as `revision`. They count writes to the store only. Ages change with the clock, and labels with the catalog, so a cache of decisions must not be keyed by revision alone.

Search and decisions read one patient's rows, through indexes by patient, and a user's account reads theirs, by subject. Organization policy is held in memory, by store, and reloaded when it's written.

## The catalog

`createCatalog(path)` opens a SQLite catalog, in memory by default. It holds no policy and is always rebuildable: `rebuildFromArchive(source, catalog)` builds it from the archive, and `catalogFromOrthanc(catalog, orthanc, config)` from Orthanc's QIDO-RS API, with `config` naming each study's id, title, site and labels. A study's labels come from its study document, which ingest writes from each input's `labels`. A catalog from an older schema is rebuilt when it opens. `seedPatientLinks(catalog, people)` links Patient IDs to patients first: a study whose Patient ID has no link is skipped and reported.

## The policy store

`new PolicyStore({ mode, path, durability, onFile })` holds policy (relationships, organization policies, shares, app approvals, revisions, settings), the signing keys, and the Authorization Server's token records, all in one SQLite file, or in memory. `durability` is `off`, `normal` or `full`, SQLite's `synchronous`. A file store is WAL and mode `0600`. `onFile` is `{ relationships, policies }`, what's on file: a new database starts with them, and a reset puts them back. The schema is versioned, at `SCHEMA_VERSION`. A store in any other format isn't read or changed: opening it throws, saying to reset saved policy by deleting the file or using a new one. Every write is validated, and all or none: `PolicyValidationError` lists each problem.

`patientSnapshot(patient)` reads what one decision needs, organization policy and that patient's rows, and `personSnapshot(user)` what a user's account needs. `snapshot()` reads every level, for administration.

## The policy API

Version 2, at `/policy/v2` on the Imaging Server. JSON in and out. Every call carries `Authorization: Bearer {policySecret}`, or gets `401`, and the service credential doesn't work here. It belongs on an internal address only. Every call acts on `store()`. A body that isn't JSON, or one that doesn't validate, gets `400` with `error` and, for a policy, `errors`, naming each field. Every write answers `{ revision }`: the policy revision, and the patient's for a write about one patient, such as `{ "policy": 3, "patient": 7 }`. A removal that matches nothing gets `404`.

| Call | Body or query | Answer |
|---|---|---|
| `GET /document` | | `{ relationships, policies, shares, approvals, revision }` |
| `PUT /document` | Any of those parts | Replaces the parts given. What it leaves out takes what hangs off it, as the single removals do |
| `GET /relationships` | | `{ relationships, revision }` |
| `PUT /relationships` | `{ subject, relation, object, recordedBy? }` | Adds one |
| `DELETE /relationships` | `subject`, `relation`, `object` | Removes one. For `guardian_of`, also that guardian's shares and app approvals for the patient |
| `GET /policies` | `type`, optionally | `{ policies, revision }` |
| `PUT /policies?type={type}` | A list of policies of that type | Replaces every policy of that type |
| `PUT /policies/{id}` | A policy with that id | Adds or replaces one. Its type can't change |
| `DELETE /policies/{id}` | | Removes one |
| `GET /shares` | | `{ shares, revision }` |
| `POST /shares` | `{ from, with, patient, sites, label }`, with `sites` a list of strings | `{ revision, share }`, replacing that sharer's earlier share with that person, with sites narrowed to those the sharer can see. `403` with `{ error, policy }` when no `sharing` policy lets the sharer's role share, or no `guardian-access` policy covers the patient for a guardian |
| `DELETE /shares` | `with`, with `from`, `patient` or both | Removes those, and the recipient's app approvals on those patients |
| `GET /app-approvals` | | `{ approvals, revision }` |
| `POST /app-approvals` | `{ by, app, patient, sites?, fhirUser? }`, with `sites` a list of strings | `{ revision, approval }`, with sites narrowed to what `by` can see, and all of the patient's sites as no limit. With no `sites`, an earlier choice stays. `403` with `{ error, policy }` when `by` holds no record of the patient |
| `DELETE /app-approvals` | `by`, `app`, and optionally `patient` | Removes those |
| `GET /access` | `user`, `fhirUser` | `{ records, shares, approvals }`: the records the user holds and how (`self`, `guardian` or `share`), with the sites they can choose among, and the choices they've made |
| `GET /explain` | `client`, `patient`, and for a launch `user` and `fhirUser` | `{ revision, searchAllowed, policies, studies }`, each study with its `release`, `why`, `because` and `policies`, as search decides it. For a backend service, `policies` are the service-access policies that let it search, and each study's, those that released it |
| `GET /settings` | | `{ contextLifetimeSeconds, maxSeriesInContext, tokenLifetimeSeconds, refreshTokenLifetimeSeconds, revision }` |
| `PATCH /settings` | Any of those | Changes those |
| `POST /reset` | `{ tokens?: boolean }` | Clears shares, approvals and settings, and puts relationships and policies back as they are on file. `tokens: true` clears token records too. The signing key stays |
| `GET /store` | | The store's mode, path, durability, journal mode, schema version, policy revision, and row counts |

A share, refused:

```
POST /policy/v2/shares
{ "from": "user:sam", "with": "user:alex", "patient": "patient:josh", "sites": ["Lakeside Imaging"], "label": "neighbor" }

403 { "error": "Sam is neither Josh nor a guardian, so has nothing to share", "policy": "patients-and-guardians-share" }
```

A study in explain:

```json
{ "id": "skin-biopsy", "release": "none", "why": "confidential adolescent care: guardians-13-to-17 keeps it from guardians",
  "because": [
    { "level": "fact", "ref": "user:sam", "text": "Sam is Riley's guardian" },
    { "level": "policy", "ref": "policy:guardians-13-to-17", "text": "Guardians of patients 13 to 17 see all studies, except those labeled confidential adolescent care" },
    { "level": "fact", "ref": "study:skin-biopsy", "text": "Labeled confidential adolescent care" } ] }
```

`createPolicyClient({ base, policySecret, fetch? })` calls it, with a method for each call: `getDocument`, `setDocument`, `relationships`, `putRelationship`, `removeRelationship`, `policies`, `putPolicy`, `replacePolicies`, `removePolicy`, `shares`, `share`, `removeShares`, `approvals`, `approveApp`, `removeApprovals`, `access`, `explain`, `getSettings`, `setSettings`, `reset`, and `info`. Writes answer the revision. `share` and `approveApp` answer `{ ok: true, revision, share }` or `{ ok: false, refusal }` for a `403`, and the removals `undefined` for a `404`. Anything else that fails throws `PolicyApiError`, with its `status`, message, `errors` and `policy`. `fetch(operation, url, init)` makes each request, so a caller can name and trace it.

## Tests

```sh
cd packages/core && bun test
```

They run without the demo, from fixtures, temporary stores, a clock moved by hand, and an observer that records (`tests/support.ts`, `tests/fake-backend.ts`). The S3 tests make and delete a temporary bucket at `S3_ENDPOINT`, or `http://127.0.0.1:${S3_PORT}` with port 4610 by default, with `S3_ACCESS_KEY` and `S3_SECRET_KEY`. Ingest's conversion tests need DCMTK.
