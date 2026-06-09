import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openTrackerDb, type TrackerDb, type CreateItemInput, type EventCtx } from '../src/tracker/store.js';
import { applyReconciliation, type ReconcileContext } from '../src/tracker/reconcile.js';
import { validateReconciliation } from '../src/tracker/validate.js';
import type { Reconciliation } from '../src/tracker/types.js';

let store: TrackerDb;
const ctx: ReconcileContext = { now: 9000, synthRunId: 1, urlFor: (id) => `https://discord.com/x/${id}` };
const evt = (ts: number): EventCtx => ({ source: 'synth_infer', ts });
const empty: Reconciliation = { new_items: [], resolutions: [], touches: [] };

/** Route a proposal through the real validator (collecting every referenced
 *  message id into the window) so reconcile tests exercise the production path. */
function validated(input: Reconciliation) {
  const windowMsgIds = new Set<string>();
  input.new_items.forEach((n) => windowMsgIds.add(n.source_msg_id));
  input.resolutions.forEach((r) => windowMsgIds.add(r.evidence_msg_id));
  input.touches.forEach((t) => windowMsgIds.add(t.evidence_msg_id));
  const openItems = new Map(store.listOpen().map((i) => [i.id, i] as const));
  return validateReconciliation(input, { openItems, windowMsgIds }).valid;
}

function seed(over: Partial<CreateItemInput>, ts = 1000): number {
  const base: CreateItemInput = {
    kind: 'todo',
    text: 'deploy the api to prod',
    owner: 'Ada',
    owner_id: 'u1',
    confidence: 'high',
    blocked: false,
    source_msg_id: 'seed',
    source_url: 'https://discord.com/x/seed',
  };
  return store.createItem({ ...base, ...over }, evt(ts));
}

beforeEach(() => {
  store = openTrackerDb(':memory:');
});
afterEach(() => store.close());

describe('resolutions — coreference by id', () => {
  it('strong done closes exactly the targeted item, with evidence url', () => {
    const a = seed({ source_msg_id: 'sa' });
    const b = seed({ source_msg_id: 'sb', text: 'fix build android' });
    const r = applyReconciliation(
      store,
      validated({ ...empty, resolutions: [{ target_id: b, type: 'done', strength: 'strong', evidence_msg_id: 'w-done' }] }),
      ctx,
    );
    expect(r.closed).toBe(1);
    expect(store.getItem(a)?.status).toBe('open');
    const closed = store.getItem(b);
    expect(closed?.status).toBe('done');
    expect(closed?.resolved_url).toBe('https://discord.com/x/w-done');
  });

  it('weak done flags needs_review and leaves status open', () => {
    const a = seed({});
    applyReconciliation(
      store,
      validated({ ...empty, resolutions: [{ target_id: a, type: 'done', strength: 'weak', evidence_msg_id: 'w' }] }),
      ctx,
    );
    const item = store.getItem(a);
    expect(item?.status).toBe('open');
    expect(item?.needs_review).toBe(true);
  });
});

describe('strong-auto-close cap (injection blast-radius bound)', () => {
  it('demotes ALL strong closes to review when a run exceeds the cap', () => {
    const ids = Array.from({ length: 9 }, (_, i) => seed({ source_msg_id: `s${i}`, text: `task number ${i}` }));
    const r = applyReconciliation(
      store,
      validated({
        ...empty,
        resolutions: ids.map((id) => ({ target_id: id, type: 'done' as const, strength: 'strong' as const, evidence_msg_id: `e${id}` })),
      }),
      { ...ctx, maxStrongAutoCloses: 8 },
    );
    expect(r.closed).toBe(0);
    expect(r.demotedStrongCloses).toBe(9);
    // none actually closed; all flagged for human "looks done?"
    expect(store.listOpen('todo').every((i) => i.needs_review)).toBe(true);
  });

  it('auto-closes normally when under the cap', () => {
    const ids = Array.from({ length: 3 }, (_, i) => seed({ source_msg_id: `s${i}`, text: `task number ${i}` }));
    const r = applyReconciliation(
      store,
      validated({
        ...empty,
        resolutions: ids.map((id) => ({ target_id: id, type: 'done' as const, strength: 'strong' as const, evidence_msg_id: `e${id}` })),
      }),
      { ...ctx, maxStrongAutoCloses: 8 },
    );
    expect(r.closed).toBe(3);
    expect(r.demotedStrongCloses).toBe(0);
  });
});

describe('touches', () => {
  it('bumps last_seen_at of the targeted item', () => {
    const a = seed({}, 1000);
    applyReconciliation(store, validated({ ...empty, touches: [{ target_id: a, evidence_msg_id: 'w' }] }), ctx);
    expect(store.getItem(a)?.last_seen_at).toBe(9000);
  });
});

describe('new_items + dedup-to-touch', () => {
  it('a new todo overlapping an open todo with the same owner becomes a touch, not an insert', () => {
    const a = seed({ source_msg_id: 'sa' }, 1000); // "deploy the api to prod", owner u1
    const r = applyReconciliation(
      store,
      validated({
        ...empty,
        new_items: [
          { kind: 'todo', text: 'deploy api prod', owner: 'Ada', owner_id: 'u1', confidence: 'high', blocked: false, source_msg_id: 'w-new' },
        ],
      }),
      ctx,
    );
    expect(r.created).toBe(0);
    expect(r.dedupedToTouch).toBe(1);
    expect(store.listOpen('todo')).toHaveLength(1);
    expect(store.getItem(a)?.last_seen_at).toBe(9000); // the existing one got touched
  });

  it('the same text under a DIFFERENT owner inserts a new item (not a dup)', () => {
    seed({ source_msg_id: 'sa', owner: 'Ada', owner_id: 'u1' });
    const r = applyReconciliation(
      store,
      validated({
        ...empty,
        new_items: [
          { kind: 'todo', text: 'deploy the api to prod', owner: 'Ben', owner_id: 'u2', confidence: 'high', blocked: false, source_msg_id: 'w-new' },
        ],
      }),
      ctx,
    );
    expect(r.created).toBe(1);
    expect(store.listOpen('todo')).toHaveLength(2);
  });

  it('dedups against the name when only one side has an owner_id (documented fallback)', () => {
    seed({ source_msg_id: 'sa', owner: 'Ada', owner_id: 'u1' }); // stored with id
    const r = applyReconciliation(
      store,
      validated({
        ...empty,
        new_items: [
          // same person, but the model didn't resolve an owner_id this time
          { kind: 'todo', text: 'deploy api prod', owner: 'Ada', owner_id: null, confidence: 'high', blocked: false, source_msg_id: 'w-new' },
        ],
      }),
      ctx,
    );
    expect(r.dedupedToTouch).toBe(1);
    expect(store.listOpen('todo')).toHaveLength(1);
  });

  it('dedups two NEW items within the same batch (intra-batch)', () => {
    const r = applyReconciliation(
      store,
      validated({
        ...empty,
        new_items: [
          { kind: 'todo', text: 'deploy the api to prod', owner: 'Sam', owner_id: 'u3', confidence: 'high', blocked: false, source_msg_id: 'w1' },
          { kind: 'todo', text: 'deploy api prod now', owner: 'Sam', owner_id: 'u3', confidence: 'high', blocked: false, source_msg_id: 'w2' },
        ],
      }),
      ctx,
    );
    expect(r.created).toBe(1);
    expect(r.dedupedToTouch).toBe(1);
    expect(store.listOpen('todo')).toHaveLength(1);
  });

  it('inserts a fresh item with stored confidence and a built source_url', () => {
    const r = applyReconciliation(
      store,
      validated({
        ...empty,
        new_items: [
          { kind: 'todo', text: 'write the blog post', owner: 'Sam', owner_id: 'u3', confidence: 'low', blocked: false, source_msg_id: 'w-new' },
        ],
      }),
      ctx,
    );
    expect(r.created).toBe(1);
    const items = store.listOpen('todo');
    expect(items[0]?.confidence).toBe('low');
    expect(items[0]?.source_url).toBe('https://discord.com/x/w-new');
  });

  it('dedups ideas by text alone (owner is null)', () => {
    seed({ kind: 'idea', owner: null, owner_id: null, text: 'switch to bun maybe', source_msg_id: 'si' });
    const r = applyReconciliation(
      store,
      validated({
        ...empty,
        new_items: [
          { kind: 'idea', text: 'switch to bun', owner: null, owner_id: null, confidence: 'low', blocked: false, source_msg_id: 'w-new' },
        ],
      }),
      ctx,
    );
    expect(r.dedupedToTouch).toBe(1);
    expect(store.listOpen('idea')).toHaveLength(1);
  });
});

describe('fail-loud', () => {
  it('throws rather than persisting an empty citation URL', () => {
    const proposal = validated({
      ...empty,
      new_items: [
        { kind: 'todo', text: 'a task', owner: 'Sam', owner_id: 'u3', confidence: 'high', blocked: false, source_msg_id: 'w1' },
      ],
    });
    expect(() => applyReconciliation(store, proposal, { ...ctx, urlFor: () => '' })).toThrow(/no URL/);
  });
});
