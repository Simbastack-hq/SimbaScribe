import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTrackerDb, type TrackerDb, type CreateItemInput, type EventCtx } from '../src/tracker/store.js';

let store: TrackerDb;

const baseInput: CreateItemInput = {
  kind: 'todo',
  text: 'deploy api',
  owner: 'Ada',
  owner_id: 'u-ada',
  confidence: 'high',
  blocked: false,
  source_msg_id: 'm1',
  source_url: 'https://discord.com/x/m1',
};
const ctx = (over: Partial<EventCtx> = {}): EventCtx => ({ source: 'synth_infer', ts: 1000, ...over });

beforeEach(() => {
  store = openTrackerDb(':memory:');
});
afterEach(() => store.close());

describe('createItem', () => {
  it('inserts an open item and writes exactly one created event, atomically', () => {
    const id = store.createItem(baseInput, ctx());
    const item = store.getItem(id);
    expect(item?.status).toBe('open');
    expect(item?.kind).toBe('todo');
    expect(item?.blocked).toBe(false); // decoded from int
    expect(item?.created_at).toBe(1000);
    expect(item?.last_seen_at).toBe(1000);
    const events = store.eventsFor(id);
    expect(events.map((e) => e.event)).toEqual(['created']);
  });

  it('decodes blocked=true round-trip', () => {
    const id = store.createItem({ ...baseInput, blocked: true }, ctx());
    expect(store.getItem(id)?.blocked).toBe(true);
  });
});

describe('touchItem', () => {
  it('bumps last_seen_at and logs touched', () => {
    const id = store.createItem(baseInput, ctx());
    store.touchItem(id, ctx({ ts: 5000 }));
    expect(store.getItem(id)?.last_seen_at).toBe(5000);
    expect(store.eventsFor(id).map((e) => e.event)).toEqual(['created', 'touched']);
  });

  it('clears resurfaced_at when the touch is newer than the resurface (item is active again)', () => {
    const id = store.createItem(baseInput, ctx());
    store.resurfaceItem(id, ctx({ ts: 2000, source: 'aging' }));
    expect(store.getItem(id)?.resurfaced_at).toBe(2000);
    store.touchItem(id, ctx({ ts: 3000 }));
    expect(store.getItem(id)?.resurfaced_at).toBeNull();
  });

  it('clears resurfaced_at on a touch at the SAME ms as the resurface (>= boundary)', () => {
    const id = store.createItem(baseInput, ctx());
    store.resurfaceItem(id, ctx({ ts: 2000, source: 'aging' }));
    store.touchItem(id, ctx({ ts: 2000 }));
    expect(store.getItem(id)?.resurfaced_at).toBeNull();
  });
});

describe('resolveItem', () => {
  it('sets status + resolved fields and logs the matching event', () => {
    const id = store.createItem(baseInput, ctx());
    store.resolveItem(
      id,
      { status: 'done', event: 'closed', resolved_msg_id: 'm9', resolved_url: 'u9', resolved_by: null },
      ctx({ ts: 7000 }),
    );
    const item = store.getItem(id);
    expect(item?.status).toBe('done');
    expect(item?.resolved_at).toBe(7000);
    expect(item?.resolved_msg_id).toBe('m9');
    expect(item?.needs_review).toBe(false);
    expect(store.eventsFor(id).map((e) => e.event)).toEqual(['created', 'closed']);
  });
});

describe('applyHumanFlag (override always wins, sticky)', () => {
  it('pinned sets the flag without changing status', () => {
    const id = store.createItem(baseInput, ctx());
    store.applyHumanFlag(id, 'pinned', ctx({ source: 'reaction' }));
    const item = store.getItem(id);
    expect(item?.human_flag).toBe('pinned');
    expect(item?.status).toBe('open');
    expect(store.eventsFor(id).at(-1)?.event).toBe('pinned');
  });

  it('dismissed suppresses the item (status=dismissed)', () => {
    const id = store.createItem(baseInput, ctx());
    store.applyHumanFlag(id, 'dismissed', ctx({ source: 'reaction' }));
    const item = store.getItem(id);
    expect(item?.human_flag).toBe('dismissed');
    expect(item?.status).toBe('dismissed');
  });

  it('reopened reverts a wrong close back to open and clears resolution', () => {
    const id = store.createItem(baseInput, ctx());
    store.resolveItem(
      id,
      { status: 'done', event: 'closed', resolved_msg_id: 'm9', resolved_url: 'u9', resolved_by: null },
      ctx(),
    );
    store.applyHumanFlag(id, 'reopened', ctx({ source: 'reaction' }));
    const item = store.getItem(id);
    expect(item?.status).toBe('open');
    expect(item?.human_flag).toBe('reopened');
    expect(item?.resolved_at).toBeNull();
    expect(item?.resolved_msg_id).toBeNull();
  });
});

describe('queries', () => {
  it('listOpen excludes resolved/dismissed and can filter by kind', () => {
    const open = store.createItem(baseInput, ctx());
    const done = store.createItem({ ...baseInput, source_msg_id: 'm2' }, ctx());
    store.resolveItem(done, { status: 'done', event: 'closed', resolved_msg_id: 'm', resolved_url: 'u', resolved_by: null }, ctx());
    store.createItem({ ...baseInput, kind: 'idea', owner: null, owner_id: null, source_msg_id: 'm3' }, ctx());

    expect(store.listOpen('todo').map((i) => i.id)).toEqual([open]);
    expect(store.listOpen().length).toBe(2); // the open todo + the idea
  });

  it('listOpenByOwner returns blocked-first then oldest-touched', () => {
    const a = store.createItem({ ...baseInput, source_msg_id: 'a' }, ctx({ ts: 100 }));
    const blocked = store.createItem({ ...baseInput, source_msg_id: 'b', blocked: true }, ctx({ ts: 200 }));
    const list = store.listOpenByOwner('u-ada');
    expect(list[0]?.id).toBe(blocked); // blocked first despite newer
    expect(list[1]?.id).toBe(a);
  });

  it('openSourceMsgIds returns distinct ids of open items only', () => {
    store.createItem({ ...baseInput, source_msg_id: 'keep' }, ctx());
    const gone = store.createItem({ ...baseInput, source_msg_id: 'gone' }, ctx());
    store.applyHumanFlag(gone, 'dismissed', ctx({ source: 'reaction' }));
    expect(store.openSourceMsgIds()).toEqual(['keep']);
  });
});

describe('setDigestMsgId', () => {
  it('binds an item and rejects a duplicate binding (reaction key must be unique)', () => {
    const a = store.createItem(baseInput, ctx());
    const b = store.createItem({ ...baseInput, source_msg_id: 'm2' }, ctx());
    store.setDigestMsgId(a, 'D1', 'new');
    expect(store.getItem(a)?.digest_msg_id).toBe('D1');
    expect(store.getItem(a)?.digest_msg_kind).toBe('new');
    expect(() => store.setDigestMsgId(b, 'D1', 'new')).toThrow(/UNIQUE/i);
  });
});

describe('schema migration (digest_msg_kind on a pre-existing DB)', () => {
  it('adds digest_msg_kind to an old tracker.db without losing rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ss-mig-'));
    const path = join(dir, 'old.db');
    // Simulate a pre-digest_msg_kind tracker.db with one open item.
    const old = new Database(path);
    old.exec(`
      CREATE TABLE tracker_items (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, text TEXT NOT NULL,
        owner TEXT, owner_id TEXT, status TEXT NOT NULL, confidence TEXT NOT NULL, blocked INTEGER NOT NULL DEFAULT 0,
        human_flag TEXT, source_msg_id TEXT NOT NULL, source_url TEXT NOT NULL, created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL, resolved_at INTEGER, resolved_msg_id TEXT, resolved_url TEXT, resolved_by TEXT,
        needs_review INTEGER NOT NULL DEFAULT 0, superseded_by INTEGER, resurfaced_at INTEGER, digest_msg_id TEXT);
      CREATE TABLE tracker_events (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL, ts INTEGER NOT NULL,
        event TEXT NOT NULL, source TEXT NOT NULL, detail TEXT, synth_run_id INTEGER);
      CREATE TABLE tracker_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO tracker_items (kind,text,owner,owner_id,status,confidence,blocked,source_msg_id,source_url,created_at,last_seen_at,needs_review)
        VALUES ('todo','legacy item','Ada','u1','open','high',0,'s','u',1,1,0);
      INSERT INTO tracker_items (kind,text,owner,owner_id,status,confidence,blocked,source_msg_id,source_url,created_at,last_seen_at,needs_review,digest_msg_id)
        VALUES ('todo','legacy bound','Ada','u1','open','high',0,'s2','u2',1,1,0,'legacy-binding');
    `);
    old.close();

    const t = openTrackerDb(path); // runs the migration
    try {
      const items = t.listOpen();
      const plain = items.find((i) => i.text === 'legacy item')!;
      const bound = items.find((i) => i.text === 'legacy bound')!;
      expect(plain.digest_msg_kind).toBeNull(); // new column, null for legacy rows
      // VF2: a legacy binding with no interpretable kind is INVALIDATED by the
      // migration, so a stale ✅/❌ can never be misread.
      expect(bound.digest_msg_id).toBeNull();
      expect(bound.status).toBe('open'); // the item itself survives
      t.setDigestMsgId(plain.id, 'm', 'looks-done'); // and bindings are writable post-migration
      expect(t.getItem(plain.id)!.digest_msg_kind).toBe('looks-done');
    } finally {
      t.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
