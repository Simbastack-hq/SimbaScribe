import type { Message, GuildTextBasedChannel } from 'discord.js';
import type { MessageRow } from '../db/client.js';

/**
 * Builds a SQLite-row representation of a Discord message.
 *
 * `fallbackGuildId` is used when message.guildId is null (shouldn't happen for
 * guild messages, but the discord.js type allows it). Caller passes the
 * configured guild ID.
 */
export function buildMessageRow(message: Message, fallbackGuildId: string): MessageRow {
  const author = message.author;
  const member = message.member;
  const authorName = member?.nickname ?? author.globalName ?? author.username;

  const attachments = Array.from(message.attachments.values()).map((a) => ({
    filename: a.name,
    url: a.url,
    content_type: a.contentType ?? null,
    size: a.size,
  }));

  const channel = message.channel as GuildTextBasedChannel;
  const channelName = 'name' in channel && channel.name ? channel.name : message.channelId;

  return {
    id: message.id,
    channel_id: message.channelId,
    channel_name: channelName,
    guild_id: message.guildId ?? fallbackGuildId,
    author_id: author.id,
    author_name: authorName,
    ts: message.createdTimestamp,
    content: message.content ?? null,
    reply_to_id: message.reference?.messageId ?? null,
    thread_root_id: message.channel.isThread() ? message.channel.parentId : null,
    attachments: JSON.stringify(attachments),
    edits: '[]',
    deleted_at: null,
    reactions: '{}',
  };
}
