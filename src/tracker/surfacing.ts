import type { TrackerItem } from './types.js';
import type { AgingResult } from './aging.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Pure rendering for the tracker's twice-daily surfacing (the "nag-loop" output).
 * No LLM, no I/O — given the post-reconcile tracker state + this run's aging
 * result, it produces (a) the digest sections appended to the team digest, and
 * (b) the list of items that warrant an individual ✅/❌ message this run.
 *
 * Everything here is deterministic and tested; the Discord posting + reaction
 * reading live in thin, injected adapters (post.ts / discord-rest.ts), so the
 * decision logic never touches the network.
 */

export interface SurfacingEmojis {
  confirmEmoji: string;
  vetoEmoji: string;
}

/**
 * Posts one surfacing/per-item message and returns the created message's id +
 * channel id (needed to bind a later ✅/❌ back to the item), or null if the post
 * failed. Injected so the surfacing logic is testable without the network; the
 * live implementation (discord-rest.ts) posts via the webhook with ?wait=true.
 */
export type ItemPoster = (content: string) => Promise<{ id: string; channelId: string } | null>;

/** What the surfacing render needs: the current open set + this run's deltas. */
export interface SurfacingInput {
  /** All open items after reconcile + aging (store.listOpen()). */
  openItems: TrackerItem[];
  /** Item ids created this run (new todos/ideas/decisions). */
  createdIds: number[];
  /** Item ids flagged needs_review this run (weak / demoted closes — "looks done?"). */
  flaggedReviewIds: number[];
  /** Items aged this run (resurfaced todos, revisited ideas, archived todos). */
  aging: AgingResult;
}

function ageDays(item: TrackerItem, now: number): number {
  return Math.max(0, Math.floor((now - item.last_seen_at) / DAY_MS));
}

/** Cap a single item's text so one long (model-generated) item can't blow past
 *  Discord's message limit or dominate the summary. */
const MAX_ITEM_TEXT = 240;
function clip(text: string): string {
  const t = text.trim();
  return t.length <= MAX_ITEM_TEXT ? t : `${t.slice(0, MAX_ITEM_TEXT - 1)}…`;
}

/** A short Discord citation suffix for an item's source. */
function cite(item: TrackerItem): string {
  return `([src](${item.source_url}))`;
}

/**
 * Render the digest's tracker sections (skip-when-empty, matching the digest's
 * own template discipline). Returns '' when there's nothing to surface — the
 * caller appends nothing in that case.
 *
 * - 📋 Open work — open todos, blocked first then resurfaced/stale then oldest,
 *   each with an age and a ⚠️ when it's been resurfaced (nobody's touched it).
 * - 💡 Parked ideas — only ideas nudged this run (one gentle "worth revisiting?").
 * - 🗳 Decisions logged — decisions newly recorded this run.
 */
export function renderTrackerSections(input: SurfacingInput, now: number): string {
  const sections: string[] = [];

  const openTodos = input.openItems.filter((i) => i.kind === 'todo');
  if (openTodos.length > 0) {
    const ranked = [...openTodos].sort(rankTodo(now));
    const lines = ranked.map((t) => {
      const flag = t.blocked ? '🔴 ' : t.resurfaced_at !== null ? '⚠️ ' : '';
      const owner = t.owner ? `**${t.owner}** → ` : '';
      return `- ${flag}${owner}${clip(t.text)} (${ageDays(t, now)}d) ${cite(t)}`;
    });
    sections.push(['**📋 Open work**', ...lines].join('\n'));
  }

  const createdSet = new Set(input.createdIds);
  const newDecisions = input.openItems.filter((i) => i.kind === 'decision' && createdSet.has(i.id));
  if (newDecisions.length > 0) {
    const lines = newDecisions.map((d) => `- ${clip(d.text)} ${cite(d)}`);
    sections.push(['**🗳 Decisions logged**', ...lines].join('\n'));
  }

  if (input.aging.revisited.length > 0) {
    const lines = input.aging.revisited.map((i) => `- ${clip(i.text)} — worth revisiting? ${cite(i)}`);
    sections.push(['**💡 Parked ideas**', ...lines].join('\n'));
  }

  return sections.join('\n\n');
}

/** Sort key: blocked first, then resurfaced/stale, then oldest-touched first. */
function rankTodo(now: number): (a: TrackerItem, b: TrackerItem) => number {
  return (a, b) => {
    if (a.blocked !== b.blocked) return a.blocked ? -1 : 1;
    const aStale = a.resurfaced_at !== null;
    const bStale = b.resurfaced_at !== null;
    if (aStale !== bStale) return aStale ? -1 : 1;
    return a.last_seen_at - b.last_seen_at; // oldest first
  };
}

export type DecisionReason = 'new' | 'looks-done' | 'resurfaced' | 'revisit';

/** An item that warrants its own ✅/❌ message this run, with the message text. */
export interface DecisionNeededItem {
  itemId: number;
  reason: DecisionReason;
  text: string;
}

/**
 * Select the items that need an individual ✅/❌ message this run, and build each
 * message's text. Thread/channel noise is proportional to DECISIONS NEEDED, not
 * to list size: only newly-tracked items (so a wrong one can be ❌'d / a key one
 * ✅-pinned), weak-closes ("looks done?"), and aged items ("still open?" /
 * "worth revisiting?") get a message. Stable ongoing items live only in the
 * summary section above, with no per-item message.
 *
 * Order matters for binding: an item appears at most once, with this precedence
 * (most actionable first): looks-done > resurfaced > revisit > new.
 */
export function selectDecisionNeeded(
  input: SurfacingInput,
  emojis: SurfacingEmojis,
): Array<DecisionNeededItem & { messageText: (item: TrackerItem) => string }> {
  const byId = new Map(input.openItems.map((i) => [i.id, i]));
  const seen = new Set<number>();
  const out: Array<DecisionNeededItem & { messageText: (item: TrackerItem) => string }> = [];
  const { confirmEmoji: ok, vetoEmoji: no } = emojis;

  const add = (id: number, reason: DecisionReason, render: (i: TrackerItem) => string): void => {
    if (seen.has(id)) return;
    const item = byId.get(id);
    if (item === undefined) return; // not open anymore (e.g. archived) → no message
    // An item a human already decided (pinned/dismissed/reopened) is not re-prompted.
    if (item.human_flag !== null) return;
    seen.add(id);
    out.push({ itemId: id, reason, text: item.text, messageText: render });
  };

  // looks-done (weak / demoted closes awaiting confirm)
  for (const id of input.flaggedReviewIds) {
    add(id, 'looks-done', (i) => `✅ Looks done? ${clip(i.text)} — ${ok} confirm closed · ${no} still open ${cite(i)}`);
  }
  // resurfaced todos (stale, untouched)
  for (const i of input.aging.resurfaced) {
    add(i.id, 'resurfaced', (it) => `⚠️ Still open? ${clip(it.text)} — ${ok} keep · ${no} drop ${cite(it)}`);
  }
  // revisited ideas (gentle nudge)
  for (const i of input.aging.revisited) {
    add(i.id, 'revisit', (it) => `💡 Worth revisiting? ${clip(it.text)} — ${ok} keep · ${no} drop ${cite(it)}`);
  }
  // newly-tracked items
  for (const id of input.createdIds) {
    add(id, 'new', (i) => `🆕 New ${i.kind}: ${clip(i.text)} — ${ok} pin · ${no} if wrong ${cite(i)}`);
  }

  return out;
}
