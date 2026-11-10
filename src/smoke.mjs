// smoke.mjs: what an app does, end to end. SANDBOX=https://…/s/{id} node smoke.mjs
import { createHash, createPrivateKey, randomBytes, randomUUID, sign } from "node:crypto";
const SANDBOX = process.env.SANDBOX, b64 = b => Buffer.from(b).toString("base64url");
const must = async (r, what) => { if (!r.ok && r.status !== 302 && r.status !== 303) throw new Error(`${what}: HTTP ${r.status} ${await r.text()}`); return r; };
// 1. The admin token, from the keys this sandbox shares on purpose.
const k = await (await must(await fetch(`${SANDBOX}/api/sandbox/keys-shared-on-purpose`), "keys")).json();
const head = `${b64(JSON.stringify({ alg: "ES256", kid: k.admin.jwk.kid }))}.${b64(JSON.stringify({ iss: k.admin.client_id, sub: k.admin.client_id, aud: k.tokenEndpoint, jti: randomUUID(), exp: Math.floor(Date.now() / 1000) + 240 }))}`;
const assertion = `${head}.${b64(sign("sha256", Buffer.from(head), { key: createPrivateKey({ key: k.admin.jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" }))}`;
const admin = (await (await must(await fetch(k.tokenEndpoint, { method: "POST", body: new URLSearchParams({ grant_type: "client_credentials", scope: "sandbox/admin", client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: assertion }) }), "admin token")).json()).access_token;
// 2. A public app, with a redirect URI nothing needs to serve: the code is read from the redirect itself.
const redirect = "http://localhost:8123/callback";
const app = await (await must(await fetch(`${SANDBOX}/api/sandbox/clients`, { method: "POST", headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" }, body: JSON.stringify({ name: "Smoke test", redirectUris: [redirect] }) }), "register")).json();
// 3. Sign in as josh, through the forms, with PKCE.
const conf = await (await must(await fetch(`${SANDBOX}/fhir/.well-known/smart-configuration`), "discovery")).json();
const verifier = b64(randomBytes(32)), challenge = b64(createHash("sha256").update(verifier).digest());
const auth = new URL(conf.authorization_endpoint);
for (const [n, v] of Object.entries({ response_type: "code", client_id: app.id, redirect_uri: redirect, scope: "launch/patient patient/*.rs", aud: `${SANDBOX}/fhir`, state: "smoke", code_challenge: challenge, code_challenge_method: "S256" })) auth.searchParams.set(n, v);
const action = async (r, what) => new URL((await (await must(r, what)).text()).match(/<form[^>]*action="([^"]+)"/)[1].replaceAll("&amp;", "&"), r.url);
const signIn = await action(await fetch(auth), "authorize");
const consent = new URL((await must(await fetch(signIn, { method: "POST", body: new URLSearchParams({ username: "josh" }), redirect: "manual" }), "sign in")).headers.get("location"), signIn);
const decide = await action(await fetch(consent), "consent page");
const back = new URL((await must(await fetch(decide, { method: "POST", body: new URLSearchParams({ decision: "approve", patient: "josh-example" }), redirect: "manual" }), "approve")).headers.get("location"));
const token = await (await must(await fetch(conf.token_endpoint, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code: back.searchParams.get("code"), redirect_uri: redirect, client_id: app.id, code_verifier: verifier }) }), "token")).json();
const bearer = { authorization: `Bearer ${token.access_token}` };
// Every GET waits out a 503 with Retry-After, as the guide asks of an app, for searches and retrievals alike.
const get = async (url, headers) => {
  for (let tries = 0; ; tries++) {
    const r = await fetch(url, { headers });
    if (r.status !== 503 || tries === 10) return must(r, `GET ${url}`);
    await new Promise(done => setTimeout(done, 1000 * Number(r.headers.get("retry-after") ?? 1)));
  }
};
// 4. Every page of the search, with each study's Endpoint.
// The FHIR server itself, if it advertises imaging at the top level (a unified sandbox), or else the associated
// endpoint that does. Never a hardcoded address: a sandbox can be switched between the two.
const offers = caps => caps?.includes("smart-imaging-access") && caps.includes("http://fhir.org/argonaut/smart-imaging/capabilities/app-launch");
const imaging = offers(conf.capabilities) ? `${SANDBOX}/fhir` : conf.associated_endpoints?.find(e => offers(e.capabilities))?.url;
if (!imaging) throw new Error("discovery advertises no SMART Imaging server for app launch");
const entries = [];
for (let next = `${imaging}/ImagingStudy?patient=Patient/${token.patient}&_include=ImagingStudy:endpoint`; next;) {
  const page = await (await get(next, bearer)).json();
  entries.push(...(page.entry ?? []));   // a search with no results has no entry at all
  next = page.link?.find(l => l.relation === "next")?.url;
}
const studies = entries.filter(e => e.resource.resourceType === "ImagingStudy").map(e => e.resource);
if (studies.length !== 6) throw new Error(`expected josh's 6 studies, got ${studies.length}`);
// 5. Each study's Endpoint, in any of the three forms the guide allows, resolved by FHIR's Bundle rules: a
// "#id" in the study's contained resources, an absolute or urn: reference by fullUrl, and a relative one
// ("Endpoint/{id}") against the base of the study's own fullUrl.
const studyEntry = study => entries.find(e => e.resource === study);
function endpointOf(study) {
  for (const { reference: ref = "" } of study.endpoint ?? []) {
    const target = ref.startsWith("#") ? study.contained?.find(c => c.id === ref.slice(1))
      : entries.find(e => e.fullUrl === ref || e.fullUrl === new URL(ref, studyEntry(study).fullUrl.replace(/ImagingStudy\/[^/]+$/, "")).href)?.resource;
    if (target?.resourceType === "Endpoint" && target.connectionType?.code === "dicom-wado-rs") return target;
  }
  throw new Error(`no WADO-RS Endpoint for ${study.id}`);
}
// 6. One image from each study, from its own Endpoint.address, waiting out a 503 with Retry-After.
let bytes = 0;
for (const study of studies) {
  const uid = study.identifier.find(i => i.system === "urn:dicom:uid").value.replace(/^urn:oid:/, "");
  const series = study.series[0], url = `${endpointOf(study).address}/studies/${uid}/series/${series.uid}/instances/${series.instance[0].uid}`;
  const image = Buffer.from(await (await get(url, { ...bearer, accept: 'multipart/related; type="application/dicom"; transfer-syntax=*' })).arrayBuffer());
  const part = image.subarray(image.indexOf("\r\n\r\n") + 4);
  if (part.subarray(128, 132).toString() !== "DICM") throw new Error(`${study.id}'s image isn't DICOM`);
  bytes += image.length;
}
// 7. A report, as text.
const reports = await (await must(await fetch(`${SANDBOX}/fhir/DiagnosticReport?patient=Patient/${token.patient}`, { headers: bearer }), "reports")).json();
const text = reports.entry[0].resource.presentedForm.find(f => f.contentType.startsWith("text/plain"));
await must(await fetch(text.url, { headers: bearer }), "report text");
await fetch(`${SANDBOX}/api/sandbox/clients/${app.id}`, { method: "DELETE", headers: { authorization: `Bearer ${admin}` } });
console.log(`OK: ${studies.length} studies, an image from each (${bytes} bytes), ${reports.entry.length} reports`);
