import { describe, it, expect } from 'vitest';
import { renderTrackerSections, selectDecisionNeeded, type SurfacingInput } from '../src/tracker/surfacing.js';
import type { AgingResult } from '../src/tracker/aging.js';
import type { TrackerItem, TrackerKind } from '../src/tracker/types.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 10 * DAY;

let nextId = 1;
function item(over: Partial<TrackerItem> & { kind: TrackerKind }): TrackerItem {
  return {
    id: nextId++,
    text: 'do the thing',
    owner: null,
    owner_id: null,
    status: 'open',
    confidence: 'high',
    blocked: false,
    human_flag: null,
    source_msg_id: 's',
    source_url: 'https://discord.com/channels/g/c/s',
    created_at: 0,
    last_seen_at: NOW,
    resolved_at: null,
    resolved_msg_id: null,
    resolved_url: null,
    resolved_by: null,
    needs_review: false,
    superseded_by: null,
    resurfaced_at: null,
    digest_msg_id: null,
    ...over,
  };
}

const noAging: AgingResult = { resurfaced: [], revisited: [], archived: [] };
const emojis = { confirmEmoji: '✅', vetoEmoji: '❌' };

function input(over: Partial<SurfacingInput>): SurfacingInput {
  return { openItems: [], createdIds: [], flaggedReviewIds: [], aging: noAging, ...over };
}

describe('renderTrackerSections', () => {
  it('returns empty string when there is nothing to surface', () => {
    expect(renderTrackerSections(input({}), NOW)).toBe('');
  });

  it('renders open todos: blocked first, then resurfaced, then oldest', () => {
    const fresh = item({ kind: 'todo', text: 'fresh todo', owner: 'Ada', last_seen_at: NOW });
    const blocked = item({ kind: 'todo', text: 'blocked todo', owner: 'Ben', blocked: true, last_seen_at: NOW });
    const stale = item({ kind: 'todo', text: 'stale todo', owner: 'Cara', resurfaced_at: NOW - DAY, last_seen_at: NOW - 6 * DAY });
    const out = renderTrackerSections(input({ openItems: [fresh, blocked, stale] }), NOW);
    expect(out).toContain('**📋 Open work**');
    const lines = out.split('\n').filter((l) => l.startsWith('- '));
    expect(lines[0]).toContain('blocked todo'); // blocked first (🔴)
    expect(lines[0]).toContain('🔴');
    expect(lines[1]).toContain('stale todo'); // then resurfaced (⚠️)
    expect(lines[1]).toContain('⚠️');
    expect(lines[2]).toContain('fresh todo');
    expect(out).toContain('**Ada** →');
    expect(out).toContain('(6d)'); // stale age
    expect(out).toContain('([src](https://discord.com/channels/g/c/s))'); // cited
  });

  it('renders new decisions (created this run) under 🗳, and skips non-created decisions', () => {
    const newDec = item({ kind: 'decision', text: 'use Postgres for the queue' });
    const oldDec = item({ kind: 'decision', text: 'old decision' });
    const out = renderTrackerSections(input({ openItems: [newDec, oldDec], createdIds: [newDec.id] }), NOW);
    expect(out).toContain('**🗳 Decisions logged**');
    expect(out).toContain('use Postgres for the queue');
    expect(out).not.toContain('old decision');
  });

  it('renders revisited ideas under 💡, only the ones nudged this run', () => {
    const idea = item({ kind: 'idea', text: 'try a dark mode' });
    const out = renderTrackerSections(input({ openItems: [idea], aging: { ...noAging, revisited: [idea] } }), NOW);
    expect(out).toContain('**💡 Parked ideas**');
    expect(out).toContain('try a dark mode — worth revisiting?');
  });

  it('skips sections with no entries', () => {
    const todo = item({ kind: 'todo', text: 'only a todo', owner: 'Ada' });
    const out = renderTrackerSections(input({ openItems: [todo] }), NOW);
    expect(out).toContain('📋 Open work');
    expect(out).not.toContain('🗳');
    expect(out).not.toContain('💡');
  });
});

describe('selectDecisionNeeded', () => {
  it('selects new / looks-done / resurfaced / revisit items with the right prompt + emoji', () => {
    const created = item({ kind: 'todo', text: 'new todo' });
    const weak = item({ kind: 'todo', text: 'maybe-done todo', needs_review: true });
    const stale = item({ kind: 'todo', text: 'stale todo', resurfaced_at: NOW });
    const idea = item({ kind: 'idea', text: 'old idea' });
    const inp = input({
      openItems: [created, weak, stale, idea],
      createdIds: [created.id],
      flaggedReviewIds: [weak.id],
      aging: { resurfaced: [stale], revisited: [idea], archived: [] },
    });
    const out = selectDecisionNeeded(inp, emojis);
    const byId = new Map(out.map((d) => [d.itemId, d]));
    expect(byId.get(weak.id)!.reason).toBe('looks-done');
    expect(byId.get(weak.id)!.messageText(weak)).toContain('Looks done?');
    expect(byId.get(weak.id)!.messageText(weak)).toContain('✅ confirm closed');
    expect(byId.get(stale.id)!.reason).toBe('resurfaced');
    expect(byId.get(stale.id)!.messageText(stale)).toContain('Still open?');
    expect(byId.get(idea.id)!.reason).toBe('revisit');
    expect(byId.get(created.id)!.reason).toBe('new');
    expect(byId.get(created.id)!.messageText(created)).toContain('🆕 New todo:');
    expect(byId.get(created.id)!.messageText(created)).toContain('❌ if wrong');
  });

  it('lists each item at most once, by precedence (looks-done > resurfaced > new)', () => {
    // An item that is BOTH newly created AND flagged for review should appear once,
    // as looks-done (higher precedence).
    const both = item({ kind: 'todo', text: 'created and weak', needs_review: true });
    const inp = input({ openItems: [both], createdIds: [both.id], flaggedReviewIds: [both.id] });
    const out = selectDecisionNeeded(inp, emojis);
    expect(out).toHaveLength(1);
    expect(out[0]!.reason).toBe('looks-done');
  });

  it('skips an item that is no longer open (e.g. archived this run)', () => {
    const archived = item({ kind: 'todo', text: 'archived todo' });
    // present in createdIds but NOT in openItems → no message
    const inp = input({ openItems: [], createdIds: [archived.id] });
    expect(selectDecisionNeeded(inp, emojis)).toHaveLength(0);
  });
});
