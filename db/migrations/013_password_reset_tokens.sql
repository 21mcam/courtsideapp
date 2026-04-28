-- Migration 013 — password_reset_tokens
--
-- Single-use, time-limited tokens for the forgot-password flow.
-- Storage shape:
--   * token_hash holds SHA-256(raw_token). The raw token is generated
--     by the app, returned (eventually) via email, and never stored.
--     SHA-256 is fine for high-entropy random tokens — no need for
--     bcrypt's slowness here.
--   * used_at is NULL until the token is consumed; partial unique
--     index below enforces "only one active token per user."
--   * expires_at is set 1 hour out by app code (not a DB default —
--     CHECK only requires it's after created_at).
--
-- Issuing a new token is a two-step operation in app code: first
-- UPDATE used_at on any prior unused tokens for that user, then
-- INSERT the new one. The partial unique index makes this required
-- — the second INSERT would fail otherwise. Both happen in the same
-- withTenantContext transaction.
--
-- Apply: psql -v ON_ERROR_STOP=1 -f 013_password_reset_tokens.sql
-- Depends on: 002 (users), 011 (privileges).
-- Verify: see commented block at end.

CREATE TABLE password_reset_tokens (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL,
  token_hash      text NOT NULL
                  CHECK (btrim(token_hash) <> '' AND length(token_hash) >= 16),
  expires_at      timestamptz NOT NULL,
  used_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE CASCADE,
  CHECK (expires_at > created_at),
  CHECK (used_at IS NULL OR used_at >= created_at)
);

-- Only one active (unused) token per user per tenant. Issuing a new
-- one requires invalidating the prior one in the same transaction.
CREATE UNIQUE INDEX password_reset_tokens_one_active_per_user
  ON password_reset_tokens (tenant_id, user_id)
  WHERE used_at IS NULL;

-- Lookup index for reset-password: hash + tenant + active.
CREATE INDEX password_reset_tokens_active_lookup_idx
  ON password_reset_tokens (tenant_id, token_hash)
  WHERE used_at IS NULL;

-- Janitor index for the eventual cleanup sweep (Phase 3+).
CREATE INDEX password_reset_tokens_expires_idx
  ON password_reset_tokens (expires_at)
  WHERE used_at IS NULL;

ALTER TABLE password_reset_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_reset_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY password_reset_tokens_tenant_isolation ON password_reset_tokens
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- ============================================================
-- VERIFICATION (run manually after applying)
-- ============================================================
--
-- 1. Table + RLS state (expected: 1 row, t/t):
--      SELECT tablename, rowsecurity, forcerowsecurity FROM pg_tables
--       WHERE schemaname = 'public' AND tablename = 'password_reset_tokens';
--
-- 2. Three indexes present (one_active, active_lookup, expires):
--      SELECT indexname FROM pg_indexes
--       WHERE tablename = 'password_reset_tokens'
--       ORDER BY indexname;
--
-- 3. Partial unique enforces one active token per user:
--      BEGIN;
--      DO $$
--      DECLARE v_tenant_id uuid; v_user_id uuid;
--      BEGIN
--        INSERT INTO tenants (subdomain, name, timezone)
--          VALUES ('verify-013', 'Verify 013', 'America/New_York')
--          RETURNING id INTO v_tenant_id;
--        PERFORM set_config('app.current_tenant_id', v_tenant_id::text, true);
--        INSERT INTO users (tenant_id, email, password_hash, first_name, last_name)
--          VALUES (v_tenant_id, 'a@example.com', 'x', 'A', 'A')
--          RETURNING id INTO v_user_id;
--        INSERT INTO password_reset_tokens
--          (tenant_id, user_id, token_hash, expires_at)
--          VALUES (v_tenant_id, v_user_id, 'aaaaaaaaaaaaaaaa',
--                  now() + interval '1 hour');
--        BEGIN
--          INSERT INTO password_reset_tokens
--            (tenant_id, user_id, token_hash, expires_at)
--            VALUES (v_tenant_id, v_user_id, 'bbbbbbbbbbbbbbbb',
--                    now() + interval '1 hour');
--          RAISE EXCEPTION 'FAIL: second active token accepted';
--        EXCEPTION WHEN unique_violation THEN
--          RAISE NOTICE 'PASS: second active token rejected';
--        END;
--      END;
--      $$;
--      ROLLBACK;
--
-- 4. After invalidating the first (used_at = now()), a second can
--    be inserted:
--      BEGIN;
--      DO $$
--      DECLARE v_tenant_id uuid; v_user_id uuid;
--      BEGIN
--        INSERT INTO tenants (subdomain, name, timezone)
--          VALUES ('verify-013b', 'Verify 013b', 'America/New_York')
--          RETURNING id INTO v_tenant_id;
--        PERFORM set_config('app.current_tenant_id', v_tenant_id::text, true);
--        INSERT INTO users (tenant_id, email, password_hash, first_name, last_name)
--          VALUES (v_tenant_id, 'b@example.com', 'x', 'B', 'B')
--          RETURNING id INTO v_user_id;
--        INSERT INTO password_reset_tokens
--          (tenant_id, user_id, token_hash, expires_at)
--          VALUES (v_tenant_id, v_user_id, 'aaaaaaaaaaaaaaaa',
--                  now() + interval '1 hour');
--        UPDATE password_reset_tokens
--           SET used_at = now()
--         WHERE tenant_id = v_tenant_id AND user_id = v_user_id;
--        INSERT INTO password_reset_tokens
--          (tenant_id, user_id, token_hash, expires_at)
--          VALUES (v_tenant_id, v_user_id, 'bbbbbbbbbbbbbbbb',
--                  now() + interval '1 hour');
--        RAISE NOTICE 'PASS: invalidate-then-insert sequence works';
--      END;
--      $$;
--      ROLLBACK;
