import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, chmodSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openTrackerDb, type TrackerDb } from '../src/tracker/store.js';
import { publishSnapshot } from '../src/snapshot/index.js';
import {
  listItems,
  getItem,
  clampLimit,
  withTrackerSnapshot,
  readTracker,
  DEFAULT_LIMIT,
  MAX_LIMIT,
} from '../src/mcp-server/tracker-db.js';
import { publishSnapshot as publishSnap, publishTrackerSnapshotIsolated } from '../src/snapshot/index.js';

let dir: string;
let tdb: TrackerDb;
let dbPath: string;

function seedItem(over: Partial<Parameters<TrackerDb['createItem']>[0]> = {}, ts = 1000): number {
  return tdb.createItem(
    {
      kind: 'todo',
      text: 'deploy api',
      owner: 'Ada',
      owner_id: 'u-ada',
      confidence: 'high',
      blocked: false,
      source_msg_id: 'm' + Math.random().toString(36).slice(2),
      source_url: 'https://discord.com/channels/g/c/m1',
      ...over,
    },
    { source: 'synth_infer', ts },
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ss-trk-'));
  dbPath = join(dir, 'tracker.db');
  tdb = openTrackerDb(dbPath);
});

afterEach(() => {
  tdb.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('clampLimit', () => {
  it('defaults / floors / caps', () => {
    expect(clampLimit(undefined)).toBe(DEFAULT_LIMIT);
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(9999)).toBe(MAX_LIMIT);
    expect(clampLimit(10)).toBe(10);
  });
});

describe('listItems', () => {
  it('defaults to OPEN items only', () => {
    const open = seedItem({ text: 'open one' });
    const closed = seedItem({ text: 'closed one' });
    tdb.resolveItem(
      closed,
      { status: 'done', event: 'closed', resolved_msg_id: 'r1', resolved_url: 'u', resolved_by: null },
      { source: 'synth_infer', ts: 2000 },
    );

    const rows = listItems(tdb.raw, {});
    expect(rows.map((r) => r.id)).toEqual([open]);
  });

  it('can fetch a non-open status explicitly', () => {
    const closed = seedItem({ text: 'closed one' });
    tdb.resolveItem(
      closed,
      { status: 'done', event: 'closed', resolved_msg_id: 'r1', resolved_url: 'u', resolved_by: null },
      { source: 'synth_infer', ts: 2000 },
    );
    const rows = listItems(tdb.raw, { status: 'done' });
    expect(rows.map((r) => r.id)).toEqual([closed]);
    expect(rows[0]!.resolved_url).toBe('u');
  });

  it('ranks pinned first, then blocked, then high-confidence, then recent', () => {
    const plain = seedItem({ text: 'plain', confidence: 'low' }, 100);
    const recent = seedItem({ text: 'recent low', confidence: 'low' }, 900);
    const high = seedItem({ text: 'high conf', confidence: 'high' }, 200);
    const blocked = seedItem({ text: 'blocked', blocked: true, confidence: 'low' }, 150);
    const pinned = seedItem({ text: 'pinned', confidence: 'low' }, 50);
    tdb.applyHumanFlag(pinned, 'pinned', { source: 'reaction', ts: 3000 });

    const ids = listItems(tdb.raw, {}).map((r) => r.id);
    expect(ids[0]).toBe(pinned); // pinned wins regardless of age
    expect(ids[1]).toBe(blocked); // then blocked
    expect(ids[2]).toBe(high); // then high-confidence
    // remaining low-confidence, most-recent-seen first
    expect(ids.slice(3)).toEqual([recent, plain]);
  });

  it('filters by kind, owner (id or name), and blocked', () => {
    const t = seedItem({ kind: 'todo', owner: 'Ada', owner_id: 'u-ada' });
    seedItem({ kind: 'idea', owner: null, owner_id: null, text: 'an idea' });
    const blk = seedItem({ kind: 'todo', owner: 'Sam', owner_id: 'u-sam', blocked: true });

    expect(listItems(tdb.raw, { kind: 'idea' }).map((r) => r.kind)).toEqual(['idea']);
    expect(listItems(tdb.raw, { owner: 'u-ada' }).map((r) => r.id)).toEqual([t]);
    expect(listItems(tdb.raw, { owner: 'Ada' }).map((r) => r.id)).toEqual([t]); // name also matches
    expect(listItems(tdb.raw, { blocked: true }).map((r) => r.id)).toEqual([blk]);
  });

  it('decodes booleans and surfaces pinned flag', () => {
    const id = seedItem({ blocked: true });
    tdb.applyHumanFlag(id, 'pinned', { source: 'reaction', ts: 3000 });
    const [row] = listItems(tdb.raw, {});
    expect(row!.blocked).toBe(true);
    expect(row!.pinned).toBe(true);
  });

  it('respects the clamped limit', () => {
    for (let i = 0; i < 5; i++) seedItem({ text: 'x' + i }, 100 + i);
    expect(listItems(tdb.raw, { limit: 2 })).toHaveLength(2);
    expect(listItems(tdb.raw, { limit: 0 })).toHaveLength(1);
  });
});

describe('getItem', () => {
  it('returns the item plus its event history', () => {
    const id = seedItem({ text: 'with history' });
    tdb.touchItem(id, { source: 'synth_infer', ts: 1500 });
    const detail = getItem(tdb.raw, id);
    expect(detail?.id).toBe(id);
    expect(detail?.events.map((e) => e.event)).toEqual(['created', 'touched']);
  });

  it('returns null for a missing id', () => {
    expect(getItem(tdb.raw, 99999)).toBeNull();
  });
});

describe('withTrackerSnapshot (independence + read-only)', () => {
  it('reads a published tracker snapshot from a non-writable dir without sidecars', () => {
    seedItem({ text: 'snap me' });
    tdb.close(); // release WAL before snapshotting

    const snapDir = join(dir, 'pub');
    mkdirSync(snapDir, { recursive: true });
    const snapPath = join(snapDir, 'tracker-snapshot.db');
    publishSnapshot(dbPath, snapPath);

    chmodSync(snapDir, 0o555); // simulate the reader reading the writer's dir
    try {
      const rows = withTrackerSnapshot(snapPath, (db) => listItems(db, {}));
      expect(rows.map((r) => r.text)).toEqual(['snap me']);
      const sidecars = readdirSync(snapDir).filter((f) => f.endsWith('-wal') || f.endsWith('-shm'));
      expect(sidecars).toEqual([]);
    } finally {
      chmodSync(snapDir, 0o755);
    }
    // reopen so afterEach's close() is valid
    tdb = openTrackerDb(dbPath);
  });

  it('throws (catchably) on a missing snapshot — the basis for graceful degradation', () => {
    expect(() => withTrackerSnapshot(join(dir, 'nope.db'), () => 1)).toThrow();
  });

  it('rejects writes through the read-only handle', () => {
    seedItem();
    tdb.close();
    expect(() =>
      withTrackerSnapshot(dbPath, (db) => db.prepare("UPDATE tracker_items SET text='x'").run()),
    ).toThrow(/readonly|read-only/i);
    tdb = openTrackerDb(dbPath);
  });
});

describe('readTracker (graceful degradation — the §4 independence guarantee)', () => {
  it('returns ok:false when the path env is unset (no throw)', () => {
    const r = readTracker(undefined, () => 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/tracker unavailable/i);
  });

  it('returns ok:false when the path env is blank', () => {
    expect(readTracker('   ', () => 1).ok).toBe(false);
  });

  it('returns ok:false (not a throw) when the snapshot file is missing', () => {
    const r = readTracker(join(dir, 'absent.db'), () => 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/tracker unavailable/i);
  });

  it('returns ok:true with the value when the snapshot exists', () => {
    seedItem({ text: 'reachable' });
    tdb.close();
    const snapPath = join(dir, 'rt.db');
    publishSnap(dbPath, snapPath);
    const r = readTracker(snapPath, (db) => listItems(db, {}));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.map((i) => i.text)).toEqual(['reachable']);
    tdb = openTrackerDb(dbPath);
  });
});

describe('publishTrackerSnapshotIsolated (failure must not abort the run — §4)', () => {
  it('skips cleanly when unconfigured', () => {
    expect(publishTrackerSnapshotIsolated(undefined, undefined)).toBe('skipped-unconfigured');
    expect(publishTrackerSnapshotIsolated('/x', undefined)).toBe('skipped-unconfigured');
  });

  it('skips (not fails) when the tracker DB does not exist yet', () => {
    const res = publishTrackerSnapshotIsolated(join(dir, 'no-tracker.db'), join(dir, 'out.db'));
    expect(res).toBe('skipped-absent');
  });

  it('SWALLOWS a publish failure (returns "failed", does not throw)', () => {
    seedItem();
    tdb.close();
    // dest dir does not exist → publishSnapshot would throw; isolation must catch it
    const res = publishTrackerSnapshotIsolated(dbPath, join(dir, 'no-such-dir', 'snap.db'));
    expect(res).toBe('failed');
    tdb = openTrackerDb(dbPath);
  });

  it('publishes when configured and the DB exists', () => {
    seedItem();
    tdb.close();
    const res = publishTrackerSnapshotIsolated(dbPath, join(dir, 'ok-snap.db'));
    expect(res).toBe('published');
    tdb = openTrackerDb(dbPath);
  });
});

// sanity that the published snapshot is a real standalone sqlite file
describe('published snapshot is a standalone sqlite file', () => {
  it('opens with better-sqlite3 readonly', () => {
    seedItem();
    tdb.close();
    const snapPath = join(dir, 'snap2.db');
    publishSnapshot(dbPath, snapPath);
    const s = new Database(snapPath, { readonly: true, fileMustExist: true });
    const n = s.prepare('SELECT COUNT(*) c FROM tracker_items').get() as { c: number };
    s.close();
    expect(n.c).toBe(1);
    tdb = openTrackerDb(dbPath);
  });
});
