// The app check: a person's own app, graded from this sandbox's side. A run puts the sandbox into a staged mode,
// with conditions the guide lets any server impose, while the person follows a script with their app; ending it
// grades every request the app made in the meantime against the guide's requirements (src/app-check.ts). A run
// lives on the site's server (src/check-runs.ts), so an agent can start one, hand over its link, and read the result.
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { api, BASE } from "../lib/api";
import { Address, announce, Choice, CopyButton } from "../lib/format";
import { useReady } from "../lib/ready";
import { RegisterForm, useClients, type Client } from "../components/RegisterApp";
import { PageLink } from "../shell/Shell";
import { download } from "../check/report";

interface Source { doc: string; section: string; url: string; text: string }
interface Request { request: string; response: string; log?: string }
interface Step { n: number; group: "script" | "requirement"; title: string; state: "pass" | "fail" | "note" | "unreached"; result: string; sources?: Source[]; requests: Request[] }
interface Note { title: string; detail: string; sources: Source[]; requests: Request[] }
interface AppRun {
  id: string; status: "waiting" | "running" | "done"; summary: string | null;
  app: { sandbox: string; clientId: string; script: string; conditions: string[]; name: string; type: string };
  script: { id: string; title: string; steps: string[] }; staged: { id: string; text: string }[]; fhirBase: string;
  startedAt?: string; endsAt?: string; endedAt?: string; ended?: "graded" | "abandoned" | "expired";
  progress?: { tokens: number; searches: number; retrievals: number }; steps: Step[]; notes: Note[]; notChecked?: string[];
}
/** The scripts and conditions a run can have, as the API names them. Kept here so the form needs no call to draw. */
const SCRIPTS = [
  { id: "josh", title: "Josh's own studies", kind: "launch", line: "Sign in as josh, approve everything offered, and open all 6 studies." },
  { id: "riley", title: "Riley, by her guardian", kind: "launch", line: "Sign in as sam-caregiver and choose Riley: a correct app gets 1 of her 2 studies." },
  { id: "robin", title: "Robin, with no studies", kind: "launch", line: "Sign in as robin: a correct app finds none, and shows that without an error." },
  { id: "service", title: "A backend service, for Josh", kind: "backend", line: "Get a token as the service, search for josh-example, and retrieve every study." },
];
const CONDITIONS = [
  { id: "small-pages", text: "Search pages of at most 2 studies" },
  { id: "search-503", text: "A 503 with Retry-After on the first search" },
  { id: "retrieval-503", text: "A 503 with Retry-After on the first retrieval" },
  { id: "endpoint-forms", text: "Endpoints in all three forms the guide allows" },
];
const KIND: Record<Client["type"], string> = { public: "Public app", confidential: "Confidential app", backend: "Backend service" };
const GLYPH = { pass: "✓", fail: "✕", note: "○", unreached: "" } as const;
const WORD = { pass: "Passed", fail: "Failed", note: "Nothing to check", unreached: "Not reached" } as const;

/** A call to the site's check runs, which live at its root whatever sandbox the page is in. */
async function runs<T = AppRun>(method: string, path = "", body?: unknown): Promise<T> {
  const r = await fetch(`/api/checks${path}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(b.error ?? `HTTP ${r.status}`);
  return b;
}
/** Tells the shell to read the sandbox again, so its banner shows or goes. */
const changed = () => dispatchEvent(new Event("app-check"));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const time = (iso?: string) => iso ? new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";

function Sources({ list }: { list?: Source[] }) {
  if (!list?.length) return null;
  return <ul className="app-check-sources">{list.map((s, i) => <li key={i}><a href={s.url} target="_blank" rel="noopener">{s.doc}, {s.section}</a>: “{s.text}”</li>)}</ul>;
}
function Requests({ list }: { list: Request[] }) {
  if (!list.length) return null;
  return <ul className="call-list">{list.map((q, i) => (
    <li key={i} className="app-check-request"><pre>{q.request}{"\n"}{q.response}</pre>{q.log && <a href={q.log} target="_blank" rel="noopener">In the logs</a>}</li>
  ))}</ul>;
}
function StepLine({ s }: { s: Step }) {
  const head = <>
    <span className="mark" aria-hidden="true">{GLYPH[s.state]}</span>
    <span className="what"><b>{s.title}</b><span className="said">{s.result}</span></span>
    <span className="state">{WORD[s.state]}</span>
  </>;
  const more = !!s.sources?.length || s.requests.length > 0;
  return (
    <li className="check-step" data-step={s.n} data-state={s.state}>
      {more ? <details open={s.state === "fail" || undefined}>
        <summary>{head}<span className="chevron" aria-hidden="true" /></summary>
        <div className="step-body"><Sources list={s.sources} /><Requests list={s.requests} /></div>
      </details> : <div className="step-head">{head}</div>}
    </li>
  );
}

/** A run as Markdown, to paste into an issue or a chat. */
function markdown(r: AppRun): string {
  const out = [`# App check: ${r.app.name}`, "", `- Client: \`${r.app.clientId}\` (${r.app.type})`, `- FHIR base: ${r.fhirBase}`, `- Script: ${r.script.title}`, `- Staged: ${r.staged.map(c => c.text).join("; ") || "nothing"}`, ...(r.endedAt ? [`- Ended: ${r.endedAt}`] : []), "", `**${r.summary ?? ""}**`];
  for (const [title, group] of [["What the script asked", "script"], ["Requirements", "requirement"]] as const) {
    out.push("", `## ${title}`, "");
    for (const s of r.steps.filter(x => x.group === group)) {
      out.push(`- ${GLYPH[s.state] || "·"} ${s.title}: ${s.result}`);
      for (const src of s.sources ?? []) out.push(`  - [${src.doc}, ${src.section}](${src.url}): “${src.text}”`);
      if (s.state === "fail") for (const q of s.requests) out.push(`  - \`${q.request}\` → ${q.response}`);
    }
  }
  if (r.notes.length) {
    out.push("", "## Beyond what the spec guarantees", "");
    for (const n of r.notes) { out.push(`- **${n.title}.** ${n.detail}`); for (const src of n.sources) out.push(`  - [${src.doc}, ${src.section}](${src.url}): “${src.text}”`); }
  }
  if (r.notChecked?.length) out.push("", "## Not checked by this run", "", ...r.notChecked.map(t => `- ${t}`));
  return `${out.join("\n")}\n`;
}

function Results({ run }: { run: AppRun }) {
  const of = (g: Step["group"]) => run.steps.filter(s => s.group === g);
  const bad = run.steps.some(s => s.state === "fail");
  return <>
    <p className={`check-summary${bad ? " bad" : run.ended === "abandoned" ? "" : " good"}`} id="check-summary" role="status">{run.summary}</p>
    {run.steps.length > 0 && <>
      <h3 className="app-check-head">What the script asked</h3>
      <ol className="check-steps" id="script-steps">{of("script").map(s => <StepLine key={s.n} s={s} />)}</ol>
      <h3 className="app-check-head">Requirements</h3>
      <p className="note">Each is a requirement on apps in SMART Imaging Access, or in a standard it relies on, checked on every request of the app's that it covers.</p>
      <ol className="check-steps" id="requirements">{of("requirement").map(s => <StepLine key={s.n} s={s} />)}</ol>
      <h3 className="app-check-head">Beyond what the spec guarantees</h3>
      {run.notes.length ? <ul className="app-check-notes" id="notes">{run.notes.map((n, i) => (
        <li key={i}><b>{n.title}</b><p>{n.detail}</p><Sources list={n.sources} />{n.requests.length > 0 && <details><summary>The requests</summary><Requests list={n.requests} /></details>}</li>
      ))}</ul> : <p className="note" id="notes">Nothing: the app relied on nothing the spec doesn't promise, as far as its requests show.</p>}
      {!!run.notChecked?.length && <>
        <h3 className="app-check-head">Not checked by this run</h3>
        <p className="note">A pass covers only the requirements above, on the requests the app made. These weren't looked at:</p>
        <ul className="app-check-unchecked" id="not-checked">{run.notChecked.map((t, i) => <li key={i}>{t}</li>)}</ul>
      </>}
    </>}
  </>;
}

function Run({ id }: { id: string }) {
  const [run, setRun] = useState<AppRun>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [, setParams] = useSearchParams();
  const load = () => runs("GET", `/${encodeURIComponent(id)}`).then(r => { setRun(r); setError(undefined); }, e => setError((e as Error).message));
  useEffect(() => { setRun(undefined); load(); }, [id]);
  // While it runs, what the app has done so far, every few seconds.
  useEffect(() => { if (run?.status !== "running") return; const t = setInterval(load, 3000); return () => clearInterval(t); }, [run?.status, id]);
  const act = (what: "start" | "end" | "abandon") => async () => {
    setBusy(true);
    try { const r = await runs("POST", `/${encodeURIComponent(id)}/${what}`); setRun(r); changed(); announce(what === "start" ? "The run started." : what === "end" ? "The run ended and was graded." : "The run was abandoned."); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const again = async () => {
    setBusy(true);
    try { const made = await runs<{ id: string }>("POST", "", { app: { sandbox: run!.app.sandbox, clientId: run!.app.clientId, script: run!.app.script, conditions: run!.app.conditions } }); await runs("POST", `/${made.id}/start`); changed(); setParams({ run: made.id }); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  useReady(!!run || !!error);
  if (!run) return error ? <p className="error" role="alert">{error}</p> : <p className="note" role="status">Loading the run…</p>;
  const logs = `${run.app.sandbox}/activity`, p = run.progress;
  return <>
    <div className="check-server">
      <h2 className="check-name">{run.app.name}: {run.script.title}</h2>
      <dl className="check-facts">
        <div><dt>Client ID</dt><dd><code>{run.app.clientId}</code></dd></div>
        <div><dt>FHIR base</dt><dd><Address value={run.fhirBase} name="FHIR base" /></dd></div>
        <div><dt>Run</dt><dd>{run.status === "waiting" ? "Not started" : run.status === "running" ? `On since ${time(run.startedAt)}; ends by itself at ${time(run.endsAt)}` : run.ended === "abandoned" ? `Abandoned at ${time(run.endedAt)}` : `Ended at ${time(run.endedAt)}`}</dd></div>
        {p && <div><dt>Seen so far</dt><dd id="progress">{plural(p.tokens, "token")}, {plural(p.searches, "search", "searches")}, {plural(p.retrievals, "retrieval")}</dd></div>}
      </dl>
      <div className="check-actions">
        {run.status === "waiting" && <button type="button" className="primary" id="start-run" disabled={busy} onClick={act("start")}>Start the run</button>}
        {run.status === "running" && <button type="button" className="primary" id="end-run" disabled={busy} onClick={act("end")}>End the run and grade</button>}
        {run.status !== "done" && <button type="button" className="secondary" id="abandon-run" disabled={busy} onClick={act("abandon")}>Abandon</button>}
        {run.status === "done" && run.ended !== "abandoned" && <>
          <CopyButton label="Copy report" value={markdown(run)} aria="Copy report as Markdown" />
          <button type="button" className="tool" onClick={() => download(`app-check-${run.app.clientId}.json`, JSON.stringify(run, null, 2))}>Download JSON</button>
        </>}
        {run.status === "done" && <button type="button" className="secondary" id="run-again" disabled={busy} onClick={again}>Run again</button>}
        <a href={logs} target="_blank" rel="noopener">Logs</a>
        <PageLink id="app-check" className="check-another">Check another app</PageLink>
      </div>
    </div>
    {error && <p className="error" role="alert">{error}</p>}
    {run.status !== "done" && <>
      <h3 className="app-check-head">What to do</h3>
      <ol className="app-check-script" id="script">
        {run.status === "waiting" && <li>Start the run. This sandbox stages the conditions below until it ends.</li>}
        <li>Point your app at the FHIR base above, with client ID <code>{run.app.clientId}</code>.</li>
        {run.script.steps.map((s, i) => <li key={i}>{s}</li>)}
        <li>End the run and grade. Only this app's requests while the run is on are graded.</li>
      </ol>
      <h3 className="app-check-head">Staged while it runs</h3>
      {run.staged.length ? <ul className="app-check-staged">{run.staged.map(c => <li key={c.id}>{c.text}</li>)}</ul> : <p className="note">Nothing: the sandbox answers as it always does.</p>}
      <p className="note">Each is something the guide or FHIR lets any server do. Ending the run, abandoning it, or its time running out puts the sandbox back as it was.</p>
    </>}
    {run.status === "done" && <Results run={run} />}
  </>;
}

function Setup() {
  const { clients, refresh } = useClients(BASE);
  const [params, setParams] = useSearchParams();
  // Build an App links here with its app chosen.
  const [app, setApp] = useState(params.get("app") ?? undefined), [script, setScript] = useState("josh"), [conditions, setConditions] = useState(CONDITIONS.map(c => c.id));
  const [on, setOn] = useState<{ run: string; client: string } | null>();
  const [error, setError] = useState<string>(), [busy, setBusy] = useState(false);
  useEffect(() => { api<{ appCheck: { run: string; client: string } | null }>("GET", "/api/sandbox").then(s => setOn(s.appCheck), () => setOn(null)); }, []);
  useReady(clients !== undefined && on !== undefined);
  const chosen = clients?.find(c => c.id === app);
  useEffect(() => { if (chosen?.type === "backend") setScript("service"); }, [chosen?.id]);
  const scripts = SCRIPTS.filter(s => !chosen || (s.kind === "backend") === (chosen.type === "backend"));
  const pick = (c: Client) => { setApp(c.id); setScript(c.type === "backend" ? "service" : script === "service" ? "josh" : script); };
  const why = on ? "A run is already on in this sandbox." : !chosen ? "Choose or register an app first." : undefined;
  const start = async () => {
    setBusy(true); setError(undefined);
    try { const made = await runs<{ id: string }>("POST", "", { app: { sandbox: BASE, clientId: chosen!.id, script, conditions } }); await runs("POST", `/${made.id}/start`); changed(); setParams({ run: made.id }); }
    catch (e) { setError((e as Error).message); setBusy(false); }
  };
  return <>
    {on && <p className="check-summary" role="status">A run is on in this sandbox, for <code>{on.client}</code>. <a href={`?run=${encodeURIComponent(on.run)}`}>Open it</a> to end it.</p>}
    <section className="app-check-setup" aria-labelledby="h-app">
      <h2 id="h-app">Your app</h2>
      {clients === undefined ? <p className="note">Loading…</p> : clients.length ? (
        <fieldset className="server-choice"><legend className="sr-only">Apps registered in this sandbox</legend>
          {clients.map(c => (
            <Choice className="server" key={c.id} type="radio" name="app" checked={app === c.id} onChange={() => pick(c)} label={c.name} detail={<>{KIND[c.type]}, client ID <code>{c.id}</code></>} bold />
          ))}
        </fieldset>
      ) : <p className="note">No app is registered in this sandbox yet.</p>}
      <details className="app-check-register" open={clients?.length === 0 || undefined}>
        <summary>Register an app</summary>
        <RegisterForm base={BASE} title="Register an app in this sandbox" registered={async c => { await refresh(); pick(c); }} />
      </details>
    </section>
    <section className="app-check-setup" aria-labelledby="h-script">
      <h2 id="h-script">Script</h2>
      <fieldset className="server-choice"><legend className="sr-only">Script</legend>
        {scripts.map(s => (
          <Choice className="server" key={s.id} type="radio" name="script" checked={script === s.id} onChange={() => setScript(s.id)} label={s.title} detail={s.line} bold />
        ))}
      </fieldset>
    </section>
    <section className="app-check-setup" aria-labelledby="h-staged">
      <h2 id="h-staged">Staged conditions</h2>
      <p className="note">Things the guide or FHIR lets any server do, which an app has to cope with. Only this sandbox, and only while the run is on.</p>
      <fieldset className="client-type"><legend className="sr-only">Staged conditions</legend>
        {CONDITIONS.map(c => <label key={c.id}><input type="checkbox" checked={conditions.includes(c.id)} onChange={e => setConditions(was => e.target.checked ? CONDITIONS.map(x => x.id).filter(x => x === c.id || was.includes(x)) : was.filter(x => x !== c.id))} /> {c.text}</label>)}
      </fieldset>
    </section>
    <div className="check-actions app-check-go">
      <button type="button" className="primary" id="start-run" disabled={!!why || busy} onClick={start}>Start the run</button>
      {why && <span className="note">{why}</span>}
    </div>
    {error && <p className="error" role="alert">{error}</p>}
  </>;
}

export default function AppCheck() {
  const [params] = useSearchParams();
  const run = params.get("run");
  return (
    <main className="landing check-page app-check">
      <h1>App check</h1>
      <p className="lead">Grades your app from this sandbox's side. While a run is on, the sandbox stages what any server may do; you follow a script with your app, then end the run to see each requirement of the guide your app met or broke, with the requests behind it.</p>
      {!BASE ? <p className="note">An app check runs in a sandbox, against the app registered there. Open one from <PageLink id="sandboxes" />.</p>
        : run ? <Run key={run} id={run} /> : <Setup />}
    </main>
  );
}
