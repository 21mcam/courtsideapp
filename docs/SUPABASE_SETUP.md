# Supabase setup

End-to-end runbook for spinning up a fresh Supabase project for this
codebase. Takes ~20 minutes; most of it is waiting for the project to
provision.

You'll do this once for the live environment. Doing it again later
(staging, second tenant, recovery from disaster) is the same procedure.

## Prerequisites

- Supabase account (free tier is fine for Phase 0–4)
- `openssl` for password generation (preinstalled on macOS / Linux)
- This repo checked out locally

## 1. Create the Supabase project

1. https://supabase.com/dashboard → **New project**
2. Pick an organization, give the project a name (use `courtside` or
   the chosen real name)
3. Pick a strong DB password — **save it somewhere safe** (this is the
   `postgres` superuser password; you'll rarely use it but you need
   it for emergencies)
4. Pick a region (`us-east-1` etc — closer to your users is faster)
5. Wait ~2 min for provisioning

## 2. Apply migrations 001–011

Open the SQL editor: dashboard → **SQL editor** in the left sidebar.

For each file in `db/migrations/`, in numeric order:

1. Open the migration file in your editor
2. Copy the contents (everything before the `-- VERIFICATION` comment)
3. Paste into Supabase SQL editor → **Run**
4. (Optional but recommended) Uncomment the `VERIFICATION` block at
   the end and run it to confirm structures landed correctly

### 002 specifically: the RLS dialog

When you run `002_tenants_and_users.sql`, Supabase pops a warning:
"New table will not have Row Level Security enabled" for `tenants`.
Click **Run and enable RLS** — this enables RLS with no policy, which
becomes a blanket deny for non-BYPASSRLS roles (defense in depth
against Supabase's default grants on `anon` / `authenticated`). The
migration file in the repo already includes
`ALTER TABLE tenants ENABLE ROW LEVEL SECURITY` so this is
idempotent — clicking the button just makes Supabase happy.

### Other migrations

004–011 won't trigger any warnings — every CREATE TABLE in those
files has matching `ENABLE ROW LEVEL SECURITY` + `FORCE` + a
tenant-isolation policy. Just paste and run.

## 3. Set the runtime role's password

Migration 011 creates the `app_runtime` DB role with `LOGIN` but no
password. Set one:

1. Generate a long random password locally:
   ```bash
   openssl rand -hex 32
   ```
   Copy the output (don't paste it into chat with anyone).

2. In Supabase SQL editor, run (substitute the hex):
   ```sql
   ALTER ROLE app_runtime PASSWORD 'paste-the-hex-here';
   ```

3. Confirm via the verification queries from migration 011 (the
   `SET ROLE app_runtime; SELECT … FROM tenants;` block must error
   with permission denied; the `SELECT … FROM tenant_lookup` block
   must succeed).

## 4. Get the runtime connection string

The free tier doesn't include direct IPv4 — you need the connection
pooler.

1. Dashboard → **Project Settings** → **Database** → **Connection
   pooling**
2. Pick **Transaction pooler** (port 6543). It's IPv4-proxied for
   free and works fine with our `set_config(..., true)` pattern
   since the GUC is transaction-local.
3. Supabase shows you a URI like
   `postgresql://postgres.{ref}:[YOUR-PASSWORD]@aws-X-{region}.pooler.supabase.com:6543/postgres`
4. Build the runtime `DATABASE_URL` from that template, with two
   substitutions:
   - User: replace `postgres.{ref}` with `app_runtime.{ref}`
   - Password: replace `[YOUR-PASSWORD]` (including the brackets)
     with the hex you generated in step 3

Final shape:
```
postgresql://app_runtime.{ref}:HEX_PASSWORD@aws-X-{region}.pooler.supabase.com:6543/postgres
```

Put this in `.env` as `DATABASE_URL=...`. **Never** put it in
`.env.example` (that file is committed).

### Common mistakes (we hit all three of these in Phase 0)

1. **Wrong file.** `.env.example` is the committed template and only
   ever has placeholders. Your real `DATABASE_URL` goes in `.env`,
   which is gitignored.
2. **Square brackets around the password.** Supabase's URI template
   shows `:[YOUR-PASSWORD]@`. The brackets are placeholder syntax,
   NOT URL syntax. Drop them. `:eb1a4279…@` not `:[eb1a4279…]@`. The
   bracket form is for IPv6 hosts and breaks pg's URL parser.
3. **Doubled `DATABASE_URL=` prefix.** If you paste an assignment line
   like `DATABASE_URL=postgres://…` into a file that already has
   `DATABASE_URL=` waiting for a value, you end up with
   `DATABASE_URL=DATABASE_URL=postgres://…`. dotenv parses the second
   `DATABASE_URL=` as part of the value, pg's URL parser then
   fails weirdly (e.g. "ENOTFOUND base", from finding "base" inside
   "data**base**"). One `DATABASE_URL=` only.
4. **Wrong user.** The connection string Supabase shows uses
   `postgres.{ref}` as the user. **Replace it with
   `app_runtime.{ref}`.** Connecting as `postgres` makes the entire
   privilege boundary in migration 011 dead code (postgres has
   BYPASSRLS, owns the tables, can read everything).

## 5. (Optional) Seed a test tenant

For local dev / "Hello, tenant" demos:

```sql
INSERT INTO tenants (
  subdomain,
  name,
  timezone,
  platform_subscription_status,
  trial_ends_at
)
VALUES (
  'momentum',
  'Momentum Sports',
  'America/New_York',
  'trial',
  now() + interval '30 days'
)
ON CONFLICT (subdomain) DO NOTHING;
```

After this, hitting `http://momentum.localhost:5173` in dev (or your
prod equivalent) should render the tenant page.

## 6. Sanity check

From the repo root:

```bash
npm run dev          # backend on :3000
npm test             # smoke test against the live DB
```

`npm test` should report 4 passing assertions. `curl
http://localhost:3000/health` should return `{"ok":true,"db":"ok",...}`.

## When you add a new migration

1. Add `db/migrations/012_*.sql` (next number)
2. Apply it via the SQL editor manually, with verification
3. Commit. CI replays from scratch on every PR — if your new migration
   breaks the chain, CI fails before merge

## Recovery / rebuild

If you ever need to recreate this from scratch (lost project,
disaster, second environment), the only thing that's not in the repo
is the runtime role's password. Generate a fresh one in step 3, set
it via `ALTER ROLE`, update `.env` and any deployed env vars.

The schema and grants are entirely reproducible from
`db/migrations/001` through `011` applied in order.
