-- Migration 019 — tenant accent color (theme_accent)
--
-- Tenants pick a UI accent color in admin Settings. Stored on the
-- tenants root table, exposed through tenant_lookup (the runtime
-- role's only read path to tenants), written through a SECURITY
-- DEFINER function (the runtime role has no UPDATE on tenants).
--
-- The key list must stay in sync with ACCENTS in client/src/theme.js.
--
-- Apply: psql -v ON_ERROR_STOP=1 -f 019_tenant_theme.sql
-- Depends on: 002 (tenants, tenant_lookup), 011 (app_runtime role).

ALTER TABLE tenants
  ADD COLUMN theme_accent text NOT NULL DEFAULT 'indigo'
  CHECK (theme_accent IN ('indigo', 'sky', 'emerald', 'violet', 'rose', 'slate'));

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
  theme_accent
FROM tenants;

CREATE OR REPLACE FUNCTION set_tenant_theme(p_tenant_id uuid, p_accent text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Same cross-tenant guard as apply_credit_change (migration 014):
  -- even a privileged caller can only touch the tenant in the GUC.
  IF p_tenant_id IS DISTINCT FROM current_setting('app.current_tenant_id', true)::uuid THEN
    RAISE EXCEPTION 'tenant mismatch';
  END IF;

  UPDATE tenants SET theme_accent = p_accent WHERE id = p_tenant_id;
  -- Invalid accents are rejected by the CHECK constraint.
END;
$$;

REVOKE ALL ON FUNCTION set_tenant_theme(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_tenant_theme(uuid, text) TO app_runtime;

COMMENT ON FUNCTION set_tenant_theme(uuid, text) IS
  'Admin settings: update the tenant''s UI accent color. SECURITY DEFINER '
  'because app_runtime has no UPDATE on tenants; guarded by the '
  'app.current_tenant_id GUC.';

-- Verify (commented for live apply):
--
--   SELECT theme_accent FROM tenant_lookup LIMIT 1;
--   -- expect: 'indigo'
--
--   BEGIN;
--   SELECT set_config('app.current_tenant_id',
--     (SELECT id::text FROM tenants LIMIT 1), true);
--   SELECT set_tenant_theme(
--     current_setting('app.current_tenant_id')::uuid, 'emerald');
--   SELECT theme_accent FROM tenant_lookup
--     WHERE id = current_setting('app.current_tenant_id')::uuid;
--   -- expect: 'emerald'
--   ROLLBACK;
