-- Migration 025 — platform billing (tenants paying Courtside via Stripe)
--
-- The tenants table has carried platform_stripe_customer_id,
-- platform_stripe_subscription_id, platform_subscription_status, and
-- trial_ends_at since migration 002 — but nothing ever wrote them.
-- This migration adds the write paths:
--
--   * create_tenant_with_owner gains p_trial_ends_at so new tenants
--     start a real trial clock (existing tenants keep NULL = never
--     expires, which deliberately grandfathers pre-billing tenants).
--   * GUC-guarded reader/writers for the tenant-admin billing flow
--     (get_platform_billing, set_platform_customer,
--     set_platform_subscription) — app_runtime has REVOKE ALL on
--     tenants (migration 011), so all access goes through SECURITY
--     DEFINER functions, same pattern as set_tenant_theme (019).
--   * lookup_tenant_by_platform_customer for the platform Stripe
--     webhook to bootstrap tenant context from a customer id, same
--     pattern as lookup_tenant_by_stripe_account (015).
--   * admin_set_platform_billing for the super-admin escape hatch
--     (comp a tenant, extend a trial). No GUC guard — reachable only
--     through X-Super-Admin-Token routes, same trust model as
--     create_tenant_with_owner (012).
--   * tenant_lookup.is_billing_ok now treats past_due as OK. Stripe
--     Smart Retries usually recover a failed card within days;
--     bricking a facility's whole booking system the moment one
--     charge fails would punish their members, not them. Hard
--     lockout waits for cancelled/suspended or trial expiry.

-- ------------------------------------------------------------
-- 1. create_tenant_with_owner: add trial_ends_at.
--
-- Postgres would happily keep the old 7-arg overload alongside an
-- 8-arg version with a DEFAULT, making 7-arg calls ambiguous — so
-- drop the old signature first.
-- ------------------------------------------------------------

DROP FUNCTION IF EXISTS create_tenant_with_owner(
  text, text, text, text, text, text, text
);

CREATE OR REPLACE FUNCTION create_tenant_with_owner(
  p_subdomain           text,
  p_name                text,
  p_timezone            text,
  p_owner_email         text,
  p_owner_password_hash text,
  p_owner_first_name    text,
  p_owner_last_name     text,
  p_trial_ends_at       timestamptz DEFAULT NULL
)
RETURNS TABLE (tenant_id uuid, user_id uuid, admin_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tenant_id uuid;
  v_user_id   uuid;
  v_admin_id  uuid;
BEGIN
  INSERT INTO tenants (subdomain, name, timezone, trial_ends_at)
  VALUES (p_subdomain, p_name, p_timezone, p_trial_ends_at)
  RETURNING id INTO v_tenant_id;

  -- Set the GUC so subsequent inserts pass FORCE RLS even if the
  -- function owner doesn't have BYPASSRLS. Belt and suspenders —
  -- in practice the migration role does have BYPASSRLS in Supabase,
  -- but we don't want this function's correctness to depend on that.
  PERFORM set_config('app.current_tenant_id', v_tenant_id::text, true);

  INSERT INTO users (
    tenant_id, email, password_hash, first_name, last_name
  )
  VALUES (
    v_tenant_id, p_owner_email, p_owner_password_hash,
    p_owner_first_name, p_owner_last_name
  )
  RETURNING id INTO v_user_id;

  INSERT INTO tenant_admins (tenant_id, user_id, role)
  VALUES (v_tenant_id, v_user_id, 'owner')
  RETURNING id INTO v_admin_id;

  -- Default booking_policies singleton. Tenants edit these via the
  -- admin UI (Phase 2+). Defaults from the schema's CHECK clauses
  -- give sensible starting values.
  INSERT INTO booking_policies (tenant_id) VALUES (v_tenant_id);

  RETURN QUERY SELECT v_tenant_id, v_user_id, v_admin_id;
END;
$$;

REVOKE ALL ON FUNCTION create_tenant_with_owner(
  text, text, text, text, text, text, text, timestamptz
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION create_tenant_with_owner(
  text, text, text, text, text, text, text, timestamptz
) TO app_runtime;

-- ------------------------------------------------------------
-- 2. get_platform_billing — the tenant admin's read surface.
--
-- GUC-guarded: even a privileged caller only sees the tenant in the
-- request's own context. Exposes the platform Stripe customer id
-- (needed to reuse the customer across checkouts and open the
-- billing portal) but never the subscription id — routes don't need
-- it, so it stays privileged-only.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION get_platform_billing(p_tenant_id uuid)
RETURNS TABLE (
  status             text,
  trial_ends_at      timestamptz,
  stripe_customer_id text,
  has_subscription   boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_tenant_id IS DISTINCT FROM current_setting('app.current_tenant_id', true)::uuid THEN
    RAISE EXCEPTION 'tenant mismatch';
  END IF;

  RETURN QUERY
  SELECT
    t.platform_subscription_status,
    t.trial_ends_at,
    t.platform_stripe_customer_id,
    (t.platform_stripe_subscription_id IS NOT NULL)
  FROM tenants t
  WHERE t.id = p_tenant_id;
END;
$$;

REVOKE ALL ON FUNCTION get_platform_billing(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_platform_billing(uuid) TO app_runtime;

-- ------------------------------------------------------------
-- 3. set_platform_customer — record the Stripe customer created for
-- this tenant. Write-once: refuses to overwrite a different existing
-- id (the partial unique index would catch cross-tenant duplicates;
-- this guard catches same-tenant clobbering, which would orphan the
-- subscription hanging off the old customer).
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION set_platform_customer(
  p_tenant_id   uuid,
  p_customer_id text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing text;
BEGIN
  IF p_tenant_id IS DISTINCT FROM current_setting('app.current_tenant_id', true)::uuid THEN
    RAISE EXCEPTION 'tenant mismatch';
  END IF;
  IF p_customer_id IS NULL OR btrim(p_customer_id) = '' THEN
    RAISE EXCEPTION 'customer id required';
  END IF;

  SELECT platform_stripe_customer_id INTO v_existing
    FROM tenants WHERE id = p_tenant_id
    FOR UPDATE;

  IF v_existing IS NOT NULL AND v_existing <> p_customer_id THEN
    RAISE EXCEPTION 'platform customer already set';
  END IF;

  UPDATE tenants
     SET platform_stripe_customer_id = p_customer_id
   WHERE id = p_tenant_id;
END;
$$;

REVOKE ALL ON FUNCTION set_platform_customer(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_platform_customer(uuid, text) TO app_runtime;

-- ------------------------------------------------------------
-- 4. set_platform_subscription — the platform webhook's write path.
-- GUC-guarded like the rest; the webhook resolves the tenant first
-- (lookup below), sets the GUC inside its transaction, then calls
-- this. Status goes through the tenants CHECK constraint, so an
-- unexpected value fails loudly rather than writing garbage.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION set_platform_subscription(
  p_tenant_id       uuid,
  p_subscription_id text,
  p_status          text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_tenant_id IS DISTINCT FROM current_setting('app.current_tenant_id', true)::uuid THEN
    RAISE EXCEPTION 'tenant mismatch';
  END IF;

  UPDATE tenants
     SET platform_stripe_subscription_id = p_subscription_id,
         platform_subscription_status    = p_status
   WHERE id = p_tenant_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant not found';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION set_platform_subscription(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_platform_subscription(uuid, text, text) TO app_runtime;

-- ------------------------------------------------------------
-- 5. lookup_tenant_by_platform_customer — webhook bootstrap.
-- Mirrors lookup_tenant_by_stripe_account (015): platform webhook
-- events arrive with no tenant context; this maps Stripe customer id
-- → tenant id so the handler can set the GUC. Returns NULL for
-- unknown customers (caller logs + ignores).
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION lookup_tenant_by_platform_customer(p_customer_id text)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT id FROM tenants WHERE platform_stripe_customer_id = p_customer_id;
$$;

REVOKE ALL ON FUNCTION lookup_tenant_by_platform_customer(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lookup_tenant_by_platform_customer(text) TO app_runtime;

-- ------------------------------------------------------------
-- 6. admin_set_platform_billing — super-admin escape hatch.
-- Comp a tenant (status 'trial' + clear trial end = free forever),
-- extend a trial, or suspend. p_status NULL = leave unchanged.
-- p_clear_trial true = trial_ends_at := NULL; otherwise
-- p_trial_ends_at NULL = leave unchanged.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION admin_set_platform_billing(
  p_tenant_id     uuid,
  p_status        text DEFAULT NULL,
  p_trial_ends_at timestamptz DEFAULT NULL,
  p_clear_trial   boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE tenants
     SET platform_subscription_status =
           COALESCE(p_status, platform_subscription_status),
         trial_ends_at = CASE
           WHEN p_clear_trial THEN NULL
           ELSE COALESCE(p_trial_ends_at, trial_ends_at)
         END
   WHERE id = p_tenant_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant not found';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION admin_set_platform_billing(uuid, text, timestamptz, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_set_platform_billing(uuid, text, timestamptz, boolean) TO app_runtime;

-- ------------------------------------------------------------
-- 7. tenant_lookup: past_due keeps access (grace while Stripe
-- retries). Same columns, so CREATE OR REPLACE preserves grants.
-- ------------------------------------------------------------

CREATE OR REPLACE VIEW tenant_lookup AS
SELECT
  id,
  subdomain,
  name,
  timezone,
  (
    platform_subscription_status IN ('active', 'past_due')
    OR (
      platform_subscription_status = 'trial'
      AND (trial_ends_at IS NULL OR trial_ends_at > now())
    )
  ) AS is_billing_ok,
  theme_accent,
  reply_to_email
FROM tenants;

COMMENT ON VIEW tenant_lookup IS
  'Safe subdomain-resolution view. Exposes routing-safe columns only; '
  'never billing fields. Runtime role gets SELECT here, not on tenants.';

-- ============================================================
-- VERIFICATION (run manually after applying)
-- ============================================================
--
-- 1. All six functions exist with SECURITY DEFINER:
--      SELECT proname, prosecdef FROM pg_proc
--       WHERE proname IN ('create_tenant_with_owner','get_platform_billing',
--                         'set_platform_customer','set_platform_subscription',
--                         'lookup_tenant_by_platform_customer',
--                         'admin_set_platform_billing');
--      -- expected: 6 rows, prosecdef = t
--
-- 2. Only the 8-arg create_tenant_with_owner remains:
--      SELECT pronargs FROM pg_proc WHERE proname = 'create_tenant_with_owner';
--      -- expected: one row, pronargs = 8
--
-- 3. past_due tenants still resolve:
--      SELECT is_billing_ok FROM tenant_lookup WHERE subdomain = '<any>';
--      -- after: UPDATE tenants SET platform_subscription_status='past_due' ...
