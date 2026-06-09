import type { Db } from '../db/client.js';

const SYNTH_RUNS_DDL = `
CREATE TABLE IF NOT EXISTS synth_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  window_start_rowid INTEGER,
  window_end_rowid INTEGER,
  messages_processed INTEGER NOT NULL,
  posted INTEGER NOT NULL DEFAULT 0,
  digest_text TEXT,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  error TEXT
);
`;

const ROWID_KEY = 'last_synth_rowid';

export interface WindowMessage {
  rowid: number;
  id: string;
  channel_id: string;
  channel_name: string;
  guild_id: string;
  author_id: string;
  author_name: string;
  ts: number;
  content: string | null;
  edits: string;
  reactions: string;
}

export interface SynthRunRow {
  id: number;
  posted: number;
  digest_text: string | null;
  error: string | null;
}

// author_id is included for the tracker reconcile (owner identity); the digest
// formatter (window.ts) ignores it, so the digest output is unchanged.
const WINDOW_COLS =
  'rowid, id, channel_id, channel_name, guild_id, author_id, author_name, ts, content, edits, reactions';

export function ensureSynthSchema(db: Db): void {
  db.raw.exec(SYNTH_RUNS_DDL);
}

export function getRowidWatermark(db: Db): number | null {
  const row = db.raw
    .prepare(`SELECT value FROM synth_state WHERE key = ?`)
    .get(ROWID_KEY) as { value: string } | undefined;
  return row === undefined ? null : Number(row.value);
}

export function setRowidWatermark(db: Db, rowid: number): void {
  db.raw
    .prepare(
      `INSERT INTO synth_state (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(ROWID_KEY, String(rowid));
}

export function getMaxMessageRowid(db: Db): number {
  const row = db.raw.prepare(`SELECT MAX(rowid) AS m FROM messages`).get() as {
    m: number | null;
  };
  return row.m ?? 0;
}

/** New-since-last-run window, keyed on insertion order (rowid), not message ts —
 *  so backfilled messages (old ts, inserted later) are still picked up. */
export function readWindowByRowid(db: Db, lastRowid: number): WindowMessage[] {
  return db.raw
    .prepare(
      `SELECT ${WINDOW_COLS} FROM messages
       WHERE rowid > ? AND deleted_at IS NULL
       ORDER BY channel_name, ts`,
    )
    .all(lastRowid) as WindowMessage[];
}

/** Explicit ts window, for --window-start/--window-end manual testing (dry-run only). */
export function readWindowByTs(db: Db, startTs: number, endTs: number): WindowMessage[] {
  return db.raw
    .prepare(
      `SELECT ${WINDOW_COLS} FROM messages
       WHERE ts > ? AND ts <= ? AND deleted_at IS NULL
       ORDER BY channel_name, ts`,
    )
    .all(startTs, endTs) as WindowMessage[];
}

export function getLatestRun(db: Db): SynthRunRow | undefined {
  return db.raw
    .prepare(`SELECT id, posted, digest_text, error FROM synth_runs ORDER BY id DESC LIMIT 1`)
    .get() as SynthRunRow | undefined;
}

export interface NewRun {
  startedAt: number;
  windowStartRowid: number | null;
  windowEndRowid: number | null;
  messagesProcessed: number;
  digestText: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

/** Inserts an audit row with posted=0, ended_at=null. Returns its id. */
export function insertRun(db: Db, r: NewRun): number {
  const info = db.raw
    .prepare(
      `INSERT INTO synth_runs
         (started_at, window_start_rowid, window_end_rowid, messages_processed,
          posted, digest_text, model, input_tokens, output_tokens)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    )
    .run(
      r.startedAt,
      r.windowStartRowid,
      r.windowEndRowid,
      r.messagesProcessed,
      r.digestText,
      r.model,
      r.inputTokens,
      r.outputTokens,
    );
  return Number(info.lastInsertRowid);
}

/** Posted successfully: mark posted=1 and advance the watermark, atomically. */
export function markPostedAndAdvance(
  db: Db,
  runId: number,
  endedAt: number,
  newWatermark: number,
): void {
  const txn = db.raw.transaction(() => {
    db.raw.prepare(`UPDATE synth_runs SET posted = 1, ended_at = ? WHERE id = ?`).run(endedAt, runId);
    setRowidWatermark(db, newWatermark);
  });
  txn();
}

/** SKIP_POST (no signal): advance the watermark without marking posted. */
export function markSkippedAndAdvance(
  db: Db,
  runId: number,
  endedAt: number,
  newWatermark: number,
): void {
  const txn = db.raw.transaction(() => {
    db.raw.prepare(`UPDATE synth_runs SET ended_at = ? WHERE id = ?`).run(endedAt, runId);
    setRowidWatermark(db, newWatermark);
  });
  txn();
}

/** Failure: record the error, do NOT advance the watermark (next run retries). */
export function markError(db: Db, runId: number, endedAt: number, error: string): void {
  db.raw
    .prepare(`UPDATE synth_runs SET ended_at = ?, error = ? WHERE id = ?`)
    .run(endedAt, error, runId);
}

/**
 * Partial post: some chunks delivered, then a chunk failed. Mark posted=1 (we
 * DID post) AND advance the watermark — re-running would re-post the delivered
 * chunks (duplicate in a public channel). Record the error note so the lost
 * tail is visible; the full digest stays in digest_text for manual recovery.
 */
export function markPartialAndAdvance(
  db: Db,
  runId: number,
  endedAt: number,
  newWatermark: number,
  note: string,
): void {
  const txn = db.raw.transaction(() => {
    db.raw
      .prepare(`UPDATE synth_runs SET posted = 1, ended_at = ?, error = ? WHERE id = ?`)
      .run(endedAt, note, runId);
    setRowidWatermark(db, newWatermark);
  });
  txn();
}
