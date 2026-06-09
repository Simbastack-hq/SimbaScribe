import type { WindowMessage } from './store.js';
import { effectiveContent } from '../db/content.js';

// effectiveContent now lives in src/db/content.ts so the synth (Phase 1b) and
// the MCP server (Phase 1.5b) resolve edited messages identically. Re-exported
// for existing callers/tests that import it from here.
export { effectiveContent };

/** Compact reaction summary so the model can apply the ✅-confirms-commitment rule. */
export function reactionsSummary(m: WindowMessage): string {
  try {
    const reactions = JSON.parse(m.reactions) as unknown;
    if (reactions === null || typeof reactions !== 'object' || Array.isArray(reactions)) return '';
    const entries = Object.entries(reactions as Record<string, string[]>);
    if (entries.length === 0) return '';
    const parts = entries.map(([emoji, users]) => `${emoji}×${Array.isArray(users) ? users.length : 0}`);
    return ` [reactions: ${parts.join(', ')}]`;
  } catch {
    return '';
  }
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * Renders the window as the model's USER message: one line per message, with
 * channel, author, time, and the guild/channel/message IDs the model needs to
 * build Discord links (https://discord.com/channels/<guild>/<channel>/<msg>).
 */
export function formatWindow(messages: WindowMessage[], guildId: string): string {
  return messages
    .map((m) => {
      const content = effectiveContent(m).replace(/\s*\n\s*/g, ' ').trim();
      const ids = `${guildId}/${m.channel_id}/${m.id}`;
      return `[#${m.channel_name}] ${m.author_name} (${fmtTime(m.ts)}) {${ids}}${reactionsSummary(m)}: ${content}`;
    })
    .join('\n');
}
