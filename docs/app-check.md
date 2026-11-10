# App check: what is graded, and why

The App check grades an app from the server side, from a sandbox's activity log, while the sandbox stages conditions a server may impose. The grading is in `src/app-check.ts`; this is its list, with sources. Quotes are from SMART Imaging Access as built on build.fhir.org (`ai.zip`, November 2026), FHIR R4 and DICOM PS3.18.

## Requirements (graded)

Each fails only on a clear violation, seen in a request the app made during the run. With no request it covers, it reads "Nothing to check".

| # | Requirement | Fails when | Source |
|---|---|---|---|
| 1 | Each retrieval sends the token of the search that gave its address | A retrieval through an address issued to one of the app's tokens carries no token, or a different token | [SIA, Retrieving images](https://build.fhir.org/ig/argonautproject/smart-imaging/specification.html#retrieving-images): "It SHALL send the same SMART access token used for the authorized FHIR request in the Authorization header." |
| 2 | Each retrieval uses its study's `Endpoint.address` as given | A retrieval with the app's token uses no address a search returned (such as `/wado/-/…`, built by the app), an address not issued to its tokens, or another study's address | [SIA, Retrieving images](https://build.fhir.org/ig/argonautproject/smart-imaging/specification.html#retrieving-images): "Clients SHALL treat returned addresses as opaque base URLs, preserve their capability information when constructing retrieval paths…"; [SIA, Responsibilities by actor](https://build.fhir.org/ig/argonautproject/smart-imaging/specification.html#token-validation-and-access-enforcement-both-modes): the app "SHALL … present it only to … WADO-RS endpoints the Imaging Server has designated (via Endpoint.address)." |
| 3 | Endpoints in every form are resolved | With `endpoint-forms` staged, the app retrieved through Endpoints of some form but never through one of another form it was given | [SIA, Finding studies](https://build.fhir.org/ig/argonautproject/smart-imaging/specification.html#finding-studies): "Apps SHALL support all three forms and resolve references using the FHIR Bundle reference-resolution rules." |
| 4 | Each retrieval sends an Accept header | A retrieval has no `Accept` | [DICOM PS3.18 §8.4.1.1](https://dicom.nema.org/medical/dicom/current/output/html/part18.html#sect_8.4.1.1): "All requests that might have a response containing a payload shall provide an Accept Header Field." |

Not graded, because the server side can't see them or can't tie them to the app: discovery reads ("Clients using in-band discovery SHALL check the corresponding imaging-specific capability"), a search with no token (no token, no client), a retrieval with neither token nor issued address, and where else the app sends its token. Sign-in rules (PKCE S256, `state`, `aud`, assertions) are enforced by the sign-in server: an app that breaks them gets no token, and fails the script's first step.

## The script (graded against the server's own answer)

Not spec requirements: whether the app did what the run asked. Each step depends on the one before.

1. Signed in as the script's user for its patient (or, for `service`, a `client_credentials` token).
2. Approved everything offered: no search's `withheld` names a study the person can see but the app wasn't approved for.
3. Searched for the patient: a search answered 200.
4. Found every study the server released: the studies across the app's searches cover the search's `total`. So Riley's 1 of 2 and Robin's 0 pass; an app that stopped at page one fails. If `total` differs from a new sandbox's (6, 1 of 2, 0, 6), the result says the sandbox's policy was changed.
5. Opened every study it found: a complete image retrieval (study, series, instance or bulk) from each study with an Endpoint.

## Staged conditions

| Condition | Fault | What the spec allows |
|---|---|---|
| `small-pages` | `pageSize: 2` | FHIR R4 Search §3.1.1.5.3: servers "may return less than the client requested" |
| `search-503` | `searchRetryAfter: 1`, the first search, once | SIA, Finding studies: "the server MAY respond 503 … Retry-After" |
| `retrieval-503` | `retrievalRetryAfter: 1`, the first retrieval, once | SIA, Retrieving images: "the endpoint MAY respond 503 with a Retry-After header" |
| `endpoint-forms` | `endpointForms: true`, the three forms in turn | SIA, Finding studies: response-local, separately addressable, or contained. Response-local is only a SHOULD for capability URLs |

## Beyond what the spec guarantees (notes, not failures)

| Note | Shown when | Why it isn't promised |
|---|---|---|
| Relied on one page of results | Found fewer than `total` | FHIR R4 §3.1.0.14: "The client must use the server supplied links in order to traverse the pages" (lowercase must); §3.1.1.5.3: a server may return fewer than `_count` |
| Gave up on a search or retrieval answered 503 with Retry-After | A staged 503 with no later identical request | SIA: "The app SHOULD wait … and repeat the identical request" |
| Repeated a request before Retry-After had passed | The repeat came sooner than asked | Same SHOULD |
| Asked for `/frames`, `/rendered` or `/thumbnail` | Any 501 for these | Server SHOULDs only; "Apps SHOULD degrade gracefully … fall back to full-study retrieval". Says whether the app fell back |
| Searched without `_include=ImagingStudy:endpoint` | Any 200 search without it | The server SHALL include response-local Endpoints anyway; separately recorded Endpoints come only when asked |
| Searched for a patient the token isn't for | A 403 for patient mismatch | The server SHALL refuse; the app gets nothing |

## For Josh to decide

- Building WADO-RS URLs itself is graded as a failure (requirement 2), since the spec has two SHALLs on it. The brief listed it as a note.
- Following `next` is a note, and an app that doesn't fails only the script's "found every study" step.
- Waiting out a 503 is a SHOULD, so only a note; an app that gives up fails the script's "opened every study".
