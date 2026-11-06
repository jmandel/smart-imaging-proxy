// JSON endpoints behind the admin screen. The demo has no admin login: every service binds to
// 127.0.0.1 and the tailnet address, and writes naming another Host or web origin are refused. A store action applies to
// the active store unless it names one.
import type { BackendName, Stack } from "./stack";
import { PolicyValidationError } from "./policy-store";
import { advance, clockOffset, now, resetClock } from "./clock";
import { PORTS, TAILNET } from "./config";

export const BACKEND_NAMES: BackendName[] = ["static-files", "minio", "orthanc"];
const MAX_ADVANCE_SECONDS = 10 * 365 * 86400;

const json = (b: unknown, status = 200) => Response.json(b, { status });
const bad = (error: string, errors?: string[]) => json({ error, ...(errors ? { errors } : {}) }, 400);

/** The parsed body, or undefined when it isn't JSON. */
export const readJson = async (req: Request): Promise<any> => req.json().catch(() => undefined);
const OWN_HOSTS = [`127.0.0.1:${PORTS.demo}`, `localhost:${PORTS.demo}`, ...(TAILNET ? [`${TAILNET.name}:${PORTS.demo}`, `${TAILNET.ip}:${PORTS.demo}`] : [])];
/**
 * Why a write must be refused, if it must. A DNS rebinding page reaches this server under its own
 * host name, so the Host header has to be this server's. A browser names the page's origin on a
 * write, and tools that send no Origin are fine.
 */
export function refuseWrite(req: Request, url: URL): Response | undefined {
  if (!OWN_HOSTS.includes(req.headers.get("host") ?? "")) return json({ error: "this server answers writes only at its own addresses and port" }, 403);
  const origin = req.headers.get("origin");
  if (origin && origin !== url.origin) return json({ error: "cross-origin request refused" }, 403);
  return undefined;
}

export function adminStatus(stack: Stack) {
  const { stores } = stack;
  const policy = stores.active.getPolicy();
  return {
    store: { active: stores.activeName, label: stores.activeLabel, saved: stores.saved.info(), scratch: stores.scratch.info() },
    policy: { rules: policy.rules, delegations: policy.delegations, appGrants: policy.appGrants },
    settings: stores.active.getSettings(),
    clock: { offsetSeconds: clockOffset(), now: now() },
    backend: { current: stack.backend, names: BACKEND_NAMES },
    signing: { kid: stack.imaging.signingKid },
    proxy: { cachedDecisions: stack.proxy.cachedDecisions },
    outage: stack.imaging.outage,
  };
}

export async function adminApi(stack: Stack, req: Request, url: URL, hooks: { forgetFlow: () => void }): Promise<Response> {
  const p = url.pathname.slice("/api/admin".length);
  const m = req.method;
  const status = () => json(adminStatus(stack));
  if (m !== "GET") { const refused = refuseWrite(req, url); if (refused) return refused; }

  if (p === "/status" && m === "GET") return status();
  if (p === "/backends" && m === "GET") return json({ current: stack.backend, backends: await Promise.all(BACKEND_NAMES.map(n => stack.selfTest(n))) });

  if (p === "/delegations" && m === "DELETE") {
    const patient = url.searchParams.get("patient"), delegate = url.searchParams.get("delegate");
    if (!patient || !delegate) return bad("patient and delegate are required");
    if (!stack.stores.active.removeDelegations({ patient, delegate })) return json({ error: "no such delegation" }, 404);
    return status();
  }
  if (p === "/app-grants" && m === "DELETE") {
    const client = url.searchParams.get("client"), user = url.searchParams.get("user"), patient = url.searchParams.get("patient");
    if (!client || !user || !patient) return bad("client, user and patient are required");
    if (!stack.stores.active.removeAppGrants({ client, user, patient })) return json({ error: "no such app grant" }, 404);
    return status();
  }
  if (p === "/store/reset-scratch" && m === "POST") {
    stack.resetScratch();
    hooks.forgetFlow();
    return status();
  }
  if (p === "/tokens/revoke-all" && m === "POST") {
    stack.stores.active.revokeAllTokens();
    return status();
  }

  if (p === "/proxy/flush" && m === "POST") {
    stack.proxy.flushDecisions();
    return status();
  }
  if (p === "/signing-key/rotate" && m === "POST") {
    stack.imaging.rotateSigningKey();
    return status();
  }

  if (m !== "POST" && m !== "PUT") return new Response("not found", { status: 404 });
  const known = ["/store/activate", "/store/reset-saved", "/rules", "/settings", "/clock", "/backend", "/outage"];
  if (!known.includes(p)) return new Response("not found", { status: 404 });
  const b = await readJson(req);
  if (b === undefined || b === null || typeof b !== "object" || Array.isArray(b)) return bad("the request body must be a JSON object");

  try {
    if (p === "/store/activate" && m === "POST") {
      if (b.store !== "saved" && b.store !== "scratch") return bad('store must be "saved" or "scratch"');
      stack.useStore(b.store);
      return status();
    }
    if (p === "/store/reset-saved" && m === "POST") {
      if (b.confirm !== true) return bad("resetting saved policy needs confirm: true");
      stack.resetSaved();
      return status();
    }
    if (p === "/rules" && m === "PUT") {
      if (!Array.isArray(b.rules)) return bad("rules must be an array");
      stack.imaging.setPolicy({ rules: b.rules });
      return status();
    }
    if (p === "/settings" && m === "PUT") {
      stack.stores.active.setSettings(b);
      return status();
    }
    if (p === "/clock" && m === "POST") {
      if (b.reset === true) resetClock();
      else if (Number.isInteger(b.advanceSeconds) && b.advanceSeconds > 0 && b.advanceSeconds <= MAX_ADVANCE_SECONDS) advance(b.advanceSeconds);
      else return bad(`send reset: true, or advanceSeconds as a whole number from 1 to ${MAX_ADVANCE_SECONDS}`);
      return status();
    }
    if (p === "/backend" && m === "POST") {
      if (!BACKEND_NAMES.includes(b.backend)) return bad(`backend must be one of ${BACKEND_NAMES.join(", ")}`);
      stack.setBackend(b.backend);
      return status();
    }
    if (p === "/outage" && m === "POST") {
      if (typeof b.on !== "boolean") return bad("on must be true or false");
      stack.imaging.setOutage(b.on);
      return status();
    }
  } catch (e) {
    if (e instanceof PolicyValidationError) return bad(e.message, e.errors);
    throw e;
  }
  return new Response("not found", { status: 404 });
}
