import { describe, it, expect } from 'vitest';
import { splitForDiscord } from '../src/synth/post.js';

describe('splitForDiscord', () => {
  it('keeps a short digest as a single chunk', () => {
    expect(splitForDiscord('hello world', 1900)).toEqual(['hello world']);
  });

  it('splits on line boundaries under the limit', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i}: ${'x'.repeat(50)}`);
    const chunks = splitForDiscord(lines.join('\n'), 200);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(200);
  });

  it('hard-splits a single line longer than the limit (never truncates)', () => {
    const longLine = 'a'.repeat(5000);
    const chunks = splitForDiscord(longLine, 1900);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1900);
    // every character is preserved across chunks — nothing dropped
    expect(chunks.join('')).toBe(longLine);
  });

  it('preserves all content across chunks for mixed input', () => {
    const content = `header\n${'b'.repeat(3000)}\nfooter`;
    const chunks = splitForDiscord(content, 1900);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1900);
    const rejoined = chunks.join('');
    expect(rejoined).toContain('header');
    expect(rejoined).toContain('footer');
    expect(rejoined).toContain('b'.repeat(3000));
  });

  it('returns a single empty chunk for empty input', () => {
    expect(splitForDiscord('', 1900)).toEqual(['']);
  });
});
