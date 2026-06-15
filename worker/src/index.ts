import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { type Event, type Participant, type Coordinator, enrichParticipant, isClaimExpired } from './db';

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

app.route('/api/admin', admin);

// Add unique constraint for coordinators (name per event)
// Health check
app.get('/api/health', (c) => json({ ok: true, ts: new Date().toISOString() }));

export default app;
