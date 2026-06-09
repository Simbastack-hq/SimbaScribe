import { describe, it, expect } from 'vitest';
import { channelMatchesWhitelist } from '../src/listener/whitelist.js';

const WL = new Set(['100000000000000001', '100000000000000002']);

describe('channelMatchesWhitelist', () => {
  it('matches a directly-whitelisted channel', () => {
    expect(
      channelMatchesWhitelist({ id: '100000000000000001', isThread: false, parentId: null }, WL),
    ).toBe(true);
  });

  it('does not match a non-whitelisted channel', () => {
    expect(
      channelMatchesWhitelist({ id: '999999999999999999', isThread: false, parentId: null }, WL),
    ).toBe(false);
  });

  it('matches a thread whose parent is whitelisted', () => {
    expect(
      channelMatchesWhitelist(
        { id: '200000000000000000', isThread: true, parentId: '100000000000000001' },
        WL,
      ),
    ).toBe(true);
  });

  it('does not match a thread whose parent is NOT whitelisted', () => {
    expect(
      channelMatchesWhitelist(
        { id: '200000000000000000', isThread: true, parentId: '999999999999999999' },
        WL,
      ),
    ).toBe(false);
  });

  it('does not match a thread with a null parent', () => {
    expect(
      channelMatchesWhitelist({ id: '200000000000000000', isThread: true, parentId: null }, WL),
    ).toBe(false);
  });

  it('still matches a thread that is itself directly whitelisted (parent irrelevant)', () => {
    expect(
      channelMatchesWhitelist(
        { id: '100000000000000002', isThread: true, parentId: '999999999999999999' },
        WL,
      ),
    ).toBe(true);
  });
});
