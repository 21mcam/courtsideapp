-- Migration 029 — tenant business info (NAP + social proof + GA4)
--
-- The public booking page renders the facility's real-world identity:
-- structured address (never concatenated free text — the Setmore flow
-- we're replacing printed "Staten Island, New York,ny 10307" from a
-- free-text state field), phone, Google rating + review count as
-- first-screen social proof, and an optional GA4 measurement id for
-- funnel instrumentation. All manually entered by the tenant admin.
--
-- Follows the migration 019/020 pattern: nullable columns on the
-- tenants root table, exposed through tenant_lookup (resolveTenant
-- does SELECT * so new view columns flow onto req.tenant with no
-- middleware change), written through a SECURITY DEFINER setter
-- guarded by the tenant GUC.
--
-- Apply: psql -v ON_ERROR_STOP=1 -f 029_tenant_business_info.sql
-- Depends on: 002 (tenants, tenant_lookup), 011 (app_runtime role),
--             019/020 (earlier view columns), 025 (CURRENT view text —
--             CREATE OR REPLACE VIEW can only append columns, so this
--             file re-states 025's column list exactly and appends).

ALTER TABLE tenants
  ADD COLUMN address_street text
    CONSTRAINT tenants_address_street_not_blank
    CHECK (address_street IS NULL OR btrim(address_street) <> ''),
  ADD COLUMN address_city text
    CONSTRAINT tenants_address_city_not_blank
    CHECK (address_city IS NULL OR btrim(address_city) <> ''),
  -- Structured, validated state — the exact failure mode this fixes
  -- was a free-text field containing "new york,ny".
  ADD COLUMN address_state text
    CONSTRAINT tenants_address_state_valid
    CHECK (address_state IS NULL OR address_state IN (
      'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID',
      'IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO',
      'MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA',
      'RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY')),
  ADD COLUMN address_zip text
    CONSTRAINT tenants_address_zip_valid
    CHECK (address_zip IS NULL OR address_zip ~ '^\d{5}(-\d{4})?$'),
  ADD COLUMN business_phone text
    CONSTRAINT tenants_business_phone_not_blank
    CHECK (business_phone IS NULL OR btrim(business_phone) <> ''),
  ADD COLUMN google_rating numeric(2,1)
    CONSTRAINT tenants_google_rating_range
    CHECK (google_rating IS NULL OR (google_rating >= 0 AND google_rating <= 5)),
  ADD COLUMN google_review_count integer
    CONSTRAINT tenants_google_review_count_nonnegative
    CHECK (google_review_count IS NULL OR google_review_count >= 0),
  ADD COLUMN google_reviews_url text
    CONSTRAINT tenants_google_reviews_url_https
    CHECK (google_reviews_url IS NULL OR google_reviews_url ~ '^https://'),
  ADD COLUMN ga4_measurement_id text
    CONSTRAINT tenants_ga4_measurement_id_shape
    CHECK (ga4_measurement_id IS NULL OR ga4_measurement_id ~ '^G-[A-Z0-9]{4,16}$');

COMMENT ON COLUMN tenants.google_rating IS
  'Manually entered by the tenant admin (no Places API integration). '
  'Rendered with google_review_count as first-screen social proof on '
  'the public booking page; hidden unless both are set.';
COMMENT ON COLUMN tenants.ga4_measurement_id IS
  'Optional GA4 measurement id (G-XXXXXXXXXX). When set, the public '
  'booking page loads gtag and fires funnel events (view_services → '
  'purchase). Ships in page source by nature — not a secret.';

-- CREATE OR REPLACE VIEW can append columns; existing grants survive.
-- Column list through reply_to_email is 025's text verbatim.
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
  ga4_measurement_id
FROM tenants;

-- Full-replace semantics (all fields every call), matching the admin
-- PUT that sends the whole business-info object — same singleton
-- style as upsertBookingPolicies.
CREATE OR REPLACE FUNCTION set_tenant_business_info(
  p_tenant_id    uuid,
  p_street       text,
  p_city         text,
  p_state        text,
  p_zip          text,
  p_phone        text,
  p_rating       numeric,
  p_review_count integer,
  p_reviews_url  text,
  p_ga4          text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Same cross-tenant guard as apply_credit_change (014) and
  -- set_tenant_theme (019).
  IF p_tenant_id IS DISTINCT FROM current_setting('app.current_tenant_id', true)::uuid THEN
    RAISE EXCEPTION 'tenant mismatch';
  END IF;

  UPDATE tenants SET
    address_street      = p_street,
    address_city        = p_city,
    address_state       = p_state,
    address_zip         = p_zip,
    business_phone      = p_phone,
    google_rating       = p_rating,
    google_review_count = p_review_count,
    google_reviews_url  = p_reviews_url,
    ga4_measurement_id  = p_ga4
  WHERE id = p_tenant_id;
  -- Malformed values are rejected by the column CHECKs above.
END;
$$;

REVOKE ALL ON FUNCTION set_tenant_business_info(
  uuid, text, text, text, text, text, numeric, integer, text, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_tenant_business_info(
  uuid, text, text, text, text, text, numeric, integer, text, text
) TO app_runtime;

COMMENT ON FUNCTION set_tenant_business_info(
  uuid, text, text, text, text, text, numeric, integer, text, text
) IS
  'Admin settings: full-replace update of the tenant''s business info '
  '(structured address, phone, Google rating/reviews, GA4 id). '
  'SECURITY DEFINER because app_runtime has no UPDATE on tenants; '
  'guarded by the app.current_tenant_id GUC.';

-- Verify (commented for live apply):
--
--   SELECT address_state, google_rating, ga4_measurement_id
--     FROM tenant_lookup LIMIT 1;
--   -- expect: NULL, NULL, NULL
--
--   BEGIN;
--   SELECT set_config('app.current_tenant_id',
--     (SELECT id::text FROM tenants LIMIT 1), true);
--   SELECT set_tenant_business_info(
--     current_setting('app.current_tenant_id')::uuid,
--     '123 Main St', 'Staten Island', 'NY', '10307',
--     '(718) 555-0100', 5.0, 205,
--     'https://g.page/example', 'G-ABC123XYZ');
--   SELECT address_city, address_state, google_rating, google_review_count
--     FROM tenant_lookup
--    WHERE id = current_setting('app.current_tenant_id')::uuid;
--   -- expect: Staten Island | NY | 5.0 | 205
--   ROLLBACK;
--
--   -- CHECK rejects a free-text state (must error):
--   BEGIN;
--   SELECT set_config('app.current_tenant_id',
--     (SELECT id::text FROM tenants LIMIT 1), true);
--   SELECT set_tenant_business_info(
--     current_setting('app.current_tenant_id')::uuid,
--     NULL, NULL, 'new york,ny', NULL, NULL, NULL, NULL, NULL, NULL);
--   ROLLBACK;
