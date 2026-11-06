# SMART Imaging Proxy Demo

A local demo of a WADO-RS proxy that enforces arbitrary study-level policy without holding any of it. It implements the `spec-clarity-organization` branch of the [SMART Imaging Access guide](https://github.com/argonautproject/smart-imaging). The sample data comes from [jmandel/shlink-dicom](https://github.com/jmandel/shlink-dicom).

## How it works

- **Instant path:** the Imaging Server signs its search decision into `Endpoint.address`. The proxy checks the signature with a public key, along with expiry, study, and a hash of the token. There's no network call.
- **Otherwise, it asks:** a refreshed token, a separate client, or an expired context leads to an [AuthZEN](https://openid.net/specs/authorization-api-1_0.html) evaluation at the Imaging Server, cached briefly.
- **Clients don't change:** the URL is opaque, and any currently valid token covering the study works.

## Running it

Requires Bun, Docker, and DCMTK.

```sh
bun run fetch-data          # downloads the sample data, verifying checksums
bun run ingest              # builds the archive and data/manifest.json. Safe to re-run
docker compose up -d        # MinIO and Orthanc, stored under /tmp by default
bun run load                # copies the archive to MinIO, and adds any study Orthanc lacks
bun run start
```

| What | Where |
|---|---|
| Flow player | http://127.0.0.1:4600 |
| Live trace | http://127.0.0.1:4604 |
| WADO-RS proxy | http://127.0.0.1:4601 |
| Imaging Server | http://127.0.0.1:4602 |
| Authorization Server | http://127.0.0.1:4603 |

Keep `bun run start` stopped while running tests, since both use the same ports.

```sh
bun test                               # every flow on every backend
BACKENDS=static-files bun test         # one backend
```

Everything is rebuildable. `/tmp` storage doesn't survive a reboot, so rerun the steps above if it's gone.

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

- **Ingest** writes content, then documents, then `current.json`, which is what publishes a version. Re-running unchanged input writes nothing. Changed input writes the next version, and earlier versions stay.
- **zstd wrapper:** an object gets one only when that saves at least 5%. So incompressible instances, lossy or not, stay byte-for-byte.
- **Quarantine:** an input that can't be parsed is left out and reported, and other inputs carry on. A study that already has a live version keeps it until its inputs are clean.
- **Serving:** `src/backends/archive.ts` settles every 404, 406 and byte count from the indexes, before opening any content.

## Layout

| Path | Purpose |
|---|---|
| `src/proxy.ts` | The proxy: fast path, `can_i`, DICOMweb conformance |
| `src/imaging-server.ts` | Search, policy, signed contexts, the decision API |
| `src/auth-server.ts` | SMART Backend Services, a demo consent step, introspection |
| `src/archive/` | The archive format: its contract, reader, object stores, and ingest |
| `src/backends/` | Static files and MinIO (`archive.ts`), and Orthanc (`orthanc.ts`) |
| `src/flows/` | The 13 flows, shared by the web page and tests |
| `src/trace.ts`, `src/trace-collector.ts` | Spans, correlation, and the live stream |
| `web/` | The flow player and live trace pages |

## Limits

This is a local demo with generated keys. It isn't production code. App Launch uses a demo consent step instead of a browser redirect, and `/rendered` and frames aren't implemented.
