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
      body: JSON.stringify({ first_name: 'David', last_name: 'Garcia', member_id: 'DGARC88' }),
    });

    expect(res.status).toBe(201);
    expect(getParticipant(h.db, takenPid).clerk_user_id).toBe('user_someone_else');
  });

  it('takes the Member ID they typed over a stale one an organizer recorded', async () => {
    const yearId = insertYear(h.db);
    const eventId = insertEvent(h.db, { year_id: yearId, status: 'registration' });
    insertYearMember(h.db, yearId, HENRY);
    insertInvite(h.db, yearId, 'JOINCODE2222', HENRY);

    // Imported from last year's roster, where the ID was recorded wrong.
    const pid = insertParticipant(h.db, eventId, {
      first_name: 'Andre',
      last_name: 'Velazquez',
      member_id: 'ANDRE VELAZQUEZ',
      email: 'andre@example.com',
      clerk_user_id: null,
    });

    setClerkUserEmail(DAVID, 'andre@example.com');

    const res = await h.request('/api/invites/JOINCODE2222/accept', {
      method: 'POST',
      as: DAVID,
      body: JSON.stringify({ first_name: 'Andre', last_name: 'Velazquez', member_id: 'ANDREV123' }),
    });

    expect(res.status).toBe(201);
    expect(getParticipant(h.db, pid).member_id).toBe('ANDREV123');
  });

  it('adopts the row already holding their Member ID rather than the one matched by email', async () => {
    const yearId = insertYear(h.db);
    const eventId = insertEvent(h.db, { year_id: yearId, status: 'registration' });
    insertYearMember(h.db, yearId, HENRY);
    insertInvite(h.db, yearId, 'JOINCODE3333', HENRY);

    const byMemberId = insertParticipant(h.db, eventId, {
      member_id: 'ANDREV123',
      clerk_user_id: null,
    });
    const byEmail = insertParticipant(h.db, eventId, {
      member_id: 'ANDRE VELAZQUEZ',
      email: 'andre@example.com',
      clerk_user_id: null,
    });

    setClerkUserEmail(DAVID, 'andre@example.com');

    const res = await h.request('/api/invites/JOINCODE3333/accept', {
      method: 'POST',
      as: DAVID,
      body: JSON.stringify({ first_name: 'Andre', last_name: 'Velazquez', member_id: 'ANDREV123' }),
    });

    // Member ID wins over email, so the stale duplicate is left alone for a human to merge
    // rather than being silently overwritten into a unique-index violation.
    expect(res.status).toBe(201);
    expect(getParticipant(h.db, byMemberId).clerk_user_id).toBe(DAVID);
    expect(getParticipant(h.db, byEmail).clerk_user_id).toBeNull();
  });

  it('refuses to hand over a row whose Member ID belongs to another account', async () => {
    const yearId = insertYear(h.db);
    const eventId = insertEvent(h.db, { year_id: yearId, status: 'registration' });
    insertYearMember(h.db, yearId, HENRY);
    insertInvite(h.db, yearId, 'JOINCODE4444', HENRY);

    const victim = insertParticipant(h.db, eventId, {
      first_name: 'Henry',
      last_name: 'Garcia',
      member_id: 'HGARC014',
      clerk_user_id: 'user_henry_account',
    });

    const res = await h.request('/api/invites/JOINCODE4444/accept', {
      method: 'POST',
      as: DAVID,
      body: JSON.stringify({ first_name: 'Not', last_name: 'Henry', member_id: 'HGARC014' }),
    });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: 'That Member ID is already registered to another account',
    });

    expect(getParticipant(h.db, victim).clerk_user_id).toBe('user_henry_account');
    expect(getParticipant(h.db, victim).first_name).toBe('Henry');

    // Nothing was written, so the real owner of this invite can still use it.
    const invite = h.db.prepare('SELECT used_at FROM invites WHERE code = ?')
      .get('JOINCODE4444') as { used_at: string | null };
    expect(invite.used_at).toBeNull();
  });

  it('refuses to accept without a Member ID, which the board requires', async () => {
    const yearId = insertYear(h.db);
    insertEvent(h.db, { year_id: yearId, status: 'registration' });
    insertYearMember(h.db, yearId, HENRY);
    insertInvite(h.db, yearId, 'JOINCODE0001', HENRY);

    const res = await h.request('/api/invites/JOINCODE0001/accept', {
      method: 'POST',
      as: DAVID,
      body: JSON.stringify({ first_name: 'David', last_name: 'Garcia' }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'SDCC Member ID is required' });

    // The invite must stay usable so they can retry with their ID.
    const invite = h.db.prepare('SELECT used_at FROM invites WHERE code = ?')
      .get('JOINCODE0001') as { used_at: string | null };
    expect(invite.used_at).toBeNull();
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

describe('admin participant email', () => {
  it('stores a lowercased email that then links a signup to the row', async () => {
    const yearId = insertYear(h.db);
    const eventId = insertEvent(h.db, { year_id: yearId, status: 'registration' });
    insertYearMember(h.db, yearId, HENRY);
    insertInvite(h.db, yearId, 'JOINCODE5555', HENRY);

    // Imported from last year's roster with no email, the way the Oct 17 board was seeded.
    const pid = insertParticipant(h.db, eventId, {
      first_name: 'Ken',
      last_name: 'Cabaong',
      member_id: 'T4477UCWY',
      email: '',
    });

    const patch = await h.request(`/api/admin/events/${eventId}/participants/${pid}`, {
      method: 'PATCH',
      adminSecret: true,
      body: JSON.stringify({ email: 'KCaba5@Yahoo.com' }),
    });
    expect(patch.status).toBe(200);
    expect(getParticipant(h.db, pid).email).toBe('kcaba5@yahoo.com');

    // With the email on file, a signup links even when the Member ID is mistyped.
    setClerkUserEmail(DAVID, 'kcaba5@yahoo.com');
    const res = await h.request('/api/invites/JOINCODE5555/accept', {
      method: 'POST',
      as: DAVID,
      body: JSON.stringify({ first_name: 'Ken', last_name: 'Cabaong', member_id: 'TYPO999' }),
    });

    expect(res.status).toBe(201);
    const row = getParticipant(h.db, pid);
    expect(row.clerk_user_id).toBe(DAVID);
    expect(row.member_id).toBe('TYPO999');

    const count = h.db.prepare(
      'SELECT COUNT(*) AS n FROM participants WHERE event_id = ? AND last_name = ?'
    ).get(eventId, 'Cabaong') as { n: number };
    expect(count.n).toBe(1);
  });
});

describe('GET /invites/:code/prefill', () => {
  /** Henry recorded David's details ahead of time against david@example.com. */
  function seedPreEntered(over: { email?: string; clerk_user_id?: string | null } = {}) {
    const yearId = insertYear(h.db);
    const eventId = insertEvent(h.db, { year_id: yearId, status: 'registration' });
    insertYearMember(h.db, yearId, HENRY);
    const groupId = insertGroup(h.db, eventId, HENRY);
    insertInvite(h.db, yearId, 'PREFILL00001', HENRY);
    const pid = insertParticipant(h.db, eventId, {
      first_name: 'David',
      last_name: 'Garcia',
      member_id: 'DGARC01',
      badge_type: 'JUNIOR',
      return_eligible: 1,
      email: over.email ?? 'david@example.com',
      group_id: groupId,
      clerk_user_id: over.clerk_user_id ?? null,
    });
    return { yearId, eventId, pid };
  }

  const getPrefill = (as?: string) =>
    h.request('/api/invites/PREFILL00001/prefill', as ? { as } : {});

  it('returns what the organizer recorded for the signer\'s verified email', async () => {
    seedPreEntered();
    setClerkUserEmail(DAVID, 'david@example.com');

    const res = await getPrefill(DAVID);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      prefill: {
        first_name: 'David',
        last_name: 'Garcia',
        member_id: 'DGARC01',
        badge_type: 'JUNIOR',
        return_eligible: true,
      },
    });
  });

  it('matches case-insensitively on the recorded email', async () => {
    seedPreEntered({ email: 'david@example.com' });
    setClerkUserEmail(DAVID, 'DAVID@Example.com');

    const res = await getPrefill(DAVID);

    const body = await res.json() as { prefill: { member_id: string } | null };
    expect(body.prefill?.member_id).toBe('DGARC01');
  });

  it('discloses nothing when no row matches the signer', async () => {
    seedPreEntered({ email: 'someone.else@example.com' });
    setClerkUserEmail(DAVID, 'david@example.com');

    await expect((await getPrefill(DAVID)).json()).resolves.toEqual({ prefill: null });
  });

  it('discloses nothing for a row already claimed by another account', async () => {
    seedPreEntered({ clerk_user_id: 'user_someone_else' });
    setClerkUserEmail(DAVID, 'david@example.com');

    await expect((await getPrefill(DAVID)).json()).resolves.toEqual({ prefill: null });
  });

  it('discloses nothing when Clerk has no verified email for the signer', async () => {
    seedPreEntered();

    await expect((await getPrefill(DAVID)).json()).resolves.toEqual({ prefill: null });
  });

  it('requires sign-in, so the invite code alone reveals no personal details', async () => {
    seedPreEntered();

    expect((await getPrefill()).status).toBe(401);
  });

  it('404s on an unknown invite code', async () => {
    seedPreEntered();
    setClerkUserEmail(DAVID, 'david@example.com');

    const res = await h.request('/api/invites/NOSUCHCODE12/prefill', { as: DAVID });
    expect(res.status).toBe(404);
  });
});
