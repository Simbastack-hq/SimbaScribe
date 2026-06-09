import type { Snowflake } from 'discord.js';

export interface ChannelMatchInput {
  id: Snowflake;
  isThread: boolean;
  parentId: Snowflake | null;
}

/**
 * Whether a channel's messages should be captured.
 *
 * A channel matches if:
 *   - it is directly whitelisted, OR
 *   - it is a thread whose PARENT channel is whitelisted.
 *
 * The parent rule means every thread under a whitelisted channel — both the
 * ones that exist today and any created later — is captured automatically,
 * without having to enumerate individual thread IDs in the whitelist.
 */
export function channelMatchesWhitelist(
  channel: ChannelMatchInput,
  whitelist: ReadonlySet<string>,
): boolean {
  if (whitelist.has(channel.id)) return true;
  if (channel.isThread && channel.parentId !== null && whitelist.has(channel.parentId)) {
    return true;
  }
  return false;
}
