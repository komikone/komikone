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
  insertPlace,
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
  /** Tony's participant row plus one place in line, through Queue-It unless told otherwise. */
  function seedBuyerWithPlace(eventId: number, status = 'buying', label = 'Laptop') {
    const buyer = seedBuyer(eventId);
    return { buyer, place: insertPlace(h.db, eventId, buyer, TONY, { status, label }) };
  }

  const claim = (eventId: number, pid: number, queueId?: number, as: string | null = TONY) =>
    h.request(`/api/events/${eventId}/participants/${pid}/claim`, {
      method: 'POST',
      as: as ?? undefined,
      body: JSON.stringify({ coordinator_name: 'Tony Nguyen', queue_id: queueId }),
    });

  it('requires authentication', async () => {
    const eventId = insertEvent(h.db);
    const pid = insertParticipant(h.db, eventId);
    const res = await claim(eventId, pid, 1, null);
    expect(res.status).toBe(401);
  });

  it('refuses to claim outside the purchasing phase, even with a simulation flag', async () => {
    const eventId = insertEvent(h.db, { status: 'registration' });
    const pid = insertParticipant(h.db, eventId);
    const { place } = seedBuyerWithPlace(eventId);

    const res = await h.request(`/api/events/${eventId}/participants/${pid}/claim`, {
      method: 'POST',
      as: TONY,
      body: JSON.stringify({ coordinator_name: 'Tony Nguyen', queue_id: place, simulation: true }),
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: 'Not in purchasing phase' });
    expect(getParticipant(h.db, pid).purchasing_claimed_by).toBe('');
  });

  it('claims through a place that is through Queue-It and records the place', async () => {
    const eventId = insertEvent(h.db);
    const pid = insertParticipant(h.db, eventId);
    const { place } = seedBuyerWithPlace(eventId);

    const res = await claim(eventId, pid, place);

    expect(res.status).toBe(200);
    const row = getParticipant(h.db, pid);
    expect(row.purchasing_claimed_by).toBe('Tony Nguyen');
    expect(row.purchasing_claimed_at).toBeTruthy();
    expect(row.purchasing_claimed_queue_id).toBe(place);
  });

  it('requires a place in line', async () => {
    const eventId = insertEvent(h.db);
    const pid = insertParticipant(h.db, eventId);
    seedBuyer(eventId);

    const res = await claim(eventId, pid);

    expect(res.status).toBe(400);
    expect(getParticipant(h.db, pid).purchasing_claimed_by).toBe('');
  });

  it('waits until the place is through Queue-It', async () => {
    const eventId = insertEvent(h.db);
    const pid = insertParticipant(h.db, eventId);
    const { place } = seedBuyerWithPlace(eventId, 'in_queueit', 'iPhone');

    const res = await claim(eventId, pid, place);

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining('iPhone') });
  });

  it("refuses someone else's place", async () => {
    const eventId = insertEvent(h.db);
    const pid = insertParticipant(h.db, eventId);
    seedBuyer(eventId);
    const henry = seedBuyer(eventId, HENRY, 'Henry', 'Garcia');
    const henrysPlace = insertPlace(h.db, eventId, henry, HENRY);

    const res = await claim(eventId, pid, henrysPlace);

    expect(res.status).toBe(403);
  });

  it('rejects a claim already held by someone else', async () => {
    const eventId = insertEvent(h.db);
    const pid = insertParticipant(h.db, eventId, {
      purchasing_claimed_by: 'Henry Garcia',
      purchasing_claimed_at: new Date().toISOString(),
    });
    const { place } = seedBuyerWithPlace(eventId);

    const res = await claim(eventId, pid, place);

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: 'Already claimed by Henry Garcia' });
  });

  it('stops at 3 per place, and a second place can take 3 more', async () => {
    const eventId = insertEvent(h.db);
    const { buyer, place } = seedBuyerWithPlace(eventId);
    const second = insertPlace(h.db, eventId, buyer, TONY, { label: 'iPhone' });
    const held = new Date().toISOString();
    for (let i = 0; i < 3; i += 1) {
      insertParticipant(h.db, eventId, {
        first_name: `Held${i}`,
        purchasing_claimed_by: 'Tony Nguyen',
        purchasing_claimed_at: held,
        purchasing_claimed_queue_id: place,
      });
    }
    const fourth = insertParticipant(h.db, eventId, { first_name: 'Fourth' });

    const full = await claim(eventId, fourth, place);
    expect(full.status).toBe(400);
    await expect(full.json()).resolves.toMatchObject({ error: expect.stringContaining('already has 3 people') });

    const other = await claim(eventId, fourth, second);
    expect(other.status).toBe(200);
    expect(getParticipant(h.db, fourth).purchasing_claimed_queue_id).toBe(second);
  });

  it('counts someone the place already bought for toward the limit', async () => {
    const eventId = insertEvent(h.db);
    const { place } = seedBuyerWithPlace(eventId);
    const held = new Date().toISOString();
    for (let i = 0; i < 2; i += 1) {
      insertParticipant(h.db, eventId, {
        first_name: `Held${i}`,
        purchasing_claimed_by: 'Tony Nguyen',
        purchasing_claimed_at: held,
        purchasing_claimed_queue_id: place,
      });
    }
    // Finished: the claim ended, but the badge came out of this place's 3.
    insertParticipant(h.db, eventId, {
      first_name: 'Bought',
      purchasing_claimed_queue_id: place,
      req_sat: 1,
      pur_sat: 1,
    });
    const fourth = insertParticipant(h.db, eventId, { first_name: 'Fourth' });

    const res = await claim(eventId, fourth, place);

    expect(res.status).toBe(400);
    expect(getParticipant(h.db, fourth).purchasing_claimed_by).toBe('');
  });

  it('does not count someone left with only sold-out days toward the limit', async () => {
    const eventId = insertEvent(h.db);
    h.db.prepare('UPDATE events SET sold_out_sat = 1 WHERE id = ?').run(eventId);
    const { place } = seedBuyerWithPlace(eventId);
    const held = new Date().toISOString();
    for (let i = 0; i < 2; i += 1) {
      insertParticipant(h.db, eventId, {
        first_name: `Held${i}`,
        req_sat: 0,
        req_sun: 1,
        purchasing_claimed_by: 'Tony Nguyen',
        purchasing_claimed_at: held,
        purchasing_claimed_queue_id: place,
      });
    }
    insertParticipant(h.db, eventId, {
      first_name: 'SoldOut',
      purchasing_claimed_by: 'Tony Nguyen',
      purchasing_claimed_at: held,
      purchasing_claimed_queue_id: place,
    });
    const fourth = insertParticipant(h.db, eventId, { first_name: 'Fourth', req_sat: 0, req_sun: 1 });

    const res = await claim(eventId, fourth, place);

    expect(res.status).toBe(200);
    expect(getParticipant(h.db, fourth).purchasing_claimed_by).toBe('Tony Nguyen');
  });

  it('refuses to claim someone whose only days are sold out', async () => {
    const eventId = insertEvent(h.db);
    h.db.prepare('UPDATE events SET sold_out_sat = 1 WHERE id = ?').run(eventId);
    const { place } = seedBuyerWithPlace(eventId);
    const pid = insertParticipant(h.db, eventId, { first_name: 'Satonly' });

    const res = await claim(eventId, pid, place);

    expect(res.status).toBe(409);
    expect(getParticipant(h.db, pid).purchasing_claimed_by).toBe('');
  });

  it('ignores expired claims when counting the limit', async () => {
    const eventId = insertEvent(h.db);
    const { place } = seedBuyerWithPlace(eventId);
    const stale = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    for (let i = 0; i < 3; i += 1) {
      insertParticipant(h.db, eventId, {
        first_name: `Stale${i}`,
        purchasing_claimed_by: 'Tony Nguyen',
        purchasing_claimed_at: stale,
        purchasing_claimed_queue_id: place,
      });
    }
    const fresh = insertParticipant(h.db, eventId, { first_name: 'Fresh' });

    const res = await claim(eventId, fresh, place);

    expect(res.status).toBe(200);
  });

  describe('when a place ends', () => {
    function claimedOn(eventId: number, place: number, over: { req_sat?: number; pur_sat?: number } = {}) {
      return insertParticipant(h.db, eventId, {
        purchasing_claimed_by: 'Tony Nguyen',
        purchasing_claimed_at: new Date().toISOString(),
        purchasing_claimed_queue_id: place,
        ...over,
      });
    }

    it('marking it done releases whoever it was still buying for', async () => {
      const eventId = insertEvent(h.db);
      const { buyer, place } = seedBuyerWithPlace(eventId);
      const other = insertPlace(h.db, eventId, buyer, TONY, { label: 'iPhone' });
      const pending = claimedOn(eventId, place);
      const elsewhere = claimedOn(eventId, other);

      const res = await h.request(`/api/events/${eventId}/purchase-queue/${place}`, {
        method: 'PATCH', as: TONY, body: JSON.stringify({ status: 'done' }),
      });

      expect(res.status).toBe(200);
      expect(getParticipant(h.db, pending)).toMatchObject({
        purchasing_claimed_by: '', purchasing_claimed_at: null, purchasing_claimed_queue_id: null,
      });
      expect(getParticipant(h.db, elsewhere).purchasing_claimed_queue_id).toBe(other);
    });

    it('removing it releases its claims', async () => {
      const eventId = insertEvent(h.db);
      const { place } = seedBuyerWithPlace(eventId);
      const pending = claimedOn(eventId, place);

      const res = await h.request(`/api/events/${eventId}/purchase-queue/${place}`, { method: 'DELETE', as: TONY });

      expect(res.status).toBe(200);
      expect(getParticipant(h.db, pending).purchasing_claimed_by).toBe('');
    });

    it('clearing the whole line releases every claim on it', async () => {
      const eventId = insertEvent(h.db);
      const { place } = seedBuyerWithPlace(eventId);
      const pending = claimedOn(eventId, place);

      const res = await h.request(`/api/admin/events/${eventId}/purchase-queue`, { method: 'DELETE', adminSecret: true });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ ok: true, cleared: 1 });
      expect(getParticipant(h.db, pending).purchasing_claimed_by).toBe('');
    });
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

  it('only changes the days sent, so one tick never undoes another', async () => {
    const eventId = insertEvent(h.db);
    seedBuyer(eventId);
    const pid = insertParticipant(h.db, eventId, {
      req_sat: 1,
      req_sun: 1,
      pur_sat: 1,
      who_purchased: 'Tony Nguyen',
      purchasing_claimed_by: 'Tony Nguyen',
      purchasing_claimed_at: new Date().toISOString(),
    });

    await h.request(`/api/events/${eventId}/participants/${pid}/purchased`, {
      method: 'PATCH',
      as: TONY,
      body: JSON.stringify({ pur_sun: true }),
    });

    const row = getParticipant(h.db, pid);
    expect(row.pur_sat).toBe(1);
    expect(row.pur_sun).toBe(1);
    expect(row.who_purchased).toBe('Tony Nguyen');
  });

  it('keeps a finished purchase linked to the place that bought it', async () => {
    const eventId = insertEvent(h.db);
    const place = insertPlace(h.db, eventId, seedBuyer(eventId), TONY, { status: 'buying', label: 'Laptop' });
    const pid = insertParticipant(h.db, eventId, {
      req_sat: 1,
      purchasing_claimed_by: 'Tony Nguyen',
      purchasing_claimed_at: new Date().toISOString(),
      purchasing_claimed_queue_id: place,
    });

    await h.request(`/api/events/${eventId}/participants/${pid}/purchased`, {
      method: 'PATCH',
      as: TONY,
      body: JSON.stringify({ pur_sat: true, who_purchased: 'Tony Nguyen' }),
    });

    const row = getParticipant(h.db, pid);
    expect(row.purchasing_claimed_by).toBe('');
    expect(row.purchasing_claimed_queue_id).toBe(place);
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
