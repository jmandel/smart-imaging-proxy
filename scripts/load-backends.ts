// Copies the archive into the S3 bucket, and fills in any study Orthanc doesn't have. Run after
// `docker compose up -d` and `bun run ingest`. Safe to repeat: only differences are written.
import { S3Client } from "bun";
import { ArchiveReader, chooseOffer, fileStore, s3Store, zstdDecompressSync } from "@smart-imaging-proxy/core";
import { CONFIG, STORAGE } from "../src/config";
import { existsSync } from "node:fs";

const wait = async (url: string, init?: RequestInit) => {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(url, init); if (r.status < 500) return; } catch {}
    await Bun.sleep(1000);
  }
  throw new Error(`timed out waiting for ${url}`);
};

const local = fileStore(CONFIG.archive.dir);
const keys: string[] = [];
for await (const k of local.list("")) keys.push(k);
if (!keys.some(k => k.endsWith("/current.json"))) throw new Error(`no published studies in ${CONFIG.archive.dir}: run the ingest first`);

// The S3 store: create the bucket with a signed request, then upload.
const { endpoint, accessKey, secretKey } = CONFIG.s3;
const { bucket } = CONFIG.archive;
const signed = (method: string, url: string) => Bun.spawnSync(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "--aws-sigv4", "aws:amz:us-east-1:s3", "--user", `${accessKey}:${secretKey}`, "-X", method, url]).stdout.toString();
// A store can answer its health check before it serves requests, so wait for a signed one.
for (let i = 0; signed("GET", `${endpoint}/`) !== "200"; i++) { if (i > 120) throw new Error(`${endpoint} never answered a signed request`); await Bun.sleep(500); }
signed("PUT", `${endpoint}/${bucket}`);
const remote = s3Store(new S3Client({ endpoint, accessKeyId: accessKey, secretAccessKey: secretKey, bucket }));

// The same publish order as ingest: content, then documents, then each `current.json`.
const rank = (k: string) => k.endsWith("/current.json") ? 2 : k.startsWith("content/") ? 0 : 1;
keys.sort((a, b) => rank(a) - rank(b));
const same = (a: Uint8Array, b: Uint8Array) => Buffer.compare(a, b) === 0;
let uploaded = 0, skipped = 0;
for (const key of keys) {
  const held = await remote.size(key);
  // Content is named by its hash, so a matching size means it's there. Anything else is small enough to compare.
  const unchanged = held !== undefined && (key.startsWith("content/") ? held === await local.size(key) : same(await local.bytes(key), await remote.bytes(key)));
  if (unchanged) { skipped++; continue; }
  await remote.write(key, Bun.file(`${CONFIG.archive.dir}/${key}`));
  uploaded++;
}
console.log(`S3 bucket ${bucket}: ${uploaded} objects uploaded, ${skipped} already there`);

// Orthanc gets a study only if it doesn't have it, each instance once, in a standard syntax. Where
// it isn't installed (scripts/backends.ts), there's nothing to load.
const auth = "Basic " + btoa(`${CONFIG.orthanc.user}:${CONFIG.orthanc.password}`);
if (!existsSync(`${STORAGE}/bin/Orthanc`)) { console.log("Orthanc: not installed here, skipped"); process.exit(0); }
await wait(`${CONFIG.orthanc.base}/system`, { headers: { Authorization: auth } });
const reader = new ArchiveReader(local, { currentTtlMs: 0 });
let sent = 0, present = 0;
for (const key of keys.filter(k => k.endsWith("/current.json"))) {
  const uid = key.split("/")[1]!;
  const lookup = await fetch(`${CONFIG.orthanc.base}/tools/lookup`, { method: "POST", headers: { Authorization: auth }, body: uid });
  if (!lookup.ok) throw new Error(`Orthanc lookup failed: ${lookup.status}`);
  if ((await lookup.json() as any[]).some(m => m.Type === "Study")) { present++; continue; }
  const version = await reader.currentVersion(uid);
  for (const s of (await reader.study(uid, version)).series) {
    for (const inst of (await reader.seriesIndex(uid, version, s.uid)).instances) {
      const offer = chooseOffer(inst.offers, [{ syntax: "*", q: 1 }])!;
      const stored = await local.bytes(offer.key);
      const r = await fetch(`${CONFIG.orthanc.base}/instances`, { method: "POST", headers: { Authorization: auth, "Content-Type": "application/dicom" }, body: offer.encoding === "zstd" ? zstdDecompressSync(stored) : stored });
      if (!r.ok) throw new Error(`Orthanc rejected ${inst.uid}: ${r.status}`);
      sent++;
    }
  }
}
console.log(`Orthanc: ${present} studies already present, ${sent} instances sent`);
