import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDb, type MessageRow } from '../src/db/client.js';
import { publishSnapshot } from '../src/snapshot/index.js';

let dir: string;
let livePath: string;
let destDir: string;
let destPath: string;

function row(over: Partial<MessageRow>): MessageRow {
  return {
    id: Math.random().toString(36).slice(2),
    channel_id: 'c1',
    channel_name: 'engineering',
    guild_id: 'g1',
    author_id: 'a1',
    author_name: 'Sam',
    ts: 100,
    content: 'alive',
    reply_to_id: null,
    thread_root_id: null,
    attachments: '[]',
    edits: '[]',
    deleted_at: null,
    reactions: '{}',
    ...over,
  };
}

function seedLive(): void {
  const db = openDb(livePath); // WAL mode, like production
  db.insertMessage(row({ id: 'm1', content: 'alive', ts: 100 }));
  db.insertMessage(row({ id: 'm2', content: 'deleted one', ts: 200, deleted_at: 999 }));
  db.close();
}

function sidecars(d: string): string[] {
  return readdirSync(d).filter((f) => f.endsWith('-wal') || f.endsWith('-shm'));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ss-snap-'));
  livePath = join(dir, 'live.db');
  destDir = join(dir, 'share');
  mkdirSync(destDir);
  destPath = join(destDir, 'snapshot.db');
  seedLive();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('publishSnapshot', () => {
  it('writes a snapshot containing ALL rows, including soft-deleted (it is a backup)', () => {
    publishSnapshot(livePath, destPath);
    expect(existsSync(destPath)).toBe(true);

    const s = new Database(destPath, { readonly: true, fileMustExist: true });
    const count = s.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number };
    s.close();
    expect(count.c).toBe(2);
  });

  it('produces a standalone non-WAL file with no -wal/-shm sidecars', () => {
    publishSnapshot(livePath, destPath);

    const s = new Database(destPath, { readonly: true, fileMustExist: true });
    const mode = s.pragma('journal_mode', { simple: true });
    s.close();
    expect(mode).toBe('delete'); // NOT 'wal' — the whole reason we use VACUUM INTO
    expect(sidecars(destDir)).toEqual([]);
  });

  it('publishes the snapshot group-readable (0640), not owner-only', () => {
    // The cross-user contract: the reader reads via the shared group. A regression
    // to 0600 would silently lock the reader out while every other test passed.
    publishSnapshot(livePath, destPath);
    const mode = statSync(destPath).mode & 0o777;
    expect(mode).toBe(0o640);
  });

  it('opens read-only from a NON-writable directory without creating sidecars', () => {
    // This is the cross-user scenario: the MCP-server user reads nj's dir but
    // cannot write to it. A WAL snapshot would fail here trying to make -shm.
    publishSnapshot(livePath, destPath);
    chmodSync(destDir, 0o555);
    try {
      const s = new Database(destPath, { readonly: true, fileMustExist: true });
      const count = s.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number };
      s.close();
      expect(count.c).toBe(2);
      expect(sidecars(destDir)).toEqual([]);
    } finally {
      chmodSync(destDir, 0o755); // restore so afterEach can clean up
    }
  });

  it('overwrites the previous snapshot on a repeat run and leaves no temp file', () => {
    publishSnapshot(livePath, destPath);
    const w = openDb(livePath);
    w.insertMessage(row({ id: 'm3', content: 'newer', ts: 300 }));
    w.close();

    publishSnapshot(livePath, destPath);
    const s = new Database(destPath, { readonly: true, fileMustExist: true });
    const count = s.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number };
    s.close();
    expect(count.c).toBe(3);
    expect(readdirSync(destDir).filter((f) => f.startsWith('.snapshot.tmp'))).toEqual([]);
  });

  it('throws if the live DB does not exist (fail loud) and leaves no temp behind', () => {
    expect(() => publishSnapshot(join(dir, 'nope.db'), destPath)).toThrow();
    expect(readdirSync(destDir).filter((f) => f.startsWith('.snapshot.tmp'))).toEqual([]);
  });

  it('throws with a clear message if the destination directory does not exist', () => {
    const missingDest = join(dir, 'no-such-dir', 'snapshot.db');
    expect(() => publishSnapshot(livePath, missingDest)).toThrow(/dest dir/i);
  });

  it('does not modify the live DB (read-only guarantee)', () => {
    const before = statSync(livePath);
    publishSnapshot(livePath, destPath);
    const after = statSync(livePath);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    // and the live DB is still openable + intact
    const live = new Database(livePath, { readonly: true, fileMustExist: true });
    const count = live.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number };
    live.close();
    expect(count.c).toBe(2);
  });

  it('handles a destination path containing a single quote (SQL-literal escaping)', () => {
    const quotedDir = join(dir, "o'brien");
    mkdirSync(quotedDir);
    const quotedDest = join(quotedDir, 'snapshot.db');
    publishSnapshot(livePath, quotedDest);
    const s = new Database(quotedDest, { readonly: true, fileMustExist: true });
    const count = s.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number };
    s.close();
    expect(count.c).toBe(2);
  });
});
