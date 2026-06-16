# Komikone

Comic-Con badge purchasing coordinator for a group of ~50-80 people.

## Stack
- **Frontend**: React + TypeScript + Tailwind CSS → Vercel (free hobby)
- **Backend**: Cloudflare Workers + Hono → CF free tier
- **Database**: Cloudflare D1 (SQLite) → CF free tier

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
npm run db:migrate:local   # for local dev
npm run db:migrate:prod    # for production
```

### 3. Set your admin secret

In `wrangler.toml` (for local dev) set `ADMIN_SECRET` to something strong.
For production, use a Cloudflare secret:

```bash
npx wrangler secret put ADMIN_SECRET
```

### 4. Start local dev

```bash
# Terminal 1 — Worker
cd worker
npm run dev   # runs on http://localhost:8787

# Terminal 2 — Frontend
cd frontend
npm install
npm run dev   # runs on http://localhost:5173
```

### 5. Deploy

```bash
# Worker
cd worker
npm run deploy

# Frontend — push to GitHub and connect to Vercel.
# Set VITE_API_URL=https://komikone-api.<your-subdomain>.workers.dev
# Also set FRONTEND_URL in wrangler.toml to your Vercel URL, then redeploy worker.
```

## Routes

| URL | Description |
|-----|-------------|
| `/` | Home + instructions |
| `/register/:eventId?token=X` | Participant self-registration |
| `/live/:eventId?token=X` | Live purchase board |
| `/payment/:eventId?token=X` | Payment settlement |
| `/admin` | Admin panel (requires admin secret) |

## Admin workflow per event

1. Go to `/admin`, enter your secret
2. Create event (year, name, reg type)
3. Set badge prices in the Prices tab
4. Change status → `registration`, share the registration link
5. Add/edit participants, assign coordinators in the Participants tab
6. On purchase day: change status → `purchasing`, share the live board link
7. After purchase day: change status → `payment`
8. Export CSV anytime for offline backup
