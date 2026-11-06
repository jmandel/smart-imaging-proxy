// Streaming multipart/related reader and writer. The reader reports whether the closing
// boundary was actually seen, which is how truncated upstream responses are detected.
import { createHash } from "node:crypto";

export type PartEvent =
  | { type: "start"; headers: Record<string, string> }
  | { type: "data"; bytes: Uint8Array }
  | { type: "end" }
  | { type: "complete" }
  | { type: "truncated" };

const enc = new TextEncoder();
function indexOf(hay: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = hay.indexOf(needle[0]!, from); i !== -1 && i + needle.length <= hay.length; i = hay.indexOf(needle[0]!, i + 1)) {
    for (let j = 1; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

export function boundaryOf(contentType: string | null): string | undefined {
  const m = contentType?.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
  return m?.[1] ?? m?.[2];
}

export async function* readMultipart(body: AsyncIterable<Uint8Array>, boundary: string): AsyncGenerator<PartEvent> {
  const delim = enc.encode(`--${boundary}`);
  const crlfDelim = enc.encode(`\r\n--${boundary}`);
  let buf: Uint8Array = new Uint8Array(0);
  let state: "preamble" | "headers" | "body" | "done" = "preamble";
  const push = (c: Uint8Array) => { const n = new Uint8Array(buf.length + c.length); n.set(buf); n.set(c, buf.length); buf = n; };
  const iter = body[Symbol.asyncIterator]();
  let ended = false;
  const more = async () => {
    try {
      const r = await iter.next();
      if (r.done) { ended = true; return false; }
      push(r.value);
      return true;
    } catch { ended = true; return false; }
  };
  try {
  while (true) {
    if (state === "preamble") {
      const i = indexOf(buf, delim);
      if (i === -1) { if (ended) { yield { type: "truncated" }; return; } await more(); continue; }
      const after = i + delim.length;
      if (buf.length < after + 2) { if (ended) { yield { type: "truncated" }; return; } await more(); continue; }
      if (buf[after] === 45 && buf[after + 1] === 45) { yield { type: "complete" }; return; }
      buf = buf.subarray(after + 2);
      state = "headers";
    } else if (state === "headers") {
      const i = indexOf(buf, enc.encode("\r\n\r\n"));
      const blank = buf[0] === 13 && buf[1] === 10;
      if (i === -1 && !blank) { if (ended) { yield { type: "truncated" }; return; } await more(); continue; }
      const headers: Record<string, string> = {};
      const text = new TextDecoder("latin1").decode(buf.subarray(0, blank ? 0 : i));
      for (const line of text.split("\r\n")) {
        const c = line.indexOf(":");
        if (c > 0) headers[line.slice(0, c).trim().toLowerCase()] = line.slice(c + 1).trim();
      }
      buf = buf.subarray(blank ? 2 : i + 4);
      yield { type: "start", headers };
      state = "body";
    } else if (state === "body") {
      const i = indexOf(buf, crlfDelim);
      if (i !== -1) {
        const after = i + crlfDelim.length;
        if (buf.length < after + 2) { if (ended) { if (i) yield { type: "data", bytes: buf.subarray(0, i) }; yield { type: "truncated" }; return; } await more(); continue; }
        if (i) yield { type: "data", bytes: buf.slice(0, i) };
        yield { type: "end" };
        if (buf[after] === 45 && buf[after + 1] === 45) { yield { type: "complete" }; return; }
        buf = buf.subarray(after + 2);
        state = "headers";
        continue;
      }
      const keep = crlfDelim.length + 1;
      if (buf.length > keep) { yield { type: "data", bytes: buf.slice(0, buf.length - keep) }; buf = buf.subarray(buf.length - keep); }
      if (ended) { if (buf.length) yield { type: "data", bytes: buf }; yield { type: "truncated" }; return; }
      await more();
    }
  }
  } finally {
    // A consumer that stops early also stops the read underneath, whatever it was reading.
    await iter.return?.();
  }
}

export const newBoundary = () => `smart-imaging-${crypto.randomUUID()}`;
/** The same request gets the same boundary, whichever encoding it travels in. */
export const stableBoundary = (identity: string) => `smart-imaging-${createHash("sha256").update(identity).digest("hex").slice(0, 36)}`;
export const partHeader = (boundary: string, headers: Record<string, string>) =>
  enc.encode(`--${boundary}\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`);
export const partFooter = enc.encode("\r\n");
export const closing = (boundary: string) => enc.encode(`--${boundary}--\r\n`);
