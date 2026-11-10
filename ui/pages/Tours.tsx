// Tours: six stories, listed beside the chosen one, which shows the layer chain it ends on. Running it starts it in a
// sandbox, and opens its step runner there. Each step is an action this page takes, as an app or a person would: a real sign-in, walked
// through the Authorization Server's forms, a search, a retrieval with its own token, or a change through the
// sandbox's management API. The sandbox plans each step and says beforehand what the reference model expects,
// and the step passes when what this page saw matches.
import { useEffect, useRef, useState, type Ref } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { Chain, Chains, Legend, type LayerChain } from "../components/Layers";
import { api, BASE } from "../lib/api";
import { announce, plural, StudyList } from "../lib/format";
import { sandboxClient, type SandboxClient } from "../lib/sandbox-client";
import { APP_LAUNCH, BACKEND_CAPABILITY } from "../lib/servers";
import { PageLink } from "../shell/Shell";

interface Panel { label?: string; chain: LayerChain }
interface Story { id: string; title: string; premise: string; chains: Panel[] }
interface TourList { tours: Story[]; cast: { name: string; line: string }[]; current: string | null }
interface Result {
  ok: boolean; stopped?: boolean; expected?: string; expectedItems?: string[]; actual: string; actualItems?: string[];
  detail?: string; write?: string; chain?: LayerChain; eventCount?: number; activityUrl?: string; quiet?: string;
}
interface Step { id: string; title: string; actor: string; expect?: string; expectItems?: string[]; result?: Result }
interface TourState {
  tour: { id: string; title: string; summary: string; detail?: string } | null;
  chain: LayerChain; panels?: Panel[]; steps: Step[]; activityUrl: string | null;
  /** The chain before any step ran, kept by the page: the server's chain is always the latest. */
  start?: LayerChain;
}
type Plan = { do: string; [k: string]: any };

/** Whether any of these chains shows a labeled study, a cited one, or links already given out. */
const marks = (chains: LayerChain[]) => ({
  locked: chains.some(c => c.columns?.some(x => x.locked)),
  cited: chains.some(c => c.columns?.some(x => x.cited)),
  linked: chains.some(c => c.rows.some(r => r.kind === "links" && r.has.length)),
});

/** What this page does for a step, as planned, under the tour's session and the step's trace. */
async function perform(client: SandboxClient, plan: Plan, trace: string) {
  const tokenOf = (user: string) => client.tokens[user] ?? (() => { throw new Error("An earlier step has to sign in first."); })();
  const found = (s: Awaited<ReturnType<SandboxClient["search"]>>) => ({ status: s.status, studies: s.studies.map(({ id, uid, base }) => ({ id, uid, base })) });
  switch (plan.do) {
    case "sign-in": { const { accessToken: _, ...t } = await client.signIn(plan as any, trace); return t; }
    case "search": return found(await client.search(tokenOf(plan.as), plan.query, trace, APP_LAUNCH));
    case "retrieve": return { status: (await client.retrieve(tokenOf(plan.as), plan.url, trace)).status };
    case "service-search": return found(await client.search(await client.serviceToken(plan.client, trace), plan.query, trace, BACKEND_CAPABILITY));
    case "service-retrieve": return { status: (await client.retrieve(await client.serviceToken(plan.client, trace), plan.url, trace)).status };
    case "referral-check": return { ok: !!plan.patientRef?.startsWith(`${plan.clinicalFhir}/Patient/`) };
    case "management": {
      const statuses: number[] = [];
      for (const c of plan.calls) { try { await client.manage(c.method, `/api/sandbox/policy${c.path}`, c.body, trace); statuses.push(200); } catch (e) { statuses.push((e as { status?: number }).status ?? 0); } }
      return { statuses };
    }
    default: return {};
  }
}

/** A story not yet started: what happens, the chain it ends on, and the button that runs it. */
function Preview({ story, error, start }: { story: Story; error?: string; start: (id: string) => void }) {
  return (
    <>
      <div className="tour-head">
        <h1 id="tour-title" tabIndex={-1}>{story.title}</h1><p>{story.premise}</p>
      </div>
      <div className="tour-buttons">
        <button type="button" className="primary" data-start={story.id} onClick={() => start(story.id)}>Run this story</button>
        <span className="note">{BASE ? "It starts over in this sandbox." : "It runs in a new sandbox of its own."} Each step is a real sign-in, search or retrieval.</span>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="tour-chain">
        {story.chains.length === 1 && <p className="ly-pane-label">Where the story ends</p>}
        <Chains list={story.chains} label={`${story.title}: why the app sees what it sees`} />
        <Legend {...marks(story.chains.map(c => c.chain))} />
      </div>
    </>
  );
}

/** Where the story stands: before any step, after the latest, and for a story about a change, before and after it. */
function Standing({ state }: { state: TourState }) {
  const steps = state.steps, doneAt = steps.findLastIndex(s => s.result?.chain);
  const latest = doneAt >= 0 ? steps[doneAt]!.result!.chain! : state.chain;
  const caption = doneAt < 0 ? "At the start, before any step runs" : doneAt === steps.length - 1 ? "Where the story ends" : `After step ${doneAt + 1}: ${steps[doneAt]!.title}`;
  const { locked, cited } = marks([latest]), { linked } = marks((state.panels ?? []).map(p => p.chain));
  return (
    <div className="tour-chain">
      <h2 className="sr-only">Why the app sees what it sees</h2>
      {/* A story about a change shows its panels, from the server, once the change has run. */}
      {state.panels ? <Chains list={state.panels} /> : <><p className="ly-pane-label">{caption}</p><Chain c={latest} /></>}
      <Legend locked={locked} cited={cited} linked={linked} />
    </div>
  );
}

function StepItem({ s, next, before, running, run, buttonRef }: { s: Step; next: boolean; before?: LayerChain; running: boolean; run: () => void; buttonRef: Ref<HTMLButtonElement> }) {
  const r = s.result;
  // A step's chain shows where the step changed it.
  const changed = r?.chain && JSON.stringify(r.chain.rows) !== JSON.stringify(before?.rows);
  return (
    <li className={r ? "step" : next ? "step next" : "step pending"}>
      <span className="what"><b>{s.title}</b><span>{s.actor}</span>
        {next && s.expect && <span className="expect">{s.expectItems ? <StudyList items={s.expectItems} lead={`Expected: ${s.expect}`} /> : `Expected: ${s.expect}`}</span>}
      </span>
      {r ? <span className={`verdict ${r.ok ? "ok" : "bad"}`}>{r.ok ? "As expected" : r.stopped ? "Stopped" : "Not as expected"}</span>
        : next ? <button type="button" className="primary" data-step={s.id} ref={buttonRef} disabled={running} onClick={run}>{running ? "Running…" : "Run"}</button>
        : <span />}
      {r && <>
        <dl className="compare">
          {r.expected && <><dt>Expected</dt><dd>{r.expectedItems ? <StudyList items={r.expectedItems} lead={r.expected} /> : r.expected}</dd></>}
          <dt>Got</dt><dd>{r.actualItems ? <StudyList items={r.actualItems} lead={r.actual} /> : r.actual}</dd>
          {r.detail && <><dt>Technical detail</dt><dd className="tech">{r.detail}</dd></>}
          {r.write && <><dt>Policy written</dt><dd>{r.write}</dd></>}
        </dl>
        {changed && <div className="step-chain"><p className="ly-pane-label">After this step</p><Chain c={r.chain} label="After this step: why the app sees what it sees" /></div>}
        {r.eventCount ? <p className="result"><a href={r.activityUrl} target="_blank" rel="noopener">Logs</a>, {plural(r.eventCount, "event")}</p> : r.quiet ? <p className="result note">{r.quiet}</p> : null}
      </>}
    </li>
  );
}

export default function Tours() {
  const navigate = useNavigate(), { pathname, search } = useLocation(), [params] = useSearchParams();
  const [list, setList] = useState<TourList>();
  const [state, setState] = useState<TourState>();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>();
  // The tour's client holds each person's token, and the service's, and nothing else keeps them.
  const client = useRef<SandboxClient>(undefined);
  const nextButton = useRef<HTMLButtonElement>(null);
  const focus = useRef<"title" | "step">(undefined);

  /** The chosen story's steps, as they stand in this sandbox. */
  const load = async (tour: string) => {
    const s = await api<TourState>("GET", `/api/sandbox/tours/state?tour=${encodeURIComponent(tour)}`);
    setState({ ...s, start: s.chain });
  };
  useEffect(() => {
    (async () => {
      try {
        // In a sandbox, the page opens on its title, as a new page would.
        if (BASE) focus.current = "title";
        const l: TourList = await fetch(`${BASE}/api/tours`).then(r => r.json());
        const chosen = params.get("tour") ?? l.current;
        // The story's steps load before anything shows, so its cards don't flash first.
        if (BASE && chosen) await load(chosen);
        setList(l);
      } catch (e) { setError((e as Error).message); }
    })();
  }, []);
  useEffect(() => {
    // Focus waits for what it goes to: the title once the page has loaded, the next step's button once it's enabled.
    const to = focus.current === "title" ? document.getElementById("tour-title") : focus.current === "step" && !running ? nextButton.current : undefined;
    if (!to) return;
    // The title is at the top of a page just opened, so focusing it mustn't move the page; a step's button may.
    to.focus(focus.current === "title" ? { preventScroll: true } : undefined);
    focus.current = undefined;
  });

  async function start(id: string) {
    try {
      // In a sandbox, the tour starts it over; from the root, the tour gets a sandbox of its own.
      const r = BASE ? await api("POST", `/api/sandbox/tours/${encodeURIComponent(id)}/start`, {})
        : await fetch(`/api/tours/${encodeURIComponent(id)}/start`, { method: "POST" }).then(async x => { const b = await x.json(); if (!x.ok) throw new Error(b.error ?? `HTTP ${x.status}`); return b; });
      client.current = undefined;
      const to = `${r.sandbox.base}/tours?tour=${encodeURIComponent(id)}`;
      // Starting this same story over stays on its page, and its history.
      if (to === `${pathname}${search}`) { setError(undefined); await load(id); focus.current = "title"; }
      else navigate(to);
    } catch (e) { setError((e as Error).message); }
  }

  /** Runs one step: the sandbox begins it, this page does what it plans, and the sandbox judges what it saw. Gives the state after. */
  async function runStep(from: TourState, id: string): Promise<TourState | undefined> {
    setRunning(true);
    const path = `/api/sandbox/tours/${encodeURIComponent(from.tour!.id)}/steps/${encodeURIComponent(id)}`;
    let next: TourState | undefined;
    try {
      const b = await api("POST", `${path}/begin`, {});
      if (b.state) next = b.state;
      else {
        if (client.current?.session !== b.session) client.current = sandboxClient(BASE, b.session);
        const c: SandboxClient = client.current!;
        next = await api<TourState>("POST", `${path}/finish`, { seen: await perform(c, b.plan, b.trace) });
      }
      next = { ...next!, start: from.start };
      setState(next);
      const s = next.steps.find(x => x.id === id);
      if (s?.result) announce(`${s.title}: ${s.result.ok ? "as expected" : "not as expected"}`);
    } catch (e) { setError((e as Error).message); }
    setRunning(false);
    focus.current = "step";
    return next;
  }
  /** Runs every step left, one after another, until one doesn't finish. */
  async function runRest() {
    let at: TourState | undefined = state;
    for (let s = at?.steps.find(x => !x.result); at && s; s = at.steps.find(x => !x.result)) {
      const id: string = s.id;
      at = await runStep(at, id);
      if (!at?.steps.find(x => x.id === id)?.result) break;
    }
  }

  const inRunner = !!(BASE && state?.tour);
  // One layout throughout: the stories on the left, the chosen one on the right, as a preview until it runs.
  const chosen = inRunner ? state!.tour!.id : params.get("tour") ?? list?.tours[0]?.id;
  const preview = list?.tours.find(t => t.id === chosen) ?? list?.tours[0];
  const choose = (id: string) => inRunner ? start(id) : navigate(`?tour=${encodeURIComponent(id)}`);
  return (
    <main className="tours" id="tours-main">
      <nav className="tour-list" aria-label="Stories" id="tour-list">
        {list && <><h2>Stories</h2>{list.tours.map(t => (
          <button type="button" className="tour" key={t.id} data-tour={t.id} aria-current={t.id === preview?.id ? "true" : undefined} onClick={() => choose(t.id)}>{t.title}</button>
        ))}
          <details className="cast"><summary>Who's who</summary>
            <dl>{list.cast.map(c => <div key={c.name}><dt>{c.name}</dt><dd>{c.line}</dd></div>)}</dl>
          </details>
          <PageLink id="explore">Explore on your own</PageLink>
        </>}
      </nav>
      <section className="tour-main" id="tour" aria-labelledby="tour-title">
        {!list ? (error ? <><h1 id="tour-title" tabIndex={-1}>Something went wrong</h1><p className="error" role="alert">{error}</p></> : <p className="note">Loading…</p>)
          : !inRunner ? (preview ? <Preview story={preview} error={error} start={start} /> : <p className="note">No stories.</p>)
          : error ? <><h1 id="tour-title" tabIndex={-1}>Something went wrong</h1><p className="error" role="alert">{error}</p></>
          : <Runner state={state!} running={running} runStep={id => runStep(state!, id)} runRest={runRest} startOver={() => start(state!.tour!.id)} nextButton={nextButton} />}
      </section>
    </main>
  );
}

function Runner({ state, running, runStep, runRest, startOver, nextButton }: { state: TourState; running: boolean; runStep: (id: string) => void; runRest: () => void; startOver: () => void; nextButton: Ref<HTMLButtonElement> }) {
  const tour = state.tour!, steps = state.steps, left = steps.filter(s => !s.result).length, allOk = steps.every(s => s.result?.ok);
  /** The chain as it stood before step `i` ran. */
  const chainBefore = (i: number) => steps.slice(0, i).reverse().find(x => x.result?.chain)?.result!.chain ?? state.start;
  return (
    <>
      <div className="tour-head">
        <h1 id="tour-title" tabIndex={-1}>{tour.title}</h1><p>{tour.summary}</p>
        {tour.detail && <details className="tech-detail"><summary>Technical detail</summary><p>{tour.detail}</p></details>}
      </div>
      <Standing state={state} />
      <ol className="steps">{steps.map((s, i) => (
        <StepItem key={s.id} s={s} next={!s.result && (i === 0 || !!steps[i - 1]!.result)} before={chainBefore(i)} running={running} run={() => runStep(s.id)} buttonRef={nextButton} />
      ))}</ol>
      <div className="tour-buttons">
        {left ? <button type="button" className="secondary" id="run-rest" disabled={running} onClick={runRest}>Run the rest</button>
          : <span className={`verdict ${allOk ? "ok" : "bad"}`} role="status">{allOk ? "Every step went as expected" : "Some steps didn't go as expected"}</span>}
        <button type="button" className="secondary" id="start" onClick={startOver}>Start over</button>
        {state.activityUrl && <a href={state.activityUrl} target="_blank" rel="noopener">Logs</a>}
      </div>
    </>
  );
}
