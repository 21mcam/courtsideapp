-- Migration 030 — 'court' accent preset (black/green)
--
-- Adds a seventh accent to the theme_accent CHECK for facilities with
-- a black + green brand (first user: Momentum Sports Training). The
-- client-side scale lives in client/src/theme.js under the same key —
-- the key list here must stay in sync with ACCENTS there and with
-- ACCENT_HEX in src/services/email.js.
--
-- Apply: psql -v ON_ERROR_STOP=1 -f 030_theme_court.sql
-- Depends on: 019 (theme_accent column + inline CHECK; Postgres named
--             it tenants_theme_accent_check).

ALTER TABLE tenants
  DROP CONSTRAINT tenants_theme_accent_check;

ALTER TABLE tenants
  ADD CONSTRAINT tenants_theme_accent_check
  CHECK (theme_accent IN ('indigo', 'sky', 'emerald', 'violet', 'rose', 'slate', 'court'));

-- Verify (commented for live apply):
--
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conname = 'tenants_theme_accent_check';
--   -- expect: ... 'slate', 'court' ...
