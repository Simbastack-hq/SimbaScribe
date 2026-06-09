import { describe, it, expect } from 'vitest';
import { validateReconciliation, type ValidationContext } from '../src/tracker/validate.js';
import type { TrackerItem, TrackerKind, Reconciliation } from '../src/tracker/types.js';

function item(id: number, kind: TrackerKind): TrackerItem {
  return {
    id,
    kind,
    text: 'x',
    owner: null,
    owner_id: null,
    status: 'open',
    confidence: 'high',
    blocked: false,
    human_flag: null,
    source_msg_id: 'src',
    source_url: 'u',
    created_at: 0,
    last_seen_at: 0,
    resolved_at: null,
    resolved_msg_id: null,
    resolved_url: null,
    resolved_by: null,
    needs_review: false,
    superseded_by: null,
    resurfaced_at: null,
    digest_msg_id: null,
  };
}

const empty: Reconciliation = { new_items: [], resolutions: [], touches: [] };

function ctx(items: TrackerItem[], msgIds: string[]): ValidationContext {
  return { openItems: new Map(items.map((i) => [i.id, i])), windowMsgIds: new Set(msgIds) };
}

describe('validateReconciliation — new_items', () => {
  it('accepts a well-formed in-window todo', () => {
    const r = validateReconciliation(
      { ...empty, new_items: [{ kind: 'todo', text: 'deploy', owner: 'Ada', owner_id: 'u1', confidence: 'high', blocked: false, source_msg_id: 'w1' }] },
      ctx([], ['w1']),
    );
    expect(r.valid.new_items).toHaveLength(1);
    expect(r.rejected).toHaveLength(0);
  });

  it('rejects a kind not emitted in v1 (question)', () => {
    const r = validateReconciliation(
      { ...empty, new_items: [{ kind: 'question', text: 'kab hoga', owner: null, owner_id: null, confidence: 'high', blocked: false, source_msg_id: 'w1' }] },
      ctx([], ['w1']),
    );
    expect(r.valid.new_items).toHaveLength(0);
    expect(r.rejected[0]?.reason).toMatch(/not emitted in v1/);
  });

  it('rejects empty text, bad confidence, and out-of-window source', () => {
    const r = validateReconciliation(
      {
        ...empty,
        new_items: [
          { kind: 'todo', text: '   ', owner: null, owner_id: null, confidence: 'high', blocked: false, source_msg_id: 'w1' },
          { kind: 'todo', text: 'ok', owner: null, owner_id: null, confidence: 'medium' as 'high', blocked: false, source_msg_id: 'w1' },
          { kind: 'todo', text: 'ok', owner: null, owner_id: null, confidence: 'high', blocked: false, source_msg_id: 'NOT-IN-WINDOW' },
        ],
      },
      ctx([], ['w1']),
    );
    expect(r.valid.new_items).toHaveLength(0);
    expect(r.rejected).toHaveLength(3);
  });

  it('forces blocked off for non-todo kinds', () => {
    const r = validateReconciliation(
      { ...empty, new_items: [{ kind: 'idea', text: 'maybe X', owner: null, owner_id: null, confidence: 'low', blocked: true, source_msg_id: 'w1' }] },
      ctx([], ['w1']),
    );
    expect(r.valid.new_items[0]?.blocked).toBe(false);
  });
});

describe('validateReconciliation — resolutions (injection defense)', () => {
  it('accepts a strong done on an open todo with in-window evidence', () => {
    const r = validateReconciliation(
      { ...empty, resolutions: [{ target_id: 7, type: 'done', strength: 'strong', evidence_msg_id: 'w2' }] },
      ctx([item(7, 'todo')], ['w2']),
    );
    expect(r.valid.resolutions).toHaveLength(1);
  });

  it('rejects a resolution whose target is not open/known (cannot close arbitrary ids)', () => {
    const r = validateReconciliation(
      { ...empty, resolutions: [{ target_id: 999, type: 'done', strength: 'strong', evidence_msg_id: 'w2' }] },
      ctx([item(7, 'todo')], ['w2']),
    );
    expect(r.valid.resolutions).toHaveLength(0);
    expect(r.rejected[0]?.reason).toMatch(/not open\/unknown/);
  });

  it('rejects evidence outside the window (an injection cannot cite an unread message)', () => {
    const r = validateReconciliation(
      { ...empty, resolutions: [{ target_id: 7, type: 'done', strength: 'strong', evidence_msg_id: 'ELSEWHERE' }] },
      ctx([item(7, 'todo')], ['w2']),
    );
    expect(r.valid.resolutions).toHaveLength(0);
    expect(r.rejected[0]?.reason).toMatch(/not in this run's window/);
  });

  it('rejects an illegal transition (done on an idea)', () => {
    const r = validateReconciliation(
      { ...empty, resolutions: [{ target_id: 3, type: 'done', strength: 'strong', evidence_msg_id: 'w2' }] },
      ctx([item(3, 'idea')], ['w2']),
    );
    expect(r.valid.resolutions).toHaveLength(0);
    expect(r.rejected[0]?.reason).toMatch(/illegal done on idea/);
  });
});

describe('validateReconciliation — touches', () => {
  it('rejects a touch on an unknown target or out-of-window evidence', () => {
    const r = validateReconciliation(
      { ...empty, touches: [
        { target_id: 999, evidence_msg_id: 'w1' },
        { target_id: 7, evidence_msg_id: 'NOPE' },
      ] },
      ctx([item(7, 'todo')], ['w1']),
    );
    expect(r.valid.touches).toHaveLength(0);
    expect(r.rejected).toHaveLength(2);
  });
});
