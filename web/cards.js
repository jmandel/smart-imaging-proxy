// One card per kind of recorded event: a one-line summary, the fields that matter, links through the
// values events share, and a drill-in to the raw exchange. Cards render from recorded events only.
const Cards = (() => {
  let names = {}, traceUrl = "", session = "";
  const nameOf = who => { if (!who) return ""; const id = who.slice(who.indexOf(":") + 1); return names[who] ?? names[id] ?? id; };
  const short = v => String(v ?? "");
  const time = at => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const listOf = xs => xs.length ? xs.join(", ") : "none";
  const SERVICE = { "authorization-server": "Authorization Server", "imaging-fhir": "Imaging Server", policy: "Imaging Server, policy", "dicomweb-proxy": "Proxy", app: "The app", demo: "Demo", user: "Browser" };

  /** Each kind's summary and fields. */
  const KINDS = {
    "token.issued": e => ({ summary: `Token issued${e.data.user ? ` to ${nameOf(`user:${e.data.user}`)}` : ` to ${nameOf(`client:${e.data.client}`)}`}${e.data.patient ? `, for ${nameOf(`patient:${e.data.patient}`)}` : ""}`,
      fields: [["How", e.data.grant?.replaceAll("_", " ")], ["Client", e.data.client], ["Scope", e.data.scope], ["Lasts", e.data.expiresIn && `${Math.round(e.data.expiresIn / 60)} minutes`], ["Token", e.data.tokenHash && `sha256:${e.data.tokenHash}…`]] }),
    "referral.checked": e => ({ summary: e.data.ok ? "The referral's patient is on the FHIR server the service may use" : "The referral's patient isn't on the FHIR server the service may use",
      fields: [["Patient", e.data.reference], ["Authorized for", e.data.authorizedBase], ["Accession", e.data.accession && `${e.data.system}|${e.data.accession}`]] }),
    "search.returned": e => e.data.status === 200
      ? { summary: `Search returned ${plural(e.data.total ?? 0, "study", "studies")}${e.data.withheld?.length ? `, with ${e.data.withheld.length} withheld` : ""}`,
          fields: [["Query", e.data.query], ["Found", listOf(e.data.found ?? [])], ...(e.data.withheld ?? []).map(w => [`Withheld ${w.study}`, w.why])] }
      : { summary: `Search answered ${e.data.status}`, fields: [["Why", e.data.reason], ["Query", e.data.query]] },
    "context.signed": e => ({ summary: `Signed link made for ${e.data.study}`, fields: [["Form", e.data.form], ["Series listed", e.data.series], ["Expires", e.data.exp && new Date(e.data.exp * 1000).toLocaleTimeString()], ["Key", e.data.kid]] }),
    "decision.answered": e => ({ summary: `The Imaging Server ${e.data.decision ? "allowed" : "refused"} ${e.data.study ?? e.data.studyUid ?? "the request"}`,
      fields: [["Why", e.data.why], ["Release", typeof e.data.response?.context?.release === "object" ? `${e.data.response.context.release.series.length} series` : e.data.response?.context?.release], ["Denial", e.data.response?.context?.denial], ["Good for", e.data.response?.context?.max_age_seconds !== undefined && `${e.data.response.context.max_age_seconds} s`]] }),
    "proxy.fast-path": e => ({ summary: e.data.taken ? "The proxy checked the signed link, with no network call" : `No fast path: ${e.data.failed ?? "the link didn't cover it"}`, fields: [["Study", e.data.studyUid]] }),
    "proxy.decision": e => ({ summary: `The proxy ${e.data.via === "cached" ? "used a cached decision" : "asked the Imaging Server"}: ${e.data.unavailable ? "no answer" : e.data.allowed ? "allowed" : "refused"}`, fields: [["Denial", e.data.denial], ["Study", e.data.studyUid]] }),
    "stream.done": e => ({ summary: `${plural(e.data.parts, "part")} streamed, ${bytes(e.data.bytes)}${e.data.encoding === "zstd" ? ", zstd passed through" : ""}${e.data.complete ? "" : ", cut off"}`,
      fields: [["What", e.data.resource], ["Decided", e.data.authz], ["Syntaxes", (e.data.syntaxes ?? []).join(", ")], ["Note", e.data.note]] }),
    "retrieval.answered": e => ({ summary: `Retrieval answered ${e.data.status}`, fields: [["What", e.data.resource], ["Decided", e.data.authz], ["Denial", e.data.denial], ["Note", e.data.note]] }),
    "policy.written": e => { const w = written(e.data); return { summary: `${e.data.status < 300 ? "" : "Refused: "}${w.what}`, fields: [["Who", w.who], ["Sites", w.sites], ["Patient", e.data.patient && nameOf(`patient:${e.data.patient}`)], ["Level", LEVEL_WORDS[e.data.level] ?? e.data.level], ["Why", e.data.error], ["Call", e.data.operation]], raw: e.data.body ?? e.data.query }; },
  };
  const LEVEL_WORDS = { fact: "A fact", policy: "Organization policy", choice: "A person's choice", settings: "Settings", document: "The whole document", reset: "A reset" };
  const sitesOf = sites => Array.isArray(sites) ? (sites.length ? sites.join(", ") : "no sites") : undefined;
  /** A policy write in words: who did what, and at which sites. */
  function written(d) {
    const b = d.body ?? {}, q = d.query ?? {}, op = d.operation ?? "";
    const whose = p => p ? `${nameOf(p)}'s records` : "records";
    if (op === "POST /shares") return { who: nameOf(b.from), what: `${nameOf(b.from)} shares ${whose(b.patient)} with ${nameOf(b.with)}${b.label ? `, as ${b.label}` : ""}`, sites: sitesOf(b.sites) };
    if (op === "DELETE /shares") return { who: q.from ? nameOf(q.from) : undefined, what: `${q.from ? nameOf(q.from) : "Everyone"} stops sharing ${q.patient ? `${whose(q.patient)} ` : ""}with ${nameOf(q.with)}` };
    if (op === "POST /app-approvals") return { who: nameOf(b.by), what: `${nameOf(b.by)} approves ${nameOf(b.app)} for ${whose(b.patient)}`, sites: b.sites ? sitesOf(b.sites) : "Every site, or the sites chosen before" };
    if (op === "DELETE /app-approvals") return { who: nameOf(q.by), what: `${nameOf(q.by)} revokes ${nameOf(q.app)}${q.patient ? ` for ${whose(q.patient)}` : ""}` };
    if (op === "PUT /relationships") return { what: `Recorded: ${nameOf(b.subject)} ${String(b.relation ?? "").replaceAll("_", " ")} ${nameOf(b.object)}` };
    if (op === "DELETE /relationships") return { what: `Removed: ${nameOf(q.subject)} ${String(q.relation ?? "").replaceAll("_", " ")} ${nameOf(q.object)}` };
    if (op.startsWith("PUT /policies")) return { what: Array.isArray(b) ? `Organization policies of type ${q.type ?? "?"} set: ${b.map(x => x.id).join(", ") || "none"}` : `Organization policy ${b.id ?? op.slice("PUT /policies/".length)} set`, sites: sitesOf(b.allow?.sites) };
    if (op.startsWith("DELETE /policies/")) return { what: `Organization policy ${op.slice("DELETE /policies/".length)} removed` };
    if (op === "PATCH /settings") return { what: `Settings changed: ${Object.keys(b).join(", ")}` };
    if (op === "POST /reset") return { what: b.tokens ? "Policy reset, with tokens" : "Policy reset" };
    if (op === "PUT /document") return { what: `Policy document written: ${Object.keys(b).join(", ")}` };
    return { what: `Policy written: ${op}` };
  }
  const LINK_WORDS = { token: "token", context: "link", study: "study", uid: "study UID", patient: "patient", user: "person", client: "service" };

  function card(e) {
    const k = (KINDS[e.kind] ?? (x => ({ summary: x.kind, fields: Object.entries(x.data).map(([a, b]) => [a, typeof b === "object" ? JSON.stringify(b) : b]) })))(e);
    const fields = k.fields.filter(([, v]) => v !== undefined && v !== null && v !== false && v !== "");
    // A search's found list is in its fields: its links keep to the token, the patient and the person.
    const studies = e.links.filter(l => l.startsWith("study:"));
    const links = e.links.filter(l => !l.startsWith("uid:") && (studies.length < 2 || !l.startsWith("study:")));
    return `<li class="card ${esc(e.outcome)}" data-kind="${esc(e.kind)}" data-seq="${esc(e.seq)}">
      <div class="line"><span class="summary">${esc(k.summary)}</span><span class="who-said">${esc(SERVICE[e.service] ?? e.service)}</span><span class="when">${esc(time(e.at))}</span></div>
      ${fields.length ? `<dl>${fields.map(([a, b]) => `<dt>${esc(a)}</dt><dd>${esc(short(b))}</dd>`).join("")}</dl>` : ""}
      ${links.length ? `<div class="links">${links.map(l => { const [kind, v] = [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1)]; return `<a href="${esc(`${BASE}/activity?${session ? `session=${encodeURIComponent(session)}&` : ""}link=${encodeURIComponent(l)}`)}" title="Every event with this ${esc(LINK_WORDS[kind] ?? kind)}">${esc(LINK_WORDS[kind] ?? kind)} ${esc(kind === "user" || kind === "client" ? nameOf(l) : v)}</a>`; }).join("")}</div>` : ""}
      ${e.span ? `<details data-session="${esc(e.session)}" data-span="${esc(e.span)}"><summary>The exchange</summary><div class="raw"><p class="note">Loading…</p></div></details>` : k.raw !== undefined ? `<details><summary>As recorded</summary><div class="raw"><pre>${esc(JSON.stringify(k.raw, null, 2))}</pre></div></details>` : ""}
    </li>`;
  }

  // Decoding the raw exchange: JWTs and signed contexts, bundles, multipart parts. Secrets arrive as hashes already.
  const b64json = part => { try { return JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/"))); } catch { return undefined; } };
  const jwt = v => { const [h, p] = String(v).split("."); const a = b64json(h ?? ""), b = b64json(p ?? ""); return a && b ? { header: a, claims: b } : undefined; };
  function bodyHtml(m) {
    if (!m) return `<p class="note">Nothing captured.</p>`;
    if (!m.body) return `<p class="note">${m.bytes ? `${esc(bytes(m.bytes))}, not captured` : "No body"}.</p>`;
    const type = m.headers?.["content-type"] ?? "";
    if (m.encoding === "hex") {
      // Multipart: the parts' headers, as far as the capture reaches.
      const text = m.body.match(/../g).map(h => String.fromCharCode(parseInt(h, 16))).join("");
      const boundary = type.match(/boundary="?([^";]+)"?/)?.[1];
      if (boundary) {
        const parts = text.split(`--${boundary}`).slice(1).filter(p => !p.startsWith("--")).map(p => p.split("\r\n\r\n")[0].trim()).filter(Boolean);
        return `<p class="note">${esc(bytes(m.bytes))} in all. The first ${esc(bytes(m.body.length / 2))} hold ${plural(parts.length, "part")}:</p>${parts.map((p, i) => `<div class="part"><b>Part ${i + 1}</b><pre>${esc(p)}</pre></div>`).join("")}`;
      }
      return `<p class="note">${esc(bytes(m.bytes))} of binary data.</p>`;
    }
    let shown = m.body;
    if (/json/.test(type)) { try { shown = JSON.stringify(JSON.parse(m.body), null, 2); } catch { /* As it came. */ } }
    const form = /x-www-form-urlencoded/.test(type) ? new URLSearchParams(m.body) : undefined;
    const assertion = form?.get("client_assertion");
    return `${assertion && jwt(assertion) ? `<h4>Client assertion, decoded</h4><pre>${esc(JSON.stringify(jwt(assertion), null, 2))}</pre>` : ""}<pre>${esc(shown)}</pre>${m.truncated ? `<p class="note">The first part of ${esc(bytes(m.bytes))}.</p>` : ""}`;
  }
  const headers = h => `<pre>${esc(Object.entries(h ?? {}).map(([k, v]) => `${k}: ${v}`).join("\n"))}</pre>`;
  function exchange(s) {
    if (!s.http) return `<p class="note">This step made no HTTP exchange of its own.</p>${Object.keys(s.attrs ?? {}).length ? `<pre>${esc(JSON.stringify(s.attrs, null, 2))}</pre>` : ""}`;
    const ctx = s.http.url.match(/\/wado\/([^/]+)\//)?.[1];
    const decoded = ctx && ctx !== "-" ? jwt(ctx) : undefined;
    return `<p><b>${esc(s.http.method)}</b> <code>${esc(s.http.url)}</code> → <b>${esc(s.http.status ?? "…")}</b></p>
      ${decoded ? `<h4>Signed link, decoded</h4><pre>${esc(JSON.stringify(decoded, null, 2))}</pre>` : ""}
      <h4>Request</h4>${headers(s.http.request?.headers)}${s.http.request?.body ? bodyHtml(s.http.request) : ""}
      <h4>Response</h4>${headers(s.http.response?.headers)}${bodyHtml(s.http.response)}
      ${traceUrl ? `<p><a href="${esc(`${traceUrl}/span.html?session=${encodeURIComponent(s.session)}&span=${encodeURIComponent(s.span)}`)}">Open in the live trace</a></p>` : ""}`;
  }
  /** Fills an exchange in when its card is opened. */
  function wire(root) {
    for (const d of $$("details[data-span]", root)) d.addEventListener("toggle", async () => {
      if (!d.open || d.dataset.loaded) return;
      d.dataset.loaded = "1";
      const raw = $(".raw", d);
      try { raw.innerHTML = exchange(await api("GET", `/api/activity/span?session=${encodeURIComponent(d.dataset.session)}&span=${encodeURIComponent(d.dataset.span)}`)); }
      catch (e) { raw.innerHTML = `<p class="note">${esc(e.status === 404 ? "This exchange is no longer kept." : e.message)}</p>`; }
    });
  }
  return {
    setNames(map) { names = { ...names, ...map }; },
    setTraceUrl(u) { traceUrl = u ?? ""; },
    /** Keeps a card's links within one session's view, as its viewer may see it. */
    setSession(s) { session = s ?? ""; },
    list(events, empty = "Nothing recorded yet.") { return events.length ? `<ol class="cards">${events.map(card).join("")}</ol>` : `<p class="note">${esc(empty)}</p>`; },
    wire,
  };
})();
