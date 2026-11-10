// A client of one sandbox, as Tours and its checks act in it: real sign-ins as an app, refresh, search and
// retrieval with the tokens this page holds, a service's own Backend Services token, and the sandbox's
// management API. Every request carries the page's trace session, and the trace it's part of, so the
// activity log shows what the page did, and how the proxy decided each retrieval.
const DEFAULT_SCOPE = "launch/patient patient/ImagingStudy.rs online_access";
const STORED_ANY = 'multipart/related; type="application/dicom"; transfer-syntax=*';
const hexOf = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, "0")).join("");

/** The parts of a multipart retrieval, read as they arrive: each one's transfer syntax, whether it closed, and whether it broke off. */
async function readParts(res) {
  const boundary = res.headers.get("content-type")?.match(/boundary="?([^";]+)/)?.[1];
  if (!res.ok || !boundary || !res.body) { await res.body?.cancel(); return { parts: [], complete: false, failed: false }; }
  const delimiter = new TextEncoder().encode(`--${boundary}`), blank = [13, 10, 13, 10];
  const find = (hay, needle, from) => { outer: for (let i = from; i + needle.length <= hay.length; i++) { for (let k = 0; k < needle.length; k++) if (hay[i + k] !== needle[k]) continue outer; return i; } return -1; };
  const parts = [], reader = res.body.getReader();
  let buf = new Uint8Array(0), complete = false, failed = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) { const b = new Uint8Array(buf.length + value.length); b.set(buf); b.set(value, buf.length); buf = b; }
      // Each delimiter is the closing one, with "--", or starts a part, whose headers end at a blank line.
      for (;;) {
        const at = find(buf, delimiter, 0);
        if (at < 0) { buf = buf.slice(Math.max(0, buf.length - delimiter.length - 4)); break; }
        const after = at + delimiter.length;
        if (buf.length < after + 2) { buf = buf.slice(at); break; }
        if (buf[after] === 45 && buf[after + 1] === 45) { complete = true; buf = new Uint8Array(0); break; }
        const end = find(buf, blank, after);
        if (end < 0) { buf = buf.slice(at); break; }
        parts.push({ syntax: new TextDecoder().decode(buf.subarray(after, end)).match(/transfer-syntax=([^;\s]+)/i)?.[1] });
        buf = buf.slice(end + 4);
      }
      if (done) break;
    }
  } catch { failed = true; }
  return { parts, complete, failed };
}

function sandboxClient(base, session) {
  const fhirBase = `${location.origin}${base}/fhir`, tokens = {}, refreshTokens = {}, services = {};
  let discovered;
  const headersFor = trace => ({ traceparent: `00-${trace}-${hexOf(8)}-01`, baggage: `demo.session=${encodeURIComponent(session)}` });
  const discovery = () => discovered ??= fetch(`${fhirBase}/.well-known/smart-configuration`).then(r => r.json()).catch(e => { discovered = undefined; throw e; });
  const imaging = async (capability = APP_LAUNCH) => imagingOf(await discovery(), fhirBase, capability)?.url;
  const formAction = (html, at) => { const f = new DOMParser().parseFromString(html, "text/html").querySelector("form[action]"); if (!f) throw new Error("The sign-in page had no form."); return new URL(f.getAttribute("action"), at).toString(); };
  const postForm = (url, form) => fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString() });
  /**
   * A person signs in and approves, on the Authorization Server's own pages: walked here as a browser would,
   * or by the person in the window `popup`. Gives where it redirected back to.
   */
  async function authorize(url, o) {
    const back = u => u.startsWith(o.redirectUri);
    // Only the redirect for this sign-in, by its state, ends the wait: any other window's message is ignored.
    const ours = u => back(u) && new URL(u).searchParams.get("state") === o.state;
    if (o.popup) {
      o.popup.location = url;
      return new Promise((done, fail) => {
        const closed = setInterval(() => { if (o.popup.closed) { clearInterval(closed); removeEventListener("message", heard); fail(new Error("The sign-in window closed before it finished.")); } }, 400);
        function heard(e) { if (e.origin !== location.origin || typeof e.data?.signedIn !== "string" || !ours(e.data.signedIn)) return; clearInterval(closed); removeEventListener("message", heard); done(new URL(e.data.signedIn)); }
        addEventListener("message", heard);
      });
    }
    let r = await fetch(url);
    if (back(r.url)) return new URL(r.url);
    r = await postForm(formAction(await r.text(), r.url), new URLSearchParams({ username: o.user }));
    if (back(r.url)) return new URL(r.url);
    const form = new URLSearchParams({ decision: o.approve === false ? "deny" : "approve", ...(o.patient ? { patient: o.patient } : {}) });
    if (o.sites) { form.set("sites_shown", "1"); for (const site of o.sites) form.append("sites", site); }
    r = await postForm(formAction(await r.text(), r.url), form);
    if (!back(r.url)) throw new Error(`The sign-in didn't come back to the app (HTTP ${r.status}).`);
    return new URL(r.url);
  }
  /** The authorization code flow with PKCE, as `app`: discovery, sign-in and approval, then the code for a token. */
  async function signIn(o, trace) {
    o = { app: "portal-app", redirectUri: `${location.origin}${base}/oauth/callback`, scope: DEFAULT_SCOPE, aud: fhirBase, ...o };
    const config = await discovery(), headers = headersFor(trace);
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32))), state = b64url(crypto.getRandomValues(new Uint8Array(16)));
    const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
    // A redirect can't carry trace headers, so the demo's own fields name the session, as the server's flows do.
    const q = new URLSearchParams({ response_type: "code", client_id: o.app, redirect_uri: o.redirectUri, scope: o.scope, state, aud: o.aud, code_challenge: challenge, code_challenge_method: "S256", login_hint: o.user, ...(o.patient ? { demo_patient: o.patient } : {}), demo_traceparent: headers.traceparent, demo_session: session });
    const back = await authorize(`${config.authorization_endpoint}?${q}`, { ...o, state });
    if (back.searchParams.get("state") !== state) return { token: false, error: "state_mismatch" };
    const code = back.searchParams.get("code");
    if (!code) return { token: false, error: back.searchParams.get("error") ?? "no code", state };
    const r = await fetch(config.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: o.redirectUri, client_id: o.app, code_verifier: verifier }) });
    const t = await r.json().catch(() => ({}));
    if (!t.access_token) return { token: false, error: t.error ?? `HTTP ${r.status}`, state };
    tokens[o.user] = t.access_token;
    if (t.refresh_token) refreshTokens[o.user] = t.refresh_token;
    return { token: true, accessToken: t.access_token, patient: t.patient, expiresIn: t.expires_in, state };
  }
  /** A new access token from the person's refresh token. */
  async function refresh(user, trace, app = "portal-app") {
    const config = await discovery();
    const r = await fetch(config.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headersFor(trace) }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshTokens[user], client_id: app }) });
    const t = await r.json().catch(() => ({}));
    if (t.refresh_token) refreshTokens[user] = t.refresh_token;
    return t.access_token;
  }
  /** One page of a search: its status, Bundle, and next link. */
  async function searchPage(token, url, trace) {
    const r = await patientFetch(url, { headers: { ...fhirHeaders(token), ...headersFor(trace) } });
    const body = await r.json().catch(() => undefined);
    return { status: r.status, body, next: body?.link?.find(l => l.relation === "next")?.url };
  }
  /** A search, every page of it: the studies it found, each with its WADO-RS address, or the refusal. */
  async function search(token, query, trace, capability) {
    let refused;
    const { entries } = await searchAll(`${await imaging(capability)}/ImagingStudy?${query}`, async url => {
      const p = await searchPage(token, url, trace);
      if (p.status !== 200) { refused = p.status; return {}; }
      return p.body;
    });
    return refused ? { status: refused, studies: [] } : { status: 200, studies: studiesFrom(entries).map(st => ({ id: st.id, uid: st.uid, base: st.address, resource: st })) };
  }
  /** A retrieval with a token, or none, read to the end. With `retry` false, a 503 is the answer, not a reason to wait. */
  async function retrieve(token, url, trace, accept = STORED_ANY, retry = true) {
    const init = { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(accept === null ? {} : { accept }), ...headersFor(trace) } };
    const r = retry ? await patientFetch(url, init) : await fetch(url, init);
    return { status: r.status, ...(await readParts(r)) };
  }
  /** How the proxy decided the last retrieval in a trace, from the activity log: by the signed link alone, a cached decision, or by asking. */
  async function decided(trace) {
    const { events } = await (await fetch(`${base}/api/activity?${new URLSearchParams({ trace, limit: "200" })}`)).json();
    return events.filter(e => (e.kind === "stream.done" || e.kind === "retrieval.answered") && e.data.authz).at(-1)?.data.authz;
  }
  /** A service's own token: SMART Backend Services, signed with its key. */
  const serviceToken = (client, trace) => services[client] ??= (async () => {
    const keys = await keysOf(base), mine = keys.services.find(x => x.client_id === client);
    return (await backendToken(mine, keys.tokenEndpoint, { scope: mine.scope }, keys.now, headersFor(trace))).access_token;
  })();
  /** A call to the sandbox's management API, in this trace. */
  const manage = (method, path, body, trace) => api(method, path, body, base, trace ? headersFor(trace) : {});
  return { base, session, fhirBase, tokens, discovery, imaging, signIn, refresh, searchPage, search, retrieve, decided, serviceToken, manage, headersFor };
}
