-- Migration 001 — extensions and shared helpers
--
-- Foundation infrastructure that every other migration depends on:
--   * pgcrypto             — gen_random_uuid() for UUID PKs
--   * btree_gist           — exclusion constraints mixing = and &&
--                            (used by operating_hours,
--                            subscription_plan_periods, bookings,
--                            class_instances)
--   * set_updated_at()     — trigger function applied to every
--                            mutable table
--   * category_key domain  — normalized category keys for offerings
--                            and plans
--
-- Apply: psql -v ON_ERROR_STOP=1 -f 001_extensions_and_helpers.sql
-- Verify: see commented block at end.

-- ============================================================
-- EXTENSIONS & SHARED FUNCTIONS
-- ============================================================

-- gen_random_uuid() lives in pgcrypto (Supabase has it on by default)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- btree_gist enables exclusion constraints that mix equality (=) and
-- range overlap (&&). Used by operating_hours and
-- subscription_plan_periods to prevent overlapping ranges.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Shared updated_at trigger function. Applied to every mutable table.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- DOMAINS
-- ============================================================

-- Normalized category keys. Used by offerings.category and
-- plans.allowed_categories so the validation rule lives in one place.
-- Display labels are a UI concern; categories at the data layer are
-- always lowercase, hyphenated, no whitespace, and never NULL (the
-- explicit IS NOT NULL check matters for array element validation —
-- domain CHECK against NULL otherwise evaluates to UNKNOWN, which
-- passes).
CREATE DOMAIN category_key AS text
  CHECK (
    VALUE IS NOT NULL
    AND VALUE = lower(VALUE)
    AND VALUE = btrim(VALUE)
    AND VALUE ~ '^[a-z0-9][a-z0-9-]*$'
  );

-- ============================================================
-- VERIFICATION (run manually after applying)
-- ============================================================
--
-- 1. Extensions installed (expected: 2 rows):
--      SELECT extname FROM pg_extension
--       WHERE extname IN ('pgcrypto', 'btree_gist')
--       ORDER BY extname;
--
-- 2. Helper function present (expected: 1 row):
--      SELECT proname FROM pg_proc WHERE proname = 'set_updated_at';
--
-- 3. Domain present (expected: 1 row):
--      SELECT typname FROM pg_type WHERE typname = 'category_key';
--
-- 4. Domain rejects bad input (each line should ERROR):
--      SELECT 'BAD_KEY'::category_key;
--      SELECT 'has space'::category_key;
--      SELECT '-leading-hyphen'::category_key;
--      SELECT NULL::category_key;
--
-- 5. Domain accepts good input (each line should succeed):
--      SELECT 'cage-time'::category_key;
--      SELECT 'hittrax'::category_key;
--      SELECT 'classes'::category_key;
