// Authorization Server: Backend Services (real client assertions), a demo consent step in
// place of a browser redirect, refresh, revocation, introspection, and SMART discovery.
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from "node:crypto";
import { ath, b64url } from "./jws";
import { now } from "./clock";
import { check, traced } from "./trace";

export interface Grant { client_id: string; scope: string; patient?: string; sub?: string; fhirUser?: string; }
interface TokenRecord extends Grant { exp: number; revoked: boolean; }

export interface BackendClient { client_id: string; kid: string; privateKey: KeyObject; }

export function createAuthServer(opts: { issuer: string; imagingFhirBase: string; serviceSecret: string; tokenLifetime?: number }) {
  const tokens = new Map<string, TokenRecord>();
  const refresh = new Map<string, Grant>();
  const backendKeys = new Map<string, { kid: string; publicKey: KeyObject; scopes: string[] }>();
  let tokenLifetime = opts.tokenLifetime ?? 3600;

  const issue = (g: Grant, withRefresh: boolean) => {
    const access_token = randomBytes(32).toString("base64url");
    const exp = now() + tokenLifetime;
    tokens.set(access_token, { ...g, exp, revoked: false });
    check("authorization-server", "issue access token", true, { client: g.client_id, scope: g.scope, patient_context: g.patient, user: g.sub, token_hash: ath(access_token).slice(0, 10), expires_in: tokenLifetime });
    const res: any = { access_token, token_type: "Bearer", expires_in: tokenLifetime, scope: g.scope };
    if (g.patient) res.patient = g.patient;
    if (withRefresh) { const r = randomBytes(32).toString("base64url"); refresh.set(r, g); res.refresh_token = r; }
    return res;
  };
  const oauthError = (error: string, status = 400) => Response.json({ error }, { status });

  function verifyAssertion(jwt: string, tokenUrl: string) {
    const [h, b, s] = jwt.split(".");
    if (!h || !b || !s) return undefined;
    const head = JSON.parse(Buffer.from(h, "base64url").toString());
    const claims = JSON.parse(Buffer.from(b, "base64url").toString());
    const reg = backendKeys.get(claims.iss);
    if (!reg || head.kid !== reg.kid || head.alg !== "ES256" || claims.sub !== claims.iss || claims.aud !== tokenUrl || claims.exp < now()) return undefined;
    const ok = verify("sha256", Buffer.from(`${h}.${b}`), { key: reg.publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
    check("authorization-server", "client assertion signature verifies", ok, { client: claims.iss, kid: head.kid, alg: head.alg });
    return ok ? reg : undefined;
  }

  const fetchHandler = traced("authorization-server", async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const tokenUrl = `${opts.issuer}/token`;
    if (url.pathname === "/fhir/.well-known/smart-configuration") {
      return Response.json({
        issuer: opts.issuer, authorization_endpoint: `${opts.issuer}/authorize`, token_endpoint: tokenUrl,
        introspection_endpoint: `${opts.issuer}/introspect`, revocation_endpoint: `${opts.issuer}/revoke`,
        grant_types_supported: ["authorization_code", "client_credentials", "refresh_token"],
        token_endpoint_auth_methods_supported: ["private_key_jwt"], token_endpoint_auth_signing_alg_values_supported: ["ES256"],
        scopes_supported: ["patient/ImagingStudy.rs", "system/ImagingStudy.rs", "launch/patient", "online_access"],
        capabilities: ["launch-standalone", "client-confidential-asymmetric"],
        associated_endpoints: [{ url: opts.imagingFhirBase, capabilities: ["smart-imaging-access", "http://fhir.org/argonaut/smart-imaging/capabilities/app-launch", "http://fhir.org/argonaut/smart-imaging/capabilities/backend-services"] }],
      });
    }
    if (url.pathname === "/token" && req.method === "POST") {
      const f = new URLSearchParams(await req.text());
      const grant = f.get("grant_type");
      if (grant === "client_credentials") {
        if (f.get("client_assertion_type") !== "urn:ietf:params:oauth:client-assertion-type:jwt-bearer") return oauthError("invalid_client", 401);
        const reg = verifyAssertion(f.get("client_assertion") ?? "", tokenUrl);
        if (!reg) return oauthError("invalid_client", 401);
        const iss = JSON.parse(Buffer.from((f.get("client_assertion") ?? "").split(".")[1]!, "base64url").toString()).iss;
        const asked = (f.get("scope") ?? "").split(" ").filter(s => reg.scopes.includes(s));
        if (!asked.length) return oauthError("invalid_scope");
        return Response.json(issue({ client_id: iss, scope: asked.join(" ") }, false));
      }
      if (grant === "refresh_token") {
        const g = refresh.get(f.get("refresh_token") ?? "");
        if (!g) return oauthError("invalid_grant");
        refresh.delete(f.get("refresh_token")!);
        return Response.json(issue(g, true));
      }
      return oauthError("unsupported_grant_type");
    }
    if (url.pathname === "/_demo/consent" && req.method === "POST") {
      // Stands in for the browser redirect flow: the user has signed in and approved.
      const b: any = await req.json();
      return Response.json(issue({ client_id: b.client_id, scope: b.scope, patient: b.patient, sub: b.user, fhirUser: b.fhirUser }, true));
    }
    if (url.pathname === "/introspect" && req.method === "POST") {
      if (req.headers.get("authorization") !== `Bearer ${opts.serviceSecret}`) return new Response(null, { status: 401 });
      const f = new URLSearchParams(await req.text());
      const t = tokens.get(f.get("token") ?? "");
      check("authorization-server", "introspect token", !!t && !t.revoked && t.exp > now(), { token_hash: ath(f.get("token") ?? "").slice(0, 10), client: t?.client_id, revoked: t?.revoked, expired: !!t && t.exp <= now() });
      if (!t || t.revoked || t.exp <= now()) return Response.json({ active: false });
      const { revoked, ...rest } = t;
      return Response.json({ active: true, iss: opts.issuer, ...rest });
    }
    if (url.pathname === "/revoke" && req.method === "POST") {
      const f = new URLSearchParams(await req.text());
      const t = tokens.get(f.get("token") ?? "");
      if (t) t.revoked = true;
      return new Response(null, { status: 200 });
    }
    if (url.pathname.startsWith("/fhir/Patient/")) {
      const id = url.pathname.split("/").pop();
      if (id !== "josh-example" && id !== "robin-example") return new Response(null, { status: 404 });
      return Response.json({ resourceType: "Patient", id, name: [{ family: "Example", given: [id === "josh-example" ? "Josh" : "Robin"] }] });
    }
    return new Response("not found", { status: 404 });
  });

  return {
    fetch: fetchHandler,
    registerBackendClient(client_id: string, scopes: string[]): BackendClient {
      const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
      const kid = `${client_id}-key`;
      backendKeys.set(client_id, { kid, publicKey, scopes });
      return { client_id, kid, privateKey };
    },
    tokenUrl: `${opts.issuer}/token`,
    setTokenLifetime(s: number) { tokenLifetime = s; },
    reset() { tokens.clear(); refresh.clear(); tokenLifetime = opts.tokenLifetime ?? 3600; },
  };
}

export function clientAssertion(c: BackendClient, aud: string): string {
  const head = b64url(JSON.stringify({ alg: "ES256", kid: c.kid, typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: c.client_id, sub: c.client_id, aud, jti: randomBytes(8).toString("hex"), exp: now() + 300 }));
  const sig = sign("sha256", Buffer.from(`${head}.${claims}`), { key: c.privateKey, dsaEncoding: "ieee-p1363" });
  return `${head}.${claims}.${b64url(sig)}`;
}
