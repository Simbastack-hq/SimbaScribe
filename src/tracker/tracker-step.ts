import type { Db } from '../db/client.js';
import { readWindowByRowid, getMaxMessageRowid, type WindowMessage } from '../synth/store.js';
import { splitForDiscord } from '../synth/post.js';
import { openTrackerDb, type TrackerDb } from './store.js';
import { formatReconcileInput } from './reconcile-format.js';
import { validateReconciliation } from './validate.js';
import { applyReconciliation, type ReconcileSummary } from './reconcile.js';
import { runAging, type AgingConfig, type AgingResult } from './aging.js';
import { applyReactions, type ReactionReader, type ReactionSummary } from './reactions.js';
import {
  renderTrackerSections,
  selectDecisionNeeded,
  type SurfacingEmojis,
  type ItemPoster,
} from './surfacing.js';
import type { Reconciliation, TrackerItem } from './types.js';

const TRACKER_WATERMARK_KEY = 'last_tracker_rowid';
const SURFACING_CHANNEL_KEY = 'surfacing_channel_id';

export interface TrackerStepConfig {
  trackerDbPath: string;
  discordGuildId: string;
}

/**
 * The nag-loop I/O + knobs. When PRESENT, the tracker step also reads ✅/❌
 * reactions (before reconcile), ages the list (after), and posts the surfacing
 * summary + per-item decision messages. When ABSENT (the default / flag-off), the
 * step is exactly the shadow reconcile it has always been: capture from chat,
 * write tracker.db, no Discord posts, no aging — behaviour identical to today.
 */
export interface SurfacingDeps {
  emojis: SurfacingEmojis;
  aging: AgingConfig;
  read: ReactionReader;
  post: ItemPoster;
  /** Cap on per-item messages per run, to bound thread/channel noise. */
  maxItemMessages: number;
}

/** Injected so tests run without network. Returns the model's raw proposal. */
export type ReconcileModelFn = (userMessage: string) => Promise<Reconciliation>;

export interface TrackerStepResult {
  status: 'first-boot' | 'empty' | 'applied';
  summary?: ReconcileSummary;
  rejected?: number;
  windowSize?: number;
  /** Present only when surfacing ran (flag on). For observability + tests. */
  surfacing?: {
    reactions: ReactionSummary;
    aging: AgingResult;
    /** True when aging was skipped because reactions couldn't be read this run. */
    agingSkippedDueToReadErrors: boolean;
    sectionsPosted: boolean;
    itemMessagesPosted: number;
  };
}

function discordUrl(guildId: string, channelId: string, msgId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${msgId}`;
}

/**
 * The tracker's reconcile step. Reads its OWN window (rowid > tracker watermark,
 * independent of the digest's corpus watermark), asks the model to propose
 * changes, validates them, applies them, and advances the tracker watermark —
 * atomically with the apply.
 *
 * This function makes NO Discord posts in shadow mode (surfacing absent) and does
 * NOT touch the digest or the corpus watermark. The caller wraps the whole thing
 * in a catch-and-swallow so a tracker failure (reconcile, aging, reactions, OR
 * posting) can never affect the live digest (spec §4/§7.1).
 *
 * With `surfacing` provided, the step additionally — all inside the same swallow:
 *  1. reads ✅/❌ on prior surfaced items and applies human overrides (before reconcile);
 *  2. ages the list (resurface/archive) after reconcile;
 *  3. posts a surfacing summary + per-item decision messages, binding each message
 *     id back to its item for the next run's reaction read.
 */
export async function runTrackerStep(
  corpusDb: Db,
  config: TrackerStepConfig,
  reconcileModel: ReconcileModelFn,
  now: number,
  synthRunId: number | null,
  surfacing?: SurfacingDeps,
): Promise<TrackerStepResult> {
  const tracker: TrackerDb = openTrackerDb(config.trackerDbPath);
  try {
    const wmRaw = tracker.getState(TRACKER_WATERMARK_KEY);

    // First boot: start from "now" — don't backfill the whole history into the
    // tracker (matches the synth's first-boot policy). Just record the watermark.
    if (wmRaw === undefined) {
      const maxRowid = getMaxMessageRowid(corpusDb);
      tracker.setState(TRACKER_WATERMARK_KEY, String(maxRowid));
      return { status: 'first-boot' };
    }

    // --- (1) Reactions: apply human ✅/❌ from prior surfaced items, before the
    // reconcile so it sees the corrected open set. Needs the channel we posted to.
    let reactions: ReactionSummary | undefined;
    if (surfacing !== undefined) {
      const channelId = tracker.getState(SURFACING_CHANNEL_KEY);
      if (channelId !== undefined) {
        reactions = await applyReactions(
          tracker,
          tracker.listOpen(),
          channelId,
          surfacing.read,
          surfacing.emojis,
          now,
        );
      }
    }

    // If surfacing is on but the reaction pass FAILED (systemic read error — revoked
    // token, outage, rate limit), we may have missed human corrections. In that case
    // we must not do ANY destructive lifecycle work this run — no auto-close, no
    // aging, no rebinding — or a ❌/✅ we never saw could be lost. We still capture
    // new items (additive + safe) and retry the rest next run. (Shadow mode never
    // reads reactions, so it's unaffected — it's the existing capture-only behaviour.)
    const reactionsUnsafe = reactions !== undefined && reactions.readErrors > 0;

    const lastRowid = Number(wmRaw);
    const messages: WindowMessage[] = readWindowByRowid(corpusDb, lastRowid);

    // --- (2) Reconcile from the new chat window (the existing core). An empty
    // window still proceeds to aging/surfacing (stale items can age with no new chat).
    let summary: ReconcileSummary | undefined;
    let rejectedCount = 0;
    if (messages.length > 0) {
      const maxRowid = messages.reduce((m, x) => (x.rowid > m ? x.rowid : m), lastRowid);
      const openItems: TrackerItem[] = tracker.listOpen();
      const userMessage = formatReconcileInput(openItems, messages);
      const proposal = await reconcileModel(userMessage);

      const openById = new Map(openItems.map((i) => [i.id, i]));
      const windowMsgIds = new Set(messages.map((m) => m.id));
      const { valid, rejected } = validateReconciliation(proposal, { openItems: openById, windowMsgIds });
      rejectedCount = rejected.length;
      const urlByMsgId = new Map(messages.map((m) => [m.id, discordUrl(config.discordGuildId, m.channel_id, m.id)]));

      const applyAndAdvance = tracker.raw.transaction(() => {
        const s = applyReconciliation(tracker, valid, {
          now,
          synthRunId,
          urlFor: (msgId: string) => {
            const u = urlByMsgId.get(msgId);
            if (u === undefined) throw new Error(`no URL for in-window message ${msgId}`);
            return u;
          },
          // Reactions unsafe → demote ALL strong closes to "looks done?" review, so
          // nothing auto-closes while a contradicting human correction may be unread.
          ...(reactionsUnsafe ? { maxStrongAutoCloses: 0 } : {}),
        });
        tracker.setState(TRACKER_WATERMARK_KEY, String(maxRowid));
        return s;
      });
      summary = applyAndAdvance();
    }

    // Shadow mode (flag off): done — no aging, no posts. Behaviour == today.
    if (surfacing === undefined) {
      if (messages.length === 0) return { status: 'empty' };
      return { status: 'applied', summary, rejected: rejectedCount, windowSize: messages.length };
    }

    // --- (3) Aging (after reconcile), then surface — but ONLY when reactions were
    // read cleanly. If the reaction pass failed, skip aging (don't archive an item
    // whose ❌/✅ we never saw); posting is skipped below for the same reason.
    const aging = reactionsUnsafe
      ? { resurfaced: [], revisited: [], archived: [] }
      : runAging(tracker, surfacing.aging, now);
    // Posting (which rebinds digest_msg_id) is also skipped when reactions are
    // unsafe — rebinding an item whose old reaction we couldn't read would orphan it.
    const surfaced = reactionsUnsafe
      ? { sectionsPosted: false, itemMessagesPosted: 0 }
      : await postSurfacing(tracker, surfacing, summary, aging, now);

    return {
      status: messages.length === 0 ? 'empty' : 'applied',
      summary,
      rejected: rejectedCount,
      windowSize: messages.length,
      surfacing: {
        reactions: reactions ?? { itemsRead: 0, pinned: 0, dismissed: 0, confirmedClosed: 0, reopened: 0, readErrors: 0 },
        aging,
        agingSkippedDueToReadErrors: reactionsUnsafe,
        sectionsPosted: surfaced.sectionsPosted,
        itemMessagesPosted: surfaced.itemMessagesPosted,
      },
    };
  } finally {
    tracker.close();
  }
}

/**
 * Render + post the surfacing summary and the per-item ✅/❌ messages, binding
 * each per-item message id back to its tracker item. Best-effort: a failed post
 * is logged-by-omission (returns lower counts) and never throws past here — the
 * item still appears in the summary, only its reaction binding is missed.
 */
async function postSurfacing(
  tracker: TrackerDb,
  surfacing: SurfacingDeps,
  summary: ReconcileSummary | undefined,
  aging: AgingResult,
  now: number,
): Promise<{ sectionsPosted: boolean; itemMessagesPosted: number }> {
  const openItems = tracker.listOpen();
  const input = {
    openItems,
    createdIds: summary?.createdIds ?? [],
    flaggedReviewIds: summary?.flaggedReviewIds ?? [],
    aging,
  };

  let channelToRemember: string | null = null;

  // Summary sections (no reaction binding needed) — the readable nag list. A long
  // open list is split into Discord-sized chunks so a big summary can't 400.
  const sections = renderTrackerSections(input, now);
  let sectionsPosted = false;
  if (sections !== '') {
    for (const chunk of splitForDiscord(sections)) {
      const res = await surfacing.post(chunk);
      if (res !== null) {
        sectionsPosted = true;
        channelToRemember = res.channelId;
      }
    }
  }

  // Per-item decision messages (each is a ✅/❌ target), capped for noise. The id
  // AND its prompt semantic (reason) are bound, so a later reaction is read with
  // the right meaning even if a subsequent re-post fails.
  const decisionItems = selectDecisionNeeded(input, surfacing.emojis).slice(0, surfacing.maxItemMessages);
  const byId = new Map(openItems.map((i) => [i.id, i]));
  let itemMessagesPosted = 0;
  for (const d of decisionItems) {
    const item = byId.get(d.itemId);
    if (item === undefined) continue;
    const res = await surfacing.post(d.messageText(item));
    if (res === null) continue;
    tracker.setDigestMsgId(item.id, res.id, d.reason);
    channelToRemember = res.channelId;
    itemMessagesPosted += 1;
  }

  // Remember where we posted so the NEXT run can read reactions there. All
  // surfacing posts go to the one webhook channel, so a single id suffices.
  if (channelToRemember !== null) {
    tracker.setState(SURFACING_CHANNEL_KEY, channelToRemember);
  }

  return { sectionsPosted, itemMessagesPosted };
}
