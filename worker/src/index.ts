import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { type Event, type Participant, type Coordinator, type YearMeta, enrichParticipant, isClaimExpired } from './db';

type Bindings = {
  DB: D1Database;
  ADMIN_SECRET: string;
  FRONTEND_URL: string;
};

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
    'SELECT * FROM participants WHERE event_id = ? ORDER BY sort_order ASC, id ASC'
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
    sponsor?: string;
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

  await c.env.DB.prepare(`
    INSERT INTO participants
      (event_id, first_name, last_name, member_id, badge_type, sponsor,
       req_preview, req_thu, req_fri, req_sat, req_sun, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 9999)
  `).bind(
    id,
    body.first_name.trim(),
    body.last_name.trim(),
    body.member_id?.trim() ?? '',
    badgeType,
    body.sponsor?.trim() ?? '',
    body.req_preview ? 1 : 0,
    body.req_thu ? 1 : 0,
    body.req_fri ? 1 : 0,
    body.req_sat ? 1 : 0,
    body.req_sun ? 1 : 0,
  ).run();

  return json({ ok: true }, 201);
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

// ── Admin-only routes ─────────────────────────────────────────────────────────

const admin = new Hono<{ Bindings: Bindings }>();
admin.use('*', async (c, next) => {
  const authHeader = c.req.header('authorization') ?? '';
  if (authHeader !== `Bearer ${c.env.ADMIN_SECRET}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return next();
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

  const result = await c.env.DB.prepare(`
    INSERT INTO participants
      (event_id, first_name, last_name, member_id, badge_type, return_eligible, sponsor, notes,
       req_preview, req_thu, req_fri, req_sat, req_sun, sort_order, purchasing_coordinator)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    eventId,
    body.first_name.trim(),
    body.last_name.trim(),
    body.member_id?.trim() ?? '',
    body.badge_type === 'JUNIOR' ? 'JUNIOR' : 'ADULT',
    body.return_eligible ? 1 : 0,
    body.sponsor?.trim() ?? '',
    body.notes?.trim() ?? '',
    body.req_preview ? 1 : 0,
    body.req_thu ? 1 : 0,
    body.req_fri ? 1 : 0,
    body.req_sat ? 1 : 0,
    body.req_sun ? 1 : 0,
    body.sort_order ?? 9999,
    body.purchasing_coordinator?.trim() ?? '',
  ).run();

  return json({ id: result.meta.last_row_id }, 201);
});

// Update participant (admin — full edit)
admin.patch('/events/:id/participants/:pid', async (c) => {
  const eventId = Number(c.req.param('id'));
  const pid = Number(c.req.param('pid'));
  const body = await c.req.json<Partial<Participant>>();

  const allowed = [
    'first_name', 'last_name', 'member_id', 'badge_type', 'return_eligible', 'sponsor', 'notes',
    'req_preview', 'req_thu', 'req_fri', 'req_sat', 'req_sun',
    'sort_order', 'purchasing_coordinator',
    'pur_preview', 'pur_thu', 'pur_fri', 'pur_sat', 'pur_sun', 'who_purchased',
    'paid',
  ] as const;

  const fields: string[] = [];
  const values: (string | number)[] = [];

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

  await c.env.DB.prepare(
    `UPDATE participants SET ${fields.join(', ')} WHERE id = ? AND event_id = ?`
  ).bind(...values).run();

  return json({ ok: true });
});

// Bulk update sort order
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
      `SELECT * FROM participants WHERE event_id = ? AND id IN (${placeholders}) ORDER BY sort_order ASC, id ASC`
    ).bind(sourceEventId, ...body.participant_ids).all<Participant>();
    participants = rows.results;
  } else {
    const rows = await c.env.DB.prepare(
      'SELECT * FROM participants WHERE event_id = ? ORDER BY sort_order ASC, id ASC'
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
        (event_id, first_name, last_name, member_id, badge_type, return_eligible, sponsor, notes,
         req_preview, req_thu, req_fri, req_sat, req_sun, sort_order,
         purchasing_coordinator, purchasing_claimed_by,
         pur_preview, pur_thu, pur_fri, pur_sat, pur_sun, who_purchased, paid)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      body.target_event_id,
      p.first_name, p.last_name, p.member_id,
      p.badge_type, p.return_eligible ? 1 : 0,
      p.sponsor, p.notes,
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

// CSV export
admin.get('/events/:id/export.csv', async (c) => {
  const eventId = Number(c.req.param('id'));
  const event = await getEvent(c.env.DB, eventId);
  if (!event) return err('Not found', 404);

  const rows = await c.env.DB.prepare(
    'SELECT * FROM participants WHERE event_id = ? ORDER BY sort_order ASC, id ASC'
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
      enriched.return_eligible ? 'Yes' : 'No', p.sponsor,
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

app.route('/api/admin', admin);

// Add unique constraint for coordinators (name per event)
// Health check
app.get('/api/health', (c) => json({ ok: true, ts: new Date().toISOString() }));

export default app;
