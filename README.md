# SMART Imaging Proxy Demo

A local demo of a WADO-RS proxy that enforces arbitrary study-level policy without holding any of it. It implements the `spec-clarity-organization` branch of the [SMART Imaging Access guide](https://github.com/argonautproject/smart-imaging). The sample data comes from [jmandel/shlink-dicom](https://github.com/jmandel/shlink-dicom).

## How it works

- **Instant path:** the Imaging Server signs its search decision into `Endpoint.address`. The proxy checks the signature with a public key, along with expiry, study, and a hash of the token. There's no network call for the decision. The proxy reads the public keys from the Imaging Server's JWKS, and refetches them every 60 seconds or when it sees an unknown key.
- **Otherwise, it asks:** a refreshed token, a separate client, or an expired context leads to an [AuthZEN](https://openid.net/specs/authorization-api-1_0.html) evaluation at the Imaging Server, cached briefly.
- **Clients don't change:** the URL is opaque, and any currently valid token covering the study works.

## Running it

Requires Bun, Docker, and DCMTK.

```sh
bun run fetch-data          # downloads the sample data, verifying checksums
bun run ingest              # builds data/studies and data/manifest.json
docker compose up -d        # MinIO and Orthanc, stored under /tmp by default
bun run load                # loads both backends
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

## Layout

| Path | Purpose |
|---|---|
| `src/proxy.ts` | The proxy: fast path, `can_i`, DICOMweb conformance |
| `src/imaging-server.ts` | Search, policy, signed contexts, the decision API |
| `src/auth-server.ts` | SMART Backend Services, a demo consent step, introspection |
| `src/backends/` | Static files and MinIO (`store.ts`), and Orthanc (`orthanc.ts`) |
| `src/flows/` | The 13 flows, shared by the web page and tests |
| `src/trace.ts`, `src/trace-collector.ts` | Spans, correlation, and the live stream |
| `web/` | The flow player and live trace pages |

## Limits

This is a local demo with generated keys. It isn't production code. App Launch uses a demo consent step instead of a browser redirect, and `/rendered` and frames aren't implemented.
