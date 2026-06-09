import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listDocs, searchKb, getDoc, readKb, clampLimit } from '../src/mcp-server/kb.js';

let root: string;
let outside: string; // a separate, cleaned-up dir for symlink-escape targets

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ss-kb-'));
  outside = mkdtempSync(join(tmpdir(), 'ss-kb-out-'));
  writeFileSync(
    join(root, 'runbook.md'),
    '# Deploy runbook\n\n## Rolling back\n\nRun `make rollback` to re-point the load balancer.\n\n## Who to ping\n\nInfra goes to Diego.\n',
  );
  mkdirSync(join(root, 'policies'));
  writeFileSync(join(root, 'policies', 'security.md'), '# Security policy\n\nSecrets live in the environment, never in the repo.\n');
  writeFileSync(join(root, 'notes.txt'), 'not markdown — ignored');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('listDocs', () => {
  it('finds .md files recursively (ignoring non-md), titled by the first H1', () => {
    const docs = listDocs(root);
    expect(docs.map((d) => d.file)).toEqual(['policies/security.md', 'runbook.md']);
    expect(docs.find((d) => d.file === 'runbook.md')!.title).toBe('Deploy runbook');
    expect(docs.find((d) => d.file === 'policies/security.md')!.title).toBe('Security policy');
  });
});

describe('searchKb', () => {
  it('matches section body, case-insensitively, and cites file + heading', () => {
    const hits = searchKb(root, 'ROLLBACK', 20);
    const hit = hits.find((h) => h.heading === 'Rolling back')!;
    expect(hit.file).toBe('runbook.md');
    expect(hit.snippet.toLowerCase()).toContain('make rollback');
  });

  it('matches on a heading too', () => {
    expect(searchKb(root, 'who to ping', 20).some((h) => h.heading === 'Who to ping')).toBe(true);
  });

  it('searches across files (subdirs included)', () => {
    expect(searchKb(root, 'secrets', 20).some((h) => h.file === 'policies/security.md')).toBe(true);
  });

  it('returns nothing for a miss / empty query, and respects the limit', () => {
    expect(searchKb(root, 'nonexistent-zzz', 20)).toEqual([]);
    expect(searchKb(root, '', 20)).toEqual([]);
    expect(searchKb(root, 'e', 1)).toHaveLength(1); // common letter, capped at 1
  });
});

describe('getDoc — read + path-traversal guard (the injection hinge)', () => {
  it('returns a valid in-root .md document', () => {
    const doc = getDoc(root, 'runbook.md')!;
    expect(doc.file).toBe('runbook.md');
    expect(doc.content).toContain('Deploy runbook');
  });

  it('reads a doc in a subdirectory', () => {
    expect(getDoc(root, 'policies/security.md')!.content).toContain('Security policy');
  });

  it('REFUSES a path that escapes the KB root', () => {
    expect(getDoc(root, '../../../../etc/passwd')).toBeNull();
    expect(getDoc(root, '../secret.md')).toBeNull();
  });

  it('REFUSES a non-.md file even inside the root', () => {
    expect(getDoc(root, 'notes.txt')).toBeNull();
  });

  it('returns null for a missing file', () => {
    expect(getDoc(root, 'does-not-exist.md')).toBeNull();
  });
});

describe('readKb — graceful degradation', () => {
  it('errors clearly when the path is unset', () => {
    const r = readKb(undefined, () => 'x');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/SIMBASCRIBE_KB_PATH is not set/);
  });

  it('errors clearly when the path is not a directory', () => {
    const r = readKb('/no/such/kb/dir', () => 'x');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not a directory/);
  });

  it('runs fn against a valid root', () => {
    const r = readKb(root, (p) => listDocs(p).length);
    expect(r).toEqual({ ok: true, value: 2 });
  });
});

describe('clampLimit', () => {
  it('defaults + clamps to [1,100]', () => {
    expect(clampLimit(undefined)).toBe(20);
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(999)).toBe(100);
    expect(clampLimit(15)).toBe(15);
  });
});

describe('getDoc — symlink escape (Codex high)', () => {
  it('REFUSES a symlink whose target is outside the KB root, even if named *.md', () => {
    const secret = join(outside, 'secret.txt');
    writeFileSync(secret, 'TOP SECRET');
    symlinkSync(secret, join(root, 'leak.md')); // planted symlink inside the KB
    expect(getDoc(root, 'leak.md')).toBeNull(); // not followed
    // and the unique outside content must not leak via search (the symlink is skipped)
    expect(searchKb(root, 'TOP SECRET', 20)).toEqual([]);
  });

  it('does not follow a symlinked directory pointing outside the root', () => {
    writeFileSync(join(outside, 'leak.md'), '# Leaked\n\noutside content');
    symlinkSync(outside, join(root, 'linked'));
    expect(listDocs(root).some((d) => d.file.includes('linked'))).toBe(false);
    expect(searchKb(root, 'outside content', 20)).toEqual([]);
  });
});

describe('resource caps (Codex medium)', () => {
  it('skips an oversized doc (search/get) instead of reading it into memory', () => {
    const big = '# Big\n\n' + 'x'.repeat(1_200_000) + ' needle';
    writeFileSync(join(root, 'big.md'), big);
    expect(searchKb(root, 'needle', 20)).toEqual([]); // oversized → skipped, not scanned
    expect(getDoc(root, 'big.md')).toBeNull();
    // listDocs still works (title falls back to filename, no crash)
    expect(listDocs(root).some((d) => d.file === 'big.md')).toBe(true);
  });
});
