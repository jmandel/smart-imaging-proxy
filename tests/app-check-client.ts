// A small SMART Imaging app driven by fetch, for the app check's tests: it signs in, searches, and retrieves one
// instance of every study. Each option turns one thing it does right into a mistake, so a test can show the grade.
import { localUrl, type SandboxUrls } from "../src/config";
import { scriptedLaunch } from "../src/flows/oauth";

export const WADO_ACCEPT = 'multipart/related; type="application/dicom"; transfer-syntax=*';
export interface AppHabits { followNext?: boolean; retry?: boolean; buildUrl?: boolean; accept?: boolean }

export async function fetchApp(urls: SandboxUrls, client: string, user: string, patient: string | undefined, habits: AppHabits = {}) {
  const t = await scriptedLaunch(user, client, { at: urls, scope: "launch/patient patient/*.rs", ...(patient ? { patient } : {}) });
  if (!t.access_token) throw new Error(`no token: ${JSON.stringify(t)}`);
  const bearer = { authorization: `Bearer ${t.access_token}` };
  const get = async (url: string, headers: Record<string, string>) => {
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(localUrl(url), { headers });
      if (r.status !== 503 || habits.retry === false || attempt > 3) return r;
      await r.body?.cancel();
      await Bun.sleep(Number(r.headers.get("retry-after") ?? 1) * 1000);
    }
  };
  const entries: any[] = [];
  let url: string | undefined = `${urls.imaging}/fhir/ImagingStudy?patient=${t.patient}&_include=ImagingStudy:endpoint`;
  while (url) {
    const r = await get(url, { ...bearer, accept: "application/fhir+json" });
    if (r.status !== 200) break;
    const b: any = await r.json();
    entries.push(...(b.entry ?? []));
    url = habits.followNext === false ? undefined : b.link?.find((l: any) => l.relation === "next")?.url;
  }
  // An Endpoint in any of the three forms: contained, a response-local entry, or an entry with its own address.
  const resolve = (study: any, ref: string) => ref.startsWith("#") ? study.contained?.find((c: any) => c.id === ref.slice(1))
    : entries.find(e => e.fullUrl === ref || e.fullUrl?.endsWith(`/${ref}`))?.resource;
  const studies = entries.filter(e => e.resource.resourceType === "ImagingStudy").map(e => e.resource);
  let retrieved = 0;
  for (const st of studies) {
    const address = resolve(st, st.endpoint?.[0]?.reference ?? "")?.address;
    const series = st.series?.find((s: any) => s.instance?.length);
    if (!address || !series) continue;
    const uid = st.identifier.find((i: any) => i.system === "urn:dicom:uid").value.replace(/^urn:oid:/, "");
    const base = habits.buildUrl ? `${urls.proxy}/wado/-` : address;
    const r = await get(`${base}/studies/${uid}/series/${series.uid}/instances/${series.instance[0].uid}`, { ...bearer, ...(habits.accept === false ? {} : { accept: WADO_ACCEPT }) });
    await r.arrayBuffer();
    if (r.ok) retrieved++;
  }
  return { token: t.access_token as string, studies: studies.length, retrieved };
}
