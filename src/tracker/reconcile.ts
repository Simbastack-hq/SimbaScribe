import type { TrackerDb, EventCtx, ResolveInput } from './store.js';
import type {
  ValidatedReconciliation,
  ProposedNewItem,
  TrackerItem,
  ResolutionType,
} from './types.js';
import { tokenOverlap, DEDUP_OVERLAP_THRESHOLD } from './text.js';

/** A single run proposing more than this many STRONG auto-closes is treated as
 *  suspicious (runaway model / injection) — all its strong closes are demoted to
 *  "looks done?" review instead of auto-applied. Bounds the blast radius of a
 *  structurally-valid "close everything" the validator can't catch semantically. */
export const MAX_STRONG_AUTO_CLOSES = 8;

export interface ReconcileContext {
  now: number;
  synthRunId: number | null;
  /** URL for an in-window message id. Validation guarantees these resolve; a
   *  miss is a programming error → throw (fail loud), not a silent bad URL. */
  urlFor: (msgId: string) => string;
  /** Override the dedup similarity threshold (default DEDUP_OVERLAP_THRESHOLD). */
  dedupThreshold?: number;
  /** Override the strong-auto-close cap (default MAX_STRONG_AUTO_CLOSES). */
  maxStrongAutoCloses?: number;
}

export interface ReconcileSummary {
  created: number;
  touched: number;
  closed: number;
  flaggedReview: number;
  dedupedToTouch: number;
  /** Strong closes demoted to review because the per-run cap was exceeded. >0
   *  is a signal the caller should log loudly (possible runaway/injection). */
  demotedStrongCloses: number;
  /** Ids of items created this run — surfacing posts a per-item ✅/❌ for each. */
  createdIds: number[];
  /** Ids flagged needs_review this run (weak/demoted closes) — "looks done?". */
  flaggedReviewIds: number[];
}

const RESOLUTION_TO_STATUS: Record<ResolutionType, ResolveInput['status']> = {
  done: 'done',
  answered: 'answered',
  superseded: 'superseded',
};
const RESOLUTION_TO_EVENT: Record<ResolutionType, ResolveInput['event']> = {
  done: 'closed',
  answered: 'answered',
  superseded: 'superseded',
};

/**
 * Same logical owner? Match by stable id when both have one, else by display
 * name, else (both unowned, e.g. two ideas) the same bucket.
 *
 * Assumption: display names are distinct within the team. When only one side
 * has an owner_id we fall back to name — which could merge two different people
 * sharing a display name. Low risk for a small team with distinct names; once
 * the synth populates owner_id reliably (it adds author_id to the window in
 * increment 2) the mixed case becomes rare. Revisit if names ever collide.
 */
function sameOwner(a: TrackerItem, n: ProposedNewItem): boolean {
  if (a.owner_id !== null && n.owner_id !== null) return a.owner_id === n.owner_id;
  if (a.owner !== null && n.owner !== null) return a.owner.toLowerCase() === n.owner.toLowerCase();
  return a.owner_id === null && n.owner_id === null && a.owner === null && n.owner === null;
}

/**
 * Apply a VALIDATED reconciliation deterministically (no LLM). The branded
 * input type makes it a compile error to apply un-validated model output. Each
 * mutation is atomic with its audit event (store guarantees that). Order:
 * touches → resolutions → inserts, so dedup sees the full pre-existing open set.
 */
export function applyReconciliation(
  store: TrackerDb,
  validated: ValidatedReconciliation,
  ctx: ReconcileContext,
): ReconcileSummary {
  const threshold = ctx.dedupThreshold ?? DEDUP_OVERLAP_THRESHOLD;
  const maxStrong = ctx.maxStrongAutoCloses ?? MAX_STRONG_AUTO_CLOSES;
  const summary: ReconcileSummary = {
    created: 0,
    touched: 0,
    closed: 0,
    flaggedReview: 0,
    dedupedToTouch: 0,
    demotedStrongCloses: 0,
    createdIds: [],
    flaggedReviewIds: [],
  };

  // Fail loud rather than persisting an empty/garbage citation URL.
  const urlFor = (msgId: string): string => {
    const url = ctx.urlFor(msgId);
    if (typeof url !== 'string' || url === '') {
      throw new Error(`urlFor returned no URL for in-window message ${msgId}`);
    }
    return url;
  };

  const baseCtx = (detail: Record<string, unknown>): EventCtx => ({
    source: 'synth_infer',
    ts: ctx.now,
    synthRunId: ctx.synthRunId,
    detail,
  });

  // touches
  for (const t of validated.touches) {
    store.touchItem(t.target_id, baseCtx({ evidence_msg_id: t.evidence_msg_id }));
    summary.touched += 1;
  }

  // resolutions. strong → close; weak → "looks done?" review. If a single run
  // proposes more strong closes than the cap, demote them ALL to review.
  const strongCount = validated.resolutions.filter((r) => r.strength === 'strong').length;
  const demoteStrong = strongCount > maxStrong;
  for (const r of validated.resolutions) {
    if (r.strength === 'weak' || demoteStrong) {
      store.flagReview(
        r.target_id,
        baseCtx({
          proposed: r.type,
          evidence_msg_id: r.evidence_msg_id,
          strength: r.strength,
          demoted: demoteStrong && r.strength === 'strong',
        }),
      );
      summary.flaggedReviewIds.push(r.target_id);
      if (r.strength === 'strong') summary.demotedStrongCloses += 1;
      else summary.flaggedReview += 1;
      continue;
    }
    store.resolveItem(
      r.target_id,
      {
        status: RESOLUTION_TO_STATUS[r.type],
        event: RESOLUTION_TO_EVENT[r.type],
        resolved_msg_id: r.evidence_msg_id,
        resolved_url: urlFor(r.evidence_msg_id),
        resolved_by: null, // auto-close from inference; a ✅-confirmed close sets this via the reaction path
      },
      baseCtx({ evidence_msg_id: r.evidence_msg_id, strength: 'strong' }),
    );
    summary.closed += 1;
  }

  // inserts, with dedup-to-touch against the (now-current) open set + this batch
  const working: TrackerItem[] = store.listOpen();
  for (const n of validated.new_items) {
    const dup = working.find(
      (a) => a.kind === n.kind && sameOwner(a, n) && tokenOverlap(a.text, n.text) >= threshold,
    );
    if (dup !== undefined) {
      store.touchItem(dup.id, baseCtx({ deduped_from_msg_id: n.source_msg_id, reason: 'overlap' }));
      summary.dedupedToTouch += 1;
      continue;
    }
    const id = store.createItem(
      {
        kind: n.kind,
        text: n.text,
        owner: n.owner,
        owner_id: n.owner_id,
        confidence: n.confidence,
        blocked: n.blocked,
        source_msg_id: n.source_msg_id,
        source_url: urlFor(n.source_msg_id),
      },
      baseCtx({ source_msg_id: n.source_msg_id, confidence: n.confidence }),
    );
    summary.created += 1;
    summary.createdIds.push(id);
    const inserted = store.getItem(id);
    if (inserted !== undefined) working.push(inserted);
  }

  return summary;
}
