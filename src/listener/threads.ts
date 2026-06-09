import { Events, type Client, type AnyThreadChannel } from 'discord.js';
import type { Db } from '../db/client.js';
import type { Config } from '../config.js';
import type { Logger } from '../log.js';
import { backfillChannel, type BackfillDeps } from './backfill.js';

export interface ThreadDeps {
  client: Client;
  db: Db;
  config: Config;
  log: Logger;
}

/**
 * Ensures the bot is a member of a thread whose parent is whitelisted.
 *
 * A bot only receives message events from a PRIVATE thread if it is a member.
 * (Public threads under a readable channel deliver events without joining, but
 * joining is harmless and keeps behavior uniform.) For private threads the bot
 * must be able to see/join the thread — that requires Manage Threads on the
 * parent (or having been added manually).
 *
 * Returns true if, after this call, the bot is a member of the thread.
 */
async function ensureJoined(
  thread: AnyThreadChannel,
  config: Config,
  log: Logger,
): Promise<boolean> {
  if (thread.parentId === null || !config.whitelistChannelIds.has(thread.parentId)) return false;
  if (thread.joined) return true;
  if (!thread.joinable) {
    log.warn(
      { threadId: thread.id, parentId: thread.parentId, name: thread.name },
      'thread under whitelisted parent is not joinable — bot likely lacks Manage Threads or access; its messages will NOT be captured',
    );
    return false;
  }
  try {
    await thread.join();
    log.info(
      { threadId: thread.id, parentId: thread.parentId, name: thread.name },
      'joined whitelisted thread',
    );
    return true;
  } catch (err) {
    log.error({ err, threadId: thread.id }, 'failed to join thread');
    return false;
  }
}

/**
 * Joins a whitelisted-parent thread, then seeds/backfills its messages.
 *
 * The seed (seedWhenEmpty) matters for two cases the live messageCreate path
 * can't cover:
 *   1. A thread created while the bot was offline — its backlog has no DB rows.
 *   2. The starter message of a brand-new private thread — it may be dispatched
 *      before our join() completes, so the live event is missed. Seeding after
 *      join recovers it (ON CONFLICT DO NOTHING dedupes against live capture).
 */
async function joinAndSyncThread(thread: AnyThreadChannel, deps: ThreadDeps): Promise<void> {
  const joined = await ensureJoined(thread, deps.config, deps.log);
  if (!joined) return;
  const backfillDeps: BackfillDeps = {
    client: deps.client,
    db: deps.db,
    config: deps.config,
    log: deps.log,
  };
  await backfillChannel(thread.id, backfillDeps, { seedWhenEmpty: true });
}

/**
 * Registers the threadCreate handler so new threads under whitelisted parents
 * are joined and seeded as soon as they're created. Call once at startup.
 */
export function registerThreadHandlers(deps: ThreadDeps): void {
  deps.client.on(Events.ThreadCreate, (thread) => {
    void joinAndSyncThread(thread, deps);
  });
}

/**
 * Joins and syncs all currently-active threads under whitelisted parents.
 * Call on (re)connect. Enumerates active threads once (no duplicate fetch).
 * Archived threads are not enumerated (rare to matter for a 30-min summarizer).
 */
export async function syncActiveThreads(deps: ThreadDeps): Promise<void> {
  const { client, config, log } = deps;
  try {
    const guild = await client.guilds.fetch(config.discordGuildId);
    const active = await guild.channels.fetchActiveThreads();
    for (const thread of active.threads.values()) {
      await joinAndSyncThread(thread, deps);
    }
  } catch (err) {
    log.error({ err, event: 'syncActiveThreads' }, 'failed to enumerate/sync active threads');
  }
}
