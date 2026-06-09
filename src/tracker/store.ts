import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  TrackerItem,
  TrackerKind,
  TrackerStatus,
  Confidence,
  HumanFlag,
  EventName,
  EventSource,
} from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(__dirname, 'schema.sql');

/** Raw tracker_items row as SQLite returns it (0/1 ints for booleans). */
interface RawItemRow {
  id: number;
  kind: string;
  text: string;
  owner: string | null;
  owner_id: string | null;
  status: string;
  confidence: string;
  blocked: number;
  human_flag: string | null;
  source_msg_id: string;
  source_url: string;
  created_at: number;
  last_seen_at: number;
  resolved_at: number | null;
  resolved_msg_id: string | null;
  resolved_url: string | null;
  resolved_by: string | null;
  needs_review: number;
  superseded_by: number | null;
  resurfaced_at: number | null;
  digest_msg_id: string | null;
  digest_msg_kind: string | null;
}

function rowToItem(r: RawItemRow): TrackerItem {
  return {
    id: r.id,
    kind: r.kind as TrackerKind,
    text: r.text,
    owner: r.owner,
    owner_id: r.owner_id,
    status: r.status as TrackerStatus,
    confidence: r.confidence as Confidence,
    blocked: r.blocked === 1,
    human_flag: r.human_flag as HumanFlag | null,
    source_msg_id: r.source_msg_id,
    source_url: r.source_url,
    created_at: r.created_at,
    last_seen_at: r.last_seen_at,
    resolved_at: r.resolved_at,
    resolved_msg_id: r.resolved_msg_id,
    resolved_url: r.resolved_url,
    resolved_by: r.resolved_by,
    needs_review: r.needs_review === 1,
    superseded_by: r.superseded_by,
    resurfaced_at: r.resurfaced_at,
    digest_msg_id: r.digest_msg_id,
    digest_msg_kind: r.digest_msg_kind,
  };
}

/** Event context every state-changing mutator records alongside the change. */
export interface EventCtx {
  source: EventSource;
  ts: number;
  synthRunId?: number | null;
  detail?: Record<string, unknown>;
}

export interface CreateItemInput {
  kind: TrackerKind;
  text: string;
  owner: string | null;
  owner_id: string | null;
  confidence: Confidence;
  blocked: boolean;
  source_msg_id: string;
  source_url: string;
}

export interface ResolveInput {
  status: Extract<TrackerStatus, 'done' | 'answered' | 'superseded'>;
  event: Extract<EventName, 'closed' | 'answered' | 'superseded'>;
  resolved_msg_id: string;
  resolved_url: string;
  resolved_by: string | null;
}

const ITEM_COLS =
  'id, kind, text, owner, owner_id, status, confidence, blocked, human_flag, source_msg_id, source_url, created_at, last_seen_at, resolved_at, resolved_msg_id, resolved_url, resolved_by, needs_review, superseded_by, resurfaced_at, digest_msg_id, digest_msg_kind';

/**
 * Opens (or creates) the writable tracker DB, applies the schema idempotently,
 * and returns a typed API. WAL + the same pragmas as the corpus client.
 *
 * Every state-changing mutator writes the item change AND its tracker_events
 * row in ONE transaction, so the audit log can never disagree with item state.
 */
export function openTrackerDb(dbPath: string) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.exec(readFileSync(SCHEMA_PATH, 'utf-8'));

  // Migration: CREATE TABLE IF NOT EXISTS won't add a column to a pre-existing
  // tracker.db, so add digest_msg_kind here if it's missing (idempotent).
  const cols = db.prepare(`PRAGMA table_info(tracker_items)`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'digest_msg_kind')) {
    db.exec(`ALTER TABLE tracker_items ADD COLUMN digest_msg_kind TEXT`);
    // Any binding that predates the kind column has no interpretable semantic.
    // Clear it so a legacy ✅/❌ can never be misread (the item simply gets a
    // fresh, known-kind prompt the next time it surfaces).
    db.exec(
      `UPDATE tracker_items SET digest_msg_id = NULL WHERE digest_msg_id IS NOT NULL AND digest_msg_kind IS NULL`,
    );
  }

  const insertEventStmt = db.prepare(
    `INSERT INTO tracker_events (item_id, ts, event, source, detail, synth_run_id)
     VALUES (@item_id, @ts, @event, @source, @detail, @synth_run_id)`,
  );
  function recordEvent(itemId: number, event: EventName, ctx: EventCtx): void {
    insertEventStmt.run({
      item_id: itemId,
      ts: ctx.ts,
      event,
      source: ctx.source,
      detail: ctx.detail === undefined ? null : JSON.stringify(ctx.detail),
      synth_run_id: ctx.synthRunId ?? null,
    });
  }

  const insertItemStmt = db.prepare(`
    INSERT INTO tracker_items
      (kind, text, owner, owner_id, status, confidence, blocked, source_msg_id,
       source_url, created_at, last_seen_at, needs_review)
    VALUES
      (@kind, @text, @owner, @owner_id, 'open', @confidence, @blocked, @source_msg_id,
       @source_url, @ts, @ts, 0)
  `);
  const getItemStmt = db.prepare(`SELECT ${ITEM_COLS} FROM tracker_items WHERE id = ?`);
  const bumpLastSeenStmt = db.prepare(
    // >= so a touch in the same run/ms as a resurface still counts as "active
    // again" and clears the flag (otherwise it could later archive as untouched).
    `UPDATE tracker_items SET last_seen_at = @ts,
       resurfaced_at = CASE WHEN @ts >= resurfaced_at THEN NULL ELSE resurfaced_at END
     WHERE id = @id`,
  );
  const resolveStmt = db.prepare(`
    UPDATE tracker_items
       SET status = @status, needs_review = 0, resolved_at = @ts,
           resolved_msg_id = @resolved_msg_id, resolved_url = @resolved_url, resolved_by = @resolved_by
     WHERE id = @id
  `);
  const flagReviewStmt = db.prepare(`UPDATE tracker_items SET needs_review = 1 WHERE id = @id`);
  const setStatusStmt = db.prepare(`UPDATE tracker_items SET status = @status WHERE id = @id`);
  const setHumanFlagStmt = db.prepare(`UPDATE tracker_items SET human_flag = @flag WHERE id = @id`);
  const clearResolvedStmt = db.prepare(
    `UPDATE tracker_items SET resolved_at = NULL, resolved_msg_id = NULL, resolved_url = NULL, resolved_by = NULL, needs_review = 0 WHERE id = @id`,
  );
  const resurfaceStmt = db.prepare(`UPDATE tracker_items SET resurfaced_at = @ts WHERE id = @id`);
  const setDigestMsgIdStmt = db.prepare(
    `UPDATE tracker_items SET digest_msg_id = @digest_msg_id, digest_msg_kind = @digest_msg_kind WHERE id = @id`,
  );
  // Keep-open ("still open" ❌) counts as ACTIVITY: clear the review flag AND
  // reset the aging clock (last_seen_at + resurfaced_at), so the item the human
  // just said to keep can't be archived by the aging pass that runs right after.
  const clearReviewStmt = db.prepare(
    `UPDATE tracker_items SET needs_review = 0, last_seen_at = @ts, resurfaced_at = NULL WHERE id = @id`,
  );

  function requireItem(id: number): RawItemRow {
    const row = getItemStmt.get(id) as RawItemRow | undefined;
    if (row === undefined) throw new Error(`tracker item ${id} does not exist`);
    return row;
  }

  const createItem = db.transaction((input: CreateItemInput, ctx: EventCtx): number => {
    const info = insertItemStmt.run({
      kind: input.kind,
      text: input.text,
      owner: input.owner,
      owner_id: input.owner_id,
      confidence: input.confidence,
      blocked: input.blocked ? 1 : 0,
      source_msg_id: input.source_msg_id,
      source_url: input.source_url,
      ts: ctx.ts,
    });
    const id = Number(info.lastInsertRowid);
    recordEvent(id, 'created', ctx);
    return id;
  });

  const touchItem = db.transaction((id: number, ctx: EventCtx): void => {
    requireItem(id);
    bumpLastSeenStmt.run({ id, ts: ctx.ts });
    recordEvent(id, 'touched', ctx);
  });

  const resolveItem = db.transaction((id: number, res: ResolveInput, ctx: EventCtx): void => {
    requireItem(id);
    resolveStmt.run({
      id,
      status: res.status,
      ts: ctx.ts,
      resolved_msg_id: res.resolved_msg_id,
      resolved_url: res.resolved_url,
      resolved_by: res.resolved_by,
    });
    recordEvent(id, res.event, ctx);
  });

  const flagReview = db.transaction((id: number, ctx: EventCtx): void => {
    requireItem(id);
    flagReviewStmt.run({ id });
    recordEvent(id, 'flagged_review', ctx);
  });

  // Human override (✅/❌). Always wins over the model and is sticky. 'pinned'
  // protects from aging + ranks top (no status change). 'dismissed' suppresses.
  // 'reopened' reverts a (wrong) close back to open.
  const applyHumanFlag = db.transaction((id: number, flag: HumanFlag, ctx: EventCtx): void => {
    requireItem(id);
    setHumanFlagStmt.run({ id, flag });
    let event: EventName;
    if (flag === 'dismissed') {
      setStatusStmt.run({ id, status: 'dismissed' });
      event = 'dismissed';
    } else if (flag === 'reopened') {
      setStatusStmt.run({ id, status: 'open' });
      clearResolvedStmt.run({ id });
      event = 'reopened';
    } else {
      event = 'pinned';
    }
    recordEvent(id, event, ctx);
  });

  const resurfaceItem = db.transaction((id: number, ctx: EventCtx): void => {
    requireItem(id);
    resurfaceStmt.run({ id, ts: ctx.ts });
    recordEvent(id, 'resurfaced', ctx);
  });

  const archiveItem = db.transaction((id: number, ctx: EventCtx): void => {
    requireItem(id);
    setStatusStmt.run({ id, status: 'archived' });
    recordEvent(id, 'auto_archived', ctx);
  });

  return {
    raw: db,

    getItem(id: number): TrackerItem | undefined {
      const row = getItemStmt.get(id) as RawItemRow | undefined;
      return row === undefined ? undefined : rowToItem(row);
    },

    /** Open items (status='open'), optionally one kind, oldest-touched first. */
    listOpen(kind?: TrackerKind): TrackerItem[] {
      const rows = (
        kind === undefined
          ? db.prepare(`SELECT ${ITEM_COLS} FROM tracker_items WHERE status = 'open' ORDER BY last_seen_at ASC`).all()
          : db
              .prepare(
                `SELECT ${ITEM_COLS} FROM tracker_items WHERE status = 'open' AND kind = ? ORDER BY last_seen_at ASC`,
              )
              .all(kind)
      ) as RawItemRow[];
      return rows.map(rowToItem);
    },

    /** Open todos for an owner — backs "what's on my plate?". */
    listOpenByOwner(ownerId: string): TrackerItem[] {
      const rows = db
        .prepare(
          `SELECT ${ITEM_COLS} FROM tracker_items
           WHERE status = 'open' AND owner_id = ? ORDER BY blocked DESC, last_seen_at ASC`,
        )
        .all(ownerId) as RawItemRow[];
      return rows.map(rowToItem);
    },

    /** source_msg_ids of all open items — feeds the edit/delete source re-check. */
    openSourceMsgIds(): string[] {
      const rows = db
        .prepare(`SELECT DISTINCT source_msg_id FROM tracker_items WHERE status = 'open'`)
        .all() as Array<{ source_msg_id: string }>;
      return rows.map((r) => r.source_msg_id);
    },

    eventsFor(itemId: number): Array<{ event: string; ts: number; source: string; detail: string | null }> {
      return db
        .prepare(`SELECT event, ts, source, detail FROM tracker_events WHERE item_id = ? ORDER BY ts ASC, id ASC`)
        .all(itemId) as Array<{ event: string; ts: number; source: string; detail: string | null }>;
    },

    getState(key: string): string | undefined {
      const row = db.prepare(`SELECT value FROM tracker_state WHERE key = ?`).get(key) as
        | { value: string }
        | undefined;
      return row?.value;
    },
    setState(key: string, value: string): void {
      db.prepare(
        `INSERT INTO tracker_state (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(key, value);
    },

    createItem,
    touchItem,
    resolveItem,
    flagReview,
    applyHumanFlag,
    resurfaceItem,
    archiveItem,

    setDigestMsgId(id: number, digestMsgId: string, kind: string): void {
      requireItem(id);
      setDigestMsgIdStmt.run({ id, digest_msg_id: digestMsgId, digest_msg_kind: kind });
    },

    /** Clear a "looks done?" review flag, keeping the item OPEN (the human said
     *  "not done"). Records a 'reopened' event. No human_flag is set, so the item
     *  can be re-surfaced / re-decided later (unlike a sticky pin/dismiss). */
    clearReview: db.transaction((id: number, ctx: EventCtx): void => {
      requireItem(id);
      clearReviewStmt.run({ id, ts: ctx.ts });
      recordEvent(id, 'reopened', ctx);
    }),

    close(): void {
      db.close();
    },
  };
}

export type TrackerDb = ReturnType<typeof openTrackerDb>;
