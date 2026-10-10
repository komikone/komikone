/**
 * Onboarding route tests.
 *
 * Every incomplete row on the live board so far came from one place: a group owner adding
 * a family member. That form accepted a name and nothing else, so people arrived with no
 * Member ID and no badge days and could not be bought for on purchase day. These cover the
 * validation that closes that gap, plus the email fallback that links someone to their
 * existing row when they later sign up for their own account.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createHarness,
  getParticipant,
  insertEvent,
  insertGroup,
  insertInvite,
  insertParticipant,
  insertYear,
  insertYearMember,
  setClerkUserEmail,
  type TestHarness,
} from './harness';

const HENRY = 'user_henry';
const DAVID = 'user_david';

let h: TestHarness;

beforeEach(async () => {
  h = await createHarness();
});

afterEach(() => {
  h.close();
});

/** A year with one registration-phase event and Henry as a member who owns a group. */
function seedYearWithOwner(over: { reg_type?: 'return' | 'open'; status?: string } = {}) {
  const yearId = insertYear(h.db);
  const eventId = insertEvent(h.db, {
    year_id: yearId,
    reg_type: over.reg_type ?? 'return',
    status: over.status ?? 'registration',
  });
  insertYearMember(h.db, yearId, HENRY);
  const groupId = insertGroup(h.db, eventId, HENRY);
  return { yearId, eventId, groupId };
}

function addPerson(yearId: number, eventId: number, body: Record<string, unknown>, as = HENRY) {
  return h.request(`/api/years/${yearId}/events/${eventId}/my-group/participants`, {
    method: 'POST',
    as,
    body: JSON.stringify(body),
  });
}

describe('POST /my-group/participants', () => {
  it('rejects a person with no Member ID on a return event', async () => {
    const { yearId, eventId } = seedYearWithOwner({ reg_type: 'return' });

    const res = await addPerson(yearId, eventId, {
      first_name: 'David',
      last_name: 'Garcia',
      req_sat: true,
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: 'Member ID is required for return registration',
    });
  });

  it('allows a blank Member ID on an open event', async () => {
    const { yearId, eventId } = seedYearWithOwner({ reg_type: 'open' });

    const res = await addPerson(yearId, eventId, {
      first_name: 'David',
      last_name: 'Garcia',
      req_sat: true,
    });

    expect(res.status).toBe(201);
  });

  it('rejects a person with no badge days during registration', async () => {
    const { yearId, eventId } = seedYearWithOwner();

    const res = await addPerson(yearId, eventId, {
      first_name: 'Karen',
      last_name: 'Sosa',
      member_id: 'KSOSA01',
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'Select at least one badge day' });
  });

  it('stores requested days, email, and return eligibility', async () => {
    const { yearId, eventId, groupId } = seedYearWithOwner();

    const res = await addPerson(yearId, eventId, {
      first_name: 'David',
      last_name: 'Garcia',
      member_id: 'DGARC01',
      email: 'David@Example.com',
      return_eligible: true,
      req_fri: true,
      req_sat: true,
    });

    expect(res.status).toBe(201);
    const created = await res.json() as { id: number };
    const row = getParticipant(h.db, created.id);

    expect(row.member_id).toBe('DGARC01');
    expect(row.email).toBe('david@example.com');
    expect(row.return_eligible).toBe(1);
    expect(row.group_id).toBe(groupId);
    expect([row.req_preview, row.req_thu, row.req_fri, row.req_sat, row.req_sun])
      .toEqual([0, 0, 1, 1, 0]);
  });

  it('applies days when adopting an existing row by Member ID', async () => {
    const { yearId, eventId, groupId } = seedYearWithOwner();
    const pid = insertParticipant(h.db, eventId, {
      first_name: 'David',
      last_name: 'Garcia',
      member_id: 'DGARC01',
      req_sat: 0,
      req_sun: 0,
      group_id: null,
    });

    const res = await addPerson(yearId, eventId, {
      first_name: 'David',
      last_name: 'Garcia',
      member_id: 'DGARC01',
      req_sun: true,
    });

    expect(res.status).toBe(201);
    const row = getParticipant(h.db, pid);
    expect(row.group_id).toBe(groupId);
    expect(row.req_sun).toBe(1);
    expect(row.req_sat).toBe(0);
  });

  it('refuses to adopt a row that belongs to another account', async () => {
    const { yearId, eventId } = seedYearWithOwner();
    insertParticipant(h.db, eventId, {
      member_id: 'TAKEN01',
      clerk_user_id: 'user_someone_else',
    });

    const res = await addPerson(yearId, eventId, {
      first_name: 'David',
      last_name: 'Garcia',
      member_id: 'TAKEN01',
      req_sat: true,
    });

    expect(res.status).toBe(409);
  });

  it('requires year membership', async () => {
    const { yearId, eventId } = seedYearWithOwner();

    const res = await addPerson(yearId, eventId, {
      first_name: 'David',
      last_name: 'Garcia',
      member_id: 'DGARC01',
      req_sat: true,
    }, 'user_stranger');

    expect(res.status).toBe(403);
  });
});

describe('POST /invites/:code/accept — identity linking', () => {
  it('links to the row a group owner created for them, matched on email', async () => {
    const yearId = insertYear(h.db);
    const eventId = insertEvent(h.db, { year_id: yearId, status: 'registration' });
    insertYearMember(h.db, yearId, HENRY);
    const groupId = insertGroup(h.db, eventId, HENRY);
    insertInvite(h.db, yearId, 'JOINCODE1234', HENRY);

    // Henry added David earlier and recorded his email, but David had no Member ID.
    const existingPid = insertParticipant(h.db, eventId, {
      first_name: 'David',
      last_name: 'Garcia',
      member_id: '',
      email: 'david@example.com',
      group_id: groupId,
      clerk_user_id: null,
    });

    setClerkUserEmail(DAVID, 'david@example.com');

    const res = await h.request('/api/invites/JOINCODE1234/accept', {
      method: 'POST',
      as: DAVID,
      body: JSON.stringify({ first_name: 'David', last_name: 'Garcia', member_id: 'DGARC99' }),
    });

    expect(res.status).toBe(201);

    // The pre-existing row is now David's, rather than a second row being created.
    const row = getParticipant(h.db, existingPid);
    expect(row.clerk_user_id).toBe(DAVID);
    expect(row.member_id).toBe('DGARC99');

    const count = h.db.prepare(
      'SELECT COUNT(*) AS n FROM participants WHERE event_id = ? AND last_name = ?'
    ).get(eventId, 'Garcia') as { n: number };
    expect(count.n).toBe(1);
  });

  it('does not hijack a row already linked to someone else', async () => {
    const yearId = insertYear(h.db);
    const eventId = insertEvent(h.db, { year_id: yearId, status: 'registration' });
    insertYearMember(h.db, yearId, HENRY);
    insertInvite(h.db, yearId, 'JOINCODE5678', HENRY);

    const takenPid = insertParticipant(h.db, eventId, {
      first_name: 'David',
      last_name: 'Garcia',
      member_id: 'OTHER01',
      email: 'david@example.com',
      clerk_user_id: 'user_someone_else',
    });

    setClerkUserEmail(DAVID, 'david@example.com');

    const res = await h.request('/api/invites/JOINCODE5678/accept', {
      method: 'POST',
      as: DAVID,
      body: JSON.stringify({ first_name: 'David', last_name: 'Garcia' }),
    });

    expect(res.status).toBe(201);
    expect(getParticipant(h.db, takenPid).clerk_user_id).toBe('user_someone_else');
  });

  it('still works when Clerk has no email on file', async () => {
    const yearId = insertYear(h.db);
    const eventId = insertEvent(h.db, { year_id: yearId, status: 'registration' });
    insertYearMember(h.db, yearId, HENRY);
    insertInvite(h.db, yearId, 'JOINCODE9999', HENRY);

    const res = await h.request('/api/invites/JOINCODE9999/accept', {
      method: 'POST',
      as: DAVID,
      body: JSON.stringify({ first_name: 'David', last_name: 'Garcia', member_id: 'DGARC77' }),
    });

    expect(res.status).toBe(201);
    const row = h.db.prepare(
      'SELECT clerk_user_id, email FROM participants WHERE event_id = ? AND member_id = ?'
    ).get(eventId, 'DGARC77') as { clerk_user_id: string; email: string };
    expect(row.clerk_user_id).toBe(DAVID);
    expect(row.email).toBe('');
  });
});
