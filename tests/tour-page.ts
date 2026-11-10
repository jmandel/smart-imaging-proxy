// What the Tours page does for each step, for tests: begin the step at the sandbox, do what it plans as the
// page would, with its own tokens, then finish it with what it saw. A test can change a step's plan first.
import { createHash, randomBytes } from "node:crypto";
import { CONFIG, localUrl } from "../src/config";
import { submitConsent } from "../src/flows/oauth";
import { adminToken, assertion, keysOf } from "./admin-token";

type Demo = { fetch(req: Request): Promise<Response> | Response };
const host = () => new URL(CONFIG.demoUrl).host;

export function tourPage(demo: Demo, base: string) {
  const tokens: Record<string, string> = {}, services: Record<string, string> = {};
  let admin: string | undefined;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}, again = true): Promise<{ status: number; body: any }> => {
    const auth = path.startsWith("/api/sandbox") ? { authorization: `Bearer ${admin ??= await adminToken(demo, base)}` } : {};
    const r = await demo.fetch(new Request(`${CONFIG.demoUrl}${base}${path}`, { method, headers: { host: host(), "content-type": "application/json", ...auth, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    // As the page does: a token the demo clock has expired gets a fresh one, once.
    if (r.status === 401 && again && path.startsWith("/api/sandbox")) { admin = undefined; return call(method, path, body, headers, false); }
    return { status: r.status, body: await r.json().catch(() => undefined) as any };
  };
  const discovery = async () => (await fetch(localUrl(`${CONFIG.demoUrl}${base}/fhir/.well-known/smart-configuration`))).json() as Promise<any>;
  const imagingOf = (c: any, capability: string) => (c.associated_endpoints ?? []).find((e: any) => e.capabilities?.includes(capability))?.url ?? `${CONFIG.demoUrl}${base}/fhir`;
  async function search(token: string, query: string, headers: Record<string, string>, capability: string) {
    let url: string | undefined = `${imagingOf(await discovery(), capability)}/ImagingStudy?${query}`;
    const entries: any[] = [];
    while (url) {
      const r = await fetch(localUrl(url), { headers: { authorization: `Bearer ${token}`, accept: "application/fhir+json", ...headers } });
      if (!r.ok) return { status: r.status, studies: [] };
      const b: any = await r.json();
      entries.push(...(b.entry ?? []));
      url = b.link?.find((l: any) => l.relation === "next")?.url;
    }
    const byUrl = new Map(entries.filter(e => e.resource.resourceType === "Endpoint").map(e => [e.fullUrl, e.resource.address]));
    return { status: 200, studies: entries.filter(e => e.resource.resourceType === "ImagingStudy").map(e => ({ id: e.resource.id, uid: e.resource.identifier[0].value.replace("urn:oid:", ""), base: byUrl.get(e.resource.endpoint?.[0]?.reference) })) };
  }
  const retrieve = async (token: string, url: string, headers: Record<string, string>) => { const r = await fetch(localUrl(url), { headers: { authorization: `Bearer ${token}`, accept: "multipart/related; type=application/dicom; transfer-syntax=*", ...headers } }); await r.arrayBuffer(); return { status: r.status }; };
  async function perform(plan: any, session: string, trace: string) {
    const headers = { traceparent: `00-${trace}-${randomBytes(8).toString("hex")}-01`, baggage: `demo.session=${encodeURIComponent(session)}` };
    const serviceToken = async (client: string) => services[client] ??= await (async () => {
      const k = await keysOf(demo, base), svc = k.services.find(s => s.client_id === client)!;
      const r: any = await (await fetch(k.tokenEndpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams({ grant_type: "client_credentials", scope: svc.scope, client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: assertion(svc.client_id, svc.jwk, k.tokenEndpoint, k.now) }) })).json();
      return r.access_token as string;
    })();
    switch (plan.do) {
      case "sign-in": {
        const c = await discovery();
        const verifier = randomBytes(32).toString("base64url"), state = randomBytes(16).toString("base64url");
        const q = new URLSearchParams({ response_type: "code", client_id: plan.app, redirect_uri: plan.redirectUri, scope: plan.scope, state, aud: plan.aud, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", login_hint: plan.user, demo_patient: plan.patient, demo_traceparent: headers.traceparent, demo_session: session });
        const back = await submitConsent(`${c.authorization_endpoint}?${q}`, { user: plan.user, patient: plan.patient, ...(plan.sites ? { sites: plan.sites } : {}) });
        const code = back.searchParams.get("code");
        if (!code) return { token: false, error: back.searchParams.get("error"), state };
        const t: any = await (await fetch(localUrl(c.token_endpoint), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: plan.redirectUri, client_id: plan.app, code_verifier: verifier }) })).json();
        if (!t.access_token) return { token: false, error: t.error, state };
        tokens[plan.user] = t.access_token;
        return { token: true, patient: t.patient, expiresIn: t.expires_in, state };
      }
      case "search": return search(tokens[plan.as]!, plan.query, headers, "http://fhir.org/argonaut/smart-imaging/capabilities/app-launch");
      case "retrieve": return retrieve(tokens[plan.as]!, plan.url, headers);
      case "service-search": return search(await serviceToken(plan.client), plan.query, headers, "http://fhir.org/argonaut/smart-imaging/capabilities/backend-services");
      case "service-retrieve": return retrieve(await serviceToken(plan.client), plan.url, headers);
      case "referral-check": return { ok: !!plan.patientRef?.startsWith(`${plan.clinicalFhir}/Patient/`) };
      case "management": {
        const statuses: number[] = [];
        for (const m of plan.calls) statuses.push((await call(m.method, `/api/sandbox/policy${m.path}`, m.body, headers)).status);
        return { statuses };
      }
      default: return {};
    }
  }
  /** One step, begun, done and finished. `change` can alter what's planned, or do more after it. */
  async function step(tour: string, id: string, change?: { plan?: (plan: any) => any; after?: (call: typeof call) => Promise<unknown> }) {
    const path = `/api/sandbox/tours/${tour}/steps/${id}`;
    const b = await call("POST", `${path}/begin`, {});
    if (b.status !== 200 || b.body.state) return b.body.state ? { status: 200, body: b.body.state } : b;
    const plan = change?.plan ? change.plan(b.body.plan) : b.body.plan;
    const seen = await perform(plan, b.body.session, b.body.trace);
    await change?.after?.(call);
    return call("POST", `${path}/finish`, { seen });
  }
  return { call, step, state: (tour?: string) => call("GET", `/api/sandbox/tours/state${tour ? `?tour=${tour}` : ""}`) };
}
