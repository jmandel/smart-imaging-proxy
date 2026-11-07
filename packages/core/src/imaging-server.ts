// Imaging Server: ImagingStudy search, policy, signed contexts, the AuthZEN decision API, and the
// policy API. All policy lives here. The proxy never sees it.
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { ath, publicJwk, signJws, verifyJws } from "./jws";
import { systemClock, type Clock } from "./clock";
import { noopObserver, type Observer } from "./observer";
import { createPolicyApi, POLICY_API_PATH, type Access, type ExplainQuery } from "./policy-api";
import type { Guardian, Policy, PolicyStore, Rule } from "./policy-store";
import type { CatalogPosition, CatalogSearch, CatalogStore, CatalogStudy, InstantRange, StudyHierarchy, TokenFilter, TokenTerm } from "./archive/types";
import { ACCESSION_SYSTEM, DICOM_UID_SYSTEM } from "./catalog";

const DEFAULT_COUNT = 20, MAX_COUNT = 100;
/** Raw hierarchy per page, by the sizes the catalog stores. A page always has at least one study. */
const PAGE_BYTES = 5 * 1024 * 1024;
const CANDIDATE_BATCH = 200;
const ACSN = { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v2-0203", code: "ACSN" }] };
const b64 = (v: Buffer | string) => Buffer.from(v).toString("base64url");
const DCM = "http://dicom.nema.org/resources/ontology/DCM";
/** The date this server's CapabilityStatement was last changed by hand. */
const CAPABILITY_DATE = "2026-11-06";
/** Values in one search's filters. More is a request to refuse, not a query to build. */
const MAX_FILTER_VALUES = 100;
const FHIR_ID = /^[A-Za-z0-9\-.]{1,64}$/;
const FHIR_DATE = /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00))?)?)?)?$/;

/** RFC 7235: the scheme is case-insensitive. */
const bearerOf = (req: Request) => req.headers.get("authorization")?.match(/^bearer +(.+)$/i)?.[1];

/** Splits on a character that a FHIR `\\` doesn't escape, leaving the escapes in place. */
function splitEscaped(text: string, on: string): string[] {
  const out = [""];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\" && i + 1 < text.length) out[out.length - 1] += text[i]! + text[++i]!;
    else if (text[i] === on) out.push("");
    else out[out.length - 1] += text[i]!;
  }
  return out;
}
const unescapeFhir = (text: string) => text.replace(/\\(.)/g, "$1");

/** `value`, `system|value`, `|value` or `system|`, per FHIR R4 search. */
function parseToken(text: string): TokenTerm | undefined {
  const pieces = splitEscaped(text, "|").map(unescapeFhir);
  if (pieces.length === 1) return pieces[0] ? { value: pieces[0] } : undefined;
  const [system, value] = pieces;
  if (pieces.length > 2 || (!system && !value)) return undefined;
  return { system: system || null, ...(value ? { value } : {}) };
}

/** The range a FHIR date covers at its stated precision. Offsetless values are UTC, this server's time zone. */
function implicitRange(text: string): { from: number; before: number } | undefined {
  const m = FHIR_DATE.exec(text);
  if (!m) return undefined;
  const [y, mo, d, h, mi, s] = [m[1]!, m[2] ?? "1", m[3] ?? "1", m[4] ?? "0", m[5] ?? "0", m[6] ?? "0"].map(Number) as [number, number, number, number, number, number];
  const fraction = m[7] ?? "";
  const local = Date.UTC(y, mo - 1, d, h, mi, s);
  const t = new Date(local);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d || t.getUTCHours() !== h || t.getUTCMinutes() !== mi || t.getUTCSeconds() !== s) return undefined;
  const start = local + Number(fraction.slice(0, 3).padEnd(3, "0"));
  if (m[2] === undefined) return { from: start, before: Date.UTC(y + 1, 0, 1) };
  if (m[3] === undefined) return { from: start, before: Date.UTC(y, mo, 1) };
  const span = m[4] === undefined ? 86400000 : m[6] === undefined ? 60000 : fraction ? 10 ** Math.max(0, 3 - fraction.length) : 1000;
  const zone = m[8] && m[8] !== "Z" ? (m[8][0] === "-" ? 1 : -1) * (Number(m[8].slice(1, 3)) * 3600000 + Number(m[8].slice(4)) * 60000) : 0;
  return { from: start + zone, before: start + zone + span };
}

/** A `_lastUpdated` value, as the instants that satisfy it. A target is one instant, so `sa` is `gt` and `eb` is `lt`. */
function parseLastUpdated(text: string): InstantRange | undefined {
  const prefix = text.match(/^(eq|ne|gt|lt|ge|le|sa|eb)/)?.[1];
  const range = implicitRange(prefix ? text.slice(2) : text);
  if (!range) return undefined;
  switch (prefix) {
    case "gt": case "sa": return { from: range.before };
    case "lt": case "eb": return { before: range.from };
    case "ge": return { from: range.from };
    case "le": return { before: range.before };
    case "ne": return { ...range, not: true };
    default: return range;
  }
}

export function hasImagingScope(scope: string, level: "patient" | "system"): boolean {
  return scope.split(" ").some(s => s === `${level}/ImagingStudy.rs` || s === `${level}/ImagingStudy.read` || s === `${level}/*.rs` || s === `${level}/*.read`);
}

/** System-level access is for Backend Services tokens, which no user authorized. A user's token needs a patient. */
export function accessLevel(t: { patient?: string; sub?: string }): "patient" | "system" | undefined {
  return t.patient ? "patient" : t.sub ? undefined : "system";
}

export interface ImagingServerOptions {
  /** The FHIR base this server is reached at, ending in `/fhir`. Every URL it issues starts here or at `proxyBase`. */
  base: string;
  /** The clinical FHIR server, whose Patient references search accepts and issues. */
  clinicalFhirBase: string;
  /** The proxy's public base, for each Endpoint.address. */
  proxyBase: () => string;
  /** Token introspection at the Authorization Server. */
  introspect: (token: string) => Promise<any>;
  /** The patient a user account is, if any. */
  patientOf: (user: string) => string | undefined;
  /** The credential the proxy and the policy API's callers present. */
  serviceSecret: string;
  catalog: () => CatalogStore;
  /** Holds the signing key. */
  keyStore: PolicyStore;
  /** The policy that search and decisions use. */
  store: () => PolicyStore;
  /** Other stores the policy API can name with `?store=`. */
  namedStore?: (name: string) => PolicyStore | undefined;
  /** Signs paging cursors. Several processes behind one address have to share it. */
  cursorKey?: Uint8Array;
  pageBytes?: number;
  observer?: Observer;
  clock?: Clock;
}

/**
 * The Imaging Server reads the catalog and has no way to read an archive object. Without a `cursorKey`,
 * a key is made here, and a restart turns cursors already issued into 400s, which a client handles by
 * searching again.
 */
export function createImagingServer(opts: ImagingServerOptions) {
  const obs = opts.observer ?? noopObserver, clock = opts.clock ?? systemClock;
  const now = () => clock.now();
  const check: Observer["check"] = (...a) => obs.check(...a);
  // Where callers reach this server.
  const serviceBase = opts.base.replace(/\/fhir$/, "");
  let key = opts.keyStore.currentSigningKey();
  // This server's own view. A proxy reads the same keys from /.well-known/jwks.json.
  const keys = new Map([[key.kid, key.publicKey]]);
  let outage = false;
  const decisions: any[] = [];
  const cursorKey = opts.cursorKey ?? randomBytes(32);
  const pageBytes = opts.pageBytes ?? PAGE_BYTES;

  type PolicyRows = Pick<Policy, "rules" | "delegations" | "guardians" | "appGrants">;
  type Evaluation = { release: "none" | "study" | { series: string[] }; rule?: Rule; why: string; chain?: string[] };
  /** One search evaluates every candidate against the same policy, read once. */
  const policyRows = (s: PolicyStore = opts.store()): PolicyRows => { return { rules: s.rules(), delegations: s.delegations(), guardians: s.guardians(), appGrants: s.appGrants() }; };

  const matchRule = (t: any, patient: string, policy: PolicyRows): Rule | undefined =>
    policy.rules.find(r =>
      (r.when.client === undefined || r.when.client === t.client_id) &&
      (r.when.user === undefined || r.when.user === t.sub) &&
      (r.when.patient === undefined || r.when.patient === patient));
  const isGuardian = (policy: Pick<PolicyRows, "guardians">, user: string, patient: string) => policy.guardians.some(g => g.guardian === user && g.patient === patient);
  /** A withdrawn rule is no pre-authorization at all. */
  const preAuthorizing = (rule: Rule | undefined) => rule && !rule.withdrawn ? rule : undefined;

  /** The single policy decision used by both search and retrieval. It works on catalog rows. */
  function evaluate(t: any, study: CatalogStudy, policy: PolicyRows = policyRows()): Evaluation {
    const r = evaluateRule(t, study, policy);
    check("policy", `policy evaluation: ${study.id}`, r.release !== "none", { client: t.client_id, user: t.sub, patient_context: t.patient, study: study.id, site: study.site, chain: r.chain?.join(" → "), rule: r.rule?.id ?? "(none)", release: typeof r.release === "object" ? `${r.release.series.length} series` : r.release, why: r.why });
    return r;
  }
  /** Only the patient or a guardian can share a record, however a row came to be written. So a delegation can't be passed on. */
  const mayGrant = (policy: Pick<PolicyRows, "guardians">, d: { grantedBy: string; patient: string }) => opts.patientOf(d.grantedBy) === d.patient || isGuardian(policy, d.grantedBy, d.patient);
  /** The patient, or a guardian on file, to related person to app. Each link can only narrow what the one before it allows. */
  function accessChain(t: any, patient: string, site: string, policy: PolicyRows, studyId: string): { ok: boolean; why?: string; chain: string[] } {
    const chain: string[] = [];
    const guardian = policy.guardians.find(x => x.guardian === t.sub && x.patient === patient);
    if (t.fhirUser === `Patient/${patient}`) chain.push(`${t.sub} is the patient`);
    else if (guardian) {
      chain.push(`${t.sub} is ${patient}'s ${guardian.relationship}, on file, ${guardian.excludedStudies?.length ? "apart from what's confidential from them" : "for the whole record"}`);
      if (guardian.excludedStudies?.includes(studyId)) return { ok: false, why: `this study is confidential from ${t.sub}, so ${patient}'s guardian doesn't get it`, chain };
    }
    else {
      const d = policy.delegations.find(x => x.delegate === t.sub && x.patient === patient);
      if (!d) return { ok: false, why: `${t.sub} has no delegation from the patient`, chain };
      if (!mayGrant(policy, d)) return { ok: false, why: `${d.grantedBy} is neither ${patient} nor their guardian, so they can't grant this`, chain };
      if (d.asGuardian && !isGuardian(policy, d.grantedBy, patient)) return { ok: false, why: `${d.grantedBy} is no longer ${patient}'s guardian, so what they shared has ended`, chain };
      chain.push(`${d.grantedBy} delegated to ${t.sub} (${d.relationship}): ${d.sites.join(", ")}`);
      if (policy.guardians.find(x => x.guardian === d.grantedBy && x.patient === patient)?.excludedStudies?.includes(studyId)) return { ok: false, why: `this study is confidential from ${d.grantedBy}, so what they shared can't include it`, chain };
      if (!d.sites.includes(site)) return { ok: false, why: `the delegation to ${t.sub} doesn't include ${site}`, chain };
    }
    const g = policy.appGrants.find(x => x.client === t.client_id && x.user === t.sub && x.patient === patient);
    if (!g) return { ok: false, why: `${t.sub} hasn't authorized ${t.client_id}`, chain };
    chain.push(`${t.sub} authorized ${t.client_id}: ${g.sites?.join(", ") ?? "everything they can see"}`);
    if (g.sites && !g.sites.includes(site)) return { ok: false, why: `${t.sub}'s authorization of ${t.client_id} doesn't include ${site}`, chain };
    return { ok: true, chain };
  }

  /** The sites a guardian can choose among, so that a confidential study's site doesn't give it away. */
  const guardianSites = (g: Guardian) => [...new Set([...candidates(opts.catalog(), { patient: g.patient })].filter(s => !g.excludedStudies?.includes(s.id)).flatMap(s => s.site ? [s.site] : []))];
  /** Sites a page may name to anyone but the patient: never one that only a study confidential from a guardian is at. */
  const withinGuardian = (policy: Pick<PolicyRows, "guardians">, user: string, patient: string, sites: string[]) => {
    const guardians = policy.guardians.filter(x => x.patient === patient && x.excludedStudies?.length);
    if (!guardians.length || opts.patientOf(user) === patient) return sites;
    const open = new Set(guardians.flatMap(guardianSites));
    return sites.filter(s => open.has(s));
  };
  /** What one signed-in user can see and has shared, for the Authorization Server's pages. Their own record is first, then the people they're guardian for, then what's shared with them. */
  function accessFor(store: PolicyStore, user: string, fhirUser: string): Access {
    const records: Access["records"] = [];
    const self = fhirUser.match(/^Patient\/(.+)$/)?.[1];
    if (self) records.push({ patient: self, via: "self", sites: opts.catalog().sitesFor(self) });
    const policy = store.getPolicy();
    for (const g of policy.guardians) if (g.guardian === user && g.patient !== self) records.push({ patient: g.patient, via: "guardian", relationship: g.relationship, sites: guardianSites(g) });
    for (const d of policy.delegations) if (d.delegate === user && !records.some(r => r.patient === d.patient) && mayGrant(policy, d)) records.push({ patient: d.patient, via: "delegation", relationship: d.relationship, sites: withinGuardian(policy, d.grantedBy, d.patient, d.sites) });
    return {
      records,
      delegations: policy.delegations.filter(d => d.grantedBy === user).map(d => ({ ...d, sites: withinGuardian(policy, user, d.patient, d.sites) })),
      apps: policy.appGrants.filter(g => g.user === user).map(g => g.sites ? { ...g, sites: withinGuardian(policy, user, g.patient, g.sites) } : g),
    };
  }

  /**
   * What the same `evaluate` that search uses decides for each of a patient's studies, for one client
   * and, for a launch, one user. It's for showing why a list looks as it does, which a real app never sees.
   */
  function explain(store: PolicyStore, { client, user, fhirUser, patient }: Partial<ExplainQuery>) {
    if (!client || !patient || (user && !fhirUser)) return { error: "client and patient are required, and a user needs a fhirUser" };
    const t = user ? { client_id: client, sub: user, fhirUser, patient } : { client_id: client };
    const policy = policyRows(store);
    const rule = matchRule(t, patient, policy);
    const studies = [...candidates(opts.catalog(), { patient })].map(study => {
      const ev = evaluate(t, study, policy);
      const released = typeof ev.release === "object" ? new Set(ev.release.series) : undefined;
      return {
        id: study.id, title: study.title, description: study.description, date: study.date, site: study.site, status: study.status,
        modalities: [...new Set(study.series.map(s => s.modality))], seriesCount: study.seriesCount, instanceCount: study.instanceCount,
        release: ev.release, reason: ev.why, chain: ev.chain ?? [], rule: ev.rule?.id,
        withheldSeries: released ? study.series.filter(s => !released.has(s.uid)).map(s => ({ uid: s.uid, number: s.number, modality: s.modality, instanceCount: s.instanceCount })) : [],
      };
    });
    return {
      client, user: user ?? undefined, fhirUser: fhirUser ?? undefined, patient, level: user ? "patient" : "system",
      searchAllowed: !!user || !!preAuthorizing(rule), rule: user ? rule : preAuthorizing(rule),
      guardian: user ? policy.guardians.find(g => g.guardian === user && g.patient === patient) : undefined,
      delegation: user ? [policy.delegations.find(d => d.delegate === user && d.patient === patient)].flatMap(d => d && mayGrant(policy, d) ? [{ ...d, sites: withinGuardian(policy, d.grantedBy, patient, d.sites) }] : [])[0] : undefined,
      appGrant: user ? [policy.appGrants.find(g => g.client === client && g.user === user && g.patient === patient)].flatMap(g => g ? [g.sites ? { ...g, sites: withinGuardian(policy, user, patient, g.sites) } : g] : [])[0] : undefined,
      studies,
    };
  }

  function evaluateRule(t: any, study: CatalogStudy, policy: PolicyRows): Evaluation {
    if (t.patient && t.patient === study.patient) {
      // A study with no site is outside every list of sites.
      const a = accessChain(t, t.patient, study.site ?? "", policy, study.id);
      if (!a.ok) return { release: "none", why: a.why!, chain: a.chain };
      return { ...evaluateAfterChain(t, study, policy), chain: a.chain };
    }
    return evaluateAfterChain(t, study, policy);
  }
  function evaluateAfterChain(t: any, study: CatalogStudy, policy: PolicyRows): Evaluation {
    const patient = study.patient;
    const level = accessLevel(t);
    if (!level) return { release: "none", why: "a user's token has no patient context" };
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

  /**
   * A study with nothing to retrieve, such as a `registered` one, has no endpoint and no series list.
   * The profile requires a modality on every study, so one with no series known yet says `OT`.
   */
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
    const released = typeof ev.release === "object" ? new Set(ev.release.series) : undefined;
    const isReleased = (s: { uid: string }) => !released || released.has(s.uid);
    const modality = (known: { modality: string }[]) => [...new Set(known.map(s => s.modality))].map(code => ({ system: DCM, code }));
    if (!endpointRef) {
      const known = modality(study.series.filter(isReleased));
      return { ...common, modality: known.length ? known : [{ system: DCM, code: "OT" }], description: study.description };
    }
    const series = (hierarchy?.series ?? []).filter(isReleased);
    return {
      ...common,
      modality: modality(series),
      description: study.description,
      numberOfSeries: series.length,
      numberOfInstances: series.reduce((n, s) => n + s.instances.length, 0),
      endpoint: [{ reference: endpointRef }],
      series: series.map(s => ({
        uid: s.uid, number: s.number, modality: { system: DCM, code: s.modality }, description: s.description, numberOfInstances: s.instances.length,
        instance: s.instances.map(i => ({ uid: i.uid, number: i.number, sopClass: { system: "urn:ietf:rfc:3986", code: `urn:oid:${i.sopClass}` } })),
      })),
    };
  }

  /** `id`, `Patient/id`, or that reference on this deployment's clinical FHIR base. */
  function patientOf(param: string): { id: string } | { status: 400 | 403; code: string; text: string } {
    const clinical = `${opts.clinicalFhirBase.replace(/\/$/, "")}/Patient/`;
    if (!param.startsWith(clinical) && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(param)) return { status: 403, code: "forbidden", text: "patient is not on this deployment's clinical FHIR server" };
    const id = param.startsWith(clinical) ? param.slice(clinical.length) : param.replace(/^Patient\//, "");
    return FHIR_ID.test(id) ? { id } : { status: 400, code: "invalid", text: "patient must be a logical id or a reference to a Patient on this deployment's clinical FHIR server" };
  }
  function searchFilters(url: URL, patient: string): CatalogSearch | { error: string } {
    const tokens = (name: string): TokenFilter | string => {
      const filter: TokenFilter = [];
      for (const repeat of url.searchParams.getAll(name)) {
        const terms = splitEscaped(repeat, ",").map(parseToken);
        if (terms.some(t => !t)) return `${name} needs a value, as value, system|value, |value or system|`;
        filter.push(terms as TokenTerm[]);
      }
      return filter;
    };
    const identifier = tokens("identifier"), basedOn = tokens("based-on:identifier");
    if (typeof identifier === "string") return { error: identifier };
    if (typeof basedOn === "string") return { error: basedOn };
    const lastUpdated = url.searchParams.getAll("_lastUpdated").map(parseLastUpdated);
    if (lastUpdated.some(r => !r)) return { error: "_lastUpdated must be a FHIR date, with one of the prefixes eq, ne, gt, lt, ge, le, sa or eb, or none. Repeat the parameter to require more than one." };
    if ([...identifier, ...basedOn].flat().length + lastUpdated.length > MAX_FILTER_VALUES) return { error: `a search can have at most ${MAX_FILTER_VALUES} filter values` };
    return { patient, ...(identifier.length ? { identifier } : {}), ...(basedOn.length ? { basedOn } : {}), ...(lastUpdated.length ? { lastUpdated: lastUpdated as InstantRange[] } : {}) };
  }

  // A cursor is a position and a hash of the query's filters, signed so a client can't aim it
  // anywhere. It grants nothing: authentication, scope and policy all run again on every page.
  const filterHash = (q: CatalogSearch) => createHash("sha256").update(JSON.stringify([q.patient, q.identifier ?? null, q.basedOn ?? null, q.lastUpdated ?? null])).digest("base64url");
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
    const bearer = bearerOf(req);
    if (!bearer) return new Response(null, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
    const t = await opts.introspect(bearer);
    if (!check("imaging-fhir", "token is active", t.active, { client: t.client_id, scope: t.scope, patient_context: t.patient, user: t.sub })) return new Response(null, { status: 401, headers: { "WWW-Authenticate": 'Bearer error="invalid_token"' } });
    const level = accessLevel(t);
    if (!level || !hasImagingScope(t.scope, level)) return Response.json(outcome("forbidden", "scope does not cover ImagingStudy"), { status: 403 });
    const patientParams = url.searchParams.getAll("patient");
    if (!patientParams[0]) return Response.json(outcome("required", "the patient parameter is required"), { status: 400 });
    if (patientParams.length > 1) return Response.json(outcome("invalid", "a search covers one patient"), { status: 400 });
    const parsed = patientOf(patientParams[0]);
    if (!("id" in parsed)) return Response.json(outcome(parsed.code, parsed.text), { status: parsed.status });
    const patient = parsed.id;
    if (level === "patient" && patient !== t.patient) return Response.json(outcome("forbidden", "patient does not match the token's patient context"), { status: 403 });
    const policy = policyRows();
    if (level === "system" && !preAuthorizing(matchRule(t, patient, policy))) return Response.json(outcome("forbidden", "this patient is outside the client's authorized access"), { status: 403 });

    const countParam = url.searchParams.get("_count");
    if (countParam !== null && !/^\d+$/.test(countParam)) return Response.json(outcome("invalid", "_count must be a whole number"), { status: 400 });
    const count = countParam === null ? DEFAULT_COUNT : Math.min(Number(countParam), MAX_COUNT);
    const filters = searchFilters(url, patient);
    if ("error" in filters) return Response.json(outcome("invalid", filters.error), { status: 400 });
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
      yield `${JSON.stringify({ resourceType: "Bundle", type: "searchset", total, link }).slice(0, -1)}${rows.length ? ',"entry":[' : ""}`;
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
      yield rows.length ? "]}" : "}";
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
    if (!check("policy", "caller is the authenticated proxy", bearerOf(req) === opts.serviceSecret)) return Response.json({ error: "authentication required" }, { status: 401, headers: { "WWW-Authenticate": "Bearer", ...echo } });
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
    const level = accessLevel(t);
    if (!level || !hasImagingScope(t.scope, level)) return respond(false, { denial: "insufficient_scope", max_age_seconds: 30 }, "scope does not cover imaging");
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

  const policyApi = createPolicyApi({
    serviceSecret: opts.serviceSecret, store: opts.store, namedStore: opts.namedStore, check,
    model: { access: accessFor, explain, guardianSites, sitesFor: patient => opts.catalog().sitesFor(patient) },
  });

  return {
    publicKeys: keys,
    jwks: () => ({ keys: [publicJwk(key)] }),
    fetch: obs.serve("imaging-fhir", async (req: Request, server): Promise<Response> => {
      const url = new URL(req.url);
      const p = url.pathname;
      const policyPath = p === POLICY_API_PATH || p.startsWith(`${POLICY_API_PATH}/`);
      if (p === "/access/v1/evaluation" || policyPath) server.creditTo("policy");
      if (policyPath) return policyApi(req, url);
      if (p === "/fhir/ImagingStudy" && req.method === "GET") return search(req, url);
      if (p === "/fhir/metadata") return Response.json({ resourceType: "CapabilityStatement", status: "active", date: CAPABILITY_DATE, kind: "instance", implementation: { description: "SMART Imaging proxy demo: Imaging FHIR Server", url: opts.base }, fhirVersion: "4.0.1", format: ["json"], instantiates: ["http://fhir.org/argonaut/smart-imaging/CapabilityStatement/smart-imaging-server"], rest: [{ mode: "server", resource: [{ type: "ImagingStudy", interaction: [{ code: "search-type" }], searchInclude: ["ImagingStudy:endpoint"], searchParam: [{ name: "patient", type: "reference" }, { name: "identifier", type: "token", documentation: "value, system|value, |value or system|. A comma means any of the values, and a repeated parameter means all of them." }, { name: "based-on", type: "reference", documentation: "Searched by order identifier, as based-on:identifier, which takes the same forms as identifier." }, { name: "_lastUpdated", type: "date", documentation: "The value each study's published version states, or otherwise midnight UTC on its study date. Only publishing a study with a different value changes it: in-place DICOM edits, deletions, reassignments and policy changes don't. Takes the prefixes eq, ne, gt, lt, ge, le, sa and eb, or none, and a repeated parameter means all of them. A value with no offset is in UTC, and a partial one covers its whole range." }, { name: "_count", type: "number", documentation: `Studies per page: ${DEFAULT_COUNT} by default, and larger values than ${MAX_COUNT} are treated as ${MAX_COUNT}. A page can hold fewer, to stay within its size limit. 0 returns only the total.` }, { name: "_cursor", type: "string", documentation: "Opaque, and supplied by a Bundle's next link. Use it with the same filters. It grants nothing, and policy applies again on every page." }] }] }] });
      if (p === "/access/v1/evaluation" && req.method === "POST") return evaluation(req);
      if (p === "/.well-known/authzen-configuration") return Response.json({ policy_decision_point: serviceBase, access_evaluation_endpoint: `${serviceBase}/access/v1/evaluation` });
      if (p === "/.well-known/jwks.json") return Response.json({ keys: [publicJwk(key)] });
      return new Response("not found", { status: 404 });
    }),
    setOutage(on: boolean) { outage = on; },
    get outage() { return outage; },
    get signingKid() { return key.kid; },
    /** URLs signed with the old key stop verifying here right away, and at a proxy once it refetches its keys. */
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
