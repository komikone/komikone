/**
 * Purchase day with a full room on the board at once.
 *
 * The failures that matter are not "the query is slow." They are two buyers
 * grabbing the same person, one place slipping past Comic-Con's 3, two people
 * joining the line onto the same position, and a neighbor releasing a claim
 * they don't hold. Polling the board is the other half: every open Live Board
 * refetches together.
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

const ROOM = 45;

let h: TestHarness;

beforeEach(async () => {
  h = await createHarness();
});

afterEach(() => {
  h.close();
});

function claim(eventId: number, pid: number, queueId: number, as: string, name: string) {
  return h.request(`/api/events/${eventId}/participants/${pid}/claim`, {
    method: 'POST',
    as,
    body: JSON.stringify({ coordinator_name: name, queue_id: queueId }),
  });
}

describe('a full room on the Live Board', () => {
  it('lists every person for every open board at once', async () => {
    const eventId = insertEvent(h.db, { status: 'purchasing' });
    const ids = Array.from({ length: ROOM }, (_, i) => insertParticipant(h.db, eventId, {
      first_name: `Person${i}`,
      clerk_user_id: `user_${i}`,
    }));

    const responses = await Promise.all(
      ids.map((_, i) => h.request(`/api/events/${eventId}/participants`, { as: `user_${i}` })),
    );

    expect(responses.every((r) => r.status === 200)).toBe(true);
    const bodies = await Promise.all(responses.map((r) => r.json() as Promise<{ id: number }[]>));
    for (const rows of bodies) {
      expect(rows).toHaveLength(ROOM);
      expect(new Set(rows.map((r) => r.id)).size).toBe(ROOM);
    }
  });

  it('gives 45 people who join at once a unique place in line', async () => {
    const eventId = insertEvent(h.db, { status: 'purchasing' });
    for (let i = 0; i < ROOM; i += 1) {
      insertParticipant(h.db, eventId, { first_name: `Person${i}`, clerk_user_id: `user_${i}` });
    }

    const responses = await Promise.all(
      Array.from({ length: ROOM }, (_, i) => h.request(`/api/events/${eventId}/purchase-queue/join`, {
        method: 'POST',
        as: `user_${i}`,
        body: JSON.stringify({}),
      })),
    );

    expect(responses.every((r) => r.status === 200)).toBe(true);
    const queue = await h.request(`/api/events/${eventId}/purchase-queue`, { as: 'user_0' });
    const rows = await queue.json() as { id: number; position: number; clerk_user_id: string }[];
    expect(rows).toHaveLength(ROOM);
    expect(new Set(rows.map((r) => r.position)).size).toBe(ROOM);
    expect(new Set(rows.map((r) => r.clerk_user_id)).size).toBe(ROOM);
  });
});

describe('two buyers clicking claim together', () => {
  it('lets only one of them hold the person', async () => {
    const eventId = insertEvent(h.db, { status: 'purchasing' });
    const target = insertParticipant(h.db, eventId, { first_name: 'Casey' });
    const tony = insertParticipant(h.db, eventId, { first_name: 'Tony', last_name: 'Nguyen', clerk_user_id: 'user_tony' });
    const henry = insertParticipant(h.db, eventId, { first_name: 'Henry', last_name: 'Garcia', clerk_user_id: 'user_henry' });
    const tonyPlace = insertPlace(h.db, eventId, tony, 'user_tony', { label: 'Tony laptop' });
    const henryPlace = insertPlace(h.db, eventId, henry, 'user_henry', { label: 'Henry phone' });

    const [a, b] = await Promise.all([
      claim(eventId, target, tonyPlace, 'user_tony', 'Tony Nguyen'),
      claim(eventId, target, henryPlace, 'user_henry', 'Henry Garcia'),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const row = getParticipant(h.db, target);
    expect(['Tony Nguyen', 'Henry Garcia']).toContain(row.purchasing_claimed_by);
    const loser = a.status === 409 ? a : b;
    await expect(loser.json()).resolves.toMatchObject({ error: expect.stringContaining('Already claimed') });
  });

  it('stops a place at 3 even when two claims race for the last slots', async () => {
    const eventId = insertEvent(h.db, { status: 'purchasing' });
    const tony = insertParticipant(h.db, eventId, { first_name: 'Tony', last_name: 'Nguyen', clerk_user_id: 'user_tony' });
    const place = insertPlace(h.db, eventId, tony, 'user_tony', { label: 'Laptop' });
    const held = new Date().toISOString();
    for (let i = 0; i < 2; i += 1) {
      insertParticipant(h.db, eventId, {
        first_name: `Held${i}`,
        purchasing_claimed_by: 'Tony Nguyen',
        purchasing_claimed_at: held,
        purchasing_claimed_queue_id: place,
      });
    }
    const nextA = insertParticipant(h.db, eventId, { first_name: 'NextA' });
    const nextB = insertParticipant(h.db, eventId, { first_name: 'NextB' });

    const [a, b] = await Promise.all([
      claim(eventId, nextA, place, 'user_tony', 'Tony Nguyen'),
      claim(eventId, nextB, place, 'user_tony', 'Tony Nguyen'),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 400]);
    const heldBy = [nextA, nextB].map((id) => getParticipant(h.db, id).purchasing_claimed_by);
    expect(heldBy.filter((name) => name === 'Tony Nguyen')).toHaveLength(1);
    const onPlace = [nextA, nextB].filter((id) => getParticipant(h.db, id).purchasing_claimed_queue_id === place);
    expect(onPlace).toHaveLength(1);
  });
});

describe('neighbors on a busy board', () => {
  it('refuses to let someone else release a claim', async () => {
    const eventId = insertEvent(h.db, { status: 'purchasing' });
    const tony = insertParticipant(h.db, eventId, { first_name: 'Tony', last_name: 'Nguyen', clerk_user_id: 'user_tony' });
    insertParticipant(h.db, eventId, { first_name: 'Henry', last_name: 'Garcia', clerk_user_id: 'user_henry' });
    const place = insertPlace(h.db, eventId, tony, 'user_tony');
    const target = insertParticipant(h.db, eventId, { first_name: 'Casey' });
    const claimed = await claim(eventId, target, place, 'user_tony', 'Tony Nguyen');
    expect(claimed.status).toBe(200);

    const stolen = await h.request(`/api/events/${eventId}/participants/${target}/unclaim`, {
      method: 'POST',
      as: 'user_henry',
    });
    expect(stolen.status).toBe(403);
    expect(getParticipant(h.db, target).purchasing_claimed_by).toBe('Tony Nguyen');

    const released = await h.request(`/api/events/${eventId}/participants/${target}/unclaim`, {
      method: 'POST',
      as: 'user_tony',
    });
    expect(released.status).toBe(200);
    expect(getParticipant(h.db, target).purchasing_claimed_by).toBe('');
  });

  it('keeps both days when two purchase taps land together', async () => {
    const eventId = insertEvent(h.db, { status: 'purchasing' });
    const tony = insertParticipant(h.db, eventId, { first_name: 'Tony', last_name: 'Nguyen', clerk_user_id: 'user_tony' });
    const place = insertPlace(h.db, eventId, tony, 'user_tony');
    const target = insertParticipant(h.db, eventId, { first_name: 'Casey', req_sat: 1, req_sun: 1 });
    expect((await claim(eventId, target, place, 'user_tony', 'Tony Nguyen')).status).toBe(200);

    const [sat, sun] = await Promise.all([
      h.request(`/api/events/${eventId}/participants/${target}/purchased`, {
        method: 'PATCH', as: 'user_tony',
        body: JSON.stringify({ pur_sat: true, who_purchased: 'Tony Nguyen' }),
      }),
      h.request(`/api/events/${eventId}/participants/${target}/purchased`, {
        method: 'PATCH', as: 'user_tony',
        body: JSON.stringify({ pur_sun: true, who_purchased: 'Tony Nguyen' }),
      }),
    ]);

    expect(sat.status).toBe(200);
    expect(sun.status).toBe(200);
    const row = getParticipant(h.db, target);
    expect(row.pur_sat).toBe(1);
    expect(row.pur_sun).toBe(1);
  });

  it('keeps both sold-out marks when two days are called out together', async () => {
    const eventId = insertEvent(h.db, { status: 'purchasing' });
    insertParticipant(h.db, eventId, { first_name: 'Tony', clerk_user_id: 'user_tony' });
    insertParticipant(h.db, eventId, { first_name: 'Henry', clerk_user_id: 'user_henry' });

    const [sat, fri] = await Promise.all([
      h.request(`/api/events/${eventId}/sold-out`, {
        method: 'PATCH', as: 'user_tony', body: JSON.stringify({ day: 'sat', sold_out: true }),
      }),
      h.request(`/api/events/${eventId}/sold-out`, {
        method: 'PATCH', as: 'user_henry', body: JSON.stringify({ day: 'fri', sold_out: true }),
      }),
    ]);

    expect(sat.status).toBe(200);
    expect(fri.status).toBe(200);
    const event = h.db.prepare('SELECT sold_out_sat, sold_out_fri FROM events WHERE id = ?').get(eventId) as {
      sold_out_sat: number; sold_out_fri: number;
    };
    expect(event.sold_out_sat).toBe(1);
    expect(event.sold_out_fri).toBe(1);
  });
});
