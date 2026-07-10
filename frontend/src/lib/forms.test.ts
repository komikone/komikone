import { describe, expect, it } from 'vitest';
import { DAY_KEYS, dayLabel, type Participant } from './api';
import { selectedDays } from '../dashboard/participantDays';

function emptyParticipant(overrides: Partial<Participant> = {}): Participant {
  return {
    id: 1,
    event_id: 1,
    first_name: 'Tony',
    last_name: 'N',
    member_id: 'ABC',
    badge_type: 'ADULT',
    return_eligible: false,
    notes: '',
    req_preview: false,
    req_thu: false,
    req_fri: false,
    req_sat: false,
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
    clerk_user_id: 'user_1',
    registered_by_clerk_user_id: 'user_1',
    group_id: 1,
    group_name: 'Tony',
    group_color: '#3b82f6',
    claim_active: false,
    purchase_total: 0,
    gaps: [],
    all_purchased: false,
    any_purchased: false,
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

describe('DAY_KEYS / dayLabel', () => {
  it('covers all five badge days', () => {
    expect(DAY_KEYS).toEqual(['preview', 'thu', 'fri', 'sat', 'sun']);
  });

  it('labels days for UI chips', () => {
    expect(dayLabel('preview')).toMatch(/preview/i);
    expect(dayLabel('thu')).toMatch(/thu/i);
  });
});

describe('selectedDays', () => {
  it('reads req_* flags for registration display', () => {
    const p = emptyParticipant({ req_thu: true, req_sat: true });
    expect(selectedDays(p, 'req')).toEqual(['thu', 'sat']);
  });

  it('reads pur_* flags for purchase/payment display', () => {
    const p = emptyParticipant({
      req_thu: true, req_fri: true,
      pur_thu: true,
    });
    expect(selectedDays(p, 'pur')).toEqual(['thu']);
  });

  it('treats 0/1-like falsy correctly (boolean false)', () => {
    const p = emptyParticipant({ req_preview: false, req_thu: false });
    expect(selectedDays(p, 'req')).toEqual([]);
  });
});

describe('days form payload shape', () => {
  it('builds full req_* payload from checkbox state (no omitted keys)', () => {
    const days: Record<string, boolean> = Object.fromEntries(
      DAY_KEYS.map((d) => [`req_${d}`, d === 'fri' || d === 'sat']),
    );
    expect(days).toEqual({
      req_preview: false,
      req_thu: false,
      req_fri: true,
      req_sat: true,
      req_sun: false,
    });
    // Critical: every key present so backend doesn't leave stale days
    for (const d of DAY_KEYS) {
      expect(days).toHaveProperty(`req_${d}`);
    }
  });
});

describe('self participant lookup', () => {
  it('matches by clerk_user_id first, then member_id (case-insensitive)', () => {
    const participants = [
      emptyParticipant({ id: 1, clerk_user_id: null, member_id: 'abc123' }),
      emptyParticipant({ id: 2, clerk_user_id: 'user_me', member_id: 'OTHER' }),
    ];
    const member = { clerk_user_id: 'user_me', member_id: 'ABC123' };

    const byClerk = participants.find((p) => p.clerk_user_id === member.clerk_user_id);
    expect(byClerk?.id).toBe(2);

    // Prefer clerk over member_id when both could match different rows
    const byEither =
      participants.find((p) => p.clerk_user_id === member.clerk_user_id)
      ?? participants.find(
        (p) => !!(member.member_id && p.member_id && p.member_id.toUpperCase() === member.member_id.toUpperCase()),
      );
    expect(byEither?.id).toBe(2);

    const orphanOnly = [
      emptyParticipant({ id: 9, clerk_user_id: null, member_id: 'abc123' }),
    ];
    const matched =
      orphanOnly.find((p) => p.clerk_user_id === member.clerk_user_id)
      ?? orphanOnly.find(
        (p) => !!(member.member_id && p.member_id && p.member_id.toUpperCase() === member.member_id.toUpperCase()),
      );
    expect(matched?.id).toBe(9);
  });
});
