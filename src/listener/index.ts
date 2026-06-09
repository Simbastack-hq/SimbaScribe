import { mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { Events } from 'discord.js';
import { loadConfig } from '../config.js';
import { openDb, type Db } from '../db/client.js';
import { log } from '../log.js';
import { createDiscordClient } from './client.js';
import { registerHandlers } from './handlers.js';
import { runBackfill } from './backfill.js';
import { registerThreadHandlers, syncActiveThreads } from './threads.js';

async function main(): Promise<void> {
  // Restrict file-creation permissions BEFORE we touch the filesystem.
  // Default 022 umask would create the SQLite DB / WAL / SHM as mode 644;
  // 0o077 makes them 600, keeping the corpus owner-only.
  process.umask(0o077);

  const config = loadConfig();
  log.level = config.logLevel;
  log.info(
    {
      whitelistedChannels: config.whitelistChannelIds.size,
      dbPath: config.dbPath,
    },
    'starting simbascribe listener',
  );

  // Ensure DB dir exists with restrictive perms
  const dbDir = dirname(config.dbPath);
  mkdirSync(dbDir, { recursive: true, mode: 0o700 });

  const db = openDb(config.dbPath);

  // Post-open perm check: warns on first-boot or pre-existing files that have
  // loose perms. Runs after openDb so a freshly-created DB file is also covered.
  checkPermissions(dbDir, config.dbPath);

  const client = createDiscordClient();
  registerHandlers({ client, db, config, log });
  registerThreadHandlers({ client, db, config, log });

  // On (re)connect: backfill whitelisted channels, then join + seed/backfill
  // active threads under whitelisted parents (syncActiveThreads joins each
  // thread before fetching its history, since membership is required to read
  // a private thread). Concurrent inserts are safe (ON CONFLICT DO NOTHING) but
  // we still guard against overlapping runs to avoid duplicate REST traffic.
  let initialReadyDone = false;
  let syncInFlight = false;

  const syncOnce = async (reason: string): Promise<void> => {
    if (syncInFlight) {
      log.debug({ reason }, 'sync already in flight — skipping duplicate trigger');
      return;
    }
    syncInFlight = true;
    try {
      log.info({ reason }, 'running channel backfill + thread sync');
      await runBackfill({ client, db, config, log });
      await syncActiveThreads({ client, db, config, log });
    } catch (err) {
      log.error({ err, reason }, 'channel backfill + thread sync failed');
    } finally {
      syncInFlight = false;
    }
  };

  client.once(Events.ClientReady, () => {
    initialReadyDone = true;
    log.info({ user: client.user?.tag }, 'discord client ready');
    void syncOnce('client_ready');
  });

  client.on(Events.ShardResume, (shardId, replayedEvents) => {
    log.info({ shardId, replayedEvents }, 'discord shard resumed');
    void syncOnce('shard_resume');
  });

  client.on(Events.ShardReady, (shardId) => {
    if (!initialReadyDone) return; // initial ready handled by ClientReady above
    log.info({ shardId }, 'discord shard re-ready (hard reconnect)');
    void syncOnce(`shard_ready_${shardId}`);
  });

  client.on(Events.ShardError, (err, shardId) => {
    log.error({ err, shardId }, 'discord shard error');
  });

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, 'shutting down');
    try {
      client.destroy();
    } catch (err) {
      log.error({ err }, 'error destroying discord client');
    }
    try {
      db.close();
    } catch (err) {
      log.error({ err }, 'error closing db');
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // Fail loud on uncaught errors — let PM2 restart
  process.on('unhandledRejection', (err) => {
    log.fatal({ err }, 'unhandled rejection — exiting');
    process.exit(1);
  });
  process.on('uncaughtException', (err) => {
    log.fatal({ err }, 'uncaught exception — exiting');
    process.exit(1);
  });

  await client.login(config.discordBotToken);
}

function checkPermissions(dbDir: string, dbPath: string): void {
  try {
    const dirStat = statSync(dbDir);
    if ((dirStat.mode & 0o077) !== 0) {
      log.warn(
        { path: dbDir, mode: (dirStat.mode & 0o777).toString(8) },
        'data directory is world/group-accessible — recommend chmod 700',
      );
    }
  } catch (err) {
    log.debug({ err, path: dbDir }, 'could not stat data dir');
  }
  try {
    const fileStat = statSync(dbPath);
    if ((fileStat.mode & 0o077) !== 0) {
      log.warn(
        { path: dbPath, mode: (fileStat.mode & 0o777).toString(8) },
        'DB file is world/group-readable — recommend chmod 600',
      );
    }
  } catch {
    // DB doesn't exist yet — that's fine, it will be created with the process umask.
  }
}

main().catch((err) => {
  log.fatal({ err }, 'failed to start');
  process.exit(1);
});

// Used by tests / type checking; not exported to dist consumers.
export type { Db };
