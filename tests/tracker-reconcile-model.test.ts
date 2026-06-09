import { describe, it, expect } from 'vitest';
import { parseReconciliation } from '../src/tracker/reconcile-model.js';

describe('parseReconciliation', () => {
  it('parses a full well-formed object', () => {
    const raw = JSON.stringify({
      new_items: [
        {
          kind: 'todo',
          text: 'deploy api',
          owner: 'Ada',
          owner_id: 'u1',
          confidence: 'high',
          blocked: false,
          source_msg_id: 'm1',
        },
      ],
      resolutions: [{ target_id: 7, type: 'done', strength: 'strong', evidence_msg_id: 'm2' }],
      touches: [{ target_id: 9, evidence_msg_id: 'm3' }],
    });
    const r = parseReconciliation(raw);
    expect(r.new_items).toHaveLength(1);
    expect(r.resolutions[0]!.target_id).toBe(7);
    expect(r.touches[0]!.target_id).toBe(9);
  });

  it('defaults missing arrays to empty (terse "nothing to do" reply)', () => {
    expect(parseReconciliation('{}')).toEqual({ new_items: [], resolutions: [], touches: [] });
    expect(parseReconciliation('{"new_items":[]}').resolutions).toEqual([]);
  });

  it('defaults optional new-item fields (owner/owner_id/blocked)', () => {
    const raw = JSON.stringify({
      new_items: [{ kind: 'idea', text: 'an idea', confidence: 'low', source_msg_id: 'm1' }],
    });
    const item = parseReconciliation(raw).new_items[0]!;
    expect(item.owner).toBeNull();
    expect(item.owner_id).toBeNull();
    expect(item.blocked).toBe(false);
  });

  it('strips ```json fences if the model wraps output', () => {
    const raw = '```json\n{"new_items":[],"resolutions":[],"touches":[]}\n```';
    expect(parseReconciliation(raw)).toEqual({ new_items: [], resolutions: [], touches: [] });
  });

  it('throws on non-JSON', () => {
    expect(() => parseReconciliation('not json at all')).toThrow(/not valid JSON/);
  });

  it('throws on schema violation (bad kind / missing required field)', () => {
    expect(() =>
      parseReconciliation(JSON.stringify({ new_items: [{ kind: 'bogus', text: 'x', confidence: 'high', source_msg_id: 'm' }] })),
    ).toThrow();
    expect(() =>
      parseReconciliation(JSON.stringify({ resolutions: [{ target_id: 1, type: 'done', strength: 'strong' }] })),
    ).toThrow(); // missing evidence_msg_id
  });
});
