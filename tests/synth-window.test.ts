import { describe, it, expect } from 'vitest';
import { formatWindow, effectiveContent, reactionsSummary } from '../src/synth/window.js';
import type { WindowMessage } from '../src/synth/store.js';

function msg(over: Partial<WindowMessage>): WindowMessage {
  return {
    rowid: 1,
    id: '111',
    channel_id: '222',
    channel_name: 'engineering',
    guild_id: '333',
    author_id: 'a-ada',
    author_name: 'Ada',
    ts: 1700000000000,
    content: 'haan karta hoon',
    edits: '[]',
    reactions: '{}',
    ...over,
  };
}

describe('effectiveContent', () => {
  it('returns original content when no edits', () => {
    expect(effectiveContent(msg({ content: 'hello' }))).toBe('hello');
  });

  it('returns the last edit content when edited', () => {
    const edits = JSON.stringify([
      { ts: 1, content: 'first edit' },
      { ts: 2, content: 'final edit' },
    ]);
    expect(effectiveContent(msg({ content: 'original', edits }))).toBe('final edit');
  });

  it('falls back to original on malformed edits JSON', () => {
    expect(effectiveContent(msg({ content: 'orig', edits: 'not json' }))).toBe('orig');
  });

  it('handles null content', () => {
    expect(effectiveContent(msg({ content: null }))).toBe('');
  });
});

describe('reactionsSummary', () => {
  it('is empty for no reactions', () => {
    expect(reactionsSummary(msg({ reactions: '{}' }))).toBe('');
  });

  it('summarizes emoji counts', () => {
    const reactions = JSON.stringify({ '✅': ['u1', 'u2'], '👀': ['u3'] });
    expect(reactionsSummary(msg({ reactions }))).toBe(' [reactions: ✅×2, 👀×1]');
  });

  it('is empty on malformed reactions JSON', () => {
    expect(reactionsSummary(msg({ reactions: 'nope' }))).toBe('');
  });
});

describe('formatWindow', () => {
  it('renders one line per message with channel, author, and link IDs', () => {
    const out = formatWindow(
      [msg({ id: '999', channel_id: '888', content: 'deploy kardunga' })],
      'GUILD',
    );
    expect(out).toContain('[#engineering]');
    expect(out).toContain('Ada');
    expect(out).toContain('{GUILD/888/999}');
    expect(out).toContain('deploy kardunga');
  });

  it('collapses newlines within a message to keep one line per message', () => {
    const out = formatWindow([msg({ content: 'line one\nline two' })], 'G');
    expect(out.split('\n')).toHaveLength(1);
    expect(out).toContain('line one line two');
  });
});
