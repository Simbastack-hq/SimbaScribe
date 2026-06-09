import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(__dirname, '..', 'src', 'db', 'schema.sql');
const schemaSql = readFileSync(SCHEMA_PATH, 'utf-8');

describe('schema.sql', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(schemaSql);
  });

  afterEach(() => {
    db.close();
  });

  it('creates messages and synth_state tables (and nothing else for Phase 1a)', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toEqual(['messages', 'synth_state']);
  });

  it('seeds synth_state.last_synth_run_ts to "0"', () => {
    const row = db
      .prepare("SELECT value FROM synth_state WHERE key = 'last_synth_run_ts'")
      .get() as { value: string } | undefined;
    expect(row?.value).toBe('0');
  });

  it('creates the channel_ts and ts indexes on messages', () => {
    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'messages' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);
    expect(names).toContain('idx_messages_channel_ts');
    expect(names).toContain('idx_messages_ts');
  });

  it('round-trips a full message row including JSON columns', () => {
    db.prepare(
      `INSERT INTO messages
       (id, channel_id, channel_name, guild_id, author_id, author_name, ts, content,
        reply_to_id, thread_root_id, attachments, edits, deleted_at, reactions)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      '1234567890123456789',
      '9876543210987654321',
      'engineering',
      '1111111111111111111',
      '2222222222222222222',
      'Ada',
      1700000000000,
      'haan karta hoon eod tak',
      null,
      null,
      JSON.stringify([
        { filename: 'screenshot.png', url: 'https://cdn.discord.com/x', content_type: 'image/png', size: 1234 },
      ]),
      '[]',
      null,
      JSON.stringify({ '✅': ['userA', 'userB'] }),
    );

    const row = db
      .prepare('SELECT * FROM messages WHERE id = ?')
      .get('1234567890123456789') as Record<string, unknown> | undefined;

    expect(row).toBeDefined();
    expect(row?.content).toBe('haan karta hoon eod tak');
    expect(row?.author_name).toBe('Ada');
    expect(row?.deleted_at).toBeNull();

    const attachments = JSON.parse(row?.attachments as string) as Array<{ filename: string }>;
    expect(attachments[0]?.filename).toBe('screenshot.png');

    const reactions = JSON.parse(row?.reactions as string) as Record<string, string[]>;
    expect(reactions['✅']).toEqual(['userA', 'userB']);
  });

  it('uses default empty JSON for attachments / edits / reactions when omitted', () => {
    db.prepare(
      `INSERT INTO messages (id, channel_id, channel_name, guild_id, author_id, author_name, ts)
       VALUES ('id1', 'c1', 'engineering', 'g1', 'a1', 'Sam', 1700000000000)`,
    ).run();
    const row = db.prepare('SELECT * FROM messages WHERE id = ?').get('id1') as Record<string, unknown>;
    expect(row.attachments).toBe('[]');
    expect(row.edits).toBe('[]');
    expect(row.reactions).toBe('{}');
  });

  it('enforces id PRIMARY KEY uniqueness', () => {
    const insert = db.prepare(
      `INSERT INTO messages (id, channel_id, channel_name, guild_id, author_id, author_name, ts)
       VALUES (?, 'c1', 'engineering', 'g1', 'a1', 'Sam', ?)`,
    );
    insert.run('dup-id', 1);
    expect(() => insert.run('dup-id', 2)).toThrow(/UNIQUE|PRIMARY/i);
  });

  it('is idempotent when re-applied to a populated DB', () => {
    // Insert data, then re-apply schema and verify nothing was destroyed.
    db.prepare(
      `INSERT INTO messages (id, channel_id, channel_name, guild_id, author_id, author_name, ts, content)
       VALUES ('msg1', 'c1', 'engineering', 'g1', 'a1', 'Sam', 1700000000000, 'hi')`,
    ).run();
    db.exec(schemaSql);
    const row = db.prepare('SELECT content FROM messages WHERE id = ?').get('msg1') as { content: string };
    expect(row.content).toBe('hi');
  });
});
