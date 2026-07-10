# Komikone

Comic-Con badge purchasing coordinator for a group of ~50-80 people.

## Stack
- **Frontend**: React + TypeScript + Tailwind CSS → Vercel
- **Backend**: Cloudflare Workers + Hono → CF free tier
- **Database**: Cloudflare D1 (SQLite) → CF free tier
- **Auth**: Clerk (production instance at clerk.komikone.com)

## First-time setup

### 1. Create the D1 database

```bash
cd worker
npm install
npx wrangler d1 create komikone
```

Copy the `database_id` from the output into `wrangler.toml`.

### 2. Run the schema

```bash
npm run db:migrate:local   # for local dev (schema.sql)
npm run db:migrate:prod    # for production (schema.sql)
```

Apply incremental migrations as needed:

```bash
npx wrangler d1 execute komikone --local --file=./migrations/006_years_members_invites.sql
npx wrangler d1 execute komikone --local --file=./migrations/007_backfill_year_members.sql
npx wrangler d1 execute komikone --local --file=./migrations/009_invite_email_tracking.sql
# Add --remote for production
```

### 3. Set secrets

Local dev: create `worker/.dev.vars` with:

```
ADMIN_SECRET=...
CLERK_SECRET_KEY=sk_test_...   # optional — enables invite-by-email via Clerk
```

Production:

```bash
npx wrangler secret put ADMIN_SECRET
npx wrangler secret put CLERK_JWKS_URL   # Clerk JWKS endpoint for JWT verification
npx wrangler secret put CLERK_SECRET_KEY # optional — Clerk app invitations (no Organizations)
```

Invite emails use Clerk [application invitations](https://clerk.com/docs/reference/backend-api/tag/Invitations#operation/CreateInvitation) (`POST /v1/invitations`). No Organizations setup required. Enable email in the Clerk Dashboard → Emails.

### 4. Start local dev

```bash
# Terminal 1 — Worker
cd worker
npm run dev   # http://localhost:8787

# Terminal 2 — Frontend
cd frontend
npm install
npm run dev   # http://localhost:5173
```

Frontend needs `VITE_CLERK_PUBLISHABLE_KEY` (see `.env.production` for prod key).

### 5. Deploy

```bash
# Worker
cd worker
npm run deploy

# Frontend — push to GitHub (auto-deploys via Vercel)
# VITE_API_URL=https://api.komikone.com
```

## Routes

| URL | Description |
|-----|-------------|
| `/` | Home + instructions |
| `/sign-in` | Clerk sign-in |
| `/join/:code` | Accept invite → join a con year |
| `/dashboard` | Manage group + generate invite links (signed in) |
| `/register/:eventId` | Select badge days (signed in; updates if already linked) |
| `/live/:eventId` | Live purchase board (signed in) |
| `/payment/:eventId` | Payment settlement (signed in) |
| `/profile` | Venmo/PayPal/Zelle info (signed in) |
| `/admin` | Admin panel (Admin role) |

## Two registration paths (both active)

**Everyone needs an invite** to join a year. The homepage invite code box (or link in email) is the entry point.

| Step | What happens |
|------|----------------|
| 1. Invite | `/join/:code` — sign in, confirm identity |
| 2. Days | `/register/:eventId` — pick badge days (members only) |
| 3. Family | `/dashboard` — add people you're buying for |

**Returning members:** use "Already joined? Sign in" on the homepage — no invite code needed again.

**New strangers:** "Request access" on homepage → admin approves in Access Requests → invite link sent.

## Admin workflow per event

1. Go to `/admin` (requires Clerk `publicMetadata.role = admin`)
2. Create a year (+ New Year) or select existing
3. Set badge prices in the Prices tab
4. Change status → `registration`, share registration links from homepage
5. Generate invite codes in Invite Codes tab for new members
6. On purchase day: change status → `purchasing`, share live board link
7. After purchase day: change status → `payment`
8. Export CSV anytime for offline backup
