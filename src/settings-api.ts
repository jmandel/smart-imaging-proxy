// The settings menu's API, for the world a page is in: the backend images come from, the demo clock,
// resetting policy, and ending access. The demo has no login: every service binds to 127.0.0.1 and the
// tailnet address, and a request naming another Host, or a write from another web origin, is refused.
// Every write takes a fixed choice from this file, and nothing else. At the root it acts on the one
// real policy database, and in a scope on that scope's. Policy changes go through the policy API.
import type { BackendName, Stack } from "./stack";
import type { World } from "./world";
import { ownHosts, PORTS } from "./config";

export const BACKEND_NAMES: BackendName[] = ["static-files", "s3", "orthanc"];

export interface Choice { value: number; label: string; }
const MINUTE = 60, HOUR = 3600, DAY = 86400;
export const CLOCK_CHOICES: Choice[] = [{ value: MINUTE, label: "1 minute" }, { value: 5 * MINUTE, label: "5 minutes" }, { value: HOUR, label: "1 hour" }, { value: DAY, label: "1 day" }];
const values = (choices: Choice[]) => choices.map(c => c.value).join(", ");

const json = (b: unknown, status = 200) => Response.json(b, { status });
const bad = (error: string) => json({ error }, 400);

/** The parsed body, or undefined when it isn't JSON. */
export const readJson = async (req: Request): Promise<any> => req.json().catch(() => undefined);
/** The message for a body holding any field but these. */
export const extraField = (b: Record<string, unknown>, allowed: string[]) =>
  Object.keys(b).some(k => !allowed.includes(k)) ? `this request accepts only ${allowed.join(", ")}` : undefined;
/** The message for a request with a body, when it takes none. */
const unwantedBody = async (req: Request) => ["", "{}"].includes((await req.text()).trim()) ? undefined : "this action takes no input";
export { ownHosts };
/**
 * A DNS rebinding page reaches a service under its own host name, so a Host header has to be the
 * service's. A browser always sends Host, so a request with none isn't such a page.
 */
export function refuseHost(req: Request, port: number = PORTS.demo): Response | undefined {
  const host = req.headers.get("host");
  return host && !ownHosts(port).includes(host) ? json({ error: "this server answers only at its own addresses and port" }, 403) : undefined;
}
/** Why a write must be refused, if it must. A browser names the page's origin on a write, and tools that send no Origin are fine. */
export function refuseWrite(req: Request, url: URL, port: number = PORTS.demo): Response | undefined {
  const foreign = refuseHost(req, port);
  if (foreign) return foreign;
  const origin = req.headers.get("origin");
  if (origin && origin !== url.origin) return json({ error: "cross-origin request refused" }, 403);
  return undefined;
}

export function settingsStatus(stack: Stack, world: World) {
  return {
    scope: world.scope ? { id: world.scope, base: world.prefix } : null,
    clock: { offsetSeconds: world.clock.offset(), now: world.clock.now() },
    clockChoices: CLOCK_CHOICES,
    backend: { current: world.backend, names: BACKEND_NAMES },
    topology: { current: world.topology, names: ["separate", "unified"] },
    catalog: { source: world.catalogSource, ...world.catalog.stats() },
    signing: { kid: world.imaging.signingKid },
    proxy: { cachedDecisions: world.proxy.cachedDecisions },
    // Only the root's store is a file, and only the root sees how many scopes there are.
    ...(world.scope ? {} : { store: stack.store.info(), scopes: { live: stack.scopes.size } }),
  };
}

const NO_INPUT = ["/tokens/revoke-all", "/proxy/flush", "/signing-key/rotate"];
const WITH_INPUT = ["/reset", "/clock", "/backend", "/topology"];

export async function settingsApi(stack: Stack, world: World, req: Request, url: URL): Promise<Response> {
  const p = url.pathname.slice("/api/settings".length);
  const m = req.method;
  const status = () => json(settingsStatus(stack, world));
  const refused = m === "GET" ? refuseHost(req) : refuseWrite(req, url);
  if (refused) return refused;

  if (p === "/status" && m === "GET") return status();
  if (p === "/backends" && m === "GET") return json({ current: world.backend, backends: await Promise.all(BACKEND_NAMES.map(n => stack.selfTest(n))) });

  if (m === "POST" && NO_INPUT.includes(p)) {
    const unwanted = url.search ? "this action takes no input" : await unwantedBody(req);
    if (unwanted) return bad(unwanted);
    if (p === "/tokens/revoke-all") { world.store.revokeAllTokens(); return status(); }
    if (p === "/proxy/flush") { world.proxy.flushDecisions(); return status(); }
    const { proxyTold } = await world.rotateSigningKey();
    return json({ ...settingsStatus(stack, world), rotation: { proxyTold } });
  }

  if (!WITH_INPUT.includes(p) || m !== "POST") return new Response("not found", { status: 404 });
  if (url.search) return bad("this request takes its input in the body");
  const b = await readJson(req);
  if (b === undefined || b === null || typeof b !== "object" || Array.isArray(b)) return bad("the request body must be a JSON object");
  const only = (...allowed: string[]) => { const extra = extraField(b, allowed); return extra ? bad(extra) : undefined; };

  if (p === "/reset") {
    const extra = only("confirm"); if (extra) return extra;
    if (b.confirm !== true) return bad("resetting policy needs confirm: true");
    await world.resetPolicy();
    return status();
  }
  if (p === "/clock") {
    if (b.reset === true) { const extra = only("reset"); if (extra) return extra; world.clock.reset(); return status(); }
    if (extraField(b, ["advanceSeconds"]) || !CLOCK_CHOICES.some(c => c.value === b.advanceSeconds)) return bad(`send reset: true, or advanceSeconds, one of ${values(CLOCK_CHOICES)}`);
    world.clock.advance(b.advanceSeconds);
    return status();
  }
  if (p === "/topology") {
    const extra = only("topology"); if (extra) return extra;
    if (!world.scope) return bad("only a sandbox can change this");
    if (b.topology !== "separate" && b.topology !== "unified") return bad("topology must be separate or unified");
    world.setTopology(b.topology);
    return status();
  }
  const extra = only("backend"); if (extra) return extra;
  if (!BACKEND_NAMES.includes(b.backend)) return bad(`backend must be one of ${BACKEND_NAMES.join(", ")}`);
  world.setBackend(b.backend);
  return status();
}
