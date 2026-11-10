// The client side of SMART Imaging Access, as the demo app, Explore and Tours all use it: search with paging,
// the study's WADO-RS address by Endpoint, retries the spec allows, and retrieval of one instance for the
// viewer. Nothing here knows which page it's on: each passes how to make a request, so a page can record
// what it did.

// As stored, since the decoder reads every standard syntax, with uncompressed as the fallback the spec makes universal.
const WADO_ACCEPT = 'multipart/related; type="application/dicom"; transfer-syntax=*, multipart/related; type="application/dicom"; transfer-syntax=1.2.840.10008.1.2.1; q=0.5';
/** How long an app will wait, in all, on servers that say to retry. */
const MOST_RETRIES = 5, LONGEST_WAIT_SECONDS = 30;
/** A DICOM UID: digits in dot-separated components, no leading zero in a component, at most 64 characters. */
const DICOM_UID = /^(?=.{1,64}$)(0|[1-9][0-9]*)(\.(0|[1-9][0-9]*))*$/;
const fhirHeaders = token => ({ authorization: `Bearer ${token}`, accept: "application/fhir+json" });

const sleep = (ms, signal) => new Promise((done, fail) => { const t = setTimeout(done, ms); signal?.addEventListener("abort", () => { clearTimeout(t); fail(new DOMException("aborted", "AbortError")); }, { once: true }); });
/** A request, repeated while the server answers 503 with Retry-After: the spec's way of saying results are being assembled. */
async function patientFetch(url, init, waiting = () => {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init), after = Number(res.headers.get("retry-after"));
    if (res.status !== 503 || !res.headers.has("retry-after") || !Number.isFinite(after) || attempt >= MOST_RETRIES) return res;
    await res.body?.cancel();
    const seconds = Math.min(after, LONGEST_WAIT_SECONDS);
    waiting(seconds);
    await sleep(seconds * 1000, init?.signal);
  }
}

const connectionOf = e => e?.connectionType?.code ?? e?.connectionType?.coding?.[0]?.code;
/** An Endpoint by reference: contained, a response-local urn:uuid, or a full or relative URL in the Bundle. */
function resolveEndpoint(owner, ref, entries) {
  if (!ref) return undefined;
  if (ref.startsWith("#")) return owner.contained?.find(c => c.id === ref.slice(1));
  const endpoints = entries.filter(e => e.resource.resourceType === "Endpoint");
  const relative = /^Endpoint\/[^/]+$/.test(ref);
  return (endpoints.find(e => e.fullUrl === ref) ?? (relative ? endpoints.find(e => e.fullUrl?.endsWith(`/${ref}`) || e.resource.id === ref.split("/")[1]) : undefined))?.resource;
}
/** The WADO-RS address among some references. The token only ever goes to one of these, never to a QIDO-RS or viewer link. */
function wadoAddress(owner, refs, entries) {
  for (const r of refs ?? []) {
    const e = resolveEndpoint(owner, r.reference, entries);
    if (e?.address && connectionOf(e) === "dicom-wado-rs") return e.address.replace(/\/$/, "");
  }
  return undefined;
}
/**
 * Every page of a search from `first`, each from the same server, and whether the server says something is
 * missing. `get(url, page)` makes one request and gives its Bundle, so a page can record it.
 */
async function searchAll(first, get) {
  const origin = new URL(first).origin, entries = [], seen = new Set();
  let url = first, page = 0, incomplete = false;
  while (url && !seen.has(url) && page < 200) {
    seen.add(url); page++;
    const bundle = await get(url, page);
    for (const e of bundle.entry ?? []) {
      if (e.resource?.resourceType === "OperationOutcome" && e.resource.issue?.some(i => i.code === "incomplete")) incomplete = true;
      else entries.push(e);
    }
    const next = bundle.link?.find(l => l.relation === "next")?.url;
    // A next link is followed with the token, so it has to stay on the imaging server.
    url = next && new URL(next, first).origin === origin ? new URL(next, first).toString() : undefined;
  }
  return { entries, incomplete };
}
/** A search's studies, newest first, each with its DICOM UID and WADO-RS address, and its series' own. */
const studiesFrom = entries => entries.filter(e => e.resource?.resourceType === "ImagingStudy").map(e => e.resource).map(r => ({
  ...r,
  uid: (r.identifier ?? []).find(i => i.system === "urn:dicom:uid")?.value?.replace(/^urn:oid:/, ""),
  address: r.status === "available" || r.status === undefined ? wadoAddress(r, r.endpoint, entries) : undefined,
  series: (r.series ?? []).map(x => ({ ...x, address: wadoAddress(r, x.endpoint, entries) })),
})).sort((a, b) => String(b.started ?? "").localeCompare(String(a.started ?? "")));
/** A study's series, as the viewer takes them: each with its instances' UIDs in order. */
const viewerSeries = study => (study.series ?? []).map(s => ({
  uid: s.uid, number: s.number, modality: s.modality?.code, description: s.description, address: s.address, count: s.numberOfInstances ?? s.instance?.length ?? 0,
  instances: [...(s.instance ?? [])].sort((a, b) => (a.number ?? 0) - (b.number ?? 0)).map(i => i.uid),
}));

/** The one part of a single-instance retrieval, as bytes for the decoder. */
function onlyPart(buffer, contentType) {
  const boundary = contentType?.match(/boundary="?([^";]+)/)?.[1];
  const bytes = new Uint8Array(buffer);
  if (!boundary) return buffer;
  const CRLF2 = [13, 10, 13, 10];
  let head = -1;
  for (let i = 0; i + 4 <= Math.min(bytes.length, 4096); i++) if (CRLF2.every((c, k) => bytes[i + k] === c)) { head = i; break; }
  if (head < 0) throw new Error("The response had no multipart header.");
  const start = head + 4, length = new TextDecoder().decode(bytes.subarray(0, head)).match(/content-length:\s*(\d+)/i)?.[1];
  if (length) return buffer.slice(start, start + Number(length));
  const close = new TextEncoder().encode(`\r\n--${boundary}`);
  for (let i = bytes.length - close.length; i >= start; i--) if (close.every((c, k) => bytes[i + k] === c)) return buffer.slice(start, i);
  throw new Error("The response had no closing boundary.");
}
/**
 * How the viewer gets a study's images: from the WADO-RS address search gave, with the token. `headers`
 * adds any of the page's own, and `seen(step)` hears of each retrieval, so a page can record it.
 */
function wadoSource(token, study, { headers = {}, seen = () => {} } = {}) {
  const base = series => series.address ?? study.address;
  const ask = (url, accept, signal, waiting) => patientFetch(url, { headers: { ...headers, authorization: `Bearer ${token}`, accept }, signal }, waiting);
  return {
    async retrieve(series, instance, signal, waiting) {
      const url = `${base(series)}/studies/${study.uid}/series/${series.uid}/instances/${instance}`, t0 = performance.now();
      const res = await ask(url, WADO_ACCEPT, signal, waiting);
      if (!res.ok) { await res.body?.cancel(); seen({ url, status: res.status, failed: true }); throw new Error(res.status === 406 ? "The image server can't send this image in a form this viewer accepts." : `The image server answered ${res.status}.`); }
      const buffer = await res.arrayBuffer();
      seen({ url, status: res.status, contentType: res.headers.get("content-type"), bytes: buffer.byteLength, ms: Math.round(performance.now() - t0) });
      return onlyPart(buffer, res.headers.get("content-type"));
    },
    /** A slide's small picture: the pyramid's THUMBNAIL, or its smallest single-frame level. Never OVERVIEW, which can show the label. */
    async slideInstance(series, signal) {
      const res = await ask(`${base(series)}/studies/${study.uid}/series/${series.uid}/metadata`, "application/dicom+json", signal);
      if (!res.ok) throw new Error(`The image server answered ${res.status} for this slide's details.`);
      const items = await res.json(), get = (o, t) => o?.[t]?.Value;
      // The UID goes into a URL path, so only a well-formed one is used.
      const typeOf = o => get(o, "00080008") ?? [], uid = o => { const v = get(o, "00080018")?.[0]; return typeof v === "string" && DICOM_UID.test(v) ? v : undefined; };
      const thumb = items.find(o => typeOf(o)[2] === "THUMBNAIL" && uid(o));
      if (thumb) return uid(thumb);
      const area = o => Number(get(o, "00280010")?.[0] ?? 0) * Number(get(o, "00280011")?.[0] ?? 0);
      const smallest = items.filter(o => typeOf(o)[2] === "VOLUME" && Number(get(o, "00280008")?.[0] ?? 1) === 1 && uid(o)).sort((a, b) => area(a) - area(b))[0];
      return smallest && uid(smallest);
    },
  };
}
/** The picture that stands for a study: the middle image of its first image series, or a slide's own small picture. */
async function thumbnailOf(study, source, signal) {
  const series = viewerSeries(study).filter(s => !ImageViewer.NOT_IMAGES.has(s.modality) && (s.instances.length || s.modality === "SM")).sort((a, b) => (a.number ?? 0) - (b.number ?? 0))[0];
  if (!series) return undefined;
  const instance = series.modality === "SM" ? await source.slideInstance(series, signal) : series.instances[Math.floor((series.instances.length - 1) / 2)];
  return instance && { series, data: await source.retrieve(series, instance, signal) };
}
