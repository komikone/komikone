/**
 * Buy lists: each member's own order of who they want to buy for on purchase day.
 * Lists are private to their owner and only ever hold people on the same event.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, insertEvent, insertParticipant, type TestHarness } from './harness';

const PREVIN = 'user_previn';
const NORA = 'user_nora';

let h: TestHarness;
let eventId: number;
let previn: number;
let daughter: number;
let friend: number;

beforeEach(async () => {
  h = await createHarness();
  eventId = insertEvent(h.db, { status: 'registration' });
  previn = insertParticipant(h.db, eventId, { first_name: 'Previn', clerk_user_id: PREVIN });
  daughter = insertParticipant(h.db, eventId, { first_name: 'Maya' });
  friend = insertParticipant(h.db, eventId, { first_name: 'Nora', clerk_user_id: NORA });
});

afterEach(() => {
  h.close();
});

function save(as: string, ids: unknown, evt = eventId) {
  return h.request(`/api/events/${evt}/buy-list`, {
    method: 'PUT', as, body: JSON.stringify({ participant_ids: ids }),
  });
}

async function load(as: string): Promise<number[]> {
  const res = await h.request(`/api/events/${eventId}/buy-list`, { as });
  expect(res.status).toBe(200);
  return ((await res.json()) as { participant_ids: number[] }).participant_ids;
}

describe('buy list', () => {
  it('starts empty and keeps the order it was saved in', async () => {
    expect(await load(PREVIN)).toEqual([]);
    const res = await save(PREVIN, [friend, previn, daughter]);
    expect(res.status).toBe(200);
    expect(await load(PREVIN)).toEqual([friend, previn, daughter]);

    await save(PREVIN, [daughter, friend]);
    expect(await load(PREVIN)).toEqual([daughter, friend]);
  });

  it('is private to whoever saved it', async () => {
    await save(PREVIN, [daughter, previn]);
    await save(NORA, [friend]);
    expect(await load(NORA)).toEqual([friend]);
    expect(await load(PREVIN)).toEqual([daughter, previn]);
  });

  it('drops duplicates instead of ranking someone twice', async () => {
    await save(PREVIN, [daughter, previn, daughter]);
    expect(await load(PREVIN)).toEqual([daughter, previn]);
  });

  it('rejects people from another event', async () => {
    const other = insertEvent(h.db, { status: 'registration' });
    const stranger = insertParticipant(h.db, other, { first_name: 'Stranger' });
    const res = await save(PREVIN, [previn, stranger]);
    expect(res.status).toBe(400);
    expect(await load(PREVIN)).toEqual([]);
  });

  it('requires sign-in', async () => {
    const res = await h.request(`/api/events/${eventId}/buy-list`);
    expect(res.status).toBe(401);
  });

  it('forgets people once they leave the event', async () => {
    await save(PREVIN, [daughter, friend]);
    const res = await h.request(`/api/admin/events/${eventId}/participants/${daughter}`, {
      method: 'DELETE', adminSecret: true,
    });
    expect(res.status).toBeLessThan(300);
    expect(await load(PREVIN)).toEqual([friend]);
  });

  it('goes away with the event', async () => {
    await save(PREVIN, [daughter]);
    const res = await h.request(`/api/admin/events/${eventId}`, { method: 'DELETE', adminSecret: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ participants_deleted: 3 });
    const left = h.db.prepare('SELECT COUNT(*) AS n FROM buy_list_entries').get() as { n: number };
    expect(left.n).toBe(0);
  });
});
