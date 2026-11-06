// Imaging Server: ImagingStudy search, policy, signed contexts, and the AuthZEN decision API.
// All policy lives here. The proxy never sees it.
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { ath, publicJwk, signJws, verifyJws } from "./jws";
import { now } from "./clock";
import { check, traced } from "./trace";
import type { Policy, PolicyStore, Rule } from "./policy-store";
import type { CatalogPosition, CatalogSearch, CatalogStore, CatalogStudy, StudyHierarchy } from "./archive/types";
import { ACCESSION_SYSTEM, DICOM_UID_SYSTEM } from "./catalog";

export type { AppGrant, Delegation, Policy, Rule } from "./policy-store";

const DEFAULT_COUNT = 20, MAX_COUNT = 100;
/** Raw hierarchy per page, by the sizes the catalog stores. A page always has at least one study. */
const PAGE_BYTES = 5 * 1024 * 1024;
const CANDIDATE_BATCH = 200;
const ACSN = { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v2-0203", code: "ACSN" }] };
const b64 = (v: Buffer | string) => Buffer.from(v).toString("base64url");

export function hasImagingScope(scope: string, level: "patient" | "system"): boolean {
  return scope.split(" ").some(s => s === `${level}/ImagingStudy.rs` || s === `${level}/ImagingStudy.read` || s === `${level}/*.rs` || s === `${level}/*.read`);
}

/**
 * The Imaging Server reads the catalog and has no way to read an archive object. `cursorKey` signs
 * paging cursors: several processes behind one address have to share it. Without one, a key is made
 * here, and a restart turns cursors already issued into 400s, which a client handles by searching again.
 */
export function createImagingServer(opts: { base: string; clinicalFhirBase: string; proxyBase: () => string; introspect: (token: string) => Promise<any>; serviceSecret: string; catalog: () => CatalogStore; keyStore: PolicyStore; store: () => PolicyStore; cursorKey?: Uint8Array; pageBytes?: number }) {
  let key = opts.keyStore.currentSigningKey();
  // The proxy shares this map, so a rotation reaches it at once.
  const keys = new Map([[key.kid, key.publicKey]]);
  let outage = false;
  const decisions: any[] = [];
  const cursorKey = opts.cursorKey ?? randomBytes(32);
  const pageBytes = opts.pageBytes ?? PAGE_BYTES;

  type PolicyRows = Pick<Policy, "rules" | "delegations" | "appGrants">;
  type Evaluation = { release: "none" | "study" | { series: string[] }; rule?: Rule; why: string; chain?: string[] };
  /** One search evaluates every candidate against the same policy, read once. */
  const policyRows = (): PolicyRows => { const s = opts.store(); return { rules: s.rules(), delegations: s.delegations(), appGrants: s.appGrants() }; };

  const matchRule = (t: any, patient: string, policy: PolicyRows): Rule | undefined =>
    policy.rules.find(r =>
      (r.when.client === undefined || r.when.client === t.client_id) &&
      (r.when.user === undefined || r.when.user === t.sub) &&
      (r.when.patient === undefined || r.when.patient === patient));

  /** The single policy decision used by both search and retrieval. It works on catalog rows. */
  function evaluate(t: any, study: CatalogStudy, policy: PolicyRows = policyRows()): Evaluation {
    const r = evaluateRule(t, study, policy);
    check("policy", `policy evaluation: ${study.id}`, r.release !== "none", { client: t.client_id, user: t.sub, patient_context: t.patient, study: study.id, site: study.site, chain: r.chain?.join(" → "), rule: r.rule?.id ?? "(none)", release: typeof r.release === "object" ? `${r.release.series.length} series` : r.release, why: r.why });
    return r;
  }
  /** Patient to related person to app. Each link can only narrow what the one before it allows. */
  function accessChain(t: any, patient: string, site: string, policy: PolicyRows): { ok: boolean; why?: string; chain: string[] } {
    const chain: string[] = [];
    if (t.fhirUser === `Patient/${patient}`) chain.push(`${t.sub} is the patient`);
    else {
      const d = policy.delegations.find(x => x.delegate === t.sub && x.patient === patient);
      if (!d) return { ok: false, why: `${t.sub} has no delegation from the patient`, chain };
      chain.push(`${d.grantedBy} delegated to ${t.sub} (${d.relationship}): ${d.sites.join(", ")}`);
      if (!d.sites.includes(site)) return { ok: false, why: `the delegation to ${t.sub} doesn't include ${site}`, chain };
    }
    const g = policy.appGrants.find(x => x.client === t.client_id && x.user === t.sub && x.patient === patient);
    if (!g) return { ok: false, why: `${t.sub} hasn't authorized ${t.client_id}`, chain };
    chain.push(`${t.sub} authorized ${t.client_id}: ${g.sites?.join(", ") ?? "everything they can see"}`);
    if (g.sites && !g.sites.includes(site)) return { ok: false, why: `${t.sub}'s authorization of ${t.client_id} doesn't include ${site}`, chain };
    return { ok: true, chain };
  }

  /** What one signed-in user can see and has shared, for the Authorization Server's pages. */
  function accessFor(user: string, fhirUser: string) {
    const records: { patient: string; via: "self" | "delegation"; relationship?: string; sites: string[] }[] = [];
    const self = fhirUser.match(/^Patient\/(.+)$/)?.[1];
    if (self) records.push({ patient: self, via: "self", sites: opts.catalog().sitesFor(self) });
    const { delegations, appGrants } = opts.store().getPolicy();
    for (const d of delegations) if (d.delegate === user) records.push({ patient: d.patient, via: "delegation", relationship: d.relationship, sites: d.sites });
    return { records, delegations: delegations.filter(d => d.grantedBy === user), apps: appGrants.filter(g => g.user === user) };
  }

  function evaluateRule(t: any, study: CatalogStudy, policy: PolicyRows): Evaluation {
    if (t.patient && t.patient === study.patient) {
      // A study with no site is outside every list of sites.
      const a = accessChain(t, t.patient, study.site ?? "", policy);
      if (!a.ok) return { release: "none", why: a.why!, chain: a.chain };
      return { ...evaluateAfterChain(t, study, policy), chain: a.chain };
    }
    return evaluateAfterChain(t, study, policy);
  }
  function evaluateAfterChain(t: any, study: CatalogStudy, policy: PolicyRows): Evaluation {
    const patient = study.patient;
    const level: "patient" | "system" = t.patient ? "patient" : "system";
    if (level === "patient" && t.patient !== patient) return { release: "none", why: "token's patient context is a different patient" };
    const rule = matchRule(t, patient, policy);
    if (!rule) {
      return level === "patient" ? { release: "study", why: "patient context matches, and no restricting policy applies" } : { release: "none", why: "no pre-authorized access for this client" };
    }
    if (rule.withdrawn) return { release: "none", rule, why: `rule ${rule.id}: access withdrawn` };
    const a = rule.allow;
    const siteOk = !a.sites || a.sites.includes(study.site ?? "");
    const studyOk = !a.studies || a.studies.includes(study.id);
    const modOk = !a.modalities || study.series.some(s => a.modalities!.includes(s.modality));
    const dateOk = !a.since || (study.date ?? "") >= a.since.replaceAll("-", "");
    if (!(a.all || a.sites || a.studies || a.modalities || a.since) || !siteOk || !studyOk || !modOk || !dateOk) return { release: "none", rule, why: `rule ${rule.id}: study is outside what it allows` };
    if (rule.withholdSeries?.length) {
      const series = study.series.map(s => s.uid).filter(u => !rule.withholdSeries!.includes(u));
      if (!series.length) return { release: "none", rule, why: `rule ${rule.id}: every series is withheld` };
      if (series.length < study.series.length) return { release: { series }, rule, why: `rule ${rule.id}: ${study.series.length - series.length} series withheld` };
    }
    return { release: "study", rule, why: `rule ${rule.id} allows this study` };
  }

  function contextFor(accessToken: string, t: any, study: CatalogStudy, ev: Evaluation): string {
    const policy = opts.store().getSettings();
    const claims: any = { v: 1, iss: "imaging-server", study: study.uid, ver: study.version, ath: ath(accessToken), exp: Math.min(now() + policy.contextLifetimeSeconds, t.exp) };
    if (ev.rule?.contextForm === "restricted") claims.restricted = true;
    else if (typeof ev.release === "object") {
      if (ev.release.series.length > policy.maxSeriesInContext) claims.restricted = true;
      else claims.series = ev.release.series;
    }
    check("imaging-fhir", `sign study context: ${study.id}`, true, { kid: key.kid, form: claims.restricted ? "restricted" : claims.series ? "series list" : "whole study", exp: claims.exp, token_hash: claims.ath.slice(0, 10) });
    return signJws(key, claims);
  }

  /** A study with nothing to retrieve, such as a `registered` one, has no endpoint and no series list. */
  function imagingStudy(study: CatalogStudy, hierarchy: StudyHierarchy | undefined, ev: Evaluation, endpointRef: string | undefined) {
    const date = study.date;
    const started = date ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` : undefined;
    const accession = study.accession ? { type: ACSN, system: ACCESSION_SYSTEM, value: study.accession } : undefined;
    const common = {
      resourceType: "ImagingStudy", id: study.id, meta: { lastUpdated: study.lastUpdated },
      identifier: [{ system: DICOM_UID_SYSTEM, value: `urn:oid:${study.uid}` }, ...(accession ? [accession] : [])],
      status: study.status,
      subject: { reference: `${opts.clinicalFhirBase}/Patient/${study.patient}` },
      ...(accession ? { basedOn: [{ type: "ServiceRequest", identifier: accession }] } : {}),
      ...(started ? { started } : {}),
    };
    if (!endpointRef) return { ...common, description: study.description };
    const released = typeof ev.release === "object" ? new Set(ev.release.series) : undefined;
    const series = (hierarchy?.series ?? []).filter(s => !released || released.has(s.uid));
    return {
      ...common,
      modality: [...new Set(series.map(s => s.modality))].map(code => ({ system: "http://dicom.nema.org/resources/ontology/DCM", code })),
      description: study.description,
      numberOfSeries: series.length,
      numberOfInstances: series.reduce((n, s) => n + s.instances.length, 0),
      endpoint: [{ reference: endpointRef }],
      series: series.map(s => ({
        uid: s.uid, number: s.number, modality: { system: "http://dicom.nema.org/resources/ontology/DCM", code: s.modality }, description: s.description, numberOfInstances: s.instances.length,
        instance: s.instances.map(i => ({ uid: i.uid, number: i.number, sopClass: { system: "urn:ietf:rfc:3986", code: `urn:oid:${i.sopClass}` } })),
      })),
    };
  }

  /** `system|value` or `value`. */
  const parseToken = (param: string | null) => {
    if (!param) return undefined;
    const [system, value] = param.includes("|") ? param.split("|") : [undefined, param];
    return { ...(system === undefined ? {} : { system }), value: value! };
  };
  function searchFilters(url: URL, patient: string): CatalogSearch {
    const lastUpdated = url.searchParams.get("_lastUpdated");
    const identifier = parseToken(url.searchParams.get("identifier")), basedOn = parseToken(url.searchParams.get("based-on:identifier"));
    return { patient, ...(identifier ? { identifier } : {}), ...(basedOn ? { basedOn } : {}), ...(lastUpdated?.startsWith("gt") ? { lastUpdatedAfter: lastUpdated.slice(2) } : {}) };
  }

  // A cursor is a position and a hash of the query's filters, signed so a client can't aim it
  // anywhere. It grants nothing: authentication, scope and policy all run again on every page.
  const filterHash = (q: CatalogSearch) => createHash("sha256").update(JSON.stringify([q.patient, q.identifier?.system ?? null, q.identifier?.value ?? null, q.basedOn?.system ?? null, q.basedOn?.value ?? null, q.lastUpdatedAfter ?? null])).digest("base64url");
  const cursorMac = (payload: string) => createHmac("sha256", cursorKey).update(payload).digest();
  const signCursor = (position: CatalogPosition, q: CatalogSearch) => {
    const payload = b64(JSON.stringify({ d: position.date, p: position.pk, f: filterHash(q) }));
    return `${payload}.${b64(cursorMac(payload))}`;
  };
  function readCursor(cursor: string, q: CatalogSearch): { position: CatalogPosition } | { error: string } {
    const [payload, mac] = cursor.split(".");
    const given = Buffer.from(mac ?? "", "base64url"), expected = cursorMac(payload ?? "");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { error: "the _cursor parameter isn't one this server issued" };
    const c = JSON.parse(Buffer.from(payload!, "base64url").toString());
    if (c.f !== filterHash(q)) return { error: "the _cursor parameter belongs to a search with different filters" };
    return { position: { date: c.d, pk: c.p } };
  }
  const positionOf = (s: CatalogStudy): CatalogPosition => ({ date: s.date ?? "", pk: s.pk });
  const isAfter = (s: CatalogStudy, p: CatalogPosition) => { const d = s.date ?? ""; return d < p.date || (d === p.date && s.pk < p.pk); };

  /** A patient's matching studies in cursor order, in batches, without hierarchies. */
  function* candidates(catalog: CatalogStore, q: CatalogSearch) {
    for (let after: CatalogPosition | undefined; ;) {
      const rows = catalog.candidates(q, after, CANDIDATE_BATCH);
      yield* rows;
      if (rows.length < CANDIDATE_BATCH) return;
      after = positionOf(rows[rows.length - 1]!);
    }
  }

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
    const policy = policyRows();
    if (level === "system" && !matchRule(t, patient, policy)) return Response.json(outcome("forbidden", "this patient is outside the client's authorized access"), { status: 403 });

    const countParam = url.searchParams.get("_count");
    if (countParam !== null && !/^\d+$/.test(countParam)) return Response.json(outcome("invalid", "_count must be a whole number"), { status: 400 });
    const count = countParam === null ? DEFAULT_COUNT : Math.min(Number(countParam), MAX_COUNT);
    const filters = searchFilters(url, patient);
    const cursorParam = url.searchParams.get("_cursor");
    let after: CatalogPosition | undefined;
    if (cursorParam !== null) {
      let read: ReturnType<typeof readCursor>;
      try { read = readCursor(cursorParam, filters); } catch { read = { error: "the _cursor parameter isn't one this server issued" }; }
      if (!check("imaging-fhir", "paging cursor is valid", "position" in read, { why: "error" in read ? read.error : undefined })) return Response.json(outcome("invalid", (read as { error: string }).error), { status: 400 });
      after = (read as { position: CatalogPosition }).position;
    }

    // The walk covers all of this patient's matching studies on every page, since `total` is what
    // this caller may see now. Its cost depends on one patient, and it reads no hierarchy.
    const catalog = opts.catalog();
    const page: { study: CatalogStudy; ev: Evaluation }[] = [];
    let total = 0, bytes = 0, more = false;
    for (const study of candidates(catalog, filters)) {
      const ev = evaluate(t, study, policy);
      if (ev.release === "none") continue;
      total++;
      if (after && !isAfter(study, after)) continue;
      if (more) continue;
      if (page.length >= count || (page.length > 0 && bytes + study.hierarchyBytes > pageBytes)) { more = true; continue; }
      page.push({ study, ev });
      bytes += study.hierarchyBytes;
    }

    const hasEndpoint = (s: CatalogStudy) => s.status === "available";
    const withEndpoint = page.filter(p => hasEndpoint(p.study));
    const hierarchies = withEndpoint.length ? catalog.hierarchies(withEndpoint.map(p => p.study.pk)) : new Map<number, StudyHierarchy>();
    // Signed here, inside this request's trace. Everything below this only serializes.
    const rows = page.map(({ study, ev }) => ({ study, ev, uuid: randomUUID(), address: hasEndpoint(study) ? `${opts.proxyBase()}/wado/${contextFor(bearer, t, study, ev)}` : undefined }));

    const link: { relation: string; url: string }[] = [{ relation: "self", url: `${opts.base}/ImagingStudy${url.search}` }];
    if (more && count > 0) {
      const next = new URLSearchParams(url.searchParams);
      if (countParam !== null) next.set("_count", String(count));
      next.set("_cursor", signCursor(positionOf(page[page.length - 1]!.study), filters));
      link.push({ relation: "next", url: `${opts.base}/ImagingStudy?${next}` });
    }

    // The Bundle is streamed a study at a time, and each hierarchy is released once it's written. A
    // page's parsed hierarchies are held at once, which the byte budget bounds, except that one
    // study larger than the budget is held whole, along with its one serialized entry.
    const self = (function* () {
      yield `${JSON.stringify({ resourceType: "Bundle", type: "searchset", total, link }).slice(0, -1)},"entry":[`;
      let first = true;
      for (const { study, ev, uuid, address } of rows) {
        const endpointRef = address ? `urn:uuid:${uuid}` : undefined;
        const resource = imagingStudy(study, hierarchies.get(study.pk), ev, endpointRef);
        hierarchies.delete(study.pk);
        yield `${first ? "" : ","}${JSON.stringify({ fullUrl: `${opts.base}/ImagingStudy/${study.id}`, resource, search: { mode: "match" } })}`;
        first = false;
        // Each Endpoint is written right after its study, so both are always on the same page.
        if (address) yield `,${JSON.stringify({
          fullUrl: endpointRef, search: { mode: "include" },
          resource: {
            resourceType: "Endpoint", id: uuid, status: "active", name: "WADO-RS",
            connectionType: { system: "http://terminology.hl7.org/CodeSystem/endpoint-connection-type", code: "dicom-wado-rs" },
            payloadType: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/endpoint-payload-type", code: "any" }] }],
            address,
          },
        })}`;
      }
      yield "]}";
    })();
    const encoder = new TextEncoder();
    return new Response(new ReadableStream({
      pull(c) {
        const n = self.next();
        if (n.done) c.close(); else c.enqueue(encoder.encode(n.value));
      },
    }), { headers: { "content-type": "application/fhir+json" } });
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
    const study = opts.catalog().studyByUid(body.resource?.id);
    if (!study || study.status !== "available") return respond(false, { denial: "not_released", max_age_seconds: 30 }, "no such study");
    const ev = evaluate(t, study);
    if (ev.release === "none") return respond(false, { denial: "not_released", max_age_seconds: 30 }, ev.why);
    return respond(true, { release: ev.release, version: study.version, max_age_seconds: Math.min(opts.store().getSettings().contextLifetimeSeconds, t.exp - now()) }, ev.why);
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
        if (p === "/internal/relationships") return Response.json(opts.store().delegations().map(d => ({ patient: d.patient, delegate: d.delegate, relationship: d.relationship })));
        if (p === "/internal/access") return Response.json(accessFor(url.searchParams.get("user") ?? "", url.searchParams.get("fhirUser") ?? ""));
        if (p === "/internal/delegations" && req.method === "POST") {
          const d: any = await req.json();
          if (!check("policy", "only the patient can delegate their records", d.fhirUser === `Patient/${d.patient}`, { user: d.grantedBy, patient: d.patient })) return new Response(null, { status: 403 });
          const known = new Set(opts.catalog().sitesFor(d.patient));
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
            // Everything the patient has is the same as no limit, which then covers later sites too.
            const all = opts.catalog().sitesFor(c.patient).length;
            sites = narrowed.length > 0 && narrowed.length === all ? undefined : narrowed;
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
      if (p === "/fhir/metadata") return Response.json({ resourceType: "CapabilityStatement", status: "active", kind: "instance", fhirVersion: "4.0.1", format: ["json"], instantiates: ["http://fhir.org/argonaut/smart-imaging/CapabilityStatement/smart-imaging-server"], rest: [{ mode: "server", resource: [{ type: "ImagingStudy", interaction: [{ code: "search-type" }], searchInclude: ["ImagingStudy:endpoint"], searchParam: [{ name: "patient", type: "reference" }, { name: "identifier", type: "token" }, { name: "based-on", type: "reference" }, { name: "_lastUpdated", type: "date", documentation: "The catalog's stored value for each study. The gt prefix is supported." }, { name: "_count", type: "number", documentation: `Studies per page: ${DEFAULT_COUNT} by default, and larger values than ${MAX_COUNT} are treated as ${MAX_COUNT}. A page can hold fewer, to stay within its size limit. 0 returns only the total.` }, { name: "_cursor", type: "string", documentation: "Opaque, and supplied by a Bundle's next link. Use it with the same filters. It grants nothing, and policy applies again on every page." }] }] }] });
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
