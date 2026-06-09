import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildSurfacingDeps } from '../src/synth/index.js';
import { parseProfile } from '../src/profile/schema.js';
import { EXAMPLE_PROFILE_PATH } from '../src/profile/load.js';
import type { SynthConfig } from '../src/synth/config.js';

const EXAMPLE = JSON.parse(readFileSync(EXAMPLE_PROFILE_PATH, 'utf-8'));
const profile = parseProfile(EXAMPLE);

function cfg(over: Partial<SynthConfig>): SynthConfig {
  return {
    discordGuildId: 'g',
    dbPath: 'd',
    webhookUrl: 'https://example/webhook',
    provider: { apiKey: 'k', baseUrl: 'https://api/anthropic', model: 'm' },
    systemPrompt: 'sys',
    profile,
    logLevel: 'silent',
    trackerDbPath: './t.db',
    surfacingEnabled: true,
    botToken: 'bot-token',
    ...over,
  };
}

describe('buildSurfacingDeps — surfacing preconditions (final-sweep F2/F5)', () => {
  it('returns deps when enabled with a webhook + bot token + distinct emojis', () => {
    expect(buildSurfacingDeps(cfg({}))).toBeDefined();
  });

  it('returns undefined (shadow) when surfacing is disabled', () => {
    expect(buildSurfacingDeps(cfg({ surfacingEnabled: false }))).toBeUndefined();
  });

  it('returns undefined — no aging — when the bot token is missing (never age without corrections) (F2)', () => {
    expect(buildSurfacingDeps(cfg({ botToken: null }))).toBeUndefined();
  });

  it('returns undefined when there is no webhook to post to', () => {
    expect(buildSurfacingDeps(cfg({ webhookUrl: null }))).toBeUndefined();
  });

  it('returns undefined when confirm and veto emojis are identical (a ✅ would be read as ❌) (F5)', () => {
    const sameEmoji = parseProfile({ ...EXAMPLE, confirmEmoji: '👍', vetoEmoji: '👍' });
    expect(buildSurfacingDeps(cfg({ profile: sameEmoji }))).toBeUndefined();
  });
});
