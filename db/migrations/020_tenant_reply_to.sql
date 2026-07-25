-- Migration 020 — tenant reply-to email (transactional email support)
--
-- System emails (booking confirmations, cancellations, password
-- resets, welcomes) are sent via Resend from a platform-owned "from"
-- address (CLAUDE.md: per-tenant custom domains are post-v1). Each
-- tenant can set a reply-to address so member replies land in the
-- facility's inbox instead of the platform's.
--
-- Follows the migration-019 pattern exactly:
--   * nullable column on the tenants root table (NULL = no reply-to,
--     emails go out without one)
--   * exposed through tenant_lookup (the runtime role's only read
--     path to tenants — resolveTenant does SELECT * so the new
--     column flows onto req.tenant with no app change)
--   * written through a SECURITY DEFINER function (app_runtime has
--     no UPDATE on tenants), guarded by the tenant GUC
--
-- Apply: psql -v ON_ERROR_STOP=1 -f 020_tenant_reply_to.sql
-- Depends on: 002 (tenants, tenant_lookup), 011 (app_runtime role),
--             019 (tenant_lookup column order — CREATE OR REPLACE
--             VIEW can only append columns).

ALTER TABLE tenants
  ADD COLUMN reply_to_email text
  CONSTRAINT tenants_reply_to_email_check CHECK (
    reply_to_email IS NULL
    OR (
      -- Same normalize-on-write convention as users.email (002):
      -- lowercase, trimmed, no whitespace.
      reply_to_email = lower(btrim(reply_to_email))
      AND btrim(reply_to_email) <> ''
      AND reply_to_email !~ '\s'
    )
  );

COMMENT ON COLUMN tenants.reply_to_email IS
  'Reply-to address for tenant transactional emails (Resend). NULL = '
  'no reply-to header. From address stays platform-owned until '
  'per-tenant custom domains land (post-v1).';

-- CREATE OR REPLACE VIEW can append columns; existing grants survive.
CREATE OR REPLACE VIEW tenant_lookup AS
SELECT
  id,
  subdomain,
  name,
  timezone,
  (
    platform_subscription_status = 'active'
    OR (
      platform_subscription_status = 'trial'
      AND (trial_ends_at IS NULL OR trial_ends_at > now())
    )
  ) AS is_billing_ok,
  theme_accent,
  reply_to_email
FROM tenants;

CREATE OR REPLACE FUNCTION set_tenant_reply_to(p_tenant_id uuid, p_email text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Same cross-tenant guard as apply_credit_change (migration 014)
  -- and set_tenant_theme (019): even a privileged caller can only
  -- touch the tenant in the GUC.
  IF p_tenant_id IS DISTINCT FROM current_setting('app.current_tenant_id', true)::uuid THEN
    RAISE EXCEPTION 'tenant mismatch';
  END IF;

  UPDATE tenants SET reply_to_email = p_email WHERE id = p_tenant_id;
  -- Malformed addresses are rejected by tenants_reply_to_email_check.
END;
$$;

REVOKE ALL ON FUNCTION set_tenant_reply_to(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_tenant_reply_to(uuid, text) TO app_runtime;

COMMENT ON FUNCTION set_tenant_reply_to(uuid, text) IS
  'Admin settings: update the tenant''s transactional-email reply-to '
  'address (NULL clears it). SECURITY DEFINER because app_runtime has '
  'no UPDATE on tenants; guarded by the app.current_tenant_id GUC.';

-- Verify (commented for live apply):
--
--   SELECT reply_to_email FROM tenant_lookup LIMIT 1;
--   -- expect: NULL
--
--   BEGIN;
--   SELECT set_config('app.current_tenant_id',
--     (SELECT id::text FROM tenants LIMIT 1), true);
--   SELECT set_tenant_reply_to(
--     current_setting('app.current_tenant_id')::uuid, 'frontdesk@example.com');
--   SELECT reply_to_email FROM tenant_lookup
--     WHERE id = current_setting('app.current_tenant_id')::uuid;
--   -- expect: 'frontdesk@example.com'
--   ROLLBACK;
--
--   -- CHECK rejects un-normalized input (must error):
--   BEGIN;
--   SELECT set_config('app.current_tenant_id',
--     (SELECT id::text FROM tenants LIMIT 1), true);
--   SELECT set_tenant_reply_to(
--     current_setting('app.current_tenant_id')::uuid, 'Bad Email@Example.com');
--   ROLLBACK;
