import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db, type MessageRow } from '../src/db/client.js';
import { openTrackerDb } from '../src/tracker/store.js';
import { runTrackerStep, type SurfacingDeps } from '../src/tracker/tracker-step.js';
import type { ReactionView } from '../src/tracker/reactions.js';
import type { Reconciliation } from '../src/tracker/types.js';

const DAY = 24 * 60 * 60 * 1000;
let dir: string;
let corpus: Db;
let trackerPath: string;
const cfg = { trackerDbPath: '', discordGuildId: 'g1' };

function insertMsg(over: Partial<MessageRow>): void {
  corpus.insertMessage({
    id: Math.random().toString(36).slice(2),
    channel_id: 'c1', channel_name: 'engineering', guild_id: 'g1',
    author_id: 'u-ada', author_name: 'Ada', ts: 1700000000000, content: 'hi',
    reply_to_id: null, thread_root_id: null, attachments: '[]', edits: '[]',
    deleted_at: null, reactions: '{}', ...over,
  });
}

const emptyModel = async (): Promise<Reconciliation> => ({ new_items: [], resolutions: [], touches: [] });

/** A surfacing deps bundle with in-memory fakes for the Discord I/O. */
function fakes(reactions: Record<string, ReactionView[]> = {}) {
  const posted: string[] = [];
  let n = 0;
  const deps: SurfacingDeps = {
    emojis: { confirmEmoji: '✅', vetoEmoji: '❌' },
    aging: { todoResurfaceMs: 5 * DAY, todoArchiveGraceMs: 9 * DAY, ideaRevisitMs: 60 * DAY },
    read: async (_c, mid) => reactions[mid] ?? [],
    post: async (content) => {
      posted.push(content);
      n += 1;
      return { id: `posted-${n}`, channelId: 'CHAN' };
    },
    maxItemMessages: 10,
  };
  return { deps, posted };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ss-surf-'));
  corpus = openDb(join(dir, 'corpus.db'));
  trackerPath = join(dir, 'tracker.db');
  cfg.trackerDbPath = trackerPath;
});
afterEach(() => {
  corpus.close();
  rmSync(dir, { recursive: true, force: true });
});

const newTodoModel = (msgId: string): ((u: string) => Promise<Reconciliation>) => async () => ({
  new_items: [{ kind: 'todo', text: 'deploy the API', owner: 'Ada', owner_id: 'u-ada', confidence: 'high', blocked: false, source_msg_id: msgId }],
  resolutions: [],
  touches: [],
});

describe('surfacing wired into runTrackerStep', () => {
  it('flag OFF (no surfacing deps) makes NO posts and no aging — behaviour == today', async () => {
    await runTrackerStep(corpus, cfg, emptyModel, 1000, null); // first-boot
    insertMsg({ id: 'N1', content: 'I will deploy the API' });
    const { deps, posted } = fakes();
    void deps; // not passed
    const res = await runTrackerStep(corpus, cfg, newTodoModel('N1'), 2000, 1); // NO surfacing arg
    expect(res.surfacing).toBeUndefined();
    expect(posted).toHaveLength(0);
    const t = openTrackerDb(trackerPath);
    expect(t.listOpen()[0]!.digest_msg_id).toBeNull(); // never surfaced
    t.close();
  });

  it('posts the summary + a per-item message for a new todo, and binds the message id', async () => {
    await runTrackerStep(corpus, cfg, emptyModel, 1000, null);
    insertMsg({ id: 'N2', content: 'I will deploy the API' });
    const { deps, posted } = fakes();
    const res = await runTrackerStep(corpus, cfg, newTodoModel('N2'), 2000, 1, deps);
    expect(res.surfacing?.sectionsPosted).toBe(true);
    expect(res.surfacing?.itemMessagesPosted).toBe(1);
    expect(posted.some((p) => p.includes('📋 Open work'))).toBe(true);
    expect(posted.some((p) => p.includes('🆕 New todo'))).toBe(true);

    const t = openTrackerDb(trackerPath);
    const item = t.listOpen()[0]!;
    expect(item.digest_msg_id).toBe('posted-2'); // sections=posted-1, item=posted-2
    expect(t.getState('surfacing_channel_id')).toBe('CHAN');
    t.close();
  });

  it('on the NEXT run, reads ✅ on the bound message and pins the item', async () => {
    await runTrackerStep(corpus, cfg, emptyModel, 1000, null);
    insertMsg({ id: 'N3', content: 'I will deploy the API' });
    const first = fakes();
    await runTrackerStep(corpus, cfg, newTodoModel('N3'), 2000, 1, first.deps);

    // a human reacts ✅ on the per-item message (posted-2); next run reads it.
    const second = fakes({ 'posted-2': [{ emoji: '✅', reactors: [{ id: 'h-ada', bot: false }] }] });
    const res = await runTrackerStep(corpus, cfg, emptyModel, 3000, 2, second.deps);
    expect(res.surfacing?.reactions.pinned).toBe(1);
    const t = openTrackerDb(trackerPath);
    expect(t.listOpen()[0]!.human_flag).toBe('pinned');
    t.close();
  });

  it('SKIPS aging when reactions could not be read (a correction may have been missed) (F3)', async () => {
    const T0 = 100 * DAY;
    insertMsg({ id: 'OLDR', content: 'old' });
    await runTrackerStep(corpus, cfg, emptyModel, T0, null);
    // pre-seed a stale todo WITH a bound message + a known surfacing channel, so
    // the reaction read is attempted (and made to fail).
    const t0 = openTrackerDb(trackerPath);
    const id = t0.createItem(
      { kind: 'todo', text: 'keep me', owner: 'Ada', owner_id: 'u-ada', confidence: 'high', blocked: false, source_msg_id: 'OLDR', source_url: 'https://discord.com/channels/g1/c1/OLDR' },
      { source: 'synth_infer', ts: T0, detail: {} },
    );
    t0.setDigestMsgId(id, 'bound-msg', 'new');
    t0.setState('surfacing_channel_id', 'CHAN');
    t0.close();

    const { deps } = fakes();
    deps.read = async () => {
      throw new Error('401 Unauthorized'); // systemic read failure
    };
    const res = await runTrackerStep(corpus, cfg, emptyModel, T0 + 6 * DAY, 5, deps);
    expect(res.surfacing?.reactions.readErrors).toBeGreaterThan(0);
    expect(res.surfacing?.agingSkippedDueToReadErrors).toBe(true);
    const t = openTrackerDb(trackerPath);
    expect(t.getItem(id)!.resurfaced_at).toBeNull(); // NOT aged — we couldn't read corrections
    t.close();
  });

  it('ages a stale todo even with an empty window — resurfaces it (⚠️) and posts a "still open?" prompt', async () => {
    // first-boot at T0 sets the watermark past all history
    const T0 = 100 * DAY;
    insertMsg({ id: 'OLD', content: 'old chatter' });
    await runTrackerStep(corpus, cfg, emptyModel, T0, null);
    // pre-seed a todo whose last_seen_at = T0 (stale by the time we run later)
    const t0 = openTrackerDb(trackerPath);
    const id = t0.createItem(
      { kind: 'todo', text: 'ship the migration', owner: 'Ada', owner_id: 'u-ada', confidence: 'high', blocked: false, source_msg_id: 'OLD', source_url: 'https://discord.com/channels/g1/c1/OLD' },
      { source: 'synth_infer', ts: T0, detail: {} },
    );
    t0.close();

    const { deps, posted } = fakes();
    const res = await runTrackerStep(corpus, cfg, emptyModel, T0 + 6 * DAY, 5, deps); // empty window, 6d later
    expect(res.status).toBe('empty');
    expect(res.surfacing?.aging.resurfaced.map((i) => i.id)).toContain(id);
    expect(posted.some((p) => p.includes('⚠️') && p.includes('Open work'))).toBe(true);
    expect(posted.some((p) => p.includes('Still open?'))).toBe(true);

    const t = openTrackerDb(trackerPath);
    const item = t.listOpen().find((i) => i.id === id)!;
    expect(item.resurfaced_at).not.toBeNull();
    expect(item.digest_msg_id).not.toBeNull(); // bound to the "still open?" message
    t.close();
  });
});

describe('surfacing — keep-open does not auto-archive (final-sweep F1)', () => {
  it('does NOT auto-archive a todo the human just kept open, even if it was past archive grace', async () => {
    const T0 = 100 * DAY;
    insertMsg({ id: 'OLDK', content: 'old' });
    await runTrackerStep(corpus, cfg, emptyModel, T0, null);
    const t0 = openTrackerDb(trackerPath);
    const id = t0.createItem(
      { kind: 'todo', text: 'keep open please', owner: 'Ada', owner_id: 'u-ada', confidence: 'high', blocked: false, source_msg_id: 'OLDK', source_url: 'https://discord.com/channels/g1/c1/OLDK' },
      { source: 'synth_infer', ts: T0 - 20 * DAY, detail: {} },
    );
    t0.resurfaceItem(id, { source: 'aging', ts: T0 - 10 * DAY, detail: {} }); // resurfaced, now past the 9d grace
    t0.flagReview(id, { source: 'synth_infer', ts: T0 - 5 * DAY, detail: {} }); // then a weak close → needs_review
    t0.setDigestMsgId(id, 'm-lookdone', 'looks-done');
    t0.setState('surfacing_channel_id', 'CHAN');
    t0.close();

    // Human reacts ❌ "still open" on the looks-done message; aging runs right after.
    const { deps } = fakes({ 'm-lookdone': [{ emoji: '❌', reactors: [{ id: 'h-ada', bot: false }] }] });
    const res = await runTrackerStep(corpus, cfg, emptyModel, T0, 9, deps);
    expect(res.surfacing?.reactions.reopened).toBe(1);

    const t = openTrackerDb(trackerPath);
    const item = t.getItem(id)!;
    expect(item.status).toBe('open'); // NOT archived
    expect(item.resurfaced_at).toBeNull(); // aging clock reset by keep-open
    t.close();
  });
});

describe('surfacing — a failed reaction pass blocks destructive work (final-verify VF1)', () => {
  it('demotes closes, skips aging + posting when reactions could not be read', async () => {
    await runTrackerStep(corpus, cfg, emptyModel, 1000, null); // first-boot
    const t0 = openTrackerDb(trackerPath);
    const id = t0.createItem(
      { kind: 'todo', text: 'still being worked', owner: 'Ada', owner_id: 'u-ada', confidence: 'high', blocked: false, source_msg_id: 'src', source_url: 'https://discord.com/channels/g1/c1/src' },
      { source: 'synth_infer', ts: 1000, detail: {} },
    );
    t0.setDigestMsgId(id, 'bound', 'new'); // bound so the reaction pass tries to read it
    t0.setState('surfacing_channel_id', 'CHAN');
    t0.close();

    insertMsg({ id: 'WIN', content: 'looks done now' });
    const closeModel = async (): Promise<import('../src/tracker/types.js').Reconciliation> => ({
      new_items: [],
      resolutions: [{ target_id: id, type: 'done', strength: 'strong', evidence_msg_id: 'WIN' }],
      touches: [],
    });
    const { deps, posted } = fakes();
    deps.read = async () => {
      throw new Error('429 rate limited');
    };
    const res = await runTrackerStep(corpus, cfg, closeModel, 2000, 7, deps);
    expect(res.surfacing?.reactions.readErrors).toBeGreaterThan(0);
    expect(res.surfacing?.agingSkippedDueToReadErrors).toBe(true);

    const t = openTrackerDb(trackerPath);
    const item = t.getItem(id)!;
    expect(item.status).toBe('open'); // NOT auto-closed — demoted while reactions unsafe
    expect(item.needs_review).toBe(true); // became a "looks done?" review instead
    t.close();
    expect(posted).toHaveLength(0); // no posting (no rebinding) while reactions unsafe
  });
});
