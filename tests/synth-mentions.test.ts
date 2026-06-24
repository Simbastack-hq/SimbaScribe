import { describe, it, expect } from 'vitest';
import { applyMentions } from '../src/synth/mentions.js';
import type { MentionRosterEntry } from '../src/profile/schema.js';

const r = (name: string, discordId: string): MentionRosterEntry => ({ name, discordId });

describe('applyMentions', () => {
  it('replaces the first occurrence of a rostered name with <@id>', () => {
    const { text, mentionedIds } = applyMentions('Ben shipped the fix.', [r('Ben', '111111111111111111')]);
    expect(text).toBe('<@111111111111111111> shipped the fix.');
    expect(mentionedIds).toEqual(['111111111111111111']);
  });

  it('tags each person only ONCE — the first occurrence — even if named repeatedly', () => {
    const { text, mentionedIds } = applyMentions(
      'Ben opened it. Ben reviewed it. Ben merged it.',
      [r('Ben', '111111111111111111')],
    );
    // first "Ben" → mention; the later two stay plain text (one ping/person/digest)
    expect(text).toBe('<@111111111111111111> opened it. Ben reviewed it. Ben merged it.');
    expect(mentionedIds).toEqual(['111111111111111111']);
  });

  it('longest-match wins: "James A" is tagged as James A, a bare "James" as James', () => {
    const roster = [r('James', '111111111111111111'), r('James A', '222222222222222222')];
    const { text, mentionedIds } = applyMentions('James A owns infra; James owns web.', roster);
    expect(text).toBe('<@222222222222222222> owns infra; <@111111111111111111> owns web.');
    expect(new Set(mentionedIds)).toEqual(new Set(['111111111111111111', '222222222222222222']));
  });

  it('respects word boundaries — does NOT match a name embedded in a larger word', () => {
    const { text, mentionedIds } = applyMentions('We enhanced the Hannah dashboard.', [r('Han', '111111111111111111')]);
    expect(text).toBe('We enhanced the Hannah dashboard.');
    expect(mentionedIds).toEqual([]);
  });

  it('tags inside **bold** and at a "Name:" line start (the digest\'s actual forms)', () => {
    const roster = [r('Ben', '111111111111111111'), r('Ada', '222222222222222222')];
    const input = '**Ben** → fix the bug\nAda: status on the migration?';
    const { text } = applyMentions(input, roster);
    expect(text).toBe('**<@111111111111111111>** → fix the bug\n<@222222222222222222>: status on the migration?');
  });

  it('handles a punctuated name ("J.R.") that \\b would have mishandled', () => {
    const { text, mentionedIds } = applyMentions('J.R. is on call.', [r('J.R.', '111111111111111111')]);
    expect(text).toBe('<@111111111111111111> is on call.');
    expect(mentionedIds).toEqual(['111111111111111111']);
  });

  it('handles a non-ASCII / diacritic name', () => {
    const { text, mentionedIds } = applyMentions('José pushed the release.', [r('José', '111111111111111111')]);
    expect(text).toBe('<@111111111111111111> pushed the release.');
    expect(mentionedIds).toEqual(['111111111111111111']);
  });

  it('does NOT match a non-ASCII name embedded in a larger word (Unicode boundary)', () => {
    // The whole point of Unicode-aware boundaries: "José" must not match inside "xJoséy".
    const { text, mentionedIds } = applyMentions('Discuss xJoséy later.', [r('José', '111111111111111111')]);
    expect(text).toBe('Discuss xJoséy later.');
    expect(mentionedIds).toEqual([]);
  });

  it('does not double-count a person who has two roster aliases (one ping per id)', () => {
    const roster = [r('Ben', '111111111111111111'), r('Benjamin', '111111111111111111')];
    const { text, mentionedIds } = applyMentions('Benjamin and Ben are the same person.', roster);
    // "Benjamin" (longest) is tagged; the id is already used, so "Ben" stays plain.
    expect(text).toBe('<@111111111111111111> and Ben are the same person.');
    expect(mentionedIds).toEqual(['111111111111111111']);
  });

  it('defangs a <@id> the model copied from a source message (so it cannot ping)', () => {
    // A raw mention echoed by the model must be neutralized; only our inserted
    // tokens may survive, or the per-chunk allow-list would ping it unintentionally.
    const { text, mentionedIds } = applyMentions('Quoted: "<@999999999999999999> please review"', []);
    expect(text).toBe('Quoted: "@999999999999999999 please review"');
    expect(mentionedIds).toEqual([]);
  });

  it('defangs role <@&id> and channel <#id> mentions too', () => {
    const { text } = applyMentions('see <@&123456789012345678> in <#987654321098765432>', []);
    expect(text).toBe('see @123456789012345678 in #987654321098765432');
  });

  it('defangs the nickname <@!id> mention variant', () => {
    const { text } = applyMentions('ping <@!123456789012345678> now', []);
    expect(text).toBe('ping @123456789012345678 now');
  });

  it('fully defangs a DOUBLE-wrapped mention — a single pass would re-form a live <@id>', () => {
    // `<<@id>>`: one pass rewrites the INNER token, leaving the outer brackets to
    // re-form a live `<@id>`. Defang must re-scan until stable so nothing the model
    // copied can ping. Same class for channels: `<<#id>>`.
    const { text, mentionedIds } = applyMentions('Quoted <<@999999999999999999>> and <<#876543210987654321>>.', []);
    expect(text).toBe('Quoted @999999999999999999 and #876543210987654321.');
    expect(mentionedIds).toEqual([]);
  });

  it('a double-wrapped copy of a ROSTERED id never produces a second live ping token', () => {
    // The real hazard: if the re-formed token is a rostered id, the per-chunk
    // allow-list would ping that teammate at the model-copied spot too — breaking
    // both the defang guarantee and one-ping-per-person.
    const { text, mentionedIds } = applyMentions(
      'Ada shipped it. Someone typed <<@222222222222222222>> earlier.',
      [r('Ada', '222222222222222222')],
    );
    expect(text).toBe('<@222222222222222222> shipped it. Someone typed @222222222222222222 earlier.');
    expect(mentionedIds).toEqual(['222222222222222222']);
  });

  it('empty roster leaves prose unchanged (defang aside) and tags nobody', () => {
    const { text, mentionedIds } = applyMentions('Nothing to tag here.', []);
    expect(text).toBe('Nothing to tag here.');
    expect(mentionedIds).toEqual([]);
  });

  it('escapes regex metacharacters in a name (no accidental wildcard match)', () => {
    // "A+B" must match literally, not as a regex. A name with regex metachars
    // that was NOT escaped could match unrelated text.
    const { text, mentionedIds } = applyMentions('Team A+B owns this. Team AAB does not.', [r('A+B', '111111111111111111')]);
    expect(text).toBe('Team <@111111111111111111> owns this. Team AAB does not.');
    expect(mentionedIds).toEqual(['111111111111111111']);
  });
});
