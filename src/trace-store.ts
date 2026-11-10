// Where the live trace keeps its spans: a SQLite file of its own, apart from policy. Writes are
// batched, and anything that goes wrong here stays here: the services being traced never see it.
// Records arrive already redacted by src/trace.ts, so nothing secret reaches this file.
import { STORAGE } from "./config";
import { Database, SQLiteError } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { EventRecord, SpanRecord } from "./trace";

/**
 * What the activity view filters events by. `sandbox: ""` is the root's alone. `kinds` and `outcomes`
 * match any one given, as does `anyLink`. `about` keeps a study's own events, by id or UID, with every search and every
 * event that names no study at all. `before` and `after` are bounds on `seq`.
 */
export interface EventQuery {
  session?: string; sandbox?: string; kind?: string; kinds?: string[]; outcome?: string; outcomes?: string[]; who?: string; trace?: string; link?: string; anyLink?: string[];
  about?: { study: string; uid?: string }; after?: number; before?: number; limit?: number;
}
/** The most events one read returns, and the most a summary reads. */
export const EVENT_PAGE_MAX = 2000, EVENT_SUMMARY_MAX = 10000;

export const DEFAULT_TRACE_DB = `${STORAGE}/traces.sqlite`;
export const TRACE_LIMITS = { maxSessions: 100, maxSpansPerSession: 20000, maxBytes: 512 * 1024 * 1024 };

export interface TraceStoreConfig { mode: "file" | "memory"; path?: string; maxSessions?: number; maxSpansPerSession?: number; maxBytes?: number; flushMs?: number; }

/** Reads TRACE_STORE, TRACE_DB and TRACE_MAX_BYTES. A bad value stops startup with a clear message. */
export function traceStoreConfigFromEnv(env: Record<string, string | undefined> = process.env): TraceStoreConfig {
  const mode = env.TRACE_STORE ?? "file";
  if (mode !== "file" && mode !== "memory") throw new Error(`TRACE_STORE must be file or memory, not "${mode}"`);
  const config: TraceStoreConfig = { mode, path: env.TRACE_DB || DEFAULT_TRACE_DB };
  if (env.TRACE_MAX_BYTES !== undefined) {
    const n = Number(env.TRACE_MAX_BYTES);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`TRACE_MAX_BYTES must be a whole number of bytes, not "${env.TRACE_MAX_BYTES}"`);
    config.maxBytes = n;
  }
  return config;
}

/** A span without its headers and bodies, which is all a list or the live stream carries. */
export const summaryOf = (r: SpanRecord): SpanRecord => {
  if (!r.http) return r;
  const { request, response, ...line } = r.http;
  return { ...r, http: { ...line, contentType: response?.headers["content-type"], bytes: response?.bytes } } as unknown as SpanRecord;
};

export interface SessionInfo { id: string; startedAt: number; lastAt: number; spans: number; bytes: number; }
const MAX_PENDING = 5000;
const keyOf = (r: SpanRecord) => `${r.session}\n${r.span}`;
/** The database refused this row, rather than being unavailable, so trying again would fail the same way. */
const rowAtFault = (e: unknown) => !(e instanceof SQLiteError) || /^SQLITE_(CONSTRAINT|MISMATCH|TOOBIG)/.test(e.code ?? "");

export class TraceStore {
  private db!: Database;
  readonly mode: "file" | "memory";
  readonly path?: string;
  readonly maxSessions: number; readonly maxSpansPerSession: number; readonly maxBytes: number;
  private flushMs: number;
  private pending = new Map<string, { record: SpanRecord; summary: string }>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private known = new Map<string, number>();
  private seen = new Set<string>();
  private closed = false;
  private counters = { flushes: 0, written: 0, failures: 0, droppedPending: 0, droppedOverLimit: 0, droppedInvalid: 0, lastFlushMs: 0, maxFlushMs: 0 };
  private lastError: string | undefined;
  private q!: Record<string, ReturnType<Database["query"]>>;
  /** Called with sessions that retention removed, so the viewer can stop listing them. */
  onRemoved: (ids: string[]) => void = () => {};

  constructor(config: TraceStoreConfig = { mode: "memory" }) {
    this.maxSessions = config.maxSessions ?? TRACE_LIMITS.maxSessions;
    this.maxSpansPerSession = config.maxSpansPerSession ?? TRACE_LIMITS.maxSpansPerSession;
    this.maxBytes = config.maxBytes ?? TRACE_LIMITS.maxBytes;
    this.flushMs = config.flushMs ?? 100;
    let mode = config.mode;
    if (mode === "file") {
      try { this.open(config.path ?? DEFAULT_TRACE_DB); this.path = config.path ?? DEFAULT_TRACE_DB; }
      catch (e) {
        // Tracing is an observer, so a bad path costs durability and nothing else.
        this.lastError = `couldn't open ${config.path ?? DEFAULT_TRACE_DB}: ${(e as Error).message}`;
        console.warn(`Traces are in memory for this run: ${this.lastError}`);
        mode = "memory";
      }
    }
    if (mode === "memory") this.open();
    this.mode = mode;
  }

  private open(path?: string) {
    if (path) {
      mkdirSync(dirname(path), { recursive: true });
      // Created private before SQLite opens it. SQLite gives its -wal and -shm files the same mode.
      writeFileSync(path, "", { flag: "a", mode: 0o600 });
      for (const f of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(f)) chmodSync(f, 0o600);
    }
    const db = new Database(path ?? ":memory:", { create: true });
    db.exec("PRAGMA busy_timeout = 2000");
    db.exec("PRAGMA auto_vacuum = INCREMENTAL");
    if (path) db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, started_at REAL NOT NULL, last_at REAL NOT NULL, spans INTEGER NOT NULL, bytes INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS spans (session TEXT NOT NULL, span TEXT NOT NULL, seq INTEGER NOT NULL, trace TEXT NOT NULL, start REAL NOT NULL, has_http INTEGER NOT NULL, bytes INTEGER NOT NULL, summary TEXT NOT NULL, PRIMARY KEY (session, span)) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS spans_by_start ON spans (session, start);
      CREATE INDEX IF NOT EXISTS spans_by_trace ON spans (session, trace, start) WHERE has_http = 1;
      CREATE TABLE IF NOT EXISTS bodies (session TEXT NOT NULL, span TEXT NOT NULL, http TEXT NOT NULL, PRIMARY KEY (session, span)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, session TEXT NOT NULL, sandbox TEXT, trace TEXT NOT NULL, span TEXT, service TEXT NOT NULL, at REAL NOT NULL, kind TEXT NOT NULL, outcome TEXT NOT NULL, who TEXT, links TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_by_session ON events (session, seq);
      CREATE INDEX IF NOT EXISTS events_by_kind ON events (kind, seq);
      PRAGMA user_version = 1;
    `);
    this.db = db;
    this.q = {
      spanBytes: db.query("SELECT bytes FROM spans WHERE session = ? AND span = ?"),
      upsertSession: db.query(`INSERT INTO sessions (id, started_at, last_at, spans, bytes) VALUES (?1, ?2, ?3, ?4, ?5)
        ON CONFLICT (id) DO UPDATE SET started_at = min(started_at, ?2), last_at = max(last_at, ?3), spans = spans + ?4, bytes = bytes + ?5`),
      upsertSpan: db.query(`INSERT INTO spans (session, span, seq, trace, start, has_http, bytes, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (session, span) DO UPDATE SET seq = excluded.seq, trace = excluded.trace, start = excluded.start, has_http = excluded.has_http, bytes = excluded.bytes, summary = excluded.summary`),
      upsertBody: db.query("INSERT INTO bodies (session, span, http) VALUES (?, ?, ?) ON CONFLICT (session, span) DO UPDATE SET http = excluded.http"),
      sessions: db.query("SELECT id, started_at AS startedAt, last_at AS lastAt, spans, bytes FROM sessions ORDER BY last_at DESC"),
      session: db.query("SELECT id, started_at AS startedAt, last_at AS lastAt, spans, bytes FROM sessions WHERE id = ?"),
      summaries: db.query("SELECT summary FROM spans WHERE session = ? ORDER BY start"),
      full: db.query("SELECT s.summary, b.http FROM spans s LEFT JOIN bodies b ON b.session = s.session AND b.span = s.span WHERE s.session = ? ORDER BY s.start"),
      one: db.query("SELECT s.summary, b.http FROM spans s LEFT JOIN bodies b ON b.session = s.session AND b.span = s.span WHERE s.session = ? AND s.span = ?"),
      log: db.query("SELECT s.summary, b.http FROM spans s JOIN bodies b ON b.session = s.session AND b.span = s.span WHERE s.session = ? AND s.has_http = 1 ORDER BY s.start"),
      logTrace: db.query("SELECT s.summary, b.http FROM spans s JOIN bodies b ON b.session = s.session AND b.span = s.span WHERE s.session = ? AND s.trace = ? AND s.has_http = 1 ORDER BY s.start"),
      totals: db.query("SELECT count(*) AS sessions, coalesce(sum(spans), 0) AS spans, coalesce(sum(bytes), 0) AS bytes FROM sessions"),
      oldest: db.query("SELECT id, bytes FROM sessions ORDER BY last_at ASC"),
      maxSeq: db.query("SELECT coalesce(max(seq), 0) AS seq FROM spans"),
    };
    if (path) this.endInterrupted();
    for (const s of this.q.sessions!.all() as SessionInfo[]) { this.known.set(s.id, s.spans); this.seen.add(s.id); }
  }

  /** A span with no end, found at startup, was cut off when the last run stopped. It won't finish now, so it shouldn't read as running. */
  private endInterrupted() {
    const rows = this.db.query("SELECT session, span, summary FROM spans WHERE json_extract(summary, '$.end') IS NULL").all() as { session: string; span: string; summary: string }[];
    const update = this.db.query("UPDATE spans SET summary = ? WHERE session = ? AND span = ?");
    this.db.transaction(() => {
      for (const row of rows) {
        const r = JSON.parse(row.summary);
        update.run(JSON.stringify({ ...r, end: r.start, status: "error", attrs: { ...r.attrs, error: "The demo stopped before this finished, so its timing and outcome are unknown." } }), row.session, row.span);
      }
    })();
  }

  /** The highest sequence number stored, so numbering carries on after a restart. */
  maxSeq(): number { return (this.q.maxSeq!.get() as any).seq; }
  knows(session: string) { return this.seen.has(session); }

  /** Queues a record. A later version of the same span replaces it, here or in the database. */
  put(record: SpanRecord, summary: string) {
    if (this.closed) return;
    this.seen.add(record.session);
    const key = keyOf(record);
    this.pending.delete(key);
    this.pending.set(key, { record, summary });
    while (this.pending.size > MAX_PENDING) {
      // Only reached if writes keep failing. Tracing gives up old spans before it grows without bound.
      this.pending.delete(this.pending.keys().next().value!);
      this.counters.droppedPending++;
    }
    this.timer ??= setTimeout(() => this.flush(), this.flushMs);
    (this.timer as any).unref?.();
  }

  /**
   * Writes what's queued in one transaction, then applies retention. It never throws. A row the database
   * refuses can't hold up the others, and anything else that goes wrong leaves the queue to try again.
   */
  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (!this.pending.size || this.closed) return;
    const started = performance.now();
    const batch = [...this.pending.values()];
    try {
      this.db.transaction(() => { for (const p of batch) this.write(p.record, p.summary); })();
      for (const p of batch) this.pending.delete(keyOf(p.record));
      this.counters.flushes++;
      this.counters.written += batch.length;
      this.lastError = undefined;
    } catch (e) {
      this.counters.failures++;
      this.lastError = (e as Error).message;
      this.known = new Map((this.safeSessions()).map(s => [s.id, s.spans]));
      if (rowAtFault(e)) this.writeEach(batch);
    }
    try { this.applyRetention(); }
    catch (e) { this.counters.failures++; this.lastError = (e as Error).message; }
    if (this.pending.size) {
      this.timer ??= setTimeout(() => this.flush(), 1000);
      (this.timer as any).unref?.();
    }
    const ms = performance.now() - started;
    this.counters.lastFlushMs = ms;
    this.counters.maxFlushMs = Math.max(this.counters.maxFlushMs, ms);
  }

  /** One row at a time, dropping and counting each one the database refuses. A problem with the database itself leaves the rest queued. */
  private writeEach(batch: { record: SpanRecord; summary: string }[]) {
    for (const p of batch) {
      try {
        this.db.transaction(() => this.write(p.record, p.summary))();
        this.counters.written++;
      } catch (e) {
        this.lastError = (e as Error).message;
        if (!rowAtFault(e)) return;
        this.counters.droppedInvalid++;
      }
      this.pending.delete(keyOf(p.record));
    }
  }

  private write(r: SpanRecord, summary: string) {
    const was = this.q.spanBytes!.get(r.session, r.span) as { bytes: number } | null;
    const count = this.known.get(r.session) ?? 0;
    if (!was && count >= this.maxSpansPerSession) { this.counters.droppedOverLimit++; return; }
    const http = r.http ? JSON.stringify(r.http) : undefined;
    const bytes = summary.length + (http?.length ?? 0);
    this.q.upsertSession!.run(r.session, r.start, r.end ?? r.start, was ? 0 : 1, bytes - (was?.bytes ?? 0));
    this.q.upsertSpan!.run(r.session, r.span, r.seq ?? 0, r.trace, r.start, r.http ? 1 : 0, bytes, summary);
    if (http) this.q.upsertBody!.run(r.session, r.span, http);
    if (!was) this.known.set(r.session, count + 1);
  }

  /**
   * Drops the sessions least recently active, past the session or size limit. The root's sessions and
   * the sandboxes' each have their own session budget, and past the size limit the sandboxes' go first, so
   * scratch activity never pushes out the root's history. The root's newest always stays, and so does
   * the newest of all.
   */
  private applyRetention() {
    const totals = this.q.totals!.get() as { sessions: number; bytes: number };
    if (totals.sessions <= this.maxSessions && totals.bytes <= this.maxBytes) return;
    const oldest = this.q.oldest!.all() as { id: string; bytes: number }[];
    const sandboxed = (id: string) => id.includes("@");
    const count = { root: oldest.filter(s => !sandboxed(s.id)).length, sandboxed: oldest.filter(s => sandboxed(s.id)).length };
    let bytes = totals.bytes;
    const removed: string[] = [];
    this.db.transaction(() => {
      for (const kind of ["sandboxed", "root"] as const) {
        for (const s of oldest) {
          if (sandboxed(s.id) !== (kind === "sandboxed")) continue;
          if ((kind === "root" && count.root <= 1) || count.root + count.sandboxed <= 1) break;
          if (count[kind] <= this.maxSessions && bytes <= this.maxBytes) break;
          for (const t of ["bodies", "spans", "events"]) this.db.query(`DELETE FROM ${t} WHERE session = ?`).run(s.id);
          this.db.query("DELETE FROM sessions WHERE id = ?").run(s.id);
          this.known.delete(s.id);
          this.seen.delete(s.id);
          removed.push(s.id);
          count[kind]--; bytes -= s.bytes;
        }
      }
    })();
    this.db.exec("PRAGMA incremental_vacuum");
    if (removed.length) this.onRemoved(removed);
  }

  private safeSessions(): SessionInfo[] { try { return this.q.sessions!.all() as SessionInfo[]; } catch { return []; } }
  private merged(row: { summary: string; http: string | null }): SpanRecord {
    const r = JSON.parse(row.summary);
    if (row.http) r.http = JSON.parse(row.http);
    return r;
  }

  sessions(): SessionInfo[] { this.flush(); return this.safeSessions(); }
  session(id: string): SessionInfo | undefined { this.flush(); return (this.q.session!.get(id) as SessionInfo | null) ?? undefined; }
  /** A JSON array of summaries, built without parsing them, so listing stays cheap. */
  summariesJson(id: string): string { this.flush(); return `[${(this.q.summaries!.all(id) as { summary: string }[]).map(r => r.summary).join(",")}]`; }
  span(session: string, span: string): SpanRecord | undefined {
    this.flush();
    const row = this.q.one!.get(session, span) as { summary: string; http: string | null } | null;
    return row ? this.merged(row) : undefined;
  }
  httpLog(session: string, trace?: string): SpanRecord[] {
    this.flush();
    const rows = (trace ? this.q.logTrace!.all(session, trace) : this.q.log!.all(session)) as { summary: string; http: string | null }[];
    return rows.map(r => this.merged(r));
  }
  /** Every span in a session, with its bodies. */
  fullSession(id: string): SpanRecord[] { this.flush(); return (this.q.full!.all(id) as { summary: string; http: string | null }[]).map(r => this.merged(r)); }

  /** Who each token was issued to or used by, so an event that names only a token's hash names its person too. */
  private whoByToken = new Map<string, string>();
  /**
   * Keeps typed events at once, in one transaction. An event that names a token but no one gets the
   * person an earlier event named for that token.
   */
  putEvents(records: EventRecord[]) {
    if (this.closed || !records.length) return;
    if (!this.whoByToken.size) for (const r of this.db.query("SELECT who, links FROM events WHERE who IS NOT NULL").all() as { who: string; links: string }[]) for (const l of r.links.trim().split(" ")) if (l.startsWith("token:")) this.whoByToken.set(l, r.who);
    const insert = this.db.query("INSERT INTO events (session, sandbox, trace, span, service, at, kind, outcome, who, links, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    try {
      this.db.transaction(() => {
        for (const r of records) {
          const token = r.links.find(l => l.startsWith("token:"));
          if (!r.who && token) r.who = this.whoByToken.get(token);
          if (r.who && token) this.whoByToken.set(token, r.who);
          if (r.who && !r.links.includes(r.who)) r.links.push(r.who);
          r.seq = Number(insert.run(r.session, r.sandbox ?? null, r.trace, r.span ?? null, r.service, r.at, r.kind, r.outcome, r.who ?? null, ` ${r.links.join(" ")} `, JSON.stringify(r.data)).lastInsertRowid);
        }
      })();
    } catch (e) { this.counters.failures++; this.lastError = (e as Error).message; }
  }
  /** Events in order, matching every filter given: a link value matches any of an event's links. */
  events(q: EventQuery = {}, max = EVENT_PAGE_MAX): EventRecord[] {
    const where: string[] = [], args: (string | number)[] = [];
    if (q.session) { where.push("session = ?"); args.push(q.session); }
    if (q.sandbox !== undefined) { if (q.sandbox === "") where.push("sandbox IS NULL"); else { where.push("sandbox = ?"); args.push(q.sandbox); } }
    for (const [col, v] of [["kind", q.kind], ["outcome", q.outcome], ["who", q.who], ["trace", q.trace]] as const) if (v) { where.push(`${col} = ?`); args.push(v); }
    for (const [col, vs] of [["kind", q.kinds], ["outcome", q.outcomes]] as const) if (vs?.length) { where.push(`${col} IN (${vs.map(() => "?").join(", ")})`); args.push(...vs); }
    if (q.link) { where.push("instr(links, ?) > 0"); args.push(` ${q.link} `); }
    if (q.anyLink?.length) { where.push(`(${q.anyLink.map(() => "instr(links, ?) > 0").join(" OR ")})`); args.push(...q.anyLink.map(l => ` ${l} `)); }
    if (q.about) {
      where.push("(kind = 'search.returned' OR (instr(links, ' study:') = 0 AND instr(links, ' uid:') = 0) OR instr(links, ?) > 0 OR instr(links, ?) > 0)");
      args.push(` study:${q.about.study} `, q.about.uid ? ` uid:${q.about.uid} ` : ` study:${q.about.study} `);
    }
    if (q.after) { where.push("seq > ?"); args.push(q.after); }
    if (q.before) { where.push("seq < ?"); args.push(q.before); }
    const limit = Math.min(Math.max(1, q.limit ?? 500), max);
    // The newest `limit`, oldest first.
    const rows = this.db.query(`SELECT * FROM (SELECT * FROM events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY seq DESC LIMIT ${limit}) ORDER BY seq`).all(...args) as any[];
    return rows.map(r => ({ seq: r.seq, session: r.session, ...(r.sandbox ? { sandbox: r.sandbox } : {}), trace: r.trace, ...(r.span ? { span: r.span } : {}), service: r.service, at: r.at, kind: r.kind, outcome: r.outcome, ...(r.who ? { who: r.who } : {}), links: r.links.trim().split(" ").filter(Boolean), data: JSON.parse(r.data) }));
  }
  /** How long each span took, in milliseconds, for those of a session that have ended. */
  spanDurations(session: string, spans: string[]): Record<string, number> {
    if (!spans.length) return {};
    this.flush();
    const rows = this.db.query(`SELECT span, json_extract(summary, '$.end') - start AS ms FROM spans WHERE session = ? AND span IN (${spans.map(() => "?").join(", ")})`).all(session, ...spans) as { span: string; ms: number | null }[];
    return Object.fromEntries(rows.filter(r => typeof r.ms === "number").map(r => [r.span, Math.round(r.ms! * 10) / 10]));
  }
  /** The values events can be filtered by, for the activity view's choices. */
  eventFacets(sandbox?: string) {
    const by = (col: string) => (this.db.query(`SELECT DISTINCT ${col} AS v FROM events WHERE ${col} IS NOT NULL ${sandbox !== undefined ? "AND sandbox IS ?" : ""} ORDER BY v`).all(...(sandbox !== undefined ? [sandbox || null] : [])) as { v: string }[]).map(r => r.v);
    return { kinds: by("kind"), outcomes: by("outcome"), who: by("who"), sandboxes: sandbox !== undefined ? [] : by("sandbox") };
  }

  fileBytes(): number {
    if (!this.path) return 0;
    return [this.path, `${this.path}-wal`, `${this.path}-shm`].reduce((n, f) => { try { return n + statSync(f).size; } catch { return n; } }, 0);
  }
  stats() {
    this.flush();
    let totals = { sessions: 0, spans: 0, bytes: 0 };
    try { totals = this.q.totals!.get() as typeof totals; } catch { /* lastError says why. */ }
    return { mode: this.mode, path: this.path, ...totals, fileBytes: this.fileBytes(), pending: this.pending.size, limits: { sessions: this.maxSessions, spansPerSession: this.maxSpansPerSession, bytes: this.maxBytes }, ...this.counters, lastError: this.lastError };
  }

  /** Removes every trace and gives the space back. */
  clear() {
    this.pending.clear();
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.db.exec("DELETE FROM bodies; DELETE FROM spans; DELETE FROM sessions; DELETE FROM events;");
    this.whoByToken.clear();
    this.known.clear();
    this.seen.clear();
    this.db.exec("PRAGMA incremental_vacuum");
    if (this.mode === "file") this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  close() {
    if (this.closed) return;
    this.flush();
    this.closed = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.db.close();
  }
}
