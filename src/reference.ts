// A sandbox's policy and studies as the reference model reads them: what a correct app may see, worked out from the
// policy on file. A sandbox's contract, and the expected answers in its llms.txt, are drawn from this, and a test
// checks every answer against real searches, so the prose, the data and the behaviour can't disagree.
import type { PolicyDocument } from "@smart-imaging-proxy/core";
import { USERS } from "./auth-server";
import { referenceModel, type RefStudy } from "./reference-model";
import { patientAttributes } from "./stores";
import type { Sandbox } from "./sandbox";

/** A sandbox's policy as the reference model reads it. */
export const documentOf = (sandbox: Sandbox): PolicyDocument => { const { revision: _r, ...doc } = sandbox.store.snapshot(); return doc; };
/** A catalog's studies, as the reference model reads them. */
export const refStudies = (sandbox: Sandbox): RefStudy[] => sandbox.catalog.allStudies().map(st => ({ id: st.id, patient: st.patient, site: st.site, labels: st.labels, date: st.date, modalities: [...new Set(st.series.map(x => x.modality))], seriesUids: st.series.map(x => x.uid) }));
/** The reference model over a sandbox as it is now. */
export const modelOf = (sandbox: Sandbox) => referenceModel({ doc: documentOf(sandbox), studies: refStudies(sandbox), now: sandbox.clock.now(), birthDate: p => patientAttributes(p)?.birthDate, patientOf: u => USERS[u]?.patient });
