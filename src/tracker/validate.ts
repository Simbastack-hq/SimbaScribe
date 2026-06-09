import {
  type Reconciliation,
  type ValidatedReconciliation,
  type ValidationResult,
  type RejectedEntry,
  type TrackerItem,
  type TrackerKind,
  type ResolutionType,
  V1_KINDS,
} from './types.js';

/**
 * Semantic validation of the model's proposed reconciliation against reality —
 * the dumb-middle-guards-the-smart-edge boundary, and the main injection defense
 * on the write path. (STRUCTURAL validation — is the JSON well-formed and
 * schema-shaped — happens in the model layer before this; here we assume typed
 * arrays and check that they reference real, legal things.)
 *
 * What this STOPS: closing/touching unknown or already-closed items, citing
 * evidence the model never read this run (out-of-window), illegal transitions
 * (e.g. "done" on an idea), and non-v1 kinds. It bounds an injection to the
 * current window's real, open items.
 *
 * What this does NOT stop (by design — it would need a second model): a
 * *semantically wrong but structurally valid* close — e.g. an in-window message
 * the model mis-attributes to the wrong open item. That residual is caught
 * downstream by soft-close (never hard-delete) + human reopen (❌), and bounded
 * by the strong-auto-close cap in reconcile.
 *
 * Rejected entries are RETURNED (for the caller to log loudly), never silently
 * dropped, and never abort the run — a single bad entry must not lose the rest.
 */
export interface ValidationContext {
  /** Currently-open items, keyed by id (what the model was shown this run). */
  openItems: Map<number, TrackerItem>;
  /** Message ids present in THIS run's window — evidence must come from here. */
  windowMsgIds: Set<string>;
}

/** Which resolution a kind may legally take. idea never resolves via reconcile. */
const LEGAL_RESOLUTION: Record<TrackerKind, ResolutionType | null> = {
  todo: 'done',
  question: 'answered',
  decision: 'superseded',
  idea: null,
};

export function validateReconciliation(
  proposal: Reconciliation,
  ctx: ValidationContext,
): ValidationResult {
  const rejected: RejectedEntry[] = [];
  const valid: Reconciliation = { new_items: [], resolutions: [], touches: [] };

  for (const item of proposal.new_items) {
    if (!V1_KINDS.includes(item.kind)) {
      rejected.push({ entry: 'new_item', reason: `kind not emitted in v1: ${item.kind}`, value: item });
      continue;
    }
    if (typeof item.text !== 'string' || item.text.trim() === '') {
      rejected.push({ entry: 'new_item', reason: 'empty text', value: item });
      continue;
    }
    if (item.confidence !== 'high' && item.confidence !== 'low') {
      rejected.push({ entry: 'new_item', reason: `bad confidence: ${String(item.confidence)}`, value: item });
      continue;
    }
    if (!ctx.windowMsgIds.has(item.source_msg_id)) {
      rejected.push({
        entry: 'new_item',
        reason: `source_msg_id not in this run's window: ${item.source_msg_id}`,
        value: item,
      });
      continue;
    }
    // TODO(2b-3): bound owner_id to an in-window author id. Today a model-
    // proposed owner_id is persisted as-is (source_msg_id is window-checked, but
    // owner_id is not). Low-risk in shadow (a wrong owner on an unseen item), but
    // before the tracker goes team-visible, thread windowAuthorIds through
    // ValidationContext and reject an owner_id that no in-window message authored.
    // blocked is meaningful only for todo; force it off for other kinds.
    valid.new_items.push({ ...item, blocked: item.kind === 'todo' ? item.blocked : false });
  }

  for (const res of proposal.resolutions) {
    const target = ctx.openItems.get(res.target_id);
    if (target === undefined) {
      rejected.push({ entry: 'resolution', reason: `target ${res.target_id} not open/unknown`, value: res });
      continue;
    }
    if (res.strength !== 'strong' && res.strength !== 'weak') {
      rejected.push({ entry: 'resolution', reason: `bad strength: ${String(res.strength)}`, value: res });
      continue;
    }
    const legal = LEGAL_RESOLUTION[target.kind];
    if (legal === null || res.type !== legal) {
      rejected.push({
        entry: 'resolution',
        reason: `illegal ${res.type} on ${target.kind} #${res.target_id}`,
        value: res,
      });
      continue;
    }
    if (!ctx.windowMsgIds.has(res.evidence_msg_id)) {
      rejected.push({
        entry: 'resolution',
        reason: `evidence_msg_id not in this run's window: ${res.evidence_msg_id}`,
        value: res,
      });
      continue;
    }
    valid.resolutions.push(res);
  }

  for (const touch of proposal.touches) {
    if (!ctx.openItems.has(touch.target_id)) {
      rejected.push({ entry: 'touch', reason: `target ${touch.target_id} not open/unknown`, value: touch });
      continue;
    }
    if (!ctx.windowMsgIds.has(touch.evidence_msg_id)) {
      rejected.push({
        entry: 'touch',
        reason: `evidence_msg_id not in this run's window: ${touch.evidence_msg_id}`,
        value: touch,
      });
      continue;
    }
    valid.touches.push(touch);
  }

  // The brand: `valid` was built only from entries that passed every check
  // above, so it is — by construction — a ValidatedReconciliation.
  return { valid: valid as ValidatedReconciliation, rejected };
}
