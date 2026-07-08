-- Migration 018 — RLS + API lockdown for stripe_webhook_events
--
-- Migration 016 created stripe_webhook_events WITHOUT RLS, by design:
-- the runtime writes a dedup row BEFORE it knows which tenant an
-- event belongs to, so there is no tenant_id to isolate on. See the
-- header of 016_stripe_webhook_events.sql.
--
-- However, Supabase auto-exposes every table in `public` through its
-- PostgREST data API (the `anon` / `authenticated` roles). A table
-- with no RLS and no revoke is reachable there. The concrete risk is
-- not a data leak (the rows are just event ids + types) but WRITE
-- poisoning: an attacker who can INSERT arbitrary event_ids could
-- pre-seed the dedup log so the app skips the matching REAL Stripe
-- deliveries — silently dropping webhooks (e.g. missed weekly credit
-- grants on invoice.payment_succeeded).
--
-- This migration closes that exposure two ways (belt and suspenders):
--   1. REVOKE all access from the PostgREST roles, so the auto-API
--      cannot touch the table regardless of RLS.
--   2. ENABLE RLS with a permissive policy scoped to `app_runtime`
--      (the only role the backend connects as). With RLS enabled and
--      the policy targeting `app_runtime` only, no other role can
--      read or write even if it somehow held a grant.
--
-- The app connects as `app_runtime` (non-owner, no BYPASSRLS), so the
-- policy is what keeps it working — enabling RLS without a policy
-- would deny the runtime all access. `app_runtime` already holds CRUD
-- via the ALTER DEFAULT PRIVILEGES set up in migration 011.
--
-- Apply: psql -v ON_ERROR_STOP=1 -f 018_stripe_webhook_events_rls.sql
-- Depends on: 016 (table exists), 011 (app_runtime role + grants).

ALTER TABLE stripe_webhook_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON stripe_webhook_events FROM anon, authenticated;

CREATE POLICY stripe_webhook_events_runtime_all ON stripe_webhook_events
  FOR ALL TO app_runtime
  USING (true)
  WITH CHECK (true);

-- Verify (commented for live apply):
--
--   -- 1. RLS is on:
--   SELECT rowsecurity FROM pg_tables
--    WHERE schemaname = 'public' AND tablename = 'stripe_webhook_events';
--   -- expect: t
--
--   -- 2. The app role can still write (the load-bearing check):
--   SELECT has_table_privilege('app_runtime','stripe_webhook_events','INSERT');
--   -- expect: t
--
--   -- 3. The PostgREST roles cannot:
--   SELECT has_table_privilege('anon','stripe_webhook_events','SELECT'),
--          has_table_privilege('authenticated','stripe_webhook_events','INSERT');
--   -- expect: f, f
--
--   -- 4. End-to-end dedup still works as app_runtime:
--   SET ROLE app_runtime;
--   INSERT INTO stripe_webhook_events (event_id, event_type) VALUES ('evt_test_018', 'foo');
--   INSERT INTO stripe_webhook_events (event_id, event_type) VALUES ('evt_test_018', 'foo')
--     ON CONFLICT DO NOTHING RETURNING event_id;   -- expect: 0 rows
--   DELETE FROM stripe_webhook_events WHERE event_id = 'evt_test_018';
--   RESET ROLE;
