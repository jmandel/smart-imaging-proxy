import { NOT_ON_THE_WEB } from "./syntax";
// Parses Accept into an ordered plan. The plan, not the client's header, is what backends see.
export interface PlanItem { syntax: string; q: number; }
export interface AcceptResult { kind: "dicom" | "metadata" | "octet" | "none" | "bad"; plan: PlanItem[]; }

function splitList(header: string): string[] {
  const out: string[] = []; let cur = "", quoted = false;
  for (const c of header) {
    if (c === '"') quoted = !quoted;
    if (c === "," && !quoted) { out.push(cur); cur = ""; } else cur += c;
  }
  out.push(cur);
  return out.map(s => s.trim()).filter(Boolean);
}

export function parseAccept(header: string | null, expect: "dicom" | "metadata" | "octet"): AcceptResult {
  if (!header) return { kind: "none", plan: [] };
  const items: (PlanItem & { order: number })[] = [];
  let matched = false;
  for (const [order, raw] of splitList(header).entries()) {
    const [type, ...params] = raw.split(";").map(s => s.trim());
    const p: Record<string, string> = {};
    for (const param of params) {
      const i = param.indexOf("=");
      if (i > 0) p[param.slice(0, i).trim().toLowerCase()] = param.slice(i + 1).trim().replace(/^"|"$/g, "");
    }
    const q = p.q !== undefined ? Number(p.q) : 1;
    const t = (type ?? "").toLowerCase();
    if (expect === "metadata") {
      if (t === "application/dicom+json" || t === "application/json" || t === "*/*" || t === "application/*") matched = true;
      continue;
    }
    if (expect === "octet") {
      if (t === "multipart/related" || t === "application/octet-stream" || t === "*/*") {
        matched = true;
        items.push({ syntax: p["transfer-syntax"] ?? "*", q, order });
      }
      continue;
    }
    const isDicomPart = t === "multipart/related" && (p.type ?? "").toLowerCase() === "application/dicom";
    if (isDicomPart || t === "application/dicom") {
      matched = true;
      // PS3.18 8.7.3: without a parameter, the default is Explicit VR Little Endian.
      const syntax = p["transfer-syntax"] ?? "1.2.840.10008.1.2.1";
      if (q > 0 && !NOT_ON_THE_WEB.has(syntax)) items.push({ syntax, q, order });
    } else if (t === "*/*" || t === "multipart/related" && !p.type) {
      matched = true;
      if (q > 0) items.push({ syntax: "1.2.840.10008.1.2.1", q, order });
    }
  }
  if (!matched) return { kind: "bad", plan: [] };
  items.sort((a, b) => b.q - a.q || a.order - b.order);
  return { kind: expect, plan: items.map(({ syntax, q }) => ({ syntax, q })) };
}

/**
 * Whether `Accept-Encoding` names zstd with a non-zero weight. `*` doesn't count: identity always
 * works, so a client gets zstd only by saying so.
 */
export function acceptsZstd(header: string | null): boolean {
  for (const item of (header ?? "").split(",")) {
    const [coding, ...params] = item.split(";").map(s => s.trim().toLowerCase());
    if (coding !== "zstd") continue;
    const q = params.find(p => /^q\s*=/.test(p))?.split("=")[1]?.trim();
    if (q === undefined) return true;
    return /^(0(\.\d{0,3})?|1(\.0{0,3})?)$/.test(q) && Number(q) > 0;
  }
  return false;
}
