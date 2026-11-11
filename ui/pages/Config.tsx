// Sandbox Config: what the sandbox runs on and how it behaves, through its management API. Where images come
// from, how the imaging FHIR server sits beside the clinical one, the demo clock, starting over, and ending
// access at once. Each section says what its last action did, beside it.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { api } from "../lib/api";
import { announce } from "../lib/format";
import { useReady } from "../lib/ready";

interface Status {
  sandbox: { id: string; base: string } | null;
  clock: { offsetSeconds: number; now: number };
  clockChoices: { value: number; label: string }[];
  storage: { current: string; names: string[] };
  topology: { current: "separate" | "unified"; names: string[] };
}
interface Store { name: string; ok: boolean; detail: string }

const BACKEND_LABELS: Record<string, string> = { "static-files": "Local files", s3: "S3 bucket", orthanc: "Orthanc" };
const backendName = (n: string) => BACKEND_LABELS[n] ?? n;
/** The clock's offset from real time, in the largest unit that reads well. */
function offsetText(s: number) {
  if (s === 0) return "real time";
  const a = Math.abs(s), sign = s > 0 ? "+" : "−";
  const [size, unit] = a >= 86400 ? [86400, "day"] : a >= 3600 ? [3600, "hour"] : [60, "minute"];
  const v = a / size, shown = unit === "minute" ? String(Math.round(v)) : v.toFixed(a % size ? 1 : 0);
  return `${sign}${shown} ${unit}${shown === "1" ? "" : "s"}`;
}

type SectionId = "storage" | "topology" | "clock" | "reset" | "end";
const SECTIONS: SectionId[] = ["storage", "topology", "clock", "reset", "end"];
/** What a section's last action did, or why it failed. */
interface Said { section: SectionId; text: string; failed?: boolean }

function Section({ id, title, said, children }: { id: SectionId; title: ReactNode; said?: Said; children: ReactNode }) {
  return (
    <section className="panel" aria-labelledby={`h-${id}`} id={`config-${id}`}>
      <h2 id={`h-${id}`}>{title}</h2>
      {children}
      <p className={`msg${said?.section === id && said.failed ? " error" : ""}`} role="status">{said?.section === id ? said.text : ""}</p>
    </section>
  );
}

export default function Config() {
  const [st, setSt] = useState<Status>();
  const [error, setError] = useState<string>();
  const [health, setHealth] = useState<Store>();
  const [said, setSaid] = useState<Said>();
  // One action at a time. Controls stay enabled while one runs, so focus stays where it was.
  const busy = useRef(false);
  const checkStorage = () => api<{ current: string; stores: Store[] }>("GET", "/api/sandbox/storage")
    .then(r => setHealth(r.stores.find(b => b.name === r.current)), () => setHealth(undefined));
  useEffect(() => {
    api<Status>("GET", "/api/sandbox").then(setSt, e => setError((e as Error).message));
    checkStorage();
  }, []);
  useReady(!!st || !!error);
  // A link can name a panel (?panel=clock): the page opens scrolled to it, once it's drawn, and follows the address.
  const [params] = useSearchParams(), panel = params.get("panel") as SectionId | null;
  useEffect(() => {
    if (st && panel && SECTIONS.includes(panel)) document.getElementById(`config-${panel}`)?.scrollIntoView({ block: "start" });
  }, [!!st, panel]);

  /** Does one action; the status it answers with redraws the page. */
  const act = async (section: SectionId, method: string, route: string, body: unknown, done: string) => {
    if (busy.current) return;
    busy.current = true;
    try {
      setSt(await api<Status>(method, `/api/sandbox${route}`, body));
      setSaid({ section, text: done });
      announce(done);
      if (section === "storage") checkStorage();
    } catch (e) { setSaid({ section, text: (e as Error).message, failed: true }); }
    finally { busy.current = false; }
  };

  if (error) return <main className="landing config-page"><h1>Sandbox Config</h1><p className="error" role="alert">{error}</p></main>;
  if (!st) return <main className="landing config-page"><h1>Sandbox Config</h1><p className="note">Loading…</p></main>;
  const offset = st.clock.offsetSeconds;
  return (
    <main className="landing config-page">
      <h1>Sandbox Config</h1>
      <p className="lead">{st.sandbox ? "How this sandbox runs. Changes here are this sandbox's alone, and everyone who shares it sees them." : "How the site's own saved policy runs, outside any sandbox."}</p>

      <Section id="storage" said={said} title={<label htmlFor="set-backend">Images come from</label>}>
        <div className="row">
          <select id="set-backend" value={st.storage.current} onChange={e => act("storage", "PATCH", "", { storage: e.target.value }, `Images now come from ${backendName(e.target.value)}.`)}>
            {st.storage.names.map(name => <option key={name} value={name}>{backendName(name)}</option>)}
          </select>
        </div>
        <p id="backend-health" className="note">{health && (health.ok ? `Working: ${health.detail}.` : `Not working: ${health.detail}.`)}</p>
      </Section>

      {st.sandbox && <Section id="topology" said={said} title={<label htmlFor="set-topology">Imaging FHIR server</label>}>
        <div className="row">
          <select id="set-topology" value={st.topology.current} onChange={e => act("topology", "PATCH", "", { topology: e.target.value }, e.target.value === "unified" ? "Imaging is now on the clinical FHIR server." : "Imaging is now on a separate FHIR server.")}>
            <option value="separate">Separate, named in discovery</option>
            <option value="unified">Unified with the clinical server</option>
          </select>
        </div>
      </Section>}

      <Section id="clock" said={said} title="Demo clock">
        <p>Now {offsetText(offset)}. Moving it ahead shows links and tokens expiring.</p>
        <div className="row">
          {st.clockChoices.map(c => <button key={c.value} type="button" className="secondary" onClick={() => act("clock", "POST", "/clock", { advanceSeconds: c.value }, "The clock moved ahead.")}>Ahead {c.label}</button>)}
          <button type="button" className="secondary" disabled={!offset} onClick={() => act("clock", "POST", "/clock", { reset: true }, "The clock is back to real time.")}>Back to real time</button>
        </div>
      </Section>

      {/* Organization policy, and editing it, comes here: between how the sandbox runs and resetting what it holds. */}

      <Section id="reset" said={said} title="Start over">
        <p>Puts relationships and organization policy back as they are on file, and clears every share and app approval.</p>
        <div className="row"><button type="button" className="secondary" onClick={() => act("reset", "POST", "/reset", { confirm: true }, "Policy is as it is on file.")}>Reset policy</button></div>
      </Section>

      <Section id="end" said={said} title="End access now">
        <p>Revoking ends every token's access at once, signed links included. After a policy change, a signed link or a cached decision lasts until it expires: flushing and rotating end those sooner.</p>
        <div className="row">
          {([["/tokens/revoke-all", "Revoke every token"], ["/proxy/flush", "Flush cached decisions"], ["/signing-key/rotate", "Rotate the signing key"]] as const).map(([route, label]) =>
            <button key={route} type="button" className="secondary" onClick={() => act("end", "POST", route, undefined, `${label}: done.`)}>{label}</button>)}
        </div>
      </Section>
    </main>
  );
}
