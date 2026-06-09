import Database from 'better-sqlite3';
import { effectiveContent } from '../db/content.js';

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

/** A corpus message as exposed to the agent — effective (edited) content,
 *  parsed reaction counts, and a prebuilt Discord deep link for citation. */
export interface CorpusMessage {
  id: string;
  channel_id: string;
  channel_name: string;
  guild_id: string;
  author_id: string;
  author_name: string;
  ts: number;
  content: string;
  reactions: Record<string, number>;
  reply_to_id: string | null;
  thread_root_id: string | null;
  url: string;
}

export interface ChannelSummary {
  channel_id: string;
  channel_name: string;
  message_count: number;
  last_ts: number;
}

export interface MessageWithContext {
  message: CorpusMessage;
  /** The message this one replied to (if any and not deleted), for citation context. */
  replied_to: CorpusMessage | null;
}

interface RawRow {
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
  reply_to_id: string | null;
  thread_root_id: string | null;
}

const ROW_COLS =
  'id, channel_id, channel_name, guild_id, author_id, author_name, ts, content, edits, reactions, reply_to_id, thread_root_id';

/**
 * Opens the read-only corpus snapshot, runs `fn`, and always closes.
 *
 * Open per call (not once at startup) on purpose: the snapshot is published by
 * a cron (`VACUUM INTO` + atomic rename) that swaps a fresh file over the old
 * one. A long-lived handle would pin the old inode and serve stale data until
 * restart; a fresh open per request always sees the latest snapshot.
 * `fileMustExist` makes a missing snapshot fail loud rather than silently
 * creating an empty DB. No WAL pragma — the snapshot is a standalone
 * rollback-journal file with no -wal/-shm sidecar (see src/snapshot).
 */
export function withSnapshot<T>(path: string, fn: (db: Database.Database) => T): T {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** Clamps a caller-supplied limit into [1, MAX_LIMIT]; undefined/NaN -> default. */
export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  const n = Math.trunc(limit);
  if (n < 1) return 1;
  if (n > MAX_LIMIT) return MAX_LIMIT;
  return n;
}

/** Escapes LIKE metacharacters (and the escape char) for use with ESCAPE '\'. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function discordUrl(guildId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

// Fail soft on purpose: a single corrupt historical reactions blob must not
// break a whole query feeding the agent. Returns {} rather than throwing.
// (Mirrors effectiveContent's tolerance in src/db/content.ts — do not "fix"
// this into a throw.)
function parseReactionCounts(raw: string): Record<string, number> {
  try {
    const obj = JSON.parse(raw) as unknown;
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return {};
    const out: Record<string, number> = {};
    for (const [emoji, users] of Object.entries(obj as Record<string, unknown>)) {
      out[emoji] = Array.isArray(users) ? users.length : 0;
    }
    return out;
  } catch {
    return {};
  }
}

function toMessage(r: RawRow): CorpusMessage {
  return {
    id: r.id,
    channel_id: r.channel_id,
    channel_name: r.channel_name,
    guild_id: r.guild_id,
    author_id: r.author_id,
    author_name: r.author_name,
    ts: r.ts,
    content: effectiveContent(r),
    reactions: parseReactionCounts(r.reactions),
    reply_to_id: r.reply_to_id,
    thread_root_id: r.thread_root_id,
    url: discordUrl(r.guild_id, r.channel_id, r.id),
  };
}

function pushChannelFilter(
  channel: string | undefined,
  where: string[],
  params: Record<string, unknown>,
): void {
  if (channel !== undefined) {
    where.push('(channel_name = @channel OR channel_id = @channel)');
    params.channel = channel;
  }
}

export function listChannels(db: Database.Database): ChannelSummary[] {
  return db
    .prepare(
      `SELECT channel_id, channel_name, COUNT(*) AS message_count, MAX(ts) AS last_ts
       FROM messages WHERE deleted_at IS NULL
       GROUP BY channel_id, channel_name
       ORDER BY last_ts DESC`,
    )
    .all() as ChannelSummary[];
}

export function recentMessages(
  db: Database.Database,
  opts: { channel?: string; limit?: number },
): CorpusMessage[] {
  const where = ['deleted_at IS NULL'];
  const params: Record<string, unknown> = { limit: clampLimit(opts.limit) };
  pushChannelFilter(opts.channel, where, params);
  const rows = db
    .prepare(
      `SELECT ${ROW_COLS} FROM messages WHERE ${where.join(' AND ')} ORDER BY ts DESC LIMIT @limit`,
    )
    .all(params) as RawRow[];
  return rows.map(toMessage);
}

export function searchMessages(
  db: Database.Database,
  opts: { query: string; channel?: string; limit?: number },
): CorpusMessage[] {
  // Searches ORIGINAL content only. Text that exists solely in a later edit is
  // not matched (edits are stored as JSON). Recall is original-content-based.
  // Rows with NULL content never match. Documented limitation; FTS deferred.
  const where = ['deleted_at IS NULL', "content LIKE @pattern ESCAPE '\\'"];
  const params: Record<string, unknown> = {
    pattern: `%${escapeLike(opts.query)}%`,
    limit: clampLimit(opts.limit),
  };
  pushChannelFilter(opts.channel, where, params);
  const rows = db
    .prepare(
      `SELECT ${ROW_COLS} FROM messages WHERE ${where.join(' AND ')} ORDER BY ts DESC LIMIT @limit`,
    )
    .all(params) as RawRow[];
  return rows.map(toMessage);
}

export function messagesInWindow(
  db: Database.Database,
  opts: { startTs: number; endTs: number; channel?: string; limit?: number },
): CorpusMessage[] {
  if (opts.startTs > opts.endTs) {
    throw new Error(`startTs (${opts.startTs}) must be <= endTs (${opts.endTs})`);
  }
  const where = ['deleted_at IS NULL', 'ts >= @startTs', 'ts <= @endTs'];
  const params: Record<string, unknown> = {
    startTs: opts.startTs,
    endTs: opts.endTs,
    limit: clampLimit(opts.limit),
  };
  pushChannelFilter(opts.channel, where, params);
  const rows = db
    .prepare(
      `SELECT ${ROW_COLS} FROM messages WHERE ${where.join(' AND ')} ORDER BY ts ASC LIMIT @limit`,
    )
    .all(params) as RawRow[];
  return rows.map(toMessage);
}

export function getMessage(db: Database.Database, id: string): MessageWithContext | null {
  const stmt = db.prepare(
    `SELECT ${ROW_COLS} FROM messages WHERE id = @id AND deleted_at IS NULL`,
  );
  const row = stmt.get({ id }) as RawRow | undefined;
  if (!row) return null;
  let replied_to: CorpusMessage | null = null;
  if (row.reply_to_id) {
    const parent = stmt.get({ id: row.reply_to_id }) as RawRow | undefined;
    if (parent) replied_to = toMessage(parent);
  }
  return { message: toMessage(row), replied_to };
}
