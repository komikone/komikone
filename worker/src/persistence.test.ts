import { describe, expect, it } from 'vitest';
import {
  assertPurchasingOpen,
  assertRegistrationOpen,
  bool01,
  daysToSql,
  groupDisplayName,
  mapGroupIdForCopy,
  normalizeDays,
  resolveSelfParticipant,
} from '../src/persistence';

describe('normalizeDays / daysToSql', () => {
  it('coerces truthy values to booleans and SQL 0/1', () => {
    const days = normalizeDays({
      req_preview: true,
      req_thu: 1,
      req_fri: 'yes',
      req_sat: false,
      req_sun: 0,
    });
    expect(days).toEqual({
      req_preview: true,
      req_thu: true,
      req_fri: true,
      req_sat: false,
      req_sun: false,
    });
    expect(daysToSql(days)).toEqual([1, 1, 1, 0, 0]);
  });

  it('defaults missing day keys to false (no silent wipe of omitted keys at helper layer)', () => {
    expect(normalizeDays({})).toEqual({
      req_preview: false,
      req_thu: false,
      req_fri: false,
      req_sat: false,
      req_sun: false,
    });
  });
});

describe('bool01', () => {
  it('maps truthy/falsy to 1/0', () => {
    expect(bool01(true)).toBe(1);
    expect(bool01(false)).toBe(0);
    expect(bool01(1)).toBe(1);
    expect(bool01(0)).toBe(0);
    expect(bool01(null)).toBe(0);
  });
});

describe('resolveSelfParticipant', () => {
  const rows = [
    { id: 1, clerk_user_id: null, member_id: 'ABC', group_id: null },
    { id: 2, clerk_user_id: 'user_1', member_id: 'XYZ', group_id: 10 },
    { id: 3, clerk_user_id: null, member_id: 'DEF', group_id: 10 },
    { id: 4, clerk_user_id: 'user_1', member_id: 'OLD', group_id: null },
  ];

  it('prefers group+clerk match', () => {
    expect(resolveSelfParticipant(rows, { clerkUserId: 'user_1', groupId: 10 })?.id).toBe(2);
  });

  it('falls back to group+member_id', () => {
    expect(resolveSelfParticipant(rows, {
      clerkUserId: 'user_new',
      memberId: 'def',
      groupId: 10,
    })?.id).toBe(3);
  });

  it('falls back to orphan clerk row (register without group_id)', () => {
    expect(resolveSelfParticipant(rows, { clerkUserId: 'user_1', groupId: 99 })?.id).toBe(2);
  });

  it('falls back to orphan member_id when no clerk match', () => {
    expect(resolveSelfParticipant(rows, {
      clerkUserId: 'nobody',
      memberId: 'abc',
    })?.id).toBe(1);
  });

  it('returns null when nothing matches', () => {
    expect(resolveSelfParticipant(rows, { clerkUserId: 'nobody', memberId: 'nope' })).toBeNull();
  });

  it('is case-insensitive on member_id', () => {
    expect(resolveSelfParticipant(rows, {
      clerkUserId: 'nobody',
      memberId: 'AbC',
    })?.id).toBe(1);
  });
});

describe('mapGroupIdForCopy', () => {
  const source = [
    { id: 1, name: 'Tony', owner_clerk_user_id: 'user_a' },
    { id: 2, name: 'Orphans', owner_clerk_user_id: null },
  ];
  const target = [
    { id: 50, name: 'Tony', owner_clerk_user_id: 'user_a' },
    { id: 51, name: 'Other', owner_clerk_user_id: 'user_b' },
  ];

  it('maps by owner_clerk_user_id', () => {
    expect(mapGroupIdForCopy(1, source, target)).toBe(50);
  });

  it('falls back to name match', () => {
    expect(mapGroupIdForCopy(2, source, [
      { id: 99, name: 'orphans', owner_clerk_user_id: 'x' },
    ])).toBe(99);
  });

  it('returns null when source group missing or unmapped', () => {
    expect(mapGroupIdForCopy(null, source, target)).toBeNull();
    expect(mapGroupIdForCopy(999, source, target)).toBeNull();
    expect(mapGroupIdForCopy(2, source, target)).toBeNull();
  });
});

describe('groupDisplayName', () => {
  it('joins names and falls back', () => {
    expect(groupDisplayName({ first_name: 'Tony', last_name: 'N' })).toBe('Tony N');
    expect(groupDisplayName({})).toBe('My Group');
  });
});

describe('status gates', () => {
  it('registration gate', () => {
    expect(assertRegistrationOpen('registration')).toBeNull();
    expect(assertRegistrationOpen('purchasing')).toMatch(/not open/i);
  });

  it('purchasing gate', () => {
    expect(assertPurchasingOpen('purchasing')).toBeNull();
    expect(assertPurchasingOpen('registration')).toMatch(/purchasing/i);
  });
});

/**
 * Regression scenarios that previously caused silent data loss.
 * These encode the expected resolution order for save paths.
 */
describe('purchase-day regression scenarios', () => {
  it('orphan register row is reclaimed into owned group on days save', () => {
    const orphan = { id: 7, clerk_user_id: 'user_x', member_id: 'M1', group_id: null };
    const family = { id: 8, clerk_user_id: null, member_id: 'KID', group_id: 3 };
    const resolved = resolveSelfParticipant([orphan, family], {
      clerkUserId: 'user_x',
      memberId: 'M1',
      groupId: 3,
    });
    expect(resolved?.id).toBe(7);
  });

  it('does not prefer a different user\'s clerk row when matching member_id in group', () => {
    const rows = [
      { id: 1, clerk_user_id: 'other', member_id: 'SHARED', group_id: 1 },
      { id: 2, clerk_user_id: 'me', member_id: 'MINE', group_id: 1 },
    ];
    expect(resolveSelfParticipant(rows, {
      clerkUserId: 'me',
      memberId: 'SHARED',
      groupId: 1,
    })?.id).toBe(2);
  });

  it('copy remaps group so open-reg board keeps family together', () => {
    const mapped = mapGroupIdForCopy(
      10,
      [{ id: 10, name: 'Crew', owner_clerk_user_id: 'owner1' }],
      [{ id: 20, name: 'Crew', owner_clerk_user_id: 'owner1' }],
    );
    expect(mapped).toBe(20);
  });
});
