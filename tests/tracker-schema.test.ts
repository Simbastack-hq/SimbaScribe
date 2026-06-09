import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(__dirname, '..', 'src', 'tracker', 'schema.sql');
const schemaSql = readFileSync(SCHEMA_PATH, 'utf-8');

describe('tracker/schema.sql', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(schemaSql);
  });
  afterEach(() => db.close());

  it('creates the three tracker tables', () => {
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{
        name: string;
      }>
    ).map((t) => t.name);
    expect(tables).toContain('tracker_items');
    expect(tables).toContain('tracker_events');
    expect(tables).toContain('tracker_state');
  });

  it('is idempotent when re-applied to populated data', () => {
    db.prepare(
      `INSERT INTO tracker_items (kind, text, status, confidence, source_msg_id, source_url, created_at, last_seen_at)
       VALUES ('todo','x','open','high','m1','u1',1,1)`,
    ).run();
    db.exec(schemaSql);
    const row = db.prepare('SELECT text FROM tracker_items WHERE source_msg_id = ?').get('m1') as
      | { text: string }
      | undefined;
    expect(row?.text).toBe('x');
  });

  it('enforces digest_msg_id uniqueness but allows many NULLs', () => {
    const ins = db.prepare(
      `INSERT INTO tracker_items (kind, text, status, confidence, source_msg_id, source_url, created_at, last_seen_at, digest_msg_id)
       VALUES ('todo','x','open','high','m','u',1,1, ?)`,
    );
    ins.run(null);
    ins.run(null); // multiple NULLs fine
    ins.run('D1');
    expect(() => ins.run('D1')).toThrow(/UNIQUE/i);
  });

  it('does NOT constrain source_msg_id (one message can spawn several items)', () => {
    const ins = db.prepare(
      `INSERT INTO tracker_items (kind, text, status, confidence, source_msg_id, source_url, created_at, last_seen_at)
       VALUES ('todo', ?, 'open','high','same-msg','u',1,1)`,
    );
    ins.run('ada deploy');
    expect(() => ins.run('ben deploy')).not.toThrow();
  });
});
