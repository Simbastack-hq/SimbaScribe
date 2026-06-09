import type { TrackerDb, EventCtx, ResolveInput } from './store.js';
import type { TrackerItem } from './types.js';

/** A reactor as seen by the reader, carrying Discord's `bot` flag. */
export interface Reactor {
  id: string;
  bot: boolean;
}

/** The reactions on one message: emoji → the users who reacted with it. */
export interface ReactionView {
  emoji: string;
  reactors: Reactor[];
}

/**
 * Reads the reactions on one message. Injected so the apply logic is testable
 * without the network; the live implementation (discord-rest.ts) reads via the
 * bot token over REST. A genuinely-missing message yields []; a transport/auth/
 * rate-limit failure THROWS (so the caller can tell "nobody reacted" from "I
 * couldn't check").
 */
export type ReactionReader = (channelId: string, messageId: string) => Promise<ReactionView[]>;

export interface ReactionEmojis {
  confirmEmoji: string;
  vetoEmoji: string;
}

export interface ReactionSummary {
  itemsRead: number;
  pinned: number;
  dismissed: number;
  confirmedClosed: number;
  reopened: number;
  /** Read failures this pass. >0 means we may have MISSED human corrections —
   *  the caller must NOT then run destructive aging (it could archive an item a
   *  human just tried to keep). */
  readErrors: number;
}

/** Kind-correct resolution for a confirmed "looks done?" close (F5: a weak
 *  decision-supersede must NOT be written as a 'done' todo). Ideas never reach
 *  needs_review, so they're not represented here. */
function closeFor(item: TrackerItem): Pick<ResolveInput, 'status' | 'event'> {
  if (item.kind === 'decision') return { status: 'superseded', event: 'superseded' };
  if (item.kind === 'question') return { status: 'answered', event: 'answered' };
  return { status: 'done', event: 'closed' };
}

/**
 * Read ✅/❌ on the synth's own per-item messages and apply human overrides — the
 * out-of-band correction path, and the security hinge of the whole design.
 *
 * Only HUMAN reactions count: Discord's `user.bot` flag is the filter, so a
 * prompt-injected / compromised agent can change what the model PROPOSES but can
 * never manufacture a teammate's reaction (spec §7).
 *
 * Interpretation is by the message's STORED semantic (`digest_msg_kind`), NOT the
 * item's current state — so a state change without a successful re-post can never
 * reinterpret an old reaction (a 'new' prompt's ✅ always means "pin"):
 *  - 'looks-done': ✅ → confirm close (kind-correct); ❌ → keep open (clear review,
 *    no sticky flag, so the item can be re-decided later).
 *  - 'new' / 'resurfaced' / 'revisit': ✅ → pin; ❌ → dismiss.
 * ❌ wins over ✅ when both are present (err toward not tracking a contested item).
 *
 * Idempotent by construction: a pinned item is skipped (terminal); dismissed/done
 * items leave the open set; a kept-open item's ❌ becomes a no-op once its review
 * flag is already clear. Runs BEFORE the reconcile so it sees the corrected set.
 */
export async function applyReactions(
  store: TrackerDb,
  openItems: TrackerItem[],
  channelId: string,
  read: ReactionReader,
  emojis: ReactionEmojis,
  now: number,
): Promise<ReactionSummary> {
  const summary: ReactionSummary = { itemsRead: 0, pinned: 0, dismissed: 0, confirmedClosed: 0, reopened: 0, readErrors: 0 };
  const ctx = (detail: Record<string, unknown>): EventCtx => ({ source: 'reaction', ts: now, detail });

  for (const item of openItems) {
    if (item.digest_msg_id === null) continue;
    // A pinned item is a terminal human decision — don't re-apply (avoids event spam).
    if (item.human_flag === 'pinned') continue;
    // Only interpret a binding with a KNOWN prompt semantic. A null/legacy/unknown
    // kind (e.g. a binding from before digest_msg_kind existed) can't be safely
    // interpreted — reading it as new/resurfaced would misread a ❌ as a dismiss.
    const kind = item.digest_msg_kind;
    if (kind !== 'looks-done' && kind !== 'new' && kind !== 'resurfaced' && kind !== 'revisit') continue;
    summary.itemsRead += 1;

    let views: ReactionView[];
    try {
      views = await read(channelId, item.digest_msg_id);
    } catch {
      // A throw is a systemic failure (auth/network/rate-limit/timeout — the
      // adapter handles a genuinely-missing message as empty). STOP the pass:
      // continuing would pay one timeout PER remaining item (holding the run's
      // lock), and readErrors>0 already makes the caller skip destructive aging.
      summary.readErrors += 1;
      break;
    }

    const humanReactor = (emoji: string): string | null => {
      const v = views.find((vv) => vv.emoji === emoji);
      return v?.reactors.find((r) => !r.bot)?.id ?? null;
    };
    const vetoBy = humanReactor(emojis.vetoEmoji);
    const confirmBy = humanReactor(emojis.confirmEmoji);
    if (vetoBy === null && confirmBy === null) continue;

    if (kind === 'looks-done') {
      if (vetoBy !== null) {
        // "still open" — only act if it's actually still flagged (idempotent).
        if (item.needs_review) {
          store.clearReview(item.id, ctx({ via: 'reaction', kept_open: true, by: vetoBy }));
          summary.reopened += 1;
        }
      } else {
        const close = closeFor(item);
        store.resolveItem(
          item.id,
          { status: close.status, event: close.event, resolved_msg_id: item.digest_msg_id, resolved_url: item.source_url, resolved_by: confirmBy },
          ctx({ via: 'reaction', confirmed: true, by: confirmBy }),
        );
        summary.confirmedClosed += 1;
      }
      continue;
    }

    // 'new' / 'resurfaced' / 'revisit' (unknown kinds were skipped above).
    if (vetoBy !== null) {
      store.applyHumanFlag(item.id, 'dismissed', ctx({ via: 'reaction', by: vetoBy }));
      summary.dismissed += 1;
    } else {
      store.applyHumanFlag(item.id, 'pinned', ctx({ via: 'reaction', by: confirmBy }));
      summary.pinned += 1;
    }
  }

  return summary;
}
