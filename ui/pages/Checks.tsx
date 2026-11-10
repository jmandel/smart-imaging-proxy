// The Conformance page: every protocol check, run one after another in the page, each a line of pass or fail
// that opens its activity in the log.
import { useEffect, useRef, useState } from "react";
import { runCheck, type CheckInfo, type CheckResult } from "../checks/conformance";
import { announce } from "../lib/format";
import { CONFORMANCE_PLAN } from "../sitemap";
import { PageLink } from "../shell/Shell";

type Row = CheckResult | { running: true };
const isDone = (r: Row | undefined): r is CheckResult => !!r && !("running" in r);

function CheckLine({ c, r }: { c: CheckInfo; r?: Row }) {
  const done = isDone(r) ? r : undefined;
  return (
    <li>
      <span className={`verdict ${done ? (done.ok ? "ok" : "bad") : ""}`}>{r && !done ? <span className="spinner" aria-hidden="true" /> : done ? (done.ok ? "Pass" : "Fail") : ""}</span>
      <span className="check-what"><b>{c.title}</b><span>{c.summary}</span></span>
      {done?.activityUrl && <a href={done.activityUrl}>Logs</a>}
      {!!done?.failures.length && <span className="fail-detail">{done.failures.map((f, i) => <span key={i}>{i > 0 && <br />}{`${f.step}: ${f.label}${f.detail ? ` (${f.detail})` : ""}`}</span>)}</span>}
    </li>
  );
}

export default function Checks() {
  const [checks, setChecks] = useState<CheckInfo[]>();
  const [error, setError] = useState<string>();
  const [results, setResults] = useState<Record<string, Row>>({});
  const runButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    fetch("/api/tours").then(r => r.json()).then(b => setChecks(b.checks), e => setError((e as Error).message));
  }, []);

  const rows = Object.values(results), done = rows.filter(isDone), busy = rows.length > done.length;
  async function runAll() {
    const list = checks ?? [], out: Record<string, Row> = Object.fromEntries(list.map(c => [c.id, { running: true } as Row]));
    setResults({ ...out });
    for (const c of list) {
      try { out[c.id] = await runCheck(c.id); }
      catch (e) { out[c.id] = { ok: false, failures: [{ step: c.title, label: (e as Error).message }] }; }
      setResults({ ...out });
    }
    const all = Object.values(out).filter(isDone);
    announce(`${all.filter(c => c.ok).length} of ${all.length} checks passed`);
  }
  // Once a run ends, the button is enabled again, and focus goes back to it.
  useEffect(() => { if (!busy && done.length) runButton.current?.focus(); }, [busy, done.length]);

  return (
    <main className="landing checks-page">
      <h1>Conformance checks</h1>
      <p className="lead">Each check acts out one situation the SMART Imaging Access guide covers. It runs against this sandbox's servers, as an app, an attacker or operations would act, and says whether the servers did what the guide asks.</p>
      <p className="note">Each check runs in a new sandbox of its own, so nothing here changes yours. Faults such as the decision service going down are set and cleared through that sandbox's management API.</p>
      <section className="checks-panel" id="check-run" aria-label="Conformance">
        {error ? <p className="error" role="alert">{error}</p> : !checks ? <p className="note">Loading…</p> : <>
          <div className="row">
            <button type="button" className="primary" id="run-checks" ref={runButton} disabled={busy} onClick={runAll}>Run all checks</button>
            {busy ? <span className="note" role="status">{done.length} of {checks.length} run</span>
              : done.length > 0 && <span className={`verdict ${done.every(c => c.ok) ? "ok" : "bad"}`} role="status">{done.filter(c => c.ok).length} of {done.length} passed</span>}
          </div>
          <ul className="check-list">{checks.map(c => <CheckLine key={c.id} c={c} r={results[c.id]} />)}</ul>
        </>}
      </section>
      <section className="panel planned" aria-labelledby="h-planned">
        <h2 id="h-planned">Planned: run these against your own server</h2>
        <p>Most of these checks need only what any client has, so they could run against a server you add on <PageLink id="servers" />:</p>
        <ul>
          <li>Token refresh</li>
          <li>Attacks on links and tokens</li>
          <li>Image formats</li>
          <li>Metadata links</li>
          <li>Paged search</li>
        </ul>
        <p>The ones that inject faults would need hooks from your server.</p>
        <p><a href={CONFORMANCE_PLAN}>Vote or comment on the plan on GitHub</a>, to say which checks matter to you.</p>
      </section>
    </main>
  );
}
