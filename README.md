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
# Add --remote for production
```

### 3. Set secrets

Local dev: create `worker/.dev.vars` with `ADMIN_SECRET=...`

Production:

```bash
npx wrangler secret put ADMIN_SECRET
npx wrangler secret put CLERK_JWKS_URL   # Clerk JWKS endpoint for JWT verification
```

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
| `/admin` | Admin panel (Clerk admin role) |

## Two registration paths (both active)

**Legacy / in-flight (2026):** Participants use the homepage **Register** link → `/register/:eventId` to pick badge days. Works for anyone signed in with Clerk.

**Invite flow (new members):** Admin or member generates invite → `/join/:code` → identity setup → `/register/:eventId` for badge days → `/dashboard` for group management.

Homepage **Request an Invite** still collects email requests for admin review.

## Admin workflow per event

1. Go to `/admin` (requires Clerk `publicMetadata.role = admin`)
2. Create a year (+ New Year) or select existing
3. Set badge prices in the Prices tab
4. Change status → `registration`, share registration links from homepage
5. Generate invite codes in Invite Codes tab for new members
6. On purchase day: change status → `purchasing`, share live board link
7. After purchase day: change status → `payment`
8. Export CSV anytime for offline backup
