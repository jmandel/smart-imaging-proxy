// What a review of the deployed sandbox found, each pinned: the clinical server's methods, links that follow
// the address asked, search parameters, shares, registration, and assertions.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { startStack, type Stack } from "../src/stack";
import { CLINICAL_FHIR, scriptedLaunch } from "../src/flows/oauth";

let stack: Stack, conf: any;
beforeAll(async () => { stack = await startStack(join(import.meta.dir, "..")); await stack.resetAll(); conf = await (await fetch(`${CLINICAL_FHIR}/.well-known/smart-configuration`)).json(); });
afterAll(() => stack.stop());
const bearer = (t: any) => ({ authorization: `Bearer ${t.access_token}`, accept: "application/fhir+json" });

describe("The clinical FHIR server is read-only", () => {
  test("anything but GET is 405, with Allow and an OperationOutcome, and changes nothing", async () => {
    const t = await scriptedLaunch("josh", "portal-app", { scope: "launch/patient patient/*.rs" });
    for (const [method, path] of [["PUT", "Patient/josh-example"], ["DELETE", "Patient/josh-example"], ["POST", "Condition"], ["PATCH", "DiagnosticReport"]] as const) {
      const r = await fetch(`${CLINICAL_FHIR}/${path}`, { method, headers: { ...bearer(t), "content-type": "application/fhir+json" }, body: method === "DELETE" ? undefined : "{}" });
      expect([method, path, r.status, r.headers.get("allow")]).toEqual([method, path, 405, "GET"]);
      expect(((await r.json()) as any).resourceType).toBe("OperationOutcome");
    }
    expect((await fetch(`${CLINICAL_FHIR}/Patient/josh-example`, { headers: bearer(t) })).status).toBe(200);
  });
});

describe("Unified topology is one server", () => {
  test("a search asked at the clinical server links there: self, next and every fullUrl", async () => {
    const w = stack.sandboxes.mint();
    w.setTopology("unified");
    const t = await scriptedLaunch("josh", "portal-app", { at: w.urls, scope: "launch/patient patient/*.rs" });
    const base = `${w.urls.auth}/fhir`;
    const b: any = await (await fetch(`${base}/ImagingStudy?patient=josh-example&_include=ImagingStudy:endpoint&_count=2`, { headers: bearer(t) })).json();
    for (const l of b.link) expect([l.relation, l.url.startsWith(`${base}/ImagingStudy?`)]).toEqual([l.relation, true]);
    expect(b.link.map((l: any) => l.relation)).toEqual(["self", "next"]);
    for (const e of b.entry.filter((e: any) => e.resource.resourceType === "ImagingStudy")) expect(e.fullUrl.startsWith(`${base}/ImagingStudy/`)).toBe(true);
    const next: any = await (await fetch(b.link[1].url, { headers: bearer(t) })).json();
    expect(next.entry.length).toBeGreaterThan(0);
    // The separate server still names its own base.
    w.setTopology("separate");
    const own: any = await (await fetch(`${w.urls.imaging}/fhir/ImagingStudy?patient=josh-example`, { headers: bearer(t) })).json();
    expect(own.link[0].url.startsWith(`${w.urls.imaging}/fhir/`)).toBe(true);
  });
});

describe("A search says what it didn't apply", () => {
  const imaging = () => conf.associated_endpoints[0].url;
  test("an unsupported parameter is left out of the links, and named in an outcome entry", async () => {
    const t = await scriptedLaunch("josh");
    const b: any = await (await fetch(`${imaging()}/ImagingStudy?patient=josh-example&modality=CT&based-on=ServiceRequest/1&_include=ImagingStudy:endpoint&_include=ImagingStudy:subject&_count=2`, { headers: bearer(t) })).json();
    expect(b.total).toBe(6);
    expect(b.link[0].url).toBe(`${imaging()}/ImagingStudy?patient=josh-example&_include=ImagingStudy:endpoint&_count=2`);
    expect(b.link[1].url).not.toContain("modality");
    const outcome = b.entry.find((e: any) => e.search?.mode === "outcome");
    expect(outcome.resource.issue[0]).toMatchObject({ severity: "warning", code: "not-supported" });
    expect(outcome.resource.issue[0].diagnostics).toContain("modality, based-on, _include=ImagingStudy:subject");
  });
  test("with Prefer: handling=strict, it's a 400", async () => {
    const t = await scriptedLaunch("josh");
    const r = await fetch(`${imaging()}/ImagingStudy?patient=josh-example&started=gt2015`, { headers: { ...bearer(t), prefer: "handling=strict" } });
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).issue[0].diagnostics).toContain("started");
    expect((await fetch(`${imaging()}/ImagingStudy?patient=josh-example&_count=1`, { headers: { ...bearer(t), prefer: "handling=strict" } })).status).toBe(200);
  });
  test("a search with only supported parameters has no outcome entry, and its self link is what was asked", async () => {
    const t = await scriptedLaunch("josh");
    const b: any = await (await fetch(`${imaging()}/ImagingStudy?patient=josh-example&_count=100`, { headers: bearer(t) })).json();
    expect(b.entry.every((e: any) => e.search.mode !== "outcome")).toBe(true);
    expect(b.link[0].url).toBe(`${imaging()}/ImagingStudy?patient=josh-example&_count=100`);
  });
});

describe("The Authorization Server's pages", () => {
  test("can't be framed, run no script, and aren't cached", async () => {
    const r = await fetch(`${conf.authorization_endpoint}?response_type=code&client_id=portal-app&redirect_uri=x`);
    expect(r.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(r.headers.get("content-security-policy")).not.toContain("script-src");
    expect([r.headers.get("x-frame-options"), r.headers.get("x-content-type-options"), r.headers.get("cache-control")]).toEqual(["DENY", "nosniff", "no-store"]);
  });
});

describe("A report finds its images", () => {
  test("by an accession number with the studies' own system, or by the study's DICOM UID, and never by an address that isn't served", async () => {
    const t = await scriptedLaunch("josh", "portal-app", { scope: "launch/patient patient/*.rs" });
    const imaging = conf.associated_endpoints[0].url;
    const reports: any = await (await fetch(`${CLINICAL_FHIR}/DiagnosticReport?patient=josh-example`, { headers: bearer(t) })).json();
    expect(reports.entry.length).toBeGreaterThan(0);
    for (const r of reports.entry.map((e: any) => e.resource)) {
      const acc = r.identifier[0], ref = r.imagingStudy[0];
      expect(ref.reference).toBeUndefined();
      for (const q of [`identifier=${encodeURIComponent(`${acc.system}|${acc.value}`)}`, `identifier=${encodeURIComponent(`${ref.identifier.system}|${ref.identifier.value}`)}`]) {
        const b: any = await (await fetch(`${imaging}/ImagingStudy?patient=josh-example&${q}`, { headers: bearer(t) })).json();
        expect([r.id, q, b.total]).toEqual([r.id, q, 1]);
      }
    }
  });
});

describe("The reference client resolves an Endpoint as the Bundle rules say", async () => {
  const { resolveEndpoint } = await import("../ui/lib/smart-imaging");
  const ep = (id: string) => ({ resourceType: "Endpoint", id, address: `https://wado/${id}` });
  const study = { resourceType: "ImagingStudy", id: "s1" };
  test("relative against the owner's own base; absolute and urn: by fullUrl; contained by #id", () => {
    const entries = [{ fullUrl: "https://a.example/fhir/ImagingStudy/s1", resource: study }, { fullUrl: "https://b.example/fhir/Endpoint/e1", resource: ep("e1") }, { fullUrl: "https://a.example/fhir/Endpoint/e2", resource: ep("e2") }, { fullUrl: "urn:uuid:u1", resource: ep("u1") }] as any[];
    // Another server's Endpoint/e1 isn't this study's, though its fullUrl ends the same way.
    expect(resolveEndpoint(study, "Endpoint/e1", entries)).toBeUndefined();
    expect(resolveEndpoint(study, "Endpoint/e2", entries)?.id).toBe("e2");
    expect(resolveEndpoint(study, "https://b.example/fhir/Endpoint/e1", entries)?.id).toBe("e1");
    expect(resolveEndpoint(study, "urn:uuid:u1", entries)?.id).toBe("u1");
    expect(resolveEndpoint({ ...study, contained: [ep("wado")] }, "#wado", entries)?.id).toBe("wado");
  });
  test("a relative reference from an owner with a urn: fullUrl, or by resource id alone, resolves to nothing", () => {
    const entries = [{ fullUrl: "urn:uuid:s1", resource: study }, { fullUrl: "urn:uuid:e3", resource: ep("e3") }] as any[];
    expect(resolveEndpoint(study, "Endpoint/e3", entries)).toBeUndefined();
  });
});

describe("The policy API refuses what would mean nothing", () => {
  test("a share with someone who isn't one of the people, with oneself, or of a site that doesn't exist; a relationship other than guardian_of", async () => {
    const w = stack.sandboxes.mint(), p = (w as any).policy;
    const share = (o: Record<string, unknown>) => p.share({ from: "user:josh", with: "user:alex-neighbor", patient: "patient:josh-example", sites: ["Lakeside Imaging"], label: "neighbor", ...o });
    await expect(share({ with: "user:nobody" })).rejects.toThrow("isn't one of this deployment's people");
    await expect(share({ with: "user:josh" })).rejects.toThrow("with someone else");
    await expect(share({ sites: ["Lakeside Imaging", "Nowhere"] })).rejects.toThrow("not a site: Nowhere");
    expect(await p.shares()).toEqual([]);
    expect(await share({})).toMatchObject({ ok: true });
    await expect(p.putRelationship({ subject: "user:sam-caregiver", relation: "owner_of", object: "patient:josh-example" })).rejects.toThrow("guardian_of");
    await expect(p.putRelationship({ subject: "user:nobody", relation: "guardian_of", object: "patient:josh-example" })).rejects.toThrow("people");
  });
});

describe("The token's scope is what was granted", () => {
  const consentWith = async (scope: string, form: Record<string, string>) => {
    const { buildAuthorization, tokenRequestBody } = await import("../src/flows/oauth");
    const a = buildAuthorization(conf.authorization_endpoint, "portal-app", scope);
    const act = (html: string, base: string) => new URL(html.match(/<form[^>]*action="([^"]+)"/)![1]!.replace(/&amp;/g, "&"), base).toString();
    const post = (to: string, o: Record<string, string>) => fetch(to, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o).toString(), redirect: "manual" });
    const signedIn = await post(act(await (await fetch(a.url)).text(), a.url), { username: "josh" });
    const consentUrl = new URL(signedIn.headers.get("location")!, a.url).toString();
    const page = await (await fetch(consentUrl)).text();
    const back = await post(act(page, consentUrl), { decision: "approve", patient: "josh-example", ...form });
    const code = new URL(back.headers.get("location")!).searchParams.get("code")!;
    const t: any = await (await fetch(conf.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: tokenRequestBody(a, code) })).json();
    return { page, t };
  };
  test("only what this server honors: no writes, no user- or unknown-type scopes, and no openid without an id_token", async () => {
    const { t } = await consentWith("launch/patient patient/*.cruds user/*.* patient/Observation.rs openid fhirUser bogus offline_access", {});
    expect(t.scope).toBe("launch/patient patient/*.rs offline_access");
    expect(t.refresh_token).toBeString();
  });
  test("the consent page offers the clinical record, and unticked, the scope leaves it out and its reads are refused", async () => {
    const { page, t } = await consentWith("launch/patient patient/*.rs", { clinical_shown: "1" });
    expect(page).toContain('name="share_clinical"');
    expect(t.scope).toBe("launch/patient patient/ImagingStudy.rs patient/DiagnosticReport.rs patient/Patient.rs");
    for (const type of ["Condition", "MedicationRequest", "AllergyIntolerance"]) expect((await fetch(`${CLINICAL_FHIR}/${type}?patient=josh-example`, { headers: bearer(t) })).status).toBe(403);
    expect((await fetch(`${CLINICAL_FHIR}/Patient/josh-example`, { headers: bearer(t) })).status).toBe(200);
    expect((await fetch(`${conf.associated_endpoints[0].url}/ImagingStudy?patient=josh-example`, { headers: bearer(t) })).status).toBe(200);
  });
  test("ticked, or posted without the choice, the clinical record is shared", async () => {
    for (const form of [{ clinical_shown: "1", share_clinical: "1" }, {}]) {
      const { t } = await consentWith("launch/patient patient/*.rs", form);
      expect(t.scope).toBe("launch/patient patient/*.rs");
      expect((await fetch(`${CLINICAL_FHIR}/Condition?patient=josh-example`, { headers: bearer(t) })).status).toBe(200);
    }
  });
  test("a request that asks for no clinical type isn't offered the choice", async () => {
    const { page, t } = await consentWith("launch/patient patient/ImagingStudy.rs", {});
    expect(page).not.toContain("share_clinical");
    expect(t.scope).toBe("launch/patient patient/ImagingStudy.rs");
  });
});

describe("Staged one-shot 503s are each token's own", () => {
  test("one app's first search and retrieval don't spend another's", async () => {
    const w = stack.sandboxes.mint();
    w.setFaults({ searchRetryAfter: 1, retrievalRetryAfter: 1 });
    const imaging = `${w.urls.imaging}/fhir/ImagingStudy?patient=josh-example&_include=ImagingStudy:endpoint`;
    const sam = await scriptedLaunch("josh", "portal-app", { at: w.urls }), josh = await scriptedLaunch("josh", "portal-app", { at: w.urls });
    const search = (t: any) => fetch(imaging, { headers: bearer(t) });
    expect((await search(sam)).status).toBe(503);
    expect((await search(josh)).status).toBe(503);
    expect((await search(josh)).status).toBe(200);
    const b: any = await (await search(sam)).json();
    const study = b.entry.find((e: any) => e.resource.resourceType === "ImagingStudy").resource;
    const address = b.entry.find((e: any) => e.resource.resourceType === "Endpoint").resource.address;
    const uid = study.identifier.find((i: any) => i.system === "urn:dicom:uid").value.replace("urn:oid:", "");
    // The context in the address is bound to the token that searched; the other token gets its own address.
    const meta = (t: any, a: string) => fetch(`${a}/studies/${uid}/metadata`, { headers: { authorization: `Bearer ${t.access_token}`, accept: "application/dicom+json" } });
    expect((await meta(sam, address)).status).toBe(503);
    expect((await meta(sam, address)).status).toBe(200);
    const jb: any = await (await search(josh)).json();
    const jaddress = jb.entry.find((e: any) => e.resource.resourceType === "Endpoint").resource.address;
    expect((await meta(josh, jaddress)).status).toBe(503);
    expect((await meta(josh, jaddress)).status).toBe(200);
  });
});

describe("Revoking a token ends its retrievals at once", () => {
  test("by /revoke: search, the signed address and an unsigned one all refuse it", async () => {
    const w = stack.sandboxes.mint();
    const t = await scriptedLaunch("josh", "portal-app", { at: w.urls });
    const b: any = await (await fetch(`${w.urls.imaging}/fhir/ImagingStudy?patient=josh-example&_include=ImagingStudy:endpoint`, { headers: bearer(t) })).json();
    const study = b.entry.find((e: any) => e.resource.resourceType === "ImagingStudy").resource;
    const address = b.entry.find((e: any) => e.resource.resourceType === "Endpoint").resource.address;
    const uid = study.identifier.find((i: any) => i.system === "urn:dicom:uid").value.replace("urn:oid:", "");
    const meta = (a: string) => fetch(`${a}/studies/${uid}/metadata`, { headers: { authorization: `Bearer ${t.access_token}`, accept: "application/dicom+json" } });
    const unsigned = `${w.urls.proxy}/wado/-`;
    expect([(await meta(address)).status, (await meta(unsigned)).status]).toEqual([200, 200]);
    await fetch(`${w.urls.auth}/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: t.access_token }) });
    expect([(await meta(address)).status, (await meta(unsigned)).status]).toEqual([401, 401]);
  });
});
