// JSON endpoints behind the admin screen. The demo has no admin login: every service binds to
// 127.0.0.1 and the tailnet address, and writes naming another Host or web origin are refused. Every
// write takes a fixed choice from this file or from rule-presets.ts, and nothing else. A store action
// applies to the active store unless it names one.
import type { BackendName, Stack } from "./stack";
import { PolicyValidationError, type Settings } from "./policy-store";
import { matchRuleSet, RULE_SETS, ruleSetById } from "./rule-presets";
import { advance, clockOffset, now, resetClock } from "./clock";
import { PORTS, TAILNET } from "./config";

export const BACKEND_NAMES: BackendName[] = ["static-files", "minio", "orthanc"];

export interface Choice { value: number; label: string; }
const MINUTE = 60, HOUR = 3600, DAY = 86400;
export const SETTING_CHOICES: Record<keyof Settings, Choice[]> = {
  contextLifetimeSeconds: [{ value: MINUTE, label: "1 minute" }, { value: 5 * MINUTE, label: "5 minutes" }, { value: 30 * MINUTE, label: "30 minutes" }],
  maxSeriesInContext: [{ value: 0, label: "0: partial releases always ask" }, { value: 12, label: "12" }, { value: 100, label: "100" }],
  tokenLifetimeSeconds: [{ value: 5 * MINUTE, label: "5 minutes" }, { value: HOUR, label: "1 hour" }, { value: DAY, label: "1 day" }],
  refreshTokenLifetimeSeconds: [{ value: DAY, label: "1 day" }, { value: 7 * DAY, label: "7 days" }, { value: 30 * DAY, label: "30 days" }],
};
export const CLOCK_CHOICES: Choice[] = [{ value: MINUTE, label: "1 minute" }, { value: 5 * MINUTE, label: "5 minutes" }, { value: HOUR, label: "1 hour" }, { value: DAY, label: "1 day" }];
const isChoice = (choices: Choice[], v: unknown) => choices.some(c => c.value === v);
const values = (choices: Choice[]) => choices.map(c => c.value).join(", ");

const json = (b: unknown, status = 200) => Response.json(b, { status });
const bad = (error: string, errors?: string[]) => json({ error, ...(errors ? { errors } : {}) }, 400);

/** The parsed body, or undefined when it isn't JSON. */
export const readJson = async (req: Request): Promise<any> => req.json().catch(() => undefined);
/** The message for a body holding any field but these. */
export const extraField = (b: Record<string, unknown>, allowed: string[]) =>
  Object.keys(b).some(k => !allowed.includes(k)) ? `this request accepts only ${allowed.join(", ")}` : undefined;
/** The message for a request with a body, when it takes none. */
const unwantedBody = async (req: Request) => ["", "{}"].includes((await req.text()).trim()) ? undefined : "this action takes no input";
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

/** Every named set as the catalog in use resolves it, and the one the active store's rules are. */
function ruleSetStatus(stack: Stack, rules: Parameters<typeof matchRuleSet>[0]) {
  return {
    current: matchRuleSet(rules, [stack.catalogs.archive, stack.catalogs.orthanc])?.id ?? null,
    choices: RULE_SETS.map(set => ({ id: set.id, label: set.label, description: set.description, rules: set.rules(stack.catalog) ?? null })),
  };
}

export function adminStatus(stack: Stack) {
  const { stores } = stack;
  const policy = stores.active.getPolicy();
  return {
    store: { active: stores.activeName, label: stores.activeLabel, saved: stores.saved.info(), scratch: stores.scratch.info() },
    policy: { rules: policy.rules, delegations: policy.delegations, appGrants: policy.appGrants },
    settings: stores.active.getSettings(),
    settingChoices: SETTING_CHOICES,
    clockChoices: CLOCK_CHOICES,
    ruleSets: ruleSetStatus(stack, policy.rules),
    clock: { offsetSeconds: clockOffset(), now: now() },
    backend: { current: stack.backend, names: BACKEND_NAMES },
    catalog: { source: stack.catalogSource, ...stack.catalog.stats() },
    signing: { kid: stack.imaging.signingKid },
    proxy: { cachedDecisions: stack.proxy.cachedDecisions },
    outage: stack.imaging.outage,
  };
}

/** The query fields each delete needs to identify one row. */
const DELETE_FIELDS: Record<string, string[]> = { "/delegations": ["patient", "delegate"], "/app-grants": ["client", "user", "patient"] };
const NO_INPUT = ["/store/reset-scratch", "/tokens/revoke-all", "/proxy/flush", "/signing-key/rotate"];
const WITH_INPUT: Record<string, string> = { "/store/activate": "POST", "/store/reset-saved": "POST", "/rule-set": "POST", "/settings": "PUT", "/clock": "POST", "/backend": "POST", "/outage": "POST" };

export async function adminApi(stack: Stack, req: Request, url: URL, hooks: { forgetFlow: () => void }): Promise<Response> {
  const p = url.pathname.slice("/api/admin".length);
  const m = req.method;
  const status = () => json(adminStatus(stack));
  if (m !== "GET") { const refused = refuseWrite(req, url); if (refused) return refused; }

  if (p === "/status" && m === "GET") return status();
  if (p === "/backends" && m === "GET") return json({ current: stack.backend, backends: await Promise.all(BACKEND_NAMES.map(n => stack.selfTest(n))) });

  if (m === "DELETE" && Object.hasOwn(DELETE_FIELDS, p)) {
    const fields = DELETE_FIELDS[p]!;
    const given = [...url.searchParams.keys()];
    if (given.length !== fields.length || !fields.every(f => url.searchParams.get(f)) || new Set(given).size !== given.length) return bad(`${fields.join(", ")} are required, and nothing else`);
    const unwanted = await unwantedBody(req);
    if (unwanted) return bad(unwanted);
    const q = (f: string) => url.searchParams.get(f)!;
    if (p === "/delegations") {
      if (!stack.stores.active.removeDelegations({ patient: q("patient"), delegate: q("delegate") })) return json({ error: "no such delegation" }, 404);
    } else if (!stack.stores.active.removeAppGrants({ client: q("client"), user: q("user"), patient: q("patient") })) return json({ error: "no such app grant" }, 404);
    return status();
  }

  if (m === "POST" && NO_INPUT.includes(p)) {
    const unwanted = url.search ? "this action takes no input" : await unwantedBody(req);
    if (unwanted) return bad(unwanted);
    if (p === "/store/reset-scratch") {
      stack.resetScratch();
      hooks.forgetFlow();
      return status();
    }
    if (p === "/tokens/revoke-all") {
      stack.stores.active.revokeAllTokens();
      return status();
    }
    if (p === "/proxy/flush") {
      stack.proxy.flushDecisions();
      return status();
    }
    const { proxyTold } = await stack.rotateSigningKey();
    return json({ ...adminStatus(stack), rotation: { proxyTold } });
  }

  if (!Object.hasOwn(WITH_INPUT, p) || WITH_INPUT[p] !== m) return new Response("not found", { status: 404 });
  if (url.search) return bad("this request takes its input in the body");
  const b = await readJson(req);
  if (b === undefined || b === null || typeof b !== "object" || Array.isArray(b)) return bad("the request body must be a JSON object");
  const only = (...allowed: string[]) => { const extra = extraField(b, allowed); return extra ? bad(extra) : undefined; };

  try {
    if (p === "/store/activate") {
      const extra = only("store"); if (extra) return extra;
      if (b.store !== "saved" && b.store !== "scratch") return bad('store must be "saved" or "scratch"');
      stack.useStore(b.store);
      return status();
    }
    if (p === "/store/reset-saved") {
      const extra = only("confirm"); if (extra) return extra;
      if (b.confirm !== true) return bad("resetting saved policy needs confirm: true");
      stack.resetSaved();
      return status();
    }
    if (p === "/rule-set") {
      const extra = only("id"); if (extra) return extra;
      const set = ruleSetById(b.id);
      if (!set) return bad(`id must be one of ${RULE_SETS.map(s => s.id).join(", ")}`);
      const rules = set.rules(stack.catalog);
      if (!rules) return json({ error: `the catalog for ${stack.backend} doesn't hold what "${set.label}" names` }, 409);
      stack.imaging.setPolicy({ rules });
      return status();
    }
    if (p === "/settings") {
      const extra = only(...Object.keys(SETTING_CHOICES)); if (extra) return extra;
      if (!Object.keys(b).length) return bad("choose at least one setting");
      const errors = Object.entries(b).flatMap(([k, v]) => { const choices = SETTING_CHOICES[k as keyof Settings]; return isChoice(choices, v) ? [] : [`${k} must be one of ${values(choices)}`]; });
      if (errors.length) return bad(errors.join("; "), errors);
      stack.stores.active.setSettings(b);
      return status();
    }
    if (p === "/clock") {
      if (b.reset === true) { const extra = only("reset"); if (extra) return extra; resetClock(); return status(); }
      if (extraField(b, ["advanceSeconds"]) || !isChoice(CLOCK_CHOICES, b.advanceSeconds)) return bad(`send reset: true, or advanceSeconds, one of ${values(CLOCK_CHOICES)}`);
      advance(b.advanceSeconds);
      return status();
    }
    if (p === "/backend") {
      const extra = only("backend"); if (extra) return extra;
      if (!BACKEND_NAMES.includes(b.backend)) return bad(`backend must be one of ${BACKEND_NAMES.join(", ")}`);
      stack.setBackend(b.backend);
      return status();
    }
    if (p === "/outage") {
      const extra = only("on"); if (extra) return extra;
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
