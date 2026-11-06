// Checks behavior against the guide's own text on the latest branch. Each test quotes the
// requirement, and fails if that text is no longer in the spec, so the two can't drift apart.
// Also checks Griffin's points from the 2026-11-06 call, and the AuthZEN API.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { startStack, type BackendName, type Stack } from "../src/stack";
import { registerClients } from "../src/flows";
import { clientAssertion } from "../src/auth-server";
import { CONFIG } from "../src/config";
import { boundaryOf, readMultipart } from "../src/multipart";
import { createProxy } from "../src/proxy";
import { scriptedLaunch } from "../src/flows/oauth";
import { OrthancBackend } from "../src/backends/orthanc";
import { generateEd25519, signJws, ath } from "../src/jws";
import { now } from "../src/clock";
import { EVRLE, JPEG_BASELINE, JPEG_LOSSLESS, isStandard } from "../src/syntax";

const SPEC_REPO = process.env.SPEC_REPO ?? "/home/jmandel/work/smart-imaging-spec-clarity";
const SPEC_REF = process.env.SPEC_REF ?? "origin/spec-clarity-organization";
const specText = new TextDecoder().decode(Bun.spawnSync(["git", "-C", SPEC_REPO, "show", `${SPEC_REF}:input/pagecontent/specification.md`]).stdout);
const says = (quote: string) => { if (!specText.includes(quote)) throw new Error(`Not in ${SPEC_REF}: ${quote}`); };

const part = (s: string, q?: number) => `multipart/related; type=application/dicom; transfer-syntax=${s}${q !== undefined ? `; q=${q}` : ""}`;
let stack: Stack, clients: any, token: string, bundle: any;
const WRIST = "xr-wrist-left-2012", SLIDE = "slide-lung-2023";
const res = (id: string) => bundle.entry.find((e: any) => e.resource.id === id)?.resource;
const base = (id: string) => bundle.entry.find((e: any) => e.fullUrl === res(id).endpoint[0].reference).resource.address;
const uid = (id: string) => res(id).identifier[0].value.replace("urn:oid:", "");
const launch = (user = "josh", client = "portal-app") => scriptedLaunch(user, client);
const searchFor = (t: string, q: string) => fetch(`${CONFIG.imagingUrl}/fhir/ImagingStudy?${q}`, { headers: { Authorization: `Bearer ${t}` } });

async function get(url: string, accept: string | undefined, t: string | undefined = token) {
  const headers: Record<string, string> = { Accept: accept ?? "" };
  if (t) headers.Authorization = `Bearer ${t}`;
  const r = await fetch(url, { headers });
  const partsOut: { syntax?: string; rawType?: string; bytes: number }[] = [];
  let complete = false;
  const b = boundaryOf(r.headers.get("content-type"));
  if (r.ok && b) {
    let cur: any;
    for await (const e of readMultipart(r.body as any, b)) {
      if (e.type === "start") { cur = { rawType: e.headers["content-type"], syntax: e.headers["content-type"]?.match(/transfer-syntax=([^;\s]+)/)?.[1], bytes: 0 }; partsOut.push(cur); }
      else if (e.type === "data") cur.bytes += e.bytes.length;
      else if (e.type === "complete") complete = true;
    }
  } else await r.body?.cancel();
  return { status: r.status, parts: partsOut, complete, headers: r.headers, contentType: r.headers.get("content-type") };
}

beforeAll(async () => {
  stack = await startStack(join(import.meta.dir, ".."));
  clients = registerClients(stack);
  stack.resetAll();
  token = (await launch()).access_token;
  bundle = await (await searchFor(token, "patient=josh-example&_include=ImagingStudy:endpoint")).json();
});
afterAll(() => stack.stop());

describe("Discovery and search", () => {
  test("smart-imaging-access and mode capabilities are advertised", async () => {
    says("SHALL advertise imaging support with the capability string **`smart-imaging-access`**");
    says("SHALL additionally advertise `http://fhir.org/argonaut/smart-imaging/capabilities/backend-services`");
    const c: any = await (await fetch(`${CONFIG.authUrl}/fhir/.well-known/smart-configuration`)).json();
    expect(c.associated_endpoints[0].capabilities).toEqual(expect.arrayContaining(["smart-imaging-access", "http://fhir.org/argonaut/smart-imaging/capabilities/app-launch", "http://fhir.org/argonaut/smart-imaging/capabilities/backend-services"]));
    expect(c.grant_types_supported).toEqual(expect.arrayContaining(["authorization_code", "client_credentials"]));
  });
  test("required and recommended search combinations work", async () => {
    says("The Imaging FHIR Server SHALL support these search parameter combinations");
    says("The Imaging FHIR Server SHOULD also support these search parameter combinations");
    const ids = async (q: string) => { const b: any = await (await searchFor(token, q)).json(); return b.entry.filter((e: any) => e.resource.resourceType === "ImagingStudy").map((e: any) => e.resource.id); };
    expect((await ids("patient=josh-example")).length).toBe(6);
    expect(await ids(`patient=josh-example&identifier=urn:dicom:uid%7Curn:oid:${uid(WRIST)}`)).toEqual([WRIST]);
    expect(await ids(`patient=josh-example&identifier=urn:oid:${uid(WRIST)}`)).toEqual([WRIST]);
    const accession = res(WRIST).identifier[1].value;
    expect(await ids(`patient=josh-example&identifier=${accession}`)).toEqual([WRIST]);
    expect(await ids(`patient=josh-example&identifier=http://hospital.example.org/accession%7C${accession}`)).toEqual([WRIST]);
    expect(await ids(`patient=josh-example&based-on:identifier=${accession}`)).toEqual([WRIST]);
    expect((await ids("patient=josh-example&_lastUpdated=gt2022-01-01T00:00:00Z"))).toEqual(["slide-lung-2023"]);
  });
  test("a patient mismatch is 403, not an empty Bundle", async () => {
    says("a mismatch receives `403 Forbidden`, not an empty Bundle");
    expect((await searchFor(token, "patient=robin-example")).status).toBe(403);
  });
  test("Endpoints are response-local, and included without _include", async () => {
    says("including when the request omits `_include`");
    says("A response-local Endpoint uses a `urn:uuid` value in `Bundle.entry.fullUrl`");
    const b: any = await (await searchFor(token, "patient=josh-example")).json();
    const eps = b.entry.filter((e: any) => e.resource.resourceType === "Endpoint");
    expect(eps.length).toBe(6);
    for (const e of eps) { expect(e.fullUrl).toStartWith("urn:uuid:"); expect(e.resource.connectionType.code).toBe("dicom-wado-rs"); }
  });
  test("available studies list every released series and instance, with SOP Class", async () => {
    says("the study SHALL list its released series");
    for (const s of bundle.entry.filter((e: any) => e.resource.resourceType === "ImagingStudy").map((e: any) => e.resource)) {
      expect(s.status).toBe("available");
      expect(s.series.length).toBe(s.numberOfSeries);
      expect(s.series.reduce((n: number, x: any) => n + x.instance.length, 0)).toBe(s.numberOfInstances);
      for (const x of s.series) for (const i of x.instance) { expect(i.uid).toBeTruthy(); expect(i.sopClass.code).toStartWith("urn:oid:"); }
    }
  });
  test("the Accession Number is in both places", async () => {
    says("it SHALL include it in `ImagingStudy.identifier[accession]`");
    says("SHOULD also populate `ImagingStudy.basedOn.identifier`");
    const s = res(WRIST);
    expect(s.identifier[1].type.coding[0].code).toBe("ACSN");
    expect(s.basedOn[0].identifier.value).toBe(s.identifier[1].value);
  });
  test("a system token never grants access without configured policy", async () => {
    says("Missing patient context SHALL NOT be treated as authorization for system-level access");
    const c = clients["hand-referral-service"];
    const t: any = await (await fetch(stack.auth.tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "client_credentials", scope: "system/ImagingStudy.rs", client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: clientAssertion(c, stack.auth.tokenUrl) }).toString() })).json();
    expect((await searchFor(t.access_token, "patient=josh-example")).status).toBe(403);
    expect((await get(`${CONFIG.proxyUrl}/wado/-/studies/${uid(WRIST)}`, part("*"), t.access_token)).status).toBe(404);
  });
});

for (const backend of (process.env.BACKENDS?.split(",") ?? ["static-files", "minio", "orthanc"]) as BackendName[]) {
  describe(`Griffin's points and retrieval rules: ${backend}`, () => {
    beforeAll(() => stack.setBackend(backend));
    const sw = () => stack.setBackend(backend);

    test("study, series and instance retrieval, with no /rendered required", async () => {
      sw();
      says("A SMART WADO-RS Endpoint SHALL support study-, series-, and instance-level DICOM retrieval");
      const s = res(WRIST), series = s.series[0].uid, inst = s.series[0].instance[0].uid;
      expect((await get(`${base(WRIST)}/studies/${uid(WRIST)}`, part(EVRLE))).parts.length).toBe(3);
      expect((await get(`${base(WRIST)}/studies/${uid(WRIST)}/series/${series}`, part(EVRLE))).parts.length).toBe(1);
      const one = await get(`${base(WRIST)}/studies/${uid(WRIST)}/series/${series}/instances/${inst}`, part(EVRLE));
      expect(one.parts.length).toBe(1);
      expect(one.complete).toBe(true);
      expect((await get(`${base(WRIST)}/studies/${uid(WRIST)}/rendered`, "image/png")).status).toBe(501);
    });
    test("a client listing only what it decodes gets exactly that, without *", async () => {
      sw();
      says("Apps that only decode standard transfer syntaxes omit `*`");
      const r = await get(`${base(WRIST)}/studies/${uid(WRIST)}`, part(EVRLE));
      expect(r.status).toBe(200);
      expect(r.parts.every(p => p.syntax === EVRLE)).toBe(true);
    });
    test("every part declares its transfer syntax", async () => {
      sw();
      says("Every response part SHALL declare the transfer syntax of the returned instance in its `Content-Type` header");
      for (const r of [await get(`${base(WRIST)}/studies/${uid(WRIST)}`, part("*")), await get(`${base(SLIDE)}/studies/${uid(SLIDE)}`, part("*"))]) {
        expect(r.parts.length).toBeGreaterThan(0);
        for (const p of r.parts) expect(p.rawType).toMatch(/^application\/dicom; transfer-syntax=[0-9.]+$/);
      }
    });
    test("web responses never use Implicit VR or Big Endian, as PS3.18 requires", async () => {
      sw();
      const r = await get(`${base(WRIST)}/studies/${uid(WRIST)}`, part("*"));
      expect(r.parts.some(p => p.syntax === "1.2.840.10008.1.2" || p.syntax === "1.2.840.10008.1.2.2")).toBe(false);
    });
    test("* is as stored, adds no lossy compression, and hides private syntaxes", async () => {
      sw();
      says("returning each instance as stored without adding lossy compression");
      says("SHOULD NOT return a private transfer syntax unless the request lists it explicitly");
      const slide = await get(`${base(SLIDE)}/studies/${uid(SLIDE)}`, part("*"));
      expect(slide.parts.some(p => p.syntax === JPEG_BASELINE)).toBe(true);
      const wrist = await get(`${base(WRIST)}/studies/${uid(WRIST)}`, part("*"));
      expect(wrist.parts.every(p => p.syntax === EVRLE)).toBe(true);
      expect(wrist.parts.every(p => p.syntax && isStandard(p.syntax))).toBe(true);
    });
    test("q weights are followed, even on a backend that uses only the top item", async () => {
      sw();
      says("`Accept` takes a comma-separated list of media types with `q` weights");
      const r = await get(`${base(WRIST)}/studies/${uid(WRIST)}`, `${part("1.2.840.10008.1.2.4.203")}, ${part(JPEG_LOSSLESS, 0.8)}, ${part(EVRLE, 0.5)}`);
      expect(r.status).toBe(200);
      expect(r.parts.every(p => p.syntax === JPEG_LOSSLESS || p.syntax === EVRLE)).toBe(true);
      if (backend !== "orthanc") expect(r.parts.every(p => p.syntax === JPEG_LOSSLESS)).toBe(true);
    });
    test("q=0 excludes a syntax", async () => {
      sw();
      const r = await get(`${base(WRIST)}/studies/${uid(WRIST)}`, `${part(EVRLE, 0)}, ${part(JPEG_LOSSLESS)}`);
      expect(r.status === 406 || r.parts.every(p => p.syntax !== EVRLE)).toBe(true);
    });
    test("nothing acceptable is 406, as Griffin argued, not the default syntax", async () => {
      sw();
      says("If the DICOMweb Server cannot provide any transfer syntax accepted by the request, it SHALL respond `406 Not Acceptable`");
      const r = await get(`${base(WRIST)}/studies/${uid(WRIST)}`, part("1.2.840.10008.1.2.4.203"));
      expect(r.status).toBe(406);
      expect(r.parts.length).toBe(0);
      expect((await get(`${base(WRIST)}/studies/${uid(WRIST)}`, "")).status).toBe(406);
    });
    test("the lossy exception is used or the data is decoded, never mislabeled", async () => {
      sw();
      says("except where the pixel data is available only in a lossy transfer syntax defined by the DICOM Standard");
      const r = await get(`${base(SLIDE)}/studies/${uid(SLIDE)}`, part(EVRLE));
      if (backend === "orthanc") { expect(r.status).toBe(200); expect(r.parts.every(p => p.syntax === EVRLE)).toBe(true); }
      else { expect(r.status).toBe(406); }
    }, 120000);
    test("Key Object style workflow: read the manifest, then fetch one instance by SOP Class", async () => {
      sw();
      says("retrieve a single instance, such as a Key Object Selection");
      const ct = res("ct-abdomen-pelvis-2012");
      const sr = ct.series.find((s: any) => s.modality.code === "SR");
      const i = sr.instance[0];
      expect(i.sopClass.code).toContain("1.2.840.10008.5.1.4.1.1.88");
      const r = await get(`${base("ct-abdomen-pelvis-2012")}/studies/${uid("ct-abdomen-pelvis-2012")}/series/${sr.uid}/instances/${i.uid}`, part("*"));
      expect(r.parts.length).toBe(1);
      expect(r.complete).toBe(true);
    });
    test("the URL is opaque and isn't a credential, as Griffin warned", async () => {
      sw();
      says("Apps SHALL treat `Endpoint.address` as an opaque WADO-RS base URL");
      const r = await get(`${base(WRIST)}/studies/${uid(WRIST)}`, part(EVRLE), "");
      expect(r.status).toBe(401);
      expect(r.headers.get("www-authenticate")).toContain("Bearer");
    });
    test("any currently valid token covering the study works, with no client change", async () => {
      sw();
      says("SHALL accept any currently valid SMART token from the configured Authorization Server that authorizes access to the study");
      const other = (await launch()).access_token;
      expect((await get(`${base(WRIST)}/studies/${uid(WRIST)}`, part(EVRLE), other)).status).toBe(200);
    });
    test("status codes follow PS3.18 8.5: unreleased and nonexistent look the same", async () => {
      sw();
      says("Status codes follow [PS3.18 §8.5]");
      says("A DICOMweb Server can respond `404 Not Found` to requests for excluded series or instances so that a client cannot infer that they exist");
      const none = await get(`${CONFIG.proxyUrl}/wado/-/studies/1.2.3.4.5`, part("*"));
      expect(none.status).toBe(404);
      expect((await get(`${base(WRIST)}/studies/${uid(WRIST)}/series/1.2.3.4.5`, part("*"))).status).toBe(404);
    });
    test("metadata exposes no internal hosts, and its bulk links work", async () => {
      sw();
      const r = await fetch(`${base(WRIST)}/studies/${uid(WRIST)}/metadata`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/dicom+json" } });
      expect(r.headers.get("content-type")).toContain("application/dicom+json");
      const text = await r.text();
      expect(text).not.toContain(":4611");
      expect(text).not.toContain(":4610");
      const uri = text.match(/"BulkDataURI":"([^"]+7FE00010)"/)?.[1]!;
      expect(uri).toStartWith(CONFIG.proxyUrl);
      expect((await fetch(uri, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
    });
  });
}

describe("The caller's token never reaches the backend, as #16 requires", () => {
  test("an upstream sees only the proxy's own credential", async () => {
    says("without forwarding the bearer token to internal PACS or archive systems");
    const seen: Record<string, string>[] = [];
    const up = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) { seen.push(Object.fromEntries(req.headers)); return new Response("--b--\r\n", { headers: { "content-type": 'multipart/related; type="application/dicom"; boundary=b' } }); } });
    const k = generateEd25519("t");
    const proxy = createProxy({ publicBase: () => "http://x", keys: new Map([["t", k.publicKey]]), decisionUrl: "http://127.0.0.1:1/none", serviceSecret: "s", backend: () => new OrthancBackend({ base: `http://127.0.0.1:${up.port}`, user: "svc", password: "pw" }) });
    const secret = "the-callers-secret-token";
    const ctx = signJws(k, { v: 1, study: "1.2", ath: ath(secret), exp: now() + 60 });
    await proxy.fetch(new Request(`http://x/wado/${ctx}/studies/1.2?accept=application/zip&includefield=all`, { headers: { Authorization: `Bearer ${secret}`, Accept: part("*"), Cookie: "a=b", "X-Forwarded-For": "1.1.1.1" } }));
    up.stop(true);
    expect(seen.length).toBeGreaterThan(0);
    const text = JSON.stringify(seen);
    expect(text).not.toContain(secret);
    expect(text).not.toContain("a=b");
    expect(text).not.toContain("1.1.1.1");
    expect(seen[0]!.authorization).toStartWith("Basic ");
  });
});

describe("AuthZEN Authorization API 1.0, Access Evaluation", () => {
  // The service secret is private to the stack, so these check what a caller without it sees,
  // and drive the rest through a recording of the proxy's real traffic.
  const url = `${CONFIG.imagingUrl}/access/v1/evaluation`;
  test("metadata is at the well-known path, as JSON, with the required fields", async () => {
    const r = await fetch(`${CONFIG.imagingUrl}/.well-known/authzen-configuration`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/json");
    const m: any = await r.json();
    expect(m.policy_decision_point).toBe(CONFIG.imagingUrl);
    expect(m.access_evaluation_endpoint).toBe(url);
  });
  test("authentication failure is 401, with WWW-Authenticate and the request ID", async () => {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-request-id": "abc" }, body: "{}" });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toBeTruthy();
    expect(r.headers.get("x-request-id")).toBe("abc");
  });
  test("the proxy's real decisions have the spec's shape", async () => {
    stack.setBackend("static-files");
    const other = (await launch()).access_token;
    const start = stack.imaging.decisions.length;
    await get(`${base(WRIST)}/studies/${uid(WRIST)}`, part(EVRLE), other);
    const d = stack.imaging.decisions.slice(start)[0];
    for (const k of ["subject", "resource", "action"]) expect(d.request[k]).toBeTruthy();
    expect(typeof d.request.subject.type).toBe("string");
    expect(typeof d.request.subject.id).toBe("string");
    expect(typeof d.request.resource.type).toBe("string");
    expect(typeof d.request.resource.id).toBe("string");
    expect(typeof d.request.action.name).toBe("string");
    expect(typeof d.response.decision).toBe("boolean");
  });
  test("a true decision the proxy doesn't understand fails closed", async () => {
    const pdp = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ decision: true, context: { release: "something-new" } }) });
    let opened = false;
    const proxy = createProxy({ publicBase: () => "http://x", keys: new Map(), decisionUrl: `http://127.0.0.1:${pdp.port}/access/v1/evaluation`, serviceSecret: "s", backend: () => { opened = true; throw new Error("must not reach the backend"); } });
    const r = await proxy.fetch(new Request("http://x/wado/-/studies/1.2", { headers: { Authorization: "Bearer t", Accept: part("*") } }));
    pdp.stop(true);
    expect(r.status).toBe(503);
    expect(opened).toBe(false);
  });
  test("a false decision never proceeds, and a failed PDP releases nothing", async () => {
    for (const reply of [() => Response.json({ decision: false }), () => Response.json({ error: "boom" }, { status: 500 }), () => new Response("not json")]) {
      const pdp = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: reply });
      let opened = false;
      const proxy = createProxy({ publicBase: () => "http://x", keys: new Map(), decisionUrl: `http://127.0.0.1:${pdp.port}/x`, serviceSecret: "s", backend: () => { opened = true; throw new Error("no"); } });
      const r = await proxy.fetch(new Request("http://x/wado/-/studies/1.2", { headers: { Authorization: "Bearer t", Accept: part("*") } }));
      pdp.stop(true);
      expect([404, 503]).toContain(r.status);
      expect(opened).toBe(false);
    }
  });
});
