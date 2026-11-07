// zstd for the archive: whole buffers for documents and ingest, streaming for content objects.
import { Readable, pipeline } from "node:stream";
import { createZstdDecompress } from "node:zlib";

/** Level 3 is zstd's default: most of the ratio at a decode speed that doesn't need a thread of its own. */
export const zstdCompress = (bytes: Uint8Array): Uint8Array => Bun.zstdCompressSync(bytes, { level: 3 });
export const zstdDecompress = (bytes: Uint8Array): Promise<Uint8Array> => Bun.zstdDecompress(bytes);
export const zstdDecompressSync = (bytes: Uint8Array): Uint8Array => Bun.zstdDecompressSync(bytes);

export const encodeJson = (value: unknown): Uint8Array => zstdCompress(new TextEncoder().encode(JSON.stringify(value)));
export const decodeJson = async <T>(bytes: Uint8Array): Promise<T> => JSON.parse(new TextDecoder().decode(await zstdDecompress(bytes))) as T;

/** The 5% rule: a wrapper is worth keeping only when it saves at least 5% of the object. */
export const wrapperPaysOff = (rawBytes: number, compressedBytes: number): boolean => compressedBytes <= rawBytes * 0.95;

/**
 * Decompresses a stream of one or more zstd frames. Pull-based: the source advances only as the
 * consumer takes output, apart from the stream buffers (tens of KiB). Ending early closes the source.
 */
export async function* zstdDecode(source: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array, void, undefined> {
  const input = Readable.from(source, { objectMode: false, highWaterMark: 64 * 1024 });
  const decoder = createZstdDecompress();
  pipeline(input, decoder, () => { /* failures surface through the iteration below */ });
  try {
    for await (const chunk of decoder) yield chunk as Uint8Array;
  } finally {
    // Waits for the source to close, so an early stop has released its object when this returns.
    const closed = input.closed ? undefined : new Promise(done => input.once("close", done));
    input.destroy();
    decoder.destroy();
    await closed;
  }
}
