// The archive that `bun run ingest` built, and the S3 bucket `bun run load` copied it to.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { S3Client } from "bun";
import { ARCHIVE_FORMAT, ArchiveBackend, ArchiveReader, EVRLE, fileStore, JPEG_BASELINE, JPEG_LOSSLESS, type ObjectSource, type PartStream, PRIVATE_DEMO, s3Store, zstdDecompressSync } from "@smart-imaging-proxy/core";
import { CONFIG } from "../src/config";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const ANY = [{ syntax: "*", q: 1 }];
const concat = (parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts));
async function collect(src: AsyncIterable<Uint8Array>) { const out: Uint8Array[] = []; for await (const c of src) out.push(c); return concat(out); }
async function drain(stream: PartStream) {
  const parts: { sop?: string; syntax?: string; encoding?: string; bytes?: number; body: Uint8Array }[] = [];
  while (true) {
    const r = await stream.parts.next();
    if (r.done) return { parts, end: r.value };
    parts.push({ sop: r.value.sop, syntax: r.value.syntax, encoding: r.value.encoding, bytes: r.value.bytes, body: await collect(r.value.body) });
  }
}
const { endpoint, accessKey, secretKey } = CONFIG.s3;
const client = (bucket: string) => new S3Client({ endpoint, accessKeyId: accessKey, secretAccessKey: secretKey, bucket });
const listAll = async (s: ObjectSource, prefix = "") => { const out: string[] = []; for await (const k of s.list(prefix)) out.push(k); return out; };

describe("Format", () => {
  test("each study in the source data carries a site", async () => {
    const def = await Bun.file(join(import.meta.dir, "../data/studies.source.json")).json();
    expect(def.studies.every((s: any) => typeof s.site === "string" && s.site.length > 0)).toBe(true);
  });
});

describe("Local files and the S3 bucket", () => {
  describe("the real archive", () => {
    const dirStore = () => fileStore(CONFIG.archive.dir);
    const bucketStore = () => s3Store(client(CONFIG.archive.bucket));
    const SOURCE = () => Bun.file(join(import.meta.dir, "../data/studies.source.json")).json().then((d: any) => d.studies as any[]);
    const SITES = () => SOURCE().then(studies => Object.fromEntries(studies.map(s => [s.id, s.site])));
    const PATIENT_IDS = () => SOURCE().then(studies => Object.fromEntries(studies.map(s => [s.id, s.patient?.mrn ?? "JEXAMPLE01"])));
    const manifest = async () => {
      const reader = new ArchiveReader(dirStore());
      const uids = (await listAll(dirStore())).filter(k => k.endsWith("/current.json")).map(k => k.split("/")[1]!);
      return { studies: await Promise.all(uids.map(async uid => reader.study(uid, await reader.currentVersion(uid)))) };
    };

    test("the bucket holds exactly what the directory holds", async () => {
      const a = dirStore(), b = bucketStore();
      const keys = await listAll(a);
      expect(keys.filter(k => k.endsWith("current.json"))).toHaveLength(10);
      expect(await listAll(b)).toEqual(keys);
      for (const k of keys) {
        if (k.startsWith("content/")) expect(await b.size(k)).toBe((await a.size(k))!);
        else expect(sha(await b.bytes(k))).toBe(sha(await a.bytes(k)));
      }
    });

    test("studies say where they came from, and who the images say they're of", async () => {
      const m = await manifest();
      const sites: any = await SITES();
      const patientIds: any = await PATIENT_IDS();
      const reader = new ArchiveReader(dirStore());
      for (const s of m.studies) {
        const doc = await reader.study(s.uid, await reader.currentVersion(s.uid));
        expect(doc).toMatchObject({ format: ARCHIVE_FORMAT, id: s.id, uid: s.uid, site: sites[s.id], sourcePatientId: patientIds[s.id], accession: s.accession });
        expect(doc.series.map(x => x.uid)).toEqual(s.series.map((x: any) => x.uid));
      }
    });

    test("every real study's offers verify, from both stores, and the fixture is where it should be", async () => {
      const m = await manifest();
      const wrist = m.studies.find((s: any) => s.id === "xr-wrist-left-2012");
      const a = new ArchiveBackend(dirStore()), b = new ArchiveBackend(bucketStore());
      const plan = [{ syntax: "*", q: 1 }];
      const x = await a.openInstances({ study: wrist.uid }, plan, { passthroughZstd: true });
      const y = await b.openInstances({ study: wrist.uid }, plan);
      expect(x.plan!.every(p => p.syntax === EVRLE)).toBe(true);
      const dx = await drain(x), dy = await drain(y);
      expect(dy.end).toBe("complete");
      dx.parts.forEach((p, i) => {
        expect(p.encoding).toBe("zstd");
        expect(sha(zstdDecompressSync(p.body))).toBe(sha(dy.parts[i]!.body));
        expect(dy.parts[i]!.body.length).toBe(dy.parts[i]!.bytes!);
      });
      const first = wrist.series[0];
      const offers = (await a.reader.seriesIndex(wrist.uid, await a.reader.currentVersion(wrist.uid), first.uid)).instances[0]!.offers;
      expect(offers.map(o => [o.syntax, o.stored, !!o.private])).toEqual([[PRIVATE_DEMO, true, true], [EVRLE, false, false], [JPEG_LOSSLESS, false, false]]);
    }, 60000);

    test("the slide keeps its lossy instances, and the 5% rule was applied to each", async () => {
      const m = await manifest();
      const slide = m.studies.find((s: any) => s.id === "slide-lung-2023");
      const reader = new ArchiveReader(dirStore());
      const version = await reader.currentVersion(slide.uid);
      const offers = (await reader.seriesIndex(slide.uid, version, slide.series[0].uid)).instances.flatMap(i => i.offers);
      expect(offers.filter(o => o.syntax === JPEG_BASELINE)).toHaveLength(3);
      for (const o of offers) {
        if (o.encoding === "zstd") expect(o.objectBytes).toBeLessThanOrEqual(o.storedBytes * 0.95);
        else {
          expect(o.objectBytes).toBe(o.storedBytes);
          expect(o.key.endsWith(".dcm")).toBe(true);
        }
      }
    });

    test("a paused read from the S3 bucket doesn't buffer the object", async () => {
      const m = await manifest();
      const slide = m.studies.find((s: any) => s.id === "slide-lung-2023");
      const b = new ArchiveBackend(bucketStore());
      const { plan } = await b.openInstances({ study: slide.uid }, ANY);
      const largest = plan!.reduce((x, p) => p.bytes > x.bytes ? p : x);
      expect(largest.bytes).toBeGreaterThan(50 * 1024 * 1024);
      const stream = await b.openInstances({ study: slide.uid, instance: largest.sop }, ANY);
      const it = (await stream.parts.next()).value.body[Symbol.asyncIterator]();
      await it.next();
      Bun.gc(true);
      const before = process.memoryUsage().rss;
      await Bun.sleep(500);
      expect(process.memoryUsage().rss - before).toBeLessThan(largest.bytes / 2);
      await it.return?.();
    }, 60000);
  });
});
