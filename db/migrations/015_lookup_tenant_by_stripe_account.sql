-- Migration 015 — lookup_tenant_by_stripe_account SECURITY DEFINER
--
-- Stripe webhooks POST from api.stripe.com, not from a tenant
-- subdomain. The webhook handler can't use the resolveTenant /
-- withTenantContext middleware sandwich; it has to bootstrap tenant
-- context from the event payload (event.account is the connected
-- Stripe account id).
--
-- stripe_connections has FORCE ROW LEVEL SECURITY, so the runtime
-- role can't read it without the GUC already set. This is the
-- chicken-and-egg the webhook has to break.
--
-- Pattern matches apply_credit_change (migration 014):
--   * SECURITY DEFINER, owned by the migration role (postgres /
--     supabase admin), which bypasses FORCE RLS.
--   * Returns ONLY the tenant_id — no other columns leak. Caller
--     uses that to set the GUC and proceed normally with RLS in
--     effect.
--   * EXECUTE granted only to app_runtime, not PUBLIC.
--   * STABLE so the planner knows it's read-only.
--
-- Apply: psql -v ON_ERROR_STOP=1 -f 015_lookup_tenant_by_stripe_account.sql
-- Depends on: 009 (stripe_connections), 011 (app_runtime role).

CREATE OR REPLACE FUNCTION lookup_tenant_by_stripe_account(p_account_id text)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
  SELECT tenant_id
    FROM stripe_connections
   WHERE stripe_account_id = p_account_id
   LIMIT 1;
$$;

REVOKE ALL ON FUNCTION lookup_tenant_by_stripe_account(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lookup_tenant_by_stripe_account(text) TO app_runtime;

COMMENT ON FUNCTION lookup_tenant_by_stripe_account(text) IS
  'Stripe-webhook tenant resolution. Bypasses RLS via SECURITY DEFINER '
  'because the webhook has no GUC set yet. Returns only the tenant_id; '
  'caller sets app.current_tenant_id and proceeds with RLS in effect.';

-- Verify (commented for live apply):
--
--   SELECT lookup_tenant_by_stripe_account('acct_does_not_exist');
--   -- expect: NULL
--
--   INSERT INTO tenants (subdomain, name, timezone)
--     VALUES ('migration015-test', 'Test', 'UTC');
--   INSERT INTO stripe_connections (tenant_id, stripe_account_id)
--     SELECT id, 'acct_test_15' FROM tenants WHERE subdomain = 'migration015-test';
--   SELECT lookup_tenant_by_stripe_account('acct_test_15');
--   -- expect: tenant_id from above
--   DELETE FROM tenants WHERE subdomain = 'migration015-test';
