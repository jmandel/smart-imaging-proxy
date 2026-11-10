// Explore: pick a person and whose records, or a service and a referral, and see what their app can see. The
// page is a SMART Imaging client, like the demo app (see ../explore/protocol.ts). The sandbox explains the view
// from its policy, and a change, a share or an approval, is a write to the sandbox's management API. Every
// request carries this view's trace session, so the activity log shows what it did.
import { Link } from "react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Chain, Legend } from "../components/Layers";
import { pictures } from "../components/Thumbnail";
import { api, BASE } from "../lib/api";
import { announce } from "../lib/format";
import { APP_LAUNCH, BACKEND_CAPABILITY, imagingOf } from "../lib/servers";
import { thumbnailOf, wadoSource } from "../lib/smart-imaging";
import { session } from "../lib/store";
import { ActionForm, needsForm, type Submitted } from "../explore/ActionForm";
import { OpenStudy } from "../explore/OpenStudy";
import { APP, discover, newSession, personToken, retrieveWhole, search, serviceToken, sheetsOf, traceHeaders } from "../explore/protocol";
import { Sheets } from "../explore/Sheets";
import { WhoList, WhoseChoice } from "../explore/Who";
import type { Action, Cast, ChainLine, Choice, Explained, Referral, Retrieval, View } from "../explore/types";

/** The view last looked at in this tab, for each sandbox. */
const lastKey = () => `smart-imaging-explore:${BASE}`;
const message = (e: unknown) => (e as Error).message;

export default function Explore() {
  const [cast, setCast] = useState<Cast>(), [referrals, setReferrals] = useState<Referral[]>([]);
  const [view, setView] = useState<View>(), [error, setError] = useState("");
  const [open, setOpen] = useState<string>(), [chain, setChain] = useState<ChainLine>(), [returnTo, setReturnTo] = useState<string>();
  const [form, setForm] = useState<Action>(), [retrievals, setRetrievals] = useState<Record<string, Retrieval>>({});
  /** The session of the view being shown: an answer for any other arrives too late, and is dropped. */
  const current = useRef<string>(undefined);
  const opened = useRef<string>(undefined);
  opened.current = open;
  const headline = useRef<HTMLHeadingElement>(null), main = useRef<HTMLElement>(null);
  /** Whether the next headline drawn takes focus: a new view's, or an opened study's. */
  const wantFocus = useRef(false);

  const loadCast = async () => { const c = await api<Cast>("GET", "/api/sandbox/explore/cast"); setCast(c); return c; };

  /** A view: the sandbox's explanation, then the app's own token, search and pictures. */
  async function look(asked: Choice, c = cast!, refs = referrals) {
    setError(""); setOpen(undefined); setChain(undefined); setForm(undefined); setRetrievals({}); setReturnTo(undefined);
    wantFocus.current = true;
    view?.pictures?.cancel();
    const service = asked.client ? c.services.find(s => s.id === asked.client) : undefined;
    // A remembered choice the sandbox no longer has starts again from Josh, the patient.
    const known = asked.user ? c.people.find(p => p.id === asked.user) : undefined;
    const choice: Choice = known || service ? asked : { user: "josh" };
    const person = service ? undefined : known ?? c.people.find(p => p.id === "josh")!;
    const referral = service ? choice.referral ?? refs[0]?.id : undefined;
    const me: View = {
      running: true, session: newSession((service ?? person)!.id), tech: [], studies: {},
      who: service ? { kind: "service", id: service.id, name: service.name, first: service.name, referral } : { kind: "user", id: person!.id, name: person!.name, first: person!.first },
    };
    const who = me.who;
    current.current = me.session;
    const live = () => current.current === me.session;
    session.set(lastKey(), JSON.stringify({ ...choice, ...(referral ? { referral } : {}) }));
    // The view is filled in as its answers arrive, so what's drawn while it runs is a copy.
    setView({ ...me });
    try {
      const q = new URLSearchParams({ session: me.session, ...(service ? { client: service.id, referral: referral ?? "" } : { user: who.id, ...(choice.patient ? { patient: choice.patient } : {}) }) });
      const v = await api<Explained>("GET", `/api/sandbox/explore/view?${q}`, undefined, BASE, traceHeaders(me));
      if (!live()) return;
      Object.assign(me, v, { patientName: v.patient && c.names[`patient:${v.patient}`] });
      if (v.patient) {
        const imaging = imagingOf(await discover(), `${location.origin}${BASE}/fhir`, service ? BACKEND_CAPABILITY : APP_LAUNCH)?.url;
        if (!imaging) throw new Error("The sandbox's SMART configuration names no imaging server.");
        const token = service ? await serviceToken(me, service.id) : await personToken(me, who.id, v.patient, c.app);
        const r = referral ? refs.find(x => x.id === referral) : undefined;
        const query = r ? new URLSearchParams({ patient: r.patientRef, identifier: `${r.system}|${r.accession}`, _include: "ImagingStudy:endpoint" }) : new URLSearchParams({ patient: v.patient, _include: "ImagingStudy:endpoint", _count: "100" });
        const found = await search(me, token, imaging, query.toString());
        if (!live()) return;
        me.token = token; me.searchStatus = found.status;
        for (const st of found.studies) if (st.id) me.studies[st.id] = st;
        me.sheets = sheetsOf(found.studies, v.rows ?? []);
        // Each study's picture for its thumbnail, retrieved with this view's token.
        me.pictures = pictures(async (id, signal) => {
          const st = me.studies[id];
          if (!st?.address || !me.token) return undefined;
          const pic = await thumbnailOf(st, wadoSource(me.token, st, { headers: traceHeaders(me) }), signal);
          return pic && { data: pic.data, modality: pic.series.modality };
        });
      } else me.sheets = [];
    } catch (e) { if (live()) { setError(message(e)); me.headline ??= "This didn't finish"; } }
    if (live()) setView({ ...me, running: false });
  }

  /** The study's chain in one line, from the same events the activity log shows for it. */
  async function loadChain(me: View, study: string) {
    try {
      const c = await api<ChainLine>("GET", `/api/sandbox/explore/happened?${new URLSearchParams({ session: me.session, study })}`);
      if (current.current === me.session && opened.current === study) setChain(c);
    } catch (e) { setChain(undefined); setError(message(e)); }
  }
  const openStudy = (id: string) => { setOpen(id); setChain(undefined); wantFocus.current = true; loadChain(view!, id); };
  const back = () => { setReturnTo(open); setOpen(undefined); };
  const retrieve = (id: string) => {
    const me = view!, st = me.studies[id];
    if (!st) return;
    retrieveWhole(me, st, r => {
      if (current.current !== me.session) return;
      setRetrievals(x => ({ ...x, [id]: r }));
      if (!r.running && opened.current === id) loadChain(me, id);
    });
  };

  // Changes, as the sandbox's management API makes them, then the same view again.
  const policy = (method: string, path: string, body?: unknown) => api(method, `/api/sandbox/policy${path}`, body, BASE, traceHeaders(view));
  async function change(fn: () => Promise<unknown>, then: Choice) {
    try { await fn(); look(then, await loadCast()); } catch (e) { setError(message(e)); }
  }
  const again = (v: View): Choice => v.who.kind === "user" ? { user: v.who.id, patient: v.patient } : { client: v.who.id, referral: v.who.referral };
  function act(a: Action, f?: Submitted) {
    const v = view!, user = v.who.id, patient = ("patient" in a ? a.patient : undefined) ?? v.patient;
    const sites = f?.sites ?? ("sites" in a ? a.sites : []);
    switch (a.kind) {
      case "approve": return change(() => policy("POST", "/app-approvals", { by: `user:${user}`, app: `app:${APP}`, patient: `patient:${patient}`, sites, fhirUser: cast!.people.find(p => p.id === user)?.fhirUser }), again(v));
      case "share": {
        const to = a.with ?? f?.with;
        return change(() => policy("POST", "/shares", { from: `user:${a.from}`, with: `user:${to}`, patient: `patient:${patient}`, sites, label: f?.relationship ?? cast!.relationships[0] }), user === to ? { user: to, patient } : again(v));
      }
      case "unshare": return change(() => policy("DELETE", `/shares?${new URLSearchParams({ from: `user:${user}`, with: `user:${a.with}`, patient: `patient:${patient}` })}`), again(v));
      case "revoke-app": return change(() => policy("DELETE", `/app-approvals?${new URLSearchParams({ by: `user:${user}`, app: `app:${APP}`, patient: `patient:${patient}` })}`), again(v));
      case "apply-policy": return change(async () => {
        const { ruleSets } = await api<{ ruleSets: { id: string; rules: { id: string }[] }[] }>("GET", `/api/sandbox/explore/rule-sets?service=${encodeURIComponent(user)}`);
        for (const rule of ruleSets.find(r => r.id === a.ruleSet)?.rules ?? []) await policy("PUT", `/policies/${encodeURIComponent(rule.id)}`, rule);
      }, again(v));
      case "person": return look({ user: a.user });
      case "referral": return look({ client: user, referral: a.referral });
    }
  }
  const take = (a: Action) => needsForm(a) ? setForm(a) : act(a);

  // The view last looked at here, or with nothing chosen yet, Josh, the patient.
  useEffect(() => {
    (async () => {
      try {
        const c = await loadCast();
        const refs = (await api<{ referrals: Referral[] }>("GET", "/api/sandbox/explore/referrals")).referrals;
        setReferrals(refs);
        let last: Choice | undefined;
        try { last = JSON.parse(session.get(lastKey()) ?? "null") ?? undefined; } catch {}
        look(last ?? { user: "josh" }, c, refs);
      } catch (e) { setError(message(e)); }
    })();
    return () => { current.current = undefined; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Back to this page from the browser's cache: the sandbox may have changed meanwhile, so look again.
  const onShow = useRef<() => void>(undefined);
  onShow.current = () => { if (view && !view.running) look(again(view)); };
  useEffect(() => {
    const shown = (e: PageTransitionEvent) => { if (e.persisted) onShow.current?.(); };
    addEventListener("pageshow", shown);
    return () => removeEventListener("pageshow", shown);
  }, []);
  // A view's thumbnails stop loading when the page goes.
  const shownPictures = view?.pictures;
  useEffect(() => () => shownPictures?.cancel(), [shownPictures]);

  // The new view's headline, or the opened study's, takes focus, unless the person has moved it elsewhere meanwhile.
  useEffect(() => {
    if (!view || view.running || !wantFocus.current) return;
    wantFocus.current = false;
    const a = document.activeElement, free = !a || a === document.body || !!main.current?.contains(a);
    if (free) headline.current?.focus({ preventScroll: innerWidth > 720 });
    announce(headline.current?.textContent ?? "");
  }, [view, open]);

  const sheet = open ? view?.sheets?.find(s => s.id === open) : undefined;
  const study = open ? view?.studies[open] : undefined;
  const source = useMemo(() => view?.token && study ? wadoSource(view.token, study, { headers: traceHeaders(view) }) : undefined, [view, study]);

  function body() {
    if (error && !view) return <><div className="headline"><h1 id="headline" tabIndex={-1} ref={headline}>Something went wrong</h1></div><p className="error" role="alert">{error}</p></>;
    if (!view || !cast) return <div className="headline"><h1 id="headline" tabIndex={-1} ref={headline}><span className="spinner" aria-hidden="true" />Loading</h1></div>;
    const choice = <WhoseChoice cast={cast} referrals={referrals} view={view} look={look} />;
    if (view.running) return <>{choice}<div className="headline"><h1 id="headline" tabIndex={-1} ref={headline}><span className="spinner" aria-hidden="true" />{view.who.kind === "user" ? `Getting ${view.who.first}'s app a token, and searching` : "Working from the referral"}</h1></div></>;
    if (sheet) return <OpenStudy sheet={sheet} study={study} source={source} retrieval={retrievals[sheet.id]} chain={chain} headline={headline}
      backTo={view.who.kind === "user" && view.patientName ? `${view.patientName.split(" ")[0]}'s studies` : "the studies"} back={back} retrieve={() => retrieve(sheet.id)} />;
    return <>
      {choice}
      <div className="headline">
        <h1 id="headline" tabIndex={-1} ref={headline}>{view.headline ?? ""}</h1>
        {view.detail && <p className="note">{view.detail}</p>}
      </div>
      {view.tech.length > 0 && <details className="tech-detail"><summary>Technical detail</summary><ul>{view.tech.map((t, i) => <li key={i}>{t}</li>)}</ul></details>}
      {view.chain?.rows?.length ? <div className="why"><h2 className="why-head">{view.whyTitle}</h2><Chain c={view.chain} label={view.whyTitle} /><Legend cited={(view.chain.columns ?? []).some(c => c.cited)} /></div> : null}
      {error && <p className="error" role="alert">{error}</p>}
      {view.sheets?.length ? <Sheets sheets={view.sheets} pictures={view.pictures} open={openStudy} returnTo={returnTo} /> : null}
      {view.empty && (
        <div className="empty">
          <p>{view.empty.text}</p>
          {view.empty.actions.length > 0 && <div className="buttons">{view.empty.actions.map((a, i) => <button key={i} type="button" className={i === 0 ? "primary" : "secondary"} onClick={() => take(a)}>{a.label}</button>)}</div>}
        </div>
      )}
      {form && <ActionForm action={form} cast={cast} submit={f => act(form, f)} cancel={() => setForm(undefined)} />}
      <div className="actions">
        {(view.actions ?? []).map((a, i) => <button key={i} type="button" className="secondary" onClick={() => take(a)}>{a.label}</button>)}
        {view.activityUrl && <Link to={view.activityUrl} className="log-link">Logs</Link>}
      </div>
    </>;
  }

  return (
    <main className="explore" ref={main}>
      {cast ? <WhoList cast={cast} view={view} look={look} /> : <aside className="who" aria-label="Who's looking" id="who"><p className="note">Loading…</p></aside>}
      <section className="view" id="view" aria-labelledby="headline">{body()}</section>
    </main>
  );
}
