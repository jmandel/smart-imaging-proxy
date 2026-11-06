// Loads the ingested dataset into MinIO and Orthanc. Run after `docker compose up -d`.
import { join } from "node:path";
import { S3Client } from "bun";
import { CONFIG } from "../src/config";

const root = join(import.meta.dir, "..");
const manifest = await Bun.file(join(root, "data/manifest.json")).json();
const dir = join(root, "data/studies");

const wait = async (url: string, init?: RequestInit) => {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(url, init); if (r.status < 500) return; } catch {}
    await Bun.sleep(1000);
  }
  throw new Error(`timed out waiting for ${url}`);
};

// MinIO: create the bucket with a signed request, then upload.
const s3 = new S3Client({ endpoint: CONFIG.minio.endpoint, accessKeyId: CONFIG.minio.accessKey, secretAccessKey: CONFIG.minio.secretKey, bucket: CONFIG.minio.bucket });
await wait(`${CONFIG.minio.endpoint}/minio/health/live`);
await Bun.spawn(["curl", "-s", "--aws-sigv4", "aws:amz:us-east-1:s3", "--user", `${CONFIG.minio.accessKey}:${CONFIG.minio.secretKey}`, "-X", "PUT", `${CONFIG.minio.endpoint}/${CONFIG.minio.bucket}`], { stdout: "ignore", stderr: "ignore" }).exited;

const auth = "Basic " + btoa(`${CONFIG.orthanc.user}:${CONFIG.orthanc.password}`);
await wait(`${CONFIG.orthanc.base}/system`, { headers: { Authorization: auth } });

let uploaded = 0, sent = 0;
for (const study of manifest.studies) {
  for (const series of study.series) {
    await s3.write(`${study.uid}/${series.uid}/.keep`, "");
    for (const inst of series.instances) {
      await s3.write(`${study.uid}/${series.uid}/${inst.uid}.json`, Bun.file(join(dir, study.uid, series.uid, `${inst.uid}.json`)));
      for (const rep of inst.representations) { await s3.write(rep.key, Bun.file(join(dir, rep.key))); uploaded++; }
      // Orthanc gets each instance once, in a standard syntax.
      const rep = inst.representations.find((r: any) => !r.private && r.key.endsWith(`${inst.uid}.dcm`));
      const r = await fetch(`${CONFIG.orthanc.base}/instances`, { method: "POST", headers: { Authorization: auth, "Content-Type": "application/dicom" }, body: Bun.file(join(dir, rep.key)) });
      if (!r.ok) throw new Error(`Orthanc rejected ${inst.uid}: ${r.status}`);
      sent++;
    }
  }
  console.log(`${study.id} loaded`);
}
console.log(`MinIO objects: ${uploaded}, Orthanc instances: ${sent}`);
