import { describe, expect, it } from 'vitest';
import {
  CLAIM_TIMEOUT_MINUTES,
  computeAllPurchased,
  isClaimExpired,
  parseClaimTimestamp,
} from '../src/db';

type DayFlags = Parameters<typeof computeAllPurchased>[0];

/** D1 stores day flags as 0/1. */
function days(over: Partial<DayFlags> = {}): DayFlags {
  return {
    req_preview: 0, req_thu: 0, req_fri: 0, req_sat: 0, req_sun: 0,
    pur_preview: 0, pur_thu: 0, pur_fri: 0, pur_sat: 0, pur_sun: 0,
    ...over,
  } as DayFlags;
}

describe('computeAllPurchased', () => {
  it('is false when no days were requested (nothing to finish)', () => {
    expect(computeAllPurchased(days())).toBe(false);
    expect(computeAllPurchased(days({ pur_sat: 1 }))).toBe(false);
  });

  it('is false while any requested day is still outstanding', () => {
    expect(computeAllPurchased(days({ req_sat: 1, req_sun: 1, pur_sat: 1 }))).toBe(false);
  });

  it('is true once every requested day is purchased', () => {
    expect(computeAllPurchased(days({ req_sat: 1, pur_sat: 1 }))).toBe(true);
    expect(computeAllPurchased(days({
      req_preview: 1, req_thu: 1, req_fri: 1, req_sat: 1, req_sun: 1,
      pur_preview: 1, pur_thu: 1, pur_fri: 1, pur_sat: 1, pur_sun: 1,
    }))).toBe(true);
  });

  it('ignores extra purchased days that were never requested', () => {
    expect(computeAllPurchased(days({ req_sat: 1, pur_sat: 1, pur_sun: 1 }))).toBe(true);
  });
});

describe('claim expiry', () => {
  it('parses D1 timestamps without a timezone suffix as UTC', () => {
    expect(parseClaimTimestamp('2026-10-17 16:00:00')).toBe(Date.parse('2026-10-17T16:00:00Z'));
    expect(parseClaimTimestamp('not a date')).toBeNull();
  });

  it('treats a missing or unparseable timestamp as expired', () => {
    expect(isClaimExpired(null)).toBe(true);
    expect(isClaimExpired('not a date')).toBe(true);
  });

  it('expires only after the timeout window', () => {
    const justNow = new Date(Date.now() - 1000).toISOString();
    const stale = new Date(Date.now() - (CLAIM_TIMEOUT_MINUTES * 60 * 1000 + 1000)).toISOString();
    expect(isClaimExpired(justNow)).toBe(false);
    expect(isClaimExpired(stale)).toBe(true);
  });
});
