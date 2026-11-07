// Reads the archive's documents through a bounded cache. Versioned objects are immutable, so a
// cached one never needs invalidating. Only `current.json` can change, and it has a short TTL.
import { ByteLru } from "./lru";
import { ARCHIVE_FORMAT, archiveKeys, type ObjectSource, type SeriesIndex, type SeriesMetadata, type StudyDocument } from "./types";
import { decodeJson } from "./zstd";

/** The object exists, but isn't a document this code can read. */
export class ArchiveFormatError extends Error {}

export interface ArchiveReaderOptions {
  /** How long a study's current version may be reused. */
  currentTtlMs?: number;
  /** Budget for cached documents, in stored (compressed) bytes. */
  cacheBytes?: number;
  now?: () => number;
}

const CURRENT_ENTRY_BYTES = 128;

export class ArchiveReader {
  // Holds stored bytes, and each read parses its own copy. So the bound is exact, and a caller
  // can change what it gets, as the proxy does when it rewrites bulk links.
  private documents: ByteLru<Uint8Array>;
  private currents = new ByteLru<{ version: number; until: number }>(1024 * 1024);
  // Concurrent misses for one object share a single read.
  private inflight = new Map<string, Promise<any>>();
  private ttl: number;
  private now: () => number;

  constructor(public readonly source: ObjectSource, opts: ArchiveReaderOptions = {}) {
    this.documents = new ByteLru(opts.cacheBytes ?? 32 * 1024 * 1024);
    this.ttl = opts.currentTtlMs ?? 2000;
    this.now = opts.now ?? Date.now;
  }

  get cachedBytes() { return this.documents.bytes; }

  private once<T>(key: string, load: () => Promise<T>): Promise<T> {
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const p = load().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  /** The live version. Throws `ObjectNotFoundError` for a study that isn't published. */
  async currentVersion(study: string): Promise<number> {
    const key = archiveKeys.current(study);
    const hit = this.currents.get(key);
    if (hit && hit.until > this.now()) return hit.version;
    return this.once(key, async () => {
      const text = await this.source.text(key);
      let version: unknown;
      try { version = JSON.parse(text).version; } catch { /* reported below */ }
      if (!Number.isInteger(version)) throw new ArchiveFormatError(`${key} doesn't name a version`);
      this.currents.set(key, { version: version as number, until: this.now() + this.ttl }, CURRENT_ENTRY_BYTES);
      return version as number;
    });
  }

  private async document<T extends { format: number }>(key: string): Promise<T> {
    let stored = this.documents.get(key);
    if (!stored) {
      stored = await this.once(key, async () => {
        const bytes = await this.source.bytes(key);
        this.documents.set(key, bytes, bytes.length);
        return bytes;
      });
    }
    let doc: T;
    try { doc = await decodeJson<T>(stored); } catch (e) { throw new ArchiveFormatError(`${key} can't be decoded: ${(e as Error).message}`); }
    if (doc.format !== ARCHIVE_FORMAT) throw new ArchiveFormatError(`${key} has format ${doc.format}, and this code reads ${ARCHIVE_FORMAT}`);
    return doc;
  }

  study = (study: string, version: number) => this.document<StudyDocument>(archiveKeys.study(study, version));
  seriesIndex = (study: string, version: number, series: string) => this.document<SeriesIndex>(archiveKeys.seriesIndex(study, version, series));
  seriesMetadata = (study: string, version: number, series: string) => this.document<SeriesMetadata>(archiveKeys.seriesMetadata(study, version, series));
}
