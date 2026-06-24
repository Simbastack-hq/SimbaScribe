import { describe, it, expect, vi } from 'vitest';
import { readFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseProfile, WorkspaceProfileSchema } from '../src/profile/schema.js';
import { interpolate, renderSystemPrompt, renderTrackerPrompt } from '../src/profile/render.js';
import { loadProfile, resolveProfilePath, EXAMPLE_PROFILE_PATH, PROFILE_ENV } from '../src/profile/load.js';
import { log } from '../src/log.js';

const writeTempProfile = (value: unknown): string => {
  const f = join(mkdtempSync(join(tmpdir(), 'ss-prof-')), 'p.json');
  writeFileSync(f, JSON.stringify(value));
  return f;
};

const EXAMPLE = JSON.parse(readFileSync(EXAMPLE_PROFILE_PATH, 'utf-8'));

describe('interpolate', () => {
  it('fills every slot', () => {
    expect(interpolate('a {{X}} b {{Y}}', { X: '1', Y: '2' })).toBe('a 1 b 2\n');
  });

  it('throws on a slot with no value (never ships a literal {{X}})', () => {
    expect(() => interpolate('hi {{MISSING}}', { OTHER: 'x' })).toThrow(/unknown slot \{\{MISSING\}\}/);
  });

  it('collapses 3+ newlines to one blank line (empty slots leave no double gap)', () => {
    expect(interpolate('a\n\n{{E}}\n\nb', { E: '' })).toBe('a\n\nb\n');
  });

  it('a fully-populated template is unaffected by the collapse', () => {
    expect(interpolate('a\n\n{{X}}\n\nb', { X: 'mid' })).toBe('a\n\nmid\n\nb\n');
  });

  it('throws on a malformed placeholder the substitution did not match', () => {
    // `{{ FOO }}` (spaces) doesn't match {{\w+}}, so it would otherwise reach the model literally.
    expect(() => interpolate('hi {{ FOO }}', { FOO: 'x' })).toThrow(/malformed placeholder/);
  });

  it('throws on empty rendered output (corrupt/empty skeleton)', () => {
    expect(() => interpolate('{{E}}', { E: '' })).toThrow(/rendered empty/);
  });
});

describe('parseProfile', () => {
  it('accepts the bundled example profile', () => {
    const p = parseProfile(EXAMPLE);
    expect(p.botName).toBe('Scribe');
    expect(p.provider.apiKeyEnv).toBe('MODEL_API_KEY');
  });

  it('applies defaults for omitted optional fields', () => {
    const minimal = {
      botName: 'B',
      workspaceName: 'the X team',
      teamOverview: 'one dev',
      signals: { commitment: 'c', decision: 'd', openQuestion: 'q', blocker: 'b', status: 's', context: 'x', noise: 'n' },
      channelContext: '- **general**: everything',
      provider: { baseUrl: 'https://api.example/anthropic', apiKeyEnv: 'KEY', model: 'm' },
    };
    const p = parseProfile(minimal);
    expect(p.offPlatformNote).toBe('');
    expect(p.languageGuidance).toBe('');
    expect(p.confirmEmoji).toBe('✅');
    expect(p.vetoEmoji).toBe('❌');
    expect(p.fewShotHeading).toBe('Worked examples');
    expect(p.canonicalization).toEqual([]);
    expect(p.aging).toEqual({ todoResurfaceDays: 5, todoArchiveGraceDays: 9, ideaRevisitDays: 60 });
    expect(p.mentions).toEqual({ enabled: false, roster: [] });
  });

  it('parses a valid mentions block (enabled + roster)', () => {
    const p = parseProfile({
      ...EXAMPLE,
      mentions: { enabled: true, roster: [{ name: 'Ada', discordId: '111111111111111111' }] },
    });
    expect(p.mentions.enabled).toBe(true);
    expect(p.mentions.roster).toEqual([{ name: 'Ada', discordId: '111111111111111111' }]);
  });

  // mentions touches the LIVE digest → it must degrade, never abort (like aging /
  // confirmEmoji). A typo'd ID (not a 17–20 digit snowflake) disables tagging for
  // the run instead of pinging a stranger or breaking the post.
  it('degrades a present-but-invalid mentions block to OFF (never aborts the digest)', () => {
    const p = parseProfile({
      ...EXAMPLE,
      mentions: { enabled: true, roster: [{ name: 'Ada', discordId: 'not-a-snowflake' }] },
    });
    expect(p.mentions).toEqual({ enabled: false, roster: [] });
  });

  it('rejects a profile missing a required field, naming the field', () => {
    const bad = { ...EXAMPLE };
    delete bad.provider;
    expect(() => parseProfile(bad)).toThrow(/Invalid workspace profile[\s\S]*provider/);
  });

  // Tracker-only fields must NEVER abort the run (the digest never reads them) —
  // an invalid value degrades to the default instead of throwing.
  it('degrades an invalid aging value to defaults (never aborts the digest)', () => {
    const p = parseProfile({ ...EXAMPLE, aging: { todoResurfaceDays: 0, todoArchiveGraceDays: 9, ideaRevisitDays: 60 } });
    expect(p.aging).toEqual({ todoResurfaceDays: 5, todoArchiveGraceDays: 9, ideaRevisitDays: 60 });
  });

  it('degrades an invalid (empty) vetoEmoji to its default', () => {
    expect(parseProfile({ ...EXAMPLE, vetoEmoji: '' }).vetoEmoji).toBe('❌');
  });

  // Secret-boundary: provider is strict — an inlined credential is rejected loud,
  // not silently stripped, so it can't slip into a committed/shared profile.
  it('rejects an inlined apiKey in the provider (strict)', () => {
    const bad = { ...EXAMPLE, provider: { ...EXAMPLE.provider, apiKey: 'sk-leaked-secret' } };
    expect(() => parseProfile(bad)).toThrow(/Invalid workspace profile/);
  });

  it('rejects an apiKeyEnv that looks like a secret value, not an env-var name', () => {
    const bad = { ...EXAMPLE, provider: { ...EXAMPLE.provider, apiKeyEnv: 'sk-abc123xyz' } };
    expect(() => parseProfile(bad)).toThrow(/ENV VAR NAME/);
  });
});

describe('renderSystemPrompt (example profile)', () => {
  const rendered = renderSystemPrompt(parseProfile(EXAMPLE));

  it('leaves no unfilled slots', () => {
    expect(rendered).not.toMatch(/\{\{\w+\}\}/);
  });

  it('contains the fictional workspace + roster', () => {
    expect(rendered).toContain('the Northwind team');
    expect(rendered).toContain('Ada, Ben, Chiara, Diego, and Erin');
  });

  it('contains no real-workspace tokens (strict check against the gitignored denylist, when present)', () => {
    // The real-name denylist lives in a gitignored file so it never ships in the
    // public tree. Present on a real deployment → strict check; absent (CI / fresh
    // clone) → the example is fictional anyway, so the positive check below suffices.
    const denylistPath = resolve(process.cwd(), 'config/pii-denylist.local.txt');
    if (existsSync(denylistPath)) {
      const lower = rendered.toLowerCase();
      const tokens = readFileSync(denylistPath, 'utf-8')
        .split('\n')
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t.length > 0 && !t.startsWith('#'));
      for (const token of tokens) expect(lower).not.toContain(token);
    }
    expect(rendered).toContain('the Northwind team'); // only fictional content
  });

  it('renders the canonicalization rules as indented bullets', () => {
    expect(rendered).toContain('   - "ada.codes" → "Ada"');
  });

  it('uses the profile fewShotHeading', () => {
    expect(rendered).toContain('## Worked examples');
  });
});

describe('renderTrackerPrompt (example profile)', () => {
  const rendered = renderTrackerPrompt(parseProfile(EXAMPLE));

  it('leaves no unfilled slots and is name-free', () => {
    expect(rendered).not.toMatch(/\{\{\w+\}\}/);
    expect(rendered.toLowerCase()).not.toContain('simbastack');
    expect(rendered).toContain('the Northwind team');
  });

  it('keeps the JSON output contract intact', () => {
    expect(rendered).toContain('"new_items"');
    expect(rendered).toContain('"resolutions"');
    expect(rendered).toContain('"touches"');
  });
});

describe('profile loading', () => {
  it('resolveProfilePath honors an explicit argument first', () => {
    expect(resolveProfilePath('/tmp/x.json')).toBe('/tmp/x.json');
  });

  it('resolveProfilePath falls back to the env var when no explicit arg', () => {
    const saved = process.env[PROFILE_ENV];
    process.env[PROFILE_ENV] = '/env/configured.json';
    try {
      expect(resolveProfilePath()).toBe('/env/configured.json');
    } finally {
      if (saved === undefined) delete process.env[PROFILE_ENV];
      else process.env[PROFILE_ENV] = saved;
    }
  });

  it('loadProfile reads + validates the example by explicit path', () => {
    expect(loadProfile(EXAMPLE_PROFILE_PATH).workspaceName).toBe('the Northwind team');
  });

  it('loadProfile throws a clear error on an unreadable path', () => {
    expect(() => loadProfile('/nonexistent/dir/profile.json')).toThrow(/Cannot read workspace profile/);
  });

  it('loadProfile throws a clear error on invalid JSON', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'ss-prof-')), 'bad.json');
    writeFileSync(f, '{ not valid json');
    expect(() => loadProfile(f)).toThrow(/not valid JSON/);
  });

  it('loadProfile surfaces schema errors from a syntactically-valid but invalid profile', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'ss-prof-')), 'empty.json');
    writeFileSync(f, '{}');
    expect(() => loadProfile(f)).toThrow(/Invalid workspace profile/);
  });

  // A typo'd roster degrades to OFF (digest-safe) but must NOT do so silently — an
  // opt-in feature the deployer turned on shouldn't vanish without a word.
  it('loadProfile warns loudly when an intended-on mentions block is invalid (then degrades to OFF)', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation((() => {}) as never);
    try {
      const f = writeTempProfile({ ...EXAMPLE, mentions: { enabled: true, roster: [{ name: 'X', discordId: 'nope' }] } });
      const p = loadProfile(f);
      expect(p.mentions).toEqual({ enabled: false, roster: [] }); // degraded, digest safe
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toMatch(/mentions.*invalid|DISABLED/i);
    } finally {
      warn.mockRestore();
    }
  });

  it('loadProfile does NOT warn for a valid mentions block', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation((() => {}) as never);
    try {
      const f = writeTempProfile({ ...EXAMPLE, mentions: { enabled: true, roster: [{ name: 'Ada', discordId: '111111111111111111' }] } });
      const p = loadProfile(f);
      expect(p.mentions.enabled).toBe(true);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('schema export', () => {
  it('is a zod object schema', () => {
    expect(typeof WorkspaceProfileSchema.safeParse).toBe('function');
  });
});
