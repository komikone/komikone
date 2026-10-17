import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { type Event, type Participant, type Coordinator, type YearMeta, type Group, type InviteRequest, type Profile, type Year, type YearMember, type Invite, type PurchaseQueueEntry, type PurchaseQueueStatus, enrichParticipant, inviteUnavailableMessage, MAX_SHARED_INVITE_USES, isClaimExpired, CLAIM_TIMEOUT_MINUTES, MAX_ACTIVE_CLAIMS, anyPurchased, nothingLeftToBuy, SALE_DAYS, type SaleDay } from './db';
import {
  assertPreviewNightAllowed,
  assertRegistrationOpen,
  daysToSql,
  groupDisplayName,
  mapGroupIdForCopy,
  normalizeDays,
  resolveSelfParticipant,
} from './persistence';
import { sendClerkInvitationEmail, revokeClerkInvitation, fetchClerkUserEmail } from './clerk';
import { seedDummies, clearDummies, countDummies } from './seedDummies';

type Bindings = {
  DB: D1Database;
  ADMIN_SECRET: string;
  FRONTEND_URL: string;
  CLERK_JWKS_URL: string;
  CLERK_SECRET_KEY?: string;
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

/** Self, group owner, registrar, or platform admin may edit requested days / profile. */
async function canEditParticipantIdentity(
  db: D1Database,
  access: { isAdmin: boolean; userId: string },
  eventId: number,
  pid: number,
): Promise<boolean> {
  if (access.userId === 'admin') return true;

  const p = await db.prepare(
    `SELECT clerk_user_id, group_id, registered_by_clerk_user_id
     FROM participants WHERE id = ? AND event_id = ?`
  ).bind(pid, eventId).first<{
    clerk_user_id: string | null;
    group_id: number | null;
    registered_by_clerk_user_id: string | null;
  }>();
  if (!p) return false;
  if (p.clerk_user_id === access.userId) return true;
  if (p.registered_by_clerk_user_id === access.userId) return true;
  if (p.group_id) {
    const g = await db.prepare(
      'SELECT owner_clerk_user_id FROM groups WHERE id = ?'
    ).bind(p.group_id).first<{ owner_clerk_user_id: string | null }>();
    if (g?.owner_clerk_user_id === access.userId) return true;
  }
  return false;
}

/**
 * Active claim by the authenticated user (admins must claim too). Once a claim
 * auto-releases on Done, the recorded buyer can still correct their own purchase.
 */
async function canActOnClaimedParticipant(
  db: D1Database,
  access: { userId: string; isAdmin: boolean },
  eventId: number,
  pid: number,
): Promise<boolean> {
  // Admins fix records after the fact, when nobody holds a claim any more.
  if (access.isAdmin) {
    return !!(await db.prepare('SELECT id FROM participants WHERE id = ? AND event_id = ?').bind(pid, eventId).first());
  }
  const target = await db.prepare(
    'SELECT purchasing_claimed_by, purchasing_claimed_at, who_purchased FROM participants WHERE id = ? AND event_id = ?'
  ).bind(pid, eventId).first<{ purchasing_claimed_by: string; purchasing_claimed_at: string | null; who_purchased: string }>();
  if (!target) return false;

  const claimActive = !!target.purchasing_claimed_by && !isClaimExpired(target.purchasing_claimed_at);
  const buyerOnRecord = target.who_purchased?.trim() ?? '';
  if (!claimActive && !buyerOnRecord) return false;

  const me = await db.prepare(
    'SELECT first_name, last_name FROM participants WHERE event_id = ? AND clerk_user_id = ?'
  ).bind(eventId, access.userId).first<{ first_name: string; last_name: string }>();
  const myName = me ? `${me.first_name} ${me.last_name}`.trim().toLowerCase() : '';
  if (!myName) return false;

  if (claimActive) return target.purchasing_claimed_by.trim().toLowerCase() === myName;
  return buyerOnRecord.toLowerCase() === myName;
}

/** Resolve (and self-heal) the years row for an event. Never leaves year_id null when a years row exists. */
async function ensureEventYear(
  db: D1Database,
  event: Event,
): Promise<{ yearId: number; conYear: number } | null> {
  if (event.year_id) {
    const row = await db.prepare('SELECT id, con_year FROM years WHERE id = ?')
      .bind(event.year_id).first<{ id: number; con_year: number }>();
    if (row) return { yearId: row.id, conYear: row.con_year };
  }

  let year = await db.prepare('SELECT id, con_year FROM years WHERE con_year = ?')
    .bind(event.year).first<{ id: number; con_year: number }>();

  if (!year) {
    // Fall back to current (latest) year so registrants are never year-less
    year = await db.prepare('SELECT id, con_year FROM years ORDER BY con_year DESC LIMIT 1')
      .first<{ id: number; con_year: number }>();
  }
  if (!year) return null;

  await db.prepare(
    'UPDATE events SET year_id = ?, year = ?, updated_at = datetime(\'now\') WHERE id = ?'
  ).bind(year.id, year.con_year, event.id).run();
  event.year_id = year.id;
  event.year = year.con_year;
  return { yearId: year.id, conYear: year.con_year };
}

/** Ensure a signed-in registrant has a year_members row for the event's year. */
async function ensureYearMemberForRegistrant(
  db: D1Database,
  yearId: number,
  clerkUserId: string,
  identity: {
    first_name: string;
    last_name: string;
    member_id: string;
    badge_type: 'ADULT' | 'JUNIOR';
  },
): Promise<YearMember> {
  const existing = await db.prepare(
    'SELECT * FROM year_members WHERE year_id = ? AND clerk_user_id = ?'
  ).bind(yearId, clerkUserId).first<YearMember>();

  if (existing) {
    await db.prepare(`
      UPDATE year_members SET
        first_name = ?, last_name = ?, member_id = ?, badge_type = ?
      WHERE id = ?
    `).bind(
      identity.first_name, identity.last_name, identity.member_id, identity.badge_type,
      existing.id,
    ).run();
    return {
      ...existing,
      first_name: identity.first_name,
      last_name: identity.last_name,
      member_id: identity.member_id,
      badge_type: identity.badge_type,
    };
  }

  await db.prepare(`
    INSERT INTO year_members (year_id, clerk_user_id, role, first_name, last_name, member_id, badge_type)
    VALUES (?, ?, 'registered', ?, ?, ?, ?)
  `).bind(
    yearId, clerkUserId,
    identity.first_name, identity.last_name, identity.member_id, identity.badge_type,
  ).run();

  const created = await db.prepare(
    'SELECT * FROM year_members WHERE year_id = ? AND clerk_user_id = ?'
  ).bind(yearId, clerkUserId).first<YearMember>();
  if (!created) throw new Error('Could not create year membership');
  return created;
}

/** Find or create a years row for a con_year (used when creating events). */
async function resolveOrCreateYearId(
  db: D1Database,
  conYear: number,
  ownerClerkUserId = '',
): Promise<number> {
  const existing = await db.prepare('SELECT id FROM years WHERE con_year = ?')
    .bind(conYear).first<{ id: number }>();
  if (existing) return existing.id;

  const result = await db.prepare(
    'INSERT INTO years (name, con_year, owner_clerk_user_id) VALUES (?, ?, ?)'
  ).bind(`SDCC ${conYear}`, conYear, ownerClerkUserId).run();
  return Number(result.meta.last_row_id);
}

async function getOrCreateOwnerGroup(
  db: D1Database,
  eventId: number,
  clerkUserId: string,
  identity: { first_name?: string | null; last_name?: string | null },
): Promise<Group> {
  let group = await db.prepare(
    'SELECT * FROM groups WHERE event_id = ? AND owner_clerk_user_id = ?'
  ).bind(eventId, clerkUserId).first<Group>();

  if (!group) {
    await db.prepare(`
      INSERT INTO groups (event_id, name, color, owner_clerk_user_id)
      VALUES (?, ?, ?, ?)
    `).bind(eventId, groupDisplayName(identity), '#3b82f6', clerkUserId).run();
    group = await db.prepare(
      'SELECT * FROM groups WHERE event_id = ? AND owner_clerk_user_id = ?'
    ).bind(eventId, clerkUserId).first<Group>();
  }
  if (!group) throw new Error('Could not create group');
  return group;
}

async function findEventParticipants(
  db: D1Database,
  eventId: number,
): Promise<{ id: number; clerk_user_id: string | null; member_id: string | null; group_id: number | null }[]> {
  const rows = await db.prepare(
    'SELECT id, clerk_user_id, member_id, group_id FROM participants WHERE event_id = ?'
  ).bind(eventId).all<{ id: number; clerk_user_id: string | null; member_id: string | null; group_id: number | null }>();
  return rows.results;
}

async function upsertSelfParticipantDays(
  db: D1Database,
  opts: {
    eventId: number;
    clerkUserId: string;
    groupId: number;
    identity: { first_name: string; last_name: string; member_id: string; badge_type: string };
    days: ReturnType<typeof normalizeDays>;
  },
): Promise<number> {
  const rows = await findEventParticipants(db, opts.eventId);
  const self = resolveSelfParticipant(rows, {
    clerkUserId: opts.clerkUserId,
    memberId: opts.identity.member_id,
    groupId: opts.groupId,
  });
  const [rp, rt, rf, rsa, rsu] = daysToSql(opts.days);

  if (self) {
    await db.prepare(`
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
      opts.clerkUserId,
      opts.groupId,
      opts.clerkUserId,
      opts.identity.first_name,
      opts.identity.last_name,
      opts.identity.member_id,
      opts.identity.badge_type,
      rp, rt, rf, rsa, rsu,
      self.id,
    ).run();
    return self.id;
  }

  const result = await db.prepare(`
    INSERT INTO participants
      (event_id, first_name, last_name, member_id, badge_type,
       req_preview, req_thu, req_fri, req_sat, req_sun,
       clerk_user_id, registered_by_clerk_user_id, group_id, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).bind(
    opts.eventId,
    opts.identity.first_name,
    opts.identity.last_name,
    opts.identity.member_id,
    opts.identity.badge_type,
    rp, rt, rf, rsa, rsu,
    opts.clerkUserId, opts.clerkUserId, opts.groupId,
  ).run();
  return Number(result.meta.last_row_id);
}

const PARTICIPANTS_QUERY = `
  SELECT p.*, g.name AS group_name, g.color AS group_color, g.owner_clerk_user_id AS group_owner_clerk_user_id
  FROM participants p
  LEFT JOIN groups g ON g.id = p.group_id
`;

const REQ_DAY_KEYS = ['req_preview', 'req_thu', 'req_fri', 'req_sat', 'req_sun'] as const;

// Avoids confusable chars (0/O, 1/I)
const INVITE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateInviteCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes).map(b => INVITE_CHARS[b % INVITE_CHARS.length]).join('');
}

async function createUniqueInvite(
  db: D1Database, yearId: number, label: string, invitedBy: string, maxUses = 1,
): Promise<Invite> {
  let code = '';
  for (let i = 0; i < 8; i++) {
    code = generateInviteCode();
    const existing = await db.prepare('SELECT id FROM invites WHERE code = ?').bind(code).first();
    if (!existing) break;
    if (i === 7) throw new Error('Failed to generate unique invite code');
  }
  await db.prepare(
    'INSERT INTO invites (year_id, code, label, invited_by_clerk_user_id, max_uses) VALUES (?, ?, ?, ?, ?)'
  ).bind(yearId, code, label, invitedBy, maxUses).run();
  const invite = await db.prepare('SELECT * FROM invites WHERE code = ?').bind(code).first<Invite>();
  if (!invite) throw new Error('Failed to create invite');
  return invite;
}

function inviteJoinUrl(frontendUrl: string, code: string): string {
  return `${frontendUrl.replace(/\/$/, '')}/join/${code}`;
}

async function sendInviteClerkEmail(
  env: Bindings,
  invite: Invite,
  email: string,
): Promise<{ emailSent: boolean; emailError?: string }> {
  if (!env.CLERK_SECRET_KEY) {
    return { emailSent: false, emailError: 'Email sending is not configured on the server' };
  }

  const result = await sendClerkInvitationEmail({
    secretKey: env.CLERK_SECRET_KEY,
    emailAddress: email,
    redirectUrl: inviteJoinUrl(env.FRONTEND_URL, invite.code),
  });

  if (!result.ok) {
    return { emailSent: false, emailError: result.error };
  }

  const normalized = email.trim().toLowerCase();
  await env.DB.prepare(
    'UPDATE invites SET invited_email = ?, clerk_invitation_id = ? WHERE id = ?'
  ).bind(normalized, result.invitationId, invite.id).run();

  return { emailSent: true };
}

async function revokeInviteClerkEmail(env: Bindings, invite: Invite): Promise<void> {
  if (!invite.clerk_invitation_id || !env.CLERK_SECRET_KEY) return;
  await revokeClerkInvitation({
    secretKey: env.CLERK_SECRET_KEY,
    invitationId: invite.clerk_invitation_id,
  });
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
    'SELECT id, year, year_id, name, reg_type, status FROM events WHERE practice_of IS NULL ORDER BY year DESC, id DESC'
  ).all<Pick<Event, 'id' | 'year' | 'year_id' | 'name' | 'reg_type' | 'status'>>();
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
    `${PARTICIPANTS_QUERY} WHERE p.event_id = ?${
      event.reg_type === 'return' && c.req.query('include_ineligible') !== '1'
        ? ' AND p.return_eligible = 1'
        : ''
    } ORDER BY p.sort_order ASC, p.id ASC`
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
  const statusErr = assertRegistrationOpen(event.status);
  if (statusErr) return err(statusErr, 403);

  // Always attach the event to a year (self-heal orphans with null year_id)
  const yearInfo = await ensureEventYear(c.env.DB, event);
  if (!yearInfo) return err('No convention year configured — create a year in Admin first', 400);

  const clerkUserId = access.userId === 'admin' ? null : access.userId;

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

  const identity = {
    first_name: body.first_name.trim(),
    last_name: body.last_name.trim(),
    member_id: body.member_id?.trim().toUpperCase() ?? '',
    badge_type: (body.badge_type === 'JUNIOR' ? 'JUNIOR' : 'ADULT') as 'ADULT' | 'JUNIOR',
  };
  const days = normalizeDays(body);
  const previewErr = assertPreviewNightAllowed(days);
  if (previewErr) return err(previewErr);

  // Prefer group-linked upsert so dashboard my-group sees the row
  if (clerkUserId) {
    // Prefer existing year-member identity fields when the form omits them
    const existingYm = await c.env.DB.prepare(
      'SELECT * FROM year_members WHERE year_id = ? AND clerk_user_id = ?'
    ).bind(yearInfo.yearId, clerkUserId).first<YearMember>();
    if (!identity.member_id && existingYm?.member_id) {
      identity.member_id = existingYm.member_id;
    }

    // Registration always assigns the user to the event's year
    await ensureYearMemberForRegistrant(c.env.DB, yearInfo.yearId, clerkUserId, identity);

    const group = await getOrCreateOwnerGroup(c.env.DB, id, clerkUserId, identity);
    const pid = await upsertSelfParticipantDays(c.env.DB, {
      eventId: id,
      clerkUserId,
      groupId: group.id,
      identity,
      days,
    });

    return json({ ok: true, id: pid, updated: true, group_id: group.id });
  }

  // Admin / no-clerk fallback (legacy)
  const [rp, rt, rf, rsa, rsu] = daysToSql(days);
  const result = await c.env.DB.prepare(`
    INSERT INTO participants
      (event_id, first_name, last_name, member_id, badge_type,
       req_preview, req_thu, req_fri, req_sat, req_sun, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 9999)
  `).bind(
    id, identity.first_name, identity.last_name, identity.member_id, identity.badge_type,
    rp, rt, rf, rsa, rsu,
  ).run();

  return json({ ok: true, id: result.meta.last_row_id }, 201);
});

app.post('/api/events/:id/participants/:pid/claim', async (c) => {
  const eventId = Number(c.req.param('id'));
  const pid = Number(c.req.param('pid'));
  const access = await authenticate(c, c.env.ADMIN_SECRET, c.env.CLERK_JWKS_URL ?? '');
  if (!access) return err('Authentication required', 401);

  const event = await getEvent(c.env.DB, eventId);
  if (!event) return err('Event not found', 404);

  const body = await c.req.json<{ coordinator_name: string; queue_id?: number }>();
  if (!body.coordinator_name?.trim()) return err('coordinator_name required');
  const queueId = Number(body.queue_id);
  if (!Number.isInteger(queueId) || queueId <= 0) {
    return err('Pick which place in line you are buying through (refresh if you see this)', 400);
  }

  // Practice mode is client-side only, so claims always require a live purchase window.
  if (event.status !== 'purchasing') {
    return err('Not in purchasing phase', 403);
  }

  const place = await c.env.DB.prepare(
    'SELECT id, clerk_user_id, status, label FROM purchase_queue WHERE id = ? AND event_id = ?'
  ).bind(queueId, eventId).first<{ id: number; clerk_user_id: string; status: PurchaseQueueStatus; label: string }>();
  if (!place) return err('That place in line no longer exists', 404);
  if (!canManageQueueEntry(access, place.clerk_user_id)) {
    return err('You can only claim through your own place in line', 403);
  }
  if (place.status !== 'buying') {
    return err(`Mark "${place.label}" as through Queue-It before claiming for it`, 409);
  }

  const p = await c.env.DB.prepare('SELECT * FROM participants WHERE id = ? AND event_id = ?')
    .bind(pid, eventId).first<Participant>();
  if (!p) return err('Participant not found', 404);

  if (p.purchasing_claimed_by && !isClaimExpired(p.purchasing_claimed_at)) {
    return err(`Already claimed by ${p.purchasing_claimed_by}`, 409);
  }
  if (nothingLeftToBuy(p, event)) {
    return err(`Nothing left to buy for ${p.first_name}: every day they wanted is bought or sold out`, 409);
  }

  const onPlace = await c.env.DB.prepare(`
    SELECT purchasing_claimed_by, purchasing_claimed_at,
           req_preview, req_thu, req_fri, req_sat, req_sun,
           pur_preview, pur_thu, pur_fri, pur_sat, pur_sun
    FROM participants
    WHERE event_id = ? AND purchasing_claimed_queue_id = ?
  `).bind(eventId, queueId).all<Participant>();
  // Someone this place bought for used one of its 3 badges. Someone claimed but never
  // bought for (left only with sold-out days, or an expired claim) did not.
  const usedSlots = onPlace.results.filter((r) =>
    anyPurchased(r)
    || (!!r.purchasing_claimed_by && !isClaimExpired(r.purchasing_claimed_at) && !nothingLeftToBuy(r, event)),
  ).length;
  if (usedSlots >= MAX_ACTIVE_CLAIMS) {
    return err(
      `"${place.label}" already has ${MAX_ACTIVE_CLAIMS} people (Comic-Con purchase limit). Use another place in line or release someone.`,
      400,
    );
  }

  // The reads above can both pass when two buyers click at once. The write itself
  // re-checks the claim and the 3-person cap in one statement, so the second one loses.
  const written = await c.env.DB.prepare(`
    UPDATE participants
    SET purchasing_claimed_by = ?, purchasing_claimed_at = datetime('now'),
        purchasing_claimed_queue_id = ?, updated_at = datetime('now')
    WHERE id = ? AND event_id = ?
      AND (
        IFNULL(purchasing_claimed_by, '') = ''
        OR purchasing_claimed_at IS NULL
        OR datetime(replace(replace(purchasing_claimed_at, 'T', ' '), 'Z', ''))
            <= datetime('now', '-${CLAIM_TIMEOUT_MINUTES} minutes')
      )
      AND (
        SELECT COUNT(*) FROM participants AS slot
        WHERE slot.event_id = ?
          AND slot.purchasing_claimed_queue_id = ?
          AND slot.id != ?
          AND (
            slot.pur_preview = 1 OR slot.pur_thu = 1 OR slot.pur_fri = 1 OR slot.pur_sat = 1 OR slot.pur_sun = 1
            OR (
              IFNULL(slot.purchasing_claimed_by, '') != ''
              AND slot.purchasing_claimed_at IS NOT NULL
              AND datetime(replace(replace(slot.purchasing_claimed_at, 'T', ' '), 'Z', ''))
                  > datetime('now', '-${CLAIM_TIMEOUT_MINUTES} minutes')
              AND (
                NOT (slot.req_preview = 1 OR slot.req_thu = 1 OR slot.req_fri = 1 OR slot.req_sat = 1 OR slot.req_sun = 1)
                OR (slot.req_preview = 1 AND slot.pur_preview = 0 AND ? = 0)
                OR (slot.req_thu = 1 AND slot.pur_thu = 0 AND ? = 0)
                OR (slot.req_fri = 1 AND slot.pur_fri = 0 AND ? = 0)
                OR (slot.req_sat = 1 AND slot.pur_sat = 0 AND ? = 0)
                OR (slot.req_sun = 1 AND slot.pur_sun = 0 AND ? = 0)
              )
            )
          )
      ) < ?
  `).bind(
    body.coordinator_name.trim(), queueId, pid, eventId,
    eventId, queueId, pid,
    event.sold_out_preview ? 1 : 0,
    event.sold_out_thu ? 1 : 0,
    event.sold_out_fri ? 1 : 0,
    event.sold_out_sat ? 1 : 0,
    event.sold_out_sun ? 1 : 0,
    MAX_ACTIVE_CLAIMS,
  ).run();

  if (!written.meta.changes) {
    const again = await c.env.DB.prepare('SELECT * FROM participants WHERE id = ? AND event_id = ?')
      .bind(pid, eventId).first<Participant>();
    if (!again) return err('Participant not found', 404);
    if (again.purchasing_claimed_by && !isClaimExpired(again.purchasing_claimed_at)) {
      return err(`Already claimed by ${again.purchasing_claimed_by}`, 409);
    }
    if (nothingLeftToBuy(again, event)) {
      return err(`Nothing left to buy for ${again.first_name}: every day they wanted is bought or sold out`, 409);
    }
    return err(
      `"${place.label}" already has ${MAX_ACTIVE_CLAIMS} people (Comic-Con purchase limit). Use another place in line or release someone.`,
      400,
    );
  }

  return json({ ok: true });
});

app.post('/api/events/:id/participants/:pid/unclaim', async (c) => {
  const eventId = Number(c.req.param('id'));
  const pid = Number(c.req.param('pid'));
  const access = await authenticate(c, c.env.ADMIN_SECRET, c.env.CLERK_JWKS_URL ?? '');
  if (!access) return err('Authentication required', 401);

  const target = await c.env.DB.prepare(
    'SELECT purchasing_claimed_by, purchasing_claimed_queue_id FROM participants WHERE id = ? AND event_id = ?'
  ).bind(pid, eventId).first<{ purchasing_claimed_by: string; purchasing_claimed_queue_id: number | null }>();
  if (!target) return err('Participant not found', 404);

  if (!access.isAdmin) {
    const me = await c.env.DB.prepare(
      'SELECT first_name, last_name FROM participants WHERE event_id = ? AND clerk_user_id = ?'
    ).bind(eventId, access.userId).first<{ first_name: string; last_name: string }>();
    const myName = me ? `${me.first_name} ${me.last_name}`.trim().toLowerCase() : '';
    const claimedBy = (target.purchasing_claimed_by ?? '').trim().toLowerCase();
    let ownsPlace = false;
    if (target.purchasing_claimed_queue_id) {
      const place = await c.env.DB.prepare(
        'SELECT clerk_user_id FROM purchase_queue WHERE id = ? AND event_id = ?'
      ).bind(target.purchasing_claimed_queue_id, eventId).first<{ clerk_user_id: string }>();
      ownsPlace = place?.clerk_user_id === access.userId;
    }
    if (!ownsPlace && (!myName || claimedBy !== myName)) {
      return err('Only the person who claimed them can release the claim', 403);
    }
  }

  await c.env.DB.prepare(`
    UPDATE participants
    SET purchasing_claimed_by = '', purchasing_claimed_at = NULL, purchasing_claimed_queue_id = NULL, updated_at = datetime('now')
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

  const target = await c.env.DB.prepare(
    'SELECT purchasing_claimed_by, purchasing_claimed_at FROM participants WHERE id = ? AND event_id = ?'
  ).bind(pid, eventId).first<{ purchasing_claimed_by: string; purchasing_claimed_at: string | null }>();
  if (!target) return err('Participant not found', 404);

  if (!(await canActOnClaimedParticipant(c.env.DB, access, eventId, pid))) {
    const claimActive = !!target.purchasing_claimed_by && !isClaimExpired(target.purchasing_claimed_at);
    return err(
      claimActive ? 'Only the claimer can mark purchases for this person' : 'Claim this person first before marking purchases',
      403,
    );
  }

  const body = await c.req.json<{
    pur_preview?: boolean; pur_thu?: boolean; pur_fri?: boolean;
    pur_sat?: boolean; pur_sun?: boolean; who_purchased?: string;
  }>();

  // Buyers record the days that were asked for. An admin can also record a substitute
  // day bought after another one sold out.
  if (!access.isAdmin) {
    const requested = await c.env.DB.prepare(
      `SELECT req_preview, req_thu, req_fri, req_sat, req_sun
       FROM participants WHERE id = ? AND event_id = ?`
    ).bind(pid, eventId).first<{
      req_preview: number; req_thu: number; req_fri: number; req_sat: number; req_sun: number;
    }>();
    const extra = SALE_DAYS.find((d) => body[`pur_${d}`] != null && !requested?.[`req_${d}`]);
    if (extra) return err('Only an admin can mark a day bought when it was not requested', 403);
  }

  // Only the days sent change. Ticking one day must not undo another the client hadn't
  // refreshed yet, which a full overwrite would.
  const flag = (v: boolean | undefined) => (v == null ? null : v ? 1 : 0);
  await c.env.DB.prepare(`
    UPDATE participants
    SET pur_preview = COALESCE(?, pur_preview), pur_thu = COALESCE(?, pur_thu),
        pur_fri = COALESCE(?, pur_fri), pur_sat = COALESCE(?, pur_sat), pur_sun = COALESCE(?, pur_sun),
        who_purchased = COALESCE(?, who_purchased), updated_at = datetime('now')
    WHERE id = ? AND event_id = ?
  `).bind(
    flag(body.pur_preview), flag(body.pur_thu), flag(body.pur_fri),
    flag(body.pur_sat), flag(body.pur_sun),
    body.who_purchased != null ? body.who_purchased.trim() : null,
    pid, eventId,
  ).run();

  // Finishing someone ends the claim without a manual release. The place link stays when
  // something was bought, so the place still shows them and can't claim past 3.
  const updated = await c.env.DB.prepare(`
    SELECT req_preview, req_thu, req_fri, req_sat, req_sun,
           pur_preview, pur_thu, pur_fri, pur_sat, pur_sun
    FROM participants WHERE id = ? AND event_id = ?
  `).bind(pid, eventId).first<Participant>();

  const claimReleased = !!updated && nothingLeftToBuy(updated, event);
  if (claimReleased) {
    await c.env.DB.prepare(`
      UPDATE participants
      SET purchasing_claimed_by = '', purchasing_claimed_at = NULL,
          purchasing_claimed_queue_id = CASE WHEN ? THEN purchasing_claimed_queue_id ELSE NULL END,
          updated_at = datetime('now')
      WHERE id = ? AND event_id = ?
    `).bind(anyPurchased(updated) ? 1 : 0, pid, eventId).run();
  }

  return json({ ok: true, claim_released: claimReleased });
});

app.patch('/api/events/:id/participants/:pid/requested', async (c) => {
  const eventId = Number(c.req.param('id'));
  const pid = Number(c.req.param('pid'));
  const access = await authenticate(c, c.env.ADMIN_SECRET, c.env.CLERK_JWKS_URL ?? '');
  if (!access) return err('Authentication required', 401);

  const event = await getEvent(c.env.DB, eventId);
  if (!event) return err('Event not found', 404);
  if (event.status === 'purchasing') {
    return err('Requested days cannot be changed during purchasing', 403);
  }

  if (!(await canEditParticipantIdentity(c.env.DB, access, eventId, pid))) {
    return err('You can only change requested days for yourself or your group', 403);
  }

  const body = await c.req.json<{
    req_preview?: boolean; req_thu?: boolean; req_fri?: boolean;
    req_sat?: boolean; req_sun?: boolean;
  }>();

  const previewErr = assertPreviewNightAllowed(normalizeDays(body));
  if (previewErr) return err(previewErr);

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

// ─── Purchase queue (Queue-It buyer line) ─────────────────────────────────────

const QUEUE_STATUSES: PurchaseQueueStatus[] = [
  'waiting', 'on_deck', 'in_queueit', 'buying', 'done', 'skipped',
];

type PurchaseQueueRow = PurchaseQueueEntry & {
  first_name: string;
  last_name: string;
  member_id: string;
  group_name: string | null;
};

const QUEUE_LABEL_MAX = 24;

function cleanQueueLabel(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().slice(0, QUEUE_LABEL_MAX) : '';
}

/** First free "Place N" for this person, so a removed place never makes two share a name. */
async function nextDefaultQueueLabel(db: D1Database, eventId: number, clerkUserId: string): Promise<string> {
  const rows = await db.prepare(
    'SELECT label FROM purchase_queue WHERE event_id = ? AND clerk_user_id = ?'
  ).bind(eventId, clerkUserId).all<{ label: string }>();
  const taken = new Set((rows.results ?? []).map((r) => r.label));
  let n = 1;
  while (taken.has(`Place ${n}`)) n++;
  return `Place ${n}`;
}

/**
 * Removing or skipping a place takes someone out of line, so only its owner or an admin
 * may do it. Status and ETA stay open to everyone so a heads-down buyer can be reported
 * by whoever is watching their screen.
 */
function canManageQueueEntry(access: { isAdmin: boolean; userId: string }, owner: string): boolean {
  return access.isAdmin || access.userId === owner;
}

/**
 * A place that is done, skipped or removed stops holding anyone it was buying for, so
 * whoever it didn't finish goes back up for grabs. `placeIdsSql` selects the place ids.
 */
function releasePlaceClaims(db: D1Database, placeIdsSql: string, ...binds: (string | number)[]) {
  return db.prepare(`
    UPDATE participants
    SET purchasing_claimed_by = '', purchasing_claimed_at = NULL, purchasing_claimed_queue_id = NULL,
        updated_at = datetime('now')
    WHERE purchasing_claimed_queue_id IN (${placeIdsSql})
  `).bind(...binds);
}

async function listPurchaseQueue(db: D1Database, eventId: number): Promise<PurchaseQueueRow[]> {
  const rows = await db.prepare(`
    SELECT q.*, p.first_name, p.last_name, p.member_id, g.name AS group_name
    FROM purchase_queue q
    JOIN participants p ON p.id = q.participant_id
    LEFT JOIN groups g ON g.id = p.group_id
    WHERE q.event_id = ?
    ORDER BY
      CASE q.status
        WHEN 'buying' THEN 0
        WHEN 'in_queueit' THEN 1
        WHEN 'on_deck' THEN 2
        WHEN 'waiting' THEN 3
        WHEN 'done' THEN 4
        WHEN 'skipped' THEN 5
        ELSE 6
      END,
      CASE WHEN q.eta_at IS NULL THEN 1 ELSE 0 END,
      q.eta_at ASC,
      q.position ASC,
      q.id ASC
  `).bind(eventId).all<PurchaseQueueRow>();
  return rows.results ?? [];
}

app.get('/api/events/:id/purchase-queue', async (c) => {
  const eventId = Number(c.req.param('id'));
  const access = await authenticate(c, c.env.ADMIN_SECRET, c.env.CLERK_JWKS_URL ?? '');
  if (!access) return err('Authentication required', 401);

  const event = await getEvent(c.env.DB, eventId);
  if (!event) return err('Event not found', 404);

  return json(await listPurchaseQueue(c.env.DB, eventId));
});

app.post('/api/events/:id/purchase-queue/join', async (c) => {
  const eventId = Number(c.req.param('id'));
  const access = await authenticate(c, c.env.ADMIN_SECRET, c.env.CLERK_JWKS_URL ?? '');
  if (!access) return err('Authentication required', 401);
  if (access.userId === 'admin') return err('Join as a signed-in member, not admin secret', 400);

  const event = await getEvent(c.env.DB, eventId);
  if (!event) return err('Event not found', 404);

  const me = await c.env.DB.prepare(
    'SELECT id FROM participants WHERE event_id = ? AND clerk_user_id = ?'
  ).bind(eventId, access.userId).first<{ id: number }>();
  if (!me) return err('Link your account to a participant first', 400);

  const body = await c.req.json<{ label?: string }>().catch(() => ({} as { label?: string }));

  // Multiple joins allowed — one entry per Queue-It cookie / browser session.
  // Position is chosen inside the insert so two people joining at once can't land on the same number.
  const label = cleanQueueLabel(body.label) || await nextDefaultQueueLabel(c.env.DB, eventId, access.userId);

  await c.env.DB.prepare(`
    INSERT INTO purchase_queue (event_id, participant_id, clerk_user_id, position, status, label)
    VALUES (?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM purchase_queue WHERE event_id = ?), 'waiting', ?)
  `).bind(eventId, me.id, access.userId, eventId, label).run();

  return json(await listPurchaseQueue(c.env.DB, eventId));
});

// ── Practice: a shared copy of the board to rehearse purchase day on ─────────
//
// Everyone who joins practice lands on the same copy, so they see each other's practice
// claims, purchases, sold-out days and places in line, while the real board stays
// untouched. Starting over or opening real purchasing throws the copy away.

const COPY_SKIP = new Set(['id', 'created_at', 'updated_at']);

function insertCopy(db: D1Database, table: string, row: Record<string, unknown>, over: Record<string, unknown>) {
  const data = { ...row, ...over };
  const cols = Object.keys(data).filter((k) => !COPY_SKIP.has(k));
  return db.prepare(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
  ).bind(...cols.map((k) => data[k] ?? null));
}

async function deletePracticeCopies(db: D1Database, eventId: number): Promise<void> {
  const copies = await db.prepare('SELECT id FROM events WHERE practice_of = ?').bind(eventId).all<{ id: number }>();
  for (const { id } of copies.results ?? []) {
    await db.batch([
      db.prepare('DELETE FROM purchase_queue WHERE event_id = ?').bind(id),
      db.prepare('DELETE FROM buy_list_entries WHERE event_id = ?').bind(id),
      db.prepare('DELETE FROM participants WHERE event_id = ?').bind(id),
      db.prepare('DELETE FROM groups WHERE event_id = ?').bind(id),
      db.prepare('DELETE FROM coordinators WHERE event_id = ?').bind(id),
      db.prepare('DELETE FROM events WHERE id = ?').bind(id),
    ]);
  }
}

async function createPracticeCopy(db: D1Database, source: Event): Promise<number> {
  const created = await insertCopy(db, 'events', source as unknown as Record<string, unknown>, {
    name: `${source.name} · Simulation`,
    status: 'purchasing',
    year_id: null,
    practice_of: source.id,
  }).run();
  const copyId = Number(created.meta.last_row_id);

  const groups = await db.prepare('SELECT * FROM groups WHERE event_id = ? ORDER BY id').bind(source.id).all<Record<string, unknown>>();
  const groupMap = new Map<number, number>();
  for (const g of groups.results ?? []) {
    const res = await insertCopy(db, 'groups', g, { event_id: copyId }).run();
    groupMap.set(Number(g.id), Number(res.meta.last_row_id));
  }

  const people = await db.prepare('SELECT * FROM participants WHERE event_id = ? ORDER BY id').bind(source.id).all<Record<string, unknown>>();
  if ((people.results ?? []).length > 0) {
    await db.batch((people.results ?? []).map((p) => insertCopy(db, 'participants', p, {
      event_id: copyId,
      group_id: p.group_id == null ? null : groupMap.get(Number(p.group_id)) ?? null,
      practice_source_id: p.id,
    })));
  }
  const copied = await db.prepare('SELECT id, practice_source_id FROM participants WHERE event_id = ?')
    .bind(copyId).all<{ id: number; practice_source_id: number }>();
  const personMap = new Map((copied.results ?? []).map((r) => [r.practice_source_id, r.id]));

  const places = await db.prepare('SELECT * FROM purchase_queue WHERE event_id = ? ORDER BY position, id').bind(source.id).all<Record<string, unknown>>();
  const placeRows = (places.results ?? []).filter((q) => personMap.has(Number(q.participant_id)));
  if (placeRows.length > 0) {
    await db.batch(placeRows.map((q) => insertCopy(db, 'purchase_queue', q, {
      event_id: copyId,
      participant_id: personMap.get(Number(q.participant_id)),
    })));
  }

  // Two people joining at once can each build a copy; everyone settles on the oldest.
  const oldest = await db.prepare('SELECT MIN(id) AS id FROM events WHERE practice_of = ?')
    .bind(source.id).first<{ id: number }>();
  if (oldest && oldest.id !== copyId) {
    await db.batch([
      db.prepare('DELETE FROM purchase_queue WHERE event_id = ?').bind(copyId),
      db.prepare('DELETE FROM participants WHERE event_id = ?').bind(copyId),
      db.prepare('DELETE FROM groups WHERE event_id = ?').bind(copyId),
      db.prepare('DELETE FROM events WHERE id = ?').bind(copyId),
    ]);
    return oldest.id;
  }
  return copyId;
}

/** Anyone with a row on the real event can practice, as can admins. */
async function canPractice(db: D1Database, access: { isAdmin: boolean; userId: string }, eventId: number): Promise<boolean> {
  if (access.isAdmin) return true;
  return !!(await db.prepare('SELECT id FROM participants WHERE event_id = ? AND clerk_user_id = ? LIMIT 1')
    .bind(eventId, access.userId).first());
}

/** Joins practice for an event, building the shared copy if nobody has yet. Returns its id. */
app.post('/api/events/:id/practice', async (c) => {
  const eventId = Number(c.req.param('id'));
  const access = await authenticate(c, c.env.ADMIN_SECRET, c.env.CLERK_JWKS_URL ?? '');
  if (!access) return err('Authentication required', 401);
  const event = await getEvent(c.env.DB, eventId);
  if (!event) return err('Event not found', 404);
  if (event.practice_of) return json({ id: event.id, practice_of: event.practice_of });
  if (event.status === 'purchasing') return err('Purchasing is open, so the simulation is closed', 409);
  if (!(await canPractice(c.env.DB, access, eventId))) return err('Only people on this board can join the simulation', 403);

  const existing = await c.env.DB.prepare('SELECT MIN(id) AS id FROM events WHERE practice_of = ?')
    .bind(eventId).first<{ id: number | null }>();
  const id = existing?.id ?? await createPracticeCopy(c.env.DB, event);
  return json({ id, practice_of: eventId });
});

/** Starts practice over: throws the shared copy away and builds a fresh one from the real board. */
app.post('/api/events/:id/practice/reset', async (c) => {
  const eventId = Number(c.req.param('id'));
  const access = await authenticate(c, c.env.ADMIN_SECRET, c.env.CLERK_JWKS_URL ?? '');
  if (!access) return err('Authentication required', 401);
  const given = await getEvent(c.env.DB, eventId);
  if (!given) return err('Event not found', 404);
  const source = given.practice_of ? await getEvent(c.env.DB, given.practice_of) : given;
  if (!source) return err('Event not found', 404);
  if (source.status === 'purchasing') return err('Purchasing is open, so the simulation is closed', 409);
  if (!(await canPractice(c.env.DB, access, source.id))) return err('Only people on this board can join the simulation', 403);

  await deletePracticeCopies(c.env.DB, source.id);
  return json({ id: await createPracticeCopy(c.env.DB, source), practice_of: source.id });
});

// ── Buy list: each member's own order of who to buy for ──────────────────────

const MAX_BUY_LIST = 50;

async function getBuyList(db: D1Database, eventId: number, userId: string): Promise<number[]> {
  const rows = await db.prepare(
    'SELECT participant_id FROM buy_list_entries WHERE event_id = ? AND clerk_user_id = ? ORDER BY rank ASC'
  ).bind(eventId, userId).all<{ participant_id: number }>();
  return (rows.results ?? []).map((r) => r.participant_id);
}

/**
 * Practice uses your real buy list, so planning done while practicing is kept. Maps
 * between practice row ids and the real rows they were copied from.
 */
async function practiceIdMap(db: D1Database, copyId: number): Promise<Map<number, number>> {
  const rows = await db.prepare('SELECT id, practice_source_id FROM participants WHERE event_id = ?')
    .bind(copyId).all<{ id: number; practice_source_id: number | null }>();
  return new Map((rows.results ?? []).filter((r) => r.practice_source_id != null).map((r) => [r.practice_source_id!, r.id]));
}

app.get('/api/events/:id/buy-list', async (c) => {
  const eventId = Number(c.req.param('id'));
  const access = await authenticate(c, c.env.ADMIN_SECRET, c.env.CLERK_JWKS_URL ?? '');
  if (!access) return err('Authentication required', 401);
  if (access.userId === 'admin') return json({ participant_ids: [] });
  const event = await getEvent(c.env.DB, eventId);
  if (event?.practice_of) {
    const toCopy = await practiceIdMap(c.env.DB, eventId);
    const real = await getBuyList(c.env.DB, event.practice_of, access.userId);
    return json({ participant_ids: real.map((id) => toCopy.get(id)).filter((id): id is number => id != null) });
  }
  return json({ participant_ids: await getBuyList(c.env.DB, eventId, access.userId) });
});

app.put('/api/events/:id/buy-list', async (c) => {
  const eventId = Number(c.req.param('id'));
  const access = await authenticate(c, c.env.ADMIN_SECRET, c.env.CLERK_JWKS_URL ?? '');
  if (!access) return err('Authentication required', 401);
  if (access.userId === 'admin') return err('Save a buy list as a signed-in member', 400);

  const event = await getEvent(c.env.DB, eventId);
  if (!event) return err('Event not found', 404);

  const body = await c.req.json<{ participant_ids?: unknown }>().catch(() => ({} as { participant_ids?: unknown }));
  if (!Array.isArray(body.participant_ids)) return err('participant_ids must be an array', 400);
  const ids = [...new Set(body.participant_ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (ids.length > MAX_BUY_LIST) return err(`A buy list holds at most ${MAX_BUY_LIST} people`, 400);

  if (ids.length > 0) {
    const found = await c.env.DB.prepare(
      `SELECT id FROM participants WHERE event_id = ? AND id IN (${ids.map(() => '?').join(',')})`
    ).bind(eventId, ...ids).all<{ id: number }>();
    if ((found.results ?? []).length !== ids.length) return err('Everyone on a buy list must be on this event', 400);
  }

  let listEventId = eventId;
  let listIds = ids;
  if (event.practice_of) {
    const toCopy = await practiceIdMap(c.env.DB, eventId);
    const toReal = new Map([...toCopy].map(([real, copy]) => [copy, real]));
    listEventId = event.practice_of;
    listIds = ids.map((id) => toReal.get(id)).filter((id): id is number => id != null);
  }

  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM buy_list_entries WHERE event_id = ? AND clerk_user_id = ?').bind(listEventId, access.userId),
    ...listIds.map((pid, i) => c.env.DB.prepare(
      'INSERT INTO buy_list_entries (event_id, clerk_user_id, participant_id, rank) VALUES (?, ?, ?, ?)'
    ).bind(listEventId, access.userId, pid, i + 1)),
  ]);
  return json({ participant_ids: ids });
});

// Must be registered before /:qid so "me" is not captured as an id.
app.delete('/api/events/:id/purchase-queue/me', async (c) => {
  const eventId = Number(c.req.param('id'));
  const access = await authenticate(c, c.env.ADMIN_SECRET, c.env.CLERK_JWKS_URL ?? '');
  if (!access) return err('Authentication required', 401);
  if (access.userId === 'admin') return err('Leave as a signed-in member', 400);

  await c.env.DB.batch([
    releasePlaceClaims(
      c.env.DB, 'SELECT id FROM purchase_queue WHERE event_id = ? AND clerk_user_id = ?', eventId, access.userId,
    ),
    c.env.DB.prepare('DELETE FROM purchase_queue WHERE event_id = ? AND clerk_user_id = ?').bind(eventId, access.userId),
  ]);

  return json(await listPurchaseQueue(c.env.DB, eventId));
});

app.delete('/api/events/:id/purchase-queue/:qid', async (c) => {
  const eventId = Number(c.req.param('id'));
  const qid = Number(c.req.param('qid'));
  const access = await authenticate(c, c.env.ADMIN_SECRET, c.env.CLERK_JWKS_URL ?? '');
  if (!access) return err('Authentication required', 401);

  const row = await c.env.DB.prepare(
    'SELECT id, clerk_user_id FROM purchase_queue WHERE id = ? AND event_id = ?'
  ).bind(qid, eventId).first<{ id: number; clerk_user_id: string }>();
  if (!row) return err('Queue entry not found', 404);
  if (!canManageQueueEntry(access, row.clerk_user_id)) {
    return err('Only the owner of this place in line or an admin can remove it', 403);
  }

  await c.env.DB.batch([
    releasePlaceClaims(c.env.DB, '?', qid),
    c.env.DB.prepare('DELETE FROM purchase_queue WHERE id = ? AND event_id = ?').bind(qid, eventId),
  ]);

  return json(await listPurchaseQueue(c.env.DB, eventId));
});

app.patch('/api/events/:id/purchase-queue/:qid', async (c) => {
  const eventId = Number(c.req.param('id'));
  const qid = Number(c.req.param('qid'));
  const access = await authenticate(c, c.env.ADMIN_SECRET, c.env.CLERK_JWKS_URL ?? '');
  if (!access) return err('Authentication required', 401);

  const body = await c.req.json<{ status?: PurchaseQueueStatus; eta_minutes?: number | null; label?: string }>();
  if (body.status === undefined && body.eta_minutes === undefined && body.label === undefined) {
    return err('Provide status, eta_minutes and/or label');
  }
  if (body.status !== undefined && !QUEUE_STATUSES.includes(body.status)) {
    return err(`status must be one of: ${QUEUE_STATUSES.join(', ')}`);
  }
  if (body.eta_minutes !== undefined && body.eta_minutes !== null) {
    if (!Number.isFinite(body.eta_minutes) || body.eta_minutes < 0 || body.eta_minutes > 24 * 60) {
      return err('eta_minutes must be between 0 and 1440');
    }
  }

  const row = await c.env.DB.prepare(
    'SELECT id, status, clerk_user_id FROM purchase_queue WHERE id = ? AND event_id = ?'
  ).bind(qid, eventId).first<{ id: number; status: PurchaseQueueStatus; clerk_user_id: string }>();
  if (!row) return err('Queue entry not found', 404);

  const touchesSkip = body.status !== undefined
    && body.status !== row.status
    && (body.status === 'skipped' || row.status === 'skipped');
  if (touchesSkip && !canManageQueueEntry(access, row.clerk_user_id)) {
    return err('Only the owner of this place in line or an admin can skip or restore it', 403);
  }
  if (body.label !== undefined && !canManageQueueEntry(access, row.clerk_user_id)) {
    return err('Only the owner of this place in line can rename it', 403);
  }

  const fields: string[] = ["updated_at = datetime('now')"];
  const values: (string | number | null)[] = [];

  if (body.label !== undefined) {
    const label = cleanQueueLabel(body.label);
    if (!label) return err('Name cannot be empty');
    fields.push('label = ?');
    values.push(label);
  }

  let nextStatus = body.status;
  if (
    body.eta_minutes != null &&
    nextStatus === undefined &&
    (row.status === 'waiting' || row.status === 'on_deck')
  ) {
    // Reporting an ETA means they're in Queue-It.
    nextStatus = 'in_queueit';
  }
  if (nextStatus !== undefined) {
    fields.push('status = ?');
    values.push(nextStatus);
    if (nextStatus === 'done' || nextStatus === 'skipped') {
      fields.push('eta_minutes = NULL', 'eta_at = NULL');
    }
  }
  if (body.eta_minutes !== undefined && nextStatus !== 'done' && nextStatus !== 'skipped') {
    if (body.eta_minutes == null) {
      fields.push('eta_minutes = NULL', 'eta_at = NULL');
    } else {
      const minutes = Math.round(body.eta_minutes);
      fields.push('eta_minutes = ?', "eta_at = datetime('now', ?)");
      values.push(minutes, `+${minutes} minutes`);
    }
  }

  values.push(qid, eventId);
  const update = c.env.DB.prepare(`
    UPDATE purchase_queue SET ${fields.join(', ')}
    WHERE id = ? AND event_id = ?
  `).bind(...values);
  await c.env.DB.batch(
    nextStatus === 'done' || nextStatus === 'skipped'
      ? [update, releasePlaceClaims(c.env.DB, '?', qid)]
      : [update],
  );

  return json(await listPurchaseQueue(c.env.DB, eventId));
});

app.put('/api/events/:id/purchase-queue/reorder', async (c) => {
  const eventId = Number(c.req.param('id'));
  const access = await authenticate(c, c.env.ADMIN_SECRET, c.env.CLERK_JWKS_URL ?? '');
  if (!access) return err('Authentication required', 401);
  // Rewrites every place in line at once, so it is an admin repair tool, not a call action.
  if (!access.isAdmin) return err('Only admins can reorder the whole line', 403);

  const body = await c.req.json<{ order: number[] }>();
  if (!Array.isArray(body.order) || body.order.length === 0) {
    return err('order must be a non-empty array of queue entry ids');
  }

  const existing = await c.env.DB.prepare(
    'SELECT id FROM purchase_queue WHERE event_id = ?'
  ).bind(eventId).all<{ id: number }>();
  const idSet = new Set((existing.results ?? []).map((r) => r.id));
  if (body.order.some((id) => !idSet.has(id)) || body.order.length !== idSet.size) {
    return err('order must include every queue entry exactly once');
  }

  const stmts = body.order.map((id, i) =>
    c.env.DB.prepare(`
      UPDATE purchase_queue SET position = ?, updated_at = datetime('now')
      WHERE id = ? AND event_id = ?
    `).bind(i + 1, id, eventId)
  );
  await c.env.DB.batch(stmts);

  return json(await listPurchaseQueue(c.env.DB, eventId));
});

app.post('/api/events/:id/purchase-queue/:qid/move', async (c) => {
  const eventId = Number(c.req.param('id'));
  const qid = Number(c.req.param('qid'));
  const access = await authenticate(c, c.env.ADMIN_SECRET, c.env.CLERK_JWKS_URL ?? '');
  if (!access) return err('Authentication required', 401);

  const body = await c.req.json<{ direction: 'up' | 'down' }>();
  if (body.direction !== 'up' && body.direction !== 'down') {
    return err('direction must be up or down');
  }

  const rows = await c.env.DB.prepare(`
    SELECT id, position FROM purchase_queue
    WHERE event_id = ? AND status NOT IN ('done', 'skipped')
    ORDER BY position ASC, id ASC
  `).bind(eventId).all<{ id: number; position: number }>();
  const list = rows.results ?? [];
  const idx = list.findIndex((r) => r.id === qid);
  if (idx === -1) return err('Queue entry not found or already finished', 404);

  const swapIdx = body.direction === 'up' ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= list.length) {
    return json(await listPurchaseQueue(c.env.DB, eventId));
  }

  const a = list[idx];
  const b = list[swapIdx];
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE purchase_queue SET position = ?, updated_at = datetime('now') WHERE id = ?"
    ).bind(b.position, a.id),
    c.env.DB.prepare(
      "UPDATE purchase_queue SET position = ?, updated_at = datetime('now') WHERE id = ?"
    ).bind(a.position, b.id),
  ]);

  return json(await listPurchaseQueue(c.env.DB, eventId));
});

/**
 * Called out mid-sale by whoever sees Comic-Con's "sold out" screen first, so anyone with a
 * row on this event may flip it, not just admins. Reversible, because a day that looked
 * gone sometimes comes back when carts expire.
 */
app.patch('/api/events/:id/sold-out', async (c) => {
  const eventId = Number(c.req.param('id'));
  const access = await authenticate(c, c.env.ADMIN_SECRET, c.env.CLERK_JWKS_URL ?? '');
  if (!access) return err('Authentication required', 401);

  const event = await getEvent(c.env.DB, eventId);
  if (!event) return err('Event not found', 404);

  if (!access.isAdmin) {
    const member = await c.env.DB.prepare(
      'SELECT id FROM participants WHERE event_id = ? AND clerk_user_id = ? LIMIT 1'
    ).bind(eventId, access.userId).first();
    if (!member) return err('Only people in this event can mark a day sold out', 403);
  }

  const body = await c.req.json<{ day?: string; sold_out?: boolean }>();
  if (!SALE_DAYS.includes(body.day as SaleDay)) {
    return err(`day must be one of: ${SALE_DAYS.join(', ')}`);
  }
  if (typeof body.sold_out !== 'boolean') return err('sold_out must be true or false');

  // Column name comes from the SALE_DAYS allowlist above, never from raw input.
  const column = `sold_out_${body.day as SaleDay}`;
  await c.env.DB.prepare(
    `UPDATE events SET ${column} = ?, updated_at = datetime('now') WHERE id = ?`
  ).bind(body.sold_out ? 1 : 0, eventId).run();

  return json(await getEvent(c.env.DB, eventId));
});

app.patch('/api/events/:id/participants/:pid/profile', async (c) => {
  const eventId = Number(c.req.param('id'));
  const pid = Number(c.req.param('pid'));
  const access = await authenticate(c, c.env.ADMIN_SECRET, c.env.CLERK_JWKS_URL ?? '');
  if (!access) return err('Authentication required', 401);

  const event = await getEvent(c.env.DB, eventId);
  if (!event) return err('Event not found', 404);

  const body = await c.req.json<{
    first_name?: string; last_name?: string; member_id?: string; badge_type?: string;
    notes?: string; return_eligible?: boolean;
  }>();

  if (!(await canEditParticipantIdentity(c.env.DB, access, eventId, pid))) {
    return err('You can only edit your own profile or your group members', 403);
  }

  const fields: string[] = [];
  const values: (string | number)[] = [];

  if (body.first_name !== undefined) { fields.push('first_name = ?'); values.push(body.first_name.trim()); }
  if (body.last_name !== undefined) { fields.push('last_name = ?'); values.push(body.last_name.trim()); }
  if (body.member_id !== undefined) { fields.push('member_id = ?'); values.push(body.member_id.trim().toUpperCase()); }
  if (body.badge_type !== undefined) { fields.push('badge_type = ?'); values.push(body.badge_type === 'JUNIOR' ? 'JUNIOR' : 'ADULT'); }
  if (body.notes !== undefined) { fields.push('notes = ?'); values.push(body.notes.trim()); }
  if (body.return_eligible !== undefined) { fields.push('return_eligible = ?'); values.push(body.return_eligible ? 1 : 0); }

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

  const target = await c.env.DB.prepare(
    'SELECT id, clerk_user_id, group_id FROM participants WHERE id = ? AND event_id = ?'
  ).bind(pid, eventId).first<{ id: number; clerk_user_id: string | null; group_id: number | null }>();
  if (!target) return err('Participant not found', 404);
  if (target.clerk_user_id && target.clerk_user_id !== access.userId) {
    return err('Participant already linked to another account', 409);
  }

  // Prefer attaching to the user's owned group when present
  const ownedGroup = await c.env.DB.prepare(
    'SELECT id FROM groups WHERE event_id = ? AND owner_clerk_user_id = ?'
  ).bind(eventId, access.userId).first<{ id: number }>();
  const groupId = ownedGroup?.id ?? target.group_id ?? null;

  await c.env.DB.prepare(
    "UPDATE participants SET clerk_user_id = ?, group_id = COALESCE(?, group_id), updated_at = datetime('now') WHERE id = ? AND event_id = ?"
  ).bind(access.userId, groupId, pid, eventId).run();

  return json({ ok: true, group_id: groupId });
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
  if (invite.used_at) return err(inviteUnavailableMessage(invite), 409);

  const year = await c.env.DB.prepare(
    'SELECT id, name, con_year FROM years WHERE id = ?'
  ).bind(invite.year_id).first<Pick<Year, 'id' | 'name' | 'con_year'>>();

  return json({ invite: { code: invite.code, label: invite.label, year_id: invite.year_id }, year });
});

/**
 * Details an organizer already recorded for this person, so the join form can be confirmed
 * rather than retyped. Matching is on the caller's *verified* Clerk email — an unverified
 * address is attacker-controlled, so fetchClerkUserEmail returns '' for those and nothing
 * is disclosed. Requires auth for the same reason: the invite code alone must not reveal
 * a name and Member ID to whoever holds the link.
 */
app.get('/api/invites/:code/prefill', async (c) => {
  const access = await authenticate(c, c.env.ADMIN_SECRET, c.env.CLERK_JWKS_URL ?? '');
  if (!access || access.userId === 'admin') return err('Sign in required', 401);

  const code = c.req.param('code').toUpperCase();
  const invite = await c.env.DB.prepare(
    'SELECT * FROM invites WHERE code = ?'
  ).bind(code).first<Invite>();
  if (!invite) return err('Invite not found', 404);

  const email = await fetchClerkUserEmail({
    secretKey: c.env.CLERK_SECRET_KEY ?? '',
    userId: access.userId,
  });
  if (!email) return json({ prefill: null });

  const match = await c.env.DB.prepare(`
    SELECT p.first_name, p.last_name, p.member_id, p.badge_type, p.return_eligible
    FROM participants p
    JOIN events e ON e.id = p.event_id
    WHERE e.year_id = ?
      AND LOWER(p.email) = ?
      AND (p.clerk_user_id IS NULL OR p.clerk_user_id = '' OR p.clerk_user_id = ?)
    ORDER BY p.id
    LIMIT 1
  `).bind(invite.year_id, email, access.userId).first<{
    first_name: string;
    last_name: string;
    member_id: string;
    badge_type: string;
    return_eligible: number;
  }>();
  if (!match) return json({ prefill: null });

  return json({
    prefill: {
      first_name: match.first_name,
      last_name: match.last_name,
      member_id: match.member_id,
      badge_type: match.badge_type === 'JUNIOR' ? 'JUNIOR' : 'ADULT',
      return_eligible: !!match.return_eligible,
    },
  });
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
  // The Live Board refuses anyone without a Member ID, so accepting without one lets people
  // finish signing up and then get locked out of the thing they signed up for.
  if (!body.member_id?.trim()) return err('SDCC Member ID is required');

  const invite = await c.env.DB.prepare(
    'SELECT * FROM invites WHERE code = ?'
  ).bind(code).first<Invite>();
  if (!invite) return err('Invite not found', 404);
  if (invite.used_at) return err(inviteUnavailableMessage(invite), 409);

  // Reject a Member ID that already belongs to someone else before anything is written,
  // so the invite stays usable. Letting it through either hands over their row or trips
  // the per-event unique index halfway through and leaves a half-built registration.
  const claimedByOther = await c.env.DB.prepare(`
    SELECT p.id FROM participants p
    JOIN events e ON e.id = p.event_id
    WHERE e.year_id = ? AND UPPER(p.member_id) = UPPER(?)
      AND p.clerk_user_id IS NOT NULL AND p.clerk_user_id != '' AND p.clerk_user_id != ?
    LIMIT 1
  `).bind(invite.year_id, body.member_id.trim(), access.userId).first();
  if (claimedByOther) {
    return err('That Member ID is already registered to another account', 409);
  }

  // Already a member (e.g. dashboard enroll) — still mark this invite used
  const existing = await c.env.DB.prepare(
    'SELECT * FROM year_members WHERE year_id = ? AND clerk_user_id = ?'
  ).bind(invite.year_id, access.userId).first<YearMember>();
  if (existing) {
    // A shared link isn't spent on someone who already belongs to the year.
    await c.env.DB.prepare(`
      UPDATE invites SET used_by_clerk_user_id = ?, used_at = datetime('now'), use_count = 1
      WHERE code = ? AND used_at IS NULL AND max_uses = 1
    `).bind(access.userId, code).run();
    if (!existing.sponsor_clerk_user_id) {
      await c.env.DB.prepare(`
        UPDATE year_members SET sponsor_clerk_user_id = ?
        WHERE id = ?
      `).bind(invite.invited_by_clerk_user_id, existing.id).run();
    }
    const member = await c.env.DB.prepare(
      'SELECT * FROM year_members WHERE id = ?'
    ).bind(existing.id).first<YearMember>();
    return json({ ok: true, member: member ?? existing, already_registered: true });
  }

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
  const memberId = body.member_id?.trim().toUpperCase() ?? '';
  const badgeType = body.badge_type ?? 'ADULT';
  const returnEligible = body.return_eligible ? 1 : 0;
  const signupEmail = await fetchClerkUserEmail({
    secretKey: c.env.CLERK_SECRET_KEY ?? '',
    userId: access.userId,
  });

  const stmts: D1PreparedStatement[] = [];

  // 1. Create year_member
  stmts.push(db.prepare(`
    INSERT INTO year_members (year_id, clerk_user_id, role, sponsor_clerk_user_id,
      first_name, last_name, member_id, badge_type, return_eligible)
    VALUES (?, ?, 'registered', ?, ?, ?, ?, ?, ?)
  `).bind(yearId, access.userId, invite.invited_by_clerk_user_id,
    firstName, lastName, memberId, badgeType, returnEligible));

  // 2. Count the use; a personal invite records who used it, and either kind is marked
  // used (full) once it reaches max_uses.
  stmts.push(db.prepare(`
    UPDATE invites SET
      use_count = use_count + 1,
      used_by_clerk_user_id = CASE WHEN max_uses = 1 THEN ? ELSE used_by_clerk_user_id END,
      used_at = CASE WHEN use_count + 1 >= max_uses THEN datetime('now') ELSE used_at END
    WHERE code = ?
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

    // Match on Member ID first, then on the email whoever added this person recorded.
    // Without the email fallback, a family member who later signs up for their own account
    // gets a second participant row and their original one is orphaned. Both lookups skip
    // rows that belong to a different account, or typing someone else's Member ID would
    // hand you their row.
    const unclaimed = "(clerk_user_id IS NULL OR clerk_user_id = '' OR clerk_user_id = ?)";
    const existingP =
      (memberId
        ? await db.prepare(`
            SELECT id, member_id FROM participants
            WHERE event_id = ? AND UPPER(member_id) = UPPER(?) AND ${unclaimed}
          `).bind(ev.id, memberId, access.userId).first<{ id: number; member_id: string }>()
        : null)
      ?? (signupEmail
        ? await db.prepare(`
            SELECT id, member_id FROM participants
            WHERE event_id = ? AND LOWER(email) = ? AND ${unclaimed}
          `).bind(ev.id, signupEmail, access.userId).first<{ id: number; member_id: string }>()
        : null);

    if (existingP) {
      // They are reading their own SDCC account, so their Member ID beats whatever an
      // organizer recorded from a previous year. Overwriting cannot trip the per-event
      // unique index here: any other row holding this ID is either unclaimed, in which
      // case the lookup above matched it instead, or owned by someone else and already
      // rejected before we got here.
      await db.prepare(`
        UPDATE participants
        SET clerk_user_id = ?, group_id = ?, registered_by_clerk_user_id = ?,
            member_id = ?,
            email = CASE WHEN email = '' THEN ? ELSE email END
        WHERE id = ?
      `).bind(
        access.userId, group.id, access.userId, memberId, signupEmail, existingP.id,
      ).run();
    } else {
      await db.prepare(`
        INSERT INTO participants (event_id, first_name, last_name, member_id, badge_type,
          return_eligible, clerk_user_id, registered_by_clerk_user_id, group_id, email)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(ev.id, firstName, lastName, memberId, badgeType,
        returnEligible, access.userId, access.userId, group.id, signupEmail).run();
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

/** Latest convention year (auth required, membership not required). */
app.get('/api/years/current', async (c) => {
  const access = await authenticate(c, c.env.ADMIN_SECRET, c.env.CLERK_JWKS_URL ?? '');
  if (!access || access.userId === 'admin') return err('Sign in required', 401);

  const year = await c.env.DB.prepare(
    'SELECT * FROM years ORDER BY con_year DESC LIMIT 1'
  ).first<Year>();
  if (!year) return err('No years configured', 404);
  return json(year);
});

/**
 * Enroll the signed-in user into a year (creates year_members + per-event group/participant).
 * Used when registering without a prior invite, or joining from the dashboard.
 */
app.post('/api/years/:yearId/enroll', async (c) => {
  const access = await authenticate(c, c.env.ADMIN_SECRET, c.env.CLERK_JWKS_URL ?? '');
  if (!access || access.userId === 'admin') return err('Sign in required', 401);

  const yearId = Number(c.req.param('yearId'));
  const year = await c.env.DB.prepare('SELECT * FROM years WHERE id = ?').bind(yearId).first<Year>();
  if (!year) return err('Year not found', 404);

  const body = await c.req.json<{
    first_name?: string;
    last_name?: string;
    member_id?: string;
    badge_type?: 'ADULT' | 'JUNIOR';
    return_eligible?: boolean;
  }>().catch(() => ({} as {
    first_name?: string;
    last_name?: string;
    member_id?: string;
    badge_type?: 'ADULT' | 'JUNIOR';
    return_eligible?: boolean;
  }));

  const existing = await c.env.DB.prepare(
    'SELECT * FROM year_members WHERE year_id = ? AND clerk_user_id = ?'
  ).bind(yearId, access.userId).first<YearMember>();
  if (existing) {
    return json({ ok: true, member: mapYearMember(existing), created: false });
  }

  const firstName = (body.first_name ?? '').trim() || 'Member';
  const lastName = (body.last_name ?? '').trim() || '';
  const memberId = (body.member_id ?? '').trim().toUpperCase();
  const badgeType = body.badge_type === 'JUNIOR' ? 'JUNIOR' : 'ADULT';
  const returnEligible = body.return_eligible ? 1 : 0;

  const db = c.env.DB;
  const color = await pickGroupColor(db, yearId);
  const groupName = lastName ? `${firstName} ${lastName}` : `${firstName}'s Group`;

  const events = await db.prepare(
    'SELECT id FROM events WHERE year_id = ?'
  ).bind(yearId).all<{ id: number }>();

  await db.prepare(`
    INSERT INTO year_members (year_id, clerk_user_id, role, first_name, last_name, member_id, badge_type, return_eligible)
    VALUES (?, ?, 'registered', ?, ?, ?, ?, ?)
  `).bind(yearId, access.userId, firstName, lastName, memberId, badgeType, returnEligible).run();

  for (const ev of events.results) {
    await db.prepare(`
      INSERT INTO groups (event_id, name, color, owner_clerk_user_id)
      VALUES (?, ?, ?, ?)
    `).bind(ev.id, groupName, color, access.userId).run();

    const group = await db.prepare(
      'SELECT id FROM groups WHERE event_id = ? AND owner_clerk_user_id = ?'
    ).bind(ev.id, access.userId).first<{ id: number }>();
    if (!group) continue;

    const existingP = memberId
      ? await db.prepare(
          'SELECT id FROM participants WHERE event_id = ? AND UPPER(member_id) = UPPER(?)'
        ).bind(ev.id, memberId).first<{ id: number }>()
      : null;

    if (existingP) {
      await db.prepare(`
        UPDATE participants SET clerk_user_id = ?, group_id = ?, registered_by_clerk_user_id = ?,
          first_name = ?, last_name = ?
        WHERE id = ?
      `).bind(access.userId, group.id, access.userId, firstName, lastName, existingP.id).run();
    } else {
      await db.prepare(`
        INSERT INTO participants (event_id, first_name, last_name, member_id, badge_type,
          return_eligible, clerk_user_id, registered_by_clerk_user_id, group_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        ev.id, firstName, lastName, memberId, badgeType, returnEligible,
        access.userId, access.userId, group.id,
      ).run();
    }
  }

  const member = await db.prepare(
    'SELECT * FROM year_members WHERE year_id = ? AND clerk_user_id = ?'
  ).bind(yearId, access.userId).first<YearMember>();

  return json({ ok: true, member: mapYearMember(member!), created: true }, 201);
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
  const memberId = body.member_id?.trim().toUpperCase() ?? '';
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

  const yearMember = await c.env.DB.prepare(
    'SELECT * FROM year_members WHERE year_id = ? AND clerk_user_id = ?'
  ).bind(yearId, access.userId).first<YearMember>();
  if (!yearMember) return err('Not a member of this year', 403);

  const group = await getOrCreateOwnerGroup(c.env.DB, eventId, access.userId, {
    first_name: yearMember.first_name,
    last_name: yearMember.last_name,
  });

  const body = await c.req.json<{
    first_name: string;
    last_name: string;
    member_id?: string;
    email?: string;
    badge_type?: 'ADULT' | 'JUNIOR';
    return_eligible?: boolean;
    req_preview?: boolean;
    req_thu?: boolean;
    req_fri?: boolean;
    req_sat?: boolean;
    req_sun?: boolean;
  }>();
  if (!body.first_name?.trim() || !body.last_name?.trim()) return err('First and last name required');

  const memberId = body.member_id?.trim().toUpperCase() ?? '';
  const email = body.email?.trim().toLowerCase() ?? '';

  const event = await getEvent(c.env.DB, eventId);
  const reqDays = REQ_DAY_KEYS.map((key) => (body[key] ? 1 : 0));

  // A person with no Member ID cannot be bought for on a return event, and a person with no
  // requested days is invisible to the purchase board. Reject both up front rather than
  // creating a row that silently blocks on purchase day.
  if (!memberId && event?.reg_type === 'return') {
    return err('Member ID is required for return registration');
  }
  if (event?.status === 'registration' && !reqDays.some((d) => d === 1)) {
    return err('Select at least one badge day');
  }
  const previewErr = assertPreviewNightAllowed(normalizeDays(body));
  if (previewErr) return err(previewErr);

  // Link to existing participant if member_id matches — only if ungrouped or already ours
  if (memberId) {
    const existingP = await c.env.DB.prepare(
      'SELECT id, group_id, clerk_user_id FROM participants WHERE event_id = ? AND UPPER(member_id) = UPPER(?)'
    ).bind(eventId, memberId).first<{ id: number; group_id: number | null; clerk_user_id: string | null }>();

    if (existingP) {
      if (existingP.clerk_user_id && existingP.clerk_user_id !== access.userId) {
        return err('That Member ID belongs to another account', 409);
      }
      if (existingP.group_id && existingP.group_id !== group.id) {
        return err('That Member ID is already in another group', 409);
      }
      const dayClauses = event?.status === 'registration'
        ? REQ_DAY_KEYS.map((key) => `${key} = ?`)
        : [];
      await c.env.DB.prepare(`
        UPDATE participants
        SET group_id = ?, registered_by_clerk_user_id = ?${dayClauses.length ? `, ${dayClauses.join(', ')}` : ''}
        WHERE id = ?
      `).bind(
        group.id,
        access.userId,
        ...(dayClauses.length ? reqDays : []),
        existingP.id,
      ).run();
      const updated = await c.env.DB.prepare(
        `${PARTICIPANTS_QUERY} WHERE p.id = ?`
      ).bind(existingP.id).first<Participant>();
      return json(updated, 201);
    }
  }

  const result = await c.env.DB.prepare(`
    INSERT INTO participants (event_id, first_name, last_name, member_id, badge_type,
      return_eligible, registered_by_clerk_user_id, group_id, email,
      ${REQ_DAY_KEYS.join(', ')})
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    eventId,
    body.first_name.trim(),
    body.last_name.trim(),
    memberId,
    body.badge_type ?? 'ADULT',
    body.return_eligible ? 1 : 0,
    access.userId,
    group.id,
    email,
    ...reqDays,
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
  const statusErr = assertRegistrationOpen(event.status);
  if (statusErr) return err(statusErr, 403);

  const identity = {
    first_name: yearMember.first_name ?? '',
    last_name: yearMember.last_name ?? '',
    member_id: yearMember.member_id ?? '',
    badge_type: (yearMember.badge_type === 'JUNIOR' ? 'JUNIOR' : 'ADULT') as 'ADULT' | 'JUNIOR',
  };

  const group = await getOrCreateOwnerGroup(c.env.DB, eventId, access.userId, identity);
  const body = await c.req.json<Partial<{
    req_preview: boolean; req_thu: boolean; req_fri: boolean; req_sat: boolean; req_sun: boolean;
  }>>();
  const days = normalizeDays(body);
  const previewErr = assertPreviewNightAllowed(days);
  if (previewErr) return err(previewErr);

  const pid = await upsertSelfParticipantDays(c.env.DB, {
    eventId,
    clerkUserId: access.userId,
    groupId: group.id,
    identity,
    days,
  });

  const updated = await c.env.DB.prepare(
    `${PARTICIPANTS_QUERY} WHERE p.id = ?`
  ).bind(pid).first<Participant>();
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
    `SELECT id, req_preview, req_thu, req_fri, req_sat, req_sun
     FROM participants WHERE id = ? AND event_id = ? AND group_id = ?`
  ).bind(pid, eventId, group.id).first<Participant>();
  if (!p) return err('Participant not found', 404);

  const body = await c.req.json<Partial<{
    first_name: string; last_name: string; member_id: string; email: string;
    badge_type: 'ADULT' | 'JUNIOR'; return_eligible: boolean;
    req_preview: boolean; req_thu: boolean; req_fri: boolean; req_sat: boolean; req_sun: boolean;
  }>>();

  const event = await getEvent(c.env.DB, eventId);
  const canEditDays = event?.status === 'registration';

  // The body only carries the days the caller touched, so validate the row as it will
  // look afterwards — checking the body alone would wave through unticking Thursday on
  // someone who already has Preview Night.
  if (canEditDays) {
    const previewErr = assertPreviewNightAllowed(normalizeDays({ ...normalizeDays(p), ...body }));
    if (previewErr) return err(previewErr);
  }

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
    'email = COALESCE(?, email)',
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
    body.member_id?.trim().toUpperCase() ?? null,
    body.email != null ? body.email.trim().toLowerCase() : null,
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
      body.member_id !== undefined ? body.member_id.trim().toUpperCase() : null,
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

/** Mark unused invites as used when a matching year member already exists (name or email path heal). */
async function reconcileUnusedInvites(db: D1Database, yearId: number, invitedBy: string): Promise<void> {
  const pending = await db.prepare(
    `SELECT * FROM invites
     WHERE year_id = ? AND invited_by_clerk_user_id = ? AND used_at IS NULL AND max_uses = 1
       AND TRIM(COALESCE(label, '')) != ''`
  ).bind(yearId, invitedBy).all<Invite>();

  for (const inv of pending.results) {
    const label = inv.label.trim().toLowerCase();
    const matches = await db.prepare(
      `SELECT * FROM year_members
       WHERE year_id = ?
         AND LOWER(TRIM(first_name || ' ' || last_name)) = ?`
    ).bind(yearId, label).all<YearMember>();

    if (matches.results.length !== 1) continue;
    const ym = matches.results[0];
    await db.prepare(`
      UPDATE invites SET used_by_clerk_user_id = ?, used_at = COALESCE(?, datetime('now'))
      WHERE id = ? AND used_at IS NULL
    `).bind(ym.clerk_user_id, ym.joined_at, inv.id).run();
    if (!ym.sponsor_clerk_user_id) {
      await db.prepare(
        'UPDATE year_members SET sponsor_clerk_user_id = ? WHERE id = ?'
      ).bind(invitedBy, ym.id).run();
    }
  }
}

// List invites created by the current user for a year
app.get('/api/years/:yearId/invites', async (c) => {
  const access = await authenticate(c, c.env.ADMIN_SECRET, c.env.CLERK_JWKS_URL ?? '');
  if (!access || access.userId === 'admin') return err('Sign in required', 401);

  const yearId = Number(c.req.param('yearId'));

  const member = await c.env.DB.prepare(
    'SELECT id FROM year_members WHERE year_id = ? AND clerk_user_id = ?'
  ).bind(yearId, access.userId).first();
  if (!member) return err('Not a member of this year', 403);

  await reconcileUnusedInvites(c.env.DB, yearId, access.userId);

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

  const body = await c.req.json<{ label?: string; email?: string }>();

  let code: string;
  // Retry on (unlikely) collision
  for (let i = 0; i < 5; i++) {
    code = generateInviteCode();
    const existing = await c.env.DB.prepare(
      'SELECT id FROM invites WHERE code = ?'
    ).bind(code).first();
    if (!existing) break;
  }

  const label = body.label?.trim() ?? '';
  await c.env.DB.prepare(`
    INSERT INTO invites (year_id, code, label, invited_by_clerk_user_id)
    VALUES (?, ?, ?, ?)
  `).bind(yearId, code!, label, access.userId).run();

  const invite = await c.env.DB.prepare(
    'SELECT * FROM invites WHERE code = ?'
  ).bind(code!).first<Invite>();

  const joinUrl = inviteJoinUrl(c.env.FRONTEND_URL, code!);

  let emailSent = false;
  let emailError: string | undefined;
  let finalInvite = invite!;

  const email = body.email?.trim();
  if (email) {
    const result = await sendInviteClerkEmail(c.env, invite!, email);
    emailSent = result.emailSent;
    emailError = result.emailError;
    if (result.emailSent) {
      finalInvite = await c.env.DB.prepare('SELECT * FROM invites WHERE id = ?').bind(invite!.id).first<Invite>() ?? invite!;
    }
  }

  return json({ invite: finalInvite, join_url: joinUrl, email_sent: emailSent, email_error: emailError }, 201);
});

// Delete an unused invite created by the current user
app.delete('/api/years/:yearId/invites/:inviteId', async (c) => {
  const access = await authenticate(c, c.env.ADMIN_SECRET, c.env.CLERK_JWKS_URL ?? '');
  if (!access || access.userId === 'admin') return err('Sign in required', 401);

  const yearId = Number(c.req.param('yearId'));
  const inviteId = Number(c.req.param('inviteId'));

  const member = await c.env.DB.prepare(
    'SELECT id FROM year_members WHERE year_id = ? AND clerk_user_id = ?'
  ).bind(yearId, access.userId).first();
  if (!member) return err('Not a member of this year', 403);

  const invite = await c.env.DB.prepare(
    'SELECT * FROM invites WHERE id = ? AND year_id = ? AND invited_by_clerk_user_id = ?'
  ).bind(inviteId, yearId, access.userId).first<Invite>();
  if (!invite) return err('Invite not found', 404);
  if (invite.used_at) return err('This invite has already been used', 409);

  await revokeInviteClerkEmail(c.env, invite);
  await c.env.DB.prepare('DELETE FROM invites WHERE id = ?').bind(inviteId).run();
  return json({ ok: true });
});

// Resend Clerk invitation email for an unused invite
app.post('/api/years/:yearId/invites/:inviteId/resend', async (c) => {
  const access = await authenticate(c, c.env.ADMIN_SECRET, c.env.CLERK_JWKS_URL ?? '');
  if (!access || access.userId === 'admin') return err('Sign in required', 401);

  const yearId = Number(c.req.param('yearId'));
  const inviteId = Number(c.req.param('inviteId'));
  const body = await c.req.json<{ email?: string }>().catch(() => ({} as { email?: string }));

  const member = await c.env.DB.prepare(
    'SELECT id FROM year_members WHERE year_id = ? AND clerk_user_id = ?'
  ).bind(yearId, access.userId).first();
  if (!member) return err('Not a member of this year', 403);

  const invite = await c.env.DB.prepare(
    'SELECT * FROM invites WHERE id = ? AND year_id = ? AND invited_by_clerk_user_id = ?'
  ).bind(inviteId, yearId, access.userId).first<Invite>();
  if (!invite) return err('Invite not found', 404);
  if (invite.used_at) return err('This invite has already been used', 409);

  const email = (body.email?.trim() || invite.invited_email || '').toLowerCase();
  if (!email) {
    return err('No email on file for this invite. Provide an email to resend.', 400);
  }

  await revokeInviteClerkEmail(c.env, invite);

  const result = await sendInviteClerkEmail(c.env, invite, email);
  if (!result.emailSent) {
    return err(result.emailError ?? 'Failed to resend invitation email', 502);
  }

  const updated = await c.env.DB.prepare('SELECT * FROM invites WHERE id = ?').bind(inviteId).first<Invite>();
  return json({ invite: updated, email_sent: true });
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

  const yearId = body.year_id
    ?? await resolveOrCreateYearId(c.env.DB, body.year);

  const result = await c.env.DB.prepare(`
    INSERT INTO events
      (year, year_id, name, reg_type, status,
       price_preview_adult, price_thu_adult, price_fri_adult, price_sat_adult, price_sun_adult,
       price_preview_junior, price_thu_junior, price_fri_junior, price_sat_junior, price_sun_junior)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    body.year, yearId, body.name, body.reg_type ?? 'open', body.status ?? 'setup',
    body.price_preview_adult ?? 0, body.price_thu_adult ?? 0,
    body.price_fri_adult ?? 0, body.price_sat_adult ?? 0, body.price_sun_adult ?? 0,
    body.price_preview_junior ?? 0, body.price_thu_junior ?? 0,
    body.price_fri_junior ?? 0, body.price_sat_junior ?? 0, body.price_sun_junior ?? 0,
  ).run();

  return json({ id: result.meta.last_row_id, year_id: yearId }, 201);
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
  // Real purchasing replaces practice, so nobody is left rehearsing on a stale copy.
  if (body.status === 'purchasing') await deletePracticeCopies(c.env.DB, id);
  return json({ ok: true });
});

admin.delete('/events/:id', async (c) => {
  const id = Number(c.req.param('id'));
  await deletePracticeCopies(c.env.DB, id);
  const res = await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM purchase_queue WHERE event_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM buy_list_entries WHERE event_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM participants WHERE event_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM groups WHERE event_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM coordinators WHERE event_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM events WHERE id = ?').bind(id),
  ]);
  if ((res[5].meta.changes ?? 0) === 0) return err('Event not found', 404);
  return json({ ok: true, participants_deleted: res[2].meta.changes ?? 0 });
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
         clerk_user_id, registered_by_clerk_user_id, email)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      eventId,
      body.first_name.trim(), body.last_name.trim(),
      body.member_id?.trim().toUpperCase() ?? '',
      body.badge_type === 'JUNIOR' ? 'JUNIOR' : 'ADULT',
      body.return_eligible ? 1 : 0,
      body.notes?.trim() ?? '',
      body.req_preview ? 1 : 0, body.req_thu ? 1 : 0,
      body.req_fri ? 1 : 0, body.req_sat ? 1 : 0, body.req_sun ? 1 : 0,
      body.sort_order ?? 9999,
      body.purchasing_coordinator?.trim() ?? '',
      body.clerk_user_id ?? null,
      body.registered_by_clerk_user_id ?? null,
      (body.email ?? '').trim().toLowerCase(),
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

  // Stored lowercase because invite-accept matches on LOWER(email) to link a signup to the
  // row an organizer already recorded.
  if ('email' in body) {
    fields.push('email = ?');
    values.push((body.email ?? '').trim().toLowerCase());
  }

  for (const key of allowed) {
    if (key in body) {
      fields.push(`${key} = ?`);
      const val = body[key];
      values.push(
        key === 'member_id' ? String(val ?? '').trim().toUpperCase()
          : typeof val === 'boolean' ? (val ? 1 : 0) : (val as string | number | null),
      );
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

  const yearId = await resolveOrCreateYearId(c.env.DB, body.year);

  const insertSQL = `
    INSERT INTO events (year, year_id, name, reg_type, status,
      price_preview_adult, price_thu_adult, price_fri_adult, price_sat_adult, price_sun_adult,
      price_preview_junior, price_thu_junior, price_fri_junior, price_sat_junior, price_sun_junior)
    VALUES (?, ?, ?, ?, 'setup', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  const priceBinds = [
    body.price_preview_adult ?? 0, body.price_thu_adult ?? 0, body.price_fri_adult ?? 0,
    body.price_sat_adult ?? 0, body.price_sun_adult ?? 0,
    body.price_preview_junior ?? 0, body.price_thu_junior ?? 0, body.price_fri_junior ?? 0,
    body.price_sat_junior ?? 0, body.price_sun_junior ?? 0,
  ];

  await c.env.DB.batch([
    c.env.DB.prepare(insertSQL).bind(body.year, yearId, `SDCC ${body.year} Return Reg`, 'return', ...priceBinds),
    c.env.DB.prepare(insertSQL).bind(body.year, yearId, `SDCC ${body.year} Open Reg`, 'open', ...priceBinds),
  ]);

  return json({ ok: true, year_id: yearId }, 201);
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

  // Ensure target has matching owner groups so group_id can be remapped
  const sourceGroups = await c.env.DB.prepare(
    'SELECT id, name, owner_clerk_user_id FROM groups WHERE event_id = ?'
  ).bind(sourceEventId).all<{ id: number; name: string; owner_clerk_user_id: string | null }>();

  for (const g of sourceGroups.results) {
    if (!g.owner_clerk_user_id) continue;
    const existing = await c.env.DB.prepare(
      'SELECT id FROM groups WHERE event_id = ? AND owner_clerk_user_id = ?'
    ).bind(body.target_event_id, g.owner_clerk_user_id).first();
    if (!existing) {
      await c.env.DB.prepare(`
        INSERT INTO groups (event_id, name, color, owner_clerk_user_id)
        VALUES (?, ?, ?, ?)
      `).bind(body.target_event_id, g.name, '#3b82f6', g.owner_clerk_user_id).run();
    }
  }

  const targetGroups = await c.env.DB.prepare(
    'SELECT id, name, owner_clerk_user_id FROM groups WHERE event_id = ?'
  ).bind(body.target_event_id).all<{ id: number; name: string; owner_clerk_user_id: string | null }>();

  const insertStmts = participants.map((p, idx) => {
    const mappedGroupId = mapGroupIdForCopy(
      p.group_id,
      sourceGroups.results,
      targetGroups.results,
    );
    return c.env.DB.prepare(`
      INSERT INTO participants
        (event_id, first_name, last_name, member_id, badge_type, return_eligible, notes,
         req_preview, req_thu, req_fri, req_sat, req_sun, sort_order,
         purchasing_coordinator, purchasing_claimed_by,
         pur_preview, pur_thu, pur_fri, pur_sat, pur_sun, who_purchased, paid,
         clerk_user_id, registered_by_clerk_user_id, group_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      mappedGroupId,
    );
  });

  const deleteStmts = body.transfer
    ? participants.map((p) =>
        c.env.DB.prepare('DELETE FROM participants WHERE id = ? AND event_id = ?').bind(p.id, sourceEventId)
      )
    : [];

  await c.env.DB.batch([...insertStmts, ...deleteStmts]);
  return json({ ok: true, copied: participants.length });
});

/** Wipes an event's Queue-It line, e.g. the places people joined while practicing. */
admin.delete('/events/:id/purchase-queue', async (c) => {
  const eventId = Number(c.req.param('id'));
  const res = await c.env.DB.batch([
    releasePlaceClaims(c.env.DB, 'SELECT id FROM purchase_queue WHERE event_id = ?', eventId),
    c.env.DB.prepare('DELETE FROM purchase_queue WHERE event_id = ?').bind(eventId),
  ]);
  return json({ ok: true, cleared: res[1].meta.changes ?? 0 });
});

/** Hands a place in line to someone else on the board, who then claims and buys through it. */
admin.patch('/events/:id/purchase-queue/:qid/owner', async (c) => {
  const eventId = Number(c.req.param('id'));
  const qid = Number(c.req.param('qid'));
  const body = await c.req.json<{ clerk_user_id?: string }>();
  const owner = body.clerk_user_id?.trim() ?? '';
  if (!owner) return err('clerk_user_id required');

  const place = await c.env.DB.prepare(
    'SELECT id, clerk_user_id FROM purchase_queue WHERE id = ? AND event_id = ?'
  ).bind(qid, eventId).first<{ id: number; clerk_user_id: string }>();
  if (!place) return err('Queue entry not found', 404);
  const row = await c.env.DB.prepare(
    'SELECT id FROM participants WHERE event_id = ? AND clerk_user_id = ?'
  ).bind(eventId, owner).first<{ id: number }>();
  if (!row) return err("The new owner isn't on this event's board", 400);
  if (place.clerk_user_id === owner) return json(await listPurchaseQueue(c.env.DB, eventId));

  // Claims were made under the old owner's name, so they go back up rather than move.
  // Anyone already bought for keeps the link, since they used one of the place's 3 badges.
  await c.env.DB.batch([
    c.env.DB.prepare(`
      UPDATE participants
      SET purchasing_claimed_by = '', purchasing_claimed_at = NULL,
          purchasing_claimed_queue_id = CASE
            WHEN pur_preview OR pur_thu OR pur_fri OR pur_sat OR pur_sun THEN purchasing_claimed_queue_id
            ELSE NULL END,
          updated_at = datetime('now')
      WHERE purchasing_claimed_queue_id = ? AND event_id = ?
    `).bind(qid, eventId),
    c.env.DB.prepare(`
      UPDATE purchase_queue SET clerk_user_id = ?, participant_id = ?, updated_at = datetime('now')
      WHERE id = ? AND event_id = ?
    `).bind(owner, row.id, qid, eventId),
  ]);
  return json(await listPurchaseQueue(c.env.DB, eventId));
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
  const body = await c.req.json<{ name?: string; color?: string; owner_clerk_user_id?: string }>();
  const fields: string[] = [];
  const values: (string | number)[] = [];
  if (body.name !== undefined) {
    if (!body.name.trim()) return err('Name cannot be empty');
    fields.push('name = ?'); values.push(body.name.trim());
  }
  if (body.color !== undefined) { fields.push('color = ?'); values.push(body.color); }
  if (body.owner_clerk_user_id !== undefined) {
    const owner = body.owner_clerk_user_id.trim();
    if (owner) {
      const onBoard = await c.env.DB.prepare(
        'SELECT id FROM participants WHERE event_id = ? AND clerk_user_id = ?'
      ).bind(eventId, owner).first();
      if (!onBoard) return err("The new owner isn't on this event's board", 400);
    }
    fields.push('owner_clerk_user_id = ?'); values.push(owner);
  }
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

admin.delete('/years/:yearId', async (c) => {
  const yearId = Number(c.req.param('yearId'));
  const year = await c.env.DB.prepare('SELECT * FROM years WHERE id = ?').bind(yearId).first<Year>();
  if (!year) return err('Year not found', 404);

  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM events WHERE year_id = ?').bind(yearId),
    c.env.DB.prepare('DELETE FROM year_meta WHERE year = ?').bind(year.con_year),
    c.env.DB.prepare('DELETE FROM years WHERE id = ?').bind(yearId),
  ]);

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
  const body = await c.req.json<{ label?: string; email?: string; max_uses?: number }>();
  const invitedBy = access?.userId === 'admin' ? 'admin' : (access?.userId ?? 'admin');
  const maxUses = Math.min(Math.max(Math.floor(Number(body.max_uses) || 1), 1), MAX_SHARED_INVITE_USES);
  if (maxUses > 1 && body.email?.trim()) return err('A shared link can\'t be emailed to one person', 400);

  const invite = await createUniqueInvite(
    c.env.DB, yearId, body.label?.trim() ?? '', invitedBy, maxUses,
  );

  const joinUrl = inviteJoinUrl(c.env.FRONTEND_URL, invite.code);

  let emailSent = false;
  let emailError: string | undefined;
  let finalInvite = invite;

  const email = body.email?.trim();
  if (email) {
    const result = await sendInviteClerkEmail(c.env, invite, email);
    emailSent = result.emailSent;
    emailError = result.emailError;
    if (result.emailSent) {
      finalInvite = await c.env.DB.prepare('SELECT * FROM invites WHERE id = ?').bind(invite.id).first<Invite>() ?? invite;
    }
  }

  return json({ invite: finalInvite, join_url: joinUrl, email_sent: emailSent, email_error: emailError }, 201);
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
  const invite = await c.env.DB.prepare(
    'SELECT * FROM invites WHERE id = ? AND year_id = ?'
  ).bind(inviteId, yearId).first<Invite>();
  if (invite) await revokeInviteClerkEmail(c.env, invite);
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

/** Edits someone's profile for the year and copies it to their own rows on every event board. */
admin.patch('/years/:yearId/members/:memberId', async (c) => {
  const yearId = Number(c.req.param('yearId'));
  const memberId = Number(c.req.param('memberId'));
  const member = await c.env.DB.prepare(
    'SELECT * FROM year_members WHERE id = ? AND year_id = ?'
  ).bind(memberId, yearId).first<YearMember>();
  if (!member) return err('Member not found', 404);

  const body = await c.req.json<{
    first_name?: string; last_name?: string; member_id?: string;
    badge_type?: 'ADULT' | 'JUNIOR'; return_eligible?: boolean; role?: 'admin' | 'registered';
  }>();
  const firstName = body.first_name?.trim() ?? member.first_name;
  const lastName = body.last_name?.trim() ?? member.last_name;
  if (!firstName || !lastName) return err('First and last name required');
  const memberIdValue = body.member_id !== undefined ? body.member_id.trim().toUpperCase() : member.member_id;
  const badgeType = body.badge_type === undefined ? member.badge_type : body.badge_type === 'JUNIOR' ? 'JUNIOR' : 'ADULT';
  const returnEligible = body.return_eligible === undefined ? (member.return_eligible ? 1 : 0) : body.return_eligible ? 1 : 0;
  let role = member.role;
  if (body.role !== undefined) {
    if (member.role === 'owner') return err("The year's owner keeps the owner role", 400);
    if (body.role !== 'admin' && body.role !== 'registered') return err('role must be admin or registered');
    role = body.role;
  }

  await c.env.DB.batch([
    c.env.DB.prepare(`
      UPDATE year_members SET first_name = ?, last_name = ?, member_id = ?, badge_type = ?,
        return_eligible = ?, role = ?
      WHERE id = ? AND year_id = ?
    `).bind(firstName, lastName, memberIdValue, badgeType, returnEligible, role, memberId, yearId),
    c.env.DB.prepare(`
      UPDATE participants SET first_name = ?, last_name = ?, member_id = ?, badge_type = ?,
        return_eligible = ?, updated_at = datetime('now')
      WHERE clerk_user_id = ? AND event_id IN (SELECT id FROM events WHERE year_id = ?)
    `).bind(firstName, lastName, memberIdValue, badgeType, returnEligible, member.clerk_user_id, yearId),
  ]);

  const updated = await c.env.DB.prepare('SELECT * FROM year_members WHERE id = ?').bind(memberId).first<YearMember>();
  return json(updated);
});

/**
 * Removes someone from a year: their membership, their own board rows, and their queue
 * places. People they added stay on the board, unlinked from them, and groups they owned
 * are kept without an owner. Their login is untouched so a new invite can bring them back.
 * `?dry_run=1` reports what would change without changing it.
 */
admin.delete('/years/:yearId/members/:memberId', async (c) => {
  const access = await authenticate(c, c.env.ADMIN_SECRET, c.env.CLERK_JWKS_URL ?? '');
  const yearId = Number(c.req.param('yearId'));
  const memberId = Number(c.req.param('memberId'));
  const dryRun = c.req.query('dry_run') === '1';

  const member = await c.env.DB.prepare(
    'SELECT * FROM year_members WHERE id = ? AND year_id = ?'
  ).bind(memberId, yearId).first<YearMember>();
  if (!member) return err('Member not found', 404);
  if (member.role === 'owner') return err("The year's owner can't be deleted", 400);
  if (access?.userId && access.userId === member.clerk_user_id) return err("You can't delete yourself", 400);

  const uid = member.clerk_user_id;
  const inYear = 'event_id IN (SELECT id FROM events WHERE year_id = ?)';
  const counts = await c.env.DB.prepare(`
    SELECT
      (SELECT COUNT(*) FROM participants WHERE clerk_user_id = ? AND ${inYear}) AS own_rows,
      (SELECT COUNT(*) FROM purchase_queue WHERE (clerk_user_id = ? OR participant_id IN (
         SELECT id FROM participants WHERE clerk_user_id = ? AND ${inYear})) AND ${inYear}) AS queue_places,
      (SELECT COUNT(*) FROM participants WHERE registered_by_clerk_user_id = ?
         AND (clerk_user_id IS NULL OR clerk_user_id != ?) AND ${inYear}) AS added_rows,
      (SELECT COUNT(*) FROM groups WHERE owner_clerk_user_id = ? AND ${inYear}) AS owned_groups
  `).bind(uid, yearId, uid, uid, yearId, yearId, uid, uid, yearId, uid, yearId).first<{
    own_rows: number; queue_places: number; added_rows: number; owned_groups: number;
  }>();
  const summary = {
    own_rows: counts?.own_rows ?? 0,
    queue_places: counts?.queue_places ?? 0,
    added_rows: counts?.added_rows ?? 0,
    owned_groups: counts?.owned_groups ?? 0,
  };
  if (dryRun) return json({ ok: true, dry_run: true, ...summary });

  await c.env.DB.batch([
    releasePlaceClaims(c.env.DB, `
      SELECT id FROM purchase_queue WHERE (clerk_user_id = ? OR participant_id IN (
        SELECT id FROM participants WHERE clerk_user_id = ? AND ${inYear})) AND ${inYear}
    `, uid, uid, yearId, yearId),
    c.env.DB.prepare(`
      DELETE FROM purchase_queue WHERE (clerk_user_id = ? OR participant_id IN (
        SELECT id FROM participants WHERE clerk_user_id = ? AND ${inYear})) AND ${inYear}
    `).bind(uid, uid, yearId, yearId),
    c.env.DB.prepare(`
      DELETE FROM buy_list_entries WHERE (clerk_user_id = ? OR participant_id IN (
        SELECT id FROM participants WHERE clerk_user_id = ? AND ${inYear})) AND ${inYear}
    `).bind(uid, uid, yearId, yearId),
    c.env.DB.prepare(`DELETE FROM participants WHERE clerk_user_id = ? AND ${inYear}`).bind(uid, yearId),
    c.env.DB.prepare(
      `UPDATE participants SET registered_by_clerk_user_id = NULL WHERE registered_by_clerk_user_id = ? AND ${inYear}`
    ).bind(uid, yearId),
    c.env.DB.prepare(`UPDATE groups SET owner_clerk_user_id = '' WHERE owner_clerk_user_id = ? AND ${inYear}`).bind(uid, yearId),
    c.env.DB.prepare('DELETE FROM year_members WHERE id = ? AND year_id = ?').bind(memberId, yearId),
  ]);
  return json({ ok: true, ...summary });
});

// ── Admin: Dummy test participants ────────────────────────────────────────────

admin.get('/years/:yearId/dummies', async (c) => {
  const yearId = Number(c.req.param('yearId'));
  const year = await c.env.DB.prepare('SELECT id FROM years WHERE id = ?').bind(yearId).first();
  if (!year) return err('Year not found', 404);
  return json(await countDummies(c.env.DB, yearId));
});

admin.post('/years/:yearId/dummies', async (c) => {
  const yearId = Number(c.req.param('yearId'));
  const year = await c.env.DB.prepare('SELECT id FROM years WHERE id = ?').bind(yearId).first();
  if (!year) return err('Year not found', 404);

  let body: { count?: number; clear_existing?: boolean } = {};
  try {
    body = await c.req.json<{ count?: number; clear_existing?: boolean }>();
  } catch { /* empty body ok */ }
  try {
    const result = await seedDummies(c.env.DB, yearId, {
      count: body.count,
      clearExisting: body.clear_existing !== false,
    });
    return json(result, 201);
  } catch (e) {
    return err(e instanceof Error ? e.message : 'Seed failed', 400);
  }
});

admin.delete('/years/:yearId/dummies', async (c) => {
  const yearId = Number(c.req.param('yearId'));
  const year = await c.env.DB.prepare('SELECT id FROM years WHERE id = ?').bind(yearId).first();
  if (!year) return err('Year not found', 404);
  return json(await clearDummies(c.env.DB, yearId));
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
      WHERE e.practice_of IS NULL AND who_purchased != '' AND LENGTH(who_purchased) < 25
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
      WHERE e.practice_of IS NULL AND p.member_id != ''
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
