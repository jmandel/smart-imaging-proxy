// Metadata and its bulk data links, through the proxy, on every backend. Every link, at any depth,
// leads to exactly the bytes of its element in the instance the proxy retrieves, and a link is
// authorized like any other retrieval of its instance.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { boundaryOf, BULK_THRESHOLD, readFileMeta, readMultipart } from "@smart-imaging-proxy/core";
import { startStack, type BackendName, type Stack } from "../src/stack";
import { registerClients } from "../src/flows";
import { clientAssertion } from "../src/auth-server";
import { CONFIG } from "../src/config";

const BACKENDS: BackendName[] = (process.env.BACKENDS?.split(",") as BackendName[]) ?? ["static-files", "s3", "orthanc"];
const PATIENTS = ["josh-example", "sam-example", "riley-example"];
const SERVICE = "outside-release-service";
const SLIDE = "slide-lung-2023", CT = "ct-abdomen-pelvis-2012", HAND = "xr-hand-right-2012";
const DICOM = 'multipart/related; type="application/dicom"; transfer-syntax=*';
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const hex = (n: number) => n.toString(16).padStart(4, "0").toUpperCase();

// ---------- A PS3.10 walker of its own, so the comparison doesn't lean on the code it checks ----------

const LONG_VRS = new Set(["OB", "OD", "OF", "OL", "OV", "OW", "SQ", "UC", "UN", "UR", "UT", "SV", "UV"]);

/** The value of the element at `path` (tag, item number from 1, tag, ...), in an Explicit VR Little Endian file. Undefined-length values run through their delimiter. */
function elementAt(b: Uint8Array, path: string): Uint8Array | undefined {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const header = (at: number) => {
    const group = dv.getUint16(at, true), element = dv.getUint16(at + 2, true);
    if (group === 0xfffe) return { group, element, vr: "", length: dv.getUint32(at + 4, true), valueAt: at + 8 };
    const vr = String.fromCharCode(b[at + 4]!, b[at + 5]!);
    return LONG_VRS.has(vr)
      ? { group, element, vr, length: dv.getUint32(at + 8, true), valueAt: at + 12 }
      : { group, element, vr, length: dv.getUint16(at + 6, true), valueAt: at + 8 };
  };
  const UNDEFINED = 0xffffffff;
  const itemEnd = (at: number): number => {
    for (let pos = at; ;) {
      const h = header(pos);
      if (h.group === 0xfffe && h.element === 0xe00d) return h.valueAt;
      pos = valueEnd(h);
    }
  };
  const valueEnd = (h: ReturnType<typeof header>): number => {
    if (h.length !== UNDEFINED) return h.valueAt + h.length;
    for (let at = h.valueAt; ;) {
      const item = header(at);
      if (item.element === 0xe0dd) return item.valueAt;
      at = item.length !== UNDEFINED ? item.valueAt + item.length : itemEnd(item.valueAt);
    }
  };
  const steps = path.toUpperCase().split("/");
  const find = (start: number, end: number, step: number): Uint8Array | undefined => {
    for (let pos = start; pos < end;) {
      const h = header(pos);
      if (h.group === 0xfffe) return undefined;
      const stop = valueEnd(h);
      if (hex(h.group) + hex(h.element) === steps[step]) {
        if (step === steps.length - 1) return b.subarray(h.valueAt, stop);
        let n = 0;
        for (let at = h.valueAt; at < stop;) {
          const item = header(at);
          if (item.element === 0xe0dd) break;
          const close = item.length !== UNDEFINED ? item.valueAt + item.length : itemEnd(item.valueAt);
          if (++n === Number(steps[step + 1])) return find(item.valueAt, close, step + 2);
          at = close;
        }
        return undefined;
      }
      pos = stop;
    }
    return undefined;
  };
  let pos = 132;
  while (dv.getUint16(pos, true) === 0x0002) pos = valueEnd(header(pos));
  return find(pos, b.length, 0);
}

/** Every bulk link in a DICOM JSON item, with the path of the element that holds it, items numbered from 1. */
function bulkLinks(item: any, path = ""): { path: string; uri: string }[] {
  const out: { path: string; uri: string }[] = [];
  for (const [tag, el] of Object.entries<any>(item)) {
    const at = path ? `${path}/${tag}` : tag;
    if (typeof el?.BulkDataURI === "string") out.push({ path: at, uri: el.BulkDataURI });
    if (el?.vr === "SQ") (el.Value ?? []).forEach((child: any, i: number) => out.push(...bulkLinks(child, `${at}/${i + 1}`)));
  }
  return out;
}
/** The decoded size of every InlineBinary value, at any depth. */
function inlineSizes(item: any): number[] {
  const out: number[] = [];
  for (const el of Object.values<any>(item)) {
    if (typeof el?.InlineBinary === "string") out.push(Buffer.from(el.InlineBinary, "base64").length);
    if (el?.vr === "SQ") for (const child of el.Value ?? []) out.push(...inlineSizes(child));
  }
  return out;
}
const sopOf = (item: any) => item["00080018"].Value[0] as string;

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (next < items.length) await fn(items[next++]!); }));
}

// ---------- The stack, and a backend service that can read every patient's studies ----------

let stack: Stack, clients: any;
beforeAll(async () => {
  stack = await startStack(join(import.meta.dir, ".."));
  clients = registerClients(stack);
  await stack.resetAll();
});
afterAll(() => stack.stop());

const serviceToken = async () => (await (await fetch(stack.auth.tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "client_credentials", scope: "system/ImagingStudy.rs", client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: clientAssertion(clients[SERVICE], stack.auth.tokenUrl) }).toString() })).json() as any).access_token as string;
const allowEverything = (withholdSeries?: string[]) => stack.store.replacePolicies("service-access", [{ id: "everything", type: "service-access", service: `service:${SERVICE}`, patients: "any", allow: { all: true }, ...(withholdSeries ? { withholdSeries } : {}) }]);

/** Each study's proxy base, from search, by study id. */
async function studyBases(token: string) {
  const out = new Map<string, { uid: string; base: string }>();
  for (const patient of PATIENTS) {
    const bundle: any = await (await fetch(`${CONFIG.imagingUrl}/fhir/ImagingStudy?patient=${patient}&_include=ImagingStudy:endpoint&_count=100`, { headers: { Authorization: `Bearer ${token}` } })).json();
    for (const e of bundle.entry ?? []) {
      if (e.resource.resourceType !== "ImagingStudy") continue;
      const endpoint = bundle.entry.find((x: any) => x.fullUrl === e.resource.endpoint[0].reference).resource;
      out.set(e.resource.id, { uid: e.resource.identifier[0].value.replace("urn:oid:", ""), base: endpoint.address });
    }
  }
  return out;
}

const getJson = async (url: string, token: string) => {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/dicom+json" } });
  const text = await r.text();
  return { status: r.status, bytes: text.length, items: r.status === 200 ? JSON.parse(text) as any[] : [] };
};
/** Every instance a retrieval returns, by SOP Instance UID. */
async function retrieve(url: string, token: string) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: DICOM } });
  const out = new Map<string, Uint8Array>();
  if (r.status !== 200) { await r.body?.cancel(); return { status: r.status, instances: out }; }
  let chunks: Uint8Array[] = [];
  for await (const e of readMultipart(r.body as any, boundaryOf(r.headers.get("content-type"))!)) {
    if (e.type === "start") chunks = [];
    else if (e.type === "data") chunks.push(e.bytes);
    else if (e.type === "end") { const b = new Uint8Array(Buffer.concat(chunks)); out.set(readFileMeta(b)!.sopInstance, b); }
  }
  return { status: r.status, instances: out };
}
const fetchBulk = async (uri: string, token: string) => {
  const r = await fetch(uri, { headers: { Authorization: `Bearer ${token}`, Accept: "application/octet-stream" } });
  return { status: r.status, length: r.headers.get("content-length"), bytes: new Uint8Array(await r.arrayBuffer()) };
};

/** Instance digests from the first backend, which every other must match. */
const instanceDigests = new Map<string, string>();

for (const backend of BACKENDS) {
  describe(`metadata and bulk data on ${backend}`, () => {
    let token: string, bases: Map<string, { uid: string; base: string }>;
    const hierarchyOf = (id: string) => { const row = stack.catalog.allStudies().find(s => s.id === id)!; return stack.catalog.hierarchies([row.pk]).get(row.pk)!; };
    beforeAll(async () => {
      stack.setBackend(backend);
      await stack.resetAll();
      allowEverything();
      token = await serviceToken();
      bases = await studyBases(token);
    });

    test("search reaches every sample study", () => {
      expect(bases.size).toBe(10);
    });

    if (backend !== "orthanc") test("the slide's series metadata is small, with no large value inline at any depth", async () => {
      expect(BULK_THRESHOLD).toBe(1024);
      const { uid, base } = bases.get(SLIDE)!;
      for (const series of hierarchyOf(SLIDE).series) {
        const r = await getJson(`${base}/studies/${uid}/series/${series.uid}/metadata`, token);
        expect(r.status).toBe(200);
        expect(r.items).toHaveLength(series.instances.length);
        // About 8 KB of ordinary attributes for each instance, against 190 KB when the ICC profile was inline.
        expect(r.bytes).toBeLessThan(10 * 1024 * series.instances.length);
        expect(r.items.flatMap(inlineSizes).filter(n => n > BULK_THRESHOLD)).toEqual([]);
        // The ICC profile is in each instance's Optical Path Sequence, and is a link now.
        for (const item of r.items) expect(bulkLinks(item).map(l => l.path)).toContain("00480105/1/00282000");
      }
    }, 60000);

    test("no study's metadata has a large value inline, at any depth", async () => {
      if (backend === "orthanc") return;
      for (const { uid, base } of bases.values()) {
        const r = await getJson(`${base}/studies/${uid}/metadata`, token);
        expect([uid, r.items.flatMap(inlineSizes).filter(n => n > BULK_THRESHOLD)]).toEqual([uid, []]);
      }
    }, 60000);

    test("every bulk link, at every level, gives exactly its element's bytes from the retrieved instance", async () => {
      // The first backend is a census, which pins the contract for every link. The others check a uniform
      // 30% sample: with ~770 links that is ~230 checks, and a defect present in 2% of links (15) is missed
      // with probability ≈ 0.7^15 ≈ 0.005, so ≥99.5% detection. The first link of every element-path class
      // is always checked, so a systematic per-tag bug cannot slip past the draw. FULL_BULK=1 restores a
      // census on every backend.
      const census = process.env.FULL_BULK === "1" || backend === BACKENDS[0];
      const classes = new Set<string>();
      const sample = (key: string) => {
        let h = 2166136261;
        for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619) >>> 0;
        return (h % 1000) / 1000;
      };
      let links = 0, nested = 0, checked = 0;
      for (const [id, { uid, base }] of bases) {
        const meta = await getJson(`${base}/studies/${uid}/metadata`, token);
        expect([id, meta.status]).toEqual([id, 200]);
        const bySop = new Map(meta.items.map(item => [sopOf(item), item]));
        for (const series of hierarchyOf(id).series) {
          const got = await retrieve(`${base}/studies/${uid}/series/${series.uid}`, token);
          expect([id, series.uid, got.status, got.instances.size]).toEqual([id, series.uid, 200, series.instances.length]);
          const work: { path: string; uri: string; bytes: Uint8Array }[] = [];
          for (const [sop, bytes] of got.instances) {
            const digest = sha(bytes);
            if (!instanceDigests.has(sop)) instanceDigests.set(sop, digest);
            expect([sop, digest]).toEqual([sop, instanceDigests.get(sop)!]);
            const item = bySop.get(sop);
            expect(item).toBeDefined();
            for (const link of bulkLinks(item)) {
              // The link names the element it stands for, and leads through this study's proxy base.
              const uri = `${base}/studies/${uid}/series/${series.uid}/instances/${sop}/bulk/${link.path}`;
              expect(link.uri).toBe(uri);
              links++;
              if (link.path.includes("/")) nested++;
              const cls = link.path.replace(/\d+/g, "#");
              const firstOfClass = !classes.has(cls);
              classes.add(cls);
              if (census || firstOfClass || sample(`${backend}:${sop}:${link.path}`) < 0.3) work.push({ path: link.path, uri, bytes });
            }
          }
          checked += work.length;
          await mapLimit(work, 6, async ({ path, uri, bytes }) => {
            const expected = elementAt(bytes, path);
            expect([path, expected !== undefined]).toEqual([path, true]);
            const r = await fetchBulk(uri, token);
            expect([uri, r.status]).toEqual([uri, 200]);
            if (backend !== "orthanc") expect(r.length).toBe(String(r.bytes.length));
            expect([path, r.bytes.length, sha(r.bytes)]).toEqual([path, expected!.length, sha(expected!)]);
          });
        }
      }
      // The X-rays' LUT Data and the slide's ICC profiles are nested.
      expect(nested).toBeGreaterThanOrEqual(14);
      expect(links).toBeGreaterThan(700);
      if (!census) expect(checked).toBeGreaterThan(links * 0.2);
    }, 600000);

    test("metadata at study, series and instance level holds exactly that level's instances", async () => {
      for (const id of [CT, SLIDE, "xr-wrist-left-2012"]) {
        const { uid, base } = bases.get(id)!;
        const series = hierarchyOf(id).series;
        const study = await getJson(`${base}/studies/${uid}/metadata`, token);
        expect(study.items.map(sopOf).sort()).toEqual(series.flatMap(s => s.instances.map(i => i.uid)).sort());
        for (const s of series) {
          const one = await getJson(`${base}/studies/${uid}/series/${s.uid}/metadata`, token);
          expect([s.uid, one.items.map(sopOf).sort()]).toEqual([s.uid, s.instances.map(i => i.uid).sort()]);
          const sop = s.instances[0]!.uid;
          const inst = await getJson(`${base}/studies/${uid}/series/${s.uid}/instances/${sop}/metadata`, token);
          expect(inst.items.map(sopOf)).toEqual([sop]);
        }
      }
    }, 120000);

    test("a withheld series gets 404 for its metadata, its bulk links and its pixels, and the rest still answer", async () => {
      // Each of this study's three series holds one instance, with LUT Data nested in a sequence.
      const series = hierarchyOf(HAND).series;
      const [withheld, kept] = series as [typeof series[0], typeof series[0]];
      const before = bases.get(HAND)!;
      const openMeta = await getJson(`${before.base}/studies/${before.uid}/series/${withheld.uid}/metadata`, token);
      const links = openMeta.items.flatMap(item => bulkLinks(item).map(l => ({ ...l, sop: sopOf(item) })));
      expect(links.map(l => l.path).sort()).toEqual(["00283010/1/00283006", "7FE00010"]);
      allowEverything([withheld.uid]);
      try {
        const now = (await studyBases(token)).get(HAND)!;
        for (const base of [now.base, `${CONFIG.proxyUrl}/wado/-`]) {
          const study = await getJson(`${base}/studies/${now.uid}/metadata`, token);
          expect(study.items.map(sopOf).sort()).toEqual(series.filter(s => s.uid !== withheld.uid).flatMap(s => s.instances.map(i => i.uid)).sort());
          expect((await getJson(`${base}/studies/${now.uid}/series/${withheld.uid}/metadata`, token)).status).toBe(404);
          expect((await getJson(`${base}/studies/${now.uid}/series/${withheld.uid}/instances/${links[0]!.sop}/metadata`, token)).status).toBe(404);
          for (const l of links) expect((await fetchBulk(`${base}/studies/${now.uid}/series/${withheld.uid}/instances/${l.sop}/bulk/${l.path}`, token)).status).toBe(404);
          expect((await retrieve(`${base}/studies/${now.uid}/series/${withheld.uid}`, token)).status).toBe(404);
          expect((await retrieve(`${base}/studies/${now.uid}/series/${withheld.uid}/instances/${links[0]!.sop}`, token)).status).toBe(404);
          const keptMeta = await getJson(`${base}/studies/${now.uid}/series/${kept.uid}/metadata`, token);
          expect(keptMeta.status).toBe(200);
          for (const l of bulkLinks(keptMeta.items[0])) {
            expect(l.uri).toStartWith(`${base}/studies/${now.uid}/series/${kept.uid}/`);
            expect((await fetchBulk(l.uri, token)).status).toBe(200);
          }
        }
      } finally { allowEverything(); }
    }, 120000);
  });
}
