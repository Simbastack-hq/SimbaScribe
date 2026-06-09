import {
  Events,
  type Client,
  type Message,
  type MessageReaction,
  type PartialMessageReaction,
  type User,
  type PartialUser,
} from 'discord.js';
import type { Db } from '../db/client.js';
import type { Config } from '../config.js';
import type { Logger } from '../log.js';
import { buildMessageRow } from './build-row.js';
import { channelMatchesWhitelist } from './whitelist.js';

export interface HandlerDeps {
  client: Client;
  db: Db;
  config: Config;
  log: Logger;
}

type EditEntry = { ts: number; content: string };
type ReactionsMap = Record<string, string[]>;

/**
 * Validates that the parsed `edits` JSON is the array-of-{ts,content} shape we
 * expect. Returns the typed value on success, or `null` if the shape is wrong
 * (caller logs and skips the event so corrupt data can be inspected — we do
 * NOT silently reset, per the fail-loud rule).
 */
function parseEdits(raw: string): EditEntry[] | null {
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return null;
    return v as EditEntry[];
  } catch {
    return null;
  }
}

/**
 * Validates that the parsed `reactions` JSON is a plain object (not array,
 * not null). Returns the typed value on success, or `null` if the shape is
 * wrong — important because setting string keys on an array silently no-ops
 * during JSON.stringify, which would lose reaction data.
 */
function parseReactions(raw: string): ReactionsMap | null {
  try {
    const v = JSON.parse(raw);
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
    return v as ReactionsMap;
  } catch {
    return null;
  }
}

/**
 * Canonical key for a reaction emoji in the reactions JSON:
 *   - unicode emoji: the raw emoji char (e.g. "✅")
 *   - custom server emoji: "<:name:id>"
 * Structural type so callers can pass any of discord.js's emoji shapes.
 */
function reactionKey(emoji: { id: string | null; name: string | null }): string {
  return emoji.id ? `<:${emoji.name ?? 'unknown'}:${emoji.id}>` : emoji.name ?? 'unknown';
}

/**
 * Registers all Discord Gateway event handlers on the given client.
 *
 * Capture gating:
 *   - messageCreate is the single entry point: a message is captured if its
 *     channel is whitelisted OR it's a thread under a whitelisted parent.
 *   - mutation handlers (edit/delete/reaction) gate on whether the message is
 *     already in our DB. If we have the row it was whitelisted at create time,
 *     so this is both correct and automatically thread-aware — no channel
 *     re-check needed, and we avoid REST fetches for messages we don't track.
 *   - every handler catches and logs errors with full context — no silent swallow.
 */
export function registerHandlers(deps: HandlerDeps): void {
  const { client, db, config, log } = deps;
  const whitelist = config.whitelistChannelIds;

  // A message should be captured if its channel is whitelisted, or it lives in
  // a thread whose parent is whitelisted (captures present + future threads).
  const shouldCapture = (channel: Message['channel']): boolean =>
    channel.isThread()
      ? channelMatchesWhitelist({ id: channel.id, isThread: true, parentId: channel.parentId }, whitelist)
      : channelMatchesWhitelist({ id: channel.id, isThread: false, parentId: null }, whitelist);

  // ---- messageCreate ---------------------------------------------------

  client.on(Events.MessageCreate, (message: Message) => {
    try {
      if (!shouldCapture(message.channel)) return;
      // Defensive: don't ingest the bot's own messages.
      if (message.author.id === client.user?.id) return;

      const row = buildMessageRow(message, config.discordGuildId);
      db.insertMessage(row);
      log.debug(
        { messageId: message.id, channel: row.channel_name, author: row.author_name },
        'captured message',
      );
    } catch (err) {
      log.error(
        { err, messageId: message.id, channelId: message.channelId, event: 'messageCreate' },
        'failed to capture message',
      );
    }
  });

  // ---- messageUpdate ---------------------------------------------------

  client.on(Events.MessageUpdate, async (_oldMessage, newMessage) => {
    const channelId = newMessage.channelId;
    try {
      // Gate on DB membership first — cheap PK lookup, avoids a REST fetch for
      // edits on messages we never captured. id is stable across fetch().
      const existing = db.getMessageState(newMessage.id);
      if (!existing) {
        log.debug(
          { messageId: newMessage.id, channelId },
          'edit on message we do not track — skipping',
        );
        return;
      }

      const fetched = newMessage.partial ? await newMessage.fetch() : (newMessage as Message);

      const edits = parseEdits(existing.edits);
      if (edits === null) {
        log.error(
          { messageId: fetched.id, channelId, rawEdits: existing.edits },
          'edits JSON has wrong shape — skipping edit so corrupt data can be inspected',
        );
        return;
      }

      // discord.js fires messageUpdate for non-content changes too (embed/link
      // unfurl, pin/unpin, flag changes). Only record an edit when the message
      // text actually changed, otherwise the edits history fills with
      // duplicate-content noise. Compare against the current effective content:
      // the last recorded edit if any, else the original stored content.
      const lastEdit = edits.at(-1);
      const currentContent = (lastEdit ? lastEdit.content : existing.content) ?? '';
      const newContent = fetched.content ?? '';
      if (newContent === currentContent) {
        log.debug(
          { messageId: fetched.id, channelId },
          'messageUpdate with no content change (embed/pin/flags) — skipping',
        );
        return;
      }

      edits.push({
        ts: fetched.editedTimestamp ?? Date.now(),
        content: newContent,
      });
      db.appendEdit(fetched.id, JSON.stringify(edits));
      log.debug({ messageId: fetched.id, editCount: edits.length }, 'captured edit');
    } catch (err) {
      log.error(
        {
          err,
          messageId: newMessage.id,
          channelId: newMessage.channelId,
          event: 'messageUpdate',
        },
        'failed to capture edit',
      );
    }
  });

  // ---- messageDelete ---------------------------------------------------

  client.on(Events.MessageDelete, (message) => {
    try {
      const existing = db.getMessageState(message.id);
      if (!existing) {
        log.debug(
          { messageId: message.id, channelId: message.channelId },
          'delete on message we do not track — skipping',
        );
        return;
      }
      db.markDeleted(message.id, Date.now());
      log.debug({ messageId: message.id }, 'captured delete');
    } catch (err) {
      log.error(
        { err, messageId: message.id, channelId: message.channelId, event: 'messageDelete' },
        'failed to capture delete',
      );
    }
  });

  // ---- messageDeleteBulk -----------------------------------------------

  client.on(Events.MessageBulkDelete, (messages, channel) => {
    try {
      const ids = Array.from(messages.keys()).filter((id) => db.getMessageState(id) !== undefined);
      if (ids.length === 0) {
        log.debug(
          { channelId: channel.id, eventCount: messages.size },
          'bulk delete — none of the messages were in our DB; skipping',
        );
        return;
      }
      db.markDeletedBulk(ids, Date.now());
      log.debug(
        { channelId: channel.id, markedCount: ids.length, eventCount: messages.size },
        'captured bulk delete',
      );
    } catch (err) {
      log.error(
        { err, channelId: channel.id, event: 'messageBulkDelete' },
        'failed to capture bulk delete',
      );
    }
  });

  // ---- messageReactionAdd / messageReactionRemove ----------------------

  const handleReaction = async (
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
    action: 'add' | 'remove',
  ): Promise<void> => {
    try {
      // Gate on DB membership before any fetch — reaction.message.id is present
      // even on a partial reaction, so we avoid fetching for untracked messages.
      const existing = db.getMessageState(reaction.message.id);
      if (!existing) {
        log.debug(
          { messageId: reaction.message.id, action },
          'reaction on message we do not track — skipping',
        );
        return;
      }

      const fetched = reaction.partial ? await reaction.fetch() : (reaction as MessageReaction);

      const reactions = parseReactions(existing.reactions);
      if (reactions === null) {
        log.error(
          { messageId: fetched.message.id, action, rawReactions: existing.reactions },
          'reactions JSON has wrong shape — skipping reaction so corrupt data can be inspected',
        );
        return;
      }
      const key = reactionKey(fetched.emoji);

      const userIds = reactions[key] ?? [];
      if (action === 'add') {
        if (!userIds.includes(user.id)) userIds.push(user.id);
        reactions[key] = userIds;
      } else {
        const filtered = userIds.filter((id) => id !== user.id);
        if (filtered.length === 0) delete reactions[key];
        else reactions[key] = filtered;
      }

      db.upsertReactions(fetched.message.id, JSON.stringify(reactions));
      log.debug(
        { messageId: fetched.message.id, emoji: key, action, userId: user.id },
        'captured reaction',
      );
    } catch (err) {
      log.error(
        {
          err,
          messageId: reaction.message.id,
          action,
          event: action === 'add' ? 'messageReactionAdd' : 'messageReactionRemove',
        },
        'failed to capture reaction',
      );
    }
  };

  client.on(Events.MessageReactionAdd, (reaction, user) => {
    void handleReaction(reaction, user, 'add');
  });
  client.on(Events.MessageReactionRemove, (reaction, user) => {
    void handleReaction(reaction, user, 'remove');
  });

  // ---- messageReactionRemoveAll ----------------------------------------
  // Fired when every reaction is cleared from a message (e.g. a mod clearing
  // a poll). Individual MessageReactionRemove events do NOT fire in this case,
  // so without this handler the reactions JSON would keep stale data forever.

  client.on(Events.MessageReactionRemoveAll, (message) => {
    try {
      if (db.getMessageState(message.id) === undefined) {
        log.debug(
          { messageId: message.id, channelId: message.channelId },
          'reaction-remove-all on message we do not track — skipping',
        );
        return;
      }
      db.upsertReactions(message.id, '{}');
      log.debug({ messageId: message.id }, 'captured reaction-remove-all (cleared reactions)');
    } catch (err) {
      log.error(
        { err, messageId: message.id, channelId: message.channelId, event: 'messageReactionRemoveAll' },
        'failed to capture reaction-remove-all',
      );
    }
  });

  // ---- messageReactionRemoveEmoji --------------------------------------
  // Fired when all reactions of ONE emoji are cleared from a message. Again,
  // no per-user MessageReactionRemove events fire, so we delete the key here.

  client.on(Events.MessageReactionRemoveEmoji, (reaction) => {
    try {
      const existing = db.getMessageState(reaction.message.id);
      if (existing === undefined) {
        log.debug(
          { messageId: reaction.message.id, channelId: reaction.message.channelId },
          'reaction-remove-emoji on message we do not track — skipping',
        );
        return;
      }
      const reactions = parseReactions(existing.reactions);
      if (reactions === null) {
        log.error(
          { messageId: reaction.message.id, rawReactions: existing.reactions },
          'reactions JSON has wrong shape — skipping reaction-remove-emoji so corrupt data can be inspected',
        );
        return;
      }
      const key = reactionKey(reaction.emoji);
      if (key in reactions) {
        delete reactions[key];
        db.upsertReactions(reaction.message.id, JSON.stringify(reactions));
        log.debug({ messageId: reaction.message.id, emoji: key }, 'captured reaction-remove-emoji');
      }
    } catch (err) {
      log.error(
        {
          err,
          messageId: reaction.message.id,
          channelId: reaction.message.channelId,
          event: 'messageReactionRemoveEmoji',
        },
        'failed to capture reaction-remove-emoji',
      );
    }
  });
}
