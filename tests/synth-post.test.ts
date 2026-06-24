import { describe, it, expect, vi, afterEach } from 'vitest';
import { splitForDiscord, postToWebhook } from '../src/synth/post.js';

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

  it('never hard-splits inside a <@id> mention token (token stays intact in one chunk)', () => {
    const token = `<@${'1'.repeat(18)}>`; // 21 chars — fits within the limit
    const line = `${'x'.repeat(20)}${token}${'y'.repeat(5)}`; // 46-char single line, no newline
    const chunks = splitForDiscord(line, 30);
    // The token must appear whole in exactly one chunk, and no chunk may hold a fragment.
    expect(chunks.some((c) => c.includes(token))).toBe(true);
    for (const c of chunks) {
      if (!c.includes(token)) expect(c).not.toMatch(/<@\d/); // no partial token left behind
    }
    expect(chunks.join('')).toBe(line); // nothing dropped
  });
});

describe('postToWebhook allowed_mentions', () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch() {
    // 200 with a tiny body — NOT 204 (a 204 Response cannot carry a body and the
    // constructor throws, which would look like a network failure to postToWebhook).
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }
  const bodyOf = (mock: ReturnType<typeof vi.fn>, i: number) =>
    JSON.parse((mock.mock.calls[i]![1] as { body: string }).body) as {
      content: string;
      allowed_mentions: { parse: string[]; users?: string[] };
    };

  it('with no allow-list, sends { parse: [] } byte-identical to the safe default (no users key)', async () => {
    const fetchMock = stubFetch();
    await postToWebhook('http://hook', 'hello world');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bodyOf(fetchMock, 0).allowed_mentions).toEqual({ parse: [] });
    expect('users' in bodyOf(fetchMock, 0).allowed_mentions).toBe(false);
  });

  it('lists only the IDs whose <@id> token is actually present in that chunk', async () => {
    const fetchMock = stubFetch();
    const [id1, id3] = ['111111111111111111', '333333333333333333'];
    // id3 is allow-listed but NOT in the content → must be filtered out.
    await postToWebhook('http://hook', `<@${id1}> shipped it`, [id1, id3]);
    expect(bodyOf(fetchMock, 0).allowed_mentions).toEqual({ parse: [], users: [id1] });
  });

  it('computes the allow-list PER chunk — a person is tagged only where their token lands', async () => {
    const fetchMock = stubFetch();
    const [id1, id2] = ['111111111111111111', '222222222222222222'];
    const filler = 'x'.repeat(1850); // forces a chunk boundary between the two mentions
    await postToWebhook('http://hook', `<@${id1}> top\n${filler}\n<@${id2}> bottom`, [id1, id2]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodyOf(fetchMock, 0).allowed_mentions).toEqual({ parse: [], users: [id1] });
    expect(bodyOf(fetchMock, 1).allowed_mentions).toEqual({ parse: [], users: [id2] });
  });
});
