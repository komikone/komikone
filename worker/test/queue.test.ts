/**
 * Queue-It line and sold-out routes.
 *
 * Places in line were going missing on the call: anyone could delete or skip anyone's
 * place, skips could not be undone, and ETAs were frozen minute counts that never counted
 * down, so the order drifted. These pin the rules that replaced that.
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
let eventId: number;

beforeEach(async () => {
  h = await createHarness();
  eventId = insertEvent(h.db, { status: 'purchasing' });
  insertParticipant(h.db, eventId, { first_name: 'Tony', clerk_user_id: TONY });
  insertParticipant(h.db, eventId, { first_name: 'Henry', clerk_user_id: HENRY });
});

afterEach(() => {
  h.close();
});

type Entry = { id: number; clerk_user_id: string; label: string; status: string; eta_at: string | null };

async function join(as: string, label?: string): Promise<Entry[]> {
  const res = await h.request(`/api/events/${eventId}/purchase-queue/join`, {
    method: 'POST', as, body: JSON.stringify(label ? { label } : {}),
  });
  expect(res.status).toBe(200);
  return res.json();
}

function patch(qid: number, as: string, body: Record<string, unknown>, adminSecret = false) {
  return h.request(`/api/events/${eventId}/purchase-queue/${qid}`, {
    method: 'PATCH', as, adminSecret, body: JSON.stringify(body),
  });
}

describe('place names', () => {
  it('gives each place a stable default name that is never reused after a removal', async () => {
    await join(TONY);
    await join(TONY);
    let queue = await join(TONY);
    const second = queue.find((q) => q.label === 'Place 2')!;

    await h.request(`/api/events/${eventId}/purchase-queue/${second.id}`, { method: 'DELETE', as: TONY });
    queue = await join(TONY);

    const labels = queue.filter((q) => q.clerk_user_id === TONY).map((q) => q.label).sort();
    expect(labels).toEqual(['Place 1', 'Place 2', 'Place 3']);
  });

  it('lets the owner rename a place but not someone else', async () => {
    const [entry] = await join(TONY);

    expect((await patch(entry.id, HENRY, { label: 'Hijack' })).status).toBe(403);

    const res = await patch(entry.id, TONY, { label: '  iPhone Safari  ' });
    expect(res.status).toBe(200);
    const queue = (await res.json()) as Entry[];
    expect(queue[0].label).toBe('iPhone Safari');
  });
});

describe('who can take a place out of line', () => {
  it('refuses to let another member remove or skip my place', async () => {
    const [entry] = await join(TONY);

    const del = await h.request(`/api/events/${eventId}/purchase-queue/${entry.id}`, { method: 'DELETE', as: HENRY });
    expect(del.status).toBe(403);
    expect((await patch(entry.id, HENRY, { status: 'skipped' })).status).toBe(403);
  });

  it('still lets another member report my ETA and status, for heads-down buyers', async () => {
    const [entry] = await join(TONY);

    expect((await patch(entry.id, HENRY, { eta_minutes: 10 })).status).toBe(200);
    expect((await patch(entry.id, HENRY, { status: 'buying' })).status).toBe(200);
  });

  it('lets an admin remove anyone', async () => {
    const [entry] = await join(TONY);
    const res = await h.request(`/api/events/${eventId}/purchase-queue/${entry.id}`, {
      method: 'DELETE', adminSecret: true,
    });
    expect(res.status).toBe(200);
  });

  it('lets the owner restore a skipped place', async () => {
    const [entry] = await join(TONY);
    await patch(entry.id, TONY, { status: 'skipped' });

    expect((await patch(entry.id, HENRY, { status: 'waiting' })).status).toBe(403);
    const res = await patch(entry.id, TONY, { status: 'waiting' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Entry[])[0].status).toBe('waiting');
  });
});

describe('ETA ordering', () => {
  it('orders by when each place is due, not by the minutes someone last typed', async () => {
    await join(TONY);
    const queue = await join(HENRY);
    const tony = queue.find((q) => q.clerk_user_id === TONY)!;
    const henry = queue.find((q) => q.clerk_user_id === HENRY)!;

    // Tony said 30 minutes twenty minutes ago (due in 10); Henry just said 25 (due in 25).
    await patch(tony.id, TONY, { eta_minutes: 30 });
    h.db.prepare("UPDATE purchase_queue SET eta_at = datetime('now', '+10 minutes') WHERE id = ?").run(tony.id);
    const res = await patch(henry.id, HENRY, { eta_minutes: 25 });

    const order = ((await res.json()) as Entry[]).map((q) => q.clerk_user_id);
    expect(order).toEqual([TONY, HENRY]);
  });

  it('clears the due time along with the ETA', async () => {
    const [entry] = await join(TONY);
    await patch(entry.id, TONY, { eta_minutes: 15 });
    const res = await patch(entry.id, TONY, { eta_minutes: null });
    expect(((await res.json()) as Entry[])[0].eta_at).toBeNull();
  });
});

describe('PATCH /sold-out', () => {
  function soldOut(as: string | undefined, body: Record<string, unknown>) {
    return h.request(`/api/events/${eventId}/sold-out`, { method: 'PATCH', as, body: JSON.stringify(body) });
  }

  it('lets anyone on the event flip a day, and flip it back', async () => {
    const on = await soldOut(HENRY, { day: 'fri', sold_out: true });
    expect(on.status).toBe(200);
    expect(((await on.json()) as { sold_out_fri: number }).sold_out_fri).toBe(1);

    const off = await soldOut(HENRY, { day: 'fri', sold_out: false });
    expect(((await off.json()) as { sold_out_fri: number }).sold_out_fri).toBe(0);
  });

  it('refuses someone who is not in the event', async () => {
    expect((await soldOut('user_stranger', { day: 'fri', sold_out: true })).status).toBe(403);
  });

  it('rejects a day that is not a sale day', async () => {
    expect((await soldOut(HENRY, { day: 'mon; DROP TABLE events', sold_out: true })).status).toBe(400);
  });

  it('stops counting a sold-out day as a gap on the board', async () => {
    await soldOut(HENRY, { day: 'sat', sold_out: true });
    const res = await h.request(`/api/events/${eventId}/participants`, { as: HENRY });
    const [tony] = (await res.json()) as { first_name: string; gaps: string[]; sold_out_gaps: string[] }[];
    expect(tony.gaps).toEqual([]);
    expect(tony.sold_out_gaps).toEqual(['Sat']);
  });

  it('frees a claim slot once the only day left is sold out', async () => {
    const pid = insertParticipant(h.db, eventId, {
      first_name: 'Karen', req_sat: 1, req_sun: 1,
      purchasing_claimed_by: 'Tony', purchasing_claimed_at: new Date().toISOString(),
    });
    await soldOut(HENRY, { day: 'sat', sold_out: true });

    const res = await h.request(`/api/events/${eventId}/participants/${pid}/purchased`, {
      method: 'PATCH', adminSecret: true,
      body: JSON.stringify({ pur_sun: true, who_purchased: 'Tony' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ claim_released: true });
    expect(getParticipant(h.db, pid).purchasing_claimed_by).toBe('');
  });
});
