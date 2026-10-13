/**
 * Admin fixes: editing someone's profile, handing a place in line to someone else,
 * changing who owns a group, and correcting purchases nobody holds a claim on.
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
  insertYearMember,
  type TestHarness,
} from './harness';

const ADMIN = 'user_admin';
const TONY = 'user_tony';
const HENRY = 'user_henry';

let h: TestHarness;

beforeEach(async () => {
  h = await createHarness();
});

afterEach(() => {
  h.close();
});

describe('PATCH /admin/years/:yearId/members/:memberId', () => {
  it("updates the profile and copies it to the person's rows on every event that year", async () => {
    const yearId = insertYear(h.db);
    const ret = insertEvent(h.db, { year_id: yearId });
    const open = insertEvent(h.db, { year_id: yearId, reg_type: 'open', name: 'SDCC 2027 Open Reg' });
    const memberId = insertYearMember(h.db, yearId, HENRY);
    const retRow = insertParticipant(h.db, ret, { first_name: 'Henry', clerk_user_id: HENRY, member_id: 'HGARC014' });
    const openRow = insertParticipant(h.db, open, { first_name: 'Henry', clerk_user_id: HENRY, member_id: 'HGARC014' });

    const res = await h.request(`/api/admin/years/${yearId}/members/${memberId}`, {
      method: 'PATCH',
      as: ADMIN,
      asAdmin: true,
      body: JSON.stringify({ first_name: 'Hank', member_id: 'hgarc999', badge_type: 'JUNIOR', role: 'admin' }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      first_name: 'Hank', last_name: 'Garcia', member_id: 'HGARC999', badge_type: 'JUNIOR', role: 'admin',
    });
    for (const row of [retRow, openRow]) {
      expect(getParticipant(h.db, row)).toMatchObject({ first_name: 'Hank', member_id: 'HGARC999', badge_type: 'JUNIOR' });
    }
  });

  it('refuses non-admins', async () => {
    const yearId = insertYear(h.db);
    const memberId = insertYearMember(h.db, yearId, HENRY);
    const res = await h.request(`/api/admin/years/${yearId}/members/${memberId}`, {
      method: 'PATCH', as: TONY, body: JSON.stringify({ first_name: 'Hank' }),
    });
    expect(res.status).toBe(401);
  });

  it("won't take the owner role away from the year's owner", async () => {
    const yearId = insertYear(h.db);
    const memberId = insertYearMember(h.db, yearId, HENRY);
    h.db.prepare("UPDATE year_members SET role = 'owner' WHERE id = ?").run(memberId);
    const res = await h.request(`/api/admin/years/${yearId}/members/${memberId}`, {
      method: 'PATCH', adminSecret: true, body: JSON.stringify({ role: 'registered' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('PATCH /admin/events/:id/purchase-queue/:qid/owner', () => {
  it('hands the place over, freeing open claims but keeping people it already bought for', async () => {
    const eventId = insertEvent(h.db);
    const tony = insertParticipant(h.db, eventId, { first_name: 'Tony', clerk_user_id: TONY });
    const henry = insertParticipant(h.db, eventId, { first_name: 'Henry', clerk_user_id: HENRY });
    const place = insertPlace(h.db, eventId, tony, TONY);
    const now = new Date().toISOString();
    const claimed = insertParticipant(h.db, eventId, {
      purchasing_claimed_by: 'Tony Nguyen', purchasing_claimed_at: now, purchasing_claimed_queue_id: place,
    });
    const bought = insertParticipant(h.db, eventId, {
      pur_sat: 1, who_purchased: 'Tony Nguyen', purchasing_claimed_queue_id: place,
    });

    const res = await h.request(`/api/admin/events/${eventId}/purchase-queue/${place}/owner`, {
      method: 'PATCH', adminSecret: true, body: JSON.stringify({ clerk_user_id: HENRY }),
    });

    expect(res.status).toBe(200);
    const row = h.db.prepare('SELECT clerk_user_id, participant_id FROM purchase_queue WHERE id = ?').get(place);
    expect({ ...row }).toEqual({ clerk_user_id: HENRY, participant_id: henry });
    expect(getParticipant(h.db, claimed)).toMatchObject({ purchasing_claimed_by: '', purchasing_claimed_queue_id: null });
    expect(getParticipant(h.db, bought)).toMatchObject({ purchasing_claimed_queue_id: place, pur_sat: 1 });
  });

  it("refuses an owner who isn't on the event's board", async () => {
    const eventId = insertEvent(h.db);
    const tony = insertParticipant(h.db, eventId, { clerk_user_id: TONY });
    const place = insertPlace(h.db, eventId, tony, TONY);
    const res = await h.request(`/api/admin/events/${eventId}/purchase-queue/${place}/owner`, {
      method: 'PATCH', adminSecret: true, body: JSON.stringify({ clerk_user_id: HENRY }),
    });
    expect(res.status).toBe(400);
  });
});

describe('PATCH /admin/events/:id/groups/:gid', () => {
  it('changes the owner to someone on the board', async () => {
    const eventId = insertEvent(h.db);
    insertParticipant(h.db, eventId, { clerk_user_id: TONY });
    const gid = insertGroup(h.db, eventId, HENRY);
    const res = await h.request(`/api/admin/events/${eventId}/groups/${gid}`, {
      method: 'PATCH', adminSecret: true, body: JSON.stringify({ owner_clerk_user_id: TONY }),
    });
    expect(res.status).toBe(200);
    const row = h.db.prepare('SELECT owner_clerk_user_id FROM groups WHERE id = ?').get(gid) as { owner_clerk_user_id: string };
    expect(row.owner_clerk_user_id).toBe(TONY);
  });

  it("refuses an owner who isn't on the board", async () => {
    const eventId = insertEvent(h.db);
    const gid = insertGroup(h.db, eventId, HENRY);
    const res = await h.request(`/api/admin/events/${eventId}/groups/${gid}`, {
      method: 'PATCH', adminSecret: true, body: JSON.stringify({ owner_clerk_user_id: TONY }),
    });
    expect(res.status).toBe(400);
  });
});

describe('PATCH /participants/:pid/purchased as an admin', () => {
  it('records a purchase nobody holds a claim on', async () => {
    const eventId = insertEvent(h.db);
    const pid = insertParticipant(h.db, eventId, { req_sat: 1, req_sun: 1 });
    const res = await h.request(`/api/events/${eventId}/participants/${pid}/purchased`, {
      method: 'PATCH', as: ADMIN, asAdmin: true, body: JSON.stringify({ pur_sun: true }),
    });
    expect(res.status).toBe(200);
    expect(getParticipant(h.db, pid)).toMatchObject({ pur_sun: 1 });
  });
});
