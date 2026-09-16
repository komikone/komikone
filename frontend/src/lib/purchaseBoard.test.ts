import { describe, expect, it } from 'vitest';
import type { EventDetail, Participant } from './api';
import {
  CLAIM_TIMEOUT_MS,
  applySimPatches,
  claimRemainingMs,
  computeAllPurchased,
  formatClaimCountdown,
  holdsClaimSlot,
  isClaimLive,
  isClaimable,
  parseClaimTimestamp,
  purchaseBlockers,
  purchasedByMe,
  setSimPatch,
} from './purchaseBoard';

const event: EventDetail = {
  id: 1,
  year: 2027,
  year_id: 1,
  name: 'SDCC 2027 Return Reg',
  reg_type: 'return',
  status: 'purchasing',
  price_preview_adult: 5000,
  price_thu_adult: 6000,
  price_fri_adult: 7000,
  price_sat_adult: 8000,
  price_sun_adult: 4000,
  price_preview_junior: 2500,
  price_thu_junior: 3000,
  price_fri_junior: 3500,
  price_sat_junior: 4000,
  price_sun_junior: 2000,
  created_at: '',
  updated_at: '',
} as EventDetail;

function participant(over: Partial<Participant> = {}): Participant {
  return {
    id: 1,
    event_id: 1,
    first_name: 'Avery',
    last_name: 'Smith',
    member_id: 'AVERY1',
    badge_type: 'ADULT',
    return_eligible: true,
    notes: '',
    req_preview: false,
    req_thu: false,
    req_fri: false,
    req_sat: true,
    req_sun: false,
    sort_order: 0,
    purchasing_coordinator: '',
    purchasing_claimed_by: '',
    purchasing_claimed_at: null,
    pur_preview: false,
    pur_thu: false,
    pur_fri: false,
    pur_sat: false,
    pur_sun: false,
    who_purchased: '',
    paid: false,
    group_id: null,
    group_name: null,
    group_color: null,
    group_owner_clerk_user_id: null,
    clerk_user_id: null,
    registered_by_clerk_user_id: null,
    claim_active: false,
    purchase_total: 0,
    gaps: [],
    all_purchased: false,
    any_purchased: false,
    created_at: '',
    updated_at: '',
    ...over,
  };
}

describe('claim timing', () => {
  it('treats bare D1 timestamps as UTC', () => {
    expect(parseClaimTimestamp('2026-10-17 16:00:00')).toBe(Date.parse('2026-10-17T16:00:00Z'));
    expect(parseClaimTimestamp('2026-10-17T16:00:00Z')).toBe(Date.parse('2026-10-17T16:00:00Z'));
  });

  it('counts down from the full timeout and floors at zero', () => {
    const claimedAt = '2026-10-17 16:00:00';
    const start = Date.parse('2026-10-17T16:00:00Z');
    expect(claimRemainingMs(claimedAt, start)).toBe(CLAIM_TIMEOUT_MS);
    expect(claimRemainingMs(claimedAt, start + CLAIM_TIMEOUT_MS + 5000)).toBe(0);
    expect(claimRemainingMs(null, start)).toBe(0);
  });

  it('formats a m:ss countdown', () => {
    expect(formatClaimCountdown(CLAIM_TIMEOUT_MS)).toBe('10:00');
    expect(formatClaimCountdown(61_000)).toBe('1:01');
    expect(formatClaimCountdown(0)).toBe('0:00');
  });

  it('expires a claim once the window passes', () => {
    const start = Date.parse('2026-10-17T16:00:00Z');
    const p = participant({ purchasing_claimed_by: 'Tony Nguyen', purchasing_claimed_at: '2026-10-17 16:00:00' });
    expect(isClaimLive(p, start)).toBe(true);
    expect(isClaimLive(p, start + CLAIM_TIMEOUT_MS + 1)).toBe(false);
  });
});

describe('claim slots', () => {
  const claimedByTony = { purchasing_claimed_by: 'Tony Nguyen', purchasing_claimed_at: '2026-10-17 16:00:00' };
  const now = Date.parse('2026-10-17T16:01:00Z');

  it('holds a slot while days are still outstanding', () => {
    const p = participant({ ...claimedByTony });
    expect(holdsClaimSlot(p, 'Tony Nguyen', now)).toBe(true);
  });

  it('frees the slot once every requested day is purchased', () => {
    const p = participant({ ...claimedByTony, pur_sat: true, all_purchased: true });
    expect(holdsClaimSlot(p, 'Tony Nguyen', now)).toBe(false);
  });

  it('ignores claims held by other people', () => {
    const p = participant({ ...claimedByTony });
    expect(holdsClaimSlot(p, 'Henry Garcia', now)).toBe(false);
  });

  it('still recognizes the buyer on record after the claim is released', () => {
    const p = participant({ pur_sat: true, all_purchased: true, who_purchased: 'tony nguyen' });
    expect(purchasedByMe(p, 'Tony Nguyen')).toBe(true);
  });
});

describe('computeAllPurchased', () => {
  it('is false when nobody requested days', () => {
    expect(computeAllPurchased(participant({ req_sat: false }))).toBe(false);
  });

  it('is true only when every requested day is bought', () => {
    expect(computeAllPurchased(participant({ req_sat: true, req_sun: true, pur_sat: true }))).toBe(false);
    expect(computeAllPurchased(participant({ req_sat: true, req_sun: true, pur_sat: true, pur_sun: true }))).toBe(true);
  });
});

describe('purchase blockers', () => {
  it('reports no blockers for a ready return-eligible member', () => {
    expect(purchaseBlockers(participant(), event)).toEqual([]);
    expect(isClaimable(participant(), event)).toBe(true);
  });

  it('flags missing days and Member ID', () => {
    const david = participant({ req_sat: false, member_id: '' });
    expect(purchaseBlockers(david, event)).toEqual(['days', 'member_id']);
    expect(isClaimable(david, event)).toBe(false);
  });

  it('flags return ineligibility only on return events', () => {
    const karen = participant({ return_eligible: false });
    expect(purchaseBlockers(karen, event)).toEqual(['return_eligible']);
    expect(purchaseBlockers(karen, { ...event, reg_type: 'open' })).toEqual([]);
  });

  it('is not claimable once already done', () => {
    expect(isClaimable(participant({ pur_sat: true, all_purchased: true }), event)).toBe(false);
  });
});

describe('simulation sandbox', () => {
  const now = Date.parse('2026-10-17T16:00:30Z');

  it('leaves the roster untouched and re-derives patched rows', () => {
    const roster = [participant({ id: 1 }), participant({ id: 2, first_name: 'Henry' })];
    const patches = setSimPatch({}, 1, {
      purchasing_claimed_by: 'Tony Nguyen',
      purchasing_claimed_at: '2026-10-17 16:00:00',
      pur_sat: true,
      who_purchased: 'Tony Nguyen',
    });

    const view = applySimPatches(roster, patches, event, now);

    expect(view[0].all_purchased).toBe(true);
    expect(view[0].gaps).toEqual([]);
    expect(view[0].purchase_total).toBe(8000);
    expect(view[0].claim_active).toBe(true);
    // Untouched rows and the underlying roster objects are unchanged.
    expect(view[1]).toBe(roster[1]);
    expect(roster[0].pur_sat).toBe(false);
    expect(roster[0].all_purchased).toBe(false);
  });

  it('returns the original list when there is nothing to practice', () => {
    const roster = [participant()];
    expect(applySimPatches(roster, {}, event, now)).toBe(roster);
  });

  it('frees the practice slot when the practice purchase completes', () => {
    const roster = [participant({ id: 1 })];
    const patches = setSimPatch({}, 1, {
      purchasing_claimed_by: 'Tony Nguyen',
      purchasing_claimed_at: '2026-10-17 16:00:00',
      pur_sat: true,
    });
    const view = applySimPatches(roster, patches, event, now);
    expect(holdsClaimSlot(view[0], 'Tony Nguyen', now)).toBe(false);
  });
});
