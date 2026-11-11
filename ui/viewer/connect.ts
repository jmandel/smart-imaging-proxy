// Connecting: a standalone SMART App Launch with PKCE, in a tab of its own, or as a backend service with a
// signed assertion and no one signing in. Each request is a step on the trail.
import { subtle } from "../lib/api";
import { ASSERTION_TYPE, b64url, signAssertion } from "../lib/api";
import { BACKEND_CAPABILITY, imagingOf, VIEWER_URL, type ServerEntry } from "../lib/servers";
import { viewerKeeper, type Keeper, type Session } from "./session";
import { requestLine, type Trail } from "./trail";

/** The scopes asked for when an entry names none: a sign-in's, and a backend service's. */
export const SCOPE = "launch/patient patient/*.rs", BACKEND_SCOPE = "system/ImagingStudy.rs";
const NO_LAUNCH = "This server doesn't advertise SMART Imaging with App Launch. If you know where its imaging FHIR server is, add it under Advanced in Build a Server.";
const random = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
/**
 * How a connection is made. `keeper` is where it saves its state (the viewer's tab, unless given), `config`
 * a discovery already read, so it isn't asked for again, and `assertion` signs the client's assertion for a
 * token endpoint when the key isn't in the entry, as when it stays on the server with an agent's run.
 */
export interface ConnectOptions { keeper?: Keeper; config?: any; assertion?: (tokenEndpoint: string) => Promise<string> }
const tokenFacts = (t: any) => ({ Granted: t.scope, "Token lasts": `${Math.round(t.expires_in / 60)} min` });

function discover(trail: Trail, iss: string) {
  return trail.traced({ id: "discover", kind: "discover", title: "Discover the servers" }, `${iss}/.well-known/smart-configuration`, {}, c => {
    const found = imagingOf(c, iss);
    return { "Sign-in": new URL(c.authorization_endpoint).host, "Imaging server": found ? `${new URL(found.url).host}${found.unified ? " (this server)" : ""}` : "None advertised" };
  });
}

/** The sign-in address for a server, after checking it can be used. What the token exchange needs is kept for it. */
export async function signInAddress(trail: Trail, server: ServerEntry, { keeper = viewerKeeper, config: read }: ConnectOptions = {}): Promise<{ url: URL; state: string }> {
  const { iss, clientId } = server, scope = server.scope ?? SCOPE;
  if (!read) trail.clear();
  const config = read ?? await discover(trail, iss);
  if (config.code_challenge_methods_supported && !config.code_challenge_methods_supported.includes("S256")) throw new Error("This server doesn't offer PKCE with S256.");
  // Nobody signs in to a server this app can't use.
  if (!imagingOf(config, iss) && !server.imaging) throw new Error(NO_LAUNCH);
  const verifier = random(), state = random();
  const challenge = b64url(new Uint8Array(await subtle().digest("SHA-256", new TextEncoder().encode(verifier))));
  keeper.save({ pending: { verifier, state, config, iss, clientId, imaging: server.imaging, label: server.label, jwk: server.jwk } });
  const url = new URL(config.authorization_endpoint);
  Object.entries({ response_type: "code", client_id: clientId, redirect_uri: VIEWER_URL, scope, aud: iss, state, code_challenge: challenge, code_challenge_method: "S256" }).forEach(([k, v]) => url.searchParams.set(k, v));
  trail.add({ id: "authorize", kind: "authorize", title: "Sign in and approve the app", request: requestLine("GET", url.toString().replace(/([?&](state|code_challenge)=)[^&]+/g, "$1…")), response: "The sign-in tab returned with a one-time code." });
  return { url, state };
}

/**
 * Where the sign-in comes back: the redirect page posts its address to this tab, which opened it. Only the
 * address carrying this sign-in's state ends the wait.
 */
export function signInReturn(tab: Window, state: string): Promise<URLSearchParams> {
  return new Promise((done, fail) => {
    const closed = setInterval(() => { if (tab.closed) { clearInterval(closed); removeEventListener("message", heard); fail(new Error("The sign-in tab closed before it finished. Connect again.")); } }, 500);
    function heard(e: MessageEvent) {
      const back = e.origin === location.origin && typeof e.data?.signedIn === "string" && e.data.signedIn.startsWith(VIEWER_URL) ? new URL(e.data.signedIn) : undefined;
      if (!back || back.searchParams.get("state") !== state) return;
      clearInterval(closed); removeEventListener("message", heard); done(back.searchParams);
    }
    addEventListener("message", heard);
  });
}

/** The code exchanged for a token, signed with the client's key when it has one. */
export async function finishSignIn(trail: Trail, params: URLSearchParams, { keeper = viewerKeeper, assertion }: ConnectOptions = {}): Promise<Session> {
  const { pending } = keeper.saved();
  if (!pending || pending.state !== params.get("state")) throw new Error("This sign-in didn't start here. Connect again.");
  keeper.save({ pending: undefined });
  const error = params.get("error");
  if (error) { trail.add({ id: "authorize", kind: "authorize", title: "Sign in and approve the app", failed: true, response: error }); throw new Error(`The sign-in ended with: ${error}`); }
  const sign = assertion ?? (pending.jwk && ((aud: string) => signAssertion(pending.jwk!, pending.clientId, aud)));
  const signed: Record<string, string> = sign ? { client_assertion_type: ASSERTION_TYPE, client_assertion: await sign(pending.config.token_endpoint) } : {};
  const body = new URLSearchParams({ grant_type: "authorization_code", code: params.get("code") ?? "", redirect_uri: VIEWER_URL, client_id: pending.clientId, code_verifier: pending.verifier, ...signed }).toString();
  const token = await trail.traced({ id: "token", kind: "token", title: "Exchange the code for a token" }, pending.config.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body }, tokenFacts);
  const imaging = imagingOf(pending.config, pending.iss)?.url ?? pending.imaging;
  if (!imaging) throw new Error(NO_LAUNCH);
  if (!token.patient) throw new Error("The token response didn't name a patient.");
  const session: Session = { token: token.access_token, patient: token.patient, imaging, iss: pending.iss, label: pending.label };
  keeper.save({ session });
  return session;
}

/** A backend service: no one signs in. It proves its identity, gets a token, and names the patient itself. */
export async function connectBackend(trail: Trail, server: ServerEntry, { keeper = viewerKeeper, config: read, assertion }: ConnectOptions = {}): Promise<Session> {
  if (!read) trail.clear();
  const config = read ?? await discover(trail, server.iss);
  const imaging = imagingOf(config, server.iss, BACKEND_CAPABILITY)?.url ?? server.imaging;
  if (!imaging) throw new Error("This server doesn't advertise SMART Imaging for Backend Services.");
  const scope = server.scope ?? BACKEND_SCOPE;
  const signed = assertion ? await assertion(config.token_endpoint) : await signAssertion(server.jwk!, server.clientId, config.token_endpoint);
  const body = new URLSearchParams({ grant_type: "client_credentials", scope, client_assertion_type: ASSERTION_TYPE, client_assertion: signed }).toString();
  const token = await trail.traced({ id: "backend-token", kind: "backend-token", title: "Authenticate and get a token" }, config.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body }, tokenFacts);
  const session: Session = { token: token.access_token, patient: server.patient!, imaging: imaging.replace(/\/$/, ""), iss: server.iss, label: server.label, backend: true };
  keeper.save({ session });
  return session;
}
