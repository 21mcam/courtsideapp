# Migration order

The `db/schema.sql` file is the canonical destination state. To apply
it incrementally to a live Supabase database, split it into ordered
migrations following the layer structure. Each migration applies
cleanly with no forward references (FKs to not-yet-created tables).

This doc is the handoff from chat-driven schema design to Claude Code
implementation. Read CLAUDE.md and PLAN.md first; this file is the
schema-specific addendum.

## Migration files

Each migration is a numbered SQL file in `db/migrations/`. Apply them
in order via the Supabase SQL editor (or psql against the migration
DB role). Migrations are NOT applied automatically by the deploy
pipeline.

### 001_extensions_and_helpers.sql

- `CREATE EXTENSION IF NOT EXISTS pgcrypto`
- `CREATE EXTENSION IF NOT EXISTS btree_gist`
- `set_updated_at()` trigger function
- `category_key` domain

### 002_tenants_and_users.sql

Foundation layer.

- `tenants` table + indexes + trigger
- `tenant_lookup` view (the runtime-safe view; runtime grants are in
  the privilege migration, not here)
- `users` table + trigger + RLS policies

The view definition lives in this migration so any subsequent
migration can rely on it existing. Permissions on it are granted in
the privilege migration.

### 003_roles.sql

- `tenant_admins` table + RLS
- `members` table (including the composite FK on
  `(tenant_id, user_id, email)` to users) + indexes + trigger + RLS

### 004_catalog.sql

- `resources` table + trigger + RLS
- `offerings` table + trigger + RLS
- `offering_resources` table (with `active` flag, timestamps,
  trigger) + RLS

### 005_subscriptions_and_credits.sql

- `plans` table + indexes + trigger + RLS
- `subscriptions` table + indexes + trigger + RLS
- `subscription_plan_periods` (with the GiST exclusion constraint and
  the partial index for current-plan lookups) + trigger + RLS
- `credit_balances` table + trigger + RLS
- `credit_ledger_entries` table — but WITHOUT the `class_booking_id`
  column or the FK to bookings/class_bookings. Those are added in
  later migrations once the referenced tables exist. The
  booking-reason CHECK is named `credit_ledger_entries_booking_ref_check`
  so migration 010 can drop it deterministically.

### 006_operational.sql

- `operating_hours` (with generated `hours_seconds` and exclusion
  constraint) + index + trigger + RLS
- `blackouts` table + indexes + trigger + RLS
- `booking_policies` (singleton-per-tenant) + trigger + RLS

### 007_bookings.sql

- `bookings` table — including:
  - All CHECK constraints (mutual exclusion, payment shape, payment
    status invariants, lifecycle consistency)
  - The composite FKs to offerings, resources, offering_resources,
    members
  - `UNIQUE (tenant_id, id)` and `UNIQUE (tenant_id, id, member_id)`
  - The partial GiST exclusion constraint
- All indexes (stripe PI unique, member, resource, status, hold expiry)
- `bookings_set_updated_at` trigger
- RLS enable + force + policy
- `enforce_booking_validity()` trigger function
- `bookings_enforce_validity` trigger
- The ledger FK addition: `ALTER TABLE credit_ledger_entries ADD
  CONSTRAINT credit_ledger_entries_booking_id_fkey ...`

### 008_classes.sql

- `class_schedules` table — includes `UNIQUE (tenant_id, id,
  offering_id)` so the class_instances composite FK can prevent
  offering drift (an instance's offering must match its schedule's).
  set_updated_at trigger + RLS.
- `enforce_class_schedule_validity()` trigger function + trigger —
  rejects schedules whose offering is inactive, has capacity = 1
  (rentals), whose resource is inactive, or whose offering_resources
  link is inactive.
- `class_instances` table — including the composite FK
  `(tenant_id, class_schedule_id, offering_id) REFERENCES
  class_schedules(tenant_id, id, offering_id)` that prevents offering
  drift between a schedule and its instances (resource can be
  overridden per instance, offering cannot). Indexes (incl. the
  partial generation-uniqueness index) + set_updated_at trigger +
  RLS + the partial GiST exclusion on resource time_range.
- `enforce_class_instance_validity()` trigger function + trigger.
- `enforce_no_class_overlap_on_booking()` trigger function + trigger
  on bookings (added now since both tables exist).
- `enforce_no_booking_overlap_on_class_instance()` trigger function +
  trigger on class_instances.
- `class_bookings` table + indexes + set_updated_at trigger + RLS +
  all CHECKs.
- `enforce_class_capacity()` trigger function + trigger
  (`BEFORE INSERT OR UPDATE OF status` — class_instance_id is
  immutable, see below, so the capacity check doesn't need to fire
  on instance change).
- `enforce_class_booking_validity()` trigger function + trigger —
  rejects bookings on cancelled instances, deactivated offerings,
  audience-flag mismatches (member vs customer), inactive resource
  / offering_resources link, and pending_payment holds whose
  hold_expires_at outlasts the instance's start_time.
- `prevent_class_instance_id_change()` trigger function +
  `class_bookings_immutable_instance` trigger — class_instance_id
  is immutable after insert; "move this person to a different class"
  is cancel-and-rebook, never UPDATE.

### 009_stripe_connections.sql

- `stripe_connections` table + trigger + RLS

### 010_finalize_credit_ledger.sql

- `ALTER TABLE credit_ledger_entries ADD COLUMN class_booking_id uuid`
- The composite FK to `class_bookings`
- Drop the old single-booking-id CHECK by its explicit name:
  `ALTER TABLE credit_ledger_entries DROP CONSTRAINT
  credit_ledger_entries_booking_ref_check;`
- Add the new CHECKs (with explicit names):
  - `credit_ledger_entries_booking_ref_check` —
    `((reason IN ('booking_spend', 'booking_refund')) =
    ((booking_id IS NOT NULL) OR (class_booking_id IS NOT NULL)))`
  - `credit_ledger_entries_no_double_booking_ref` —
    `(NOT (booking_id IS NOT NULL AND class_booking_id IS NOT NULL))`

### 011_privileges.sql

Phase 0 privilege configuration. Run AFTER all schema migrations are
applied successfully.

- Create the `app_runtime` DB role (or whatever name the runtime
  user connects as). NOT a superuser. NO BYPASSRLS. NOT an owner of
  any tables.
- `GRANT USAGE ON SCHEMA public TO app_runtime`.
- `GRANT SELECT ON tenant_lookup TO app_runtime`.
- `REVOKE ALL ON tenants FROM app_runtime`.
- `GRANT SELECT, INSERT, UPDATE, DELETE` on all other tables to
  `app_runtime`. (Specific revocations on credit_balances and
  credit_ledger_entries come in the Phase 2 migration.)
- `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO
  app_runtime` — required for INSERT into the bigserial
  `credit_ledger_entries.entry_number` (and any future serial
  columns). Without it, INSERTs that touch a sequence fail with
  "permission denied for sequence …".
- Smoke test query #1 (run as app_runtime, MUST raise
  permission-denied):
  ```sql
  SELECT platform_stripe_customer_id FROM tenants LIMIT 1;
  ```
  If it succeeds, the privilege setup is broken.
- Smoke test query #2 (run as app_runtime, MUST succeed):
  ```sql
  SELECT id, subdomain, name, timezone, is_billing_ok
  FROM tenant_lookup LIMIT 1;
  ```
  If it errors, the view grant is broken.

## Application of migrations

For each migration file:

1. Read the file end-to-end before applying.
2. Apply via Supabase SQL editor as the `postgres` role (which has
   BYPASSRLS and full DDL privileges).
3. Verify with the queries listed in the file's verification block
   (e.g. counts of expected tables, presence of triggers, exclusion
   constraint behavior with a deliberate-conflict test).
4. Commit the migration file to the repo with the verification
   results in the PR description.
5. Move to the next migration only after the current one is verified
   on the live DB.

## Phase deliverables that aren't migrations

Some pieces in the schema's TODO block are application code or
out-of-band ops, not SQL migrations. Listed here for completeness:

### Phase 0

- `tenant_lookup` privilege smoke test as a CI step (re-run on every
  PR and deploy; fails loud if runtime can read billing fields, or
  if SELECT on `tenant_lookup` fails). Runs against a disposable
  Postgres service container in CI by replaying migrations 001–011
  with `psql -v ON_ERROR_STOP=1 -f ...`. Supabase verification stays
  manual after each migration is applied to the live DB, since
  managed-Postgres role/extension/RLS behavior can differ subtly.
- The `withTenantContext` middleware that wraps every tenant-scoped
  request — including login and register, not just authenticated
  ones — in a transaction with `SELECT
  set_config('app.current_tenant_id', $1, true)`. The `true`
  argument scopes the GUC to the transaction so it can't leak across
  pooled connections.
- Stripe webhook route mounted BEFORE the subdomain-resolving tenant
  middleware (and BEFORE `express.json()`, with
  `express.raw({ type: 'application/json' })` for signature
  verification). The handler resolves the tenant explicitly from
  Stripe metadata / customer / account ID, then sets the GUC and
  runs DB work inside its own transaction. Subdomain-based tenant
  resolution doesn't apply — webhooks come from `api.stripe.com`,
  not a tenant hostname.

### Phase 2

- `apply_credit_change(...)` SECURITY DEFINER function. Lives in a
  migration, but it's a Phase 2 deliverable because it requires the
  privilege revocation to be in place first.
- Revocations on `credit_balances` and `credit_ledger_entries` for
  the runtime role.
- More granular RLS policies (member-self-read, admin-tenant-read).

### Phase 3

- Hold-expiry janitor (sweeps both bookings and class_bookings).
  Runs on a schedule (pg_cron or external cron-via-API).

### Phase 4

- Class instance horizon extender for open-ended schedules.

### Phase 5

- Stripe `incomplete` subscription janitor (24h sweeper).

## Notes on dropping/altering CHECKs

Postgres auto-names CHECK constraints if no name is provided. The
schema now follows a convention: any CHECK that a future migration
might need to drop or replace gets an explicit name. The
`credit_ledger_entries_booking_ref_check` is the one current example
(named at creation in migration 005, dropped/replaced in migration
010).

Other CHECKs in the schema are anonymous because no migration touches
them. If a future migration needs to alter one, prefer naming the
CHECK in the original definition rather than discovering it via
`pg_constraint` — discovery is fragile across Postgres versions.

```sql
-- to discover an anonymous CHECK if you must:
SELECT conname FROM pg_constraint
WHERE conrelid = 'some_table'::regclass
  AND contype = 'c';
-- but prefer explicit naming up front.
```

## Schema invariants worth verifying after each migration

- Every tenant-scoped table has both `ENABLE ROW LEVEL SECURITY` and
  `FORCE ROW LEVEL SECURITY`. Query:
  ```sql
  SELECT schemaname, tablename, rowsecurity, forcerowsecurity
  FROM pg_tables
  WHERE schemaname = 'public' AND tablename NOT IN ('tenants');
  ```
- Every tenant-scoped table has a `tenant_isolation` policy. Query:
  ```sql
  SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'public';
  ```
- Every mutable table (anything with `updated_at`) has a
  `*_set_updated_at` trigger. Query:
  ```sql
  SELECT event_object_table, trigger_name FROM information_schema.triggers
  WHERE trigger_name LIKE '%set_updated_at';
  ```

If any of those drift from the expected count, fix immediately —
those are load-bearing invariants.
