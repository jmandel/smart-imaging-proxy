// Hand-built zstd frames made of raw blocks: valid zstd with no compression work, and a size known
// from the content length alone. This is how uncompressed bytes travel inside a `Content-Encoding:
// zstd` response beside stored frames, since concatenated frames decode to concatenated content.
//
// A frame is the magic number, a descriptor, a window of 128 KB, and an 8-byte content size. The
// window is fixed rather than the frame's size, so a decoder needs no more memory for a large
// instance, and its default window limit can't refuse one. Then comes a run of blocks, each with a
// 3-byte little-endian header: bit 0 marks the last block, bits 1-2 are the type (0 is raw), and the
// rest is the size. See RFC 8878 section 3.1.1.

export const RAW_BLOCK_MAX = 128 * 1024;
const FRAME_HEADER_BYTES = 14;
const BLOCK_HEADER_BYTES = 3;

/** Exact encoded size of `content` bytes as one raw frame. */
export const rawFrameSize = (content: number) => FRAME_HEADER_BYTES + BLOCK_HEADER_BYTES * Math.max(1, Math.ceil(content / RAW_BLOCK_MAX)) + content;

function frameHeader(content: number): Uint8Array {
  const h = new Uint8Array(FRAME_HEADER_BYTES);
  const v = new DataView(h.buffer);
  v.setUint32(0, 0xfd2fb528, true); // Magic number.
  h[4] = 0xc0; // Descriptor: 8-byte content size, a window descriptor, no checksum, no dictionary.
  h[5] = 0x38; // Window descriptor: exponent 7, mantissa 0, which is 2^17 bytes.
  v.setBigUint64(6, BigInt(content), true);
  return h;
}
function blockHeader(size: number, last: boolean): Uint8Array {
  const value = (size << 3) | (last ? 1 : 0);
  return new Uint8Array([value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff]);
}

/**
 * Wraps a stream of known length as one raw frame, without buffering: a block's header goes out
 * first, and its content follows as it arrives. Supplying more or fewer bytes than promised throws.
 */
export class RawFrameWriter {
  private left: number;
  private inBlock = 0;
  constructor(private content: number) { this.left = content; }
  /** The frame's opening bytes, which are the whole frame when there's no content. */
  start(): Uint8Array {
    const head = frameHeader(this.content);
    if (this.content > 0) return head;
    const whole = new Uint8Array(FRAME_HEADER_BYTES + BLOCK_HEADER_BYTES);
    whole.set(head);
    whole.set(blockHeader(0, true), FRAME_HEADER_BYTES);
    return whole;
  }
  /** Pieces to send for this chunk. They share its memory. */
  push(chunk: Uint8Array): Uint8Array[] {
    if (chunk.length > this.left) throw new Error(`raw frame got more than the ${this.content} bytes it promised`);
    const out: Uint8Array[] = [];
    let at = 0;
    while (at < chunk.length) {
      if (this.inBlock === 0) {
        this.inBlock = Math.min(RAW_BLOCK_MAX, this.left - at);
        out.push(blockHeader(this.inBlock, this.left - at === this.inBlock));
      }
      const n = Math.min(this.inBlock, chunk.length - at);
      out.push(chunk.subarray(at, at + n));
      at += n;
      this.inBlock -= n;
    }
    this.left -= chunk.length;
    return out;
  }
  finish() {
    if (this.left !== 0) throw new Error(`raw frame ended ${this.left} bytes short`);
  }
}

/** One small whole frame, for framing bytes such as a part's boundary and headers. */
export function rawFrame(content: Uint8Array): Uint8Array {
  const w = new RawFrameWriter(content.length);
  const pieces = [w.start(), ...w.push(content)];
  w.finish();
  const out = new Uint8Array(rawFrameSize(content.length));
  let at = 0;
  for (const p of pieces) { out.set(p, at); at += p.length; }
  return out;
}
