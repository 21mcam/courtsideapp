-- Migration 014 — apply_credit_change SECURITY DEFINER + privilege
--                  revocation on credit tables
--
-- The credit ledger is the only place we treat as critical-audit. The
-- invariant we want to make impossible to violate is:
--
--   credit_balances.current_credits = balance_after of the latest
--   credit_ledger_entries row for that (tenant_id, member_id).
--
-- Enforcing this in app code alone means every code path that touches
-- credits must remember to write both rows in the right order in the
-- right transaction. Easy to forget. Easy to skip "just this once."
--
-- This migration makes the invariant structural:
--
--   1. apply_credit_change(...) does the SELECT FOR UPDATE on the
--      balance, computes the new balance, rejects if it would go
--      negative, UPDATEs the balance, and INSERTs the ledger entry —
--      all atomically. This is the ONLY path to mutate either table.
--
--   2. REVOKE INSERT, UPDATE, DELETE on both tables from app_runtime.
--      The runtime role can SELECT but cannot write. Direct writes
--      from a forgetful future code path fail at the privilege layer.
--
--   3. The function is SECURITY DEFINER + SET search_path = public,
--      pg_temp. Runs as the function's owner (postgres in Supabase),
--      bypassing the app_runtime REVOKE. EXECUTE granted only to
--      app_runtime; not to PUBLIC.
--
--   4. The function verifies p_tenant_id =
--      current_setting('app.current_tenant_id', true)::uuid. Even a
--      privileged caller (or a buggy app path that passes the wrong
--      tenant_id) can't write across tenants — the GUC is the source
--      of truth, the parameter must agree.
--
-- After this migration: every credit change in Phase 2+ flows through
-- this function. Routes call it inside withTenantContext (the GUC is
-- already set by then). Phase 2 admin endpoints (credit adjustments)
-- and Phase 3 booking flows (spend / refund) will use it. Phase 5
-- pg_cron weekly_reset uses it too.
--
-- Apply: psql -v ON_ERROR_STOP=1 -f 014_apply_credit_change.sql
-- Depends on: 005 (credit_balances, credit_ledger_entries),
--             007 (booking_id FK on ledger),
--             010 (class_booking_id column + final CHECKs),
--             011 (app_runtime role).
-- Verify: see commented block at end.

-- ============================================================
-- The function
-- ============================================================

CREATE OR REPLACE FUNCTION apply_credit_change(
  p_tenant_id        uuid,
  p_member_id        uuid,
  p_amount           integer,
  p_reason           text,
  p_note             text DEFAULT NULL,
  p_granted_by       uuid DEFAULT NULL,
  p_booking_id       uuid DEFAULT NULL,
  p_class_booking_id uuid DEFAULT NULL
)
RETURNS TABLE (entry_id uuid, balance_after integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_guc_tenant uuid;
  v_current    integer;
  v_new        integer;
  v_existed    boolean;
  v_entry_id   uuid;
BEGIN
  -- 1. Cross-tenant defense: even SECURITY DEFINER callers must operate
  --    within the GUC tenant. Catches buggy callers, not just malicious
  --    ones — the GUC is set by withTenantContext on every request, so
  --    any drift between p_tenant_id and the GUC is a bug.
  v_guc_tenant := current_setting('app.current_tenant_id', true)::uuid;
  IF v_guc_tenant IS NULL OR v_guc_tenant <> p_tenant_id THEN
    RAISE EXCEPTION
      'tenant context mismatch: GUC=%, p_tenant_id=%',
      v_guc_tenant, p_tenant_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- 2. Amount must be non-zero. The table CHECK enforces this on the
  --    ledger row, but raising here gives a clearer error before the
  --    INSERT phase.
  IF p_amount = 0 THEN
    RAISE EXCEPTION 'amount must be non-zero'
      USING ERRCODE = 'check_violation';
  END IF;

  -- 3. Lock the balance row (if any) and read current_credits. This is
  --    the serialization point — concurrent calls for the same member
  --    are queued by the row lock, so balance_after is monotonic per
  --    member.
  SELECT current_credits INTO v_current
  FROM credit_balances
  WHERE tenant_id = p_tenant_id AND member_id = p_member_id
  FOR UPDATE;
  v_existed := FOUND;

  IF NOT v_existed THEN
    -- First credit change for this member — start from 0. The balance
    -- INSERT at the bottom creates the row.
    v_current := 0;
  END IF;

  v_new := v_current + p_amount;

  -- 4. Reject if would go negative. The credit_balances CHECK
  --    (current_credits >= 0) would catch this on the UPDATE/INSERT
  --    below, but raising here is clearer and avoids relying on a
  --    table CHECK as our balance gate.
  IF v_new < 0 THEN
    RAISE EXCEPTION 'insufficient credits: have %, change %',
      v_current, p_amount
      USING ERRCODE = 'check_violation';
  END IF;

  -- 5. Apply the balance change. last_reset_at is only touched on
  --    weekly_reset reasons; other reasons preserve whatever was there.
  IF v_existed THEN
    UPDATE credit_balances
       SET current_credits = v_new,
           last_reset_at = CASE
             WHEN p_reason = 'weekly_reset' THEN now()
             ELSE last_reset_at
           END
     WHERE tenant_id = p_tenant_id AND member_id = p_member_id;
  ELSE
    INSERT INTO credit_balances (
      tenant_id, member_id, current_credits, last_reset_at
    ) VALUES (
      p_tenant_id, p_member_id, v_new,
      CASE WHEN p_reason = 'weekly_reset' THEN now() ELSE NULL END
    );
  END IF;

  -- 6. Append the ledger row. The table's CHECKs validate the
  --    reason/booking_id/class_booking_id consistency, the
  --    booking-amount-sign rule, and the no-double-booking-ref
  --    constraint — bad combinations propagate as check_violation
  --    or unique_violation from this INSERT.
  INSERT INTO credit_ledger_entries (
    tenant_id, member_id, amount, balance_after, reason,
    note, granted_by, booking_id, class_booking_id
  ) VALUES (
    p_tenant_id, p_member_id, p_amount, v_new, p_reason,
    p_note, p_granted_by, p_booking_id, p_class_booking_id
  ) RETURNING id INTO v_entry_id;

  entry_id := v_entry_id;
  balance_after := v_new;
  RETURN NEXT;
END;
$$;

-- ============================================================
-- Privileges
-- ============================================================

REVOKE ALL ON FUNCTION apply_credit_change(
  uuid, uuid, integer, text, text, uuid, uuid, uuid
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION apply_credit_change(
  uuid, uuid, integer, text, text, uuid, uuid, uuid
) TO app_runtime;

-- Lock down direct writes to the credit tables. SELECT stays — admin
-- views read balances and ledgers. INSERT/UPDATE/DELETE are revoked
-- because the only legitimate path is the function above.
REVOKE INSERT, UPDATE, DELETE ON credit_balances FROM app_runtime;
REVOKE INSERT, UPDATE, DELETE ON credit_ledger_entries FROM app_runtime;

-- ============================================================
-- VERIFICATION (run manually after applying)
-- ============================================================
--
-- 1. Function exists with SECURITY DEFINER:
--      SELECT proname, prosecdef FROM pg_proc
--       WHERE proname = 'apply_credit_change';
--      -- expected: 1 row, prosecdef = t
--
-- 2. EXECUTE granted to app_runtime, not public:
--      SELECT has_function_privilege(
--        'app_runtime',
--        'apply_credit_change(uuid,uuid,integer,text,text,uuid,uuid,uuid)',
--        'EXECUTE'
--      );
--      -- expected: t
--      SELECT has_function_privilege(
--        'public',
--        'apply_credit_change(uuid,uuid,integer,text,text,uuid,uuid,uuid)',
--        'EXECUTE'
--      );
--      -- expected: f
--
-- 3. Direct writes denied for app_runtime:
--      SELECT has_table_privilege('app_runtime', 'credit_balances', 'INSERT');
--      -- expected: f
--      SELECT has_table_privilege('app_runtime', 'credit_balances', 'SELECT');
--      -- expected: t
--      SELECT has_table_privilege('app_runtime', 'credit_ledger_entries', 'INSERT');
--      -- expected: f
--      SELECT has_table_privilege('app_runtime', 'credit_ledger_entries', 'SELECT');
--      -- expected: t
--
-- 4. Happy path: grant 10 credits, ledger + balance reflect:
--      BEGIN;
--      DO $$
--      DECLARE
--        v_t uuid; v_m uuid; r record;
--      BEGIN
--        INSERT INTO tenants (subdomain, name, timezone)
--          VALUES ('verify-014', 'Verify 014', 'America/New_York')
--          RETURNING id INTO v_t;
--        PERFORM set_config('app.current_tenant_id', v_t::text, true);
--        INSERT INTO members (tenant_id, email, first_name, last_name)
--          VALUES (v_t, 'm@example.com', 'M', 'M')
--          RETURNING id INTO v_m;
--        SELECT * FROM apply_credit_change(v_t, v_m, 10, 'admin_adjustment') INTO r;
--        IF r.balance_after <> 10 THEN
--          RAISE EXCEPTION 'FAIL: balance_after = %', r.balance_after;
--        END IF;
--        IF (SELECT current_credits FROM credit_balances
--             WHERE tenant_id = v_t AND member_id = v_m) <> 10 THEN
--          RAISE EXCEPTION 'FAIL: balance row not 10';
--        END IF;
--        RAISE NOTICE 'PASS: grant 10 credits → balance 10';
--      END;
--      $$;
--      ROLLBACK;
--
-- 5. Negative balance rejected:
--      BEGIN;
--      DO $$
--      DECLARE v_t uuid; v_m uuid;
--      BEGIN
--        INSERT INTO tenants (subdomain, name, timezone)
--          VALUES ('verify-014b', 'Verify 014b', 'America/New_York')
--          RETURNING id INTO v_t;
--        PERFORM set_config('app.current_tenant_id', v_t::text, true);
--        INSERT INTO members (tenant_id, email, first_name, last_name)
--          VALUES (v_t, 'm@example.com', 'M', 'M')
--          RETURNING id INTO v_m;
--        BEGIN
--          PERFORM apply_credit_change(v_t, v_m, -5, 'admin_adjustment');
--          RAISE EXCEPTION 'FAIL: spend without balance accepted';
--        EXCEPTION WHEN check_violation THEN
--          RAISE NOTICE 'PASS: insufficient-credits rejected';
--        END;
--      END;
--      $$;
--      ROLLBACK;
--
-- 6. Cross-tenant GUC mismatch rejected:
--      BEGIN;
--      DO $$
--      DECLARE v_t1 uuid; v_t2 uuid; v_m uuid;
--      BEGIN
--        INSERT INTO tenants (subdomain, name, timezone)
--          VALUES ('verify-014c1', 'C1', 'America/New_York')
--          RETURNING id INTO v_t1;
--        INSERT INTO tenants (subdomain, name, timezone)
--          VALUES ('verify-014c2', 'C2', 'America/New_York')
--          RETURNING id INTO v_t2;
--        PERFORM set_config('app.current_tenant_id', v_t1::text, true);
--        INSERT INTO members (tenant_id, email, first_name, last_name)
--          VALUES (v_t1, 'm@example.com', 'M', 'M')
--          RETURNING id INTO v_m;
--        BEGIN
--          PERFORM apply_credit_change(v_t2, v_m, 5, 'admin_adjustment');
--          RAISE EXCEPTION 'FAIL: cross-tenant accepted';
--        EXCEPTION WHEN check_violation THEN
--          RAISE NOTICE 'PASS: cross-tenant rejected';
--        END;
--      END;
--      $$;
--      ROLLBACK;
