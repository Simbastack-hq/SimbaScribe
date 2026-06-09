import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type Db, type MessageRow } from '../src/db/client.js';
import {
  ensureSynthSchema,
  getRowidWatermark,
  setRowidWatermark,
  getMaxMessageRowid,
  readWindowByRowid,
  insertRun,
  markPostedAndAdvance,
} from '../src/synth/store.js';

let db: Db;

function insertMsg(over: Partial<MessageRow>): void {
  const row: MessageRow = {
    id: Math.random().toString(36).slice(2),
    channel_id: 'c1',
    channel_name: 'engineering',
    guild_id: 'g1',
    author_id: 'a1',
    author_name: 'Sam',
    ts: 1700000000000,
    content: 'hi',
    reply_to_id: null,
    thread_root_id: null,
    attachments: '[]',
    edits: '[]',
    deleted_at: null,
    reactions: '{}',
    ...over,
  };
  db.insertMessage(row);
}

beforeEach(() => {
  db = openDb(':memory:');
  ensureSynthSchema(db);
});

afterEach(() => {
  db.close();
});

describe('rowid watermark', () => {
  it('is null before first set', () => {
    expect(getRowidWatermark(db)).toBeNull();
  });

  it('round-trips through set/get', () => {
    setRowidWatermark(db, 42);
    expect(getRowidWatermark(db)).toBe(42);
  });

  it('getMaxMessageRowid is 0 on empty table', () => {
    expect(getMaxMessageRowid(db)).toBe(0);
  });
});

describe('readWindowByRowid catches backfilled old-ts messages (the core fix)', () => {
  it('includes a message whose ts is OLD but was inserted after the watermark', () => {
    // Two live messages, newest ts last.
    insertMsg({ id: 'A', ts: 2000 });
    insertMsg({ id: 'B', ts: 3000 });

    const firstWindow = readWindowByRowid(db, 0);
    expect(firstWindow.map((m) => m.id)).toEqual(['A', 'B']); // ordered by ts within channel
    const watermark = Math.max(...firstWindow.map((m) => m.rowid));
    setRowidWatermark(db, watermark);

    // Simulate reconnect backfill: a message with an OLD ts (1000) inserted now.
    // A ts-based window (ts > lastTs) would MISS it; a rowid window catches it.
    insertMsg({ id: 'C_backfilled', ts: 1000 });

    const secondWindow = readWindowByRowid(db, getRowidWatermark(db)!);
    expect(secondWindow.map((m) => m.id)).toEqual(['C_backfilled']);
  });

  it('excludes soft-deleted messages', () => {
    insertMsg({ id: 'live', ts: 2000 });
    insertMsg({ id: 'gone', ts: 2001, deleted_at: 9999 });
    const window = readWindowByRowid(db, 0);
    expect(window.map((m) => m.id)).toEqual(['live']);
  });
});

describe('markPostedAndAdvance', () => {
  it('marks the run posted and advances the watermark atomically', () => {
    insertMsg({ id: 'm1', ts: 2000 });
    const window = readWindowByRowid(db, 0);
    const maxRowid = Math.max(...window.map((m) => m.rowid));

    const runId = insertRun(db, {
      startedAt: 1,
      windowStartRowid: 0,
      windowEndRowid: maxRowid,
      messagesProcessed: 1,
      digestText: 'a digest',
      model: 'claude-sonnet-4-6',
      inputTokens: 10,
      outputTokens: 5,
    });

    markPostedAndAdvance(db, runId, 2, maxRowid);

    expect(getRowidWatermark(db)).toBe(maxRowid);
    const run = db.raw.prepare('SELECT posted, ended_at FROM synth_runs WHERE id = ?').get(runId) as {
      posted: number;
      ended_at: number;
    };
    expect(run.posted).toBe(1);
    expect(run.ended_at).toBe(2);
  });
});

describe('ensureSynthSchema', () => {
  it('does not create synth_runs until called, then is idempotent', () => {
    const fresh = openDb(':memory:');
    const tableExists = () =>
      fresh.raw
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='synth_runs'")
        .get() !== undefined;
    expect(tableExists()).toBe(false);
    ensureSynthSchema(fresh);
    expect(tableExists()).toBe(true);
    ensureSynthSchema(fresh); // idempotent
    expect(tableExists()).toBe(true);
    fresh.close();
  });
});
