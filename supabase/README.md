# Supabase Local Development Setup

This guide explains how to run Supabase locally for development and testing.

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running
- [Supabase CLI](https://supabase.com/docs/guides/cli) installed

### Install Supabase CLI

**macOS:**
```bash
brew install supabase/tap/supabase
```

**Windows:**
```bash
scoop install supabase
```

**Linux:**
```bash
brew install supabase/tap/supabase
```

## Quick Start

### 1. Start Supabase
```bash
npm run supabase:start
```

This will:
- Start Docker containers for Supabase services
- Run all migrations in `supabase/migrations/`
- Seed the database with `supabase/seed.sql`
- Display connection details

**Expected output:**
```
Started supabase local development setup.

         API URL: http://localhost:54321
          DB URL: postgresql://postgres:postgres@localhost:54322/postgres
      Studio URL: http://localhost:54323
    Inbucket URL: http://localhost:54324
        anon key: eyJhbGc...
service_role key: eyJhbGc...
```

### 2. Access Supabase Studio
Open http://localhost:54323 in your browser to:
- View tables and data
- Run SQL queries
- Test RLS policies
- Monitor logs

### 3. Get Connection Details
```bash
npm run supabase:status
```

### 4. Stop Supabase
```bash
npm run supabase:stop
```

## Database Migrations

### Create a New Migration
```bash
npm run supabase:migration:new add_new_feature
```
This creates a new file in `supabase/migrations/` with timestamp.

### Reset Database (Apply All Migrations)
```bash
npm run supabase:db:reset
```
This will:
1. Drop all tables
2. Re-run all migrations
3. Re-seed the database

## Environment Variables for Local Development
Create `.env.local`:
```bash
# Supabase Local
SUPABASE_URL=http://localhost:54321
SUPABASE_SERVICE_KEY=eyJhbGc... # Get from supabase status

# OpenRouter text and vision requests
OPENROUTER_API_KEY=your_openrouter_key

# Telegram
TELEGRAM_BOT_TOKEN=your_bot_token

# API Key for iOS Shortcut
API_KEY=generate_a_secure_random_string
```

## Testing with Local Supabase
1. Start Supabase
```bash
npm run supabase:start
```

2. Update `wrangler.toml` for local dev
```toml
[env.local]
vars = { SUPABASE_URL = "http://localhost:54321" }
```

3. Run Worker Locally
```bash
npm run dev
```

4. Test Transaction Creation
```bash
curl -X POST http://localhost:8787/transaction \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your_api_key" \
  -d '{
    "text": "20000 en almuerzo",
    "source": "manual"
  }'
```

5. Verify in Supabase Studio
- Go to http://localhost:54323
- Navigate to "Table Editor" → "transactions"
- You should see the new transaction

## Common Commands
```bash
# View logs
npm run supabase:status

# Reset and reseed database
npm run supabase:db:reset

# Generate TypeScript types from database
supabase gen types typescript --local > src/types/database.ts

# Push local changes to remote Supabase
supabase db push

# Pull remote changes to local
supabase db pull
```

## Troubleshooting

### Docker not running
```
Error: Cannot connect to the Docker daemon
```
**Solution:** Start Docker Desktop

### Port already in use
```
Error: port 54321 already allocated
```
**Solution:**
```bash
npm run supabase:stop
npm run supabase:start
```

### Database connection refused
**Solution:** Ensure Docker containers are running:
```bash
docker ps | grep supabase
```

## Production Setup
For production, use Supabase Cloud:
1. Create project at https://supabase.com
2. Get connection details from Settings → API
3. Update `wrangler.toml`:
```toml
[vars]
SUPABASE_URL = "https://xxxxx.supabase.co"

# Then set secret:
# wrangler secret put SUPABASE_SERVICE_KEY
```
4. Push migrations:
```bash
supabase link --project-ref your-project-ref
supabase db push
```

For the 2026 web rollout, apply the migrations in timestamp order before deploying the Worker and
web app. Back up the remote database and review the migration list against the linked project
first. Local PGlite checks cover the new RPCs, but a full Supabase migration and RLS pass still
requires the local Docker stack or a disposable Supabase project. `db push` changes the linked
remote database; run it only after the release review is approved.
