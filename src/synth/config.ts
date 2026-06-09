import { required } from '../config.js';
import { loadProfile } from '../profile/load.js';
import { renderSystemPrompt } from '../profile/render.js';
import type { WorkspaceProfile } from '../profile/schema.js';

/** The model provider with its API key resolved from the env var the profile names. */
export interface ResolvedProvider {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
}

export interface SynthConfig {
  readonly discordGuildId: string;
  readonly dbPath: string;
  readonly webhookUrl: string | null;
  readonly provider: ResolvedProvider;
  /** The digest system prompt, rendered from the profile (the digest needs it,
   *  so it's resolved eagerly — a render failure here legitimately stops the run). */
  readonly systemPrompt: string;
  /** The full workspace profile (provider, aging, emojis, the tracker prompt
   *  skeleton source). Carried so the isolated tracker step can render its OWN
   *  prompt lazily, inside its swallow boundary — never at startup. */
  readonly profile: WorkspaceProfile;
  readonly logLevel: string;
  /** Phase 2 tracker write store. When set, the synth runs the (isolated)
   *  shadow reconcile step. Unset → tracker step is skipped entirely. */
  readonly trackerDbPath: string | null;
  /** Nag-loop flag, default OFF. When true (and the webhook + bot token are
   *  present), the isolated tracker step also ages the list, posts the surfacing
   *  summary + per-item ✅/❌ messages, and reads reactions. Default false →
   *  shadow reconcile only (capture + recall), identical to today. */
  readonly surfacingEnabled: boolean;
  /** Discord bot token — reused read-only to read ✅/❌ reactions when surfacing
   *  is on. Unset → reactions can't be read (surfacing degrades to post-only). */
  readonly botToken: string | null;
}

/**
 * Loads the synth's configuration. The model provider (baseUrl + model) comes
 * from the active workspace profile; the API KEY comes from the env var the
 * profile names (`provider.apiKeyEnv`), so secrets stay in .env, never in the
 * committed/shared profile.
 *
 * `requirePostingVars` is false in dry-run: the webhook URL isn't needed when
 * we're only printing to stdout. The model key IS required even in dry-run,
 * because a dry-run still makes the model call — that's the point. Fails loud on
 * any missing required var (including an unconfigured/invalid workspace profile).
 */
export function loadSynthConfig(opts: { requirePostingVars: boolean }): SynthConfig {
  const profile = loadProfile();
  const provider: ResolvedProvider = {
    apiKey: required(profile.provider.apiKeyEnv),
    baseUrl: profile.provider.baseUrl,
    model: profile.provider.model,
  };
  return {
    discordGuildId: required('DISCORD_GUILD_ID'),
    dbPath: required('SIMBASCRIBE_DB_PATH'),
    provider,
    systemPrompt: renderSystemPrompt(profile),
    profile,
    webhookUrl: opts.requirePostingVars
      ? required('SIMBASCRIBE_OUTPUT_WEBHOOK_URL')
      : process.env.SIMBASCRIBE_OUTPUT_WEBHOOK_URL?.trim() || null,
    logLevel: process.env.LOG_LEVEL?.trim() || 'info',
    trackerDbPath: process.env.SIMBASCRIBE_TRACKER_DB_PATH?.trim() || null,
    surfacingEnabled: process.env.SIMBASCRIBE_TRACKER_SURFACING_ENABLED?.trim() === 'true',
    botToken: process.env.DISCORD_BOT_TOKEN?.trim() || null,
  };
}
