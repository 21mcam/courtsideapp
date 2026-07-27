-- Migration 028 — category display overlay (section labels + ordering)
--
-- The public booking page groups offerings into sections by their
-- category key. Keys like 'hittrax' can't produce a first-time-parent
-- header like "HitTrax – See Your Hitting Stats", so tenants need a
-- place to store a display label and a section order.
--
-- Design: a pure DISPLAY OVERLAY, not a categories entity.
-- offerings.category stays a free-text category_key scalar (CLAUDE.md:
-- renaming categories is still not a first-class operation, and
-- plans.allowed_categories still references raw keys). A missing row
-- here just means the client derives a label from the key
-- (formatCategoryLabel) and sorts alphabetically. Orphan rows (a label
-- for a key no offering uses) are harmless and prunable — there is
-- deliberately no FK to offerings (category isn't unique there).
--
-- Apply: psql -v ON_ERROR_STOP=1 -f 028_category_display.sql
-- Depends on: 001 (category_key domain, set_updated_at),
--             002 (tenants), 011 (app_runtime default privileges).

CREATE TABLE category_display (
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  category      category_key NOT NULL,
  label         text NOT NULL CHECK (btrim(label) <> ''),
  display_order integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- Natural composite PK, same pattern as credit_balances: one
  -- overlay row per (tenant, category key). No surrogate id, so no
  -- UNIQUE (tenant_id, id) needed.
  PRIMARY KEY (tenant_id, category)
);

CREATE TRIGGER category_display_set_updated_at
  BEFORE UPDATE ON category_display
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE category_display ENABLE ROW LEVEL SECURITY;
ALTER TABLE category_display FORCE ROW LEVEL SECURITY;
CREATE POLICY category_display_tenant_isolation ON category_display
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- No explicit grants needed: migration 011's ALTER DEFAULT PRIVILEGES
-- gives app_runtime full CRUD, which is correct — these are ordinary
-- admin-managed display rows.

COMMENT ON TABLE category_display IS
  'Per-tenant display overlay for offering category keys: section '
  'label + ordering on the public booking page. No row = client '
  'derives the label from the key. Deleting a row reverts to the '
  'derived label; it never affects offerings or plan restrictions.';

-- Verify (commented for live apply):
--
--   SELECT tablename, rowsecurity, forcerowsecurity FROM pg_tables
--    WHERE schemaname = 'public' AND tablename = 'category_display';
--   -- expect: 1 row, t / t
--
--   SELECT has_table_privilege('app_runtime', 'category_display', 'INSERT');
--   -- expect: t
