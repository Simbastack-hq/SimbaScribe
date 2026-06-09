import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(__dirname, 'schema.sql');

export interface MessageRow {
  id: string;
  channel_id: string;
  channel_name: string;
  guild_id: string;
  author_id: string;
  author_name: string;
  ts: number;
  content: string | null;
  reply_to_id: string | null;
  thread_root_id: string | null;
  attachments: string;
  edits: string;
  deleted_at: number | null;
  reactions: string;
}

export interface MessageStateRow {
  id: string;
  content: string | null;
  edits: string;
  reactions: string;
}

/**
 * Opens (or creates) the SQLite DB at `dbPath`, applies the schema if needed,
 * and returns a typed API over prepared statements.
 *
 * All writes are synchronous (better-sqlite3 is synchronous by design).
 * WAL mode is enabled for concurrent-reader safety with the future synth process.
 */
export function openDb(dbPath: string) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  const schemaSql = readFileSync(SCHEMA_PATH, 'utf-8');
  db.exec(schemaSql);

  const insertMessageStmt = db.prepare(`
    INSERT INTO messages (id, channel_id, channel_name, guild_id, author_id, author_name,
                          ts, content, reply_to_id, thread_root_id, attachments, edits,
                          deleted_at, reactions)
    VALUES (@id, @channel_id, @channel_name, @guild_id, @author_id, @author_name,
            @ts, @content, @reply_to_id, @thread_root_id, @attachments, @edits,
            @deleted_at, @reactions)
    ON CONFLICT(id) DO NOTHING
  `);

  const appendEditStmt = db.prepare(`
    UPDATE messages SET edits = @edits WHERE id = @id
  `);

  const markDeletedStmt = db.prepare(`
    UPDATE messages SET deleted_at = @deletedAt
    WHERE id = @id AND deleted_at IS NULL
  `);

  const upsertReactionsStmt = db.prepare(`
    UPDATE messages SET reactions = @reactions WHERE id = @id
  `);

  const getLastTsStmt = db.prepare(`
    SELECT MAX(ts) AS max_ts FROM messages WHERE channel_id = @channelId
  `);

  const getMessageStateStmt = db.prepare(`
    SELECT id, content, edits, reactions FROM messages WHERE id = @id
  `);

  const insertBatchTxn = db.transaction((rows: MessageRow[]) => {
    for (const row of rows) {
      insertMessageStmt.run(row);
    }
  });

  const markDeletedBulkTxn = db.transaction((ids: string[], deletedAt: number) => {
    for (const id of ids) {
      markDeletedStmt.run({ id, deletedAt });
    }
  });

  return {
    raw: db,

    insertMessage(row: MessageRow): void {
      insertMessageStmt.run(row);
    },

    insertMessagesBatch(rows: MessageRow[]): void {
      if (rows.length === 0) return;
      insertBatchTxn(rows);
    },

    appendEdit(id: string, edits: string): void {
      appendEditStmt.run({ id, edits });
    },

    markDeleted(id: string, deletedAt: number): void {
      markDeletedStmt.run({ id, deletedAt });
    },

    markDeletedBulk(ids: string[], deletedAt: number): void {
      if (ids.length === 0) return;
      markDeletedBulkTxn(ids, deletedAt);
    },

    upsertReactions(id: string, reactions: string): void {
      upsertReactionsStmt.run({ id, reactions });
    },

    getLastTsForChannel(channelId: string): number | null {
      const row = getLastTsStmt.get({ channelId }) as { max_ts: number | null } | undefined;
      return row?.max_ts ?? null;
    },

    getMessageState(id: string): MessageStateRow | undefined {
      return getMessageStateStmt.get({ id }) as MessageStateRow | undefined;
    },

    close(): void {
      db.close();
    },
  };
}

export type Db = ReturnType<typeof openDb>;
