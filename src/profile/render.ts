import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkspaceProfile } from './schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYSTEM_SKELETON_PATH = resolve(__dirname, 'system-prompt.skeleton.txt');
const TRACKER_SKELETON_PATH = resolve(__dirname, 'tracker-prompt.skeleton.txt');

/**
 * Replace every {{SLOT}} in `template` with the matching value from `slots`, then
 * FAIL LOUD on anything that would ship a malformed/empty prompt to the model:
 *
 *  - an unknown well-formed slot ({{FOO}} with no entry) → throw;
 *  - any residual `{{`/`}}` after substitution (e.g. a malformed `{{ FOO }}` that
 *    the substitution regex didn't match) → throw, so a literal brace-pair never
 *    reaches the model;
 *  - empty rendered output (e.g. a corrupt/empty skeleton) → throw, so the digest
 *    never calls the model without its system prompt.
 *
 * After substitution, runs of 3+ newlines collapse to 2 (one blank line) so an
 * empty slot (e.g. no off-platform note) doesn't leave a double gap. When every
 * slot is non-empty the output is unaffected — a fully-populated profile
 * reproduces the source text exactly.
 */
export function interpolate(template: string, slots: Record<string, string>): string {
  const substituted = template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const value = slots[key];
    // `undefined` = no entry for this slot (a skeleton/profile mismatch); an
    // empty string is a legitimate value (e.g. no off-platform note).
    if (value === undefined) {
      throw new Error(`prompt skeleton references unknown slot {{${key}}}`);
    }
    return value;
  });
  // A residual brace-pair means a malformed placeholder the substitution missed.
  if (/\{\{|\}\}/.test(substituted)) {
    const stray = substituted.match(/\{\{[^}]*\}?\}?|\{?\{?[^{]*\}\}/)?.[0] ?? '';
    throw new Error(`prompt skeleton has a malformed placeholder near: ${stray.slice(0, 40)}`);
  }
  const rendered = substituted.replace(/\n{3,}/g, '\n\n').trim() + '\n';
  if (rendered.trim() === '') {
    throw new Error('prompt skeleton rendered empty — refusing to call the model without a system prompt');
  }
  return rendered;
}

/** Render the canonicalization rules as indented bullets (matches rule 3's layout). */
function renderCanonicalization(profile: WorkspaceProfile): string {
  if (profile.canonicalization.length === 0) return '   (no name remapping needed)';
  return profile.canonicalization.map((r) => `   - "${r.from}" → "${r.to}"`).join('\n');
}

/** Slots shared by both prompt skeletons. */
function commonSlots(profile: WorkspaceProfile): Record<string, string> {
  return {
    BOT_NAME: profile.botName,
    WORKSPACE_NAME: profile.workspaceName,
    LANGUAGE_GUIDANCE: profile.languageGuidance,
    CONFIRM_EMOJI: profile.confirmEmoji,
    VETO_EMOJI: profile.vetoEmoji,
  };
}

/** Render the digest system prompt from the skeleton + profile. */
export function renderSystemPrompt(profile: WorkspaceProfile, skeleton = readSkeleton(SYSTEM_SKELETON_PATH)): string {
  return interpolate(skeleton, {
    ...commonSlots(profile),
    TEAM_OVERVIEW: profile.teamOverview,
    OFF_PLATFORM_NOTE: profile.offPlatformNote,
    COMMITMENT_MARKERS: profile.signals.commitment,
    DECISION_MARKERS: profile.signals.decision,
    OPEN_QUESTION_MARKERS: profile.signals.openQuestion,
    BLOCKER_MARKERS: profile.signals.blocker,
    STATUS_MARKERS: profile.signals.status,
    CONTEXT_EXAMPLES: profile.signals.context,
    NOISE_EXAMPLES: profile.signals.noise,
    CHANNEL_CONTEXT: profile.channelContext,
    CANONICALIZATION_RULES: renderCanonicalization(profile),
    FEWSHOT_HEADING: profile.fewShotHeading,
    FEWSHOT_EXAMPLES: profile.fewShotExamples,
  });
}

/** Render the tracker reconcile system prompt from the skeleton + profile. */
export function renderTrackerPrompt(profile: WorkspaceProfile, skeleton = readSkeleton(TRACKER_SKELETON_PATH)): string {
  return interpolate(skeleton, commonSlots(profile));
}

function readSkeleton(path: string): string {
  return readFileSync(path, 'utf-8');
}
