import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openTrackerDb, type TrackerDb, type CreateItemInput, type EventCtx } from '../src/tracker/store.js';
import { runAging, DEFAULT_AGING } from '../src/tracker/aging.js';
import type { TrackerKind } from '../src/tracker/types.js';

const DAY = 24 * 60 * 60 * 1000;
let store: TrackerDb;

function seed(kind: TrackerKind, createdTs: number, over: Partial<CreateItemInput> = {}): number {
  const base: CreateItemInput = {
    kind,
    text: 'a thing',
    owner: kind === 'todo' ? 'Ada' : null,
    owner_id: kind === 'todo' ? 'u1' : null,
    confidence: 'high',
    blocked: false,
    source_msg_id: `m-${Math.random().toString(36).slice(2)}`,
    source_url: 'u',
  };
  return store.createItem({ ...base, ...over }, { source: 'synth_infer', ts: createdTs });
}

beforeEach(() => {
  store = openTrackerDb(':memory:');
});
afterEach(() => store.close());

describe('todo aging: resurface once, then archive', () => {
  it('resurfaces at exactly the threshold (>= boundary)', () => {
    const id = seed('todo', 0);
    const r = runAging(store, DEFAULT_AGING, DEFAULT_AGING.todoResurfaceMs); // exactly 5d elapsed
    expect(r.resurfaced.map((i) => i.id)).toEqual([id]);
  });

  it('resurfaces a stale todo exactly once', () => {
    const id = seed('todo', 0);
    const r1 = runAging(store, DEFAULT_AGING, 6 * DAY);
    expect(r1.resurfaced.map((i) => i.id)).toEqual([id]);
    expect(store.getItem(id)?.resurfaced_at).toBe(6 * DAY);

    // Before the grace lapses: neither re-resurfaced nor archived.
    const r2 = runAging(store, DEFAULT_AGING, 10 * DAY);
    expect(r2.resurfaced).toHaveLength(0);
    expect(r2.archived).toHaveLength(0);
    expect(store.getItem(id)?.status).toBe('open');
  });

  it('archives a resurfaced todo once the grace lapses untouched', () => {
    const id = seed('todo', 0);
    runAging(store, DEFAULT_AGING, 6 * DAY); // resurfaced_at = 6d
    const r = runAging(store, DEFAULT_AGING, 16 * DAY); // 10d since resurface > 9d grace
    expect(r.archived.map((i) => i.id)).toEqual([id]);
    expect(store.getItem(id)?.status).toBe('archived');
  });

  it('a touch after resurfacing rescues the item — it re-resurfaces instead of archiving', () => {
    const id = seed('todo', 0);
    runAging(store, DEFAULT_AGING, 6 * DAY); // resurfaced_at = 6d
    store.touchItem(id, { source: 'synth_infer', ts: 7 * DAY }); // clears resurfaced_at
    expect(store.getItem(id)?.resurfaced_at).toBeNull();

    const r = runAging(store, DEFAULT_AGING, 20 * DAY); // stale again vs last_seen 7d
    expect(r.archived).toHaveLength(0);
    expect(r.resurfaced.map((i) => i.id)).toEqual([id]);
    expect(store.getItem(id)?.status).toBe('open');
  });
});

describe('aging skips protected items', () => {
  it('never ages a pinned todo', () => {
    const id = seed('todo', 0);
    store.applyHumanFlag(id, 'pinned', { source: 'reaction', ts: 1 });
    const r = runAging(store, DEFAULT_AGING, 100 * DAY);
    expect(r.resurfaced).toHaveLength(0);
    expect(r.archived).toHaveLength(0);
    expect(store.getItem(id)?.status).toBe('open');
  });

  it('skips items awaiting a "looks done?" review', () => {
    const id = seed('todo', 0);
    store.flagReview(id, { source: 'synth_infer', ts: 1 });
    const r = runAging(store, DEFAULT_AGING, 100 * DAY);
    expect(r.resurfaced).toHaveLength(0);
  });
});

describe('passive kinds', () => {
  it('an idea gets one gentle revisit and is never auto-archived', () => {
    const id = seed('idea', 0);
    const r1 = runAging(store, DEFAULT_AGING, 70 * DAY);
    expect(r1.revisited.map((i) => i.id)).toEqual([id]);

    const r2 = runAging(store, DEFAULT_AGING, 500 * DAY);
    expect(r2.archived).toHaveLength(0);
    expect(store.getItem(id)?.status).toBe('open');
  });

  it('a decision never ages at all', () => {
    const id = seed('decision', 0);
    const r = runAging(store, DEFAULT_AGING, 1000 * DAY);
    expect(r.resurfaced).toHaveLength(0);
    expect(r.revisited).toHaveLength(0);
    expect(r.archived).toHaveLength(0);
    expect(store.getItem(id)?.status).toBe('open');
  });
});
