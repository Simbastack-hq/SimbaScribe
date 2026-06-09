import type { Client, GuildTextBasedChannel, Message } from 'discord.js';
import type { Db, MessageRow } from '../db/client.js';
import type { Config } from '../config.js';
import type { Logger } from '../log.js';
import { buildMessageRow } from './build-row.js';

const BACKFILL_LIMIT = 100;

/** Discord epoch is 2015-01-01T00:00:00.000Z. */
const DISCORD_EPOCH = 1420070400000n;

/**
 * Converts a Unix ms timestamp into a Discord snowflake suitable for the
 * `after` argument of channel.messages.fetch().
 *
 * Snowflakes are 64-bit integers laid out as:
 *   [42 bits: ms since Discord epoch] [22 bits: worker/process/sequence]
 * To use one as a paging cursor we set the lower 22 bits to zero.
 */
function snowflakeFromTs(tsMs: number): string {
  const snowflake = (BigInt(tsMs) - DISCORD_EPOCH) << 22n;
  return snowflake.toString();
}

export interface BackfillDeps {
  client: Client;
  db: Db;
  config: Config;
  log: Logger;
}

export interface BackfillOptions {
  /**
   * What to do when the DB has no prior message for this channel:
   *   - false (default): SKIP. Used for top-level whitelisted channels — they
   *     exist from day one, so "no rows" means first boot and we capture
   *     forward rather than seeding a large historical backlog.
   *   - true: SEED. Fetch the most recent messages. Used for threads, which are
   *     created mid-stream: "no rows" means we just discovered the thread (e.g.
   *     it was created while the bot was offline, or just now), and its recent
   *     backlog is exactly what we'd otherwise lose.
   */
  seedWhenEmpty?: boolean;
}

/**
 * Backfills one channel (regular channel OR thread) by its ID.
 *
 *   - Has prior rows: fetch up to 100 messages with snowflake > lastTs.
 *   - No prior rows + seedWhenEmpty=false: skip.
 *   - No prior rows + seedWhenEmpty=true: fetch the most recent up-to-100.
 *
 * Inserts in chronological order in one transaction. Concurrent calls are safe
 * (INSERT ... ON CONFLICT DO NOTHING), so a seed that overlaps live capture
 * just no-ops on the duplicates.
 */
export async function backfillChannel(
  channelId: string,
  deps: BackfillDeps,
  options: BackfillOptions = {},
): Promise<void> {
  const { client, db, config, log } = deps;
  try {
    const lastTs = db.getLastTsForChannel(channelId);

    let fetchOptions: { limit: number; after?: string };
    if (lastTs === null) {
      if (!options.seedWhenEmpty) {
        log.debug({ channelId }, 'no prior messages in DB for channel — skipping backfill');
        return;
      }
      fetchOptions = { limit: BACKFILL_LIMIT }; // seed: most recent messages
    } else {
      fetchOptions = { after: snowflakeFromTs(lastTs), limit: BACKFILL_LIMIT };
    }

    const channel = await client.channels.fetch(channelId);
    if (channel === null || !('messages' in channel)) {
      log.warn({ channelId }, 'channel not fetchable or not text-based — skipping backfill');
      return;
    }

    const textChannel = channel as GuildTextBasedChannel;
    const fetched = await textChannel.messages.fetch(fetchOptions);

    if (fetched.size === 0) {
      log.debug({ channelId, lastTs }, 'no missed messages — backfill clean');
      return;
    }

    // Discord returns newest-first; we want chronological for INSERT ordering.
    const chronological: Message[] = Array.from(fetched.values()).reverse();
    const rows: MessageRow[] = chronological.map((m) => buildMessageRow(m, config.discordGuildId));
    db.insertMessagesBatch(rows);

    log.info(
      { channelId, channelName: textChannel.name, count: rows.length, seeded: lastTs === null },
      'backfilled messages for channel',
    );

    if (fetched.size === BACKFILL_LIMIT) {
      log.warn(
        { channelId, channelName: textChannel.name },
        `backfill cap (${BACKFILL_LIMIT}) hit — possible gap of additional messages not retrieved`,
      );
    }
  } catch (err) {
    log.error({ err, channelId, event: 'backfill' }, 'backfill failed for channel');
  }
}

/**
 * Backfills every whitelisted top-level channel (not threads — thread sync
 * lives in threads.ts, which joins them first then seeds/backfills).
 */
export async function runBackfill(deps: BackfillDeps): Promise<void> {
  for (const channelId of deps.config.whitelistChannelIds) {
    await backfillChannel(channelId, deps);
  }
}
