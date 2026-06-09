import { describe, it, expect } from 'vitest';
import { parseArgs } from '../src/synth/args.js';

describe('parseArgs', () => {
  it('defaults to a live run (no dry-run, no window)', () => {
    expect(parseArgs([])).toEqual({ dryRun: false, windowStart: null, windowEnd: null });
  });

  it('parses --dry-run', () => {
    expect(parseArgs(['--dry-run']).dryRun).toBe(true);
  });

  it('window override forces dry-run', () => {
    const args = parseArgs(['--window-start', '1000', '--window-end', '2000']);
    expect(args.dryRun).toBe(true);
    expect(args.windowStart).toBe(1000);
    expect(args.windowEnd).toBe(2000);
  });

  it('throws if only one window bound is given', () => {
    expect(() => parseArgs(['--window-start', '1000'])).toThrow(/together/);
    expect(() => parseArgs(['--window-end', '2000'])).toThrow(/together/);
  });

  it('throws if window-start >= window-end', () => {
    expect(() => parseArgs(['--window-start', '2000', '--window-end', '1000'])).toThrow(/less than/);
    expect(() => parseArgs(['--window-start', '1000', '--window-end', '1000'])).toThrow(/less than/);
  });

  it('throws on a non-integer window value', () => {
    expect(() => parseArgs(['--window-start', 'abc', '--window-end', '2000'])).toThrow(/integer/);
  });

  it('throws on an unknown argument', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/Unknown argument/);
  });
});
