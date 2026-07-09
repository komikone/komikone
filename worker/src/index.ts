import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { type Event, type Participant, type Coordinator, type YearMeta, type Group, type InviteRequest, type Profile, type Year, type YearMember, type Invite, enrichParticipant, isClaimExpired } from './db';

type Bindings = {
  DB: D1Database;
  ADMIN_SECRET: string;
  FRONTEND_URL: string;
  CLERK_JWKS_URL: string;
};

// ── Clerk JWT verification ────────────────────────────────────────────────────

type ClerkClaims = {
  sub: string;
  public_metadata?: Record<string, unknown>;
};

let jwksCache: { keys: (JsonWebKey & { kid?: string })[] } | null = null;

async function verifyClerkJWT(token: string, jwksUrl: string): Promise<ClerkClaims | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [h, p, s] = parts;
    const decode = (b64: string) => JSON.parse(atob(b64.replace(/-/g, '+').replace(/_/g, '/')));
    const header = decode(h) as { kid?: string };
    const payload = decode(p) as ClerkClaims & { exp: number };
    if (payload.exp < Date.now() / 1000) return null;
    if (!jwksCache) {
      const res = await fetch(jwksUrl);
      jwksCache = await res.json() as { keys: (JsonWebKey & { kid?: string })[] };
    }
    const jwk = jwksCache.keys.find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey(
      'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']
    );
    const sig = Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    const data = new TextEncoder().encode(`${h}.${p}`);
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, data);
    return valid ? payload : null;
  } catch {
    return null;
  }
}

async function getClerkUserId(c: { req: { header: (k: string) => string | undefined } }, jwksUrl: string): Promise<string | null> {
  const auth = c.req.header('authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  const claims = await verifyClerkJWT(token, jwksUrl);
  return claims?.sub ?? null;
}

async function authenticate(
  c: { req: { header: (k: string) => string | undefined } },
  adminSecret: string,
  jwksUrl: string
): Promise<{ isAdmin: boolean; userId: string } | null> {
  const authHeader = c.req.header('authorization') ?? '';
  if (adminSecret && authHeader === `Bearer ${adminSecret}`) {
    return { isAdmin: true, userId: 'admin' };
  }
  if (!authHeader.startsWith('Bearer ')) return null;
  const claims = await verifyClerkJWT(authHeader.slice(7), jwksUrl);
  if (!claims) return null;
  const isAdmin = claims.public_metadata?.role === 'admin';
  return { isAdmin, userId: claims.sub };
}

const app = new Hono<{ Bindings: Bindings }>();

app.use('*', async (c, next) => {
  const origin = c.req.header('origin') || '';
  const allowed = [c.env.FRONTEND_URL, 'http://localhost:5173', 'http://localhost:3000'];
  return cors({
    origin: (o) => (allowed.includes(o) ? o : allowed[0]),
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86400,
  })(c, next);
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function json<T>(data: T, status = 200) {
  return Response.json(data, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

function err(msg: string, status = 400) {
  return Response.json({ error: msg }, { status, headers: { 'Cache-Control': 'no-store' } });
}

function mapYearMember(row: YearMember) {
  return { ...row, return_eligible: !!row.return_eligible };
}

async function getEvent(db: D1Database, id: number): Promise<Event | null> {
  return db.prepare('SELECT * FROM events WHERE id = ?').bind(id).first<Event>();
}

const PARTICIPANTS_QUERY = `
  SELECT p.*, g.name AS group_name, g.color AS group_color
  FROM participants p
  LEFT JOIN groups g ON g.id = p.group_id
`;

// Avoids confusable chars (0/O, 1/I)
const INVITE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateInviteCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes).map(b => INVITE_CHARS[b % INVITE_CHARS.length]).join('');
}

async function createUniqueInvite(
  db: D1Database, yearId: number, label: string, invitedBy: string,
): Promise<Invite> {
  let code = '';
  for (let i = 0; i < 8; i++) {
    code = generateInviteCode();
    const existing = await db.prepare('SELECT id FROM invites WHERE code = ?').bind(code).first();
    if (!existing) break;
    if (i === 7) throw new Error('Failed to generate unique invite code');
  }
  await db.prepare(
    'INSERT INTO invites (year_id, code, label, invited_by_clerk_user_id) VALUES (?, ?, ?, ?)'
  ).bind(yearId, code, label, invitedBy).run();
  const invite = await db.prepare('SELECT * FROM invites WHERE code = ?').bind(code).first<Invite>();
  if (!invite) throw new Error('Failed to create invite');
  return invite;
}

const GROUP_COLORS = [
  '#6366f1', '#10b981', '#f43f5e', '#f59e0b',
  '#0ea5e9', '#a855f7', '#f97316', '#14b8a6',
  '#ec4899', '#84cc16',
];

async function pickGroupColor(db: D1Database, yearId: number): Promise<string> {
  const row = await db.prepare(
    `SELECT COUNT(*) as cnt FROM groups g
     JOIN events e ON e.id = g.event_id
     WHERE e.year_id = ?`
  ).bind(yearId).first<{ cnt: number }>();
  return GROUP_COLORS[(row?.cnt ?? 0) % GROUP_COLORS.length];
}

// ── Public routes ─────────────────────────────────────────────────────────────

app.post('/api/invite-requests', async (c) => {
  const body = await c.req.json<{ email: string; referred_by: string; notes?: string }>();
  if (!body.email?.trim()) return err('Email is required');
  if (!body.referred_by?.trim()) return err('Please tell us who referred you');

  const existing = await c.env.DB.prepare(
    "SELECT id FROM invite_requests WHERE LOWER(email) = LOWER(?) AND status = 'pending'"
  ).bind(body.email.trim()).first();
  if (existing) return err('A pending request from this email already exists', 409);

  await c.env.DB.prepare(
    'INSERT INTO invite_requests (email, referred_by, notes) VALUES (?, ?, ?)'
  ).bind(body.email.trim().toLowerCase(), body.referred_by.trim(), body.notes?.trim() ?? '').run();

  return json({ ok: true }, 201);
});

app.get('/api/events', async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT id, year, name, reg_type, status FROM events ORDER BY year DESC, id DESC'
  ).all<Pick<Event, 'id' | 'year' | 'name' | 'reg_type' | 'status'>>();
  return json(rows.results);
});

// ── Authenticated event routes ─────────────────────────────────────────────────

app.get('/api/events/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const access = await authenticate(c, c.env.ADMIN_SECRET, c.env.CLERK_JWKS_URL ?? '');
  if (!access) return err('Authentication required', 401);

  const event = await getEvent(c.env.DB, id);
  if (!event) return err('Event not found', 404);
  return json(event);
});

app.get('/api/events/:id/participants', async (c) => {
  const id = Number(c.req.param('id'));
  const access = await authenticate(c, c.env.ADMIN_SECRET, c.env.CLERK_JWKS_URL ?? '');
  if (!access) return err('Authentication required', 401);

  const event = await getEvent(c.env.DB, id);
  if (!event) return err('Event not found', 404);

  const rows = await c.env.DB.prepare(
    `${PARTICIPANTS_QUERY} WHERE p.event_id = ? ORDER BY p.sort_order ASC, p.id ASC`
  ).bind(id).all<Participant>();

  return json(rows.results.map((p) => enrichParticipant(p, event)));
});

// Register self (requires Clerk auth + event in registration status)
app.post('/api/events/:id/register', async (c) => {
  const id = Number(c.req.param('id'));
  const access = await authenticate(c, c.env.ADMIN_SECRET, c.env.CLERK_JWKS_URL ?? '');
  if (!access) return err('Authentication required', 401);

  const event = await getEvent(c.env.DB, id);
  if (!event) return err('Event not found', 404);
  if (event.status !== 'registration') return err('Registration is not open', 403);

  const clerkUserId = access.userId === 'admin' ? null : access.userId;
  if (clerkUserId) {
    const yearRow = await c.env.DB.prepare(
      'SELECT id FROM years WHERE con_year = ?'
    ).bind(event.year).first<{ id: number }>();
    if (yearRow) {
      const member = await c.env.DB.prepare(
        'SELECT id FROM year_members WHERE year_id = ? AND clerk_user_id = ?'
      ).bind(yearRow.id, clerkUserId).first();
      if (!member) {
        return err('An invite is required before you can register. Use your invite link or request access.', 403);
      }
    }
  }

  const body = await c.req.json<{
    first_name: string;
    last_name: string;
    member_id?: string;
    badge_type?: string;
    req_preview?: boolean;
    req_thu?: boolean;
    req_fri?: boolean;
    req_sat?: boolean;
    req_sun?: boolean;
  }>();

  if (!body.first_name?.trim() || !body.last_name?.trim()) {
    return err('First and last name required');
  }

  const badgeType = body.badge_type === 'JUNIOR' ? 'JUNIOR' : 'ADULT';
  const firstName = body.first_name.trim();
  const lastName = body.last_name.trim();
  const memberId = body.member_id?.trim() ?? '';
  const reqPreview = body.req_preview ? 1 : 0;
  const reqThu = body.req_thu ? 1 : 0;
  const reqFri = body.req_fri ? 1 : 0;
  const reqSat = body.req_sat ? 1 : 0;
  const reqSun = body.req_sun ? 1 : 0;

  // Update existing linked participant (invite flow or re-submitting days)
  if (clerkUserId) {
    const existing = await c.env.DB.prepare(
      'SELECT id FROM participants WHERE event_id = ? AND clerk_user_id = ?'
    ).bind(id, clerkUserId).first<{ id: number }>();

    if (existing) {
      await c.env.DB.prepare(`
        UPDATE participants SET
          first_name = ?, last_name = ?, member_id = ?, badge_type = ?,
          req_preview = ?, req_thu = ?, req_fri = ?, req_sat = ?, req_sun = ?,
          updated_at = datetime('now')
        WHERE id = ?
      `).bind(
        firstName, lastName, memberId, badgeType,
        reqPreview, reqThu, reqFri, reqSat, reqSun,
        existing.id,
      ).run();
      return json({ ok: true, id: existing.id, updated: true });
    }
  }

  let result;
  try {
    result = await c.env.DB.prepare(`
      INSERT INTO participants
        (event_id, first_name, last_name, member_id, badge_type,
         req_preview, req_thu, req_fri, req_sat, req_sun,
         clerk_user_id, registered_by_clerk_user_id, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 9999)
    `).bind(
      id, firstName, lastName, memberId, badgeType,
      reqPreview, reqThu, reqFri, reqSat, reqSun,
      clerkUserId, clerkUserId,
    ).run();
  } catch (e) {
    if (e instanceof Error && e.message.includes('UNIQUE')) return err('Already registered for this event', 409);
    throw e;
  }

  return json({ ok: true, id: result.meta.last_row_id }, 201);
});

app.post('/api/events/:id/participants/:pid/claim', async (c) => {
  const eventId = Number(c.req.param('id'));
  const pid = Number(c.req.param('pid'));
  const access = await authenticate(c, c.env.ADMIN_SECRET, c.env.CLERK_JWKS_URL ?? '');
  if (!access) return err('Authentication required', 401);

  const event = await getEvent(c.env.DB, eventId);
  if (!event) return err('Event not found', 404);
  if (event.status !== 'purchasing') return err('Not in purchasing phase', 403);

  const body = await c.req.json<{ coordinator_name: string }>();
  if (!body.coordinator_name?.trim()) return err('coordinator_name required');

  const p = await c.env.DB.prepare('SELECT * FROM participants WHERE id = ? AND event_id = ?')
    .bind(pid, eventId).first<Participant>();
  if (!p) return err('Participant not found', 404);

  if (p.purchasing_claimed_by && !isClaimExpired(p.purchasing_claimed_at)) {
    return err(`Already claimed by ${p.purchasing_claimed_by}`, 409);
  }

  await c.env.DB.prepare(`
    UPDATE participants
    SET purchasing_claimed_by = ?, purchasing_claimed_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `).bind(body.coordinator_name.trim(), pid).run();

  return json({ ok: true });
});

app.post('/api/events/:id/participants/:pid/unclaim', async (c) => {
  const eventId = Number(c.req.param('id'));
  const pid = Number(c.req.param('pid'));
  const access = await authenticate(c, c.env.ADMIN_SECRET, c.env.CLERK_JWKS_URL ?? '');
  if (!access) return err('Authentication required', 401);

  await c.env.DB.prepare(`
    UPDATE participants
    SET purchasing_claimed_by = '', purchasing_claimed_at = NULL, updated_at = datetime('now')
    WHERE id = ? AND event_id = ?
  `).bind(pid, eventId).run();

  return json({ ok: true });
});

app.patch('/api/events/:id/participants/:pid/purchased', async (c) => {
  const eventId = Number(c.req.param('id'));
  const pid = Number(c.req.param('pid'));
  const access = await authenticate(c, c.env.ADMIN_SECRET, c.env.CLERK_JWKS_URL ?? '');
  if (!access) return err('Authentication required', 401);

  const event = await getEvent(c.env.DB, eventId);
  if (!event) return err('Event not found', 404);

  const body = await c.req.json<{
    pur_preview?: boolean; pur_thu?: boolean; pur_fri?: boolean;
    pur_sat?: boolean; pur_sun?: boolean; who_purchased?: string;
  }>();

  await c.env.DB.prepare(`
    UPDATE participants
    SET pur_preview = ?, pur_thu = ?, pur_fri = ?, pur_sat = ?, pur_sun = ?,
        who_purchased = ?, updated_at = datetime('now')
    WHERE id = ? AND event_id = ?
  `).bind(
    body.pur_preview ? 1 : 0, body.pur_thu ? 1 : 0, body.pur_fri ? 1 : 0,
    body.pur_sat ? 1 : 0, body.pur_sun ? 1 : 0,
    body.who_purchased?.trim() ?? '',
    pid, eventId,
  ).run();

  return json({ ok: true });
});

app.patch('/api/events/:id/participants/:pid/requested', async (c) => {
  const eventId = Number(c.req.param('id'));
  const pid = Number(c.req.param('pid'));
  const access = await authenticate(c, c.env.ADMIN_SECRET, c.env.CLERK_JWKS_URL ?? '');
  if (!access) return err('Authentication required', 401);

  const body = await c.req.json<{
    req_preview?: boolean; req_thu?: boolean; req_fri?: boolean;
    req_sat?: boolean; req_sun?: boolean;
  }>();

  await c.env.DB.prepare(`
    UPDATE participants
    SET req_preview = ?, req_thu = ?, req_fri = ?, req_sat = ?, req_sun = ?,
        updated_at = datetime('now')
    WHERE id = ? AND event_id = ?
  `).bind(
    body.req_preview ? 1 : 0, body.req_thu ? 1 : 0, body.req_fri ? 1 : 0,
    body.req_sat ? 1 : 0, body.req_sun ? 1 : 0,
    pid, eventId,
  ).run();

  return json({ ok: true });
});

app.patch('/api/events/:id/participants/:pid/paid', async (c) => {
  const eventId = Number(c.req.param('id'));
  const pid = Number(c.req.param('pid'));
  const access = await authenticate(c, c.env.ADMIN_SECRET, c.env.CLERK_JWKS_URL ?? '');
  if (!access) return err('Authentication required', 401);

  const body = await c.req.json<{ paid: boolean }>();

  await c.env.DB.prepare(`
    UPDATE participants SET paid = ?, updated_at = datetime('now') WHERE id = ? AND event_id = ?
  `).bind(body.paid ? 1 : 0, pid, eventId).run();

  return json({ ok: true });
});

app.get('/api/events/:id/coordinators', async (c) => {
  const id = Number(c.req.param('id'));
  const access = await authenticate(c, c.env.ADMIN_SECRET, c.env.CLERK_JWKS_URL ?? '');
  if (!access) return err('Authentication required', 401);

  const event = await getEvent(c.env.DB, id);
  if (!event) return err('Event not found', 404);

  const rows = await c.env.DB.prepare(
    'SELECT * FROM coordinators WHERE event_id = ? ORDER BY name ASC'
  ).bind(id).all<Coordinator>();
  return json(rows.results);
});

app.put('/api/events/:id/coordinators/:name', async (c) => {
  const eventId = Number(c.req.param('id'));
  const name = decodeURIComponent(c.req.param('name'));
  const access = await authenticate(c, c.env.ADMIN_SECRET, c.env.CLERK_JWKS_URL ?? '');
  if (!access) return err('Authentication required', 401);

  const body = await c.req.json<{ venmo?: string; zelle?: string; paypal?: string; phone_last4?: string }>();

  await c.env.DB.prepare(`
    INSERT INTO coordinators (event_id, name, venmo, zelle, paypal, phone_last4)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_id, name) DO UPDATE SET
      venmo = excluded.venmo, zelle = excluded.zelle,
      paypal = excluded.paypal, phone_last4 = excluded.phone_last4,
      updated_at = datetime('now')
  `).bind(eventId, name, body.venmo?.trim() ?? '', body.zelle?.trim() ?? '', body.paypal?.trim() ?? '', body.phone_last4?.trim() ?? '').run();

  return json({ ok: true });
});

app.patch('/api/events/:id/participants/:pid/profile', async (c) => {
  const eventId = Number(c.req.param('id'));
  const pid = Number(c.req.param('pid'));
  const access = await authenticate(c, c.env.ADMIN_SECRET, c.env.CLERK_JWKS_URL ?? '');
  if (!access) return err('Authentication required', 401);

  const body = await c.req.json<{
    first_name?: string; last_name?: string; member_id?: string; badge_type?: string; notes?: string;
  }>();

  const fields: string[] = [];
  const values: (string | number)[] = [];

  if (body.first_name !== undefined) { fields.push('first_name = ?'); values.push(body.first_name.trim()); }
  if (body.last_name !== undefined) { fields.push('last_name = ?'); values.push(body.last_name.trim()); }
  if (body.member_id !== undefined) { fields.push('member_id = ?'); values.push(body.member_id.trim().toUpperCase()); }
  if (body.badge_type !== undefined) { fields.push('badge_type = ?'); values.push(body.badge_type === 'JUNIOR' ? 'JUNIOR' : 'ADULT'); }
  if (body.notes !== undefined) { fields.push('notes = ?'); values.push(body.notes.trim()); }

  if (fields.length === 0) return err('No fields to update');
  fields.push("updated_at = datetime('now')");
  values.push(pid, eventId);

  try {
    await c.env.DB.prepare(
      `UPDATE participants SET ${fields.join(', ')} WHERE id = ? AND event_id = ?`
    ).bind(...values).run();
  } catch (e) {
    if (e instanceof Error && e.message.includes('UNIQUE')) return err('Member ID already used by another participant', 409);
    throw e;
  }

  return json({ ok: true });
});

app.get('/api/events/:id/groups', async (c) => {
  const id = Number(c.req.param('id'));
  const access = await authenticate(c, c.env.ADMIN_SECRET, c.env.CLERK_JWKS_URL ?? '');
  if (!access) return err('Authentication required', 401);

  const event = await getEvent(c.env.DB, id);
  if (!event) return err('Event not found', 404);

  const rows = await c.env.DB.prepare(
    'SELECT * FROM groups WHERE event_id = ? ORDER BY sort_order ASC, id ASC'
  ).bind(id).all<Group>();
  return json(rows.results);
});

// Resolve current user's linked participant for an event
app.get('/api/events/:id/me', async (c) => {
  const id = Number(c.req.param('id'));
  const access = await authenticate(c, c.env.ADMIN_SECRET, c.env.CLERK_JWKS_URL ?? '');
  if (!access) return err('Authentication required', 401);

  const event = await getEvent(c.env.DB, id);
  if (!event) return err('Event not found', 404);

  if (access.userId === 'admin') return json({ linked: false });

  const participant = await c.env.DB.prepare(
    `${PARTICIPANTS_QUERY} WHERE p.event_id = ? AND p.clerk_user_id = ?`
  ).bind(id, access.userId).first<Participant>();

  if (!participant) return json({ linked: false });
  return json({ linked: true, participant: enrichParticipant(participant, event) });
});

// Link current user to a participant row
app.post('/api/events/:id/participants/:pid/link-identity', async (c) => {
  const eventId = Number(c.req.param('id'));
  const pid = Number(c.req.param('pid'));
  const access = await authenticate(c, c.env.ADMIN_SECRET, c.env.CLERK_JWKS_URL ?? '');
  if (!access || access.userId === 'admin') return err('Authentication required', 401);

  const existing = await c.env.DB.prepare(
    'SELECT id FROM participants WHERE event_id = ? AND clerk_user_id = ?'
  ).bind(eventId, access.userId).first();
  if (existing) return err('Already linked to a participant in this event', 409);

  await c.env.DB.prepare(
    "UPDATE participants SET clerk_user_id = ?, updated_at = datetime('now') WHERE id = ? AND event_id = ?"
  ).bind(access.userId, pid, eventId).run();

  return json({ ok: true });
});

// ── User profile ──────────────────────────────────────────────────────────────

app.get('/api/profile', async (c) => {
  const access = await authenticate(c, c.env.ADMIN_SECRET, c.env.CLERK_JWKS_URL ?? '');
  if (!access || access.userId === 'admin') return err('Authentication required', 401);

  const profile = await c.env.DB.prepare(
    'SELECT * FROM profiles WHERE clerk_user_id = ?'
  ).bind(access.userId).first<Profile>();

  return json(profile ?? {
    clerk_user_id: access.userId,
    display_name: '', venmo: '', paypal: '', zelle: '',
    created_at: '', updated_at: '',
  });
});

app.put('/api/profile', async (c) => {
  const access = await authenticate(c, c.env.ADMIN_SECRET, c.env.CLERK_JWKS_URL ?? '');
  if (!access || access.userId === 'admin') return err('Authentication required', 401);

  const body = await c.req.json<Partial<Profile>>();

  await c.env.DB.prepare(`
    INSERT INTO profiles (clerk_user_id, display_name, venmo, paypal, zelle, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(clerk_user_id) DO UPDATE SET
      display_name = excluded.display_name,
      venmo = excluded.venmo,
      paypal = excluded.paypal,
      zelle = excluded.zelle,
      updated_at = datetime('now')
  `).bind(
    access.userId,
    body.display_name?.trim() ?? '',
    body.venmo?.trim() ?? '',
    body.paypal?.trim() ?? '',
    body.zelle?.trim() ?? '',
  ).run();

  return json({ ok: true });
});

// ── Invite lookup (public) ────────────────────────────────────────────────────

app.get('/api/invites/:code', async (c) => {
  const code = c.req.param('code').toUpperCase();
  const invite = await c.env.DB.prepare(
    'SELECT * FROM invites WHERE code = ?'
  ).bind(code).first<Invite>();
  if (!invite) return err('Invite not found', 404);
  if (invite.used_at) return err('This invite has already been used', 409);

  const year = await c.env.DB.prepare(
    'SELECT id, name, con_year FROM years WHERE id = ?'
  ).bind(invite.year_id).first<Pick<Year, 'id' | 'name' | 'con_year'>>();

  return json({ invite: { code: invite.code, label: invite.label, year_id: invite.year_id }, year });
});

// ── Accept invite / register ──────────────────────────────────────────────────

app.post('/api/invites/:code/accept', async (c) => {
  const access = await authenticate(c, c.env.ADMIN_SECRET, c.env.CLERK_JWKS_URL ?? '');
  if (!access || access.userId === 'admin') return err('Sign in required', 401);

  const code = c.req.param('code').toUpperCase();
  const body = await c.req.json<{
    first_name: string;
    last_name: string;
    member_id: string;
    badge_type: 'ADULT' | 'JUNIOR';
    return_eligible: boolean;
  }>();

  if (!body.first_name?.trim() || !body.last_name?.trim()) return err('First and last name required');

  const invite = await c.env.DB.prepare(
    'SELECT * FROM invites WHERE code = ?'
  ).bind(code).first<Invite>();
  if (!invite) return err('Invite not found', 404);
  if (invite.used_at) return err('This invite has already been used', 409);

  // Check not already a member of this year
  const existing = await c.env.DB.prepare(
    'SELECT id FROM year_members WHERE year_id = ? AND clerk_user_id = ?'
  ).bind(invite.year_id, access.userId).first();
  if (existing) return err('You are already registered for this year', 409);

  const db = c.env.DB;
  const yearId = invite.year_id;
  const color = await pickGroupColor(db, yearId);
  const groupName = `${body.first_name.trim()}'s Group`;

  // Get all events for this year
  const events = await db.prepare(
    'SELECT id FROM events WHERE year_id = ?'
  ).bind(yearId).all<{ id: number }>();

  const firstName = body.first_name.trim();
  const lastName = body.last_name.trim();
  const memberId = body.member_id?.trim() ?? '';
  const badgeType = body.badge_type ?? 'ADULT';
  const returnEligible = body.return_eligible ? 1 : 0;

  const stmts: D1PreparedStatement[] = [];

  // 1. Create year_member
  stmts.push(db.prepare(`
    INSERT INTO year_members (year_id, clerk_user_id, role, sponsor_clerk_user_id,
      first_name, last_name, member_id, badge_type, return_eligible)
    VALUES (?, ?, 'registered', ?, ?, ?, ?, ?, ?)
  `).bind(yearId, access.userId, invite.invited_by_clerk_user_id,
    firstName, lastName, memberId, badgeType, returnEligible));

  // 2. Mark invite used
  stmts.push(db.prepare(`
    UPDATE invites SET used_by_clerk_user_id = ?, used_at = datetime('now') WHERE code = ?
  `).bind(access.userId, code));

  // 3. Create group in each event + participant record
  for (const ev of events.results) {
    stmts.push(db.prepare(`
      INSERT INTO groups (event_id, name, color, owner_clerk_user_id)
      VALUES (?, ?, ?, ?)
    `).bind(ev.id, groupName, color, access.userId));
  }

  await db.batch(stmts);

  // 4. For each event, get the new group and upsert participant
  for (const ev of events.results) {
    const group = await db.prepare(
      'SELECT id FROM groups WHERE event_id = ? AND owner_clerk_user_id = ?'
    ).bind(ev.id, access.userId).first<{ id: number }>();
    if (!group) continue;

    // Check if participant with this member_id already exists in the event
    const existingP = memberId
      ? await db.prepare(
          'SELECT id FROM participants WHERE event_id = ? AND UPPER(member_id) = UPPER(?)'
        ).bind(ev.id, memberId).first<{ id: number }>()
      : null;

    if (existingP) {
      await db.prepare(`
        UPDATE participants SET clerk_user_id = ?, group_id = ?, registered_by_clerk_user_id = ? WHERE id = ?
      `).bind(access.userId, group.id, access.userId, existingP.id).run();
    } else {
      await db.prepare(`
        INSERT INTO participants (event_id, first_name, last_name, member_id, badge_type,
          return_eligible, clerk_user_id, registered_by_clerk_user_id, group_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(ev.id, firstName, lastName, memberId, badgeType,
        returnEligible, access.userId, access.userId, group.id).run();
    }
  }

  const member = await db.prepare(
    'SELECT * FROM year_members WHERE year_id = ? AND clerk_user_id = ?'
  ).bind(yearId, access.userId).first<YearMember>();

  return json({ ok: true, member }, 201);
});

// ── User dashboard endpoints ──────────────────────────────────────────────────

app.get('/api/years', async (c) => {
  const access = await authenticate(c, c.env.ADMIN_SECRET, c.env.CLERK_JWKS_URL ?? '');
  if (!access || access.userId === 'admin') return err('Sign in required', 401);

  const rows = await c.env.DB.prepare(`
    SELECT y.* FROM years y
    JOIN year_members ym ON ym.year_id = y.id
    WHERE ym.clerk_user_id = ?
    ORDER BY y.con_year DESC
  `).bind(access.userId).all<Year>();
  return json(rows.results);
});

// Current user's membership + group info for a year
app.get('/api/years/:yearId/me', async (c) => {
  const access = await authenticate(c, c.env.ADMIN_SECRET, c.env.CLERK_JWKS_URL ?? '');
  if (!access || access.userId === 'admin') return err('Sign in required', 401);

  const yearId = Number(c.req.param('yearId'));
  const member = await c.env.DB.prepare(
    'SELECT * FROM year_members WHERE year_id = ? AND clerk_user_id = ?'
  ).bind(yearId, access.userId).first<YearMember>();
  if (!member) return err('Not a member of this year', 403);

  return json({ member: mapYearMember(member) });
});

// Update current user's profile for a year (year_members + linked participants)
app.patch('/api/years/:yearId/me', async (c) => {
  const access = await authenticate(c, c.env.ADMIN_SECRET, c.env.CLERK_JWKS_URL ?? '');
  if (!access || access.userId === 'admin') return err('Sign in required', 401);

  const yearId = Number(c.req.param('yearId'));
  const body = await c.req.json<{
    first_name: string;
    last_name: string;
    member_id?: string;
    badge_type?: 'ADULT' | 'JUNIOR';
    return_eligible?: boolean;
  }>();

  if (!body.first_name?.trim() || !body.last_name?.trim()) {
    return err('First and last name required');
  }

  const existing = await c.env.DB.prepare(
    'SELECT id FROM year_members WHERE year_id = ? AND clerk_user_id = ?'
  ).bind(yearId, access.userId).first();
  if (!existing) return err('Not a member of this year', 403);

  const firstName = body.first_name.trim();
  const lastName = body.last_name.trim();
  const memberId = body.member_id?.trim() ?? '';
  const badgeType = body.badge_type === 'JUNIOR' ? 'JUNIOR' : 'ADULT';
  const returnEligible = body.return_eligible ? 1 : 0;

  await c.env.DB.prepare(`
    UPDATE year_members SET
      first_name = ?, last_name = ?, member_id = ?, badge_type = ?, return_eligible = ?
    WHERE year_id = ? AND clerk_user_id = ?
  `).bind(
    firstName, lastName, memberId, badgeType, returnEligible,
    yearId, access.userId,
  ).run();

  const events = await c.env.DB.prepare(
    'SELECT id FROM events WHERE year_id = ?'
  ).bind(yearId).all<{ id: number }>();

  for (const ev of events.results) {
    await c.env.DB.prepare(`
      UPDATE participants SET
        first_name = ?, last_name = ?, member_id = ?, badge_type = ?, return_eligible = ?,
        updated_at = datetime('now')
      WHERE event_id = ? AND clerk_user_id = ?
    `).bind(
      firstName, lastName, memberId, badgeType, returnEligible,
      ev.id, access.userId,
    ).run();

    if (memberId) {
      await c.env.DB.prepare(`
        UPDATE participants SET
          clerk_user_id = ?, first_name = ?, last_name = ?, member_id = ?, badge_type = ?,
          return_eligible = ?, updated_at = datetime('now')
        WHERE event_id = ? AND clerk_user_id IS NULL AND UPPER(member_id) = UPPER(?)
          AND group_id IN (
            SELECT id FROM groups WHERE event_id = ? AND owner_clerk_user_id = ?
          )
      `).bind(
        access.userId, firstName, lastName, memberId, badgeType, returnEligible,
        ev.id, memberId, ev.id, access.userId,
      ).run();
    }
  }

  const member = await c.env.DB.prepare(
    'SELECT * FROM year_members WHERE year_id = ? AND clerk_user_id = ?'
  ).bind(yearId, access.userId).first<YearMember>();

  return json({ member: mapYearMember(member!) });
});

// Participants in the current user's group for a specific event
app.get('/api/years/:yearId/events/:eventId/my-group', async (c) => {
  const access = await authenticate(c, c.env.ADMIN_SECRET, c.env.CLERK_JWKS_URL ?? '');
  if (!access || access.userId === 'admin') return err('Sign in required', 401);

  const yearId = Number(c.req.param('yearId'));
  const eventId = Number(c.req.param('eventId'));

  const member = await c.env.DB.prepare(
    'SELECT id FROM year_members WHERE year_id = ? AND clerk_user_id = ?'
  ).bind(yearId, access.userId).first();
  if (!member) return err('Not a member of this year', 403);

  const group = await c.env.DB.prepare(
    'SELECT * FROM groups WHERE event_id = ? AND owner_clerk_user_id = ?'
  ).bind(eventId, access.userId).first<Group>();

  const event = await getEvent(c.env.DB, eventId);

  const participants = group
    ? await c.env.DB.prepare(
        `${PARTICIPANTS_QUERY} WHERE p.event_id = ? AND p.group_id = ? ORDER BY p.sort_order, p.id`
      ).bind(eventId, group.id).all<Participant>()
    : { results: [] };

  return json({
    group,
    participants: event
      ? participants.results.map((p) => enrichParticipant(p, event))
      : participants.results,
  });
});

// Add a participant to the current user's group
app.post('/api/years/:yearId/events/:eventId/my-group/participants', async (c) => {
  const access = await authenticate(c, c.env.ADMIN_SECRET, c.env.CLERK_JWKS_URL ?? '');
  if (!access || access.userId === 'admin') return err('Sign in required', 401);

  const yearId = Number(c.req.param('yearId'));
  const eventId = Number(c.req.param('eventId'));

  const member = await c.env.DB.prepare(
    'SELECT id FROM year_members WHERE year_id = ? AND clerk_user_id = ?'
  ).bind(yearId, access.userId).first();
  if (!member) return err('Not a member of this year', 403);

  const group = await c.env.DB.prepare(
    'SELECT * FROM groups WHERE event_id = ? AND owner_clerk_user_id = ?'
  ).bind(eventId, access.userId).first<Group>();
  if (!group) return err('Group not found', 404);

  const body = await c.req.json<{
    first_name: string;
    last_name: string;
    member_id?: string;
    badge_type?: 'ADULT' | 'JUNIOR';
    return_eligible?: boolean;
  }>();
  if (!body.first_name?.trim() || !body.last_name?.trim()) return err('First and last name required');

  const memberId = body.member_id?.trim() ?? '';

  // Link to existing participant if member_id matches
  if (memberId) {
    const existingP = await c.env.DB.prepare(
      'SELECT id FROM participants WHERE event_id = ? AND UPPER(member_id) = UPPER(?)'
    ).bind(eventId, memberId).first<{ id: number }>();

    if (existingP) {
      await c.env.DB.prepare(
        'UPDATE participants SET group_id = ?, registered_by_clerk_user_id = ? WHERE id = ?'
      ).bind(group.id, access.userId, existingP.id).run();
      const updated = await c.env.DB.prepare(
        `${PARTICIPANTS_QUERY} WHERE p.id = ?`
      ).bind(existingP.id).first<Participant>();
      return json(updated, 201);
    }
  }

  const result = await c.env.DB.prepare(`
    INSERT INTO participants (event_id, first_name, last_name, member_id, badge_type,
      return_eligible, registered_by_clerk_user_id, group_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    eventId,
    body.first_name.trim(),
    body.last_name.trim(),
    memberId,
    body.badge_type ?? 'ADULT',
    body.return_eligible ? 1 : 0,
    access.userId,
    group.id,
  ).run();

  const created = await c.env.DB.prepare(
    `${PARTICIPANTS_QUERY} WHERE p.id = ?`
  ).bind(result.meta.last_row_id).first<Participant>();
  return json(created, 201);
});

// Save current user's badge days for an event (resolves/links self participant in their group)
app.patch('/api/years/:yearId/events/:eventId/my-group/days', async (c) => {
  const access = await authenticate(c, c.env.ADMIN_SECRET, c.env.CLERK_JWKS_URL ?? '');
  if (!access || access.userId === 'admin') return err('Sign in required', 401);

  const yearId = Number(c.req.param('yearId'));
  const eventId = Number(c.req.param('eventId'));

  const yearMember = await c.env.DB.prepare(
    'SELECT * FROM year_members WHERE year_id = ? AND clerk_user_id = ?'
  ).bind(yearId, access.userId).first<YearMember>();
  if (!yearMember) return err('Not a member of this year', 403);

  const event = await getEvent(c.env.DB, eventId);
  if (!event) return err('Event not found', 404);
  if (event.status !== 'registration') return err('Registration is not open', 403);

  let group = await c.env.DB.prepare(
    'SELECT * FROM groups WHERE event_id = ? AND owner_clerk_user_id = ?'
  ).bind(eventId, access.userId).first<Group>();

  if (!group) {
    const groupName = [yearMember.first_name, yearMember.last_name].filter(Boolean).join(' ') || 'My Group';
    await c.env.DB.prepare(`
      INSERT INTO groups (event_id, name, color, owner_clerk_user_id)
      VALUES (?, ?, ?, ?)
    `).bind(eventId, groupName, '#3b82f6', access.userId).run();
    group = await c.env.DB.prepare(
      'SELECT * FROM groups WHERE event_id = ? AND owner_clerk_user_id = ?'
    ).bind(eventId, access.userId).first<Group>();
  }
  if (!group) return err('Could not create group', 500);

  const body = await c.req.json<{
    req_preview?: boolean; req_thu?: boolean; req_fri?: boolean; req_sat?: boolean; req_sun?: boolean;
  }>();

  const reqPreview = body.req_preview ? 1 : 0;
  const reqThu = body.req_thu ? 1 : 0;
  const reqFri = body.req_fri ? 1 : 0;
  const reqSat = body.req_sat ? 1 : 0;
  const reqSun = body.req_sun ? 1 : 0;

  // Prefer participant already in this group (clerk, then member_id)
  let self = await c.env.DB.prepare(
    'SELECT id FROM participants WHERE event_id = ? AND group_id = ? AND clerk_user_id = ?'
  ).bind(eventId, group.id, access.userId).first<{ id: number }>();

  if (!self && yearMember.member_id) {
    self = await c.env.DB.prepare(
      'SELECT id FROM participants WHERE event_id = ? AND group_id = ? AND UPPER(member_id) = UPPER(?)'
    ).bind(eventId, group.id, yearMember.member_id).first<{ id: number }>();
  }

  // Orphan participant with this clerk (e.g. register without group_id) — claim into group
  if (!self) {
    self = await c.env.DB.prepare(
      'SELECT id FROM participants WHERE event_id = ? AND clerk_user_id = ?'
    ).bind(eventId, access.userId).first<{ id: number }>();
  }

  // Orphan by member_id
  if (!self && yearMember.member_id) {
    self = await c.env.DB.prepare(
      'SELECT id FROM participants WHERE event_id = ? AND UPPER(member_id) = UPPER(?)'
    ).bind(eventId, yearMember.member_id).first<{ id: number }>();
  }

  if (self) {
    await c.env.DB.prepare(`
      UPDATE participants SET
        clerk_user_id = ?,
        group_id = ?,
        registered_by_clerk_user_id = COALESCE(registered_by_clerk_user_id, ?),
        first_name = COALESCE(NULLIF(?, ''), first_name),
        last_name = COALESCE(NULLIF(?, ''), last_name),
        member_id = COALESCE(NULLIF(?, ''), member_id),
        badge_type = COALESCE(NULLIF(?, ''), badge_type),
        req_preview = ?, req_thu = ?, req_fri = ?, req_sat = ?, req_sun = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).bind(
      access.userId,
      group.id,
      access.userId,
      yearMember.first_name ?? '',
      yearMember.last_name ?? '',
      yearMember.member_id ?? '',
      yearMember.badge_type ?? 'ADULT',
      reqPreview, reqThu, reqFri, reqSat, reqSun,
      self.id,
    ).run();
  } else {
    const result = await c.env.DB.prepare(`
      INSERT INTO participants
        (event_id, first_name, last_name, member_id, badge_type,
         req_preview, req_thu, req_fri, req_sat, req_sun,
         clerk_user_id, registered_by_clerk_user_id, group_id, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).bind(
      eventId,
      yearMember.first_name ?? '',
      yearMember.last_name ?? '',
      yearMember.member_id ?? '',
      yearMember.badge_type ?? 'ADULT',
      reqPreview, reqThu, reqFri, reqSat, reqSun,
      access.userId, access.userId, group.id,
    ).run();
    self = { id: Number(result.meta.last_row_id) };
  }

  const updated = await c.env.DB.prepare(
    `${PARTICIPANTS_QUERY} WHERE p.id = ?`
  ).bind(self.id).first<Participant>();
  return json(enrichParticipant(updated!, event));
});

// Update a participant in the current user's group
app.patch('/api/years/:yearId/events/:eventId/my-group/participants/:pid', async (c) => {
  const access = await authenticate(c, c.env.ADMIN_SECRET, c.env.CLERK_JWKS_URL ?? '');
  if (!access || access.userId === 'admin') return err('Sign in required', 401);

  const yearId = Number(c.req.param('yearId'));
  const eventId = Number(c.req.param('eventId'));
  const pid = Number(c.req.param('pid'));

  const member = await c.env.DB.prepare(
    'SELECT id FROM year_members WHERE year_id = ? AND clerk_user_id = ?'
  ).bind(yearId, access.userId).first();
  if (!member) return err('Not a member of this year', 403);

  const group = await c.env.DB.prepare(
    'SELECT id FROM groups WHERE event_id = ? AND owner_clerk_user_id = ?'
  ).bind(eventId, access.userId).first<{ id: number }>();
  if (!group) return err('Group not found', 404);

  // Ensure participant belongs to this group
  const p = await c.env.DB.prepare(
    'SELECT id FROM participants WHERE id = ? AND event_id = ? AND group_id = ?'
  ).bind(pid, eventId, group.id).first();
  if (!p) return err('Participant not found', 404);

  const body = await c.req.json<Partial<{
    first_name: string; last_name: string; member_id: string;
    badge_type: 'ADULT' | 'JUNIOR'; return_eligible: boolean;
    req_preview: boolean; req_thu: boolean; req_fri: boolean; req_sat: boolean; req_sun: boolean;
  }>>();

  const event = await getEvent(c.env.DB, eventId);
  const canEditDays = event?.status === 'registration';

  const reqFields: string[] = [];
  const reqValues: number[] = [];
  if (canEditDays) {
    for (const key of ['req_preview', 'req_thu', 'req_fri', 'req_sat', 'req_sun'] as const) {
      if (key in body) {
        reqFields.push(`${key} = ?`);
        reqValues.push(body[key] ? 1 : 0);
      }
    }
  }

  const setClauses = [
    'first_name = COALESCE(?, first_name)',
    'last_name = COALESCE(?, last_name)',
    'member_id = COALESCE(?, member_id)',
    'badge_type = COALESCE(?, badge_type)',
    'return_eligible = COALESCE(?, return_eligible)',
    ...reqFields,
    "updated_at = datetime('now')",
  ];

  await c.env.DB.prepare(`
    UPDATE participants SET ${setClauses.join(', ')}
    WHERE id = ?
  `).bind(
    body.first_name?.trim() ?? null,
    body.last_name?.trim() ?? null,
    body.member_id?.trim() ?? null,
    body.badge_type ?? null,
    body.return_eligible != null ? (body.return_eligible ? 1 : 0) : null,
    ...reqValues,
    pid,
  ).run();

  const pRow = await c.env.DB.prepare(
    'SELECT clerk_user_id FROM participants WHERE id = ?'
  ).bind(pid).first<{ clerk_user_id: string | null }>();

  if (pRow?.clerk_user_id === access.userId) {
    await c.env.DB.prepare(`
      UPDATE year_members SET
        first_name = COALESCE(?, first_name),
        last_name = COALESCE(?, last_name),
        member_id = COALESCE(?, member_id),
        badge_type = COALESCE(?, badge_type),
        return_eligible = COALESCE(?, return_eligible)
      WHERE year_id = ? AND clerk_user_id = ?
    `).bind(
      body.first_name?.trim() ?? null,
      body.last_name?.trim() ?? null,
      body.member_id !== undefined ? (body.member_id.trim() ?? '') : null,
      body.badge_type ?? null,
      body.return_eligible != null ? (body.return_eligible ? 1 : 0) : null,
      yearId,
      access.userId,
    ).run();
  }

  const updated = await c.env.DB.prepare(
    `${PARTICIPANTS_QUERY} WHERE p.id = ?`
  ).bind(pid).first<Participant>();
  return json(updated);
});

// Delete a participant from the current user's group
app.delete('/api/years/:yearId/events/:eventId/my-group/participants/:pid', async (c) => {
  const access = await authenticate(c, c.env.ADMIN_SECRET, c.env.CLERK_JWKS_URL ?? '');
  if (!access || access.userId === 'admin') return err('Sign in required', 401);

  const yearId = Number(c.req.param('yearId'));
  const eventId = Number(c.req.param('eventId'));
  const pid = Number(c.req.param('pid'));

  const member = await c.env.DB.prepare(
    'SELECT id FROM year_members WHERE year_id = ? AND clerk_user_id = ?'
  ).bind(yearId, access.userId).first();
  if (!member) return err('Not a member of this year', 403);

  const group = await c.env.DB.prepare(
    'SELECT id FROM groups WHERE event_id = ? AND owner_clerk_user_id = ?'
  ).bind(eventId, access.userId).first<{ id: number }>();
  if (!group) return err('Group not found', 404);

  const p = await c.env.DB.prepare(
    'SELECT id, clerk_user_id FROM participants WHERE id = ? AND event_id = ? AND group_id = ?'
  ).bind(pid, eventId, group.id).first<{ id: number; clerk_user_id: string | null }>();
  if (!p) return err('Participant not found', 404);
  // Cannot remove yourself
  if (p.clerk_user_id === access.userId) return err('Cannot remove yourself from your group', 400);

  await c.env.DB.prepare('DELETE FROM participants WHERE id = ?').bind(pid).run();
  return json({ ok: true });
});

// List invites created by the current user for a year
app.get('/api/years/:yearId/invites', async (c) => {
  const access = await authenticate(c, c.env.ADMIN_SECRET, c.env.CLERK_JWKS_URL ?? '');
  if (!access || access.userId === 'admin') return err('Sign in required', 401);

  const yearId = Number(c.req.param('yearId'));

  const member = await c.env.DB.prepare(
    'SELECT id FROM year_members WHERE year_id = ? AND clerk_user_id = ?'
  ).bind(yearId, access.userId).first();
  if (!member) return err('Not a member of this year', 403);

  const rows = await c.env.DB.prepare(
    'SELECT * FROM invites WHERE year_id = ? AND invited_by_clerk_user_id = ? ORDER BY created_at DESC'
  ).bind(yearId, access.userId).all<Invite>();
  return json(rows.results);
});

// Create an invite (registered users and admins)
app.post('/api/years/:yearId/invites', async (c) => {
  const access = await authenticate(c, c.env.ADMIN_SECRET, c.env.CLERK_JWKS_URL ?? '');
  if (!access) return err('Authentication required', 401);

  const yearId = Number(c.req.param('yearId'));

  // Must be admin or a member of this year
  if (!access.isAdmin) {
    const member = await c.env.DB.prepare(
      'SELECT id FROM year_members WHERE year_id = ? AND clerk_user_id = ?'
    ).bind(yearId, access.userId).first();
    if (!member) return err('Not a member of this year', 403);
  }

  const body = await c.req.json<{ label?: string }>();

  let code: string;
  // Retry on (unlikely) collision
  for (let i = 0; i < 5; i++) {
    code = generateInviteCode();
    const existing = await c.env.DB.prepare(
      'SELECT id FROM invites WHERE code = ?'
    ).bind(code).first();
    if (!existing) break;
  }

  await c.env.DB.prepare(`
    INSERT INTO invites (year_id, code, label, invited_by_clerk_user_id)
    VALUES (?, ?, ?, ?)
  `).bind(yearId, code!, body.label?.trim() ?? '', access.userId).run();

  const invite = await c.env.DB.prepare(
    'SELECT * FROM invites WHERE code = ?'
  ).bind(code!).first<Invite>();

  return json(invite, 201);
});

// ── Admin-only routes ─────────────────────────────────────────────────────────

const admin = new Hono<{ Bindings: Bindings }>();
admin.use('*', async (c, next) => {
  const authHeader = c.req.header('authorization') ?? '';
  if (authHeader === `Bearer ${c.env.ADMIN_SECRET}`) return next();
  if (c.env.CLERK_JWKS_URL && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const claims = await verifyClerkJWT(token, c.env.CLERK_JWKS_URL);
    if (claims?.public_metadata?.role === 'admin') return next();
  }
  return Response.json({ error: 'Unauthorized' }, { status: 401 });
});

admin.post('/events', async (c) => {
  const body = await c.req.json<Omit<Event, 'id' | 'created_at' | 'updated_at'>>();
  if (!body.year || !body.name) return err('year and name required');

  const result = await c.env.DB.prepare(`
    INSERT INTO events
      (year, name, reg_type, status,
       price_preview_adult, price_thu_adult, price_fri_adult, price_sat_adult, price_sun_adult,
       price_preview_junior, price_thu_junior, price_fri_junior, price_sat_junior, price_sun_junior)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    body.year, body.name, body.reg_type ?? 'open', body.status ?? 'setup',
    body.price_preview_adult ?? 0, body.price_thu_adult ?? 0,
    body.price_fri_adult ?? 0, body.price_sat_adult ?? 0, body.price_sun_adult ?? 0,
    body.price_preview_junior ?? 0, body.price_thu_junior ?? 0,
    body.price_fri_junior ?? 0, body.price_sat_junior ?? 0, body.price_sun_junior ?? 0,
  ).run();

  return json({ id: result.meta.last_row_id }, 201);
});

admin.patch('/events/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json<Partial<Event>>();

  const fields: string[] = [];
  const values: (string | number)[] = [];

  const allowed = [
    'year', 'name', 'reg_type', 'status',
    'price_preview_adult', 'price_thu_adult', 'price_fri_adult', 'price_sat_adult', 'price_sun_adult',
    'price_preview_junior', 'price_thu_junior', 'price_fri_junior', 'price_sat_junior', 'price_sun_junior',
  ] as const;

  for (const key of allowed) {
    if (key in body) {
      fields.push(`${key} = ?`);
      values.push(body[key] as string | number);
    }
  }

  if (fields.length === 0) return err('No fields to update');
  fields.push("updated_at = datetime('now')");
  values.push(id);

  await c.env.DB.prepare(`UPDATE events SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run();
  return json({ ok: true });
});

admin.delete('/events/:id', async (c) => {
  const id = Number(c.req.param('id'));
  await c.env.DB.prepare('DELETE FROM events WHERE id = ?').bind(id).run();
  return json({ ok: true });
});

admin.post('/events/:id/participants', async (c) => {
  const eventId = Number(c.req.param('id'));
  const body = await c.req.json<Partial<Participant>>();

  if (!body.first_name?.trim() || !body.last_name?.trim()) {
    return err('first_name and last_name required');
  }

  let result;
  try {
    result = await c.env.DB.prepare(`
      INSERT INTO participants
        (event_id, first_name, last_name, member_id, badge_type, return_eligible, notes,
         req_preview, req_thu, req_fri, req_sat, req_sun, sort_order, purchasing_coordinator,
         clerk_user_id, registered_by_clerk_user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      eventId,
      body.first_name.trim(), body.last_name.trim(),
      body.member_id?.trim() ?? '',
      body.badge_type === 'JUNIOR' ? 'JUNIOR' : 'ADULT',
      body.return_eligible ? 1 : 0,
      body.notes?.trim() ?? '',
      body.req_preview ? 1 : 0, body.req_thu ? 1 : 0,
      body.req_fri ? 1 : 0, body.req_sat ? 1 : 0, body.req_sun ? 1 : 0,
      body.sort_order ?? 9999,
      body.purchasing_coordinator?.trim() ?? '',
      body.clerk_user_id ?? null,
      body.registered_by_clerk_user_id ?? null,
    ).run();
  } catch (e) {
    if (e instanceof Error && e.message.includes('UNIQUE')) return err('Member ID already used in this event', 409);
    throw e;
  }

  return json({ id: result.meta.last_row_id }, 201);
});

admin.patch('/events/:id/participants/sort', async (c) => {
  const eventId = Number(c.req.param('id'));
  const body = await c.req.json<{ order: number[] }>();

  const stmts = body.order.map((pid, idx) =>
    c.env.DB.prepare(
      "UPDATE participants SET sort_order = ?, updated_at = datetime('now') WHERE id = ? AND event_id = ?"
    ).bind(idx + 1, pid, eventId)
  );

  await c.env.DB.batch(stmts);
  return json({ ok: true });
});

admin.patch('/events/:id/participants/:pid', async (c) => {
  const eventId = Number(c.req.param('id'));
  const pid = Number(c.req.param('pid'));
  const body = await c.req.json<Partial<Participant>>();

  const allowed = [
    'first_name', 'last_name', 'member_id', 'badge_type', 'return_eligible', 'notes',
    'req_preview', 'req_thu', 'req_fri', 'req_sat', 'req_sun',
    'sort_order', 'purchasing_coordinator',
    'pur_preview', 'pur_thu', 'pur_fri', 'pur_sat', 'pur_sun', 'who_purchased',
    'paid', 'clerk_user_id',
  ] as const;

  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if ('group_id' in body) {
    fields.push('group_id = ?');
    values.push((body as Partial<Participant & { group_id: number | null }>).group_id === null ? null : Number((body as Partial<Participant & { group_id: number | null }>).group_id));
  }

  for (const key of allowed) {
    if (key in body) {
      fields.push(`${key} = ?`);
      const val = body[key];
      values.push(typeof val === 'boolean' ? (val ? 1 : 0) : (val as string | number | null));
    }
  }

  if (fields.length === 0) return err('No fields to update');
  fields.push("updated_at = datetime('now')");
  values.push(pid, eventId);

  try {
    await c.env.DB.prepare(
      `UPDATE participants SET ${fields.join(', ')} WHERE id = ? AND event_id = ?`
    ).bind(...values).run();
  } catch (e) {
    if (e instanceof Error && e.message.includes('UNIQUE')) return err('Member ID already used in this event', 409);
    throw e;
  }

  return json({ ok: true });
});

admin.post('/initialize-year', async (c) => {
  const body = await c.req.json<{
    year: number;
    price_preview_adult: number; price_thu_adult: number; price_fri_adult: number;
    price_sat_adult: number; price_sun_adult: number;
    price_preview_junior: number; price_thu_junior: number; price_fri_junior: number;
    price_sat_junior: number; price_sun_junior: number;
  }>();

  if (!body.year) return err('year required');

  const insertSQL = `
    INSERT INTO events (year, name, reg_type, status,
      price_preview_adult, price_thu_adult, price_fri_adult, price_sat_adult, price_sun_adult,
      price_preview_junior, price_thu_junior, price_fri_junior, price_sat_junior, price_sun_junior)
    VALUES (?, ?, ?, 'setup', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  const priceBinds = [
    body.price_preview_adult ?? 0, body.price_thu_adult ?? 0, body.price_fri_adult ?? 0,
    body.price_sat_adult ?? 0, body.price_sun_adult ?? 0,
    body.price_preview_junior ?? 0, body.price_thu_junior ?? 0, body.price_fri_junior ?? 0,
    body.price_sat_junior ?? 0, body.price_sun_junior ?? 0,
  ];

  await c.env.DB.batch([
    c.env.DB.prepare(insertSQL).bind(body.year, `SDCC ${body.year} Return Reg`, 'return', ...priceBinds),
    c.env.DB.prepare(insertSQL).bind(body.year, `SDCC ${body.year} Open Reg`, 'open', ...priceBinds),
  ]);

  return json({ ok: true }, 201);
});

admin.post('/events/:id/participants/copy', async (c) => {
  const sourceEventId = Number(c.req.param('id'));
  const body = await c.req.json<{
    target_event_id: number;
    participant_ids?: number[];
    reset_purchasing?: boolean;
    transfer?: boolean;
    carryover?: boolean;
  }>();

  if (!body.target_event_id) return err('target_event_id required');
  if (body.target_event_id === sourceEventId) return err('Source and target must differ');

  const [src, tgt] = await Promise.all([
    getEvent(c.env.DB, sourceEventId),
    getEvent(c.env.DB, body.target_event_id),
  ]);
  if (!src) return err('Source event not found', 404);
  if (!tgt) return err('Target event not found', 404);

  let participants: Participant[];
  if (body.participant_ids?.length) {
    const placeholders = body.participant_ids.map(() => '?').join(',');
    const rows = await c.env.DB.prepare(
      `${PARTICIPANTS_QUERY} WHERE p.event_id = ? AND p.id IN (${placeholders}) ORDER BY p.sort_order ASC, p.id ASC`
    ).bind(sourceEventId, ...body.participant_ids).all<Participant>();
    participants = rows.results;
  } else {
    const rows = await c.env.DB.prepare(
      `${PARTICIPANTS_QUERY} WHERE p.event_id = ? ORDER BY p.sort_order ASC, p.id ASC`
    ).bind(sourceEventId).all<Participant>();
    participants = rows.results;
  }

  if (participants.length === 0) return err('No participants found', 400);

  const carryover = body.carryover ?? false;
  const reset = carryover ? true : (body.reset_purchasing ?? true);

  const insertStmts = participants.map((p, idx) =>
    c.env.DB.prepare(`
      INSERT INTO participants
        (event_id, first_name, last_name, member_id, badge_type, return_eligible, notes,
         req_preview, req_thu, req_fri, req_sat, req_sun, sort_order,
         purchasing_coordinator, purchasing_claimed_by,
         pur_preview, pur_thu, pur_fri, pur_sat, pur_sun, who_purchased, paid,
         clerk_user_id, registered_by_clerk_user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      body.target_event_id,
      p.first_name, p.last_name, p.member_id,
      p.badge_type, p.return_eligible ? 1 : 0, p.notes,
      carryover ? (p.req_preview && !p.pur_preview ? 1 : 0) : (p.req_preview ? 1 : 0),
      carryover ? (p.req_thu && !p.pur_thu ? 1 : 0) : (p.req_thu ? 1 : 0),
      carryover ? (p.req_fri && !p.pur_fri ? 1 : 0) : (p.req_fri ? 1 : 0),
      carryover ? (p.req_sat && !p.pur_sat ? 1 : 0) : (p.req_sat ? 1 : 0),
      carryover ? (p.req_sun && !p.pur_sun ? 1 : 0) : (p.req_sun ? 1 : 0),
      idx + 1,
      reset ? '' : p.purchasing_coordinator,
      reset ? '' : p.purchasing_claimed_by,
      reset ? 0 : (p.pur_preview ? 1 : 0),
      reset ? 0 : (p.pur_thu ? 1 : 0),
      reset ? 0 : (p.pur_fri ? 1 : 0),
      reset ? 0 : (p.pur_sat ? 1 : 0),
      reset ? 0 : (p.pur_sun ? 1 : 0),
      reset ? '' : p.who_purchased,
      reset ? 0 : (p.paid ? 1 : 0),
      p.clerk_user_id ?? null,
      p.registered_by_clerk_user_id ?? null,
    )
  );

  const deleteStmts = body.transfer
    ? participants.map((p) =>
        c.env.DB.prepare('DELETE FROM participants WHERE id = ? AND event_id = ?').bind(p.id, sourceEventId)
      )
    : [];

  await c.env.DB.batch([...insertStmts, ...deleteStmts]);
  return json({ ok: true, copied: participants.length });
});

admin.delete('/events/:id/participants/:pid', async (c) => {
  const eventId = Number(c.req.param('id'));
  const pid = Number(c.req.param('pid'));
  await c.env.DB.prepare('DELETE FROM participants WHERE id = ? AND event_id = ?').bind(pid, eventId).run();
  return json({ ok: true });
});

admin.post('/events/:id/coordinators', async (c) => {
  const eventId = Number(c.req.param('id'));
  const body = await c.req.json<Partial<Coordinator>>();
  if (!body.name?.trim()) return err('name required');

  await c.env.DB.prepare(`
    INSERT INTO coordinators (event_id, name, venmo, zelle, paypal, phone_last4)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    eventId, body.name.trim(),
    body.venmo?.trim() ?? '', body.zelle?.trim() ?? '',
    body.paypal?.trim() ?? '', body.phone_last4?.trim() ?? '',
  ).run();

  return json({ ok: true }, 201);
});

admin.delete('/events/:id/coordinators/:cid', async (c) => {
  const eventId = Number(c.req.param('id'));
  const cid = Number(c.req.param('cid'));
  await c.env.DB.prepare('DELETE FROM coordinators WHERE id = ? AND event_id = ?').bind(cid, eventId).run();
  return json({ ok: true });
});

admin.patch('/events/:id/groups/reorder', async (c) => {
  const eventId = Number(c.req.param('id'));
  const body = await c.req.json<{ order: number[] }>();
  const stmts = body.order.map((gid, idx) =>
    c.env.DB.prepare("UPDATE groups SET sort_order = ?, updated_at = datetime('now') WHERE id = ? AND event_id = ?")
      .bind(idx + 1, gid, eventId)
  );
  await c.env.DB.batch(stmts);
  return json({ ok: true });
});

admin.post('/events/:id/groups', async (c) => {
  const eventId = Number(c.req.param('id'));
  const body = await c.req.json<{ name: string; color?: string }>();
  if (!body.name?.trim()) return err('name required');
  const count = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM groups WHERE event_id = ?').bind(eventId).first<{ n: number }>();
  const result = await c.env.DB.prepare(
    'INSERT INTO groups (event_id, name, color, sort_order) VALUES (?, ?, ?, ?)'
  ).bind(eventId, body.name.trim(), body.color ?? '#6366f1', (count?.n ?? 0) + 1).run();
  return json({ id: result.meta.last_row_id }, 201);
});

admin.patch('/events/:id/groups/:gid', async (c) => {
  const eventId = Number(c.req.param('id'));
  const gid = Number(c.req.param('gid'));
  const body = await c.req.json<{ name?: string; color?: string }>();
  const fields: string[] = [];
  const values: (string | number)[] = [];
  if (body.name !== undefined) { fields.push('name = ?'); values.push(body.name.trim()); }
  if (body.color !== undefined) { fields.push('color = ?'); values.push(body.color); }
  if (fields.length === 0) return err('No fields to update');
  fields.push("updated_at = datetime('now')");
  values.push(gid, eventId);
  await c.env.DB.prepare(`UPDATE groups SET ${fields.join(', ')} WHERE id = ? AND event_id = ?`).bind(...values).run();
  return json({ ok: true });
});

admin.delete('/events/:id/groups/:gid', async (c) => {
  const eventId = Number(c.req.param('id'));
  const gid = Number(c.req.param('gid'));
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE participants SET group_id = NULL WHERE group_id = ? AND event_id = ?').bind(gid, eventId),
    c.env.DB.prepare('DELETE FROM groups WHERE id = ? AND event_id = ?').bind(gid, eventId),
  ]);
  return json({ ok: true });
});

admin.get('/events/:id/export.csv', async (c) => {
  const eventId = Number(c.req.param('id'));
  const event = await getEvent(c.env.DB, eventId);
  if (!event) return err('Not found', 404);

  const rows = await c.env.DB.prepare(
    `${PARTICIPANTS_QUERY} WHERE p.event_id = ? ORDER BY p.sort_order ASC, p.id ASC`
  ).bind(eventId).all<Participant>();

  const headers = [
    'Sort', 'Last Name', 'First Name', 'Member ID', 'Badge Type', 'Return Eligible',
    'Preview', 'Thu', 'Fri', 'Sat', 'Sun',
    'Coordinator', 'Claimed By',
    'Pur Preview', 'Pur Thu', 'Pur Fri', 'Pur Sat', 'Pur Sun',
    'Who Purchased', 'Total ($)', 'Gaps', 'Paid', 'Notes',
  ];

  const csvRows = rows.results.map((p) => {
    const enriched = enrichParticipant(p, event);
    return [
      p.sort_order, p.last_name, p.first_name, p.member_id, p.badge_type,
      enriched.return_eligible ? 'Yes' : 'No',
      enriched.req_preview ? 'Y' : '', enriched.req_thu ? 'Y' : '',
      enriched.req_fri ? 'Y' : '', enriched.req_sat ? 'Y' : '', enriched.req_sun ? 'Y' : '',
      p.purchasing_coordinator, p.purchasing_claimed_by,
      enriched.pur_preview ? 'Y' : '', enriched.pur_thu ? 'Y' : '',
      enriched.pur_fri ? 'Y' : '', enriched.pur_sat ? 'Y' : '', enriched.pur_sun ? 'Y' : '',
      p.who_purchased,
      (enriched.purchase_total / 100).toFixed(2),
      enriched.gaps.join('; '),
      enriched.paid ? 'Yes' : 'No',
      p.notes,
    ].map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',');
  });

  const csv = [headers.map((h) => `"${h}"`).join(','), ...csvRows].join('\n');

  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="komikone-${event.year}-${event.reg_type}.csv"`,
    },
  });
});

admin.get('/year-meta/:year', async (c) => {
  const year = Number(c.req.param('year'));
  const row = await c.env.DB.prepare('SELECT * FROM year_meta WHERE year = ?').bind(year).first<YearMeta>();
  return json(row ?? {
    year, return_reg_start: '', return_reg_end: '', open_reg_start: '', open_reg_end: '',
    address_deadline: '', hotel_deadline: '',
    preview_date: '', thu_date: '', fri_date: '', sat_date: '', sun_date: '',
    notes: '', created_at: '', updated_at: '',
  });
});

admin.put('/year-meta/:year', async (c) => {
  const year = Number(c.req.param('year'));
  const body = await c.req.json<Partial<YearMeta>>();
  await c.env.DB.prepare(`
    INSERT INTO year_meta (year, return_reg_start, return_reg_end, open_reg_start, open_reg_end,
      address_deadline, hotel_deadline, preview_date, thu_date, fri_date, sat_date, sun_date, notes, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(year) DO UPDATE SET
      return_reg_start = excluded.return_reg_start, return_reg_end = excluded.return_reg_end,
      open_reg_start = excluded.open_reg_start, open_reg_end = excluded.open_reg_end,
      address_deadline = excluded.address_deadline, hotel_deadline = excluded.hotel_deadline,
      preview_date = excluded.preview_date, thu_date = excluded.thu_date,
      fri_date = excluded.fri_date, sat_date = excluded.sat_date,
      sun_date = excluded.sun_date, notes = excluded.notes, updated_at = datetime('now')
  `).bind(
    year,
    body.return_reg_start ?? '', body.return_reg_end ?? '',
    body.open_reg_start ?? '', body.open_reg_end ?? '',
    body.address_deadline ?? '', body.hotel_deadline ?? '',
    body.preview_date ?? '', body.thu_date ?? '',
    body.fri_date ?? '', body.sat_date ?? '',
    body.sun_date ?? '', body.notes ?? '',
  ).run();
  return json({ ok: true });
});

// ── Admin: Years ──────────────────────────────────────────────────────────────

admin.get('/years', async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT * FROM years ORDER BY con_year DESC'
  ).all<Year>();
  return json(rows.results);
});

admin.post('/years', async (c) => {
  const access = await authenticate(c, c.env.ADMIN_SECRET, c.env.CLERK_JWKS_URL ?? '');
  const body = await c.req.json<{ name: string; con_year: number }>();
  if (!body.con_year) return err('con_year required');

  const name = body.name?.trim() || `SDCC ${body.con_year}`;
  const ownerClerkUserId = access?.userId === 'admin' ? '' : (access?.userId ?? '');

  const priceBinds = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const insertEvent = `
    INSERT INTO events (year, year_id, name, reg_type, status,
      price_preview_adult, price_thu_adult, price_fri_adult, price_sat_adult, price_sun_adult,
      price_preview_junior, price_thu_junior, price_fri_junior, price_sat_junior, price_sun_junior)
    VALUES (?, ?, ?, ?, 'setup', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  const yearResult = await c.env.DB.prepare(`
    INSERT INTO years (name, con_year, owner_clerk_user_id) VALUES (?, ?, ?)
  `).bind(name, body.con_year, ownerClerkUserId).run();

  const yearId = yearResult.meta.last_row_id;

  await c.env.DB.batch([
    c.env.DB.prepare(insertEvent).bind(body.con_year, yearId, `${name} Return Reg`, 'return', ...priceBinds),
    c.env.DB.prepare(insertEvent).bind(body.con_year, yearId, `${name} Open Reg`, 'open', ...priceBinds),
  ]);

  // Auto-enroll creator as owner year_member if they're a real user
  if (ownerClerkUserId) {
    await c.env.DB.prepare(`
      INSERT OR IGNORE INTO year_members (year_id, clerk_user_id, role)
      VALUES (?, ?, 'owner')
    `).bind(yearId, ownerClerkUserId).run();
  }

  const year = await c.env.DB.prepare('SELECT * FROM years WHERE id = ?').bind(yearId).first<Year>();
  return json(year, 201);
});

admin.patch('/years/:yearId', async (c) => {
  const yearId = Number(c.req.param('yearId'));
  const body = await c.req.json<Partial<Pick<Year, 'name' | 'owner_clerk_user_id'>>>();
  const fields: string[] = [];
  const values: (string | number)[] = [];
  if (body.name) { fields.push('name = ?'); values.push(body.name.trim()); }
  if (body.owner_clerk_user_id !== undefined) { fields.push('owner_clerk_user_id = ?'); values.push(body.owner_clerk_user_id); }
  if (fields.length === 0) return err('No fields to update');
  fields.push("updated_at = datetime('now')");
  values.push(yearId);
  await c.env.DB.prepare(`UPDATE years SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run();
  return json({ ok: true });
});

// ── Admin: Invites ────────────────────────────────────────────────────────────

admin.get('/years/:yearId/invites', async (c) => {
  const yearId = Number(c.req.param('yearId'));
  const rows = await c.env.DB.prepare(
    'SELECT * FROM invites WHERE year_id = ? ORDER BY created_at DESC'
  ).bind(yearId).all<Invite>();
  return json(rows.results);
});

admin.post('/years/:yearId/invites', async (c) => {
  const access = await authenticate(c, c.env.ADMIN_SECRET, c.env.CLERK_JWKS_URL ?? '');
  const yearId = Number(c.req.param('yearId'));
  const body = await c.req.json<{ label?: string }>();
  const invitedBy = access?.userId === 'admin' ? 'admin' : (access?.userId ?? 'admin');

  const invite = await createUniqueInvite(
    c.env.DB, yearId, body.label?.trim() ?? '', invitedBy,
  );
  return json(invite, 201);
});

admin.post('/years/:yearId/invites/bulk', async (c) => {
  const access = await authenticate(c, c.env.ADMIN_SECRET, c.env.CLERK_JWKS_URL ?? '');
  const yearId = Number(c.req.param('yearId'));
  const body = await c.req.json<{ count: number; label_prefix?: string }>();
  const count = Math.min(Math.max(Math.floor(body.count || 0), 1), 100);
  const invitedBy = access?.userId === 'admin' ? 'admin' : (access?.userId ?? 'admin');
  const prefix = body.label_prefix?.trim() ?? '';

  const invites: Invite[] = [];
  for (let i = 0; i < count; i++) {
    const label = prefix ? `${prefix} ${i + 1}` : `Invite ${i + 1}`;
    invites.push(await createUniqueInvite(c.env.DB, yearId, label, invitedBy));
  }
  return json({ invites }, 201);
});

admin.delete('/years/:yearId/invites/:inviteId', async (c) => {
  const yearId = Number(c.req.param('yearId'));
  const inviteId = Number(c.req.param('inviteId'));
  await c.env.DB.prepare('DELETE FROM invites WHERE id = ? AND year_id = ?').bind(inviteId, yearId).run();
  return json({ ok: true });
});

// ── Admin: Year Members ───────────────────────────────────────────────────────

admin.get('/years/:yearId/members', async (c) => {
  const yearId = Number(c.req.param('yearId'));
  const rows = await c.env.DB.prepare(
    'SELECT * FROM year_members WHERE year_id = ? ORDER BY joined_at'
  ).bind(yearId).all<YearMember>();
  return json(rows.results);
});

admin.get('/invite-requests', async (c) => {
  const status = c.req.query('status');
  const sql = status
    ? 'SELECT * FROM invite_requests WHERE status = ? ORDER BY created_at DESC'
    : "SELECT * FROM invite_requests ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, created_at DESC";
  const rows = status
    ? await c.env.DB.prepare(sql).bind(status).all<InviteRequest>()
    : await c.env.DB.prepare(sql).all<InviteRequest>();
  return json(rows.results);
});

admin.patch('/invite-requests/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json<{ status?: 'pending' | 'approved' | 'rejected'; admin_notes?: string }>();
  const fields: string[] = [];
  const values: (string | number)[] = [];
  if (body.status !== undefined) { fields.push('status = ?'); values.push(body.status); }
  if (body.admin_notes !== undefined) { fields.push('admin_notes = ?'); values.push(body.admin_notes.trim()); }
  if (fields.length === 0) return err('No fields to update');
  fields.push("updated_at = datetime('now')");
  values.push(id);
  await c.env.DB.prepare(`UPDATE invite_requests SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run();
  return json({ ok: true });
});

admin.delete('/invite-requests/:id', async (c) => {
  const id = Number(c.req.param('id'));
  await c.env.DB.prepare('DELETE FROM invite_requests WHERE id = ?').bind(id).run();
  return json({ ok: true });
});

type BackgroundRow = {
  id: number;
  url: string;
  label: string;
  sort_order: number;
  active: number;
  created_at: string;
};

function isValidBackgroundUrl(url: string): boolean {
  try {
    const u = new URL(url.trim());
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

function mapBackground(row: BackgroundRow) {
  return {
    id: row.id,
    url: row.url,
    label: row.label,
    sort_order: row.sort_order,
    active: row.active === 1,
    created_at: row.created_at,
  };
}

admin.get('/backgrounds', async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT * FROM backgrounds ORDER BY sort_order ASC, id ASC'
  ).all<BackgroundRow>();
  return json(rows.results.map(mapBackground));
});

admin.post('/backgrounds', async (c) => {
  const body = await c.req.json<{ url: string; label?: string }>();
  const url = body.url?.trim() ?? '';
  if (!isValidBackgroundUrl(url)) return err('A valid http(s) URL is required');

  const maxOrder = await c.env.DB.prepare(
    'SELECT COALESCE(MAX(sort_order), -1) AS m FROM backgrounds'
  ).first<{ m: number }>();

  try {
    const result = await c.env.DB.prepare(`
      INSERT INTO backgrounds (url, label, sort_order) VALUES (?, ?, ?)
    `).bind(url, body.label?.trim() ?? '', (maxOrder?.m ?? -1) + 1).run();

    const row = await c.env.DB.prepare(
      'SELECT * FROM backgrounds WHERE id = ?'
    ).bind(result.meta.last_row_id).first<BackgroundRow>();
    return json(mapBackground(row!), 201);
  } catch (e) {
    if (e instanceof Error && e.message.includes('UNIQUE')) return err('This URL is already added', 409);
    throw e;
  }
});

admin.patch('/backgrounds/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json<Partial<{ url: string; label: string; active: boolean; sort_order: number }>>();

  const fields: string[] = [];
  const values: (string | number)[] = [];

  if ('url' in body) {
    const url = body.url?.trim() ?? '';
    if (!isValidBackgroundUrl(url)) return err('A valid http(s) URL is required');
    fields.push('url = ?');
    values.push(url);
  }
  if ('label' in body) {
    fields.push('label = ?');
    values.push(body.label?.trim() ?? '');
  }
  if ('active' in body) {
    fields.push('active = ?');
    values.push(body.active ? 1 : 0);
  }
  if ('sort_order' in body && body.sort_order != null) {
    fields.push('sort_order = ?');
    values.push(body.sort_order);
  }

  if (fields.length === 0) return err('No fields to update');

  values.push(id);
  try {
    await c.env.DB.prepare(
      `UPDATE backgrounds SET ${fields.join(', ')} WHERE id = ?`
    ).bind(...values).run();
  } catch (e) {
    if (e instanceof Error && e.message.includes('UNIQUE')) return err('This URL is already added', 409);
    throw e;
  }

  const row = await c.env.DB.prepare('SELECT * FROM backgrounds WHERE id = ?').bind(id).first<BackgroundRow>();
  if (!row) return err('Not found', 404);
  return json(mapBackground(row));
});

admin.delete('/backgrounds/:id', async (c) => {
  const id = Number(c.req.param('id'));
  await c.env.DB.prepare('DELETE FROM backgrounds WHERE id = ?').bind(id).run();
  return json({ ok: true });
});

app.route('/api/admin', admin);

// ── Public backgrounds ────────────────────────────────────────────────────────

app.get('/api/backgrounds', async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT url FROM backgrounds WHERE active = 1 ORDER BY sort_order ASC, id ASC'
  ).all<{ url: string }>();
  return json({ urls: rows.results.map((r) => r.url) });
});

// ── Stats ─────────────────────────────────────────────────────────────────────

app.get('/api/stats', async (c) => {
  const db = c.env.DB;

  const [yearRows, buyerRows, retentionRows] = await Promise.all([
    db.prepare(`
      SELECT
        e.year, e.reg_type,
        COUNT(p.id) AS total,
        SUM(CASE WHEN p.pur_preview OR p.pur_thu OR p.pur_fri OR p.pur_sat OR p.pur_sun THEN 1 ELSE 0 END) AS purchased_any,
        SUM(p.paid) AS paid_count,
        SUM(p.req_preview) AS req_preview, SUM(p.req_thu) AS req_thu,
        SUM(p.req_fri) AS req_fri, SUM(p.req_sat) AS req_sat, SUM(p.req_sun) AS req_sun,
        SUM(p.pur_preview) AS pur_preview, SUM(p.pur_thu) AS pur_thu,
        SUM(p.pur_fri) AS pur_fri, SUM(p.pur_sat) AS pur_sat, SUM(p.pur_sun) AS pur_sun,
        SUM(p.badge_type = 'JUNIOR') AS junior_count
      FROM events e JOIN participants p ON p.event_id = e.id
      WHERE e.status = 'complete'
      GROUP BY e.year, e.reg_type
      ORDER BY e.year, e.reg_type
    `).all(),
    db.prepare(`
      SELECT
        who_purchased AS name,
        COUNT(*) AS participants_served,
        COUNT(DISTINCT e.year) AS years_active,
        GROUP_CONCAT(DISTINCT e.year ORDER BY e.year) AS year_list
      FROM participants p JOIN events e ON e.id = p.event_id
      WHERE who_purchased != '' AND LENGTH(who_purchased) < 25
        AND (p.pur_preview OR p.pur_thu OR p.pur_fri OR p.pur_sat OR p.pur_sun)
      GROUP BY who_purchased
      ORDER BY participants_served DESC
      LIMIT 20
    `).all(),
    db.prepare(`
      SELECT
        UPPER(p.member_id) AS member_id,
        MAX(p.first_name) AS first_name,
        MAX(p.last_name) AS last_name,
        COUNT(DISTINCT e.year) AS year_count,
        GROUP_CONCAT(DISTINCT e.year ORDER BY e.year) AS years
      FROM participants p JOIN events e ON e.id = p.event_id
      WHERE p.member_id != ''
      GROUP BY UPPER(p.member_id)
      HAVING year_count >= 2
      ORDER BY year_count DESC, UPPER(p.member_id)
      LIMIT 30
    `).all(),
  ]);

  return json({ years: yearRows.results, top_buyers: buyerRows.results, retention: retentionRows.results });
});

app.get('/api/health', (c) => json({ ok: true, ts: new Date().toISOString() }));

export default app;
