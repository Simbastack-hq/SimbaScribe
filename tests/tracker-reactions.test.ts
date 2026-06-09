import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTrackerDb, type TrackerDb, type EventCtx } from '../src/tracker/store.js';
import { applyReactions, type ReactionView } from '../src/tracker/reactions.js';
import type { TrackerKind } from '../src/tracker/types.js';

let dir: string;
let store: TrackerDb;
const NOW = 1_000_000;
const emojis = { confirmEmoji: '✅', vetoEmoji: '❌' };
const ctx = (): EventCtx => ({ source: 'synth_infer', ts: NOW, detail: {} });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ss-react-'));
  store = openTrackerDb(join(dir, 'tracker.db'));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Seed an open item with a bound digest message id + its prompt semantic. */
function seed(opts: { kind?: TrackerKind; digestMsgId?: string | null; needsReview?: boolean; msgKind?: string } = {}): number {
  const id = store.createItem(
    {
      kind: opts.kind ?? 'todo',
      text: 'do a thing',
      owner: 'Ada',
      owner_id: 'u-ada',
      confidence: 'high',
      blocked: false,
      source_msg_id: 'src',
      source_url: 'https://discord.com/channels/g/c/src',
    },
    ctx(),
  );
  if (opts.digestMsgId !== null) store.setDigestMsgId(id, opts.digestMsgId ?? `msg-${id}`, opts.msgKind ?? 'new');
  if (opts.needsReview) store.flagReview(id, ctx());
  return id;
}

/** Build a reader from a map of messageId → reactions. */
function reader(map: Record<string, ReactionView[]>) {
  return async (_channelId: string, messageId: string): Promise<ReactionView[]> => map[messageId] ?? [];
}
const human = (id: string) => ({ id, bot: false });
const bot = (id: string) => ({ id, bot: true });

describe('applyReactions — human-only filter (the security hinge)', () => {
  it('pins on a human ✅ and dismisses on a human ❌', async () => {
    const pinId = seed({ digestMsgId: 'm-pin' });
    const dropId = seed({ digestMsgId: 'm-drop' });
    const summary = await applyReactions(
      store,
      store.listOpen(),
      'chan',
      reader({
        'm-pin': [{ emoji: '✅', reactors: [human('h1')] }],
        'm-drop': [{ emoji: '❌', reactors: [human('h2')] }],
      }),
      emojis,
      NOW,
    );
    expect(summary.pinned).toBe(1);
    expect(summary.dismissed).toBe(1);
    expect(store.getItem(pinId)!.human_flag).toBe('pinned');
    expect(store.getItem(dropId)!.status).toBe('dismissed');
  });

  it('IGNORES a reaction from a bot/webhook identity (injection cannot self-confirm)', async () => {
    const id = seed({ digestMsgId: 'm-bot' });
    const summary = await applyReactions(
      store,
      store.listOpen(),
      'chan',
      reader({ 'm-bot': [{ emoji: '✅', reactors: [bot('pulse-bot')] }] }),
      emojis,
      NOW,
    );
    expect(summary.pinned).toBe(0);
    expect(store.getItem(id)!.human_flag).toBeNull();
  });

  it('❌ takes precedence over ✅ when both are present (contested → not tracked)', async () => {
    const id = seed({ digestMsgId: 'm-both' });
    await applyReactions(
      store,
      store.listOpen(),
      'chan',
      reader({ 'm-both': [{ emoji: '✅', reactors: [human('h1')] }, { emoji: '❌', reactors: [human('h2')] }] }),
      emojis,
      NOW,
    );
    expect(store.getItem(id)!.status).toBe('dismissed');
  });
});

describe('applyReactions — looks-done semantics (interpreted by stored kind)', () => {
  it('✅ on a looks-done todo confirms the close (done, resolved_by = the human)', async () => {
    const id = seed({ digestMsgId: 'm-rev', needsReview: true, msgKind: 'looks-done' });
    const summary = await applyReactions(store, store.listOpen(), 'chan', reader({ 'm-rev': [{ emoji: '✅', reactors: [human('h-closer')] }] }), emojis, NOW);
    expect(summary.confirmedClosed).toBe(1);
    const it = store.getItem(id)!;
    expect(it.status).toBe('done');
    expect(it.resolved_by).toBe('h-closer');
  });

  it('✅ on a looks-done DECISION supersedes it — NOT a "done" todo (F5)', async () => {
    const id = seed({ kind: 'decision', digestMsgId: 'm-dec', needsReview: true, msgKind: 'looks-done' });
    await applyReactions(store, store.listOpen(), 'chan', reader({ 'm-dec': [{ emoji: '✅', reactors: [human('h')] }] }), emojis, NOW);
    expect(store.getItem(id)!.status).toBe('superseded');
  });

  it('❌ keeps it open, clears the review flag, sets NO sticky flag (re-decidable)', async () => {
    const id = seed({ digestMsgId: 'm-rev2', needsReview: true, msgKind: 'looks-done' });
    const summary = await applyReactions(store, store.listOpen(), 'chan', reader({ 'm-rev2': [{ emoji: '❌', reactors: [human('h')] }] }), emojis, NOW);
    expect(summary.reopened).toBe(1);
    const it = store.getItem(id)!;
    expect(it.status).toBe('open');
    expect(it.needs_review).toBe(false);
    expect(it.human_flag).toBeNull(); // NOT sticky → a later prompt can still work
  });

  it('a ✅ on a "new" prompt always means PIN, even after the item drifted to needs_review (F2)', async () => {
    // Stale binding: the message was a 'new' prompt; the item later became
    // needs_review but the re-post failed, so digest_msg_kind stays 'new'.
    const id = seed({ digestMsgId: 'm-stale', needsReview: true, msgKind: 'new' });
    await applyReactions(store, store.listOpen(), 'chan', reader({ 'm-stale': [{ emoji: '✅', reactors: [human('h')] }] }), emojis, NOW);
    const it = store.getItem(id)!;
    expect(it.human_flag).toBe('pinned'); // interpreted as PIN (stored kind), not confirm-close
    expect(it.status).toBe('open'); // NOT closed
  });
});

describe('applyReactions — idempotency & robustness', () => {
  it('skips an item with no bound message and one already human-flagged (sticky)', async () => {
    const unbound = seed({ digestMsgId: null });
    const pinned = seed({ digestMsgId: 'm-already' });
    store.applyHumanFlag(pinned, 'pinned', ctx()); // already decided
    const summary = await applyReactions(
      store,
      store.listOpen(),
      'chan',
      reader({ 'm-already': [{ emoji: '❌', reactors: [human('h')] }] }), // a late ❌ must NOT override
      emojis,
      NOW,
    );
    expect(summary.itemsRead).toBe(0); // both skipped
    expect(store.getItem(pinned)!.human_flag).toBe('pinned'); // unchanged
    expect(store.getItem(unbound)!.human_flag).toBeNull();
  });

  it('re-reading the same ✅ across runs is a no-op (sticky flag)', async () => {
    const id = seed({ digestMsgId: 'm-x' });
    const r = reader({ 'm-x': [{ emoji: '✅', reactors: [human('h')] }] });
    await applyReactions(store, store.listOpen(), 'chan', r, emojis, NOW);
    const second = await applyReactions(store, store.listOpen(), 'chan', r, emojis, NOW + 1);
    expect(second.pinned).toBe(0); // already pinned → skipped
    expect(store.getItem(id)!.human_flag).toBe('pinned');
  });

});

describe('applyReactions — legacy bindings & systemic failure (final-sweep fixes)', () => {
  it('SKIPS a binding with an unknown/null kind — never misreads a ❌ as dismiss (F3)', async () => {
    const id = seed({ digestMsgId: 'm-legacy', needsReview: true });
    // Simulate a pre-digest_msg_kind binding: clear the stored kind to null.
    store.raw.prepare('UPDATE tracker_items SET digest_msg_kind = NULL WHERE id = ?').run(id);
    const summary = await applyReactions(
      store,
      store.listOpen(),
      'chan',
      reader({ 'm-legacy': [{ emoji: '❌', reactors: [human('h')] }] }),
      emojis,
      NOW,
    );
    expect(summary.itemsRead).toBe(0); // not interpreted
    expect(store.getItem(id)!.status).toBe('open'); // NOT dismissed
  });

  it('STOPS the pass on a read failure — does not pay a timeout per remaining item (F6)', async () => {
    seed({ digestMsgId: 'm-1' });
    seed({ digestMsgId: 'm-2' });
    let reads = 0;
    const failing = async (): Promise<ReactionView[]> => {
      reads += 1;
      throw new Error('systemic hang');
    };
    const summary = await applyReactions(store, store.listOpen(), 'chan', failing, emojis, NOW);
    expect(summary.readErrors).toBe(1);
    expect(reads).toBe(1); // broke after the first failure; did not read the second
  });
});
