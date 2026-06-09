import type { TrackerDb, EventCtx } from './store.js';
import type { TrackerItem } from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface AgingConfig {
  /** Days a todo can sit untouched before it's resurfaced once. */
  todoResurfaceMs: number;
  /** After resurfacing, grace before an still-untouched todo auto-archives. */
  todoArchiveGraceMs: number;
  /** Days an idea sits before a single gentle "worth revisiting?" nudge. */
  ideaRevisitMs: number;
}

// Defaults from the resolved knobs (§17.3): todo 5d→resurface, 14d→archive
// (= 5d + 9d grace), idea 60d gentle revisit. Decisions never age.
export const DEFAULT_AGING: AgingConfig = {
  todoResurfaceMs: 5 * DAY_MS,
  todoArchiveGraceMs: 9 * DAY_MS,
  ideaRevisitMs: 60 * DAY_MS,
};

export interface AgingResult {
  /** Todos surfaced "still open? ✅ keep / ❌ drop" (resurfaced this run). */
  resurfaced: TrackerItem[];
  /** Ideas surfaced "worth revisiting?" (one gentle nudge). */
  revisited: TrackerItem[];
  /** Todos auto-archived after the resurface grace lapsed untouched. */
  archived: TrackerItem[];
}

/**
 * Deterministic aging pass (no LLM). Resurface-once-then-archive for todos;
 * a single gentle revisit for ideas; decisions never age. Pinned items and
 * items awaiting a "looks done?" review are left alone.
 *
 * Returns the items to surface so the synth can post the prompts; the state
 * transitions (resurfaced_at set / archived) are applied here.
 */
export function runAging(store: TrackerDb, config: AgingConfig, now: number): AgingResult {
  const result: AgingResult = { resurfaced: [], revisited: [], archived: [] };
  const ctx = (detail: Record<string, unknown>): EventCtx => ({ source: 'aging', ts: now, detail });

  for (const item of store.listOpen()) {
    if (item.human_flag === 'pinned') continue; // pinned never ages
    if (item.needs_review) continue; // awaiting a human "looks done?" decision

    if (item.kind === 'todo') {
      if (item.resurfaced_at === null) {
        if (now - item.last_seen_at >= config.todoResurfaceMs) {
          store.resurfaceItem(item.id, ctx({ age_ms: now - item.last_seen_at }));
          result.resurfaced.push(item);
        }
      } else if (now - item.resurfaced_at >= config.todoArchiveGraceMs) {
        store.archiveItem(item.id, ctx({ since_resurface_ms: now - item.resurfaced_at }));
        result.archived.push(item);
      }
    } else if (item.kind === 'idea') {
      // Passive: one gentle revisit, never auto-archived.
      if (item.resurfaced_at === null && now - item.last_seen_at >= config.ideaRevisitMs) {
        store.resurfaceItem(item.id, ctx({ age_ms: now - item.last_seen_at, kind: 'idea' }));
        result.revisited.push(item);
      }
    }
    // decision (and the deferred question kind): never aged here.
  }

  return result;
}
