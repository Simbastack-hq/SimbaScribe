import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db, type MessageRow } from '../src/db/client.js';
import {
  listChannels,
  recentMessages,
  searchMessages,
  messagesInWindow,
  getMessage,
  clampLimit,
  escapeLike,
  withSnapshot,
  DEFAULT_LIMIT,
  MAX_LIMIT,
} from '../src/mcp-server/db.js';

let db: Db;

function insertMsg(over: Partial<MessageRow>): void {
  const row: MessageRow = {
    id: Math.random().toString(36).slice(2),
    channel_id: 'c1',
    channel_name: 'engineering',
    guild_id: 'g1',
    author_id: 'a1',
    author_name: 'Sam',
    ts: 1700000000000,
    content: 'hi',
    reply_to_id: null,
    thread_root_id: null,
    attachments: '[]',
    edits: '[]',
    deleted_at: null,
    reactions: '{}',
    ...over,
  };
  db.insertMessage(row);
}

beforeEach(() => {
  db = openDb(':memory:');
});

afterEach(() => {
  db.close();
});

describe('clampLimit', () => {
  it('defaults when undefined or NaN', () => {
    expect(clampLimit(undefined)).toBe(DEFAULT_LIMIT);
    expect(clampLimit(Number.NaN)).toBe(DEFAULT_LIMIT);
  });
  it('floors to 1 and caps at MAX_LIMIT', () => {
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(-10)).toBe(1);
    expect(clampLimit(99999)).toBe(MAX_LIMIT);
    expect(clampLimit(30)).toBe(30);
  });
});

describe('escapeLike', () => {
  it('escapes LIKE metacharacters and the escape char', () => {
    expect(escapeLike('100%_done\\')).toBe('100\\%\\_done\\\\');
  });
});

describe('listChannels', () => {
  it('counts non-deleted messages per channel, newest channel first', () => {
    insertMsg({ channel_id: 'c1', channel_name: 'engineering', ts: 100 });
    insertMsg({ channel_id: 'c1', channel_name: 'engineering', ts: 200 });
    insertMsg({ channel_id: 'c2', channel_name: 'product', ts: 300 });
    insertMsg({ channel_id: 'c2', channel_name: 'product', ts: 50, deleted_at: 999 });

    const channels = listChannels(db.raw);
    expect(channels).toEqual([
      { channel_id: 'c2', channel_name: 'product', message_count: 1, last_ts: 300 },
      { channel_id: 'c1', channel_name: 'engineering', message_count: 2, last_ts: 200 },
    ]);
  });
});

describe('recentMessages', () => {
  it('returns newest first and excludes deleted', () => {
    insertMsg({ id: 'm1', ts: 100, content: 'first' });
    insertMsg({ id: 'm2', ts: 300, content: 'third' });
    insertMsg({ id: 'm3', ts: 200, content: 'second' });
    insertMsg({ id: 'm4', ts: 400, content: 'gone', deleted_at: 1 });

    const out = recentMessages(db.raw, {});
    expect(out.map((m) => m.id)).toEqual(['m2', 'm3', 'm1']);
  });

  it('filters by channel name OR id', () => {
    insertMsg({ id: 'a', channel_id: 'c1', channel_name: 'engineering' });
    insertMsg({ id: 'b', channel_id: 'c2', channel_name: 'product' });

    expect(recentMessages(db.raw, { channel: 'product' }).map((m) => m.id)).toEqual(['b']);
    expect(recentMessages(db.raw, { channel: 'c1' }).map((m) => m.id)).toEqual(['a']);
  });

  it('caps the result at the clamped limit', () => {
    for (let i = 0; i < 5; i++) insertMsg({ id: `m${i}`, ts: 1000 + i });
    expect(recentMessages(db.raw, { limit: 2 })).toHaveLength(2);
    expect(recentMessages(db.raw, { limit: 0 })).toHaveLength(1);
  });

  it('uses edited content, keeps null-content rows, parses reaction counts, builds the url', () => {
    insertMsg({
      id: '999',
      channel_id: '888',
      guild_id: 'GUILD',
      content: 'original',
      edits: JSON.stringify([{ ts: 1, content: 'edited!' }]),
      reactions: JSON.stringify({ '✅': ['u1', 'u2'], '👀': ['u3'] }),
      ts: 500,
    });
    insertMsg({ id: 'noText', content: null, ts: 400 });

    const out = recentMessages(db.raw, {});
    const edited = out.find((m) => m.id === '999')!;
    expect(edited.content).toBe('edited!');
    expect(edited.reactions).toEqual({ '✅': 2, '👀': 1 });
    expect(edited.url).toBe('https://discord.com/channels/GUILD/888/999');

    const empty = out.find((m) => m.id === 'noText')!;
    expect(empty).toBeDefined();
    expect(empty.content).toBe('');
  });

  it('falls back gracefully on malformed edits/reactions JSON (does not throw)', () => {
    insertMsg({ id: 'bad', content: 'orig', edits: 'not-json', reactions: 'not-json' });
    const out = recentMessages(db.raw, {});
    const bad = out.find((m) => m.id === 'bad')!;
    expect(bad.content).toBe('orig');
    expect(bad.reactions).toEqual({});
  });
});

describe('searchMessages', () => {
  it('matches substrings case-insensitively and excludes deleted + null content', () => {
    insertMsg({ id: 'm1', content: 'Deploy the API today', ts: 100 });
    insertMsg({ id: 'm2', content: 'nothing relevant', ts: 200 });
    insertMsg({ id: 'm3', content: 'deploy done', ts: 300, deleted_at: 1 });
    insertMsg({ id: 'm4', content: null, ts: 400 });

    expect(searchMessages(db.raw, { query: 'deploy' }).map((m) => m.id)).toEqual(['m1']);
  });

  it('treats % and _ as literals, not wildcards', () => {
    insertMsg({ id: 'pct', content: 'we are 100% done' });
    insertMsg({ id: 'underscore', content: 'file_name.ts' });
    insertMsg({ id: 'other', content: 'totally unrelated text' });

    // Without escaping, "%" would match everything; "_" would match any char.
    expect(searchMessages(db.raw, { query: '100%' }).map((m) => m.id)).toEqual(['pct']);
    expect(searchMessages(db.raw, { query: 'file_name' }).map((m) => m.id)).toEqual(['underscore']);
  });

  it('searches original content only (edited-in text is not matched)', () => {
    insertMsg({
      id: 'm1',
      content: 'placeholder',
      edits: JSON.stringify([{ ts: 1, content: 'now mentions kubernetes' }]),
    });
    expect(searchMessages(db.raw, { query: 'kubernetes' })).toHaveLength(0);
    expect(searchMessages(db.raw, { query: 'placeholder' }).map((m) => m.id)).toEqual(['m1']);
  });
});

describe('messagesInWindow', () => {
  it('includes both boundaries and returns chronological order', () => {
    insertMsg({ id: 'before', ts: 99 });
    insertMsg({ id: 'start', ts: 100 });
    insertMsg({ id: 'mid', ts: 150 });
    insertMsg({ id: 'end', ts: 200 });
    insertMsg({ id: 'after', ts: 201 });

    const out = messagesInWindow(db.raw, { startTs: 100, endTs: 200 });
    expect(out.map((m) => m.id)).toEqual(['start', 'mid', 'end']);
  });

  it('excludes deleted and respects channel filter', () => {
    insertMsg({ id: 'k', channel_name: 'engineering', ts: 100 });
    insertMsg({ id: 'm', channel_name: 'product', ts: 120 });
    insertMsg({ id: 'd', channel_name: 'engineering', ts: 130, deleted_at: 1 });

    expect(messagesInWindow(db.raw, { startTs: 0, endTs: 999, channel: 'engineering' }).map((m) => m.id)).toEqual(['k']);
  });

  it('throws on an inverted window', () => {
    expect(() => messagesInWindow(db.raw, { startTs: 200, endTs: 100 })).toThrow(/startTs/);
  });
});

describe('getMessage', () => {
  it('returns the message and the message it replied to', () => {
    insertMsg({ id: 'parent', content: 'can you deploy?', ts: 100 });
    insertMsg({ id: 'child', content: 'haan kar diya', reply_to_id: 'parent', ts: 200 });

    const out = getMessage(db.raw, 'child');
    expect(out?.message.id).toBe('child');
    expect(out?.replied_to?.id).toBe('parent');
  });

  it('returns null replied_to when there is no reply', () => {
    insertMsg({ id: 'solo', content: 'standalone' });
    expect(getMessage(db.raw, 'solo')?.replied_to).toBeNull();
  });

  it('omits a deleted reply-parent from context (still returns the message)', () => {
    insertMsg({ id: 'gone', content: 'deleted parent', deleted_at: 1 });
    insertMsg({ id: 'kid', content: 'reply', reply_to_id: 'gone' });
    const out = getMessage(db.raw, 'kid');
    expect(out?.message.id).toBe('kid');
    expect(out?.replied_to).toBeNull();
  });

  it('returns null for a missing or deleted message', () => {
    insertMsg({ id: 'gone', content: 'x', deleted_at: 1 });
    expect(getMessage(db.raw, 'gone')).toBeNull();
    expect(getMessage(db.raw, 'nope')).toBeNull();
  });
});

describe('withSnapshot (read-only file open)', () => {
  let dir: string;
  let snapshotPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ss-mcp-'));
    snapshotPath = join(dir, 'snapshot.db');
    const seed = openDb(snapshotPath);
    seed.insertMessage({
      id: 's1',
      channel_id: 'c1',
      channel_name: 'engineering',
      guild_id: 'g1',
      author_id: 'a1',
      author_name: 'Sam',
      ts: 100,
      content: 'snapshot row',
      reply_to_id: null,
      thread_root_id: null,
      attachments: '[]',
      edits: '[]',
      deleted_at: null,
      reactions: '{}',
    });
    seed.close();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads from a standalone snapshot file', () => {
    const out = withSnapshot(snapshotPath, (d) => recentMessages(d, {}));
    expect(out.map((m) => m.id)).toEqual(['s1']);
  });

  it('throws if the snapshot file is missing', () => {
    expect(() => withSnapshot(join(dir, 'nope.db'), () => 1)).toThrow();
  });

  it('rejects writes through the read-only handle', () => {
    expect(() =>
      withSnapshot(snapshotPath, (d) => d.prepare("UPDATE messages SET content = 'x'").run()),
    ).toThrow(/readonly|read-only/i);
  });
});
