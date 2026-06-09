import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db, type MessageRow } from '../src/db/client.js';
import { openTrackerDb } from '../src/tracker/store.js';
import { runTrackerStep } from '../src/tracker/tracker-step.js';
import { isolateTrackerStep } from '../src/synth/index.js';
import { formatReconcileInput } from '../src/tracker/reconcile-format.js';
import type { Reconciliation } from '../src/tracker/types.js';
import type { WindowMessage } from '../src/synth/store.js';

let dir: string;
let corpus: Db;
let corpusPath: string;
let trackerPath: string;

function insertMsg(over: Partial<MessageRow>): void {
  corpus.insertMessage({
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
  });
}

const cfg = { trackerDbPath: '', discordGuildId: 'g1' };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ss-step-'));
  corpusPath = join(dir, 'corpus.db');
  trackerPath = join(dir, 'tracker.db');
  corpus = openDb(corpusPath);
  cfg.trackerDbPath = trackerPath;
});

afterEach(() => {
  corpus.close();
  rmSync(dir, { recursive: true, force: true });
});

const emptyModel = async (): Promise<Reconciliation> => ({ new_items: [], resolutions: [], touches: [] });

describe('runTrackerStep — first boot', () => {
  it('initializes the watermark to max rowid and processes nothing', async () => {
    insertMsg({ content: 'old history 1' });
    insertMsg({ content: 'old history 2' });
    let called = false;
    const res = await runTrackerStep(corpus, cfg, async () => {
      called = true;
      return emptyModel();
    }, 1000, null);
    expect(res.status).toBe('first-boot');
    expect(called).toBe(false); // history is NOT backfilled
    // tracker DB has no items
    const t = openTrackerDb(trackerPath);
    expect(t.listOpen()).toHaveLength(0);
    t.close();
  });
});

describe('runTrackerStep — window processing', () => {
  beforeEach(async () => {
    // first-boot to set the watermark, then add NEW messages after it
    await runTrackerStep(corpus, cfg, emptyModel, 1000, null);
  });

  it('empty window when nothing new since the watermark', async () => {
    const res = await runTrackerStep(corpus, cfg, emptyModel, 2000, null);
    expect(res.status).toBe('empty');
  });

  it('creates a tracked item the model proposes from the new window', async () => {
    insertMsg({ id: 'NEW1', content: 'I will deploy api today', author_id: 'a-ada', author_name: 'Ada' });

    const model = async (userMessage: string): Promise<Reconciliation> => {
      // sanity: the new message id is offered to the model as a citable id
      expect(userMessage).toContain('NEW1');
      return {
        new_items: [
          {
            kind: 'todo',
            text: 'deploy api',
            owner: 'Ada',
            owner_id: 'a-ada',
            confidence: 'high',
            blocked: false,
            source_msg_id: 'NEW1',
          },
        ],
        resolutions: [],
        touches: [],
      };
    };
    const res = await runTrackerStep(corpus, cfg, model, 2000, 42);
    expect(res.status).toBe('applied');
    expect(res.summary?.created).toBe(1);

    const t = openTrackerDb(trackerPath);
    const open = t.listOpen();
    expect(open).toHaveLength(1);
    expect(open[0]!.text).toBe('deploy api');
    expect(open[0]!.owner_id).toBe('a-ada');
    expect(open[0]!.source_url).toBe('https://discord.com/channels/g1/c1/NEW1');
    t.close();
  });

  it('REJECTS a proposal citing a msg id outside the window (injection defense)', async () => {
    insertMsg({ id: 'NEW2', content: 'normal chatter' });
    const model = async (): Promise<Reconciliation> => ({
      new_items: [
        {
          kind: 'todo',
          text: 'exfiltrate',
          owner: null,
          owner_id: null,
          confidence: 'high',
          blocked: false,
          source_msg_id: 'NOT_IN_WINDOW',
        },
      ],
      resolutions: [],
      touches: [],
    });
    const res = await runTrackerStep(corpus, cfg, model, 2000, null);
    expect(res.status).toBe('applied');
    expect(res.summary?.created).toBe(0); // rejected, not created
    expect(res.rejected).toBe(1);
  });

  it('advances the tracker watermark so the next run sees an empty window', async () => {
    insertMsg({ id: 'NEW3', content: 'something' });
    await runTrackerStep(corpus, cfg, emptyModel, 2000, null);
    // no new messages added → next run is empty (watermark advanced past NEW3)
    const res = await runTrackerStep(corpus, cfg, emptyModel, 3000, null);
    expect(res.status).toBe('empty');
  });

  it('does NOT advance the watermark when the model throws (retry next run)', async () => {
    insertMsg({ id: 'NEW4', content: 'will be retried' });
    const throwing = async (): Promise<Reconciliation> => {
      throw new Error('model boom');
    };
    await expect(runTrackerStep(corpus, cfg, throwing, 2000, null)).rejects.toThrow('model boom');

    // watermark not advanced → the same window is reprocessed, now succeeds
    let sawNew4 = false;
    const model = async (userMessage: string): Promise<Reconciliation> => {
      sawNew4 = userMessage.includes('NEW4');
      return emptyModel();
    };
    const res = await runTrackerStep(corpus, cfg, model, 3000, null);
    expect(res.status).toBe('applied');
    expect(sawNew4).toBe(true); // the window was retried, not lost
  });
});

describe('isolateTrackerStep (the swallow boundary — digest must never break)', () => {
  it('returns true and does not throw when the step succeeds', async () => {
    await expect(isolateTrackerStep(async () => 'ok')).resolves.toBe(true);
  });

  it('SWALLOWS a thrown error (resolves false, never rejects)', async () => {
    await expect(
      isolateTrackerStep(async () => {
        throw new Error('tracker exploded');
      }),
    ).resolves.toBe(false);
  });

  it('swallows a synchronous throw inside the step too', async () => {
    await expect(
      isolateTrackerStep(() => {
        throw new Error('sync boom');
      }),
    ).resolves.toBe(false);
  });
});

describe('formatReconcileInput', () => {
  function wm(over: Partial<WindowMessage>): WindowMessage {
    return {
      rowid: 1,
      id: 'm1',
      channel_id: 'c1',
      channel_name: 'engineering',
      guild_id: 'g1',
      author_id: 'a1',
      author_name: 'Sam',
      ts: 1700000000000,
      content: 'hello',
      edits: '[]',
      reactions: '{}',
      ...over,
    };
  }

  it('lists open items with their ids and the window messages with citable ids', () => {
    const out = formatReconcileInput(
      [
        {
          id: 7,
          kind: 'todo',
          text: 'deploy api',
          owner: 'Ada',
          owner_id: 'a-c',
          status: 'open',
          confidence: 'high',
          blocked: true,
          human_flag: null,
          source_msg_id: 's1',
          source_url: 'u',
          created_at: 1,
          last_seen_at: Date.now(),
          resolved_at: null,
          resolved_msg_id: null,
          resolved_url: null,
          resolved_by: null,
          needs_review: false,
          superseded_by: null,
          resurfaced_at: null,
          digest_msg_id: null,
        },
      ],
      [wm({ id: 'WMSG', content: 'api deployed', author_id: 'a-c', author_name: 'Ada' })],
    );
    expect(out).toContain('#7');
    expect(out).toContain('blocked');
    expect(out).toContain('{WMSG}');
    expect(out).toContain('id=a-c');
    expect(out).toContain('api deployed');
  });

  it('handles the no-open-items and no-messages cases', () => {
    const out = formatReconcileInput([], []);
    expect(out).toContain('(none open)');
    expect(out).toContain('(no new messages)');
  });
});
