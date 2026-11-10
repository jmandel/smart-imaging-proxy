// One study, opened: its images in the viewer, retrieving the whole of it, and its chain in one line. The
// viewer stays mounted while the study is open, so the chain or a retrieval arriving never loses its place.
import { Link } from "react-router";
import { useEffect, useRef, type Ref } from "react";
import { ImageViewer, type ImageViewerHandle } from "../components/ImageViewer";
import { bytes, studyDate } from "../lib/format";
import { viewerSeries, type ImageSource, type Study } from "../lib/smart-imaging";
import { sizeOf } from "./Sheets";
import type { ChainLine, Retrieval, Sheet } from "./types";

export function OpenStudy({ sheet: s, study, source, retrieval: r, chain, backTo, back, retrieve, headline }: {
  sheet: Sheet; study?: Study; source?: ImageSource; retrieval?: Retrieval; chain?: ChainLine; backTo: string;
  back: () => void; retrieve: () => void; headline: Ref<HTMLHeadingElement>;
}) {
  const viewer = useRef<ImageViewerHandle>(null);
  useEffect(() => {
    const v = viewer.current!;
    if (study?.address && source) v.openStudy(viewerSeries(study), source); else v.note("This study has no images to show.");
    return () => v.close();
    // The study is the one opened: a new token or source for it comes only with a new view, which closes this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.id]);
  const meta = [(s.modalities ?? []).join(" "), studyDate(s.date), s.site, sizeOf(s), s.partial].filter(Boolean).join(", ");
  return <>
    <button type="button" className="back" id="back" onClick={back}>Back to {backTo}</button>
    <div className="study-open">
      <div className="study-hero">
        <span className="meta">{meta}</span>
        <h2 id="headline" tabIndex={-1} ref={headline}>{s.title}</h2>
      </div>
      <section className="explore-viewer" aria-label="Image viewer"><ImageViewer ref={viewer} /></section>
      <div><button type="button" className="primary" id="retrieve" disabled={r?.running} onClick={retrieve}>{r ? (r.running ? "Retrieving…" : "Retrieve again") : "Retrieve the whole study"}</button></div>
      {r && (
        <div className="retrieval">
          <h3>{r.running ? "Retrieving" : r.status === 200 && r.complete ? "Retrieved" : `Not retrieved (HTTP ${r.status ?? "none"})`}</h3>
          <dl>
            <dt>Parts</dt><dd>{r.parts}</dd><dt>Received</dt><dd>{bytes(r.bytes)}</dd>
            {r.wire ? <><dt>On the wire</dt><dd>{bytes(r.wire)}</dd></> : null}
            {r.ms !== undefined && <><dt>Took</dt><dd>{r.ms} ms</dd></>}
            {r.error && <><dt>Problem</dt><dd className="error">{r.error}</dd></>}
          </dl>
        </div>
      )}
      <p className="chain" id="chain">{chain ? <>{chain.line} <Link to={chain.activityUrl}>Logs</Link></> : <><span className="spinner" aria-hidden="true" />Loading…</>}</p>
    </div>
  </>;
}
