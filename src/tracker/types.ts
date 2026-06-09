// Shared tracker types. v1 emits 'todo' | 'idea' | 'decision'; 'question' is
// designed-for (the close-detection fast-follow) and kept in the union so the
// schema/machinery stay kind-extensible — but the v1 classifier never emits it.

export type TrackerKind = 'todo' | 'idea' | 'decision' | 'question';

/** Kinds the v1 reconcile will accept from the model. 'question' is rejected. */
export const V1_KINDS: readonly TrackerKind[] = ['todo', 'idea', 'decision'];

export type TrackerStatus =
  | 'open'
  | 'done'
  | 'answered'
  | 'superseded'
  | 'dismissed'
  | 'archived';

export type Confidence = 'high' | 'low';

export type HumanFlag = 'pinned' | 'dismissed' | 'reopened';

export type ResolutionType = 'done' | 'answered' | 'superseded';

export type ResolutionStrength = 'strong' | 'weak';

export type EventName =
  | 'created'
  | 'touched'
  | 'closed'
  | 'answered'
  | 'superseded'
  | 'pinned'
  | 'dismissed'
  | 'reopened'
  | 'flagged_review'
  | 'resurfaced'
  | 'auto_archived';

export type EventSource = 'synth_infer' | 'reaction' | 'aging';

/** A row in tracker_items, with SQLite's 0/1 ints decoded to booleans. */
export interface TrackerItem {
  id: number;
  kind: TrackerKind;
  text: string;
  owner: string | null;
  owner_id: string | null;
  status: TrackerStatus;
  confidence: Confidence;
  blocked: boolean;
  human_flag: HumanFlag | null;
  source_msg_id: string;
  source_url: string;
  created_at: number;
  last_seen_at: number;
  resolved_at: number | null;
  resolved_msg_id: string | null;
  resolved_url: string | null;
  resolved_by: string | null;
  needs_review: boolean;
  superseded_by: number | null;
  resurfaced_at: number | null;
  digest_msg_id: string | null;
  /** The semantic of the bound message ('new'|'looks-done'|'resurfaced'|'revisit').
   *  A reaction is interpreted by THIS stored semantic, not by the item's current
   *  state — so a state change without a successful re-post can't reinterpret an
   *  old reaction (e.g. a 'new' prompt's ✅ always means "pin", never "confirm close"). */
  digest_msg_kind: string | null;
}

/** What the synth's one LLM call proposes (it never writes state directly). */
export interface ProposedNewItem {
  kind: TrackerKind;
  text: string;
  owner: string | null;
  owner_id: string | null;
  confidence: Confidence;
  blocked: boolean;
  source_msg_id: string;
}

export interface ProposedResolution {
  target_id: number;
  type: ResolutionType;
  strength: ResolutionStrength;
  evidence_msg_id: string;
}

export interface ProposedTouch {
  target_id: number;
  evidence_msg_id: string;
}

export interface Reconciliation {
  new_items: ProposedNewItem[];
  resolutions: ProposedResolution[];
  touches: ProposedTouch[];
}

/**
 * A reconciliation that has passed validateReconciliation. The brand makes it a
 * COMPILE error to hand raw (un-validated) model output to applyReconciliation —
 * closing the injection footgun where a caller skips the semantic guard. The
 * only producer of this type is the validator.
 */
export type ValidatedReconciliation = Reconciliation & { readonly __validated: unique symbol };

/** A proposal entry the validator threw out, with a machine-readable reason. */
export interface RejectedEntry {
  entry: 'new_item' | 'resolution' | 'touch';
  reason: string;
  value: unknown;
}

export interface ValidationResult {
  valid: ValidatedReconciliation;
  rejected: RejectedEntry[];
}
