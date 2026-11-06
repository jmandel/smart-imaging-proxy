// Object stores over local files and MinIO. Both hold the same keys and the same bytes. Reads are
// async generators, so nothing is opened until the first pull and reading stops when pulling stops.
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import type { S3Client } from "bun";
import type { ObjectSource } from "./types";

/** The object doesn't exist, as distinct from a store that couldn't answer. */
export class ObjectNotFoundError extends Error {
  constructor(public key: string) { super(`no object at ${key}`); }
}

/** What ingest and loading use. The serving path only ever sees `ObjectSource`. */
export interface ObjectStore extends ObjectSource {
  /** Size of an object, or undefined if there is none. */
  size(key: string): Promise<number | undefined>;
  /** Atomic: a reader sees the old object or the whole new one. */
  write(key: string, data: Uint8Array | Blob | string): Promise<void>;
}

const CHUNK = 256 * 1024;

export function fileStore(dir: string, name = "static-files"): ObjectStore {
  const root = resolve(dir);
  const path = (key: string) => {
    const p = resolve(root, key);
    if (!p.startsWith(root + sep)) throw new ObjectNotFoundError(key);
    return p;
  };
  const missing = (e: any, key: string) => e?.code === "ENOENT" ? new ObjectNotFoundError(key) : e;

  // Holds no file handle between chunks, so a reader that stops partway leaves nothing open.
  async function* range(key: string, start: number, length: number): AsyncGenerator<Uint8Array> {
    const file = Bun.file(path(key));
    const size = await stat(path(key)).then(s => s.size, e => { throw missing(e, key); });
    const end = Math.min(size, start + length);
    for (let at = start; at < end; at += CHUNK) yield await file.slice(at, Math.min(at + CHUNK, end)).bytes();
  }

  // Sorting each directory with its slash gives the same order S3 lists keys in.
  async function* walk(key: string): AsyncGenerator<string> {
    const found = await readdir(join(root, key), { withFileTypes: true }).catch(e => { if (e.code === "ENOENT") return []; throw e; });
    const names = found.filter(e => !e.name.startsWith(".")).map(e => e.isDirectory() ? `${e.name}/` : e.name).sort();
    for (const n of names) {
      if (n.endsWith("/")) yield* walk(key + n);
      else yield key + n;
    }
  }

  return {
    name,
    read: key => range(key, 0, Number.MAX_SAFE_INTEGER),
    readRange: (key, start, length) => range(key, start, length),
    bytes: key => Bun.file(path(key)).bytes().catch(e => { throw missing(e, key); }),
    text: key => Bun.file(path(key)).text().catch(e => { throw missing(e, key); }),
    async *list(prefix) {
      for await (const key of walk(prefix.slice(0, prefix.lastIndexOf("/") + 1))) if (key.startsWith(prefix)) yield key;
    },
    size: key => stat(path(key)).then(s => s.size, e => { if (e.code === "ENOENT") return undefined; throw e; }),
    async write(key, data) {
      const target = path(key);
      await mkdir(dirname(target), { recursive: true });
      const tmp = join(dirname(target), `.${randomBytes(6).toString("hex")}.tmp`);
      try {
        await Bun.write(tmp, data);
        await rename(tmp, target);
      } catch (e) { await rm(tmp, { force: true }); throw e; }
    },
  };
}

export function s3Store(client: S3Client, name = "minio"): ObjectStore {
  const missing = (e: any, key: string) => e?.code === "NoSuchKey" ? new ObjectNotFoundError(key) : e;
  async function* stream(file: ReturnType<S3Client["file"]>, key: string): AsyncGenerator<Uint8Array> {
    try {
      for await (const chunk of file.stream() as unknown as AsyncIterable<Uint8Array>) yield chunk;
    } catch (e) { throw missing(e, key); }
  }
  return {
    name,
    read: key => stream(client.file(key), key),
    readRange: (key, start, length) => stream(client.file(key).slice(start, start + length) as any, key),
    bytes: key => client.file(key).bytes().catch(e => { throw missing(e, key); }),
    text: key => client.file(key).text().catch(e => { throw missing(e, key); }),
    async *list(prefix) {
      let continuationToken: string | undefined;
      do {
        const page: any = await client.list({ prefix, continuationToken });
        for (const o of page.contents ?? []) yield o.key as string;
        continuationToken = page.isTruncated ? page.nextContinuationToken : undefined;
      } while (continuationToken);
    },
    size: key => client.file(key).stat().then(s => s.size, e => { if (e?.code === "NoSuchKey") return undefined; throw e; }),
    async write(key, data) { await client.write(key, data); },
  };
}
