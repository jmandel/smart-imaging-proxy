// The connected app: the chart (patient, conditions, medications, allergies, reports), the patient's studies,
// the image viewer, and the protocol panel. Everything is read with the one token, each request recorded.
import { useEffect, useRef, useState } from "react";
import { ImageViewer, type ImageViewerHandle } from "../components/ImageViewer";
import { announce, bytes, plural, studyDate } from "../lib/format";
import { diagnose } from "../lib/diagnose";
import { fhirHeaders, searchAll, studiesFrom, viewerSeries, WADO_ACCEPT, wadoSource, type Resource, type Study } from "../lib/smart-imaging";
import { Protocol } from "./Protocol";
import { save, type Session } from "./session";
import { curlOf, HttpError, requestLine, type Trail } from "./trail";

/** Something still loading, loaded, or failed with what to say. */
type Load<T> = { data?: T; error?: string };
const failure = (e: unknown, notOffered: string) => ({ error: (e as HttpError).status === 404 ? notOffered : (e as Error).message });

const CLINICAL = [
  { type: "AllergyIntolerance", filter: "clinical-status=active", label: "Allergies", textOf: (r: Resource) => r.code?.text },
  { type: "Condition", filter: "clinical-status=active", label: "Conditions", textOf: (r: Resource) => r.code?.text },
  { type: "MedicationRequest", filter: "status=active", label: "Medications", textOf: (r: Resource) => r.medicationCodeableConcept?.text },
] as const;
const usable = (st: Study) => !!(st.address && st.uid);
const titleOf = (r: Resource) => r.code?.text ?? r.code?.coding?.[0]?.display ?? "Report";

function Patient({ session, load }: { session: Session; load: Load<Resource> }) {
  if (session.backend) return <div id="patient"><p className="who">Patient {session.patient}</p><p className="facts">Backend service: no one signed in</p></div>;
  const p = load.data;
  if (load.error) return <div id="patient"><p className="error">{load.error}</p></div>;
  if (!p) return <div id="patient" />;
  const name = p.name?.[0] ? `${(p.name[0].given ?? []).join(" ")} ${p.name[0].family ?? ""}`.trim() : p.id;
  const facts = [p.birthDate && `Born ${p.birthDate}`, p.gender, p.identifier?.[0]?.value && `MRN ${p.identifier[0].value}`].filter(Boolean);
  return <div id="patient"><p className="who">{name}</p>{facts.length > 0 && <p className="facts">{facts.join(" · ")}</p>}</div>;
}

function Clinical({ groups }: { groups: Record<string, Load<string[]>> }) {
  return (
    <div id="clinical" className="panel">
      <h2>Clinical data</h2>
      {CLINICAL.map(({ type, label }) => {
        const g = groups[type] ?? {};
        return (
          <div className="clinical-group" id={`c-${type}`} key={type}>
            <h3>{label}</h3>
            {g.error ? <p className="none">{g.error}</p> : !g.data ? <p className="none">Loading…</p> : g.data.length ? <ul>{g.data.map((t, i) => <li key={i}>{t}</li>)}</ul> : <p className="none">None active.</p>}
          </div>
        );
      })}
    </div>
  );
}

/** A report: its conclusion, its PDF, and the images of the same accession number. */
function Report({ r, session, trail, viewImages }: { r: Resource; session: Session; trail: Trail; viewImages: (r: Resource) => boolean }) {
  const [pdfSaid, setPdfSaid] = useState<string>(), [imagesSaid, setImagesSaid] = useState<string>();
  const form = r.presentedForm?.find((f: Resource) => f.contentType === "application/pdf");
  const openPdf = async () => {
    // Opened before the fetch, while the tap still counts, so a phone doesn't block it.
    const tab = window.open("", "_blank");
    const res = await fetch(new URL(form.url, `${session.iss}/`), { headers: { authorization: `Bearer ${session.token}` } });
    trail.add({ id: "report-pdf", kind: "clinical", title: "Retrieve a report PDF", status: `${res.status}`, failed: !res.ok, request: requestLine("GET", form.url, { authorization: "x" }), response: `HTTP ${res.status}\ncontent-type: ${res.headers.get("content-type")}` });
    if (!res.ok) { tab?.close(); setPdfSaid("Couldn't open"); return; }
    const url = URL.createObjectURL(await res.blob());
    if (tab) tab.location.href = url; else location.assign(url);
  };
  return (
    <li><details className="report">
      <summary><span className="report-title">{titleOf(r)}</span><span className="report-date">{studyDate(r.effectiveDateTime)}</span></summary>
      <div className="report-body">
        {r.conclusion && <p>{r.conclusion}</p>}
        <div className="report-actions">
          {form && <button type="button" className="tool" onClick={openPdf}>{pdfSaid ?? "Open PDF"}</button>}
          <button type="button" className="tool" onClick={() => { if (!viewImages(r)) setImagesSaid("No images available"); }}>{imagesSaid ?? "View images"}</button>
        </div>
      </div>
    </details></li>
  );
}

function Reports({ load, ...rest }: { load: Load<Resource[]>; session: Session; trail: Trail; viewImages: (r: Resource) => boolean }) {
  const reports = load.data;
  return (
    <div id="reports-panel" className="panel"><h2>Reports</h2>
      <div id="reports">
        {load.error ? <p className="note">{load.error}</p>
          : !reports ? <p className="note">Loading…</p>
          : !reports.length ? <p className="note">No reports this app can see.</p>
          : <ul className="report-list">{reports.map((r, i) => <Report key={r.id ?? i} r={r} {...rest} />)}</ul>}
      </div>
    </div>
  );
}

function Studies({ load, open, chosen }: { load: Load<{ studies: Study[]; incomplete: boolean }>; open: (i: number) => void; chosen?: number }) {
  const found = load.data;
  return (
    <div className="panel studies-panel"><h2>Imaging studies</h2>
      <div id="studies">
        {load.error ? <p className="error">{load.error}</p> : !found ? <p className="note">Loading…</p> : <>
          {found.incomplete && <p className="note">The server says these results are incomplete. Some sources haven't answered yet.</p>}
          {!found.studies.length ? <p className="note">This patient has no studies this app can see.</p> : (
            <ul className="study-list-client">{found.studies.map((st, i) => (
              <li key={st.id ?? i}><button type="button" className="study-button" data-i={i} aria-pressed={chosen === i} disabled={!usable(st)} onClick={() => open(i)}>
                <strong>{st.description ?? st.modality?.[0]?.code ?? "Study"}</strong>
                <span>{[studyDate(st.started), (st.modality ?? []).map((m: Resource) => m.code).join(", "), usable(st) ? plural(st.numberOfInstances ?? 0, "image") : st.status && st.status !== "available" ? `Not available (${st.status})` : "Images not available to this app"].filter(Boolean).join(" · ")}</span>
              </button></li>
            ))}</ul>
          )}
        </>}
      </div>
    </div>
  );
}

export function Workspace({ session, trail, disconnect }: { session: Session; trail: Trail; disconnect: () => void }) {
  const viewer = useRef<ImageViewerHandle>(null);
  const [patient, setPatient] = useState<Load<Resource>>({});
  const [groups, setGroups] = useState<Record<string, Load<string[]>>>({});
  const [reports, setReports] = useState<Load<Resource[]>>({});
  const [studies, setStudies] = useState<Load<{ studies: Study[]; incomplete: boolean }>>({});
  const [chosen, setChosen] = useState<number>();
  // What's been retrieved, in all and by study, for the protocol panel.
  const stats = useRef({ images: 0, bytes: 0, firstMs: undefined as number | undefined });
  const byStudy = useRef(new Map<string, { images: number; bytes: number; failed?: { request: string; response: string; status: number } }>());
  const found = useRef<Study[]>([]);

  /** How the viewer gets a study's images, each retrieval recorded on the protocol panel. */
  // One line per study opened: its images and their size, its latest request, and a failure that stays shown once
  // one happens. The stage's totals are a summary of their own.
  const recordedSource = (study: Study) => wadoSource(session.token, study, { seen: r => {
    const request = requestLine("GET", r.url, { authorization: "x", accept: WADO_ACCEPT });
    const key = study.uid ?? study.id ?? "study", mine = byStudy.current.get(key) ?? { images: 0, bytes: 0 };
    byStudy.current.set(key, mine);
    const s = stats.current;
    if (r.failed) mine.failed = { request, response: `HTTP ${r.status}`, status: r.status };
    else { s.images++; s.bytes += r.bytes ?? 0; mine.images++; mine.bytes += r.bytes ?? 0; }
    const name = study.description ?? "A study", count = mine.images + (mine.failed ? 1 : 0);
    trail.add({
      id: `wado-${key}`, kind: "wado", title: `${name}: ${plural(mine.images, "image")}, ${bytes(mine.bytes)}`, count,
      ...(mine.failed
        ? { failed: true, request: mine.failed.request, response: mine.failed.response, diagnosis: diagnose("wado", r.url, { status: mine.failed.status }) }
        : { ms: r.ms, request, response: `HTTP ${r.status}\ncontent-type: ${r.contentType}`, curl: curlOf(r.url, { authorization: "x", accept: WADO_ACCEPT }) }),
    });
    trail.add({ id: "wado", kind: "wado", title: "Retrieved", summary: true, facts: { Images: s.images, "Data retrieved": bytes(s.bytes), ...(s.firstMs === undefined ? {} : { "First image": `${s.firstMs} ms` }) } });
  } });
  const openStudy = (i: number) => {
    const study = found.current[i];
    if (!study) return;
    setChosen(i);
    stats.current.firstMs = undefined;
    viewer.current?.openStudy(viewerSeries(study), recordedSource(study));
  };
  /** A report's images: the study with its accession number, if this app can open it. */
  const viewImages = (r: Resource) => {
    const accession: string[] = r.identifier?.map((i: Resource) => i.value) ?? [];
    const i = found.current.findIndex(st => st.identifier?.some((x: Resource) => accession.includes(x.value)));
    if (i < 0 || !usable(found.current[i]!)) return false;
    openStudy(i);
    return true;
  };

  useEffect(() => {
    const s = session, headers = fhirHeaders(s.token);
    const loadPatient = async () => {
      try { setPatient({ data: await trail.traced({ id: "patient", kind: "patient", title: "Read the patient" }, `${s.iss}/Patient/${s.patient}`, { headers }) }); }
      catch (e) { setPatient({ error: (e as Error).message }); throw e; }
    };
    // Each search stands alone: one failing leaves the others on the screen.
    const loadClinical = () => Promise.all(CLINICAL.map(async ({ type, filter, label, textOf }) => {
      const set = (g: Load<string[]>) => setGroups(was => ({ ...was, [type]: g }));
      try {
        const b = await trail.traced({ id: `clinical-${type}`, kind: "clinical", title: `Search ${type}` }, `${s.iss}/${type}?${filter}&patient=Patient/${s.patient}`, { headers }, b => ({ [label]: b.entry?.length ?? 0 }));
        set({ data: (b.entry ?? []).map((e: Resource) => textOf(e.resource)).filter(Boolean) });
      } catch (e) { set(failure(e, "This server doesn't offer this search.")); }
    }));
    const loadReports = async () => {
      try {
        const b = await trail.traced({ id: "reports", kind: "clinical", title: "Search DiagnosticReport" }, `${s.iss}/DiagnosticReport?patient=${encodeURIComponent(s.patient)}`, { headers }, b => ({ Reports: b.entry?.length ?? 0 }));
        setReports({ data: (b.entry ?? []).map((e: Resource) => e.resource).filter((r: Resource) => r?.resourceType === "DiagnosticReport").sort((a: Resource, b: Resource) => String(b.effectiveDateTime ?? "").localeCompare(String(a.effectiveDateTime ?? ""))) });
      } catch (e) { setReports(failure(e, "This server doesn't offer reports.")); }
    };
    /** Every page of the study search, each one recorded on the protocol panel. */
    const loadStudies = async () => {
      let result;
      try {
        result = await searchAll(`${s.imaging}/ImagingStudy?patient=${encodeURIComponent(s.patient)}&_include=ImagingStudy:endpoint`, (url, page) => trail.traced({ id: page === 1 ? "imaging" : `imaging-${page}`, kind: "imaging", title: page === 1 ? "Search imaging studies" : `Search imaging studies, page ${page}` }, url, { headers }, b => {
          const of = (t: string) => (b.entry ?? []).filter((e: Resource) => e.resource?.resourceType === t).length;
          return page === 1 ? { Studies: of("ImagingStudy"), Endpoints: of("Endpoint") } : { [`Page ${page}`]: of("ImagingStudy") };
        }));
      } catch (e) { setStudies({ error: (e as Error).message }); throw e; }
      const list = found.current = studiesFrom(result.entries);
      setStudies({ data: { studies: list, incomplete: result.incomplete } });
      if (!list.length) { viewer.current?.note("No studies to show."); return; }
      const first = list.findIndex(usable);
      if (first >= 0) openStudy(first);
    };
    (async () => {
      const results = await Promise.allSettled(s.backend ? [loadStudies()] : [loadPatient(), loadClinical(), loadReports(), loadStudies()]);
      if (results.some(r => r.status === "rejected" && (r.reason as HttpError)?.status === 401)) {
        save({ session: undefined });
        announce("Your session ended. Connect again.");
        viewer.current?.note("Your session ended. Disconnect, then connect again.");
      }
    })();
  }, []);

  return (
    <main id="app" className="workspace">
      <section className="chart" aria-label="Patient">
        <div className="panel patient-panel"><Patient session={session} load={patient} /><p className="connected" id="connected">Connected to {session.label}</p><button type="button" className="tool" id="disconnect" onClick={disconnect}>Disconnect</button></div>
        {!session.backend && <Clinical groups={groups} />}
        <Studies load={studies} open={openStudy} chosen={chosen} />
        {!session.backend && <Reports load={reports} session={session} trail={trail} viewImages={viewImages} />}
      </section>
      <section className="viewer" aria-label="Image viewer">
        <ImageViewer ref={viewer} withIds onShown={ms => { if (stats.current.firstMs === undefined) stats.current.firstMs = ms; }} />
      </section>
      <Protocol trail={trail} />
    </main>
  );
}
