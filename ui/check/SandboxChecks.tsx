// Checks only a sandbox can run: situations that need its management API, such as the decision service going down
// or the image store stopping partway, and fixtures only a sandbox has. Each runs in a fresh sandbox set up like
// the one being checked, since checks set faults, move the clock and change policy.
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { announce } from "../lib/format";
import { runCheck, type CheckInfo, type CheckResult, type SandboxSetup } from "../checks/conformance";

type Row = CheckResult | { running: true };
const isDone = (r: Row | undefined): r is CheckResult => !!r && !("running" in r);

function CheckLine({ c, r }: { c: CheckInfo; r?: Row }) {
  const done = isDone(r) ? r : undefined, mark = !r ? "todo" : !done ? "running" : done.ok ? "pass" : "fail";
  return (
    <li className="check-step" data-check={c.id} data-state={mark}>
      <div className="step-head">
        <span className="mark" aria-hidden="true">{mark === "running" ? <span className="spinner" /> : mark === "pass" ? "✓" : mark === "fail" ? "✕" : ""}</span>
        <span className="what"><b>{c.title}</b><span className="said">{c.summary}</span>
          {!!done?.failures.length && <span className="said fail-detail">{done.failures.map((f, i) => <span key={i}>{i > 0 && <br />}{`${f.step}: ${f.label}${f.detail ? ` (${f.detail})` : ""}`}</span>)}</span>}
        </span>
        <span className="state">{done?.activityUrl ? <a href={done.activityUrl} target="_blank" rel="noopener">{done.ok ? "Passed" : "Failed"}: logs</a> : mark === "running" ? "Running" : mark === "todo" ? "To do" : ""}</span>
      </div>
    </li>
  );
}

export function SandboxChecks({ base }: { base: string }) {
  const [checks, setChecks] = useState<CheckInfo[]>();
  const [error, setError] = useState<string>();
  const [results, setResults] = useState<Record<string, Row>>({});
  useEffect(() => { fetch("/api/tours").then(r => r.json()).then(b => setChecks(b.checks), e => setError((e as Error).message)); }, []);

  const rows = Object.values(results), done = rows.filter(isDone), busy = rows.length > done.length;
  async function runAll() {
    const list = checks ?? [], out: Record<string, Row> = Object.fromEntries(list.map(c => [c.id, { running: true } as Row]));
    setResults({ ...out });
    // Set up like this sandbox, as far as this page may read it. The shared sandbox of a public site may not be read.
    const like: SandboxSetup = await api<{ storage: { current: string }; topology: { current: string } }>("GET", "/api/sandbox", undefined, base)
      .then(s => ({ storage: s.storage.current, topology: s.topology.current }), () => ({}));
    for (const c of list) {
      try { out[c.id] = await runCheck(c.id, like); }
      catch (e) { out[c.id] = { ok: false, failures: [{ step: c.title, label: (e as Error).message }] }; }
      setResults({ ...out });
    }
    const all = Object.values(out).filter(isDone);
    announce(`${all.filter(c => c.ok).length} of ${all.length} sandbox checks passed`);
  }
  const passed = done.filter(c => c.ok).length;
  return (
    <section className="sandbox-checks" aria-labelledby="h-sandbox-checks">
      <h2 id="h-sandbox-checks">Checks only a sandbox can run</h2>
      <p className="note">Situations no outside client can set up: the service that decides access going down, the image store stopping partway, a clock moved past a token's expiry, policy changed between pages. Each runs in a fresh sandbox set up like this one, through its management API, so nothing here changes this sandbox.</p>
      {error ? <p className="error" role="alert">{error}</p> : !checks ? <p className="note">Loading…</p> : <>
        <div className="check-actions">
          <button type="button" className="secondary" id="run-sandbox-checks" disabled={busy} onClick={runAll}>{done.length ? "Run them again" : "Run the sandbox checks"}</button>
          <span className={`sandbox-checks-summary${!busy && done.length ? (passed === done.length ? " good" : " bad") : ""}`} role="status">
            {busy ? `${done.length} of ${checks.length} run…` : done.length ? `${passed} of ${done.length} passed` : ""}
          </span>
        </div>
        <ol className="check-steps">{checks.map(c => <CheckLine key={c.id} c={c} r={results[c.id]} />)}</ol>
      </>}
    </section>
  );
}
