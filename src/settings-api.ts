// A sandbox's own API: what the settings menu uses, for the sandbox a page is in: the backend images come from, the demo clock,
// resetting policy, and ending access. The demo has no login: every service binds to 127.0.0.1 and the
// tailnet address, and a request naming another Host, or a write from another web origin, is refused.
// Every write takes a fixed choice from this file, and nothing else. At the root it acts on the one
// real policy database, and in a sandbox on that sandbox's. Policy changes go through the policy API.
import type { BackendName, Stack } from "./stack";
import type { Sandbox } from "./sandbox";
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

export function settingsStatus(stack: Stack, sandbox: Sandbox) {
  return {
    sandbox: sandbox.id ? { id: sandbox.id, base: sandbox.prefix } : null,
    name: sandbox.name ?? null,
    clock: { offsetSeconds: sandbox.clock.offset(), now: sandbox.clock.now() },
    clockChoices: CLOCK_CHOICES,
    storage: { current: sandbox.backend, names: BACKEND_NAMES },
    topology: { current: sandbox.topology, names: ["separate", "unified"] },
    catalog: { source: sandbox.catalogSource, ...sandbox.catalog.stats() },
    signing: { kid: sandbox.imaging.signingKid },
    proxy: { cachedDecisions: sandbox.proxy.cachedDecisions },
    faults: sandbox.faults(),
    appCheck: sandbox.appCheck ?? null,
    // Only the root's store is a file, and only the root sees how many sandboxes there are.
    ...(sandbox.id ? {} : { store: stack.store.info(), sandboxes: { live: stack.sandboxes.size } }),
  };
}

const NO_INPUT = ["/tokens/revoke-all", "/proxy/flush", "/signing-key/rotate"];
const WITH_INPUT = ["/reset", "/clock", "/faults"];
const NAME_LIMIT = 40;

export async function settingsApi(stack: Stack, sandbox: Sandbox, req: Request, url: URL): Promise<Response> {
  const p = url.pathname.slice("/api/sandbox".length);
  const m = req.method;
  const status = () => json(settingsStatus(stack, sandbox));
  const refused = m === "GET" ? refuseHost(req) : refuseWrite(req, url);
  if (refused) return refused;

  if (p === "" && m === "GET") return status();
  // What's on now, as POST /faults answers too, so a caller can tell.
  if (p === "/faults" && m === "GET") return json({ faults: sandbox.faults(), appCheck: sandbox.appCheck ?? null });
  if (p === "/storage" && m === "GET") return json({ current: sandbox.backend, stores: await Promise.all(BACKEND_NAMES.map(n => stack.selfTest(n))) });

  if (m === "POST" && NO_INPUT.includes(p)) {
    const unwanted = url.search ? "this action takes no input" : await unwantedBody(req);
    if (unwanted) return bad(unwanted);
    if (p === "/tokens/revoke-all") { sandbox.store.revokeAllTokens(); return status(); }
    if (p === "/proxy/flush") { sandbox.proxy.flushDecisions(); return status(); }
    const { proxyTold } = await sandbox.rotateSigningKey();
    return json({ ...settingsStatus(stack, sandbox), rotation: { proxyTold } });
  }

  if (!(p === "" && m === "PATCH") && !(WITH_INPUT.includes(p) && m === "POST")) return Response.json({ error: `no ${m} /api/sandbox${p}`, hint: "The management API's calls are listed in llms.txt, under Manage a sandbox." }, { status: 404 });
  if (url.search) return bad("this request takes its input in the body");
  const b = await readJson(req);
  if (b === undefined || b === null || typeof b !== "object" || Array.isArray(b)) return bad("the request body must be a JSON object");
  const only = (...allowed: string[]) => { const extra = extraField(b, allowed); return extra ? bad(extra) : undefined; };

  if (p === "/reset") {
    const extra = only("confirm"); if (extra) return extra;
    if (b.confirm !== true) return bad("resetting policy needs confirm: true");
    await sandbox.resetPolicy();
    return status();
  }
  // Faults a check injects, and clears: the Imaging Server's decision API down, the image store stopping partway through
  // a study, and what the guide lets any server do: small pages, a 503 with Retry-After first, Endpoints in every form.
  if (p === "/faults") {
    const extra = only("decisionOutage", "truncateAfter", "pageSize", "searchRetryAfter", "retrievalRetryAfter", "endpointForms"); if (extra) return extra;
    const upTo = (field: string, most: number, what: string) => b[field] !== undefined && b[field] !== null && !(Number.isInteger(b[field]) && b[field] > 0 && b[field] <= most) ? `${field} is ${what} from 1 to ${most}, or null` : undefined;
    const wrong = (b.decisionOutage !== undefined && typeof b.decisionOutage !== "boolean" ? "decisionOutage is true or false" : undefined)
      ?? (b.endpointForms !== undefined && typeof b.endpointForms !== "boolean" ? "endpointForms is true or false" : undefined)
      ?? upTo("truncateAfter", 10000, "a number of instances") ?? upTo("pageSize", 100, "a number of studies")
      ?? upTo("searchRetryAfter", 30, "a number of seconds") ?? upTo("retrievalRetryAfter", 30, "a number of seconds");
    if (wrong) return bad(wrong);
    // A run grades against what it staged, and puts back what was here before it, so nothing changes under it.
    if (sandbox.appCheck) return json({ error: "an app check is running in this sandbox: end it first, on its App check page" }, 409);
    sandbox.setFaults(b);
    return json({ faults: sandbox.faults(), appCheck: null });
  }
  if (p === "/clock") {
    if (b.reset === true) { const extra = only("reset"); if (extra) return extra; sandbox.clock.reset(); return status(); }
    if (extraField(b, ["advanceSeconds"]) || !CLOCK_CHOICES.some(c => c.value === b.advanceSeconds)) return bad(`send reset: true, or advanceSeconds, one of ${values(CLOCK_CHOICES)}`);
    sandbox.clock.advance(b.advanceSeconds);
    return status();
  }
  if (p === "") {
    const extra = only("name", "topology", "storage"); if (extra) return extra;
    if (b.name === undefined && b.topology === undefined && b.storage === undefined) return bad("send name, topology or storage");
    if ((b.name !== undefined || b.topology !== undefined) && !sandbox.id) return bad("only a sandbox can change this");
    if (b.name !== undefined && (typeof b.name !== "string" || !b.name.trim() || b.name.trim().length > NAME_LIMIT)) return bad(`a name is 1 to ${NAME_LIMIT} characters`);
    if (b.topology !== undefined && b.topology !== "separate" && b.topology !== "unified") return bad("topology must be separate or unified");
    if (b.storage !== undefined && !BACKEND_NAMES.includes(b.storage)) return bad(`storage must be one of ${BACKEND_NAMES.join(", ")}`);
    if (b.name !== undefined) sandbox.setName(b.name.trim());
    if (b.topology !== undefined) sandbox.setTopology(b.topology);
    if (b.storage !== undefined) sandbox.setBackend(b.storage);
    return status();
  }
  return Response.json({ error: `no ${m} /api/sandbox${p}`, hint: "The management API's calls are listed in llms.txt, under Manage a sandbox." }, { status: 404 });
}
