// Imaging Server: ImagingStudy search, policy, signed contexts, and the AuthZEN decision API.
// All policy lives here. The proxy never sees it.
import { randomUUID } from "node:crypto";
import { ath, publicJwk, signJws, verifyJws } from "./jws";
import { now } from "./clock";
import { check, traced } from "./trace";
import type { Policy, PolicyStore, Rule } from "./policy-store";

export type { AppGrant, Delegation, Policy, Rule } from "./policy-store";

export const SITES: Record<string, string> = {
  "mri-brain-2020": "Lakeside Imaging",
  "ct-abdomen-pelvis-2012": "Riverside Hospital",
  "xr-wrist-left-2012": "Riverside Hospital",
  "xr-hand-wrist-right-2012": "Riverside Hospital",
  "xr-hand-right-2012": "Riverside Hospital",
  "slide-lung-2023": "Northside Pathology",
};

const PATIENT_ID = "josh-example"; // Every study in the sample data belongs to this patient.
const ACCESSION_SYSTEM = "http://hospital.example.org/accession";

export function hasImagingScope(scope: string, level: "patient" | "system"): boolean {
  return scope.split(" ").some(s => s === `${level}/ImagingStudy.rs` || s === `${level}/ImagingStudy.read` || s === `${level}/*.rs` || s === `${level}/*.read`);
}

export function createImagingServer(opts: { base: string; clinicalFhirBase: string; proxyBase: () => string; introspect: (token: string) => Promise<any>; serviceSecret: string; manifest: any; keyStore: PolicyStore; store: () => PolicyStore }) {
  let key = opts.keyStore.currentSigningKey();
  // The proxy shares this map, so a rotation reaches it at once.
  const keys = new Map([[key.kid, key.publicKey]]);
  let outage = false;
  const decisions: any[] = [];
  const studies: any[] = opts.manifest.studies;
  const studyById = (uid: string) => studies.find(s => s.uid === uid);
  const patientOf = (_s: any) => PATIENT_ID;

  const matchRule = (t: any, patient: string): Rule | undefined =>
    opts.store().rules().find(r =>
      (r.when.client === undefined || r.when.client === t.client_id) &&
      (r.when.user === undefined || r.when.user === t.sub) &&
      (r.when.patient === undefined || r.when.patient === patient));

  /** The single policy decision used by both search and retrieval. */
  function evaluate(t: any, study: any) {
    const r = evaluateRule(t, study);
    check("policy", `policy evaluation: ${study.id}`, r.release !== "none", { client: t.client_id, user: t.sub, patient_context: t.patient, study: study.id, site: SITES[study.id], chain: r.chain?.join(" → "), rule: r.rule?.id ?? "(none)", release: typeof r.release === "object" ? `${r.release.series.length} series` : r.release, why: r.why });
    return r;
  }
  /** Patient to related person to app. Each link can only narrow what the one before it allows. */
  function accessChain(t: any, patient: string, site: string): { ok: boolean; why?: string; chain: string[] } {
    const chain: string[] = [];
    if (t.fhirUser === `Patient/${patient}`) chain.push(`${t.sub} is the patient`);
    else {
      const d = opts.store().delegations().find(x => x.delegate === t.sub && x.patient === patient);
      if (!d) return { ok: false, why: `${t.sub} has no delegation from the patient`, chain };
      chain.push(`${d.grantedBy} delegated to ${t.sub} (${d.relationship}): ${d.sites.join(", ")}`);
      if (!d.sites.includes(site)) return { ok: false, why: `the delegation to ${t.sub} doesn't include ${site}`, chain };
    }
    const g = opts.store().appGrants().find(x => x.client === t.client_id && x.user === t.sub && x.patient === patient);
    if (!g) return { ok: false, why: `${t.sub} hasn't authorized ${t.client_id}`, chain };
    chain.push(`${t.sub} authorized ${t.client_id}: ${g.sites?.join(", ") ?? "everything they can see"}`);
    if (g.sites && !g.sites.includes(site)) return { ok: false, why: `${t.sub}'s authorization of ${t.client_id} doesn't include ${site}`, chain };
    return { ok: true, chain };
  }

  /** What one signed-in user can see and has shared, for the Authorization Server's pages. */
  function accessFor(user: string, fhirUser: string) {
    const records: { patient: string; via: "self" | "delegation"; relationship?: string; sites: string[] }[] = [];
    const self = fhirUser.match(/^Patient\/(.+)$/)?.[1];
    if (self) records.push({ patient: self, via: "self", sites: [...new Set(studies.filter(s => patientOf(s) === self).map(s => SITES[s.id]!))] });
    const { delegations, appGrants } = opts.store().getPolicy();
    for (const d of delegations) if (d.delegate === user) records.push({ patient: d.patient, via: "delegation", relationship: d.relationship, sites: d.sites });
    return { records, delegations: delegations.filter(d => d.grantedBy === user), apps: appGrants.filter(g => g.user === user) };
  }

  function evaluateRule(t: any, study: any): { release: "none" | "study" | { series: string[] }; rule?: Rule; why: string; chain?: string[] } {
    if (t.patient && t.patient === patientOf(study)) {
      const a = accessChain(t, t.patient, SITES[study.id]!);
      if (!a.ok) return { release: "none", why: a.why!, chain: a.chain };
      return { ...evaluateAfterChain(t, study), chain: a.chain };
    }
    return evaluateAfterChain(t, study);
  }
  function evaluateAfterChain(t: any, study: any): { release: "none" | "study" | { series: string[] }; rule?: Rule; why: string } {
    const patient = patientOf(study);
    const level: "patient" | "system" = t.patient ? "patient" : "system";
    if (level === "patient" && t.patient !== patient) return { release: "none", why: "token's patient context is a different patient" };
    const rule = matchRule(t, patient);
    if (!rule) {
      return level === "patient" ? { release: "study", why: "patient context matches, and no restricting policy applies" } : { release: "none", why: "no pre-authorized access for this client" };
    }
    if (rule.withdrawn) return { release: "none", rule, why: `rule ${rule.id}: access withdrawn` };
    const a = rule.allow;
    const siteOk = !a.sites || a.sites.includes(SITES[study.id]!);
    const studyOk = !a.studies || a.studies.includes(study.id);
    const modOk = !a.modalities || study.series.some((s: any) => a.modalities!.includes(s.modality));
    const dateOk = !a.since || (study.date ?? "") >= a.since.replaceAll("-", "");
    if (!(a.all || a.sites || a.studies || a.modalities || a.since) || !siteOk || !studyOk || !modOk || !dateOk) return { release: "none", rule, why: `rule ${rule.id}: study is outside what it allows` };
    if (rule.withholdSeries?.length) {
      const series = study.series.map((s: any) => s.uid).filter((u: string) => !rule.withholdSeries!.includes(u));
      if (!series.length) return { release: "none", rule, why: `rule ${rule.id}: every series is withheld` };
      if (series.length < study.series.length) return { release: { series }, rule, why: `rule ${rule.id}: ${study.series.length - series.length} series withheld` };
    }
    return { release: "study", rule, why: `rule ${rule.id} allows this study` };
  }

  function contextFor(accessToken: string, t: any, study: any, ev: ReturnType<typeof evaluate>): string {
    const policy = opts.store().getSettings();
    const claims: any = { v: 1, iss: "imaging-server", study: study.uid, ath: ath(accessToken), exp: Math.min(now() + policy.contextLifetimeSeconds, t.exp) };
    if (ev.rule?.contextForm === "restricted") claims.restricted = true;
    else if (typeof ev.release === "object") {
      if (ev.release.series.length > policy.maxSeriesInContext) claims.restricted = true;
      else claims.series = ev.release.series;
    }
    check("imaging-fhir", `sign study context: ${study.id}`, true, { kid: key.kid, form: claims.restricted ? "restricted" : claims.series ? "series list" : "whole study", exp: claims.exp, token_hash: claims.ath.slice(0, 10) });
    return signJws(key, claims);
  }

  function imagingStudy(study: any, ev: ReturnType<typeof evaluate>, endpointRef: string) {
    const series = typeof ev.release === "object" ? study.series.filter((s: any) => (ev.release as any).series.includes(s.uid)) : study.series;
    const date = study.date as string | undefined;
    const started = date ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` : undefined;
    return {
      resourceType: "ImagingStudy", id: study.id, meta: { lastUpdated: `${started ?? "2020-01-01"}T00:00:00Z` },
      identifier: [
        { system: "urn:dicom:uid", value: `urn:oid:${study.uid}` },
        ...(study.accession ? [{ type: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v2-0203", code: "ACSN" }] }, system: ACCESSION_SYSTEM, value: study.accession }] : []),
      ],
      status: "available",
      subject: { reference: `${opts.clinicalFhirBase}/Patient/${patientOf(study)}` },
      ...(study.accession ? { basedOn: [{ type: "ServiceRequest", identifier: { type: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v2-0203", code: "ACSN" }] }, system: ACCESSION_SYSTEM, value: study.accession } }] } : {}),
      ...(started ? { started } : {}),
      modality: [...new Set(series.map((s: any) => s.modality))].map(code => ({ system: "http://dicom.nema.org/resources/ontology/DCM", code })),
      description: study.description,
      numberOfSeries: series.length,
      numberOfInstances: series.reduce((n: number, s: any) => n + s.instances.length, 0),
      endpoint: [{ reference: endpointRef }],
      series: series.map((s: any) => ({
        uid: s.uid, number: s.number, modality: { system: "http://dicom.nema.org/resources/ontology/DCM", code: s.modality }, description: s.description, numberOfInstances: s.instances.length,
        instance: s.instances.map((i: any) => ({ uid: i.uid, number: i.number, sopClass: { system: "urn:ietf:rfc:3986", code: `urn:oid:${i.sopClass}` } })),
      })),
    };
  }

  const tokenMatches = (param: string, st: any, f: (st: any) => { system?: string; value: string }[]) => {
    const [sys, val] = param.includes("|") ? param.split("|") : [undefined, param];
    return f(st).some(i => i.value === val && (sys === undefined || i.system === sys));
  };

  async function search(req: Request, url: URL): Promise<Response> {
    const bearer = req.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
    if (!bearer) return new Response(null, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
    const t = await opts.introspect(bearer);
    if (!check("imaging-fhir", "token is active", t.active, { client: t.client_id, scope: t.scope, patient_context: t.patient, user: t.sub })) return new Response(null, { status: 401, headers: { "WWW-Authenticate": 'Bearer error="invalid_token"' } });
    const level = t.patient ? "patient" : "system";
    if (!hasImagingScope(t.scope, level)) return Response.json(outcome("forbidden", "scope does not cover ImagingStudy"), { status: 403 });
    const patient = url.searchParams.get("patient")?.replace(/^.*Patient\//, "");
    if (!patient) return Response.json(outcome("required", "the patient parameter is required"), { status: 400 });
    if (level === "patient" && patient !== t.patient) return Response.json(outcome("forbidden", "patient does not match the token's patient context"), { status: 403 });
    if (level === "system" && !matchRule(t, patient)) return Response.json(outcome("forbidden", "this patient is outside the client's authorized access"), { status: 403 });
    const entries: any[] = [];
    const identifier = url.searchParams.get("identifier");
    const basedOn = url.searchParams.get("based-on:identifier");
    const lastUpdated = url.searchParams.get("_lastUpdated");
    let total = 0;
    for (const study of studies) {
      if (patientOf(study) !== patient) continue;
      const ev = evaluate(t, study);
      if (ev.release === "none") continue;
      const uuid = randomUUID();
      const res: any = imagingStudy(study, ev, `urn:uuid:${uuid}`);
      if (identifier && !tokenMatches(identifier, res, s => s.identifier)) continue;
      if (basedOn && !tokenMatches(basedOn, res, s => (s.basedOn ?? []).map((b: any) => b.identifier))) continue;
      if (lastUpdated?.startsWith("gt") && res.meta.lastUpdated <= lastUpdated.slice(2)) continue;
      total++;
      entries.push({ fullUrl: `${opts.base}/ImagingStudy/${study.id}`, resource: res, search: { mode: "match" } });
      entries.push({
        fullUrl: `urn:uuid:${uuid}`, search: { mode: "include" },
        resource: {
          resourceType: "Endpoint", id: uuid, status: "active", name: "WADO-RS",
          connectionType: { system: "http://terminology.hl7.org/CodeSystem/endpoint-connection-type", code: "dicom-wado-rs" },
          payloadType: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/endpoint-payload-type", code: "any" }] }],
          address: `${opts.proxyBase()}/wado/${contextFor(bearer, t, study, ev)}`,
        },
      });
    }
    return Response.json({ resourceType: "Bundle", type: "searchset", total, link: [{ relation: "self", url: `${opts.base}/ImagingStudy${url.search}` }], entry: entries }, { headers: { "content-type": "application/fhir+json" } });
  }

  const outcome = (code: string, text: string) => ({ resourceType: "OperationOutcome", issue: [{ severity: "error", code, diagnostics: text }] });

  async function evaluation(req: Request): Promise<Response> {
    const requestId = req.headers.get("x-request-id");
    const echo: Record<string, string> = requestId ? { "X-Request-ID": requestId } : {};
    if (!check("policy", "caller is the authenticated proxy", req.headers.get("authorization") === `Bearer ${opts.serviceSecret}`)) return Response.json({ error: "authentication required" }, { status: 401, headers: { "WWW-Authenticate": "Bearer", ...echo } });
    if (outage) check("policy", "decision service is available", false, { injected: "outage" });
    if (outage) return Response.json({ error: "decision service unavailable" }, { status: 500, headers: echo });
    const body: any = await req.json().catch(() => undefined);
    const str = (v: unknown) => typeof v === "string" && v.length > 0;
    const wellFormed = !!body && typeof body === "object" && !Array.isArray(body) && str(body.subject?.type) && str(body.subject?.id) && str(body.resource?.type) && str(body.resource?.id) && str(body.action?.name);
    if (!check("policy", "request has the required AuthZEN attributes", wellFormed)) return Response.json({ error: "subject, resource and action are required" }, { status: 400, headers: echo });
    const respond = (decision: boolean, context: any, why: string) => {
      const res = { decision, context: { decision_id: `d-${randomUUID().slice(0, 8)}`, ...context } };
      check("policy", `decision: ${decision ? "allow" : "deny"}`, decision, { decision_id: res.context.decision_id, why, release: typeof context.release === "object" ? `${context.release.series.length} series` : context.release, denial: context.denial, max_age_seconds: context.max_age_seconds });
      decisions.push({ at: Date.now(), why, request: { ...body, subject: { ...body.subject, properties: { access_token: "(redacted in this log)" } } }, response: res });
      if (decisions.length > 200) decisions.shift();
      return Response.json(res, { headers: echo });
    };
    const token = body.subject?.properties?.access_token;
    const t = token ? await opts.introspect(token) : { active: false };
    if (!t.active) return respond(false, { denial: "invalid_token", max_age_seconds: 0 }, "token is not active");
    const level = t.patient ? "patient" : "system";
    if (!hasImagingScope(t.scope, level)) return respond(false, { denial: "insufficient_scope", max_age_seconds: 30 }, "scope does not cover imaging");
    const signed = body.context?.signed_context;
    if (signed) {
      // A retired key ends the instant path, not access: this answer comes from current policy.
      const claims = verifyJws(signed, keys) ?? verifyJws(signed, opts.keyStore.retiredPublicKeys());
      if (!claims) return respond(false, { denial: "not_released", max_age_seconds: 0 }, "signed context failed verification");
      if (claims.study !== body.resource?.id) return respond(false, { denial: "not_released", max_age_seconds: 0 }, "request is outside the study this URL was issued for");
    }
    const study = studyById(body.resource?.id);
    if (!study) return respond(false, { denial: "not_released", max_age_seconds: 30 }, "no such study");
    const ev = evaluate(t, study);
    if (ev.release === "none") return respond(false, { denial: "not_released", max_age_seconds: 30 }, ev.why);
    return respond(true, { release: ev.release, max_age_seconds: Math.min(opts.store().getSettings().contextLifetimeSeconds, t.exp - now()) }, ev.why);
  }

  return {
    publicKeys: keys,
    jwks: () => ({ keys: [publicJwk(key)] }),
    fetch: traced("imaging-fhir", async (req: Request, server): Promise<Response> => {
      const url = new URL(req.url);
      const p = url.pathname;
      if (p === "/access/v1/evaluation" || p.startsWith("/internal/")) server.record.service = "policy";
      if (p.startsWith("/internal/")) {
        if (req.headers.get("authorization") !== `Bearer ${opts.serviceSecret}`) return new Response(null, { status: 401 });
        const known = new Set(Object.values(SITES));
        if (p === "/internal/relationships") return Response.json(opts.store().delegations().map(d => ({ patient: d.patient, delegate: d.delegate, relationship: d.relationship })));
        if (p === "/internal/access") return Response.json(accessFor(url.searchParams.get("user") ?? "", url.searchParams.get("fhirUser") ?? ""));
        if (p === "/internal/delegations" && req.method === "POST") {
          const d: any = await req.json();
          if (!check("policy", "only the patient can delegate their records", d.fhirUser === `Patient/${d.patient}`, { user: d.grantedBy, patient: d.patient })) return new Response(null, { status: 403 });
          const sites = d.sites.filter((s: string) => known.has(s));
          opts.store().putDelegation({ patient: d.patient, grantedBy: d.grantedBy, delegate: d.delegate, relationship: d.relationship, sites });
          check("policy", "record delegation to a related person", true, { from: d.grantedBy, to: d.delegate, relationship: d.relationship, sites: sites.join(", ") });
          return new Response(null, { status: 204 });
        }
        if (p === "/internal/delegations" && req.method === "DELETE") {
          const by = url.searchParams.get("grantedBy"), to = url.searchParams.get("delegate");
          opts.store().removeDelegations({ grantedBy: by ?? "", delegate: to ?? "" });
          check("policy", "revoke delegation", true, { from: by, to });
          return new Response(null, { status: 204 });
        }
        if (p === "/internal/consents" && req.method === "POST") {
          const c: any = await req.json();
          const held = accessFor(c.user, c.fhirUser).records.find(r => r.patient === c.patient);
          if (!check("policy", "user has access to this patient", !!held, { user: c.user, patient: c.patient })) return new Response(null, { status: 403 });
          const existing = opts.store().appGrants().find(x => x.client === c.client && x.user === c.user && x.patient === c.patient);
          let sites: string[] | undefined = existing?.sites;
          if (c.sites) {
            // A choice can only narrow what the user holds, whatever the form submitted.
            const narrowed = c.sites.filter((s: string) => held!.sites.includes(s));
            sites = narrowed.length === new Set(Object.values(SITES)).size ? undefined : narrowed;
            check("policy", "app's sites stay within what the user holds", narrowed.length === c.sites.length, { requested: c.sites.join(", "), held: held!.sites.join(", "), granted: narrowed.join(", ") });
          }
          opts.store().putAppGrant({ client: c.client, user: c.user, patient: c.patient, ...(sites ? { sites } : {}) });
          return new Response(null, { status: 204 });
        }
        if (p === "/internal/consents" && req.method === "DELETE") {
          const client = url.searchParams.get("client"), user = url.searchParams.get("user");
          opts.store().removeAppGrants({ client: client ?? "", user: user ?? "" });
          check("policy", "revoke app authorization", true, { client, user });
          return new Response(null, { status: 204 });
        }
        return new Response("not found", { status: 404 });
      }
      if (p === "/fhir/ImagingStudy" && req.method === "GET") return search(req, url);
      if (p === "/fhir/metadata") return Response.json({ resourceType: "CapabilityStatement", status: "active", kind: "instance", fhirVersion: "4.0.1", format: ["json"], instantiates: ["http://fhir.org/argonaut/smart-imaging/CapabilityStatement/smart-imaging-server"], rest: [{ mode: "server", resource: [{ type: "ImagingStudy", interaction: [{ code: "search-type" }], searchInclude: ["ImagingStudy:endpoint"], searchParam: [{ name: "patient", type: "reference" }, { name: "identifier", type: "token" }, { name: "based-on", type: "reference" }, { name: "_lastUpdated", type: "date", documentation: "Updated only when this demo's dataset is rebuilt." }] }] }] });
      if (p === "/access/v1/evaluation" && req.method === "POST") return evaluation(req);
      if (p === "/.well-known/authzen-configuration") return Response.json({ policy_decision_point: url.origin, access_evaluation_endpoint: `${url.origin}/access/v1/evaluation` });
      if (p === "/.well-known/jwks.json") return Response.json({ keys: [publicJwk(key)] });
      return new Response("not found", { status: 404 });
    }),
    /** These act on whichever store is active: saved, or a flow's scratch store. */
    setPolicy(pol: Partial<Policy>) { opts.store().setPolicy(pol); },
    getPolicy: () => opts.store().getPolicy(),
    updateRule(id: string, patch: Partial<Rule>) { opts.store().updateRule(id, patch); },
    setOutage(on: boolean) { outage = on; },
    get outage() { return outage; },
    get signingKid() { return key.kid; },
    /** URLs signed with the old key stop verifying here and at the proxy, right away. */
    rotateSigningKey() {
      key = opts.keyStore.rotateSigningKey();
      keys.clear();
      keys.set(key.kid, key.publicKey);
      return key.kid;
    },
    decisions,
    /** Clears the outage switch and the decision log. Policy belongs to the stores. */
    reset() { outage = false; decisions.length = 0; },
  };
}
