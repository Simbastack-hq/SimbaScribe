import 'dotenv/config';

/** Throws if the env var is missing or empty; trims whitespace. */
export function required(name: string): string {
  const val = process.env[name];
  if (val === undefined || val.trim() === '') {
    throw new Error(`Missing required env var: ${name}`);
  }
  return val.trim();
}

/**
 * Parses a comma-separated list of Discord channel snowflake IDs into a Set.
 *
 * Fails loud on:
 *   - empty / whitespace-only input
 *   - any value that isn't a 17-20 digit snowflake
 *
 * Whitespace around commas is tolerated.
 */
export function parseChannelIds(raw: string): Set<string> {
  if (raw.trim() === '') {
    throw new Error('SIMBASCRIBE_WHITELIST_CHANNEL_IDS must not be empty');
  }
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) {
    throw new Error('SIMBASCRIBE_WHITELIST_CHANNEL_IDS must contain at least one channel ID');
  }
  for (const id of parts) {
    if (!/^\d{17,20}$/.test(id)) {
      throw new Error(
        `Invalid Discord channel ID (expected 17-20 digit snowflake): ${JSON.stringify(id)}`,
      );
    }
  }
  return new Set(parts);
}

export interface Config {
  readonly discordBotToken: string;
  readonly discordGuildId: string;
  readonly whitelistChannelIds: ReadonlySet<string>;
  readonly dbPath: string;
  readonly logLevel: string;
}

export function loadConfig(): Config {
  return {
    discordBotToken: required('DISCORD_BOT_TOKEN'),
    discordGuildId: required('DISCORD_GUILD_ID'),
    whitelistChannelIds: parseChannelIds(required('SIMBASCRIBE_WHITELIST_CHANNEL_IDS')),
    dbPath: required('SIMBASCRIBE_DB_PATH'),
    logLevel: process.env.LOG_LEVEL?.trim() || 'info',
  };
}
