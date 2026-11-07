// Focused tests for details the flows rely on.
import { describe, expect, test } from "bun:test";
import { ath, chooseOffer, closing, EVRLE, generateEd25519, isLossy, isStandard, JPEG_BASELINE, JPEG_LOSSLESS, parseAccept, partFooter, partHeader, PRIVATE_TEST_SYNTAX, readMultipart, signJws, verifyJws } from "../src";

const part = (s: string, q?: number) => `multipart/related; type=application/dicom; transfer-syntax=${s}${q !== undefined ? `; q=${q}` : ""}`;

describe("Accept", () => {
  test("orders by q, then position", () => {
    expect(parseAccept(`${part(EVRLE, 0.5)}, ${part(JPEG_LOSSLESS)}, ${part("*", 0.1)}`, "dicom").plan.map(p => p.syntax)).toEqual([JPEG_LOSSLESS, EVRLE, "*"]);
  });
  test("q=0 excludes an item", () => {
    expect(parseAccept(`${part(EVRLE, 0)}, ${part(JPEG_LOSSLESS)}`, "dicom").plan.map(p => p.syntax)).toEqual([JPEG_LOSSLESS]);
  });
  test("omitting transfer-syntax means the default, not anything", () => {
    expect(parseAccept(`multipart/related; type="application/dicom"`, "dicom").plan[0]!.syntax).toBe(EVRLE);
  });
  test("no header and unrelated types are distinguished", () => {
    expect(parseAccept(null, "dicom").kind).toBe("none");
    expect(parseAccept("image/png", "dicom").kind).toBe("bad");
  });
});

describe("Representation choice", () => {
  const stored = (syntax: string, extra: any = {}) => ({ syntax, stored: true, key: syntax, ...extra });
  const alt = (syntax: string) => ({ syntax, stored: false, key: syntax });
  test("* returns what is stored", () => {
    expect(chooseOffer([stored(JPEG_BASELINE)] as any, [{ syntax: "*", q: 1 }])!.syntax).toBe(JPEG_BASELINE);
  });
  test("* substitutes a standard syntax for a private one", () => {
    expect(chooseOffer([stored(PRIVATE_TEST_SYNTAX, { private: true }), alt(EVRLE)] as any, [{ syntax: "*", q: 1 }])!.syntax).toBe(EVRLE);
  });
  test("a listed private syntax is returned", () => {
    expect(chooseOffer([stored(PRIVATE_TEST_SYNTAX), alt(EVRLE)] as any, [{ syntax: PRIVATE_TEST_SYNTAX, q: 1 }])!.syntax).toBe(PRIVATE_TEST_SYNTAX);
  });
  test("lossy data doesn't satisfy a .1.2.1-only request", () => {
    expect(chooseOffer([stored(JPEG_BASELINE)] as any, [{ syntax: EVRLE, q: 1 }])).toBeUndefined();
  });
  test("weights are followed", () => {
    expect(chooseOffer([stored(EVRLE), alt(JPEG_LOSSLESS)] as any, [{ syntax: JPEG_LOSSLESS, q: 1 }, { syntax: EVRLE, q: 0.5 }])!.syntax).toBe(JPEG_LOSSLESS);
  });
  test("syntax classification", () => {
    expect(isStandard(PRIVATE_TEST_SYNTAX)).toBe(false);
    expect(isStandard(EVRLE)).toBe(true);
    expect(isLossy(JPEG_BASELINE)).toBe(true);
    expect(isLossy(JPEG_LOSSLESS)).toBe(false);
  });
});

async function events(chunks: Uint8Array[], boundary: string) {
  const body = (async function* () { for (const c of chunks) yield c; })();
  const out: string[] = [];
  for await (const e of readMultipart(body, boundary)) out.push(e.type);
  return out;
}

describe("Multipart reader", () => {
  const enc = new TextEncoder();
  const whole = (b: string) => {
    const pieces = [partHeader(b, { "Content-Type": "application/dicom" }), enc.encode("hello"), partFooter, closing(b)];
    const n = new Uint8Array(pieces.reduce((a, p) => a + p.length, 0));
    let o = 0; for (const p of pieces) { n.set(p, o); o += p.length; }
    return n;
  };
  test("a closing boundary is complete", async () => {
    expect(await events([whole("x")], "x")).toContain("complete");
  });
  test("splitting across chunks changes nothing", async () => {
    const w = whole("x");
    expect(await events(Array.from(w, v => new Uint8Array([v])), "x")).toEqual(expect.arrayContaining(["start", "end", "complete"]));
  });
  test("a clean end without a closing boundary is truncated", async () => {
    const w = whole("x");
    const t = await events([w.subarray(0, w.length - 10)], "x");
    expect(t).toContain("truncated");
    expect(t).not.toContain("complete");
  });
});

describe("Signed context", () => {
  const k = generateEd25519("k");
  const keys = new Map([["k", k.publicKey]]);
  test("verifies, and detects edits", () => {
    const j = signJws(k, { study: "1.2" });
    expect(verifyJws(j, keys).study).toBe("1.2");
    const [h, , s] = j.split(".");
    expect(verifyJws(`${h}.${Buffer.from('{"study":"9"}').toString("base64url")}.${s}`, keys)).toBeUndefined();
  });
  test("rejects alg:none and unknown keys", () => {
    const none = `${Buffer.from('{"alg":"none","typ":"smart-imaging-context+jwt"}').toString("base64url")}.${Buffer.from("{}").toString("base64url")}.`;
    expect(verifyJws(none, keys)).toBeUndefined();
    expect(verifyJws(signJws(generateEd25519("other"), {}), keys)).toBeUndefined();
  });
  test("ath is the DPoP construction", () => {
    expect(ath("abc")).toBe("ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0");
  });
});

describe("A truly truncating DICOMweb upstream", () => {
  test("the Orthanc adapter reports truncation, with no closing boundary", async () => {
    const { OrthancBackend } = await import("../src/backends/orthanc");
    const boundary = "up";
    const enc2 = new TextEncoder();
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() {
      // Two parts, then a clean end of stream with no closing boundary, as Orthanc and dcm4chee were seen to do.
      const body = `--${boundary}\r\nContent-Type: application/dicom\r\n\r\nAAAA\r\n--${boundary}\r\nContent-Type: application/dicom\r\n\r\nBB`;
      return new Response(enc2.encode(body), { headers: { "content-type": `multipart/related; type="application/dicom"; boundary=${boundary}` } });
    } });
    const b = new OrthancBackend({ base: `http://127.0.0.1:${server.port}`, user: "u", password: "p" });
    const s = await b.openInstances({ study: "1.2" }, [{ syntax: "*", q: 1 }]);
    const it = s.parts;
    let n = 0, result: any;
    while (true) {
      const r = await it.next();
      if (r.done) { result = r.value; break; }
      n++;
      for await (const _ of r.value.body) { /* read it */ }
    }
    server.stop(true);
    expect(n).toBe(2);
    expect(result).toBe("truncated");
  });
});
