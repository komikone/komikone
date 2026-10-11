/**
 * Shared invite links: one code a whole group can join with, up to a cap. Personal
 * invites must keep behaving exactly as before.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, insertEvent, insertInvite, insertYear, insertYearMember, type TestHarness } from './harness';

let h: TestHarness;
let yearId: number;

beforeEach(async () => {
  h = await createHarness();
  yearId = insertYear(h.db);
  insertEvent(h.db, { year_id: yearId, status: 'registration' });
});

afterEach(() => {
  h.close();
});

const invite = (code: string) =>
  h.db.prepare('SELECT use_count, used_at, used_by_clerk_user_id, max_uses FROM invites WHERE code = ?').get(code) as {
    use_count: number; used_at: string | null; used_by_clerk_user_id: string | null; max_uses: number;
  };

let seq = 0;
function accept(code: string, as: string) {
  seq += 1;
  return h.request(`/api/invites/${code}/accept`, {
    method: 'POST', as,
    body: JSON.stringify({ first_name: `Friend${seq}`, last_name: 'Test', member_id: `FRND${seq}` }),
  });
}

async function createShared(maxUses: number): Promise<string> {
  const res = await h.request(`/api/admin/years/${yearId}/invites`, {
    method: 'POST', adminSecret: true, body: JSON.stringify({ label: 'Group link', max_uses: maxUses }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { invite: { code: string } }).invite.code;
}

describe('shared invite links', () => {
  it('lets several people join with one code until it is full', async () => {
    const code = await createShared(2);

    expect((await accept(code, 'user_a')).status).toBe(201);
    expect(invite(code)).toMatchObject({ use_count: 1, used_at: null, used_by_clerk_user_id: null });

    expect((await accept(code, 'user_b')).status).toBe(201);
    expect(invite(code).use_count).toBe(2);
    expect(invite(code).used_at).not.toBeNull();

    const full = await accept(code, 'user_c');
    expect(full.status).toBe(409);
    expect(((await full.json()) as { error: string }).error).toMatch(/full/);
    expect((await h.request(`/api/invites/${code}`)).status).toBe(409);

    const members = h.db.prepare('SELECT COUNT(*) n FROM year_members WHERE year_id = ?').get(yearId) as { n: number };
    expect(members.n).toBe(2);
  });

  it("doesn't spend a slot on someone who is already a member", async () => {
    const code = await createShared(5);
    insertYearMember(h.db, yearId, 'user_existing');

    expect((await accept(code, 'user_existing')).status).toBe(200);
    expect(invite(code).use_count).toBe(0);
  });

  it('caps the size and refuses to email a shared link', async () => {
    const res = await h.request(`/api/admin/years/${yearId}/invites`, {
      method: 'POST', adminSecret: true, body: JSON.stringify({ max_uses: 99999 }),
    });
    expect(((await res.json()) as { invite: { max_uses: number } }).invite.max_uses).toBe(500);

    const emailed = await h.request(`/api/admin/years/${yearId}/invites`, {
      method: 'POST', adminSecret: true, body: JSON.stringify({ max_uses: 10, email: 'a@example.com' }),
    });
    expect(emailed.status).toBe(400);
  });
});

describe('personal invites', () => {
  it('are still single-use and record who used them', async () => {
    insertInvite(h.db, yearId, 'PERSONAL1234', 'admin');

    expect((await accept('PERSONAL1234', 'user_a')).status).toBe(201);
    expect(invite('PERSONAL1234')).toMatchObject({ use_count: 1, used_by_clerk_user_id: 'user_a', max_uses: 1 });
    expect(invite('PERSONAL1234').used_at).not.toBeNull();

    const again = await accept('PERSONAL1234', 'user_b');
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toBe('This invite has already been used');
  });
});
