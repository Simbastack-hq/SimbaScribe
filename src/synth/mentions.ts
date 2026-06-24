import type { MentionRosterEntry } from '../profile/schema.js';

/**
 * Deterministic, opt-in @-mention tagging for the daily digest.
 *
 * The model writes the digest in CANONICAL names (e.g. "Ben", "Ada") — never IDs.
 * It isn't given any author IDs (`window.ts` feeds it names), and it couldn't be
 * trusted to emit 18-digit snowflakes correctly anyway. So tagging is a
 * deterministic post-processing step: AFTER the model runs, replace the first
 * occurrence of each rostered name with a Discord mention `<@id>`.
 *
 * Two safety properties this module owns:
 *  - DEFANG: any Discord mention syntax the model copied verbatim from a source
 *    message is neutralized first, so the ONLY `<@id>` tokens left are the ones we
 *    deliberately insert. The caller builds the `allowed_mentions` allow-list by
 *    scanning the text for `<@id>`; a model-copied id must not sneak into it.
 *  - FIRST-OCCURRENCE ONLY: each person is tagged at most once per digest, so
 *    someone named on four lines gets one ping, not four.
 *
 * Pure + side-effect-free so it's exhaustively testable.
 */

export interface MentionResult {
  /** The digest text with first-occurrence names replaced by `<@id>` tokens. */
  readonly text: string;
  /** The unique set of Discord IDs actually substituted (order = first tagged). */
  readonly mentionedIds: string[];
}

/** Escape a string for safe use as a literal inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Neutralize Discord mention syntax the *model* emitted: `<@id>` / `<@!id>` (user),
 * `<@&id>` (role), `<#id>` (channel). We drop the angle brackets so Discord won't
 * parse them, leaving readable `@id` / `#id` plain text. (Our own inserted tokens
 * are added AFTER this, so they're untouched.)
 *
 * Re-scan until STABLE: a single pass on a double-wrapped `<<@id>>` rewrites only
 * the inner token, and the leftover outer brackets re-form a live `<@id>`. Looping
 * until the text stops changing collapses any nesting depth. It terminates because
 * every replacing pass strictly shortens the text (each match drops two brackets).
 */
function defangModelMentions(text: string): string {
  let out = text;
  let prev: string;
  do {
    prev = out;
    out = out.replace(/<@[!&]?(\d+)>/g, '@$1').replace(/<#(\d+)>/g, '#$1');
  } while (out !== prev);
  return out;
}

/**
 * Replace the first occurrence of each rostered name with `<@discordId>`.
 *
 * - Longest name first, so "James A" wins over a bare "James".
 * - Unicode-aware word boundaries `[\p{L}\p{N}_]` (not `\b`) so punctuated names
 *   ("J.R.") and non-ASCII names ("José") match correctly, while a name embedded
 *   in a larger word ("Han" in "Hannah") does not.
 * - Case-sensitive (canonical names are proper nouns).
 * - At most one tag per id, even if a person has two roster aliases.
 */
export function applyMentions(text: string, roster: readonly MentionRosterEntry[]): MentionResult {
  let out = defangModelMentions(text);
  const mentionedIds: string[] = [];

  const ordered = [...roster].sort((a, b) => b.name.length - a.name.length);
  for (const { name, discordId } of ordered) {
    if (mentionedIds.includes(discordId)) continue; // already tagged this person
    const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(name)}(?![\\p{L}\\p{N}_])`, 'u');
    const m = re.exec(out);
    if (m === null) continue;
    const start = m.index;
    out = out.slice(0, start) + `<@${discordId}>` + out.slice(start + m[0].length);
    mentionedIds.push(discordId);
  }

  return { text: out, mentionedIds };
}
