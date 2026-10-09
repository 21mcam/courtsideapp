-- Migration 035 — tenant visibility (private / unlisted / public)
--
-- A facility being set up (Momentum before its cutover) must not show
-- up in Google or take bookings from anyone who stumbles on the URL,
-- while its staff configure it. tenants.visibility:
--
--   private   noindex everywhere; visitors get a "coming soon" page;
--             public bookings + member self-signup refused. Staff can
--             sign in and preview the public pages (banner).
--   unlisted  works normally, but noindex (demos, soft launches).
--   public    normal, indexable.
--
-- Existing tenants become 'unlisted' (keeps the Sunset Park demo
-- working, keeps everything out of search); facilities created through
-- the platform (console "New facility" / signup API) start 'private' —
-- a facility goes public when the platform operator says so. Set from
-- the platform console via platform_set_visibility().
--
-- Apply: psql -v ON_ERROR_STOP=1 -f 035_tenant_visibility.sql
-- Depends on: 002 (tenants), 029 (tenant_lookup current column list),
--             032 (platform admin helpers + audit log).

-- Column default 'unlisted': existing rows, the demo seed and test
-- fixtures (raw INSERTs) stay open but unindexed. Facilities created
-- through the platform start 'private' — create_tenant_with_owner below.
ALTER TABLE tenants
  ADD COLUMN visibility text NOT NULL DEFAULT 'unlisted'
    CONSTRAINT tenants_visibility_valid
    CHECK (visibility IN ('private', 'unlisted', 'public'));

-- Same signature/body as 025, plus visibility = 'private' on insert.
-- (CREATE OR REPLACE keeps 025's grants.)
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
  -- Facilities created through the platform (console / API) start
  -- PRIVATE (migration 035): set up quietly, go public when ready.
  INSERT INTO tenants (subdomain, name, timezone, trial_ends_at, visibility)
  VALUES (p_subdomain, p_name, p_timezone, p_trial_ends_at, 'private')
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

COMMENT ON COLUMN tenants.visibility IS
  'private = noindex + coming-soon page + public booking/signup refused; '
  'unlisted = open but noindex; public = normal. Platform console only.';

-- tenant_lookup: same columns as 029, visibility appended (CREATE OR
-- REPLACE VIEW can only append).
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
  reply_to_email,
  address_street,
  address_city,
  address_state,
  address_zip,
  business_phone,
  google_rating,
  google_review_count,
  google_reviews_url,
  ga4_measurement_id,
  visibility
FROM tenants;

-- Platform console setter: active platform admin only, audited in the
-- same statement (same pattern as platform_get_tenant, migration 032).
CREATE OR REPLACE FUNCTION platform_set_visibility(
  p_admin_id   uuid,
  p_tenant_id  uuid,
  p_visibility text,
  p_ip         text DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_old text;
  v_sub text;
BEGIN
  PERFORM _platform_assert_admin(p_admin_id);

  SELECT visibility, subdomain INTO v_old, v_sub
    FROM tenants WHERE id = p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant not found';
  END IF;

  UPDATE tenants SET visibility = p_visibility WHERE id = p_tenant_id;

  INSERT INTO platform_audit_log (platform_admin_id, action, tenant_id, detail, ip)
  VALUES (p_admin_id, 'tenant.visibility_update', p_tenant_id,
          jsonb_build_object('subdomain', v_sub, 'from', v_old, 'to', p_visibility),
          p_ip);

  RETURN p_visibility;
END;
$$;

REVOKE ALL ON FUNCTION platform_set_visibility(uuid, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_set_visibility(uuid, uuid, text, text) TO app_runtime;

-- platform_list_tenants / platform_get_tenant read `tenants` directly,
-- so visibility needs adding to their outputs — done app-side by a
-- separate lookup (tenant_lookup carries it) to avoid redefining those
-- functions' RETURNS TABLE here.

-- Verify (commented for live apply):
--   SELECT subdomain, visibility FROM tenant_lookup;
--   -- expect: every existing tenant 'unlisted'
--   SELECT prosrc LIKE '%''private''%' FROM pg_proc
--    WHERE proname = 'create_tenant_with_owner';
--   -- expect: t
