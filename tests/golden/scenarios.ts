// The search behavior the catalog must preserve: a set of users and queries, run over HTTP against
// a stack, with everything random or time-dependent normalized. capture.ts writes the results to
// search.json, and tests/golden.test.ts compares a current run against that file.
import { createHash } from "node:crypto";
import { clientAssertion } from "../../src/auth-server";
import { CONFIG } from "../../src/config";
import { now } from "../../src/clock";
import { scriptedLaunch } from "../../src/flows/oauth";

const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16);
// With one origin, the proxy and Authorization Server share a base, so the proxy is told apart by its path.
const hosts = (s: string) => s.replaceAll(CONFIG.imagingUrl, "{imaging}").replaceAll(`${CONFIG.proxyUrl}/wado/`, "{proxy}/wado/").replaceAll(CONFIG.authUrl, "{auth}").replaceAll(CONFIG.proxyUrl, "{proxy}");
const payloadOf = (jws: string) => JSON.parse(Buffer.from(jws.split(".")[1]!, "base64url").toString());

/** Replaces random and time-dependent values. Long instance lists become a count and hashes. */
export function normalizeBody(body: any): any {
  if (body?.resourceType !== "Bundle") return body;
  body = { ...body, entry: body.entry ?? [] }; // An empty search has no `entry`, and the captures list none.
  const endpointOwner = new Map<string, string>();
  for (const e of body.entry) if (e.resource.resourceType === "ImagingStudy") for (const r of e.resource.endpoint ?? []) endpointOwner.set(r.reference, e.resource.id);
  const local = (ref: string) => `urn:uuid:{endpoint of ${endpointOwner.get(ref)}}`;
  return {
    ...body,
    link: body.link.map((l: any) => ({ ...l, url: hosts(l.url) })),
    entry: body.entry.map((e: any) => {
      const r = e.resource;
      if (r.resourceType === "Endpoint") {
        const jws = r.address.split("/wado/")[1];
        const { ath: _ath, exp, ...claims } = payloadOf(jws);
        return { ...e, fullUrl: local(e.fullUrl), resource: { ...r, id: "{uuid}", address: "{proxy}/wado/{signed context}" }, context: { ...claims, ath: "{token hash}", expiresInAbout: Math.round((exp - now()) / 10) * 10 } };
      }
      return {
        ...e, fullUrl: hosts(e.fullUrl),
        resource: {
          ...r, subject: { reference: hosts(r.subject.reference) },
          ...(r.endpoint ? { endpoint: r.endpoint.map((x: any) => ({ reference: local(x.reference) })) } : {}),
          ...(r.series ? { series: r.series.map((s: any) => { const { instance, ...rest } = s; return { ...rest, instanceCount: instance.length, instances: sha(instance), instancesAnyOrder: sha(instance.map((i: any) => JSON.stringify(i)).sort()) }; }) } : {}),
        },
      };
    }),
  };
}

const normalizeDecision = (d: any) => {
  const { decision_id: _id, max_age_seconds, ...context } = d.response.context;
  return { decision: d.response.decision, why: d.why, context: { ...context, decision_id: "{id}", maxAgeAbout: Math.round((max_age_seconds ?? 0) / 10) * 10 } };
};

export async function runScenarios(stack: any, clients: any) {
  const out: Record<string, unknown> = {};
  const search = async (token: string | undefined, q: string) => {
    const r = await fetch(`${CONFIG.imagingUrl}/fhir/ImagingStudy?${q}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    const text = await r.text();
    return { status: r.status, contentType: r.headers.get("content-type"), wwwAuthenticate: r.headers.get("www-authenticate") ?? undefined, body: text ? JSON.parse(text) : undefined };
  };
  const record = async (name: string, token: string | undefined, q: string) => { const r = await search(token, q); out[name] = { query: q, ...r, body: normalizeBody(r.body) }; return r; };
  const backendToken = async (id: string) => (await (await fetch(stack.auth.tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "client_credentials", scope: "system/ImagingStudy.rs", client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: clientAssertion(clients[id], stack.auth.tokenUrl) }).toString() })).json() as any).access_token as string;
  const fresh = () => stack.resetAll();
  /** One service-access policy, replacing any other. */
  const service = (id: string, client: string, patients: string, allow: object, extra: object = {}) => stack.store.replacePolicies("service-access", [{ id, type: "service-access", service: `service:${client}`, patients, allow, ...extra }]);
  const JOSH = "patient:josh-example";
  const ALL = "patient=josh-example&_include=ImagingStudy:endpoint";

  // Josh, with nothing restricted, and every query form.
  await fresh();
  const josh = (await scriptedLaunch("josh")).access_token;
  const all = (await search(josh, ALL)).body;
  const study = (id: string) => all.entry.find((e: any) => e.resource.id === id).resource;
  const wrist = study("xr-wrist-left-2012"), ct = study("ct-abdomen-pelvis-2012"), mri = study("mri-brain-2020");
  const wristUid = wrist.identifier[0].value, wristAccession = wrist.identifier[1].value;
  const ACCESSION = "http://hospital.example.org/accession";
  await record("no token", undefined, ALL);
  await record("unknown token", "not-a-token", ALL);
  await record("josh: all, with _include", josh, ALL);
  await record("josh: all, without _include", josh, "patient=josh-example");
  await record("josh: patient as a relative reference", josh, "patient=Patient/josh-example");
  await record("josh: patient as an absolute reference", josh, `patient=${encodeURIComponent(`${CONFIG.authUrl}/fhir/Patient/josh-example`)}`);
  await record("josh: no patient parameter", josh, "_include=ImagingStudy:endpoint");
  await record("josh: another patient", josh, "patient=robin-example");
  await record("josh: identifier with system", josh, `patient=josh-example&identifier=${encodeURIComponent(`urn:dicom:uid|${wristUid}`)}`);
  await record("josh: identifier without system", josh, `patient=josh-example&identifier=${encodeURIComponent(wristUid)}`);
  await record("josh: identifier with the wrong system", josh, `patient=josh-example&identifier=${encodeURIComponent(`urn:other|${wristUid}`)}`);
  await record("josh: identifier with an empty system", josh, `patient=josh-example&identifier=${encodeURIComponent(`|${wristAccession}`)}`);
  await record("josh: accession without system", josh, `patient=josh-example&identifier=${wristAccession}`);
  await record("josh: accession with system", josh, `patient=josh-example&identifier=${encodeURIComponent(`${ACCESSION}|${wristAccession}`)}`);
  await record("josh: identifier matching nothing", josh, "patient=josh-example&identifier=nothing");
  await record("josh: based-on without system", josh, `patient=josh-example&based-on:identifier=${wristAccession}`);
  await record("josh: based-on with system", josh, `patient=josh-example&based-on:identifier=${encodeURIComponent(`${ACCESSION}|${wristAccession}`)}`);
  await record("josh: based-on with the wrong system", josh, `patient=josh-example&based-on:identifier=${encodeURIComponent(`urn:other|${wristAccession}`)}`);
  await record("josh: based-on with a Study UID", josh, `patient=josh-example&based-on:identifier=${encodeURIComponent(wristUid)}`);
  await record("josh: _lastUpdated after 2022", josh, "patient=josh-example&_lastUpdated=gt2022-01-01T00:00:00Z");
  await record("josh: _lastUpdated after 2012-10-09", josh, "patient=josh-example&_lastUpdated=gt2012-10-09T00:00:00Z");
  await record("josh: _lastUpdated after everything", josh, "patient=josh-example&_lastUpdated=gt2030-01-01T00:00:00Z");
  await record("josh: _lastUpdated with the ge prefix", josh, "patient=josh-example&_lastUpdated=ge2022-01-01T00:00:00Z");
  await record("josh: identifier and _lastUpdated", josh, `patient=josh-example&identifier=${wristAccession}&_lastUpdated=gt2022-01-01T00:00:00Z`);

  await fresh();
  const noScope = await scriptedLaunch("josh", "portal-app", { scope: "launch/patient online_access" });
  await record("josh: a token without imaging scope", noScope.access_token, ALL);

  // App approvals narrow the patient's own access.
  await fresh();
  await record("josh: app approved for Riverside", (await scriptedLaunch("josh", "portal-app", { sites: ["Riverside Hospital"] })).access_token, ALL);
  await fresh();
  await record("josh: app approved for two sites", (await scriptedLaunch("josh", "portal-app", { sites: ["Lakeside Imaging", "Northside Pathology"] })).access_token, ALL);
  await fresh();
  await record("josh: app approved for no sites", (await scriptedLaunch("josh", "portal-app", { sites: [] })).access_token, ALL);

  // Related people.
  await fresh();
  stack.store.putShare({ from: "user:josh", with: "user:sam-caregiver", patient: JOSH, sites: ["Lakeside Imaging", "Riverside Hospital"], label: "caregiver" });
  await record("sam: holds two sites, app given everything", (await scriptedLaunch("sam-caregiver", "portal-app", { patient: "josh-example" })).access_token, ALL);
  await record("sam: app given one held and one unheld site", (await scriptedLaunch("sam-caregiver", "portal-app", { sites: ["Lakeside Imaging", "Northside Pathology"], patient: "josh-example" })).access_token, ALL);
  await fresh();
  out["alex: no delegation"] = await scriptedLaunch("alex-neighbor");

  // Robin has an account and no studies.
  await fresh();
  const robin = (await scriptedLaunch("robin")).access_token;
  await record("robin: own records are an empty result", robin, "patient=robin-example&_include=ImagingStudy:endpoint");
  await record("robin: josh's records", robin, ALL);

  // Another user-facing app, as its approval allows.
  await fresh();
  await record("josh: separate viewer approved for all sites", (await scriptedLaunch("josh", "separate-viewer")).access_token, ALL);
  await fresh();
  await record("josh: separate viewer approved for no sites", (await scriptedLaunch("josh", "separate-viewer", { sites: [] })).access_token, ALL);

  // Backend Services.
  await fresh();
  await record("backend: no rule", await backendToken("hand-referral-service"), ALL);
  await fresh();
  service("hand", "hand-referral-service", JOSH, { modalities: ["CR"] });
  const hand = await backendToken("hand-referral-service");
  await record("backend: CR only", hand, ALL);
  await record("backend: another patient", hand, "patient=robin-example");
  await fresh();
  service("hand", "hand-referral-service", JOSH, { modalities: ["CR", "MR"] });
  await record("backend: CR and MR", await backendToken("hand-referral-service"), ALL);
  await fresh();
  service("recent", "research-donation", "any", { since: "2020-01-01" });
  await record("backend: since 2020", await backendToken("research-donation"), ALL);
  await fresh();
  service("sites", "research-donation", "any", { sites: ["Riverside Hospital"] });
  await record("backend: one site", await backendToken("research-donation"), ALL);
  const hideSome = ct.series.filter((s: any) => /Clinical Documents|Dose Report/.test(s.description)).map((s: any) => s.uid);
  await fresh();
  service("hide", "outside-release-service", JOSH, { studies: ["ct-abdomen-pelvis-2012"] }, { withholdSeries: hideSome });
  await record("backend: withheld series", await backendToken("outside-release-service"), ALL);
  await fresh();
  service("hide", "outside-release-service", JOSH, { studies: ["ct-abdomen-pelvis-2012"] }, { withholdSeries: ct.series.map((s: any) => s.uid) });
  await record("backend: every series withheld", await backendToken("outside-release-service"), ALL);
  await fresh();
  service("long", "outside-release-service", JOSH, { studies: ["mri-brain-2020"] }, { withholdSeries: [mri.series[0].uid] });
  stack.store.setSettings({ maxSeriesInContext: 12 });
  await record("backend: series list too long for the URL", await backendToken("outside-release-service"), ALL);
  await fresh();
  service("long", "outside-release-service", JOSH, { studies: ["mri-brain-2020"] }, { withholdSeries: [mri.series[0].uid] });
  stack.store.setSettings({ maxSeriesInContext: 40 });
  await record("backend: series list fits in the URL", await backendToken("outside-release-service"), ALL);
  await fresh();
  service("form", "research-donation", "any", { all: true }, { contextForm: "restricted" });
  await record("backend: restricted form", await backendToken("research-donation"), ALL);
  await fresh();
  service("gone", "research-donation", "any", { all: true });
  stack.store.removePolicy("gone");
  await record("backend: policy removed", await backendToken("research-donation"), ALL);
  await fresh();
  service("short", "research-donation", "any", { all: true });
  stack.store.setSettings({ contextLifetimeSeconds: 60 });
  await record("backend: short context lifetime", await backendToken("research-donation"), ALL);

  // Decisions, as the proxy receives them, for a URL that doesn't answer on its own.
  const askFor = async (name: string, token: string, s: any) => {
    const before = stack.imaging.decisions.length;
    const r = await fetch(`${CONFIG.proxyUrl}/wado/-/studies/${s.identifier[0].value.replace("urn:oid:", "")}/series/${s.series[0].uid}/instances/${s.series[0].instance[0].uid}`, { headers: { Authorization: `Bearer ${token}`, Accept: "multipart/related; type=application/dicom; transfer-syntax=*" } });
    await r.body?.cancel();
    out[name] = { status: r.status, decisions: stack.imaging.decisions.slice(before).map(normalizeDecision) };
  };
  await fresh();
  await askFor("can_i: allowed", (await scriptedLaunch("josh")).access_token, wrist);
  await fresh();
  await askFor("can_i: denied by sites", (await scriptedLaunch("josh", "portal-app", { sites: ["Lakeside Imaging"] })).access_token, wrist);
  await fresh();
  service("hide", "outside-release-service", JOSH, { studies: ["ct-abdomen-pelvis-2012"] }, { withholdSeries: hideSome });
  await askFor("can_i: series subset", await backendToken("outside-release-service"), ct);

  // Several patients, and one person choosing among them.
  const SAM = "patient=sam-example&_include=ImagingStudy:endpoint", RILEY = "patient=riley-example&_include=ImagingStudy:endpoint";
  const sam = (patient: string, sites?: string[]) => scriptedLaunch("sam-caregiver", "portal-app", { patient, sites });
  await fresh();
  const samOwn = (await sam("sam-example")).access_token;
  await record("sam: own records", samOwn, SAM);
  await record("sam: own token, riley's records", samOwn, RILEY);
  await record("sam: own token, josh's records", samOwn, ALL);
  const samRiley = (await sam("riley-example")).access_token;
  await record("sam: riley's records, as guardian", samRiley, RILEY);
  await record("sam: riley's token, josh's records", samRiley, ALL);
  await record("sam: riley's token, own records", samRiley, SAM);
  await record("sam: riley's records, app given one site", (await sam("riley-example", ["Northside Pathology"])).access_token, RILEY);
  out["sam: josh's records with no delegation"] = await sam("josh-example");
  await fresh();
  stack.store.putShare({ from: "user:sam-caregiver", with: "user:alex-neighbor", patient: "patient:sam-example", sites: ["Lakeside Imaging"], label: "neighbor" });
  await record("alex: part of sam's own records, shared by sam", (await scriptedLaunch("alex-neighbor", "portal-app", { patient: "sam-example" })).access_token, SAM);
  out["alex: riley's records, not shared"] = await scriptedLaunch("alex-neighbor", "portal-app", { patient: "riley-example" });
  await fresh();
  service("hand", "hand-referral-service", JOSH, { modalities: ["CR"] });
  await record("backend: a rule for josh, asking for riley", await backendToken("hand-referral-service"), RILEY);
  await fresh();
  return out;
}
