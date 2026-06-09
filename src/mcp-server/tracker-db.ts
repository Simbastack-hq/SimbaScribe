import Database from 'better-sqlite3';

// Read-only query layer over the tracker SNAPSHOT (tracker-snapshot.db), the
// VACUUM INTO copy of the writable tracker.db. Mirrors mcp-server/db.ts: open
// read-only per request, clamp limits, no LLM, pure SQL. The agent (Pulse) reads
// the team's tracked todos/ideas/decisions through this; it never writes.
//
// INDEPENDENCE (spec §4): a missing/foreign tracker snapshot must degrade ONLY
// the tracker_* tools — it must never break the corpus tools or take down the
// MCP server at startup. Hence withTrackerSnapshot throws a clear, catchable
// error rather than being probed at boot.

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

export type TrackerKind = 'todo' | 'idea' | 'decision' | 'question';
export type TrackerStatus =
  | 'open'
  | 'done'
  | 'answered'
  | 'superseded'
  | 'dismissed'
  | 'archived';

/** A tracked item as exposed to the agent (booleans decoded, citation url present). */
export interface TrackerItemView {
  id: number;
  kind: TrackerKind;
  text: string;
  owner: string | null;
  owner_id: string | null;
  status: TrackerStatus;
  confidence: 'high' | 'low';
  blocked: boolean;
  pinned: boolean;
  needs_review: boolean;
  source_url: string;
  created_at: number;
  last_seen_at: number;
  resolved_at: number | null;
  resolved_url: string | null;
}

export interface TrackerEventView {
  event: string;
  ts: number;
  source: string;
  detail: string | null;
}

export interface TrackerItemDetail extends TrackerItemView {
  events: TrackerEventView[];
}

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
  needs_review: number;
  source_url: string;
  created_at: number;
  last_seen_at: number;
  resolved_at: number | null;
  resolved_url: string | null;
}

const ITEM_COLS =
  'id, kind, text, owner, owner_id, status, confidence, blocked, human_flag, needs_review, source_url, created_at, last_seen_at, resolved_at, resolved_url';

/**
 * Opens the read-only tracker snapshot, runs `fn`, always closes. Open per call
 * (the snapshot is atomically swapped by the cron). `fileMustExist` makes a
 * missing snapshot fail loud — callers in index.ts catch it and return a clear
 * "tracker unavailable" tool error, so the corpus tools are unaffected.
 */
export function withTrackerSnapshot<T>(path: string, fn: (db: Database.Database) => T): T {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

export type TrackerReadResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/**
 * Graceful-degradation wrapper used by the MCP server: resolve the tracker
 * snapshot path from its env value, run `fn`, and turn an unset path or any open
 * failure into a clear `{ ok: false, error }` instead of throwing. This is the
 * §4 independence guarantee in one place — the tracker_* tools degrade to a
 * "tracker unavailable" message while the corpus tools are wholly unaffected.
 * Returned as a result (not an MCP envelope) so it's unit-testable without the
 * server; index.ts maps it to ok()/err().
 */
export function readTracker<T>(
  pathEnvValue: string | undefined,
  fn: (db: Database.Database) => T,
): TrackerReadResult<T> {
  const path = pathEnvValue?.trim();
  if (!path) {
    return { ok: false, error: 'tracker unavailable: SIMBASCRIBE_TRACKER_SNAPSHOT_DB_PATH is not set' };
  }
  try {
    return { ok: true, value: withTrackerSnapshot(path, fn) };
  } catch (e) {
    return { ok: false, error: `tracker unavailable: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  const n = Math.trunc(limit);
  if (n < 1) return 1;
  if (n > MAX_LIMIT) return MAX_LIMIT;
  return n;
}

function rowToView(r: RawItemRow): TrackerItemView {
  return {
    id: r.id,
    kind: r.kind as TrackerKind,
    text: r.text,
    owner: r.owner,
    owner_id: r.owner_id,
    status: r.status as TrackerStatus,
    confidence: r.confidence === 'low' ? 'low' : 'high',
    blocked: r.blocked === 1,
    pinned: r.human_flag === 'pinned',
    needs_review: r.needs_review === 1,
    source_url: r.source_url,
    created_at: r.created_at,
    last_seen_at: r.last_seen_at,
    resolved_at: r.resolved_at,
    resolved_url: r.resolved_url,
  };
}

export interface ListOpts {
  kind?: TrackerKind;
  owner?: string;
  status?: TrackerStatus;
  blocked?: boolean;
  limit?: number;
}

/**
 * List tracked items. Defaults to OPEN items only (the live list); pass an
 * explicit `status` to see closed/archived/etc. Ranked: pinned first, then
 * blocked, then high-confidence, then most-recently-seen. `owner` matches the
 * stable owner_id OR the canonical display name — backs "what's on my plate?".
 */
export function listItems(db: Database.Database, opts: ListOpts): TrackerItemView[] {
  const where: string[] = [];
  const params: Record<string, unknown> = { limit: clampLimit(opts.limit) };

  // Default view is the live (open) list; an explicit status overrides.
  where.push('status = @status');
  params.status = opts.status ?? 'open';

  if (opts.kind !== undefined) {
    where.push('kind = @kind');
    params.kind = opts.kind;
  }
  if (opts.owner !== undefined) {
    where.push('(owner_id = @owner OR owner = @owner)');
    params.owner = opts.owner;
  }
  if (opts.blocked !== undefined) {
    where.push('blocked = @blocked');
    params.blocked = opts.blocked ? 1 : 0;
  }

  const rows = db
    .prepare(
      `SELECT ${ITEM_COLS} FROM tracker_items
       WHERE ${where.join(' AND ')}
       ORDER BY (human_flag = 'pinned') DESC, blocked DESC,
                (confidence = 'high') DESC, last_seen_at DESC
       LIMIT @limit`,
    )
    .all(params) as RawItemRow[];
  return rows.map(rowToView);
}

/** One item plus its full event history ("why is this here / when did it close"). */
export function getItem(db: Database.Database, id: number): TrackerItemDetail | null {
  const row = db.prepare(`SELECT ${ITEM_COLS} FROM tracker_items WHERE id = ?`).get(id) as
    | RawItemRow
    | undefined;
  if (!row) return null;
  const events = db
    .prepare(
      `SELECT event, ts, source, detail FROM tracker_events
       WHERE item_id = ? ORDER BY ts ASC, id ASC`,
    )
    .all(id) as TrackerEventView[];
  return { ...rowToView(row), events };
}
