import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { type Event, type Participant, type Coordinator, type YearMeta, type Group, type Sponsor, type InviteRequest, enrichParticipant, isClaimExpired } from './db';

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

function isAdminAuth(authHeader: string | undefined, adminSecret: string): boolean {
  return authHeader === `Bearer ${adminSecret}`;
}

const app = new Hono<{ Bindings: Bindings }>();

// CORS — allow Vercel frontend and local dev
app.use('*', async (c, next) => {
  const origin = c.req.header('origin') || '';
  const allowed = [
    c.env.FRONTEND_URL,
    'http://localhost:5173',
    'http://localhost:3000',
  ];
  return cors({
    origin: (o) => (allowed.includes(o) ? o : allowed[0]),
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'x-access-token'],
    maxAge: 86400,
  })(c, next);
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function json<T>(data: T, status = 200) {
  return Response.json(data, { status });
}

function err(msg: string, status = 400) {
  return Response.json({ error: msg }, { status });
}

async function getEvent(db: D1Database, id: number): Promise<Event | null> {
  return db.prepare('SELECT * FROM events WHERE id = ?').bind(id).first<Event>();
}

// ── Public routes ─────────────────────────────────────────────────────────────

// List sponsors (public — needed for registration dropdown)
app.get('/api/sponsors', async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT * FROM sponsors ORDER BY name ASC'
  ).all<Sponsor>();
  return json(rows.results);
});

// Submit an invite request (public)
app.post('/api/invite-requests', async (c) => {
  const body = await c.req.json<{ email: string; referred_by: string; notes?: string }>();
  if (!body.email?.trim()) return err('Email is required');
  if (!body.referred_by?.trim()) return err('Please tell us who referred you');

  // Prevent duplicate pending requests from the same email
  const existing = await c.env.DB.prepare(
    "SELECT id FROM invite_requests WHERE LOWER(email) = LOWER(?) AND status = 'pending'"
  ).bind(body.email.trim()).first();
  if (existing) return err('A pending request from this email already exists', 409);

  await c.env.DB.prepare(
    'INSERT INTO invite_requests (email, referred_by, notes) VALUES (?, ?, ?)'
  ).bind(
    body.email.trim().toLowerCase(),
    body.referred_by.trim(),
    body.notes?.trim() ?? '',
  ).run();

  return json({ ok: true }, 201);
});

// List events (public — only id, year, name, status, reg_type; no prices/tokens)
app.get('/api/events', async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT id, year, name, reg_type, status FROM events ORDER BY year DESC, id DESC'
  ).all<Pick<Event, 'id' | 'year' | 'name' | 'reg_type' | 'status'>>();
  return json(rows.results);
});

// Get event detail (requires access_token OR admin auth)
app.get('/api/events/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const token = c.req.query('token') || c.req.header('x-access-token');
  const authHeader = c.req.header('authorization');
  const isAdmin = authHeader === `Bearer ${c.env.ADMIN_SECRET}`;

  const event = await getEvent(c.env.DB, id);
  if (!event) return err('Event not found', 404);

  if (!isAdmin && token !== event.access_token) return err('Invalid token', 401);

  // Strip internal token from non-admin responses
  if (!isAdmin) {
    const { access_token: _, ...safe } = event;
    return json(safe);
  }
  return json(event);
});

// Get live board (participants for event — requires access_token or admin)
app.get('/api/events/:id/participants', async (c) => {
  const id = Number(c.req.param('id'));
  const token = c.req.query('token') || c.req.header('x-access-token');
  const authHeader = c.req.header('authorization');
  const isAdmin = authHeader === `Bearer ${c.env.ADMIN_SECRET}`;

  const event = await getEvent(c.env.DB, id);
  if (!event) return err('Event not found', 404);
  if (!isAdmin && token !== event.access_token) return err('Invalid token', 401);

  const rows = await c.env.DB.prepare(
    `SELECT p.*, g.name AS group_name, g.color AS group_color, s.name AS sponsor_name
     FROM participants p
     LEFT JOIN groups g ON g.id = p.group_id
     LEFT JOIN sponsors s ON s.id = p.sponsor_id
     WHERE p.event_id = ?
     ORDER BY p.sort_order ASC, p.id ASC`
  ).bind(id).all<Participant>();

  const enriched = rows.results.map((p) => enrichParticipant(p, event));
  return json(enriched);
});

// Register self (participant self-registration)
app.post('/api/events/:id/register', async (c) => {
  const id = Number(c.req.param('id'));
  const token = c.req.query('token') || c.req.header('x-access-token');

  const event = await getEvent(c.env.DB, id);
  if (!event) return err('Event not found', 404);
  if (token !== event.access_token) return err('Invalid token', 401);
  if (event.status !== 'registration') return err('Registration is not open', 403);

  const body = await c.req.json<{
    first_name: string;
    last_name: string;
    member_id?: string;
    badge_type?: string;
    sponsor_id: number;
    req_preview?: boolean;
    req_thu?: boolean;
    req_fri?: boolean;
    req_sat?: boolean;
    req_sun?: boolean;
  }>();

  if (!body.first_name?.trim() || !body.last_name?.trim()) {
    return err('First and last name required');
  }
  if (!body.sponsor_id) return err('Sponsor is required');

  const badgeType = body.badge_type === 'JUNIOR' ? 'JUNIOR' : 'ADULT';

  let result;
  try {
    result = await c.env.DB.prepare(`
      INSERT INTO participants
        (event_id, first_name, last_name, member_id, badge_type, sponsor_id,
         req_preview, req_thu, req_fri, req_sat, req_sun, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 9999)
    `).bind(
      id,
      body.first_name.trim(),
      body.last_name.trim(),
      body.member_id?.trim() ?? '',
      badgeType,
      body.sponsor_id,
      body.req_preview ? 1 : 0,
      body.req_thu ? 1 : 0,
      body.req_fri ? 1 : 0,
      body.req_sat ? 1 : 0,
      body.req_sun ? 1 : 0,
    ).run();
  } catch (e) {
    if (e instanceof Error && e.message.includes('UNIQUE')) return err('Member ID is already registered for this event', 409);
    throw e;
  }

  return json({ ok: true, id: result.meta.last_row_id }, 201);
});

// Claim a participant row for purchasing
app.post('/api/events/:id/participants/:pid/claim', async (c) => {
  const eventId = Number(c.req.param('id'));
  const pid = Number(c.req.param('pid'));
  const token = c.req.query('token') || c.req.header('x-access-token');
  const authHeader = c.req.header('authorization');
  const isAdmin = authHeader === `Bearer ${c.env.ADMIN_SECRET}`;

  const event = await getEvent(c.env.DB, eventId);
  if (!event) return err('Event not found', 404);
  if (!isAdmin && token !== event.access_token) return err('Invalid token', 401);
  if (event.status !== 'purchasing') return err('Not in purchasing phase', 403);

  const body = await c.req.json<{ coordinator_name: string }>();
  if (!body.coordinator_name?.trim()) return err('coordinator_name required');

  const p = await c.env.DB.prepare('SELECT * FROM participants WHERE id = ? AND event_id = ?')
    .bind(pid, eventId).first<Participant>();
  if (!p) return err('Participant not found', 404);

  // If already claimed and not expired, reject
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

// Release a claim
app.post('/api/events/:id/participants/:pid/unclaim', async (c) => {
  const eventId = Number(c.req.param('id'));
  const pid = Number(c.req.param('pid'));
  const token = c.req.query('token') || c.req.header('x-access-token');
  const authHeader = c.req.header('authorization');
  const isAdmin = authHeader === `Bearer ${c.env.ADMIN_SECRET}`;

  const event = await getEvent(c.env.DB, eventId);
  if (!event) return err('Event not found', 404);
  if (!isAdmin && token !== event.access_token) return err('Invalid token', 401);

  await c.env.DB.prepare(`
    UPDATE participants
    SET purchasing_claimed_by = '', purchasing_claimed_at = NULL, updated_at = datetime('now')
    WHERE id = ? AND event_id = ?
  `).bind(pid, eventId).run();

  return json({ ok: true });
});

// Update purchased days + who_purchased
app.patch('/api/events/:id/participants/:pid/purchased', async (c) => {
  const eventId = Number(c.req.param('id'));
  const pid = Number(c.req.param('pid'));
  const token = c.req.query('token') || c.req.header('x-access-token');
  const authHeader = c.req.header('authorization');
  const isAdmin = authHeader === `Bearer ${c.env.ADMIN_SECRET}`;

  const event = await getEvent(c.env.DB, eventId);
  if (!event) return err('Event not found', 404);
  if (!isAdmin && token !== event.access_token) return err('Invalid token', 401);

  const body = await c.req.json<{
    pur_preview?: boolean;
    pur_thu?: boolean;
    pur_fri?: boolean;
    pur_sat?: boolean;
    pur_sun?: boolean;
    who_purchased?: string;
  }>();

  await c.env.DB.prepare(`
    UPDATE participants
    SET pur_preview = ?, pur_thu = ?, pur_fri = ?, pur_sat = ?, pur_sun = ?,
        who_purchased = ?, updated_at = datetime('now')
    WHERE id = ? AND event_id = ?
  `).bind(
    body.pur_preview ? 1 : 0,
    body.pur_thu ? 1 : 0,
    body.pur_fri ? 1 : 0,
    body.pur_sat ? 1 : 0,
    body.pur_sun ? 1 : 0,
    body.who_purchased?.trim() ?? '',
    pid, eventId,
  ).run();

  return json({ ok: true });
});

// Update requested days (self-service)
app.patch('/api/events/:id/participants/:pid/requested', async (c) => {
  const eventId = Number(c.req.param('id'));
  const pid = Number(c.req.param('pid'));
  const token = c.req.query('token') || c.req.header('x-access-token');
  const authHeader = c.req.header('authorization');
  const isAdmin = authHeader === `Bearer ${c.env.ADMIN_SECRET}`;

  const event = await getEvent(c.env.DB, eventId);
  if (!event) return err('Event not found', 404);
  if (!isAdmin && token !== event.access_token) return err('Invalid token', 401);

  const body = await c.req.json<{
    req_preview?: boolean;
    req_thu?: boolean;
    req_fri?: boolean;
    req_sat?: boolean;
    req_sun?: boolean;
  }>();

  await c.env.DB.prepare(`
    UPDATE participants
    SET req_preview = ?, req_thu = ?, req_fri = ?, req_sat = ?, req_sun = ?,
        updated_at = datetime('now')
    WHERE id = ? AND event_id = ?
  `).bind(
    body.req_preview ? 1 : 0,
    body.req_thu ? 1 : 0,
    body.req_fri ? 1 : 0,
    body.req_sat ? 1 : 0,
    body.req_sun ? 1 : 0,
    pid, eventId,
  ).run();

  return json({ ok: true });
});

// Mark participant as paid (self-service)
app.patch('/api/events/:id/participants/:pid/paid', async (c) => {
  const eventId = Number(c.req.param('id'));
  const pid = Number(c.req.param('pid'));
  const token = c.req.query('token') || c.req.header('x-access-token');
  const authHeader = c.req.header('authorization');
  const isAdmin = authHeader === `Bearer ${c.env.ADMIN_SECRET}`;

  const event = await getEvent(c.env.DB, eventId);
  if (!event) return err('Event not found', 404);
  if (!isAdmin && token !== event.access_token) return err('Invalid token', 401);

  const body = await c.req.json<{ paid: boolean }>();

  await c.env.DB.prepare(`
    UPDATE participants SET paid = ?, updated_at = datetime('now') WHERE id = ? AND event_id = ?
  `).bind(body.paid ? 1 : 0, pid, eventId).run();

  return json({ ok: true });
});

// Get coordinators for an event
app.get('/api/events/:id/coordinators', async (c) => {
  const id = Number(c.req.param('id'));
  const token = c.req.query('token') || c.req.header('x-access-token');
  const authHeader = c.req.header('authorization');
  const isAdmin = authHeader === `Bearer ${c.env.ADMIN_SECRET}`;

  const event = await getEvent(c.env.DB, id);
  if (!event) return err('Event not found', 404);
  if (!isAdmin && token !== event.access_token) return err('Invalid token', 401);

  const rows = await c.env.DB.prepare(
    'SELECT * FROM coordinators WHERE event_id = ? ORDER BY name ASC'
  ).bind(id).all<Coordinator>();
  return json(rows.results);
});

// Upsert coordinator payment info (self-service)
app.put('/api/events/:id/coordinators/:name', async (c) => {
  const eventId = Number(c.req.param('id'));
  const name = decodeURIComponent(c.req.param('name'));
  const token = c.req.query('token') || c.req.header('x-access-token');
  const authHeader = c.req.header('authorization');
  const isAdmin = authHeader === `Bearer ${c.env.ADMIN_SECRET}`;

  const event = await getEvent(c.env.DB, eventId);
  if (!event) return err('Event not found', 404);
  if (!isAdmin && token !== event.access_token) return err('Invalid token', 401);

  const body = await c.req.json<{
    venmo?: string; zelle?: string; paypal?: string; phone_last4?: string;
  }>();

  await c.env.DB.prepare(`
    INSERT INTO coordinators (event_id, name, venmo, zelle, paypal, phone_last4)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_id, name) DO UPDATE SET
      venmo = excluded.venmo, zelle = excluded.zelle,
      paypal = excluded.paypal, phone_last4 = excluded.phone_last4,
      updated_at = datetime('now')
  `).bind(
    eventId, name,
    body.venmo?.trim() ?? '',
    body.zelle?.trim() ?? '',
    body.paypal?.trim() ?? '',
    body.phone_last4?.trim() ?? '',
  ).run();

  return json({ ok: true });
});

// Update participant profile (name, member_id, badge_type, notes) — token-gated
app.patch('/api/events/:id/participants/:pid/profile', async (c) => {
  const eventId = Number(c.req.param('id'));
  const pid = Number(c.req.param('pid'));
  const token = c.req.query('token') || c.req.header('x-access-token');
  const authHeader = c.req.header('authorization');
  const isAdmin = authHeader === `Bearer ${c.env.ADMIN_SECRET}`;

  const event = await getEvent(c.env.DB, eventId);
  if (!event) return err('Event not found', 404);
  if (!isAdmin && token !== event.access_token) return err('Invalid token', 401);

  const body = await c.req.json<{
    first_name?: string; last_name?: string; member_id?: string;
    badge_type?: string; notes?: string;
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
    if (e instanceof Error && e.message.includes('UNIQUE')) return err('Member ID is already used by another participant in this event', 409);
    throw e;
  }

  return json({ ok: true });
});

// Get groups for an event (public, token-gated)
app.get('/api/events/:id/groups', async (c) => {
  const id = Number(c.req.param('id'));
  const token = c.req.query('token') || c.req.header('x-access-token');
  const authHeader = c.req.header('authorization');
  const isAdmin = authHeader === `Bearer ${c.env.ADMIN_SECRET}`;
  const event = await getEvent(c.env.DB, id);
  if (!event) return err('Event not found', 404);
  if (!isAdmin && token !== event.access_token) return err('Invalid token', 401);
  const rows = await c.env.DB.prepare(
    'SELECT * FROM groups WHERE event_id = ? ORDER BY sort_order ASC, id ASC'
  ).bind(id).all<Group>();
  return json(rows.results);
});

// Resolve current Clerk user's participant identity for an event
app.get('/api/events/:id/me', async (c) => {
  const id = Number(c.req.param('id'));
  const token = c.req.query('token') || c.req.header('x-access-token');
  const event = await getEvent(c.env.DB, id);
  if (!event) return err('Event not found', 404);
  if (!isAdminAuth(c.req.header('authorization'), c.env.ADMIN_SECRET) && token !== event.access_token) {
    return err('Invalid token', 401);
  }
  const userId = await getClerkUserId(c, c.env.CLERK_JWKS_URL ?? '');
  if (!userId) return err('Not authenticated', 401);
  const participant = await c.env.DB.prepare(
    `SELECT p.*, g.name AS group_name, g.color AS group_color, s.name AS sponsor_name
     FROM participants p
     LEFT JOIN groups g ON g.id = p.group_id
     LEFT JOIN sponsors s ON s.id = p.sponsor_id
     WHERE p.event_id = ? AND p.clerk_user_id = ?`
  ).bind(id, userId).first<Participant>();
  if (!participant) return json({ linked: false });
  return json({ linked: true, participant: enrichParticipant(participant, event) });
});

// Link current Clerk user to a participant row (one-time identity setup)
app.post('/api/events/:id/participants/:pid/link-identity', async (c) => {
  const eventId = Number(c.req.param('id'));
  const pid = Number(c.req.param('pid'));
  const token = c.req.query('token') || c.req.header('x-access-token');
  const event = await getEvent(c.env.DB, eventId);
  if (!event) return err('Event not found', 404);
  if (!isAdminAuth(c.req.header('authorization'), c.env.ADMIN_SECRET) && token !== event.access_token) {
    return err('Invalid token', 401);
  }
  const userId = await getClerkUserId(c, c.env.CLERK_JWKS_URL ?? '');
  if (!userId) return err('Not authenticated', 401);
  // Prevent a single Clerk account from claiming two different slots in the same event
  const existing = await c.env.DB.prepare(
    'SELECT id FROM participants WHERE event_id = ? AND clerk_user_id = ?'
  ).bind(eventId, userId).first();
  if (existing) return err('Already linked to a participant in this event', 409);
  await c.env.DB.prepare(
    "UPDATE participants SET clerk_user_id = ?, updated_at = datetime('now') WHERE id = ? AND event_id = ?"
  ).bind(userId, pid, eventId).run();
  return json({ ok: true });
});

// ── Admin-only routes ─────────────────────────────────────────────────────────

const admin = new Hono<{ Bindings: Bindings }>();
admin.use('*', async (c, next) => {
  const authHeader = c.req.header('authorization') ?? '';
  // Accept legacy ADMIN_SECRET
  if (authHeader === `Bearer ${c.env.ADMIN_SECRET}`) return next();
  // Accept Clerk JWT with admin role
  if (c.env.CLERK_JWKS_URL && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const claims = await verifyClerkJWT(token, c.env.CLERK_JWKS_URL);
    if (claims?.public_metadata?.role === 'admin') return next();
  }
  return Response.json({ error: 'Unauthorized' }, { status: 401 });
});

// Create event
admin.post('/events', async (c) => {
  const body = await c.req.json<Omit<Event, 'id' | 'created_at' | 'updated_at'>>();
  if (!body.year || !body.name) return err('year and name required');

  const token = crypto.randomUUID().replace(/-/g, '');

  const result = await c.env.DB.prepare(`
    INSERT INTO events
      (year, name, reg_type, status, access_token,
       price_preview_adult, price_thu_adult, price_fri_adult, price_sat_adult, price_sun_adult,
       price_preview_junior, price_thu_junior, price_fri_junior, price_sat_junior, price_sun_junior)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    body.year,
    body.name,
    body.reg_type ?? 'open',
    body.status ?? 'setup',
    token,
    body.price_preview_adult ?? 0,
    body.price_thu_adult ?? 0,
    body.price_fri_adult ?? 0,
    body.price_sat_adult ?? 0,
    body.price_sun_adult ?? 0,
    body.price_preview_junior ?? 0,
    body.price_thu_junior ?? 0,
    body.price_fri_junior ?? 0,
    body.price_sat_junior ?? 0,
    body.price_sun_junior ?? 0,
  ).run();

  return json({ id: result.meta.last_row_id, access_token: token }, 201);
});

// Update event
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

  await c.env.DB.prepare(
    `UPDATE events SET ${fields.join(', ')} WHERE id = ?`
  ).bind(...values).run();

  return json({ ok: true });
});

// Regenerate access token
admin.post('/events/:id/token', async (c) => {
  const id = Number(c.req.param('id'));
  const token = crypto.randomUUID().replace(/-/g, '');
  await c.env.DB.prepare(
    "UPDATE events SET access_token = ?, updated_at = datetime('now') WHERE id = ?"
  ).bind(token, id).run();
  return json({ access_token: token });
});

// Delete event
admin.delete('/events/:id', async (c) => {
  const id = Number(c.req.param('id'));
  await c.env.DB.prepare('DELETE FROM events WHERE id = ?').bind(id).run();
  return json({ ok: true });
});

// Add participant (admin)
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
        (event_id, first_name, last_name, member_id, badge_type, return_eligible, sponsor_id, notes,
         req_preview, req_thu, req_fri, req_sat, req_sun, sort_order, purchasing_coordinator)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      eventId,
      body.first_name.trim(),
      body.last_name.trim(),
      body.member_id?.trim() ?? '',
      body.badge_type === 'JUNIOR' ? 'JUNIOR' : 'ADULT',
      body.return_eligible ? 1 : 0,
      body.sponsor_id ?? 1,
      body.notes?.trim() ?? '',
      body.req_preview ? 1 : 0,
      body.req_thu ? 1 : 0,
      body.req_fri ? 1 : 0,
      body.req_sat ? 1 : 0,
      body.req_sun ? 1 : 0,
      body.sort_order ?? 9999,
      body.purchasing_coordinator?.trim() ?? '',
    ).run();
  } catch (e) {
    if (e instanceof Error && e.message.includes('UNIQUE')) return err('Member ID is already used by another participant in this event', 409);
    throw e;
  }

  return json({ id: result.meta.last_row_id }, 201);
});

// Bulk update sort order (must be before /:pid to avoid "sort" being captured as a param)
admin.patch('/events/:id/participants/sort', async (c) => {
  const eventId = Number(c.req.param('id'));
  const body = await c.req.json<{ order: number[] }>(); // array of participant IDs in desired order

  const stmts = body.order.map((pid, idx) =>
    c.env.DB.prepare(
      "UPDATE participants SET sort_order = ?, updated_at = datetime('now') WHERE id = ? AND event_id = ?"
    ).bind(idx + 1, pid, eventId)
  );

  await c.env.DB.batch(stmts);
  return json({ ok: true });
});

// Update participant (admin — full edit)
admin.patch('/events/:id/participants/:pid', async (c) => {
  const eventId = Number(c.req.param('id'));
  const pid = Number(c.req.param('pid'));
  const body = await c.req.json<Partial<Participant>>();

  const allowed = [
    'first_name', 'last_name', 'member_id', 'badge_type', 'return_eligible', 'sponsor_id', 'notes',
    'req_preview', 'req_thu', 'req_fri', 'req_sat', 'req_sun',
    'sort_order', 'purchasing_coordinator',
    'pur_preview', 'pur_thu', 'pur_fri', 'pur_sat', 'pur_sun', 'who_purchased',
    'paid',
  ] as const;

  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  // Handle group_id specially since it can be null
  if ('group_id' in body) {
    fields.push('group_id = ?');
    values.push((body as Partial<Participant & { group_id: number | null }>).group_id === null ? null : Number((body as Partial<Participant & { group_id: number | null }>).group_id));
  }

  for (const key of allowed) {
    if (key in body) {
      fields.push(`${key} = ?`);
      const val = body[key];
      values.push(typeof val === 'boolean' ? (val ? 1 : 0) : (val as string | number));
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
    if (e instanceof Error && e.message.includes('UNIQUE')) return err('Member ID is already used by another participant in this event', 409);
    throw e;
  }

  return json({ ok: true });
});

// Initialize a new year — atomically creates Return Reg + Open Reg events
admin.post('/initialize-year', async (c) => {
  const body = await c.req.json<{
    year: number;
    price_preview_adult: number; price_thu_adult: number; price_fri_adult: number;
    price_sat_adult: number; price_sun_adult: number;
    price_preview_junior: number; price_thu_junior: number; price_fri_junior: number;
    price_sat_junior: number; price_sun_junior: number;
  }>();

  if (!body.year) return err('year required');

  const returnToken = crypto.randomUUID();
  const openToken = crypto.randomUUID();

  const insertSQL = `
    INSERT INTO events (year, name, reg_type, status,
      price_preview_adult, price_thu_adult, price_fri_adult, price_sat_adult, price_sun_adult,
      price_preview_junior, price_thu_junior, price_fri_junior, price_sat_junior, price_sun_junior,
      access_token)
    VALUES (?, ?, ?, 'setup', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  const priceBinds = [
    body.price_preview_adult ?? 0,
    body.price_thu_adult ?? 0,
    body.price_fri_adult ?? 0,
    body.price_sat_adult ?? 0,
    body.price_sun_adult ?? 0,
    body.price_preview_junior ?? 0,
    body.price_thu_junior ?? 0,
    body.price_fri_junior ?? 0,
    body.price_sat_junior ?? 0,
    body.price_sun_junior ?? 0,
  ];

  await c.env.DB.batch([
    c.env.DB.prepare(insertSQL).bind(body.year, `SDCC ${body.year} Return Reg`, 'return', ...priceBinds, returnToken),
    c.env.DB.prepare(insertSQL).bind(body.year, `SDCC ${body.year} Open Reg`, 'open', ...priceBinds, openToken),
  ]);

  return json({ ok: true }, 201);
});

// Copy or transfer participants to another event
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
      `SELECT p.*, g.name AS group_name, g.color AS group_color
       FROM participants p
       LEFT JOIN groups g ON g.id = p.group_id
       WHERE p.event_id = ? AND p.id IN (${placeholders})
       ORDER BY p.sort_order ASC, p.id ASC`
    ).bind(sourceEventId, ...body.participant_ids).all<Participant>();
    participants = rows.results;
  } else {
    const rows = await c.env.DB.prepare(
      `SELECT p.*, g.name AS group_name, g.color AS group_color
       FROM participants p
       LEFT JOIN groups g ON g.id = p.group_id
       WHERE p.event_id = ?
       ORDER BY p.sort_order ASC, p.id ASC`
    ).bind(sourceEventId).all<Participant>();
    participants = rows.results;
  }

  if (participants.length === 0) return err('No participants found', 400);

  const carryover = body.carryover ?? false;
  // carryover implies reset (target event starts fresh, only gap days as requests)
  const reset = carryover ? true : (body.reset_purchasing ?? true);

  const insertStmts = participants.map((p, idx) =>
    c.env.DB.prepare(`
      INSERT INTO participants
        (event_id, first_name, last_name, member_id, badge_type, return_eligible, sponsor_id, notes,
         req_preview, req_thu, req_fri, req_sat, req_sun, sort_order,
         purchasing_coordinator, purchasing_claimed_by,
         pur_preview, pur_thu, pur_fri, pur_sat, pur_sun, who_purchased, paid, clerk_user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      body.target_event_id,
      p.first_name, p.last_name, p.member_id,
      p.badge_type, p.return_eligible ? 1 : 0,
      p.sponsor_id ?? 1, p.notes,
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

// Delete participant
admin.delete('/events/:id/participants/:pid', async (c) => {
  const eventId = Number(c.req.param('id'));
  const pid = Number(c.req.param('pid'));
  await c.env.DB.prepare('DELETE FROM participants WHERE id = ? AND event_id = ?').bind(pid, eventId).run();
  return json({ ok: true });
});

// Add coordinator (admin)
admin.post('/events/:id/coordinators', async (c) => {
  const eventId = Number(c.req.param('id'));
  const body = await c.req.json<Partial<Coordinator>>();
  if (!body.name?.trim()) return err('name required');

  await c.env.DB.prepare(`
    INSERT INTO coordinators (event_id, name, venmo, zelle, paypal, phone_last4)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    eventId, body.name.trim(),
    body.venmo?.trim() ?? '',
    body.zelle?.trim() ?? '',
    body.paypal?.trim() ?? '',
    body.phone_last4?.trim() ?? '',
  ).run();

  return json({ ok: true }, 201);
});

// Delete coordinator
admin.delete('/events/:id/coordinators/:cid', async (c) => {
  const eventId = Number(c.req.param('id'));
  const cid = Number(c.req.param('cid'));
  await c.env.DB.prepare('DELETE FROM coordinators WHERE id = ? AND event_id = ?').bind(cid, eventId).run();
  return json({ ok: true });
});

// Reorder groups (must be before :gid routes to avoid conflict)
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

// Create group
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

// Update group
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

// Delete group (unsets group_id on participants)
admin.delete('/events/:id/groups/:gid', async (c) => {
  const eventId = Number(c.req.param('id'));
  const gid = Number(c.req.param('gid'));
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE participants SET group_id = NULL WHERE group_id = ? AND event_id = ?').bind(gid, eventId),
    c.env.DB.prepare('DELETE FROM groups WHERE id = ? AND event_id = ?').bind(gid, eventId),
  ]);
  return json({ ok: true });
});

// CSV export
admin.get('/events/:id/export.csv', async (c) => {
  const eventId = Number(c.req.param('id'));
  const event = await getEvent(c.env.DB, eventId);
  if (!event) return err('Not found', 404);

  const rows = await c.env.DB.prepare(
    `SELECT p.*, g.name AS group_name, g.color AS group_color, s.name AS sponsor_name
     FROM participants p
     LEFT JOIN groups g ON g.id = p.group_id
     LEFT JOIN sponsors s ON s.id = p.sponsor_id
     WHERE p.event_id = ?
     ORDER BY p.sort_order ASC, p.id ASC`
  ).bind(eventId).all<Participant>();

  const headers = [
    'Sort', 'Last Name', 'First Name', 'Member ID', 'Badge Type', 'Return Eligible', 'Sponsor',
    'Preview', 'Thu', 'Fri', 'Sat', 'Sun',
    'Coordinator', 'Claimed By',
    'Pur Preview', 'Pur Thu', 'Pur Fri', 'Pur Sat', 'Pur Sun',
    'Who Purchased', 'Total ($)', 'Gaps', 'Paid', 'Notes',
  ];

  const csvRows = rows.results.map((p) => {
    const enriched = enrichParticipant(p, event);
    return [
      p.sort_order, p.last_name, p.first_name, p.member_id, p.badge_type,
      enriched.return_eligible ? 'Yes' : 'No', p.sponsor_name ?? '',
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

// Get year meta
admin.get('/year-meta/:year', async (c) => {
  const year = Number(c.req.param('year'));
  const row = await c.env.DB.prepare('SELECT * FROM year_meta WHERE year = ?').bind(year).first<YearMeta>();
  return json(row ?? {
    year, return_reg_start: '', return_reg_end: '',
    open_reg_start: '', open_reg_end: '',
    address_deadline: '', hotel_deadline: '',
    preview_date: '', thu_date: '', fri_date: '', sat_date: '', sun_date: '',
    notes: '', created_at: '', updated_at: '',
  });
});

// Upsert year meta
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

// ── Admin invite request routes ───────────────────────────────────────────────

admin.get('/invite-requests', async (c) => {
  const status = c.req.query('status'); // optional filter: pending | approved | rejected
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

// ── Admin sponsor CRUD ────────────────────────────────────────────────────────

admin.get('/sponsors', async (c) => {
  const rows = await c.env.DB.prepare('SELECT * FROM sponsors ORDER BY name ASC').all<Sponsor>();
  return json(rows.results);
});

admin.post('/sponsors', async (c) => {
  const body = await c.req.json<{ name: string; notes?: string }>();
  if (!body.name?.trim()) return err('name required');
  try {
    const result = await c.env.DB.prepare(
      "INSERT INTO sponsors (name, notes) VALUES (?, ?)"
    ).bind(body.name.trim(), body.notes?.trim() ?? '').run();
    return json({ id: result.meta.last_row_id }, 201);
  } catch (e) {
    if (e instanceof Error && e.message.includes('UNIQUE')) return err('A sponsor with that name already exists', 409);
    throw e;
  }
});

admin.patch('/sponsors/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (id === 1) return err('Cannot modify the Unassigned sentinel', 403);
  const body = await c.req.json<{ name?: string; notes?: string }>();
  const fields: string[] = [];
  const values: (string | number)[] = [];
  if (body.name !== undefined) { fields.push('name = ?'); values.push(body.name.trim()); }
  if (body.notes !== undefined) { fields.push('notes = ?'); values.push(body.notes.trim()); }
  if (fields.length === 0) return err('No fields to update');
  fields.push("updated_at = datetime('now')");
  values.push(id);
  try {
    await c.env.DB.prepare(`UPDATE sponsors SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run();
  } catch (e) {
    if (e instanceof Error && e.message.includes('UNIQUE')) return err('A sponsor with that name already exists', 409);
    throw e;
  }
  return json({ ok: true });
});

admin.delete('/sponsors/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (id === 1) return err('Cannot delete the Unassigned sentinel', 403);
  // Reassign participants to Unassigned before deleting
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE participants SET sponsor_id = 1 WHERE sponsor_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM sponsors WHERE id = ?').bind(id),
  ]);
  return json({ ok: true });
});

app.route('/api/admin', admin);

// ── Stats endpoint (public aggregate data for dashboard) ──────────────────────

app.get('/api/stats', async (c) => {
  const db = c.env.DB;

  const [yearRows, buyerRows, retentionRows] = await Promise.all([
    // Per year/type: totals, success, day breakdowns
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

    // Top buyers across all history
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

    // Return members: appear in 2+ years
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

  return json({
    years: yearRows.results,
    top_buyers: buyerRows.results,
    retention: retentionRows.results,
  });
});

// Health check
app.get('/api/health', (c) => json({ ok: true, ts: new Date().toISOString() }));

export default app;
