/**
 * Practice: a shared copy of the board that anyone on it can join to rehearse purchase
 * day, without touching the real board. Buy lists are the one thing practice keeps.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createHarness,
  getParticipant,
  insertEvent,
  insertGroup,
  insertParticipant,
  insertPlace,
  insertYear,
  type TestHarness,
} from './harness';

const TONY = 'user_tony';
const HENRY = 'user_henry';
const STRANGER = 'user_stranger';

let h: TestHarness;

beforeEach(async () => {
  h = await createHarness();
});

afterEach(() => {
  h.close();
});

function seedBoard() {
  const yearId = insertYear(h.db);
  const eventId = insertEvent(h.db, { year_id: yearId, status: 'registration' });
  const groupId = insertGroup(h.db, eventId, TONY, "Tony's Group");
  const tony = insertParticipant(h.db, eventId, { first_name: 'Tony', clerk_user_id: TONY, group_id: groupId, member_id: 'TNGUY001' });
  const henry = insertParticipant(h.db, eventId, { first_name: 'Henry', clerk_user_id: HENRY, member_id: 'HGARC014' });
  const place = insertPlace(h.db, eventId, tony, TONY, { status: 'waiting', label: 'Laptop' });
  return { yearId, eventId, groupId, tony, henry, place };
}

const join = (eventId: number, as: string = TONY) =>
  h.request(`/api/events/${eventId}/practice`, { method: 'POST', as });

describe('POST /api/events/:id/practice', () => {
  it('builds a purchasing copy of the board with its people, groups and places in line', async () => {
    const { eventId, groupId, tony } = seedBoard();

    const res = await join(eventId);
    expect(res.status).toBe(200);
    const { id, practice_of } = await res.json() as { id: number; practice_of: number };
    expect(practice_of).toBe(eventId);
    expect(id).not.toBe(eventId);

    const copy = h.db.prepare('SELECT * FROM events WHERE id = ?').get(id) as Record<string, unknown>;
    expect(copy).toMatchObject({ status: 'purchasing', practice_of: eventId, year_id: null });

    const people = h.db.prepare('SELECT * FROM participants WHERE event_id = ? ORDER BY id').all(id) as Record<string, unknown>[];
    expect(people.map((p) => p.first_name)).toEqual(['Tony', 'Henry']);
    expect(people[0].practice_source_id).toBe(tony);
    expect(people[0].group_id).not.toBe(groupId);
    expect(h.db.prepare('SELECT name FROM groups WHERE id = ?').get(people[0].group_id as number)).toMatchObject({ name: "Tony's Group" });

    const places = h.db.prepare('SELECT * FROM purchase_queue WHERE event_id = ?').all(id) as Record<string, unknown>[];
    expect(places).toHaveLength(1);
    expect(places[0]).toMatchObject({ label: 'Laptop', participant_id: people[0].id });
  });

  it('puts everyone who joins on the same copy', async () => {
    const { eventId } = seedBoard();
    const first = await (await join(eventId, TONY)).json() as { id: number };
    const second = await (await join(eventId, HENRY)).json() as { id: number };
    expect(second.id).toBe(first.id);
  });

  it('leaves the copy out of the event list', async () => {
    const { eventId } = seedBoard();
    const { id } = await (await join(eventId)).json() as { id: number };
    const events = await (await h.request('/api/events')).json() as { id: number }[];
    expect(events.map((e) => e.id)).toContain(eventId);
    expect(events.map((e) => e.id)).not.toContain(id);
  });

  it("refuses people who aren't on the board", async () => {
    const { eventId } = seedBoard();
    expect((await join(eventId, STRANGER)).status).toBe(403);
  });

  it('is closed while the real event is purchasing', async () => {
    const { eventId } = seedBoard();
    h.db.prepare("UPDATE events SET status = 'purchasing' WHERE id = ?").run(eventId);
    expect((await join(eventId)).status).toBe(409);
  });

  it('lets people claim and buy on the copy without touching the real board', async () => {
    const { eventId, henry } = seedBoard();
    const { id } = await (await join(eventId)).json() as { id: number };
    const copyHenry = (h.db.prepare('SELECT id FROM participants WHERE event_id = ? AND practice_source_id = ?').get(id, henry) as { id: number }).id;
    const copyPlace = (h.db.prepare('SELECT id FROM purchase_queue WHERE event_id = ?').get(id) as { id: number }).id;
    h.db.prepare("UPDATE purchase_queue SET status = 'buying' WHERE id = ?").run(copyPlace);

    const res = await h.request(`/api/events/${id}/participants/${copyHenry}/claim`, {
      method: 'POST', as: TONY, body: JSON.stringify({ coordinator_name: 'Tony Nguyen', queue_id: copyPlace }),
    });
    expect(res.status).toBe(200);
    expect(getParticipant(h.db, copyHenry).purchasing_claimed_by).toBe('Tony Nguyen');
    expect(getParticipant(h.db, henry).purchasing_claimed_by).toBe('');
  });
});

describe('POST /api/events/:id/practice/reset', () => {
  it('throws practice away and starts again from the real board', async () => {
    const { eventId } = seedBoard();
    const { id: oldId } = await (await join(eventId)).json() as { id: number };
    h.db.prepare("UPDATE events SET sold_out_sat = 1 WHERE id = ?").run(oldId);

    const res = await h.request(`/api/events/${oldId}/practice/reset`, { method: 'POST', as: HENRY });
    expect(res.status).toBe(200);
    const { id } = await res.json() as { id: number };
    expect(id).not.toBe(oldId);
    expect(h.db.prepare('SELECT id FROM events WHERE id = ?').get(oldId)).toBeUndefined();
    expect(h.db.prepare('SELECT sold_out_sat FROM events WHERE id = ?').get(id)).toMatchObject({ sold_out_sat: 0 });
  });
});

describe('practice and real purchasing', () => {
  it('drops the copy when an admin opens real purchasing', async () => {
    const { eventId } = seedBoard();
    const { id } = await (await join(eventId)).json() as { id: number };

    const res = await h.request(`/api/admin/events/${eventId}`, {
      method: 'PATCH', adminSecret: true, body: JSON.stringify({ status: 'purchasing' }),
    });
    expect(res.status).toBe(200);
    expect(h.db.prepare('SELECT id FROM events WHERE id = ?').get(id)).toBeUndefined();
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM participants WHERE event_id = ?').get(id)).toMatchObject({ n: 0 });
  });
});

describe('buy lists while practicing', () => {
  it('reads and saves your real buy list', async () => {
    const { eventId, tony, henry } = seedBoard();
    const { id } = await (await join(eventId)).json() as { id: number };
    const copyOf = (pid: number) =>
      (h.db.prepare('SELECT id FROM participants WHERE event_id = ? AND practice_source_id = ?').get(id, pid) as { id: number }).id;

    const save = await h.request(`/api/events/${id}/buy-list`, {
      method: 'PUT', as: TONY, body: JSON.stringify({ participant_ids: [copyOf(henry), copyOf(tony)] }),
    });
    expect(save.status).toBe(200);

    const real = await (await h.request(`/api/events/${eventId}/buy-list`, { as: TONY })).json();
    expect(real).toEqual({ participant_ids: [henry, tony] });
    const practice = await (await h.request(`/api/events/${id}/buy-list`, { as: TONY })).json();
    expect(practice).toEqual({ participant_ids: [copyOf(henry), copyOf(tony)] });
  });
});
