// The server check: every step of SMART Imaging Access, and the refusals it promises, run against one server from
// this page as far as it can go on its own, saying how far it got and why it stopped. It pauses only for a person
// to sign in. A sandbox gets a second section, of checks only a sandbox can run. An agent can start a check for
// its person through the API (src/check-runs.ts): the link it gives them opens here, and each step is reported back.
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { announce, CopyButton } from "../lib/format";
import { putServer, sandboxServer, savedServers, serverKey, signsIn, useServers, VIEWER_URL, type ServerChoice, type ServerEntry } from "../lib/servers";
import { useSandboxes } from "../lib/store";
import { useReady } from "../lib/ready";
import { PageLink } from "../shell/Shell";
import { SCOPE } from "../viewer/connect";
import { useSteps, type Step } from "../viewer/trail";
import { Abandoned, capital, kindOf, runCheck, sandboxOf, summary, WORD, type Line, type Mark } from "../check/run";
import { download, markdown, reportOf, reportSteps } from "../check/report";
import { SandboxChecks } from "../check/SandboxChecks";

const GLYPH: Record<Mark, string> = { todo: "", running: "", paused: "…", pass: "✓", fail: "✕", skip: "–", note: "○", unreached: "" };
/** A run an agent started: its server, without the private key, which stays on the site's server. */
type RunServer = ServerEntry & { hasKey?: boolean; kid?: string };

function Call({ s }: { s: Step }) {
  return (
    <li><details className="call" data-call={s.id} open={s.failed || undefined}>
      <summary><span className="call-title">{s.title}</span><span className={`call-status${s.failed ? " bad" : ""}`}>{s.failed ? "Failed" : s.status ?? "OK"}</span>{s.ms !== undefined && <span className="call-ms">{s.ms} ms</span>}<span className="chevron" aria-hidden="true" /></summary>
      <div className="call-body">
        {s.request && <><h4>Request</h4><pre>{s.request}</pre></>}
        {s.response && <><h4>Response</h4><pre>{s.response}</pre></>}
        {s.curl && <CopyButton label="Copy as curl" value={s.curl} aria="Copy as curl (set $TOKEN first)" />}
      </div>
    </details></li>
  );
}

/** What the server has to know before anyone signs in: the check's redirect URI, client ID and scope. */
function Register({ server }: { server: RunServer }) {
  const scope = server.scope ?? SCOPE, kid = server.jwk?.kid ?? server.kid;
  return (
    <div className="register-first">
      <p>Register these for the client at the server first. A redirect URI it doesn't know for this client fails at its sign-in page, before the check sees an answer.</p>
      <dl>
        <dt>Redirect URI</dt><dd><code>{VIEWER_URL}</code><CopyButton label="Copy" value={VIEWER_URL} aria="Copy the redirect URI" /></dd>
        <dt>Client ID</dt><dd><code>{server.clientId}</code><CopyButton label="Copy" value={server.clientId} aria="Copy the client ID" /></dd>
        <dt>Scope</dt><dd><code>{scope}</code><CopyButton label="Copy" value={scope} aria="Copy the scope" /></dd>
        {signsIn(server) && kid && <><dt>Signs with</dt><dd>The key whose kid is <code>{kid}</code>, as <code>private_key_jwt</code></dd></>}
      </dl>
    </div>
  );
}

function StepLine({ n, line, server, signIn }: { n: number; line: Line; server: RunServer; signIn?: () => void }) {
  const calls = useSteps(line.trail);
  // What it most likely means: said once, beside the step, from the request that failed.
  const diagnosis = line.diagnosis ?? (line.mark === "fail" ? calls.findLast(c => c.diagnosis)?.diagnosis : undefined);
  const head = <>
    <span className="mark" aria-hidden="true">{line.mark === "running" ? <span className="spinner" /> : GLYPH[line.mark]}</span>
    <span className="what"><b>{n}. {line.title}</b>{line.said && <span className="said">{capital(line.said)}</span>}</span>
    <span className="state">{WORD[line.mark]}</span>
  </>;
  const more = calls.length > 0 || !!line.seen?.length || !!diagnosis;
  return (
    <li className="check-step" data-step={n} data-state={line.mark}>
      {more ? <details open={line.mark === "fail" || undefined}>
        <summary>{head}<span className="chevron" aria-hidden="true" /></summary>
        <div className="step-body">
          {diagnosis && <div className="call-diagnosis"><p>{diagnosis.cause}</p>{diagnosis.check && <pre>{diagnosis.check}</pre>}</div>}
          {!!line.seen?.length && <ul className="seen">{line.seen.map((s, i) => <li key={i} data-ok={s.ok}><span aria-hidden="true">{s.ok ? "✓" : "✕"}</span><span className="sr-only">{s.ok ? "Present: " : "Missing: "}</span><code>{s.text}</code></li>)}</ul>}
          {calls.length > 0 && <ul className="call-list">{calls.map(c => <Call key={c.id} s={c} />)}</ul>}
        </div>
      </details> : <div className="step-head">{head}</div>}
      {signIn && <div className="step-action">
        <Register server={server} />
        <div className="step-go"><button type="button" className="primary" onClick={signIn}>Sign in to continue</button><span className="note">The sign-in opens in a tab of its own, and the check carries on when it comes back.</span></div>
      </div>}
    </li>
  );
}

function Picker({ servers, unknown }: { servers: ServerChoice[]; unknown?: string }) {
  return (
    <section className="check-picker" aria-labelledby="h-pick">
      {unknown && <p className="error" role="alert">There's no server <code>{unknown}</code> in this browser's list.</p>}
      <h2 id="h-pick">Choose a server to check</h2>
      {servers.length ? <ul className="check-servers">{servers.map(s => (
        <li key={s.id}><Link to={`/check?server=${encodeURIComponent(s.id)}`}><b>{s.label}</b><span>{s.detail}</span><span>{capital(kindOf(s))}</span></Link></li>
      ))}</ul> : <p className="note">None yet. Make a sandbox on <PageLink id="sandboxes" />, or add a server of your own.</p>}
      <p>Add or change a server on <PageLink id="servers" />.</p>
    </section>
  );
}

/** Sends a run's state to the API after every change, one request at a time, so the latest arrives last. */
function useReporting(runId: string | undefined, lines: Line[], finished: boolean) {
  const sending = useRef<Promise<unknown>>(Promise.resolve());
  const [failed, setFailed] = useState<string>();
  useEffect(() => {
    if (!runId || !lines.length) return;
    const status = finished ? "done" : lines.some(l => l.mark === "paused") ? "paused" : "running";
    const body = JSON.stringify({ status, summary: summary(lines), steps: reportSteps(lines) });
    sending.current = sending.current.then(() => fetch(`/api/checks/${encodeURIComponent(runId)}/report`, { method: "PUT", headers: { "content-type": "application/json" }, body }))
      .then(r => { if (r instanceof Response) setFailed(r.ok ? undefined : `The report couldn't be sent back (HTTP ${r.status}), so the agent won't see it.`); }, () => setFailed("The report couldn't be sent back, so the agent won't see it."));
  }, [runId, lines, finished]);
  return failed;
}

function Run({ server, runId }: { server: RunServer; runId?: string }) {
  const [lines, setLines] = useState<Line[]>([]);
  const [finished, setFinished] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [waiting, setWaiting] = useState<(tab: Window | null) => void>();
  const [saved, setSaved] = useState(() => savedServers().some(s => serverKey(s) === serverKey(server)));
  const runs = useRef(0);
  const key = serverKey(server);
  useEffect(() => {
    const run = ++runs.current, live = () => runs.current === run;
    setWaiting(undefined);
    setFinished(false);
    const signIn = () => new Promise<Window | null>(done => setWaiting(() => done));
    // A run's key stays on the site's server, which signs each assertion for it.
    const assertion = runId && server.hasKey ? async (aud: string) => {
      const r = await fetch(`/api/checks/${encodeURIComponent(runId)}/assertion`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ aud }) });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`The run's key couldn't sign an assertion: ${b.error ?? `HTTP ${r.status}`}.`);
      return b.assertion as string;
    } : undefined;
    runCheck(server, { show: setLines, signIn, live, assertion }).then(() => { if (live()) { setFinished(true); announce("The server check finished."); } }, e => { if (!(e instanceof Abandoned)) console.error(e); });
    return () => { runs.current++; };
  }, [key, attempt]);
  const reportFailed = useReporting(runId, lines, finished);
  // Ready once the first steps are drawn: the run goes on, and stops only for a sign-in.
  useReady(lines.length > 0);
  // The tab opens from the press itself, or the browser blocks it.
  const signIn = waiting && (() => { setWaiting(undefined); waiting(open("about:blank", "smart-imaging-sign-in")); });
  const busy = lines.some(l => l.mark === "running"), said = summary(lines), sandbox = sandboxOf(server.iss);
  const report = () => reportOf(server, said, lines);
  const save = () => { const { hasKey: _h, kid: _k, ...entry } = server; putServer(entry); setSaved(true); announce("Saved to Your servers."); };
  return <>
    <div className="check-server">
      <h2 className="check-name">{server.label}</h2>
      <dl className="check-facts">
        <div><dt>FHIR server</dt><dd><code>{server.iss}</code></dd></div>
        <div><dt>Signs in as</dt><dd>{capital(kindOf(server))}{runId ? ", for the agent that sent you this link" : ""}</dd></div>
        <div><dt>Client ID</dt><dd><code>{server.clientId}</code></dd></div>
      </dl>
      <div className="check-actions">
        <button type="button" className="secondary" id="run-again" onClick={() => setAttempt(a => a + 1)}>Run again</button>
        <CopyButton label="Copy report" value={markdown(report())} aria="Copy report as Markdown" />
        <button type="button" className="tool" onClick={() => download(`server-check-${new URL(server.iss).host}.json`, JSON.stringify(report(), null, 2))}>Download JSON</button>
        <Link className="check-another" to="/check">Check another server</Link>
      </div>
    </div>
    {runId && <div className="check-run-note">
      <p className="note">Each step is sent back to the agent as it happens. The link lasts a day.</p>
      {reportFailed && <p className="error" role="alert">{reportFailed}</p>}
      {saved ? <p className="note">This server is in <PageLink id="servers" />.</p>
        : server.hasKey ? <p className="note">Its private key stays with the run, on this site's server, so to keep it in Your servers, add it there with its key.</p>
        : <button type="button" className="tool" onClick={save}>Save to Your servers</button>}
    </div>}
    <p className={`check-summary${busy ? "" : lines.some(l => l.mark === "fail") ? " bad" : finished && lines.every(l => l.mark === "pass" || l.mark === "note") ? " good" : ""}`} id="check-summary" role="status">{summary(lines, true)}</p>
    <ol className="check-steps">{lines.map((l, i) => <StepLine key={`${attempt}-${i}`} n={i + 1} line={l} server={server} signIn={l.mark === "paused" ? signIn : undefined} />)}</ol>
    {sandbox !== undefined && <SandboxChecks base={sandbox} />}
  </>;
}

/** A run an agent started, by its id: its server comes from the API. */
function AgentRun({ id }: { id: string }) {
  const [server, setServer] = useState<RunServer>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    fetch(`/api/checks/${encodeURIComponent(id)}`).then(async r => {
      const b = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(r.status === 404 ? "This check link has expired, or was never made. Ask for a new one." : b.error ?? `HTTP ${r.status}`);
      setServer(b.server);
    }).catch(e => setError((e as Error).message));
  }, [id]);
  useReady(!!server || !!error);
  if (error) return <p className="error" role="alert">{error}</p>;
  return server ? <Run server={server} runId={id} /> : <p className="note" role="status">Loading the check…</p>;
}

export default function ServerCheck() {
  const servers = useServers(), sandboxes = useSandboxes();
  const [params] = useSearchParams();
  const run = params.get("run"), base = params.get("sandbox"), wanted = params.get("server") ?? undefined;
  // A sandbox's own link opens the check on it, known in this browser or not.
  const onSandbox = base !== null && /^(\/s\/[A-Za-z0-9_-]+)?$/.test(base) ? { ...sandboxServer(base, sandboxes.find(w => w.base === base)?.name), id: "" } : undefined;
  const server = onSandbox ?? servers.find(s => s.id === wanted);
  return (
    <main className="landing check-page">
      <h1>Server check</h1>
      <p className="lead">Runs SMART Imaging Access against one server, step by step, from this page. It stops only for you to sign in, and shows where a step failed and why.</p>
      {run ? <AgentRun key={run} id={run} /> : server ? <Run key={serverKey(server)} server={server} /> : <Picker servers={servers} unknown={wanted} />}
    </main>
  );
}
