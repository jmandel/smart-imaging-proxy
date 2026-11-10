// Which of your sandboxes a page outside any sandbox works with: choose one, or make a new one, without leaving
// the page. Its links then go into the sandbox chosen.
import { useState } from "react";
import { chooseSandbox, createSandbox, useLinkedSandbox, useSandboxes } from "../lib/store";

export function SandboxPicker() {
  const list = useSandboxes(), current = useLinkedSandbox();
  const [making, setMaking] = useState(false), [error, setError] = useState<string>();
  const make = async () => {
    setMaking(true); setError(undefined);
    try { chooseSandbox(await createSandbox()); } catch (e) { setError((e as Error).message); } finally { setMaking(false); }
  };
  return (
    <div className="sandbox-picker" id="guide-sandbox">
      {current ? <>
        <label htmlFor="picker-sandbox">The steps below use</label>
        <select id="picker-sandbox" value={current.base} onChange={e => chooseSandbox(e.target.value)}>
          {list.map(w => <option key={w.base} value={w.base}>{w.name ?? "Sandbox"}</option>)}
        </select>
        <button type="button" className="tool" onClick={make} disabled={making}>New sandbox</button>
      </> : <>
        <span>You don't have a sandbox yet. Make one to follow these steps in it.</span>
        <button type="button" className="primary" onClick={make} disabled={making}>Create a sandbox</button>
      </>}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}
