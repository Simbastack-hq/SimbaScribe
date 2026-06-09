import type { ReactionReader, ReactionView } from './reactions.js';
import type { ItemPoster } from './surfacing.js';

// Thin Discord REST adapters for the tracker nag-loop's I/O. These are the ONLY
// network-touching pieces; the surfacing/reaction LOGIC is pure and injected with
// these (or with fakes in tests). Kept deliberately small so they can be verified
// by reading. The nag-loop ships OFF by default, so these run only once a
// deployment enables surfacing — verify against live Discord before relying on them.

const DISCORD_API = 'https://discord.com/api/v10';

/** Per-call timeout so a hung Discord API can't stall the synth past the next
 *  cron tick (the surfacing runs inside the swallow boundary, but an un-bounded
 *  await would still block the process). */
const REQUEST_TIMEOUT_MS = 10_000;

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read ✅/❌ reactions on a message using the bot token (read-only). Discord
 * returns the reacting users — including each user's `bot` flag, which is the
 * human-only filter the apply logic depends on. One GET per emoji (the API is
 * per-emoji). A 404 (no such reaction) yields an empty list for that emoji; any
 * other non-2xx throws so the caller's swallow boundary records it.
 */
export function makeReactionReader(botToken: string, emojis: string[]): ReactionReader {
  return async (channelId: string, messageId: string): Promise<ReactionView[]> => {
    const views: ReactionView[] = [];
    for (const emoji of emojis) {
      const enc = encodeURIComponent(emoji);
      const res = await fetchWithTimeout(
        `${DISCORD_API}/channels/${channelId}/messages/${messageId}/reactions/${enc}?limit=100`,
        { headers: { Authorization: `Bot ${botToken}` } },
      );
      if (res.status === 404) continue; // nobody reacted with this emoji
      if (!res.ok) {
        throw new Error(`reaction read failed (${res.status}) for message ${messageId}`);
      }
      const users = (await res.json()) as Array<{ id: string; bot?: boolean }>;
      views.push({ emoji, reactors: users.map((u) => ({ id: u.id, bot: u.bot === true })) });
    }
    return views;
  };
}

/**
 * Post one surfacing/per-item message via the digest webhook with ?wait=true so
 * the response carries the created message (id + channel_id) for reaction binding.
 * Mentions are suppressed (allowed_mentions) exactly like the digest post, so an
 * item whose text contains @everyone/role pings can't ping the channel. Returns
 * null on any non-2xx — per-item posts are best-effort (a rare miss is acceptable).
 */
export function makeItemPoster(webhookUrl: string): ItemPoster {
  return async (content: string) => {
    const url = `${webhookUrl}${webhookUrl.includes('?') ? '&' : '?'}wait=true`;
    let res: Response;
    try {
      res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
      });
    } catch {
      return null;
    }
    if (!res.ok) return null;
    const msg = (await res.json()) as { id: string; channel_id: string };
    return { id: msg.id, channelId: msg.channel_id };
  };
}
