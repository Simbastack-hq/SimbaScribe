import { z } from 'zod';

/**
 * The workspace profile — the single config object that carries everything
 * team-, venture-, language-, channel-, and provider-specific. The committed
 * source ships a generic skeleton + a fictional example profile; a real
 * deployment supplies its own (gitignored) profile. Genericization lives here:
 * NO team-specific literal belongs anywhere else in src/.
 *
 * Prompt-shaping fields are deliberately freeform strings (markdown fragments),
 * not over-structured: the language-specific calibration text (signal markers,
 * few-shot corpus, channel notes) varies wildly by team and language, so the
 * skeleton owns the STRUCTURE and the profile owns the CONTENT. The renderer
 * (render.ts) slots these into the skeleton templates.
 */

const CanonRuleSchema = z.object({
  /** The raw display name / handle as written in chat. */
  from: z.string().min(1),
  /** The canonical name (or role) it resolves to. */
  to: z.string().min(1),
});

/**
 * Per-category classification guidance for the digest's seven signal buckets.
 * Each is a markdown fragment (typically a heading + bullet list of language-
 * specific markers / examples) injected under that category's generic
 * definition in the system prompt skeleton.
 */
const SignalsSchema = z.object({
  commitment: z.string(),
  decision: z.string(),
  openQuestion: z.string(),
  blocker: z.string(),
  status: z.string(),
  context: z.string(),
  noise: z.string(),
});

/**
 * The model provider. The API KEY is never stored in the profile — only the
 * NAME of the env var that holds it (`apiKeyEnv`), so secrets stay in .env and
 * the profile is safe to commit / share. baseUrl is an Anthropic-protocol
 * endpoint (Anthropic itself, or any Anthropic-protocol-compatible gateway).
 *
 * STRICT on purpose: an unknown key (e.g. someone inlining `apiKey: "sk-…"`) is
 * REJECTED loudly rather than silently stripped, so a literal secret can't slip
 * into the committed/shared profile. `apiKeyEnv` is constrained to an env-var
 * NAME shape (UPPER_SNAKE_CASE) so a secret accidentally pasted there is caught
 * at validation instead of being echoed into a "missing env var" error.
 */
const ProviderSchema = z
  .object({
    baseUrl: z.string().min(1),
    apiKeyEnv: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/, 'apiKeyEnv must be an ENV VAR NAME (UPPER_SNAKE_CASE), not a secret value'),
    model: z.string().min(1),
  })
  .strict();

/** Aging thresholds (days) for the tracker nag-loop. Decisions never age. */
const AgingSchema = z.object({
  todoResurfaceDays: z.number().positive(),
  todoArchiveGraceDays: z.number().positive(),
  ideaRevisitDays: z.number().positive(),
});

const DEFAULT_AGING = { todoResurfaceDays: 5, todoArchiveGraceDays: 9, ideaRevisitDays: 60 };

/**
 * A single name→Discord-ID mapping for opt-in @-mention tagging in the digest.
 * `name` is the CANONICAL name as printed in the digest prose; `discordId` is the
 * teammate's Discord user snowflake. STRICT on the ID SHAPE so a typo is caught at
 * load rather than silently pinging the wrong person — shape only, though: a
 * valid-but-wrong snowflake is uncatchable, so the roster must be curated.
 */
const MentionRosterEntrySchema = z.object({
  name: z.string().min(1),
  discordId: z.string().regex(/^\d{17,20}$/, 'discordId must be a Discord snowflake (17–20 digits)'),
});
export type MentionRosterEntry = z.infer<typeof MentionRosterEntrySchema>;

const DEFAULT_MENTIONS: { enabled: boolean; roster: MentionRosterEntry[] } = { enabled: false, roster: [] };

export const WorkspaceProfileSchema = z.object({
  /** The bot's display name (e.g. "SimbaScribe"). */
  botName: z.string().min(1),
  /**
   * Possessive-friendly name for the workspace/team (e.g. "the Acme dev team").
   * Rendered as "{workspaceName}'s institutional memory", so phrase it to read
   * correctly with a trailing "'s".
   */
  workspaceName: z.string().min(1),
  /** One short paragraph: who's on the team + what they work on. */
  teamOverview: z.string().min(1),
  /**
   * Optional note about people who matter but aren't in the chat corpus (e.g.
   * co-founders who communicate off-platform). Empty when everyone's in chat.
   */
  offPlatformNote: z.string().default(''),
  /**
   * Optional note about the language(s) the team writes in. Empty for a plain
   * monolingual-English team; for a code-switching team, describe the mix so
   * the model reads it correctly.
   */
  languageGuidance: z.string().default(''),
  signals: SignalsSchema,
  /** Per-channel classification context (markdown bullets). */
  channelContext: z.string().min(1),
  /** Display-name → canonical-name resolution rules. */
  canonicalization: z.array(CanonRuleSchema).default([]),
  /** Heading for the worked-examples section (default "Worked examples"). */
  fewShotHeading: z.string().default('Worked examples'),
  /**
   * Optional worked examples from the team's own corpus — the classifier's
   * calibration set. Strongly recommended; a profile without them still works
   * off the generic taxonomy, just less tuned.
   */
  fewShotExamples: z.string().default(''),
  /**
   * Reaction that pins/confirms a tracked item (default ✅). LENIENT: an invalid
   * value falls back to the default instead of aborting — confirmEmoji touches
   * the digest (rule 6) but the tracker reactions are isolated, so a bad emoji
   * must never break the live digest.
   */
  confirmEmoji: z.string().min(1).catch('✅'),
  /**
   * Reaction that vetoes/dismisses a tracked item (default ❌). LENIENT (tracker-
   * only): an invalid value can never abort the digest — it degrades to default.
   */
  vetoEmoji: z.string().min(1).catch('❌'),
  provider: ProviderSchema,
  /**
   * Aging thresholds for the tracker nag-loop. LENIENT (tracker-only): a missing
   * OR malformed value degrades to defaults rather than aborting the run — aging
   * is consumed only inside the isolated tracker step, so it must never be able
   * to break the live digest (the digest never reads it).
   */
  aging: AgingSchema.catch(DEFAULT_AGING).default(DEFAULT_AGING),
  /**
   * Opt-in @-mention tagging. When `enabled` AND the roster is non-empty, the
   * digest replaces each rostered person's FIRST appearance with a Discord ping.
   * LENIENT (digest-touching, like confirmEmoji/aging): a present-but-invalid
   * block degrades to OFF rather than aborting the live digest; absent → OFF. The
   * `.catch` is intentionally SILENT (matching every other `.catch` here) — the
   * loud signal lives at the use-site in synth/index.ts, after the log level is set.
   */
  mentions: z
    .object({
      enabled: z.boolean().default(false),
      roster: z.array(MentionRosterEntrySchema).default([]),
    })
    .catch(DEFAULT_MENTIONS)
    .default(DEFAULT_MENTIONS),
});

export type WorkspaceProfile = z.infer<typeof WorkspaceProfileSchema>;

/**
 * Parse + validate an unknown value (e.g. JSON.parse output) into a
 * WorkspaceProfile. Throws a readable aggregated error listing every invalid
 * field — a malformed profile must fail loud at load, never silently.
 */
export function parseProfile(value: unknown): WorkspaceProfile {
  const result = WorkspaceProfileSchema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid workspace profile:\n${issues}`);
  }
  return result.data;
}
