// Builds a catalog from an existing archive's DICOMweb API, using QIDO-RS and nothing else. This is
// what fronting a PACS looks like: no bucket and no copy of the images, only a query of what's there.
import type { CatalogStore, StudyDocument, StudyHierarchy } from "./archive/types";
import { patientSourceOf, publicationFor } from "./catalog";

/**
 * What DICOM doesn't state: the FHIR id, a display title, and the site, by accession. It stands in
 * for an operator's configuration. A study it doesn't name
 * uses its Study UID as its id and has no site, so site-limited access never reaches it.
 */
export interface OperatorStudyConfig { id?: string; title?: string; site?: string; }
export interface OrthancCatalogConfig { studies: Record<string, OperatorStudyConfig>; }

const TAG = { studyDate: "00080020", studyTime: "00080030", accession: "00080050", modality: "00080060", sopClass: "00080016", sopInstance: "00080018", studyDescription: "00081030", seriesDescription: "0008103E", patientId: "00100020", patientIssuer: "00100021", bodyPart: "00180015", studyUid: "0020000D", seriesUid: "0020000E", seriesNumber: "00200011", instanceNumber: "00200013" };
const value = (item: any, tag: string): any => item[tag]?.Value?.[0];
const text = (item: any, tag: string): string | undefined => { const v = value(item, tag); return v === undefined ? undefined : String(v); };
const QIDO_PAGE = 500;
const byNumberThenUid = (a: { number: number; uid: string }, b: { number: number; uid: string }) => a.number - b.number || (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0);

export interface OrthancBuildReport { published: string[]; unlinked: { study: string; sourcePatientId?: string; sourcePatientIssuer?: string }[]; }

export async function catalogFromOrthanc(catalog: CatalogStore, orthanc: { base: string; user: string; password: string }, config: OrthancCatalogConfig): Promise<OrthancBuildReport> {
  const headers = { Authorization: `Basic ${btoa(`${orthanc.user}:${orthanc.password}`)}`, Accept: "application/dicom+json" };
  /** Every result of a QIDO-RS query, in pages. */
  const qido = async (path: string, fields: string[]): Promise<any[]> => {
    const out: any[] = [];
    for (let offset = 0; ; offset += QIDO_PAGE) {
      const q = new URLSearchParams({ limit: String(QIDO_PAGE), offset: String(offset) });
      for (const f of fields) q.append("includefield", f);
      const r = await fetch(`${orthanc.base}/dicom-web${path}?${q}`, { headers });
      if (!r.ok) throw new Error(`QIDO-RS ${path}: HTTP ${r.status}`);
      const page = r.status === 204 ? [] : await r.json() as any[];
      out.push(...page);
      if (page.length < QIDO_PAGE) return out;
    }
  };

  const report: OrthancBuildReport = { published: [], unlinked: [] };
  const studies = (await qido("/studies", [TAG.studyDescription, TAG.patientIssuer])).sort((a, b) => (text(a, TAG.studyUid)! < text(b, TAG.studyUid)! ? -1 : 1));
  for (const st of studies) {
    const uid = text(st, TAG.studyUid)!;
    const sourcePatientId = text(st, TAG.patientId), sourcePatientIssuer = text(st, TAG.patientIssuer);
    const patient = sourcePatientId === undefined ? undefined : catalog.patientFor(patientSourceOf(sourcePatientIssuer), sourcePatientId);
    if (!patient) { report.unlinked.push({ study: uid, sourcePatientId, sourcePatientIssuer }); continue; }
    const accession = text(st, TAG.accession) || undefined;
    const operator = (accession ? config.studies[accession] : undefined) ?? config.studies[uid] ?? {};
    const hierarchy: StudyHierarchy = { series: [] };
    for (const se of await qido(`/studies/${uid}/series`, [TAG.seriesDescription, TAG.bodyPart, TAG.seriesNumber])) {
      const seriesUid = text(se, TAG.seriesUid)!;
      const instances = (await qido(`/studies/${uid}/series/${seriesUid}/instances`, [TAG.instanceNumber]))
        .map(i => ({ uid: text(i, TAG.sopInstance)!, number: Number(value(i, TAG.instanceNumber) ?? 0), sopClass: text(i, TAG.sopClass)! }));
      hierarchy.series.push({
        uid: seriesUid, number: Number(value(se, TAG.seriesNumber) ?? 0), modality: text(se, TAG.modality) ?? "OT",
        ...(text(se, TAG.seriesDescription) !== undefined ? { description: text(se, TAG.seriesDescription) } : {}), ...(text(se, TAG.bodyPart) !== undefined ? { bodyPart: text(se, TAG.bodyPart) } : {}),
        instances: instances.sort(byNumberThenUid),
      });
    }
    hierarchy.series.sort(byNumberThenUid);
    // Orthanc doesn't version a study, so this catalog's version stays 1.
    const document: StudyDocument = {
      format: 1, uid, id: operator.id ?? uid, version: 1,
      ...(operator.title !== undefined ? { title: operator.title } : {}), ...(operator.site !== undefined ? { site: operator.site } : {}),
      ...(text(st, TAG.studyDescription) !== undefined ? { description: text(st, TAG.studyDescription) } : {}),
      ...(accession ? { accession } : {}), ...(text(st, TAG.studyDate) ? { date: text(st, TAG.studyDate) } : {}), ...(text(st, TAG.studyTime) ? { time: text(st, TAG.studyTime) } : {}),
      sourcePatientId, ...(sourcePatientIssuer !== undefined ? { sourcePatientIssuer } : {}),
      series: hierarchy.series.map(s => ({ uid: s.uid, number: s.number, modality: s.modality, instanceCount: s.instances.length })),
    };
    catalog.publish(publicationFor(document, patient, hierarchy));
    report.published.push(uid);
  }
  return report;
}
