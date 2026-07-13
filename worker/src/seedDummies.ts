/** Marker stored in participants.notes and groups.name for test data cleanup. */
export const DUMMY_MARKER = '[DUMMY]';
export const DUMMY_MEMBER_PREFIX = 'DUMMY-';
export const DUMMY_GROUP_PREFIX = '[DUMMY] ';

const FIRST_NAMES = [
  'Alex', 'Jordan', 'Sam', 'Taylor', 'Casey', 'Riley', 'Morgan', 'Quinn',
  'Avery', 'Jamie', 'Reese', 'Drew', 'Skyler', 'Cameron', 'Harper', 'Rowan',
  'Kai', 'Nova', 'Blake', 'Finley', 'Parker', 'Sage', 'River', 'Emerson',
  'Charlie', 'Dakota', 'Elliot', 'Frankie', 'Hayden', 'Indigo', 'Jules', 'Kit',
];

const LAST_NAMES = [
  'Nguyen', 'Garcia', 'Kim', 'Patel', 'Smith', 'Johnson', 'Lee', 'Brown',
  'Martinez', 'Wilson', 'Anderson', 'Thomas', 'Jackson', 'White', 'Harris', 'Clark',
  'Lewis', 'Robinson', 'Walker', 'Young', 'Allen', 'King', 'Wright', 'Scott',
  'Torres', 'Nguyen', 'Chen', 'Park', 'Singh', 'Cohen', 'Diaz', 'Reed',
];

const GROUP_NAMES = ['Avengers', 'X-Force', 'Justice League', 'Guardians', 'Titans'];
const GROUP_COLORS = ['#ef4444', '#3b82f6', '#22c55e', '#a855f7', '#f59e0b'];

type DayKey = 'preview' | 'thu' | 'fri' | 'sat' | 'sun';
const DAYS: DayKey[] = ['preview', 'thu', 'fri', 'sat', 'sun'];

export type DummySeedResult = {
  created: number;
  groups_created: number;
  event_ids: number[];
};

export type DummyClearResult = {
  participants_deleted: number;
  groups_deleted: number;
  event_ids: number[];
};

export type DummyCountResult = {
  participants: number;
  groups: number;
  event_ids: number[];
};

function mulberry32(seed: number) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function pickDays(rand: () => number): Record<`req_${DayKey}`, boolean> {
  const out = {
    req_preview: false,
    req_thu: false,
    req_fri: false,
    req_sat: false,
    req_sun: false,
  };
  const weights: Record<DayKey, number> = {
    preview: 0.25,
    thu: 0.45,
    fri: 0.7,
    sat: 0.85,
    sun: 0.4,
  };
  let any = false;
  for (const d of DAYS) {
    const on = rand() < weights[d];
    out[`req_${d}`] = on;
    if (on) any = true;
  }
  if (!any) out.req_sat = true;
  return out;
}

async function eventsForYear(db: D1Database, yearId: number): Promise<{ id: number; name: string; reg_type: string }[]> {
  const rows = await db.prepare(
    'SELECT id, name, reg_type FROM events WHERE year_id = ? ORDER BY id ASC'
  ).bind(yearId).all<{ id: number; name: string; reg_type: string }>();
  return rows.results ?? [];
}

export async function countDummies(db: D1Database, yearId: number): Promise<DummyCountResult> {
  const events = await eventsForYear(db, yearId);
  const eventIds = events.map((e) => e.id);
  if (eventIds.length === 0) return { participants: 0, groups: 0, event_ids: [] };

  const placeholders = eventIds.map(() => '?').join(',');
  const p = await db.prepare(
    `SELECT COUNT(*) AS n FROM participants
     WHERE event_id IN (${placeholders})
       AND (notes = ? OR member_id LIKE ?)`
  ).bind(...eventIds, DUMMY_MARKER, `${DUMMY_MEMBER_PREFIX}%`).first<{ n: number }>();

  const g = await db.prepare(
    `SELECT COUNT(*) AS n FROM groups
     WHERE event_id IN (${placeholders})
       AND name LIKE ?`
  ).bind(...eventIds, `${DUMMY_GROUP_PREFIX}%`).first<{ n: number }>();

  return {
    participants: p?.n ?? 0,
    groups: g?.n ?? 0,
    event_ids: eventIds,
  };
}

export async function clearDummies(db: D1Database, yearId: number): Promise<DummyClearResult> {
  const events = await eventsForYear(db, yearId);
  const eventIds = events.map((e) => e.id);
  if (eventIds.length === 0) {
    return { participants_deleted: 0, groups_deleted: 0, event_ids: [] };
  }

  const placeholders = eventIds.map(() => '?').join(',');

  // Unlink dummy groups from any remaining non-dummy participants first (safety)
  await db.prepare(
    `UPDATE participants SET group_id = NULL
     WHERE event_id IN (${placeholders})
       AND group_id IN (
         SELECT id FROM groups WHERE event_id IN (${placeholders}) AND name LIKE ?
       )`
  ).bind(...eventIds, ...eventIds, `${DUMMY_GROUP_PREFIX}%`).run();

  const pRes = await db.prepare(
    `DELETE FROM participants
     WHERE event_id IN (${placeholders})
       AND (notes = ? OR member_id LIKE ?)`
  ).bind(...eventIds, DUMMY_MARKER, `${DUMMY_MEMBER_PREFIX}%`).run();

  const gRes = await db.prepare(
    `DELETE FROM groups
     WHERE event_id IN (${placeholders})
       AND name LIKE ?`
  ).bind(...eventIds, `${DUMMY_GROUP_PREFIX}%`).run();

  return {
    participants_deleted: pRes.meta.changes ?? 0,
    groups_deleted: gRes.meta.changes ?? 0,
    event_ids: eventIds,
  };
}

/**
 * Seed dummy participants (+ a few groups) into every event for a year.
 * Tags: notes='[DUMMY]', member_id='DUMMY-####', group names '[DUMMY] …'
 */
export async function seedDummies(
  db: D1Database,
  yearId: number,
  opts: { count?: number; clearExisting?: boolean } = {},
): Promise<DummySeedResult> {
  const count = Math.min(Math.max(opts.count ?? 40, 1), 120);
  const events = await eventsForYear(db, yearId);
  if (events.length === 0) {
    throw new Error('No events found for this year');
  }

  if (opts.clearExisting !== false) {
    await clearDummies(db, yearId);
  }

  const eventIds = events.map((e) => e.id);
  let created = 0;
  let groupsCreated = 0;

  for (const event of events) {
    const rand = mulberry32(yearId * 10007 + event.id * 97 + count);

    // Create a few named groups
    const groupIds: number[] = [];
    const groupCount = Math.min(3, GROUP_NAMES.length);
    for (let i = 0; i < groupCount; i++) {
      const name = `${DUMMY_GROUP_PREFIX}${GROUP_NAMES[i]}`;
      const color = GROUP_COLORS[i];
      const res = await db.prepare(
        'INSERT INTO groups (event_id, name, color, sort_order) VALUES (?, ?, ?, ?)'
      ).bind(event.id, name, color, i + 1).run();
      groupIds.push(Number(res.meta.last_row_id));
      groupsCreated++;
    }

    // Max existing DUMMY sort for uniqueness if not clearing
    const existing = await db.prepare(
      `SELECT COUNT(*) AS n FROM participants WHERE event_id = ? AND member_id LIKE ?`
    ).bind(event.id, `${DUMMY_MEMBER_PREFIX}%`).first<{ n: number }>();
    const startIdx = (existing?.n ?? 0) + 1;

    const stmts = [];
    for (let i = 0; i < count; i++) {
      const n = startIdx + i;
      const first = FIRST_NAMES[Math.floor(rand() * FIRST_NAMES.length)];
      const last = LAST_NAMES[Math.floor(rand() * LAST_NAMES.length)];
      const badge = rand() < 0.18 ? 'JUNIOR' : 'ADULT';
      const returnEligible = event.reg_type === 'return' ? true : rand() < 0.2;
      const days = pickDays(rand);
      const groupId = groupIds.length && rand() < 0.55
        ? groupIds[Math.floor(rand() * groupIds.length)]
        : null;
      const memberId = `${DUMMY_MEMBER_PREFIX}${String(n).padStart(4, '0')}`;

      stmts.push(
        db.prepare(`
          INSERT INTO participants
            (event_id, first_name, last_name, member_id, badge_type, return_eligible, notes,
             req_preview, req_thu, req_fri, req_sat, req_sun, sort_order, group_id,
             clerk_user_id, registered_by_clerk_user_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
        `).bind(
          event.id,
          first,
          last,
          memberId,
          badge,
          returnEligible ? 1 : 0,
          DUMMY_MARKER,
          days.req_preview ? 1 : 0,
          days.req_thu ? 1 : 0,
          days.req_fri ? 1 : 0,
          days.req_sat ? 1 : 0,
          days.req_sun ? 1 : 0,
          n,
          groupId,
        ),
      );
    }

    // Batch in chunks of 40
    for (let i = 0; i < stmts.length; i += 40) {
      await db.batch(stmts.slice(i, i + 40));
    }
    created += count;
  }

  return { created, groups_created: groupsCreated, event_ids: eventIds };
}
