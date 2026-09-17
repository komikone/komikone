/**
 * Route-level tests against a real SQLite database and real JWT verification.
 * These cover the purchase-day behaviour that pure unit tests can't reach:
 * the claim phase gate, the 3-claim ceiling, auto-release on Done, and the
 * return-eligibility filter the Live Board depends on.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createHarness,
  getParticipant,
  insertEvent,
  insertParticipant,
  type TestHarness,
} from './harness';

const TONY = 'user_tony';
const HENRY = 'user_henry';

let h: TestHarness;

beforeEach(async () => {
  h = await createHarness();
});

afterEach(() => {
  h.close();
});

/** A signed-in buyer needs a participant row so the worker can resolve their name. */
function seedBuyer(eventId: number, clerkUserId = TONY, first = 'Tony', last = 'Nguyen') {
  return insertParticipant(h.db, eventId, {
    first_name: first,
    last_name: last,
    // Member IDs are unique per event.
    member_id: `${first.toUpperCase()}01`,
    clerk_user_id: clerkUserId,
  });
}

describe('POST /participants/:pid/claim', () => {
  it('requires authentication', async () => {
    const eventId = insertEvent(h.db);
    const pid = insertParticipant(h.db, eventId);
    const res = await h.request(`/api/events/${eventId}/participants/${pid}/claim`, {
      method: 'POST',
      body: JSON.stringify({ coordinator_name: 'Tony Nguyen' }),
    });
    expect(res.status).toBe(401);
  });

  it('refuses to claim outside the purchasing phase, even with a simulation flag', async () => {
    const eventId = insertEvent(h.db, { status: 'registration' });
    const pid = insertParticipant(h.db, eventId);
    seedBuyer(eventId);

    const res = await h.request(`/api/events/${eventId}/participants/${pid}/claim`, {
      method: 'POST',
      as: TONY,
      body: JSON.stringify({ coordinator_name: 'Tony Nguyen', simulation: true }),
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: 'Not in purchasing phase' });
    expect(getParticipant(h.db, pid).purchasing_claimed_by).toBe('');
  });

  it('claims an unclaimed person during purchasing', async () => {
    const eventId = insertEvent(h.db);
    const pid = insertParticipant(h.db, eventId);
    seedBuyer(eventId);

    const res = await h.request(`/api/events/${eventId}/participants/${pid}/claim`, {
      method: 'POST',
      as: TONY,
      body: JSON.stringify({ coordinator_name: 'Tony Nguyen' }),
    });

    expect(res.status).toBe(200);
    const row = getParticipant(h.db, pid);
    expect(row.purchasing_claimed_by).toBe('Tony Nguyen');
    expect(row.purchasing_claimed_at).toBeTruthy();
  });

  it('rejects a claim already held by someone else', async () => {
    const eventId = insertEvent(h.db);
    const pid = insertParticipant(h.db, eventId, {
      purchasing_claimed_by: 'Henry Garcia',
      purchasing_claimed_at: new Date().toISOString(),
    });
    seedBuyer(eventId);

    const res = await h.request(`/api/events/${eventId}/participants/${pid}/claim`, {
      method: 'POST',
      as: TONY,
      body: JSON.stringify({ coordinator_name: 'Tony Nguyen' }),
    });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: 'Already claimed by Henry Garcia' });
  });

  it('stops at 3 simultaneous claims', async () => {
    const eventId = insertEvent(h.db);
    seedBuyer(eventId);
    const held = new Date().toISOString();
    for (let i = 0; i < 3; i += 1) {
      insertParticipant(h.db, eventId, {
        first_name: `Held${i}`,
        purchasing_claimed_by: 'Tony Nguyen',
        purchasing_claimed_at: held,
      });
    }
    const fourth = insertParticipant(h.db, eventId, { first_name: 'Fourth' });

    const res = await h.request(`/api/events/${eventId}/participants/${fourth}/claim`, {
      method: 'POST',
      as: TONY,
      body: JSON.stringify({ coordinator_name: 'Tony Nguyen' }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining('only claim 3 people at a time'),
    });
  });

  it('does not count a finished person toward the limit', async () => {
    const eventId = insertEvent(h.db);
    seedBuyer(eventId);
    const held = new Date().toISOString();
    // Two still in progress, one fully purchased.
    for (let i = 0; i < 2; i += 1) {
      insertParticipant(h.db, eventId, {
        first_name: `Held${i}`,
        purchasing_claimed_by: 'Tony Nguyen',
        purchasing_claimed_at: held,
      });
    }
    insertParticipant(h.db, eventId, {
      first_name: 'Done',
      purchasing_claimed_by: 'Tony Nguyen',
      purchasing_claimed_at: held,
      req_sat: 1,
      pur_sat: 1,
    });
    const fourth = insertParticipant(h.db, eventId, { first_name: 'Fourth' });

    const res = await h.request(`/api/events/${eventId}/participants/${fourth}/claim`, {
      method: 'POST',
      as: TONY,
      body: JSON.stringify({ coordinator_name: 'Tony Nguyen' }),
    });

    expect(res.status).toBe(200);
    expect(getParticipant(h.db, fourth).purchasing_claimed_by).toBe('Tony Nguyen');
  });

  it('ignores expired claims when counting the limit', async () => {
    const eventId = insertEvent(h.db);
    seedBuyer(eventId);
    const stale = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    for (let i = 0; i < 3; i += 1) {
      insertParticipant(h.db, eventId, {
        first_name: `Stale${i}`,
        purchasing_claimed_by: 'Tony Nguyen',
        purchasing_claimed_at: stale,
      });
    }
    const fresh = insertParticipant(h.db, eventId, { first_name: 'Fresh' });

    const res = await h.request(`/api/events/${eventId}/participants/${fresh}/claim`, {
      method: 'POST',
      as: TONY,
      body: JSON.stringify({ coordinator_name: 'Tony Nguyen' }),
    });

    expect(res.status).toBe(200);
  });
});

describe('PATCH /participants/:pid/purchased', () => {
  it('requires a claim before marking purchases', async () => {
    const eventId = insertEvent(h.db);
    const pid = insertParticipant(h.db, eventId);
    seedBuyer(eventId);

    const res = await h.request(`/api/events/${eventId}/participants/${pid}/purchased`, {
      method: 'PATCH',
      as: TONY,
      body: JSON.stringify({ pur_sat: true, who_purchased: 'Tony Nguyen' }),
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      error: 'Claim this person first before marking purchases',
    });
  });

  it('auto-releases the claim once every requested day is purchased', async () => {
    const eventId = insertEvent(h.db);
    seedBuyer(eventId);
    const pid = insertParticipant(h.db, eventId, {
      req_sat: 1,
      purchasing_claimed_by: 'Tony Nguyen',
      purchasing_claimed_at: new Date().toISOString(),
    });

    const res = await h.request(`/api/events/${eventId}/participants/${pid}/purchased`, {
      method: 'PATCH',
      as: TONY,
      body: JSON.stringify({ pur_sat: true, who_purchased: 'Tony Nguyen' }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, claim_released: true });

    const row = getParticipant(h.db, pid);
    expect(row.purchasing_claimed_by).toBe('');
    expect(row.purchasing_claimed_at).toBeNull();
    // The record of who bought must survive the release.
    expect(row.who_purchased).toBe('Tony Nguyen');
    expect(row.pur_sat).toBe(1);
  });

  it('keeps the claim while requested days are still outstanding', async () => {
    const eventId = insertEvent(h.db);
    seedBuyer(eventId);
    const pid = insertParticipant(h.db, eventId, {
      req_sat: 1,
      req_sun: 1,
      purchasing_claimed_by: 'Tony Nguyen',
      purchasing_claimed_at: new Date().toISOString(),
    });

    const res = await h.request(`/api/events/${eventId}/participants/${pid}/purchased`, {
      method: 'PATCH',
      as: TONY,
      body: JSON.stringify({ pur_sat: true, who_purchased: 'Tony Nguyen' }),
    });

    await expect(res.json()).resolves.toMatchObject({ claim_released: false });
    expect(getParticipant(h.db, pid).purchasing_claimed_by).toBe('Tony Nguyen');
  });

  it('lets the buyer on record correct days after the claim auto-released', async () => {
    const eventId = insertEvent(h.db);
    seedBuyer(eventId);
    const pid = insertParticipant(h.db, eventId, {
      req_sat: 1,
      pur_sat: 1,
      who_purchased: 'Tony Nguyen',
    });

    const res = await h.request(`/api/events/${eventId}/participants/${pid}/purchased`, {
      method: 'PATCH',
      as: TONY,
      body: JSON.stringify({ pur_sat: false, who_purchased: 'Tony Nguyen' }),
    });

    expect(res.status).toBe(200);
    expect(getParticipant(h.db, pid).pur_sat).toBe(0);
  });

  it('does not let a non-buyer edit a released purchase', async () => {
    const eventId = insertEvent(h.db);
    seedBuyer(eventId);
    seedBuyer(eventId, HENRY, 'Henry', 'Garcia');
    const pid = insertParticipant(h.db, eventId, {
      req_sat: 1,
      pur_sat: 1,
      who_purchased: 'Tony Nguyen',
    });

    const res = await h.request(`/api/events/${eventId}/participants/${pid}/purchased`, {
      method: 'PATCH',
      as: HENRY,
      body: JSON.stringify({ pur_sat: false, who_purchased: 'Henry Garcia' }),
    });

    expect(res.status).toBe(403);
    expect(getParticipant(h.db, pid).pur_sat).toBe(1);
  });
});

describe('GET /participants return eligibility', () => {
  it('hides return-ineligible people from a return event by default', async () => {
    const eventId = insertEvent(h.db, { reg_type: 'return' });
    seedBuyer(eventId);
    insertParticipant(h.db, eventId, { first_name: 'Karen', last_name: 'Sosa', return_eligible: 0 });

    const res = await h.request(`/api/events/${eventId}/participants`, { as: TONY });
    const rows = await res.json() as { first_name: string }[];

    expect(res.status).toBe(200);
    expect(rows.map((r) => r.first_name)).not.toContain('Karen');
  });

  it('includes them with include_ineligible=1, which the Live Board relies on', async () => {
    const eventId = insertEvent(h.db, { reg_type: 'return' });
    seedBuyer(eventId);
    insertParticipant(h.db, eventId, { first_name: 'Karen', last_name: 'Sosa', return_eligible: 0 });

    const res = await h.request(`/api/events/${eventId}/participants?include_ineligible=1`, { as: TONY });
    const rows = await res.json() as { first_name: string; return_eligible: number }[];

    const karen = rows.find((r) => r.first_name === 'Karen');
    expect(karen).toBeDefined();
    expect(karen?.return_eligible).toBeFalsy();
  });

  it('always lists everyone on an open event', async () => {
    const eventId = insertEvent(h.db, { reg_type: 'open' });
    seedBuyer(eventId);
    insertParticipant(h.db, eventId, { first_name: 'Karen', return_eligible: 0 });

    const res = await h.request(`/api/events/${eventId}/participants`, { as: TONY });
    const rows = await res.json() as { first_name: string }[];

    expect(rows.map((r) => r.first_name)).toContain('Karen');
  });
});

describe('PATCH /participants/:pid/profile', () => {
  it('updates return eligibility so Fix setup can unblock a member', async () => {
    const eventId = insertEvent(h.db, { reg_type: 'return', status: 'registration' });
    seedBuyer(eventId);
    const karen = insertParticipant(h.db, eventId, {
      first_name: 'Karen',
      last_name: 'Sosa',
      member_id: '',
      return_eligible: 0,
      clerk_user_id: TONY,
    });

    const res = await h.request(`/api/events/${eventId}/participants/${karen}/profile`, {
      method: 'PATCH',
      as: TONY,
      body: JSON.stringify({ member_id: 'karen9', return_eligible: true }),
    });

    expect(res.status).toBe(200);
    const row = getParticipant(h.db, karen);
    expect(row.return_eligible).toBe(1);
    expect(row.member_id).toBe('KAREN9');
  });

  it('refuses edits to someone outside your group', async () => {
    const eventId = insertEvent(h.db, { status: 'registration' });
    seedBuyer(eventId);
    seedBuyer(eventId, HENRY, 'Henry', 'Garcia');
    const stranger = insertParticipant(h.db, eventId, { first_name: 'Stranger', return_eligible: 0 });

    const res = await h.request(`/api/events/${eventId}/participants/${stranger}/profile`, {
      method: 'PATCH',
      as: HENRY,
      body: JSON.stringify({ return_eligible: true }),
    });

    expect(res.status).toBe(403);
    expect(getParticipant(h.db, stranger).return_eligible).toBe(0);
  });
});
