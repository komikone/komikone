/**
 * Admin cleanup: removing a member from a year, and clearing a Queue-It line left over
 * from practice. Deleting a member must not take the people they added with them.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createHarness,
  insertEvent,
  insertGroup,
  insertParticipant,
  insertYear,
  insertYearMember,
  type TestHarness,
} from './harness';

const HENRY = 'user_henry';
const TONY = 'user_tony';

let h: TestHarness;
let yearId: number;
let eventId: number;

beforeEach(async () => {
  h = await createHarness();
  yearId = insertYear(h.db);
  eventId = insertEvent(h.db, { year_id: yearId, status: 'registration' });
});

afterEach(() => {
  h.close();
});

const count = (sql: string, ...args: (string | number)[]) =>
  Number((h.db.prepare(sql).get(...args) as { n: number }).n);

function joinQueue(as: string) {
  return h.request(`/api/events/${eventId}/purchase-queue/join`, { method: 'POST', as, body: '{}' });
}

describe('deleting a member', () => {
  let memberId: number;
  let familyId: number;
  let groupId: number;

  beforeEach(async () => {
    memberId = insertYearMember(h.db, yearId, HENRY);
    groupId = insertGroup(h.db, eventId, HENRY);
    insertParticipant(h.db, eventId, { first_name: 'Henry', clerk_user_id: HENRY, group_id: groupId });
    familyId = insertParticipant(h.db, eventId, { first_name: 'Lucy', group_id: groupId });
    h.db.prepare('UPDATE participants SET registered_by_clerk_user_id = ? WHERE id = ?').run(HENRY, familyId);
    h.db.prepare("UPDATE events SET status = 'purchasing' WHERE id = ?").run(eventId);
    expect((await joinQueue(HENRY)).status).toBe(200);
  });

  const del = (dryRun = false) =>
    h.request(`/api/admin/years/${yearId}/members/${memberId}${dryRun ? '?dry_run=1' : ''}`, {
      method: 'DELETE', adminSecret: true,
    });

  it('previews what will change without changing anything', async () => {
    const res = await del(true);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ own_rows: 1, queue_places: 1, added_rows: 1, owned_groups: 1 });
    expect(count('SELECT COUNT(*) n FROM year_members WHERE id = ?', memberId)).toBe(1);
  });

  it('removes their membership, board row and queue places but keeps who they added', async () => {
    expect((await del()).status).toBe(200);

    expect(count('SELECT COUNT(*) n FROM year_members WHERE id = ?', memberId)).toBe(0);
    expect(count('SELECT COUNT(*) n FROM participants WHERE clerk_user_id = ?', HENRY)).toBe(0);
    expect(count('SELECT COUNT(*) n FROM purchase_queue WHERE event_id = ?', eventId)).toBe(0);

    const lucy = h.db.prepare('SELECT registered_by_clerk_user_id r, group_id g FROM participants WHERE id = ?')
      .get(familyId) as { r: string | null; g: number };
    expect(lucy).toEqual({ r: null, g: groupId });
    expect(count("SELECT COUNT(*) n FROM groups WHERE id = ? AND owner_clerk_user_id = ''", groupId)).toBe(1);
  });

  it('leaves other members alone', async () => {
    insertYearMember(h.db, yearId, TONY, { first_name: 'Tony', member_id: 'TONYN858' });
    insertParticipant(h.db, eventId, { first_name: 'Tony', clerk_user_id: TONY });
    expect((await joinQueue(TONY)).status).toBe(200);

    await del();

    expect(count('SELECT COUNT(*) n FROM year_members WHERE clerk_user_id = ?', TONY)).toBe(1);
    expect(count('SELECT COUNT(*) n FROM purchase_queue WHERE clerk_user_id = ?', TONY)).toBe(1);
  });

  it("won't delete the year's owner", async () => {
    h.db.prepare("UPDATE year_members SET role = 'owner' WHERE id = ?").run(memberId);
    expect((await del()).status).toBe(400);
  });

  it('is admin-only', async () => {
    const res = await h.request(`/api/admin/years/${yearId}/members/${memberId}`, { method: 'DELETE', as: TONY });
    expect(res.status).toBe(401);
  });
});

describe('clearing the Queue-It line', () => {
  beforeEach(() => {
    insertParticipant(h.db, eventId, { first_name: 'Tony', clerk_user_id: TONY });
    insertParticipant(h.db, eventId, { first_name: 'Henry', clerk_user_id: HENRY });
    h.db.prepare("UPDATE events SET status = 'purchasing' WHERE id = ?").run(eventId);
  });

  it('removes every place on that event only', async () => {
    const other = insertEvent(h.db, { year_id: yearId, reg_type: 'open', name: 'Open' });
    insertParticipant(h.db, other, { first_name: 'Tony', clerk_user_id: TONY });
    await joinQueue(TONY);
    await joinQueue(HENRY);
    await h.request(`/api/events/${other}/purchase-queue/join`, { method: 'POST', as: TONY, body: '{}' });

    const res = await h.request(`/api/admin/events/${eventId}/purchase-queue`, { method: 'DELETE', adminSecret: true });
    expect(await res.json()).toEqual({ ok: true, cleared: 2 });
    expect(count('SELECT COUNT(*) n FROM purchase_queue WHERE event_id = ?', eventId)).toBe(0);
    expect(count('SELECT COUNT(*) n FROM purchase_queue WHERE event_id = ?', other)).toBe(1);
  });

  it('is admin-only', async () => {
    const res = await h.request(`/api/admin/events/${eventId}/purchase-queue`, { method: 'DELETE', as: TONY });
    expect(res.status).toBe(401);
  });
});
