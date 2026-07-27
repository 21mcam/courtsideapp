-- Migration 027 — offering descriptions
--
-- The rebuilt walk-in checkout keeps service names short (one line at
-- 390px) and moves explanations into a per-row "details" expander.
-- That expander needs somewhere to live: a nullable free-text
-- description on offerings, shown to customers and members.
--
-- Apply: psql -v ON_ERROR_STOP=1 -f 027_offerings_description.sql
-- Depends on: 004 (offerings).

ALTER TABLE offerings
  ADD COLUMN description text
    CONSTRAINT offerings_description_not_blank
    CHECK (description IS NULL OR btrim(description) <> '');

COMMENT ON COLUMN offerings.description IS
  'Optional customer-facing blurb shown in the booking page''s '
  'per-service details expander. Keep names short; explain here.';

-- Verify (commented for live apply):
--
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'offerings' AND column_name = 'description';
--   -- expect: 1 row
