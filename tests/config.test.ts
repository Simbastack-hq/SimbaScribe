import { describe, it, expect } from 'vitest';
import { parseChannelIds } from '../src/config.js';

describe('parseChannelIds', () => {
  it('parses a single 18-digit snowflake', () => {
    const ids = parseChannelIds('123456789012345678');
    expect(ids.size).toBe(1);
    expect(ids.has('123456789012345678')).toBe(true);
  });

  it('parses multiple comma-separated snowflakes', () => {
    const ids = parseChannelIds('111111111111111111,222222222222222222,333333333333333333');
    expect(ids.size).toBe(3);
    expect(ids.has('111111111111111111')).toBe(true);
    expect(ids.has('222222222222222222')).toBe(true);
    expect(ids.has('333333333333333333')).toBe(true);
  });

  it('trims whitespace around commas', () => {
    const ids = parseChannelIds(' 111111111111111111 , 222222222222222222  ,  333333333333333333 ');
    expect(ids.size).toBe(3);
  });

  it('deduplicates identical entries', () => {
    const ids = parseChannelIds('111111111111111111,111111111111111111,222222222222222222');
    expect(ids.size).toBe(2);
  });

  it('throws on empty input', () => {
    expect(() => parseChannelIds('')).toThrow(/must not be empty/);
  });

  it('throws on whitespace-only input', () => {
    expect(() => parseChannelIds('   ')).toThrow(/must not be empty/);
  });

  it('throws on a comma-only input (no actual values)', () => {
    expect(() => parseChannelIds(',,,')).toThrow();
  });

  it('throws on a non-numeric value', () => {
    expect(() => parseChannelIds('abc')).toThrow(/snowflake/);
  });

  it('throws when one of several entries is malformed', () => {
    expect(() => parseChannelIds('111111111111111111,abc,222222222222222222')).toThrow(/snowflake/);
  });

  it('throws on a too-short snowflake (16 digits)', () => {
    expect(() => parseChannelIds('1234567890123456')).toThrow(/snowflake/);
  });

  it('throws on a too-long snowflake (21 digits)', () => {
    expect(() => parseChannelIds('123456789012345678901')).toThrow(/snowflake/);
  });

  it('accepts the 17-digit lower bound', () => {
    expect(() => parseChannelIds('12345678901234567')).not.toThrow();
  });

  it('accepts the 20-digit upper bound', () => {
    expect(() => parseChannelIds('12345678901234567890')).not.toThrow();
  });
});
