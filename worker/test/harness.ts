/**
 * Test-only harness: runs the real Hono app against a real SQLite database and
 * real Clerk-style JWT verification, so route tests exercise the actual SQL and
 * auth paths rather than a mock of them.
 *
 * Lives outside src/ because it depends on Node builtins, while the worker
 * source is typed against the Workers runtime only.
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import app from '../src/index';

const WORKER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

export const JWKS_URL = 'https://clerk.test/.well-known/jwks.json';
export const ADMIN_SECRET = 'test-admin-secret';

// ─── Minimal D1 adapter over node:sqlite ─────────────────────────────────────

type SqlValue = string | number | null;

/** D1 rejects JS booleans and undefined; normalize the way the real binding does. */
function normalizeBinding(v: unknown): SqlValue {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' || typeof v === 'string') return v;
  if (typeof v === 'bigint') return Number(v);
  throw new Error(`Unsupported binding type: ${typeof v}`);
}

class TestD1PreparedStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly args: SqlValue[] = [],
  ) {}

  bind(...args: unknown[]): TestD1PreparedStatement {
    return new TestD1PreparedStatement(this.db, this.sql, args.map(normalizeBinding));
  }

  private stmt(): StatementSync {
    return this.db.prepare(this.sql);
  }

  private rows<T>(): T[] {
    // node:sqlite returns null-prototype rows; spread into plain objects like D1.
    return (this.stmt().all(...this.args) as Record<string, unknown>[])
      .map((r) => ({ ...r })) as T[];
  }

  async first<T>(): Promise<T | null> {
    return this.rows<T>()[0] ?? null;
  }

  async all<T>(): Promise<{ results: T[]; success: true; meta: Record<string, number> }> {
    return { results: this.rows<T>(), success: true, meta: {} };
  }

  async run(): Promise<{ success: true; meta: { last_row_id: number; changes: number } }> {
    const res = this.stmt().run(...this.args);
    return {
      success: true,
      meta: { last_row_id: Number(res.lastInsertRowid), changes: Number(res.changes) },
    };
  }
}

class TestD1Database {
  constructor(private readonly db: DatabaseSync) {}

  prepare(sql: string): TestD1PreparedStatement {
    return new TestD1PreparedStatement(this.db, sql);
  }

  async batch(statements: TestD1PreparedStatement[]) {
    const out = [];
    for (const s of statements) out.push(await s.run());
    return out;
  }
}

// ─── Schema ──────────────────────────────────────────────────────────────────

function statementsOf(sql: string): string[] {
  return sql
    .split('\n')
    .map((line) => (line.trimStart().startsWith('--') ? '' : line))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * schema.sql predates several migrations, so migrations legitimately re-add
 * columns and tables it already has. Migration 010 documents that duplicates
 * are expected and safe to ignore.
 */
function isAlreadyAppliedError(message: string): boolean {
  return /duplicate column name|already exists/i.test(message);
}

function applySchema(db: DatabaseSync): void {
  const files = [
    join(WORKER_DIR, 'schema.sql'),
    ...readdirSync(join(WORKER_DIR, 'migrations'))
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((f) => join(WORKER_DIR, 'migrations', f)),
  ];

  for (const file of files) {
    for (const statement of statementsOf(readFileSync(file, 'utf8'))) {
      try {
        db.exec(statement);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (!isAlreadyAppliedError(message)) {
          throw new Error(`${file}: ${message}\n${statement}`);
        }
      }
    }
  }
}

// ─── Clerk-style JWT signing ─────────────────────────────────────────────────

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlJson(value: unknown): string {
  return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

const KID = 'test-key';

type TokenSigner = (sub: string, opts?: { admin?: boolean; expired?: boolean }) => Promise<string>;

/**
 * The worker caches the JWKS at module scope after its first fetch, so every
 * harness in a module must share one key pair or later tokens fail to verify.
 */
let signerPromise: Promise<TokenSigner> | null = null;

function getSigner(): Promise<TokenSigner> {
  if (!signerPromise) signerPromise = setUpClerkAuth();
  return signerPromise;
}

async function setUpClerkAuth(): Promise<TokenSigner> {
  const { publicKey, privateKey } = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  ) as CryptoKeyPair;

  const jwk = { ...(await crypto.subtle.exportKey('jwk', publicKey)), kid: KID };

  // The worker fetches the JWKS itself, so serve it instead of stubbing verification.
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === JWKS_URL) return Response.json({ keys: [jwk] });
    throw new Error(`Unexpected fetch in tests: ${url}`);
  }) as typeof fetch;

  return async (sub, opts = {}) => {
    const header = base64urlJson({ alg: 'RS256', typ: 'JWT', kid: KID });
    const payload = base64urlJson({
      sub,
      exp: Math.floor(Date.now() / 1000) + (opts.expired ? -3600 : 3600),
      public_metadata: opts.admin ? { role: 'admin' } : {},
    });
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      privateKey,
      new TextEncoder().encode(`${header}.${payload}`),
    );
    return `${header}.${payload}.${base64url(new Uint8Array(signature))}`;
  };
}

// ─── Harness ─────────────────────────────────────────────────────────────────

export type TestHarness = {
  db: DatabaseSync;
  /** Signed request as a Clerk user (`sub`), or omit for an unauthenticated call. */
  request: (path: string, init?: RequestInit & { as?: string; adminSecret?: boolean }) => Promise<Response>;
  close: () => void;
};

export async function createHarness(): Promise<TestHarness> {
  const db = new DatabaseSync(':memory:');
  applySchema(db);

  const signToken = await getSigner();
  const env = {
    DB: new TestD1Database(db) as unknown as D1Database,
    ADMIN_SECRET,
    FRONTEND_URL: 'https://komikone.test',
    CLERK_JWKS_URL: JWKS_URL,
  };

  return {
    db,
    request: async (path, init = {}) => {
      const { as, adminSecret, ...rest } = init;
      const headers = new Headers(rest.headers);
      if (adminSecret) headers.set('authorization', `Bearer ${ADMIN_SECRET}`);
      else if (as) headers.set('authorization', `Bearer ${await signToken(as)}`);
      if (rest.body && !headers.has('content-type')) headers.set('content-type', 'application/json');

      return app.fetch(
        new Request(`https://api.komikone.test${path}`, { ...rest, headers }),
        env,
      );
    },
    close: () => db.close(),
  };
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

export function insertEvent(db: DatabaseSync, over: {
  year?: number;
  name?: string;
  reg_type?: 'return' | 'open';
  status?: string;
  price_sat_adult?: number;
} = {}): number {
  const res = db.prepare(`
    INSERT INTO events (year, name, reg_type, status, price_sat_adult, price_sun_adult)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    over.year ?? 2027,
    over.name ?? 'SDCC 2027 Return Reg',
    over.reg_type ?? 'return',
    over.status ?? 'purchasing',
    over.price_sat_adult ?? 8000,
    4000,
  );
  return Number(res.lastInsertRowid);
}

let memberIdSeq = 0;

export function insertParticipant(db: DatabaseSync, eventId: number, over: {
  first_name?: string;
  last_name?: string;
  member_id?: string;
  return_eligible?: number;
  req_sat?: number;
  req_sun?: number;
  pur_sat?: number;
  pur_sun?: number;
  purchasing_claimed_by?: string;
  purchasing_claimed_at?: string | null;
  who_purchased?: string;
  clerk_user_id?: string | null;
  group_id?: number | null;
} = {}): number {
  const res = db.prepare(`
    INSERT INTO participants (
      event_id, first_name, last_name, member_id, return_eligible,
      req_sat, req_sun, pur_sat, pur_sun,
      purchasing_claimed_by, purchasing_claimed_at, who_purchased,
      clerk_user_id, group_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    eventId,
    over.first_name ?? 'Avery',
    over.last_name ?? 'Smith',
    // Member IDs carry a unique index per event, so default to a fresh one.
    over.member_id ?? `MEMBER${(memberIdSeq += 1)}`,
    over.return_eligible ?? 1,
    over.req_sat ?? 1,
    over.req_sun ?? 0,
    over.pur_sat ?? 0,
    over.pur_sun ?? 0,
    over.purchasing_claimed_by ?? '',
    over.purchasing_claimed_at ?? null,
    over.who_purchased ?? '',
    over.clerk_user_id ?? null,
    over.group_id ?? null,
  );
  return Number(res.lastInsertRowid);
}

export function getParticipant(db: DatabaseSync, id: number): Record<string, unknown> {
  return { ...(db.prepare('SELECT * FROM participants WHERE id = ?').get(id) as Record<string, unknown>) };
}
