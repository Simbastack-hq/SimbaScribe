import { Client, GatewayIntentBits, Partials } from 'discord.js';

/**
 * Constructs the discord.js client with the intents and partials SimbaScribe needs.
 *
 * Intents:
 *  - Guilds: required for any channel/message work
 *  - GuildMessages: messageCreate/Update/Delete events
 *  - GuildMessageReactions: reaction add/remove events
 *  - MessageContent: privileged — must be enabled in the developer portal.
 *    Without it, message.content is empty for messages not directly addressed to the bot.
 *
 * Partials are enabled for Message, Channel, Reaction, User so that
 * edit/delete/reaction events on uncached messages or uncached users still
 * fire. Without Partials.User in particular, messageReactionRemove can silently
 * drop when the user isn't in the client's cache.
 * The handler is responsible for fetching the full object when needed.
 *
 * GuildMembers intent is deliberately NOT requested: author display names come
 * from message.member.nickname (when cached) or fall back to
 * message.author.globalName / username. This avoids a second privileged-intent
 * approval in the developer portal.
 */
export function createDiscordClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User],
  });
}
