import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadProfile } from '../src/profile/load.js';
import { renderSystemPrompt } from '../src/profile/render.js';

/**
 * LOCAL-ONLY regression guard (skipped in CI / fresh clones). When a real
 * workspace profile AND a golden copy of the original (pre-genericization) digest
 * prompt are both present, this proves the profile still renders the live prompt
 * with NO structural drift, and that the ONLY content difference is confined to
 * the single documented, genericization-mandated change: rule 6's illustrative
 * example (the original cited a workspace-specific phrase, which cannot remain in
 * committed source — so the skeleton uses a language-neutral illustration).
 *
 * To enable on a real deployment: keep `config/workspace.local.json` (your real
 * profile) and `config/golden-system-prompt.local.txt` (a copy of the prompt as
 * it was before genericization). Both are gitignored.
 */
const LOCAL_PROFILE = resolve(process.cwd(), 'config/workspace.local.json');
const GOLDEN = resolve(process.cwd(), 'config/golden-system-prompt.local.txt');
const hasLocal = existsSync(LOCAL_PROFILE) && existsSync(GOLDEN);

describe.runIf(hasLocal)('live digest prompt equivalence (local profile present)', () => {
  it('renders the original prompt with no drift beyond the documented rule-6 illustration', () => {
    const golden = readFileSync(GOLDEN, 'utf-8').replace(/\s*$/, '').split('\n');
    const rendered = renderSystemPrompt(loadProfile(LOCAL_PROFILE)).replace(/\s*$/, '').split('\n');

    // No structural drift: same number of lines.
    expect(rendered.length).toBe(golden.length);

    // The only differing lines must be the rule-6 illustration (≤ 2 lines), and
    // they must sit at/after rule 6 in the "Hard rules" section.
    const diffLines = golden.map((g, i) => (g === rendered[i] ? -1 : i)).filter((i) => i >= 0);
    expect(diffLines.length).toBeLessThanOrEqual(2);
    const rule6 = golden.findIndex((l) => l.startsWith('6. Reaction'));
    expect(rule6).toBeGreaterThan(0);
    for (const i of diffLines) expect(i).toBeGreaterThanOrEqual(rule6);

    // And the rendered rule 6 carries the generic phrasing (proves it actually rendered).
    expect(rendered.join('\n')).toContain('another teammate reacts');
  });
});
