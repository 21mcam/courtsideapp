-- Migration 032 — platform super-admin console (v1)
--
-- Until now "super admin" meant one shared secret in an
-- X-Super-Admin-Token header, used via curl against two write
-- endpoints. Nothing could LIST tenants or see their state, and
-- nothing was recorded. This migration adds:
--
--   * platform_admins — the platform operator's own login (email +
--     bcrypt password + TOTP secret). Platform-level like `tenants`:
--     NO tenant_id, by design — these people belong to no tenant.
--     Privileged-only: app_runtime has no table grants; every read
--     goes through the SECURITY DEFINER functions below.
--   * platform_audit_log — append-only record of every platform
--     action (logins, failed logins, tenant views, impersonation,
--     billing changes, tenant creation). Also privileged-only.
--   * Cross-tenant read functions (platform_list_tenants,
--     platform_get_tenant). These are the "explicit, audited escape
--     hatches" CLAUDE.md requires for cross-tenant work: each takes
--     the acting platform admin's id, refuses unless that admin is
--     active, and (for per-tenant detail) writes an audit row in the
--     same statement.
--
-- RLS note: the stats loops set app.current_tenant_id per tenant
-- before counting, so the counts are correct whether or not the
-- function owner has BYPASSRLS (it does in Supabase; CI's postgres is
-- a superuser — neither is relied on). Both refuse to run inside an
-- existing tenant context so they can never leave a different
-- tenant's id in a live request's GUC.
--
-- Trust model: same as create_tenant_with_owner (012) and
-- admin_set_platform_billing (025) — app_runtime may EXECUTE, and the
-- app gates the routes. The p_admin_id check is defense in depth plus
-- attribution, not a cryptographic boundary.
--
-- Apply: psql -v ON_ERROR_STOP=1 -f 032_platform_admin.sql
-- Depends on: 002 (tenants), 003 (tenant_admins), 011 (app_runtime),
--             025 (platform billing columns), 029 (business info).
-- After applying: create your login with
--   node scripts/platform/create-admin.js you@example.com "Your Name"
-- and paste the INSERT it prints into the SQL editor.

-- ============================================================
-- 1. platform_admins
-- ============================================================

CREATE TABLE platform_admins (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           text NOT NULL UNIQUE
                  CHECK (
                    email = lower(btrim(email))
                    AND btrim(email) <> ''
                    AND email !~ '\s'
                  ),
  display_name    text NOT NULL
                  CHECK (btrim(display_name) <> '' AND display_name = btrim(display_name)),
  password_hash   text NOT NULL CHECK (btrim(password_hash) <> ''),
  -- RFC 6238 shared secret, base32. Stored in the clear: anyone who
  -- can read this table already holds the database, so encrypting it
  -- here would only move the key next to it.
  totp_secret     text NOT NULL CHECK (totp_secret ~ '^[A-Z2-7]{16,}$'),
  -- Last accepted TOTP time-step. A code is single-use: login refuses
  -- any step <= this, so a shoulder-surfed code can't be replayed
  -- inside its 30-second window.
  totp_last_step  bigint,
  active          boolean NOT NULL DEFAULT true,
  last_login_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER platform_admins_set_updated_at
  BEFORE UPDATE ON platform_admins
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Same posture as tenants (002): RLS on with NO policy = blanket deny
-- for any role without BYPASSRLS, on top of the REVOKE below.
ALTER TABLE platform_admins ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON platform_admins FROM app_runtime;

-- ============================================================
-- 2. platform_audit_log
-- ============================================================

CREATE TABLE platform_audit_log (
  id                 bigserial PRIMARY KEY,
  -- NULL for events with no authenticated admin: failed logins for an
  -- unknown email, and calls made with the legacy
  -- X-Super-Admin-Token header.
  platform_admin_id  uuid REFERENCES platform_admins(id) ON DELETE RESTRICT,
  action             text NOT NULL
                     CHECK (action ~ '^[a-z_]+(\.[a-z_]+)*$'),
  -- Single-column FK (tenants is the root; no composite needed).
  -- SET NULL keeps the audit trail when a tenant is deleted; the
  -- subdomain lives on in `detail`.
  tenant_id          uuid REFERENCES tenants(id) ON DELETE SET NULL,
  detail             jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip                 text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX platform_audit_log_created_idx
  ON platform_audit_log (created_at DESC);
CREATE INDEX platform_audit_log_tenant_idx
  ON platform_audit_log (tenant_id, created_at DESC)
  WHERE tenant_id IS NOT NULL;

ALTER TABLE platform_audit_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON platform_audit_log FROM app_runtime;
REVOKE ALL ON SEQUENCE platform_audit_log_id_seq FROM app_runtime;

-- ============================================================
-- 3. Internal guards (not granted to app_runtime)
-- ============================================================

CREATE OR REPLACE FUNCTION _platform_assert_admin(p_admin_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_admin_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM platform_admins WHERE id = p_admin_id AND active
  ) THEN
    RAISE EXCEPTION 'not an active platform admin'
      USING ERRCODE = '42501';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION _platform_assert_admin(uuid) FROM PUBLIC;

-- Cross-tenant loops set the GUC per tenant. Refuse to start inside a
-- tenant-scoped transaction: the loop would clobber that request's
-- tenant context.
CREATE OR REPLACE FUNCTION _platform_assert_no_tenant_context()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF coalesce(current_setting('app.current_tenant_id', true), '') <> '' THEN
    RAISE EXCEPTION 'platform functions must not run inside a tenant context';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION _platform_assert_no_tenant_context() FROM PUBLIC;

-- ============================================================
-- 4. Auth surface
-- ============================================================

-- Login lookup. Returns the hash + TOTP secret so the app can verify;
-- an inactive admin is returned (active=false) so the app can spend
-- the same bcrypt time before refusing.
CREATE OR REPLACE FUNCTION platform_admin_for_login(p_email text)
RETURNS TABLE (
  id              uuid,
  password_hash   text,
  totp_secret     text,
  totp_last_step  bigint,
  active          boolean
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT a.id, a.password_hash, a.totp_secret, a.totp_last_step, a.active
    FROM platform_admins a
   WHERE a.email = lower(btrim(p_email));
$$;

REVOKE ALL ON FUNCTION platform_admin_for_login(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_admin_for_login(text) TO app_runtime;

-- Consume a TOTP step and record the login. Returns false (and
-- changes nothing) when the step was already used — the replay guard.
-- Row lock makes two concurrent logins with the same code race-safe.
CREATE OR REPLACE FUNCTION platform_admin_record_login(
  p_admin_id uuid,
  p_step     bigint,
  p_ip       text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_last bigint;
BEGIN
  SELECT totp_last_step INTO v_last
    FROM platform_admins
   WHERE id = p_admin_id AND active
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF v_last IS NOT NULL AND p_step <= v_last THEN
    RETURN false;
  END IF;

  UPDATE platform_admins
     SET totp_last_step = p_step,
         last_login_at  = now()
   WHERE id = p_admin_id;

  INSERT INTO platform_audit_log (platform_admin_id, action, ip)
  VALUES (p_admin_id, 'auth.login', p_ip);

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION platform_admin_record_login(uuid, bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_admin_record_login(uuid, bigint, text) TO app_runtime;

-- Per-request session check: the JWT says who; this says they're
-- still allowed (deactivating a row revokes every live session).
CREATE OR REPLACE FUNCTION platform_admin_session(p_admin_id uuid)
RETURNS TABLE (id uuid, email text, display_name text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT a.id, a.email, a.display_name
    FROM platform_admins a
   WHERE a.id = p_admin_id AND a.active;
$$;

REVOKE ALL ON FUNCTION platform_admin_session(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_admin_session(uuid) TO app_runtime;

-- App-level audit events (failed logins, impersonation, tenant
-- creation, billing changes). p_admin_id may be NULL only for events
-- with no authenticated admin; a non-NULL id must be a real admin
-- (the FK enforces it).
CREATE OR REPLACE FUNCTION platform_audit(
  p_admin_id  uuid,
  p_action    text,
  p_tenant_id uuid,
  p_detail    jsonb,
  p_ip        text
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  INSERT INTO platform_audit_log (platform_admin_id, action, tenant_id, detail, ip)
  VALUES (p_admin_id, p_action, p_tenant_id, coalesce(p_detail, '{}'::jsonb), p_ip);
$$;

REVOKE ALL ON FUNCTION platform_audit(uuid, text, uuid, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_audit(uuid, text, uuid, jsonb, text) TO app_runtime;

-- ============================================================
-- 5. Cross-tenant reads
-- ============================================================

-- The console's home screen: one row per tenant with billing state
-- and a few health numbers. Not audited per call (it's the landing
-- page); per-tenant detail is.
CREATE OR REPLACE FUNCTION platform_list_tenants(p_admin_id uuid)
RETURNS TABLE (
  id                       uuid,
  subdomain                text,
  name                     text,
  timezone                 text,
  created_at               timestamptz,
  billing_status           text,
  trial_ends_at            timestamptz,
  has_platform_subscription boolean,
  is_billing_ok            boolean,
  owner_email              text,
  stripe_charges_enabled   boolean,
  member_count             integer,
  active_subscriptions     integer,
  bookings_last_30d        integer,
  upcoming_bookings        integer,
  last_booking_at          timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  t record;
BEGIN
  PERFORM _platform_assert_admin(p_admin_id);
  PERFORM _platform_assert_no_tenant_context();

  FOR t IN
    SELECT tn.*, tl.is_billing_ok AS billing_ok
      FROM tenants tn
      JOIN tenant_lookup tl ON tl.id = tn.id
     ORDER BY tn.created_at
  LOOP
    PERFORM set_config('app.current_tenant_id', t.id::text, true);

    id                        := t.id;
    subdomain                 := t.subdomain;
    name                      := t.name;
    timezone                  := t.timezone;
    created_at                := t.created_at;
    billing_status            := t.platform_subscription_status;
    trial_ends_at             := t.trial_ends_at;
    has_platform_subscription := t.platform_stripe_subscription_id IS NOT NULL;
    is_billing_ok             := t.billing_ok;

    SELECT u.email INTO owner_email
      FROM tenant_admins ta
      JOIN users u ON u.tenant_id = ta.tenant_id AND u.id = ta.user_id
     WHERE ta.tenant_id = t.id
     ORDER BY (ta.role = 'owner') DESC, ta.created_at
     LIMIT 1;

    SELECT sc.charges_enabled INTO stripe_charges_enabled
      FROM stripe_connections sc WHERE sc.tenant_id = t.id;
    IF NOT FOUND THEN
      stripe_charges_enabled := NULL;
    END IF;

    SELECT count(*)::int INTO member_count
      FROM members m WHERE m.tenant_id = t.id;
    SELECT count(*)::int INTO active_subscriptions
      FROM subscriptions s
     WHERE s.tenant_id = t.id AND s.status IN ('active', 'past_due');
    SELECT count(*)::int INTO bookings_last_30d
      FROM bookings b
     WHERE b.tenant_id = t.id
       AND b.created_at >= now() - interval '30 days'
       AND b.status <> 'pending_payment';
    SELECT count(*)::int INTO upcoming_bookings
      FROM bookings b
     WHERE b.tenant_id = t.id
       AND b.start_time >= now()
       AND b.status = 'confirmed';
    SELECT max(b.created_at) INTO last_booking_at
      FROM bookings b WHERE b.tenant_id = t.id;

    RETURN NEXT;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION platform_list_tenants(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_list_tenants(uuid) TO app_runtime;

-- One tenant's full picture for the detail screen, as one jsonb
-- document: profile, billing, Stripe Connect, staff, a "ready to take
-- bookings?" setup checklist, and activity counts. Audited
-- (tenant.view) because it includes staff names + emails.
CREATE OR REPLACE FUNCTION platform_get_tenant(
  p_admin_id  uuid,
  p_tenant_id uuid,
  p_ip        text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  t       tenants%ROWTYPE;
  v_ok    boolean;
  v_doc   jsonb;
BEGIN
  PERFORM _platform_assert_admin(p_admin_id);
  PERFORM _platform_assert_no_tenant_context();

  SELECT * INTO t FROM tenants WHERE id = p_tenant_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT is_billing_ok INTO v_ok FROM tenant_lookup WHERE id = p_tenant_id;

  PERFORM set_config('app.current_tenant_id', t.id::text, true);

  v_doc := jsonb_build_object(
    'tenant', jsonb_build_object(
      'id', t.id,
      'subdomain', t.subdomain,
      'name', t.name,
      'timezone', t.timezone,
      'created_at', t.created_at,
      'reply_to_email', t.reply_to_email,
      'business_phone', t.business_phone,
      'address_street', t.address_street,
      'address_city', t.address_city,
      'address_state', t.address_state,
      'address_zip', t.address_zip,
      'google_rating', t.google_rating,
      'google_review_count', t.google_review_count,
      'ga4_measurement_id', t.ga4_measurement_id,
      'last_weekly_reset_at', t.last_weekly_reset_at
    ),
    'billing', jsonb_build_object(
      'status', t.platform_subscription_status,
      'trial_ends_at', t.trial_ends_at,
      'has_stripe_customer', t.platform_stripe_customer_id IS NOT NULL,
      'has_subscription', t.platform_stripe_subscription_id IS NOT NULL,
      'is_billing_ok', v_ok
    ),
    'stripe_connection', (
      SELECT jsonb_build_object(
        'details_submitted', sc.details_submitted,
        'charges_enabled', sc.charges_enabled,
        'payouts_enabled', sc.payouts_enabled,
        'connected_at', sc.connected_at,
        'fully_onboarded_at', sc.fully_onboarded_at
      )
      FROM stripe_connections sc WHERE sc.tenant_id = t.id
    ),
    'staff', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'first_name', u.first_name,
               'last_name', u.last_name,
               'email', u.email,
               'role', ta.role,
               'has_password', u.password_hash IS NOT NULL,
               'added_at', ta.created_at
             ) ORDER BY (ta.role = 'owner') DESC, ta.created_at)
        FROM tenant_admins ta
        JOIN users u ON u.tenant_id = ta.tenant_id AND u.id = ta.user_id
       WHERE ta.tenant_id = t.id
    ), '[]'::jsonb),
    'setup', jsonb_build_object(
      'resources', (SELECT count(*) FROM resources r
                     WHERE r.tenant_id = t.id AND r.active),
      'offerings', (SELECT count(*) FROM offerings o
                     WHERE o.tenant_id = t.id AND o.active),
      'public_offerings', (SELECT count(*) FROM offerings o
                            WHERE o.tenant_id = t.id AND o.active
                              AND o.allow_public_booking),
      'operating_hours', (SELECT count(*) FROM operating_hours oh
                           WHERE oh.tenant_id = t.id),
      'plans', (SELECT count(*) FROM plans p
                 WHERE p.tenant_id = t.id AND p.active),
      'has_address', t.address_street IS NOT NULL AND t.address_city IS NOT NULL,
      'has_reply_to', t.reply_to_email IS NOT NULL
    ),
    'activity', jsonb_build_object(
      'members', (SELECT count(*) FROM members m WHERE m.tenant_id = t.id),
      'active_subscriptions', (SELECT count(*) FROM subscriptions s
                                WHERE s.tenant_id = t.id
                                  AND s.status IN ('active', 'past_due')),
      'bookings_last_30d', (SELECT count(*) FROM bookings b
                             WHERE b.tenant_id = t.id
                               AND b.created_at >= now() - interval '30 days'
                               AND b.status <> 'pending_payment'),
      'walkin_bookings_last_30d', (SELECT count(*) FROM bookings b
                                    WHERE b.tenant_id = t.id
                                      AND b.member_id IS NULL
                                      AND b.created_at >= now() - interval '30 days'
                                      AND b.status <> 'pending_payment'),
      'upcoming_bookings', (SELECT count(*) FROM bookings b
                             WHERE b.tenant_id = t.id
                               AND b.start_time >= now()
                               AND b.status = 'confirmed'),
      'paid_cents_last_30d', (SELECT coalesce(sum(b.amount_paid_cents - b.amount_refunded_cents), 0)
                               FROM bookings b
                              WHERE b.tenant_id = t.id
                                AND b.created_at >= now() - interval '30 days'),
      'last_booking_at', (SELECT max(b.created_at) FROM bookings b
                           WHERE b.tenant_id = t.id)
    )
  );

  INSERT INTO platform_audit_log (platform_admin_id, action, tenant_id, detail, ip)
  VALUES (p_admin_id, 'tenant.view', t.id,
          jsonb_build_object('subdomain', t.subdomain), p_ip);

  RETURN v_doc;
END;
$$;

REVOKE ALL ON FUNCTION platform_get_tenant(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_get_tenant(uuid, uuid, text) TO app_runtime;

-- The audit log screen (optionally filtered to one tenant). Reading
-- the log is not itself logged — it holds no tenant data beyond what
-- the actions already recorded.
CREATE OR REPLACE FUNCTION platform_list_audit(
  p_admin_id  uuid,
  p_tenant_id uuid DEFAULT NULL,
  p_limit     integer DEFAULT 100
)
RETURNS TABLE (
  id               bigint,
  created_at       timestamptz,
  action           text,
  admin_email      text,
  tenant_id        uuid,
  tenant_subdomain text,
  detail           jsonb,
  ip               text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM _platform_assert_admin(p_admin_id);

  RETURN QUERY
  SELECT l.id, l.created_at, l.action, a.email, l.tenant_id,
         tn.subdomain, l.detail, l.ip
    FROM platform_audit_log l
    LEFT JOIN platform_admins a ON a.id = l.platform_admin_id
    LEFT JOIN tenants tn ON tn.id = l.tenant_id
   WHERE p_tenant_id IS NULL OR l.tenant_id = p_tenant_id
   ORDER BY l.created_at DESC, l.id DESC
   LIMIT least(greatest(coalesce(p_limit, 100), 1), 500);
END;
$$;

REVOKE ALL ON FUNCTION platform_list_audit(uuid, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_list_audit(uuid, uuid, integer) TO app_runtime;

-- ============================================================
-- VERIFICATION (run manually after applying)
-- ============================================================
--
-- 1. Runtime can't touch the tables directly (both must error 42501):
--      SET ROLE app_runtime;
--      SELECT * FROM platform_admins LIMIT 1;
--      SELECT * FROM platform_audit_log LIMIT 1;
--      RESET ROLE;
--
-- 2. Functions refuse an unknown admin (must error
--    'not an active platform admin'):
--      SET ROLE app_runtime;
--      SELECT * FROM platform_list_tenants(gen_random_uuid());
--      RESET ROLE;
--
-- 3. After inserting your admin row (scripts/platform/create-admin.js):
--      SELECT id, email, active FROM platform_admins;
