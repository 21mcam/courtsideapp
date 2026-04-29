-- Courtside — Database Schema (Phase 0)
--
-- All tables locked across 8 layers:
--   1. Foundation: tenants, users, tenant_admins, members
--   2. Catalog: resources, offerings, offering_resources
--   3. Subscription/Credit: plans, subscriptions,
--      subscription_plan_periods, credit_balances,
--      credit_ledger_entries
--   4. Operational: operating_hours, blackouts, booking_policies
--   5. Bookings: bookings (resource rentals)
--   6. Classes: class_schedules, class_instances, class_bookings
--   7. Stripe Connect: stripe_connections
--   8. Cleanup: post-class FK additions to credit_ledger_entries
--
-- Migrations are applied manually to live Supabase. This file is the
-- canonical destination state; individual migrations in db/migrations/
-- get there incrementally. See MIGRATION_ORDER.md for the order.

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
-- LAYER 1: FOUNDATION
-- ============================================================

-- The tenants table is special: it's the root, has no tenant_id, and
-- is queried during subdomain resolution BEFORE any tenant context
-- exists. To prevent accidental exposure of platform billing fields
-- to the runtime path, application code must use a narrow
-- `tenant_lookup` view (Phase 0 deliverable) that exposes only
-- routing-safe columns (id, subdomain, name, timezone). The runtime
-- DB role gets SELECT on the view; the underlying table is reachable
-- only via the migration/super-admin role.
CREATE TABLE tenants (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subdomain                       text UNIQUE NOT NULL
                                  CHECK (
                                    subdomain = lower(subdomain)
                                    AND subdomain ~ '^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$'
                                    AND subdomain NOT IN (
                                      'www', 'api', 'admin', 'app', 'support', 'login',
                                      'help', 'mail', 'auth', 'status', 'cdn', 'static',
                                      'assets'
                                    )
                                  ),
  name                            text NOT NULL
                                  CHECK (btrim(name) <> '' AND name = btrim(name)),
  timezone                        text NOT NULL
                                  CHECK (btrim(timezone) <> '' AND timezone = btrim(timezone)),
  -- platform-side billing (what the tenant pays us). Privileged-only
  -- — never exposed via tenant_lookup view.
  platform_stripe_customer_id     text,
  platform_stripe_subscription_id text,
  platform_subscription_status    text NOT NULL DEFAULT 'trial'
                                  CHECK (platform_subscription_status IN
                                         ('trial', 'active', 'past_due', 'cancelled', 'suspended')),
  trial_ends_at                   timestamptz,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX tenants_platform_stripe_customer_unique
  ON tenants (platform_stripe_customer_id)
  WHERE platform_stripe_customer_id IS NOT NULL;

CREATE UNIQUE INDEX tenants_platform_stripe_subscription_unique
  ON tenants (platform_stripe_subscription_id)
  WHERE platform_stripe_subscription_id IS NOT NULL;

CREATE TRIGGER tenants_set_updated_at
  BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Tenants is the root: no tenant_id column, so the standard
-- `tenant_id = current_setting(...)` policy doesn't apply. We still
-- enable RLS with NO POLICY, which becomes a blanket deny for any
-- role without BYPASSRLS — defense in depth against Supabase's
-- default `anon`/`authenticated` grants and any future role we
-- forget about.
--
-- FORCE ROW LEVEL SECURITY is intentionally NOT set on tenants:
-- migrations and cross-tenant ops (Stripe webhook resolving from
-- customer ID, super-admin) need to read/write tenants as the
-- postgres / DDL role. With ENABLE-only, the table owner still
-- bypasses the (missing) policy; non-owner non-BYPASSRLS roles see
-- nothing.
--
-- The runtime path (Express backend, role app_runtime) never queries
-- tenants directly — it goes through the `tenant_lookup` view below.
-- Migration 011 also REVOKE ALL ON tenants FROM app_runtime, so the
-- runtime is denied at the GRANT layer too.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------
-- Narrow lookup view for subdomain resolution. Runtime DB role gets
-- SELECT on this view, NOT on the underlying tenants table — that
-- keeps platform billing fields out of the routing path. Only the
-- migration / super-admin role can query tenants directly.
--
-- is_billing_ok is a derived boolean exposing only "is this tenant
-- in good standing" — never the underlying status enum or any
-- Stripe IDs.
CREATE VIEW tenant_lookup AS
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
  ) AS is_billing_ok
FROM tenants;

COMMENT ON VIEW tenant_lookup IS
  'Safe subdomain-resolution view. Exposes routing-safe columns only; '
  'never billing fields. Runtime role gets SELECT here, not on tenants.';

-- ----------------------------------------------------------
CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email           text NOT NULL
                  CHECK (
                    email = lower(btrim(email))
                    AND btrim(email) <> ''
                    AND email !~ '\s'
                  ),
  password_hash   text NOT NULL,
  first_name      text NOT NULL
                  CHECK (btrim(first_name) <> '' AND first_name = btrim(first_name)),
  last_name       text NOT NULL
                  CHECK (btrim(last_name) <> '' AND last_name = btrim(last_name)),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email),
  UNIQUE (tenant_id, id),  -- needed for composite FKs from role tables
  -- Required by the members composite FK below: ensures a linked
  -- member's email always matches the user's email, so login
  -- identity and member identity can't drift apart.
  UNIQUE (tenant_id, id, email)
);

CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY users_tenant_isolation ON users
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- ----------------------------------------------------------
-- A user can have either or both of these role rows. One user, many
-- roles: a facility owner can be both an admin AND a member of their
-- own facility (testing flows, training as a member). Distinct roles,
-- single login.
CREATE TABLE tenant_admins (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  user_id     uuid NOT NULL,
  role        text NOT NULL DEFAULT 'admin'
              CHECK (role IN ('admin', 'owner')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE tenant_admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_admins FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_admins_tenant_isolation ON tenant_admins
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- ----------------------------------------------------------
-- Members are people who hold (or could hold) a paid subscription.
-- user_id is nullable so admins can manually create member records
-- before the person sets up a login (invite flow, data import).
-- ON DELETE RESTRICT for the user FK because deleting a user with
-- linked member history should be intentional, not cascading.
CREATE TABLE members (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id         uuid,
  email           text NOT NULL
                  CHECK (
                    email = lower(btrim(email))
                    AND btrim(email) <> ''
                    AND email !~ '\s'
                  ),
  first_name      text NOT NULL
                  CHECK (btrim(first_name) <> '' AND first_name = btrim(first_name)),
  last_name       text NOT NULL
                  CHECK (btrim(last_name) <> '' AND last_name = btrim(last_name)),
  phone           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email),
  UNIQUE (tenant_id, id),
  -- Composite FK including email: when a member is linked to a user
  -- (user_id IS NOT NULL), the emails MUST match. This prevents a
  -- buggy invite/link flow from silently attaching the wrong login
  -- identity to a member's credits and bookings. ON UPDATE CASCADE
  -- so a user email change auto-propagates to the linked member.
  -- When user_id IS NULL (manual/imported members), the FK is
  -- inactive — composite FKs with any null column don't enforce.
  FOREIGN KEY (tenant_id, user_id, email)
    REFERENCES users(tenant_id, id, email)
    ON UPDATE CASCADE
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX members_tenant_user_unique
  ON members (tenant_id, user_id)
  WHERE user_id IS NOT NULL;

CREATE TRIGGER members_set_updated_at
  BEFORE UPDATE ON members
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE members ENABLE ROW LEVEL SECURITY;
ALTER TABLE members FORCE ROW LEVEL SECURITY;
CREATE POLICY members_tenant_isolation ON members
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- ============================================================
-- LAYER 2: CATALOG
-- ============================================================

CREATE TABLE resources (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name            text NOT NULL
                  CHECK (btrim(name) <> '' AND name = btrim(name)),
  display_order   integer NOT NULL DEFAULT 0,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name),
  UNIQUE (tenant_id, id)
);

CREATE TRIGGER resources_set_updated_at
  BEFORE UPDATE ON resources
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE resources FORCE ROW LEVEL SECURITY;
CREATE POLICY resources_tenant_isolation ON resources
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- ----------------------------------------------------------
CREATE TABLE offerings (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                  text NOT NULL
                        CHECK (btrim(name) <> '' AND name = btrim(name)),
  category              category_key NOT NULL,
  duration_minutes      integer NOT NULL CHECK (duration_minutes > 0),
  credit_cost           integer NOT NULL CHECK (credit_cost >= 0),
  dollar_price          integer NOT NULL CHECK (dollar_price >= 0),  -- cents
  capacity              integer NOT NULL DEFAULT 1 CHECK (capacity >= 1),
  -- capacity = 1 means rental (resource-exclusive booking)
  -- capacity > 1 means class (multi-roster booking)
  allow_member_booking  boolean NOT NULL DEFAULT true,
  allow_public_booking  boolean NOT NULL DEFAULT false,
  active                boolean NOT NULL DEFAULT true,
  display_order         integer NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  -- An active offering must be bookable by at least one audience.
  -- Use active = false for "draft" offerings.
  CHECK (NOT active OR allow_member_booking OR allow_public_booking)
);

CREATE TRIGGER offerings_set_updated_at
  BEFORE UPDATE ON offerings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE offerings ENABLE ROW LEVEL SECURITY;
ALTER TABLE offerings FORCE ROW LEVEL SECURITY;
CREATE POLICY offerings_tenant_isolation ON offerings
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- ----------------------------------------------------------
-- One offering can be valid for multiple resources, and one resource
-- can host multiple offerings. Tenant-leading PK for query ergonomics
-- and RLS.
--
-- The `active` flag exists because bookings reference this row via
-- composite FK (offering_id + resource_id must be a valid pairing).
-- That means we can't delete a row once any booking exists. Admins
-- "remove" a resource from an offering by setting active = false;
-- new bookings check the flag, historical bookings keep referencing
-- the row.
CREATE TABLE offering_resources (
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  offering_id  uuid NOT NULL,
  resource_id  uuid NOT NULL,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, offering_id, resource_id),
  FOREIGN KEY (tenant_id, offering_id) REFERENCES offerings(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, resource_id) REFERENCES resources(tenant_id, id) ON DELETE CASCADE
);

CREATE TRIGGER offering_resources_set_updated_at
  BEFORE UPDATE ON offering_resources
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX offering_resources_tenant_resource_idx
  ON offering_resources (tenant_id, resource_id);

ALTER TABLE offering_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE offering_resources FORCE ROW LEVEL SECURITY;
CREATE POLICY offering_resources_tenant_isolation ON offering_resources
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- ============================================================
-- LAYER 3: SUBSCRIPTION / CREDIT
-- ============================================================

CREATE TABLE plans (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                  text NOT NULL
                        CHECK (btrim(name) <> '' AND name = btrim(name)),
  description           text,
  monthly_price_cents   integer NOT NULL CHECK (monthly_price_cents >= 0),
  credits_per_week      integer NOT NULL CHECK (credits_per_week >= 0),
  -- NULL means "all categories allowed"; non-empty array is a whitelist.
  -- category_key domain rejects NULL elements so the array is clean.
  allowed_categories    category_key[]
                        CHECK (allowed_categories IS NULL
                               OR cardinality(allowed_categories) > 0),
  -- Stripe Price ID lives in the tenant's Connect account. Nullable
  -- because plans can be created in the wizard before Stripe Connect
  -- is finished. Sync logic enforces "active plans must have a Stripe
  -- price" at the application layer. Globally unique in practice;
  -- the partial unique index below is sufficient.
  stripe_price_id       text,
  active                boolean NOT NULL DEFAULT true,
  display_order         integer NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

-- Active plan names unique per tenant, case-insensitive. Inactive
-- plans don't block creating a new active plan with the same name.
CREATE UNIQUE INDEX plans_active_name_unique
  ON plans (tenant_id, lower(name))
  WHERE active = true;

CREATE UNIQUE INDEX plans_stripe_price_unique
  ON plans (stripe_price_id)
  WHERE stripe_price_id IS NOT NULL;

CREATE TRIGGER plans_set_updated_at
  BEFORE UPDATE ON plans
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE plans FORCE ROW LEVEL SECURITY;
CREATE POLICY plans_tenant_isolation ON plans
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- ----------------------------------------------------------
-- One row per Stripe subscription. This represents the
-- subscription's lifecycle, NOT the plan history. When a member
-- upgrades their plan, Stripe updates this same subscription's items
-- — so we keep this row, and add a new row in
-- subscription_plan_periods. Cancel-and-resubscribe creates a new
-- subscription row.
--
-- Statuses are internal (Stripe-mapped, not Stripe-mirrored) — we
-- translate Stripe's "canceled" to our "cancelled" at the webhook
-- boundary. Stripe's "incomplete_expired" maps to our "cancelled".
--
-- Phase 5 deliverable: a janitor job that sweeps `incomplete`
-- subscriptions older than 24h and marks them cancelled. Stripe
-- normally fires `incomplete_expired` automatically, but the janitor
-- is the safety net for missed webhooks. Without it, a stale
-- incomplete subscription can block a member from retrying checkout
-- (subscriptions_one_active_per_member would conflict).
--
-- Note: stripe_customer_id is more "member identity" than
-- "subscription lifecycle". For v1 it lives here; consider a
-- stripe_customers table later when adding multi-customer support
-- or platform-wide deduplication.
CREATE TABLE subscriptions (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  member_id                   uuid NOT NULL,
  stripe_subscription_id      text,
  stripe_customer_id          text,
  status                      text NOT NULL
                              CHECK (status IN ('pending', 'active', 'past_due',
                                                 'cancelled', 'incomplete')),
  current_period_start        timestamptz,
  current_period_end          timestamptz,
  cancel_at_period_end        boolean NOT NULL DEFAULT false,
  scheduled_deactivation_at   timestamptz,
  -- Set when status first becomes 'active'. NULL for subscriptions
  -- that never activated (e.g. payment never cleared).
  activated_at                timestamptz,
  -- Set when status moves to a terminal state.
  ended_at                    timestamptz,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, member_id) REFERENCES members(tenant_id, id) ON DELETE CASCADE,
  -- Period bounds must make sense if both are set. Skipping the
  -- analogous activated_at/ended_at check intentionally — Stripe
  -- webhook ordering edge cases make a strict DB constraint there
  -- create more reconciliation pain than value. App-level validation
  -- handles that one.
  CHECK (
    current_period_start IS NULL
    OR current_period_end IS NULL
    OR current_period_end > current_period_start
  )
);

CREATE UNIQUE INDEX subscriptions_stripe_unique
  ON subscriptions (stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;

-- A member can have many historical subscriptions but only one
-- non-terminal subscription at a time.
CREATE UNIQUE INDEX subscriptions_one_active_per_member
  ON subscriptions (tenant_id, member_id)
  WHERE status IN ('pending', 'active', 'past_due', 'incomplete');

CREATE TRIGGER subscriptions_set_updated_at
  BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY subscriptions_tenant_isolation ON subscriptions
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- ----------------------------------------------------------
-- Plan history within a subscription. One row per "you were on this
-- plan from started_at until ended_at." Plan changes (upgrade,
-- downgrade) close the previous row and open a new one. The current
-- plan for a subscription is the row where ended_at IS NULL.
--
-- Why separate from subscriptions: Stripe represents plan changes as
-- updates to the same subscription's items. We need history for
-- billing audits, "when did this member upgrade?" support questions,
-- and credit ledger reasons (plan_change credits get tied to a
-- specific period's start).
--
-- period_range is a generated tstzrange over [started_at,
-- coalesce(ended_at, 'infinity')) used by the exclusion constraint
-- to prevent overlapping plan periods within a subscription. This is
-- a critical invariant: bookings and credit logic ask "what plan was
-- active at time X" and need a single answer.
--
-- Provenance columns (started_reason/by, ended_reason/by) are
-- DEFERRED. A single change_reason is ambiguous because a period
-- has two lifecycle moments. When a concrete need arises, add four
-- nullable columns: started_reason, started_by, ended_reason,
-- ended_by. Historical rows stay null.
CREATE TABLE subscription_plan_periods (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subscription_id     uuid NOT NULL,
  plan_id             uuid NOT NULL,
  started_at          timestamptz NOT NULL DEFAULT now(),
  ended_at            timestamptz,    -- NULL = currently in effect
  period_range        tstzrange GENERATED ALWAYS AS (
                        tstzrange(started_at, coalesce(ended_at, 'infinity'::timestamptz), '[)')
                      ) STORED,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, subscription_id) REFERENCES subscriptions(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, plan_id) REFERENCES plans(tenant_id, id) ON DELETE RESTRICT,
  CHECK (ended_at IS NULL OR ended_at > started_at),
  EXCLUDE USING gist (
    tenant_id WITH =,
    subscription_id WITH =,
    period_range WITH &&
  )
);

CREATE INDEX subscription_plan_periods_subscription_idx
  ON subscription_plan_periods (tenant_id, subscription_id, started_at);

-- Fast lookup for the common "what plan is this subscription on right
-- now?" query. The GiST exclusion index handles overlap checks, but
-- isn't great for simple equality. This partial btree is small and
-- direct.
CREATE INDEX subscription_plan_periods_current_idx
  ON subscription_plan_periods (tenant_id, subscription_id)
  WHERE ended_at IS NULL;

CREATE TRIGGER subscription_plan_periods_set_updated_at
  BEFORE UPDATE ON subscription_plan_periods
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE subscription_plan_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_plan_periods FORCE ROW LEVEL SECURITY;
CREATE POLICY subscription_plan_periods_tenant_isolation ON subscription_plan_periods
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- ----------------------------------------------------------
-- Singleton-per-member current balance.
-- Mutations go through apply_credit_change() (TODO Phase 2) which
-- writes both this row AND a credit_ledger_entries row in one
-- transaction. Direct UPDATE on this table is forbidden — privileges
-- will be revoked from the runtime DB role; only SECURITY DEFINER
-- function can write.
CREATE TABLE credit_balances (
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  member_id        uuid NOT NULL,
  current_credits  integer NOT NULL DEFAULT 0 CHECK (current_credits >= 0),
  last_reset_at    timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, member_id),
  FOREIGN KEY (tenant_id, member_id) REFERENCES members(tenant_id, id) ON DELETE CASCADE
);

CREATE TRIGGER credit_balances_set_updated_at
  BEFORE UPDATE ON credit_balances
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE credit_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_balances FORCE ROW LEVEL SECURITY;
CREATE POLICY credit_balances_tenant_isolation ON credit_balances
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- ----------------------------------------------------------
-- Append-only credit ledger. Every balance mutation writes a row.
-- Invariant: credit_balances.current_credits = balance_after of the
-- ledger row with the highest entry_number for that (tenant_id,
-- member_id).
--
-- entry_number (bigserial, globally monotonic) is the source of
-- truth for ordering, not created_at — because now() returns the
-- transaction start time, multiple ledger inserts in one transaction
-- would otherwise share a created_at and make "latest" ambiguous.
--
-- amount is signed: positive = credits added, negative = removed.
-- balance_after is the resulting balance (must be >= 0).
--
-- booking_id is added in a later migration once bookings exists
-- (see Phase 3 deliverable: "finalize ledger.booking_id FK").
CREATE TABLE credit_ledger_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_number    bigserial NOT NULL UNIQUE,
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  member_id       uuid NOT NULL,
  amount          integer NOT NULL CHECK (amount <> 0),
  balance_after   integer NOT NULL CHECK (balance_after >= 0),
  reason          text NOT NULL
                  CHECK (reason IN ('weekly_reset', 'admin_adjustment', 'signup_bonus',
                                    'booking_spend', 'booking_refund', 'plan_change',
                                    'manual')),
  note            text,
  granted_by      uuid,         -- user_id of admin (if any). No FK so historical entries
                                -- survive admin user deletion.
  booking_id      uuid,         -- FK added in bookings migration (Phase 3).
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, member_id) REFERENCES members(tenant_id, id) ON DELETE CASCADE,
  -- booking_id presence is tied to reason: booking_spend/booking_refund
  -- entries must reference a booking; other reasons must not.
  -- Named explicitly so migration 010 can drop it by deterministic
  -- name when adding class_booking_id support.
  CONSTRAINT credit_ledger_entries_booking_ref_check
    CHECK ((reason IN ('booking_spend', 'booking_refund')) = (booking_id IS NOT NULL)),
  -- amount direction is fixed for booking-related reasons:
  --   booking_spend: credits leaving the balance (negative)
  --   booking_refund: credits returning to the balance (positive)
  -- Other reasons (admin_adjustment, manual, plan_change) can be
  -- either direction by intent — app validation handles those.
  CONSTRAINT credit_ledger_entries_booking_amount_sign_check
    CHECK (
      CASE reason
        WHEN 'booking_spend' THEN amount < 0
        WHEN 'booking_refund' THEN amount > 0
        ELSE true
      END
    )
);

CREATE INDEX credit_ledger_entries_member_entry_idx
  ON credit_ledger_entries (tenant_id, member_id, entry_number DESC);

ALTER TABLE credit_ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_ledger_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY credit_ledger_entries_tenant_isolation ON credit_ledger_entries
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- ============================================================
-- LAYER 4: OPERATIONAL
-- ============================================================

-- One resource, one day-of-week, one time range = one row.
-- Multiple rows allowed per resource+day for split shifts (e.g.
-- 9am-12pm and 2pm-9pm with a lunch break), but they cannot overlap
-- (enforced by exclusion constraint).
-- A resource with NO operating_hours rows for a given day is closed
-- that day (no booking allowed).
-- day_of_week: 0=Sun, 1=Mon, ... 6=Sat (matches JS Date.getDay()
-- and Postgres EXTRACT(DOW)).
-- open_time/close_time use `time` not timestamptz: operating hours
-- are local times that don't shift with DST.
-- hours_seconds is a generated int4range (in seconds-since-midnight)
-- used by the exclusion constraint to prevent overlapping ranges.
CREATE TABLE operating_hours (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  resource_id     uuid NOT NULL,
  day_of_week     smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  open_time       time NOT NULL,
  close_time      time NOT NULL,
  hours_seconds   int4range GENERATED ALWAYS AS (
                    int4range(
                      extract(epoch FROM open_time)::int4,
                      extract(epoch FROM close_time)::int4,
                      '[)'
                    )
                  ) STORED,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, resource_id) REFERENCES resources(tenant_id, id) ON DELETE CASCADE,
  CHECK (close_time > open_time),
  EXCLUDE USING gist (
    tenant_id WITH =,
    resource_id WITH =,
    day_of_week WITH =,
    hours_seconds WITH &&
  )
);

CREATE INDEX operating_hours_resource_day_idx
  ON operating_hours (tenant_id, resource_id, day_of_week);

CREATE TRIGGER operating_hours_set_updated_at
  BEFORE UPDATE ON operating_hours
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE operating_hours ENABLE ROW LEVEL SECURITY;
ALTER TABLE operating_hours FORCE ROW LEVEL SECURITY;
CREATE POLICY operating_hours_tenant_isolation ON operating_hours
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- ----------------------------------------------------------
-- A blackout is a time range when something is NOT bookable.
-- Targeting:
--   - resource_id set, offering_id null → blackout that resource
--   - offering_id set, resource_id null → blackout that offering
--   - both null → facility-wide blackout (e.g. "Christmas Day")
-- Both set is forbidden (CHECK).
--
-- Common UX patterns map to blackout rows:
--   - Admin clicks "Pause this offering until [date]" on the offering
--     admin form → INSERT blackouts with offering_id, starts_at = now(),
--     ends_at = picked date.
--   - Admin clicks "Cage 3 out of service until [date]" → same idea
--     with resource_id.
--   - Admin clicks "Closed for the holiday on [date range]" → both null.
CREATE TABLE blackouts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  resource_id     uuid,
  offering_id     uuid,
  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz NOT NULL,
  reason          text,
  created_by      uuid,         -- user_id of admin. No FK; soft reference.
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  CHECK (NOT (resource_id IS NOT NULL AND offering_id IS NOT NULL)),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, resource_id) REFERENCES resources(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, offering_id) REFERENCES offerings(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX blackouts_tenant_time_idx
  ON blackouts (tenant_id, starts_at, ends_at);

CREATE INDEX blackouts_resource_time_idx
  ON blackouts (tenant_id, resource_id, starts_at)
  WHERE resource_id IS NOT NULL;

CREATE INDEX blackouts_offering_time_idx
  ON blackouts (tenant_id, offering_id, starts_at)
  WHERE offering_id IS NOT NULL;

CREATE TRIGGER blackouts_set_updated_at
  BEFORE UPDATE ON blackouts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE blackouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE blackouts FORCE ROW LEVEL SECURITY;
CREATE POLICY blackouts_tenant_isolation ON blackouts
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- ----------------------------------------------------------
-- One row per tenant. Booking policy is intentionally singleton
-- (no per-offering overrides in v1) — keeps booking validation
-- simple. Per-offering overrides are post-v1.
CREATE TABLE booking_policies (
  tenant_id                       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- cancellation policy (3-field model, no multi-tier refunds in v1)
  free_cancel_hours_before        integer NOT NULL DEFAULT 24
                                  CHECK (free_cancel_hours_before >= 0),
  partial_refund_hours_before     integer
                                  CHECK (partial_refund_hours_before IS NULL
                                         OR partial_refund_hours_before >= 0),
  partial_refund_percent          integer
                                  CHECK (partial_refund_percent IS NULL
                                         OR (partial_refund_percent BETWEEN 0 AND 100)),
  -- no-show policy
  no_show_action                  text NOT NULL DEFAULT 'none'
                                  CHECK (no_show_action IN ('none', 'forfeit_credits',
                                                             'charge_fee', 'block_member')),
  no_show_fee_cents               integer
                                  CHECK (no_show_fee_cents IS NULL OR no_show_fee_cents >= 0),
  -- advance booking window
  min_advance_booking_minutes     integer NOT NULL DEFAULT 0
                                  CHECK (min_advance_booking_minutes >= 0),
  max_advance_booking_days        integer NOT NULL DEFAULT 30
                                  CHECK (max_advance_booking_days > 0),
  -- self-service modification
  allow_member_self_cancel        boolean NOT NULL DEFAULT true,
  allow_customer_self_cancel      boolean NOT NULL DEFAULT true,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id),
  -- partial refund config is internally consistent
  CHECK (
    (partial_refund_hours_before IS NULL AND partial_refund_percent IS NULL)
    OR
    (partial_refund_hours_before IS NOT NULL AND partial_refund_percent IS NOT NULL
     AND partial_refund_hours_before <= free_cancel_hours_before)
  ),
  -- if no_show_action is charge_fee, fee must be set
  CHECK (
    (no_show_action <> 'charge_fee')
    OR (no_show_fee_cents IS NOT NULL AND no_show_fee_cents > 0)
  ),
  -- advance booking window is internally consistent: min advance
  -- can't exceed max advance.
  CHECK (min_advance_booking_minutes <= max_advance_booking_days * 1440)
);

CREATE TRIGGER booking_policies_set_updated_at
  BEFORE UPDATE ON booking_policies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE booking_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY booking_policies_tenant_isolation ON booking_policies
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- ============================================================
-- LAYER 5: BOOKINGS
-- ============================================================

-- One booking per resource-time-slot, for both members (spend credits)
-- and customers (walk-ins, pay cash or card). Mutual exclusion between
-- member_id and customer_* fields is enforced by CHECK.
--
-- Resource assignment is required and constrained by the composite FK
-- to offering_resources, so a booking can only exist for a valid
-- (offering, resource) pair. Bookings persist after offering_resources
-- rows are deactivated (active = false), preserving history.
--
-- Slot exclusivity for resource bookings is enforced by a partial
-- exclusion constraint: two bookings with overlapping time_range on
-- the same resource cannot coexist unless one is cancelled. Only
-- cancelled bookings free up their slot; completed and no_show
-- remain on the calendar as historical records and continue to
-- block future inserts. Phrased negatively (status <> 'cancelled')
-- so any future status defaults to blocking.
--
-- pending_payment requires hold_expires_at — abandoned checkout sessions
-- otherwise hold cages forever. A janitor (Phase 3 deliverable) sweeps
-- expired holds and marks them cancelled.
--
-- Pricing/cost is snapshotted at booking time. amount_due_cents and
-- credit_cost_charged are the at-time-of-booking values; the offering's
-- current price/cost can change without affecting historical bookings.
--
-- Lifecycle audit fields (cancelled_at, cancelled_by_*, etc.) are on
-- the row itself rather than a separate booking_state_changes table —
-- support visibility without a full audit system.
CREATE TABLE bookings (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  offering_id                 uuid NOT NULL,
  resource_id                 uuid NOT NULL,

  -- identity: exactly one of (member_id) or (customer_*)
  member_id                   uuid,
  customer_first_name         text
                              CHECK (
                                customer_first_name IS NULL
                                OR (btrim(customer_first_name) <> ''
                                    AND customer_first_name = btrim(customer_first_name))
                              ),
  customer_last_name          text
                              CHECK (
                                customer_last_name IS NULL
                                OR (btrim(customer_last_name) <> ''
                                    AND customer_last_name = btrim(customer_last_name))
                              ),
  customer_email              text
                              CHECK (
                                customer_email IS NULL
                                OR (customer_email = lower(btrim(customer_email))
                                    AND btrim(customer_email) <> ''
                                    AND customer_email !~ '\s')
                              ),
  customer_phone              text,

  -- timing
  start_time                  timestamptz NOT NULL,
  end_time                    timestamptz NOT NULL,
  time_range                  tstzrange GENERATED ALWAYS AS (
                                tstzrange(start_time, end_time, '[)')
                              ) STORED,

  -- state
  status                      text NOT NULL DEFAULT 'confirmed'
                              CHECK (status IN ('pending_payment', 'confirmed',
                                                 'completed', 'no_show', 'cancelled')),
  hold_expires_at             timestamptz,

  -- price/cost snapshot at booking time
  amount_due_cents            integer NOT NULL CHECK (amount_due_cents >= 0),
  credit_cost_charged         integer NOT NULL DEFAULT 0 CHECK (credit_cost_charged >= 0),

  -- payment state
  amount_paid_cents           integer NOT NULL DEFAULT 0 CHECK (amount_paid_cents >= 0),
  amount_refunded_cents       integer NOT NULL DEFAULT 0 CHECK (amount_refunded_cents >= 0),
  payment_status              text NOT NULL DEFAULT 'not_required'
                              CHECK (payment_status IN ('not_required', 'pending', 'paid',
                                                         'refunded', 'partial_refund')),
  stripe_payment_intent_id    text,

  -- lifecycle audit
  cancelled_at                timestamptz,
  cancelled_by_type           text
                              CHECK (cancelled_by_type IS NULL
                                     OR cancelled_by_type IN ('member', 'customer', 'admin', 'system')),
  cancelled_by_user_id        uuid,
  cancellation_reason         text,
  no_show_marked_at           timestamptz,
  no_show_marked_by           uuid,

  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, id),
  -- needed for credit_ledger_entries composite FK that ensures a
  -- ledger entry's member_id matches the booking's member_id (no
  -- cross-member ledger entries via a wrong booking_id).
  UNIQUE (tenant_id, id, member_id),

  -- catalog FKs
  FOREIGN KEY (tenant_id, offering_id) REFERENCES offerings(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, resource_id) REFERENCES resources(tenant_id, id) ON DELETE RESTRICT,
  -- the integrity FK: prove resource is valid for this offering
  FOREIGN KEY (tenant_id, offering_id, resource_id)
    REFERENCES offering_resources(tenant_id, offering_id, resource_id)
    ON DELETE RESTRICT,
  -- identity FK
  FOREIGN KEY (tenant_id, member_id) REFERENCES members(tenant_id, id) ON DELETE RESTRICT,

  -- mutual exclusion: member XOR customer
  CHECK (
    (member_id IS NOT NULL
     AND customer_first_name IS NULL AND customer_last_name IS NULL
     AND customer_email IS NULL AND customer_phone IS NULL)
    OR
    (member_id IS NULL
     AND customer_first_name IS NOT NULL
     AND customer_last_name IS NOT NULL
     AND customer_email IS NOT NULL)
  ),

  -- payment shape: members spend credits (no money), customers owe
  -- money (no credits). Free member bookings are allowed
  -- (credit_cost_charged = 0 for "first class free" promos etc.).
  CHECK (
    (member_id IS NOT NULL AND amount_due_cents = 0 AND credit_cost_charged >= 0)
    OR
    (member_id IS NULL AND credit_cost_charged = 0)
  ),

  -- refunds can't exceed payments
  CHECK (amount_refunded_cents <= amount_paid_cents),

  -- pending_payment must have an expiry, and the hold can't outlast
  -- the slot itself (otherwise abandoned holds block real availability
  -- through the actual booked time). App code separately enforces a
  -- shorter hold duration (e.g. 15 min); the DB constraint is the
  -- absolute upper bound.
  CHECK (status <> 'pending_payment' OR hold_expires_at IS NOT NULL),
  CHECK (status <> 'pending_payment' OR hold_expires_at <= start_time),

  -- pending_payment is customer-only (members debit credits
  -- synchronously; there is no async payment to wait for). A
  -- pending_payment booking must be a customer booking with
  -- payment_status = 'pending'.
  CHECK (
    status <> 'pending_payment'
    OR (member_id IS NULL AND payment_status = 'pending')
  ),

  -- end after start
  CHECK (end_time > start_time),

  -- lifecycle consistency
  CHECK (status <> 'cancelled' OR cancelled_at IS NOT NULL),
  CHECK (status <> 'no_show' OR no_show_marked_at IS NOT NULL),
  CHECK (cancelled_by_type <> 'admin' OR cancelled_by_user_id IS NOT NULL),

  -- payment_status must agree with money fields. Caught via CASE so
  -- each state's invariants are explicit. Each state requires
  -- amount_due_cents > 0 (except 'not_required' which requires = 0).
  -- amount_paid >= amount_due (not =) because Stripe sometimes rounds
  -- up by a cent.
  CHECK (
    CASE payment_status
      WHEN 'not_required' THEN
        amount_due_cents = 0
        AND amount_paid_cents = 0
        AND amount_refunded_cents = 0
      WHEN 'pending' THEN
        amount_due_cents > 0
        AND amount_paid_cents = 0
        AND amount_refunded_cents = 0
      WHEN 'paid' THEN
        amount_due_cents > 0
        AND amount_paid_cents >= amount_due_cents
        AND amount_refunded_cents = 0
      WHEN 'partial_refund' THEN
        amount_due_cents > 0
        AND amount_paid_cents > 0
        AND amount_refunded_cents > 0
        AND amount_refunded_cents < amount_paid_cents
      WHEN 'refunded' THEN
        amount_due_cents > 0
        AND amount_paid_cents > 0
        AND amount_refunded_cents = amount_paid_cents
    END
  ),

  -- payment_status maps to member/customer identity:
  --   member bookings → always 'not_required' (credits, no money)
  --   customer free bookings → 'not_required' with $0 due
  --   customer paid bookings → some non-'not_required' state with $ due
  CHECK (
    (member_id IS NOT NULL AND payment_status = 'not_required')
    OR
    (member_id IS NULL
     AND ((payment_status = 'not_required' AND amount_due_cents = 0)
          OR (payment_status <> 'not_required' AND amount_due_cents > 0)))
  ),

  -- prevent overlapping bookings on same resource. Only 'cancelled'
  -- bookings don't block — completed and no_show are historical
  -- records and must remain immutable on the calendar. Phrased
  -- negatively (<> 'cancelled') so any future status defaults to
  -- blocking, which is the safe direction.
  EXCLUDE USING gist (
    tenant_id WITH =,
    resource_id WITH =,
    time_range WITH &&
  ) WHERE (status <> 'cancelled')
);

CREATE UNIQUE INDEX bookings_stripe_payment_intent_unique
  ON bookings (stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;

CREATE INDEX bookings_tenant_member_start_idx
  ON bookings (tenant_id, member_id, start_time DESC)
  WHERE member_id IS NOT NULL;

CREATE INDEX bookings_tenant_resource_start_idx
  ON bookings (tenant_id, resource_id, start_time);

CREATE INDEX bookings_tenant_status_start_idx
  ON bookings (tenant_id, status, start_time);

-- janitor index for sweeping expired pending holds
CREATE INDEX bookings_hold_expires_idx
  ON bookings (hold_expires_at)
  WHERE status = 'pending_payment';

CREATE TRIGGER bookings_set_updated_at
  BEFORE UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings FORCE ROW LEVEL SECURITY;
CREATE POLICY bookings_tenant_isolation ON bookings
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- ----------------------------------------------------------
-- Booking validity trigger.
--
-- The composite FKs prove the offering and resource exist and are a
-- valid pairing. They don't prove the booking is currently bookable.
-- This trigger validates the full bookability contract:
--   1. offering is active
--   2. offering capacity = 1 (classes go through class_bookings)
--   3. offering allows the booking's audience (member/customer)
--   4. resource is active
--   5. offering_resources link is active
--
-- We can't enforce these via FK because all five flags are runtime
-- gates, not referential constraints — historical bookings must
-- survive deactivation of any of them.
--
-- Trigger fires on INSERT and on UPDATE of the gating columns
-- (offering, resource, member, status). On UPDATE it short-circuits
-- when none of the gating fields changed, so historical bookings
-- can have payment, audit, or hold-expiry fields updated freely.
-- The exception: transitioning out of 'cancelled' (reactivating
-- a booking) forces re-validation against the current bookability
-- contract — even if no other gating field changed. A booking that
-- was cancelled while its offering was active can't be silently
-- reactivated after the offering has been deactivated.
CREATE OR REPLACE FUNCTION enforce_booking_validity() RETURNS trigger AS $$
DECLARE
  v_offering_active     boolean;
  v_offering_capacity   integer;
  v_offering_member_ok  boolean;
  v_offering_public_ok  boolean;
  v_resource_active     boolean;
  v_link_active         boolean;
  v_is_member_booking   boolean;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.offering_id IS NOT DISTINCT FROM OLD.offering_id
     AND NEW.resource_id IS NOT DISTINCT FROM OLD.resource_id
     AND NEW.member_id   IS NOT DISTINCT FROM OLD.member_id
     -- Force re-validation when transitioning out of cancelled.
     -- Reactivating a booking must satisfy the current bookability
     -- contract, even if no other gating field changed.
     AND NOT (OLD.status = 'cancelled' AND NEW.status <> 'cancelled') THEN
    RETURN NEW;
  END IF;

  v_is_member_booking := (NEW.member_id IS NOT NULL);

  -- Offering: exists, active, capacity = 1, audience allowed
  SELECT active, capacity, allow_member_booking, allow_public_booking
    INTO v_offering_active, v_offering_capacity,
         v_offering_member_ok, v_offering_public_ok
  FROM offerings
  WHERE tenant_id = NEW.tenant_id AND id = NEW.offering_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Offering % not found in tenant %',
      NEW.offering_id, NEW.tenant_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NOT v_offering_active THEN
    RAISE EXCEPTION 'Cannot book inactive offering %', NEW.offering_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_offering_capacity <> 1 THEN
    RAISE EXCEPTION 'Offering % is a class (capacity %), use class_bookings',
      NEW.offering_id, v_offering_capacity
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_is_member_booking AND NOT v_offering_member_ok THEN
    RAISE EXCEPTION 'Offering % does not allow member bookings', NEW.offering_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT v_is_member_booking AND NOT v_offering_public_ok THEN
    RAISE EXCEPTION 'Offering % does not allow public bookings', NEW.offering_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- Resource: active
  SELECT active INTO v_resource_active
  FROM resources
  WHERE tenant_id = NEW.tenant_id AND id = NEW.resource_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Resource % not found in tenant %',
      NEW.resource_id, NEW.tenant_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NOT v_resource_active THEN
    RAISE EXCEPTION 'Cannot book inactive resource %', NEW.resource_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- offering_resources link: active
  SELECT active INTO v_link_active
  FROM offering_resources
  WHERE tenant_id = NEW.tenant_id
    AND offering_id = NEW.offering_id
    AND resource_id = NEW.resource_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No offering_resources row for (offering=%, resource=%)',
      NEW.offering_id, NEW.resource_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NOT v_link_active THEN
    RAISE EXCEPTION 'Offering % is no longer offered on resource %',
      NEW.offering_id, NEW.resource_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER bookings_enforce_validity
  BEFORE INSERT OR UPDATE OF offering_id, resource_id, member_id, status ON bookings
  FOR EACH ROW EXECUTE FUNCTION enforce_booking_validity();

-- ----------------------------------------------------------
-- Now that bookings exists, add the FK from credit_ledger_entries
-- (was deferred from layer 3 due to circular dependency).
-- A booking referenced by a ledger entry can't be deleted; the ledger
-- is append-only and historical bookings preserve the audit trail.
--
-- The FK is composite over (tenant_id, booking_id, member_id) — not
-- just (tenant_id, booking_id) — so a ledger entry can't accidentally
-- reference a different member's booking.
--
-- This FK is fully enforced for any ledger row with a non-null
-- booking_id: credit_ledger_entries.member_id is NOT NULL, and a
-- customer booking has bookings.member_id = NULL, so a ledger entry
-- pointing at a customer booking would have its tuple
-- (tenant_id, customer_booking_id, ledger_member_id) fail to match
-- bookings(tenant_id, id, member_id). Customer bookings are
-- physically excluded from the ledger by the FK shape itself —
-- no extra trigger needed.
ALTER TABLE credit_ledger_entries
  ADD CONSTRAINT credit_ledger_entries_booking_id_fkey
  FOREIGN KEY (tenant_id, booking_id, member_id)
  REFERENCES bookings(tenant_id, id, member_id)
  ON DELETE RESTRICT;

-- ============================================================
-- LAYER 6: CLASSES
-- ============================================================

-- A class_schedule defines a recurring class. Simple weekly model:
-- "this offering, in this resource, every {day_of_week} at
-- {start_time}, from {start_date} until {end_date}."
--
-- Eager generation: when the schedule is created, the generator
-- creates class_instance rows for every matching date up to a
-- horizon (26 weeks for open-ended schedules; full range for
-- bounded schedules). A periodic job (Phase 4 deliverable) extends
-- the horizon for open-ended schedules as instances are consumed.
--
-- start_date IS the first class date — the day_of_week constraint
-- below enforces that. The wizard should default start_date to the
-- next matching day_of_week so the constraint is invisible to admins.
--
-- For one-off classes (no recurrence), admins create a class_instance
-- directly with class_schedule_id = NULL.
CREATE TABLE class_schedules (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  offering_id         uuid NOT NULL,
  resource_id         uuid NOT NULL,
  -- recurrence
  day_of_week         smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time          time NOT NULL,
  start_date          date NOT NULL,
  end_date            date,                                 -- NULL = open-ended
  -- generator state
  generated_through   date,                                 -- last date generator has reached
  active              boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, offering_id) REFERENCES offerings(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, resource_id) REFERENCES resources(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, offering_id, resource_id)
    REFERENCES offering_resources(tenant_id, offering_id, resource_id)
    ON DELETE RESTRICT,

  -- start_date must fall on the configured day_of_week.
  -- Postgres EXTRACT(DOW) returns 0 = Sunday, matching our convention.
  CHECK (extract(dow from start_date)::smallint = day_of_week),
  CHECK (end_date IS NULL OR end_date >= start_date),

  -- needed for class_instances composite FK that ensures an instance
  -- inherits its schedule's offering (resource can be overridden;
  -- offering can't drift).
  UNIQUE (tenant_id, id, offering_id)
);

CREATE TRIGGER class_schedules_set_updated_at
  BEFORE UPDATE ON class_schedules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE class_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE class_schedules FORCE ROW LEVEL SECURITY;
CREATE POLICY class_schedules_tenant_isolation ON class_schedules
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- ----------------------------------------------------------
-- Validity trigger for class_schedules. Same checks as
-- enforce_class_instance_validity (offering active, capacity > 1,
-- resource active, link active) — fired when the schedule is
-- created or its offering/resource changes. Catches invalid
-- schedules before they generate bad instances.
CREATE OR REPLACE FUNCTION enforce_class_schedule_validity() RETURNS trigger AS $$
DECLARE
  v_offering_active     boolean;
  v_offering_capacity   integer;
  v_resource_active     boolean;
  v_link_active         boolean;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.offering_id IS NOT DISTINCT FROM OLD.offering_id
     AND NEW.resource_id IS NOT DISTINCT FROM OLD.resource_id THEN
    RETURN NEW;
  END IF;

  SELECT active, capacity INTO v_offering_active, v_offering_capacity
  FROM offerings
  WHERE tenant_id = NEW.tenant_id AND id = NEW.offering_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Offering % not found in tenant %',
      NEW.offering_id, NEW.tenant_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NOT v_offering_active THEN
    RAISE EXCEPTION 'Cannot create schedule for inactive offering %', NEW.offering_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_offering_capacity = 1 THEN
    RAISE EXCEPTION 'Offering % is a rental (capacity 1), cannot have a class schedule',
      NEW.offering_id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT active INTO v_resource_active
  FROM resources
  WHERE tenant_id = NEW.tenant_id AND id = NEW.resource_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Resource % not found in tenant %',
      NEW.resource_id, NEW.tenant_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NOT v_resource_active THEN
    RAISE EXCEPTION 'Cannot create schedule on inactive resource %', NEW.resource_id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT active INTO v_link_active
  FROM offering_resources
  WHERE tenant_id = NEW.tenant_id
    AND offering_id = NEW.offering_id
    AND resource_id = NEW.resource_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No offering_resources row for (offering=%, resource=%)',
      NEW.offering_id, NEW.resource_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NOT v_link_active THEN
    RAISE EXCEPTION 'Offering % is no longer offered on resource %',
      NEW.offering_id, NEW.resource_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER class_schedules_enforce_validity
  BEFORE INSERT OR UPDATE OF offering_id, resource_id ON class_schedules
  FOR EACH ROW EXECUTE FUNCTION enforce_class_schedule_validity();

-- ----------------------------------------------------------
-- A class_instance is a single occurrence of a class. Generated
-- from a class_schedule (recurring), or created directly by admin
-- (one-off, class_schedule_id = NULL).
--
-- capacity is snapshotted from the offering at generation/creation
-- time. Changing the offering's capacity later doesn't affect
-- existing instances — same snapshot pattern as booking pricing.
--
-- resource_id is also snapshotted (initially from the schedule, but
-- editable per-instance). If Cage 4 is broken on July 12, admin can
-- change that one instance to Cage 5 without affecting the rest of
-- the series.
--
-- Cancellation of an entire instance: set cancelled_at + reason.
-- App code cascades to all class_bookings for the instance. The
-- exclusion constraint excludes cancelled instances so the slot
-- can be reused.
CREATE TABLE class_instances (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  class_schedule_id       uuid,                             -- NULL = one-off
  offering_id             uuid NOT NULL,
  resource_id             uuid NOT NULL,
  start_time              timestamptz NOT NULL,
  end_time                timestamptz NOT NULL,
  time_range              tstzrange GENERATED ALWAYS AS (
                            tstzrange(start_time, end_time, '[)')
                          ) STORED,
  capacity                integer NOT NULL CHECK (capacity >= 1),
  -- cancellation
  cancelled_at            timestamptz,
  cancellation_reason     text,
  cancelled_by_user_id    uuid,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, id),

  FOREIGN KEY (tenant_id, class_schedule_id)
    REFERENCES class_schedules(tenant_id, id)
    ON DELETE RESTRICT,
  -- Prevents offering drift between schedule and instance. When
  -- class_schedule_id is set, the instance's offering must match the
  -- schedule's offering (composite FKs only fire when all columns
  -- are non-null, so one-offs with class_schedule_id = NULL skip
  -- this check correctly). Resource can still be overridden per
  -- instance — that's intentional. Offering can't drift.
  FOREIGN KEY (tenant_id, class_schedule_id, offering_id)
    REFERENCES class_schedules(tenant_id, id, offering_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, offering_id) REFERENCES offerings(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, resource_id) REFERENCES resources(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, offering_id, resource_id)
    REFERENCES offering_resources(tenant_id, offering_id, resource_id)
    ON DELETE RESTRICT,

  CHECK (end_time > start_time),

  -- prevent overlapping non-cancelled instances on same resource
  EXCLUDE USING gist (
    tenant_id WITH =,
    resource_id WITH =,
    time_range WITH &&
  ) WHERE (cancelled_at IS NULL)
);

-- Idempotency: generator can safely retry without creating duplicate
-- instances. Partial because one-offs don't have a schedule_id.
CREATE UNIQUE INDEX class_instances_generation_unique
  ON class_instances (tenant_id, class_schedule_id, start_time)
  WHERE class_schedule_id IS NOT NULL;

CREATE INDEX class_instances_tenant_resource_start_idx
  ON class_instances (tenant_id, resource_id, start_time);

CREATE INDEX class_instances_schedule_idx
  ON class_instances (tenant_id, class_schedule_id, start_time)
  WHERE class_schedule_id IS NOT NULL;

CREATE TRIGGER class_instances_set_updated_at
  BEFORE UPDATE ON class_instances
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE class_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE class_instances FORCE ROW LEVEL SECURITY;
CREATE POLICY class_instances_tenant_isolation ON class_instances
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- ----------------------------------------------------------
-- Validity trigger for class_instances. Same pattern as
-- enforce_booking_validity but with capacity > 1 (instead of = 1)
-- and skipping the audience check (classes can be either members or
-- customers depending on which class_bookings show up).
CREATE OR REPLACE FUNCTION enforce_class_instance_validity() RETURNS trigger AS $$
DECLARE
  v_offering_active     boolean;
  v_offering_capacity   integer;
  v_resource_active     boolean;
  v_link_active         boolean;
BEGIN
  -- Skip on UPDATE if the gating fields didn't change and we're not
  -- transitioning out of cancelled.
  IF TG_OP = 'UPDATE'
     AND NEW.offering_id IS NOT DISTINCT FROM OLD.offering_id
     AND NEW.resource_id IS NOT DISTINCT FROM OLD.resource_id
     AND NOT (OLD.cancelled_at IS NOT NULL AND NEW.cancelled_at IS NULL) THEN
    RETURN NEW;
  END IF;

  SELECT active, capacity INTO v_offering_active, v_offering_capacity
  FROM offerings
  WHERE tenant_id = NEW.tenant_id AND id = NEW.offering_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Offering % not found in tenant %',
      NEW.offering_id, NEW.tenant_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NOT v_offering_active THEN
    RAISE EXCEPTION 'Cannot create class instance for inactive offering %', NEW.offering_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_offering_capacity = 1 THEN
    RAISE EXCEPTION 'Offering % is a rental (capacity 1), use bookings table', NEW.offering_id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT active INTO v_resource_active
  FROM resources
  WHERE tenant_id = NEW.tenant_id AND id = NEW.resource_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Resource % not found in tenant %',
      NEW.resource_id, NEW.tenant_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NOT v_resource_active THEN
    RAISE EXCEPTION 'Cannot create class instance on inactive resource %', NEW.resource_id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT active INTO v_link_active
  FROM offering_resources
  WHERE tenant_id = NEW.tenant_id
    AND offering_id = NEW.offering_id
    AND resource_id = NEW.resource_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No offering_resources row for (offering=%, resource=%)',
      NEW.offering_id, NEW.resource_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NOT v_link_active THEN
    RAISE EXCEPTION 'Offering % is no longer offered on resource %',
      NEW.offering_id, NEW.resource_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER class_instances_enforce_validity
  BEFORE INSERT OR UPDATE OF offering_id, resource_id, cancelled_at ON class_instances
  FOR EACH ROW EXECUTE FUNCTION enforce_class_instance_validity();

-- ----------------------------------------------------------
-- Cross-table resource conflict prevention.
--
-- bookings.exclusion prevents rental-vs-rental overlap on a resource.
-- class_instances.exclusion prevents class-vs-class overlap.
-- Neither catches rental-vs-class. These triggers do.
--
-- Pattern: BEFORE INSERT/UPDATE on each table, lock the resource row
-- FOR UPDATE (serializes against concurrent inserts on the OTHER
-- table), then check for an overlapping non-cancelled reservation
-- in the other table on the same resource.
CREATE OR REPLACE FUNCTION enforce_no_class_overlap_on_booking() RETURNS trigger AS $$
DECLARE
  v_conflict_count integer;
BEGIN
  -- Only check when the booking would block availability
  IF NEW.status = 'cancelled' THEN
    RETURN NEW;
  END IF;
  -- Skip if the time/resource didn't change on UPDATE
  IF TG_OP = 'UPDATE'
     AND NEW.resource_id IS NOT DISTINCT FROM OLD.resource_id
     AND NEW.start_time  IS NOT DISTINCT FROM OLD.start_time
     AND NEW.end_time    IS NOT DISTINCT FROM OLD.end_time
     AND OLD.status <> 'cancelled' THEN
    RETURN NEW;
  END IF;

  -- Lock the resource row to serialize against concurrent class_instances inserts
  PERFORM 1 FROM resources
  WHERE tenant_id = NEW.tenant_id AND id = NEW.resource_id
  FOR UPDATE;

  -- Look for any overlapping non-cancelled class_instances on this resource
  SELECT count(*) INTO v_conflict_count
  FROM class_instances
  WHERE tenant_id = NEW.tenant_id
    AND resource_id = NEW.resource_id
    AND cancelled_at IS NULL
    AND time_range && tstzrange(NEW.start_time, NEW.end_time, '[)');

  IF v_conflict_count > 0 THEN
    RAISE EXCEPTION 'Booking conflicts with an existing class instance on resource % at this time',
      NEW.resource_id
      USING ERRCODE = 'exclusion_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER bookings_no_class_overlap
  BEFORE INSERT OR UPDATE OF resource_id, start_time, end_time, status ON bookings
  FOR EACH ROW EXECUTE FUNCTION enforce_no_class_overlap_on_booking();

CREATE OR REPLACE FUNCTION enforce_no_booking_overlap_on_class_instance() RETURNS trigger AS $$
DECLARE
  v_conflict_count integer;
BEGIN
  -- Only check when the instance would block availability
  IF NEW.cancelled_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  -- Skip if the time/resource didn't change and was already non-cancelled
  IF TG_OP = 'UPDATE'
     AND NEW.resource_id IS NOT DISTINCT FROM OLD.resource_id
     AND NEW.start_time  IS NOT DISTINCT FROM OLD.start_time
     AND NEW.end_time    IS NOT DISTINCT FROM OLD.end_time
     AND OLD.cancelled_at IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM 1 FROM resources
  WHERE tenant_id = NEW.tenant_id AND id = NEW.resource_id
  FOR UPDATE;

  SELECT count(*) INTO v_conflict_count
  FROM bookings
  WHERE tenant_id = NEW.tenant_id
    AND resource_id = NEW.resource_id
    AND status <> 'cancelled'
    AND time_range && tstzrange(NEW.start_time, NEW.end_time, '[)');

  IF v_conflict_count > 0 THEN
    RAISE EXCEPTION 'Class instance conflicts with an existing booking on resource % at this time',
      NEW.resource_id
      USING ERRCODE = 'exclusion_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER class_instances_no_booking_overlap
  BEFORE INSERT OR UPDATE OF resource_id, start_time, end_time, cancelled_at ON class_instances
  FOR EACH ROW EXECUTE FUNCTION enforce_no_booking_overlap_on_class_instance();

-- ----------------------------------------------------------
-- Class roster entries. One row per person who has a spot in a class
-- instance. Same identity (member XOR customer), state machine,
-- payment fields, and audit columns as bookings — but no time or
-- resource (those come from the class_instance) and capacity is
-- enforced by trigger rather than exclusion constraint.
CREATE TABLE class_bookings (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  class_instance_id           uuid NOT NULL,

  -- identity: exactly one of (member_id) or (customer_*)
  member_id                   uuid,
  customer_first_name         text
                              CHECK (
                                customer_first_name IS NULL
                                OR (btrim(customer_first_name) <> ''
                                    AND customer_first_name = btrim(customer_first_name))
                              ),
  customer_last_name          text
                              CHECK (
                                customer_last_name IS NULL
                                OR (btrim(customer_last_name) <> ''
                                    AND customer_last_name = btrim(customer_last_name))
                              ),
  customer_email              text
                              CHECK (
                                customer_email IS NULL
                                OR (customer_email = lower(btrim(customer_email))
                                    AND btrim(customer_email) <> ''
                                    AND customer_email !~ '\s')
                              ),
  customer_phone              text,

  -- state
  status                      text NOT NULL DEFAULT 'confirmed'
                              CHECK (status IN ('pending_payment', 'confirmed',
                                                 'completed', 'no_show', 'cancelled')),
  hold_expires_at             timestamptz,

  -- price/cost snapshot at booking time
  amount_due_cents            integer NOT NULL CHECK (amount_due_cents >= 0),
  credit_cost_charged         integer NOT NULL DEFAULT 0 CHECK (credit_cost_charged >= 0),

  -- payment state
  amount_paid_cents           integer NOT NULL DEFAULT 0 CHECK (amount_paid_cents >= 0),
  amount_refunded_cents       integer NOT NULL DEFAULT 0 CHECK (amount_refunded_cents >= 0),
  payment_status              text NOT NULL DEFAULT 'not_required'
                              CHECK (payment_status IN ('not_required', 'pending', 'paid',
                                                         'refunded', 'partial_refund')),
  stripe_payment_intent_id    text,

  -- lifecycle audit
  cancelled_at                timestamptz,
  cancelled_by_type           text
                              CHECK (cancelled_by_type IS NULL
                                     OR cancelled_by_type IN ('member', 'customer', 'admin', 'system')),
  cancelled_by_user_id        uuid,
  cancellation_reason         text,
  no_show_marked_at           timestamptz,
  no_show_marked_by           uuid,

  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, id),
  -- needed for credit_ledger_entries.class_booking_id composite FK
  UNIQUE (tenant_id, id, member_id),

  FOREIGN KEY (tenant_id, class_instance_id) REFERENCES class_instances(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, member_id) REFERENCES members(tenant_id, id) ON DELETE RESTRICT,

  -- mutual exclusion: member XOR customer (same as bookings)
  CHECK (
    (member_id IS NOT NULL
     AND customer_first_name IS NULL AND customer_last_name IS NULL
     AND customer_email IS NULL AND customer_phone IS NULL)
    OR
    (member_id IS NULL
     AND customer_first_name IS NOT NULL
     AND customer_last_name IS NOT NULL
     AND customer_email IS NOT NULL)
  ),

  -- payment shape (same as bookings)
  CHECK (
    (member_id IS NOT NULL AND amount_due_cents = 0 AND credit_cost_charged >= 0)
    OR
    (member_id IS NULL AND credit_cost_charged = 0)
  ),

  CHECK (amount_refunded_cents <= amount_paid_cents),

  -- pending_payment + hold expiry constraints (same as bookings)
  CHECK (status <> 'pending_payment' OR hold_expires_at IS NOT NULL),
  CHECK (
    status <> 'pending_payment'
    OR (member_id IS NULL AND payment_status = 'pending')
  ),

  -- lifecycle consistency (same as bookings)
  CHECK (status <> 'cancelled' OR cancelled_at IS NOT NULL),
  CHECK (status <> 'no_show' OR no_show_marked_at IS NOT NULL),
  CHECK (cancelled_by_type <> 'admin' OR cancelled_by_user_id IS NOT NULL),

  -- payment_status invariants (same CASE as bookings)
  CHECK (
    CASE payment_status
      WHEN 'not_required' THEN
        amount_due_cents = 0
        AND amount_paid_cents = 0
        AND amount_refunded_cents = 0
      WHEN 'pending' THEN
        amount_due_cents > 0
        AND amount_paid_cents = 0
        AND amount_refunded_cents = 0
      WHEN 'paid' THEN
        amount_due_cents > 0
        AND amount_paid_cents >= amount_due_cents
        AND amount_refunded_cents = 0
      WHEN 'partial_refund' THEN
        amount_due_cents > 0
        AND amount_paid_cents > 0
        AND amount_refunded_cents > 0
        AND amount_refunded_cents < amount_paid_cents
      WHEN 'refunded' THEN
        amount_due_cents > 0
        AND amount_paid_cents > 0
        AND amount_refunded_cents = amount_paid_cents
    END
  ),

  -- payment_status / member-customer cross-check (same as bookings)
  CHECK (
    (member_id IS NOT NULL AND payment_status = 'not_required')
    OR
    (member_id IS NULL
     AND ((payment_status = 'not_required' AND amount_due_cents = 0)
          OR (payment_status <> 'not_required' AND amount_due_cents > 0)))
  )
);

-- One member can't hold two non-cancelled spots in the same class instance
CREATE UNIQUE INDEX class_bookings_member_per_instance_unique
  ON class_bookings (tenant_id, class_instance_id, member_id)
  WHERE member_id IS NOT NULL AND status <> 'cancelled';

CREATE UNIQUE INDEX class_bookings_stripe_payment_intent_unique
  ON class_bookings (stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;

CREATE INDEX class_bookings_tenant_member_idx
  ON class_bookings (tenant_id, member_id, created_at DESC)
  WHERE member_id IS NOT NULL;

CREATE INDEX class_bookings_instance_status_idx
  ON class_bookings (tenant_id, class_instance_id, status);

CREATE INDEX class_bookings_hold_expires_idx
  ON class_bookings (hold_expires_at)
  WHERE status = 'pending_payment';

CREATE TRIGGER class_bookings_set_updated_at
  BEFORE UPDATE ON class_bookings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE class_bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE class_bookings FORCE ROW LEVEL SECURITY;
CREATE POLICY class_bookings_tenant_isolation ON class_bookings
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- ----------------------------------------------------------
-- Class booking capacity enforcement.
--
-- Belt and suspenders: app code does SELECT ... FOR UPDATE on the
-- class_instance row inside the booking transaction to serialize
-- the count check. This trigger is the safety net.
--
-- Capacity counts non-cancelled bookings only. Completed and no_show
-- bookings still occupied a seat (historical integrity, same lesson
-- as the bookings exclusion constraint).
CREATE OR REPLACE FUNCTION enforce_class_capacity() RETURNS trigger AS $$
DECLARE
  v_capacity integer;
  v_current  integer;
BEGIN
  -- Only check when this row is in a counting state
  IF NEW.status = 'cancelled' THEN
    RETURN NEW;
  END IF;
  -- Skip if old row was already counting (status moves between
  -- counting states, e.g. pending_payment → confirmed, don't change
  -- the count)
  IF TG_OP = 'UPDATE' AND OLD.status <> 'cancelled' THEN
    RETURN NEW;
  END IF;

  -- Lock the instance row to serialize concurrent inserts
  SELECT capacity INTO v_capacity
  FROM class_instances
  WHERE tenant_id = NEW.tenant_id AND id = NEW.class_instance_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Class instance % not found', NEW.class_instance_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  SELECT count(*) INTO v_current
  FROM class_bookings
  WHERE tenant_id = NEW.tenant_id
    AND class_instance_id = NEW.class_instance_id
    AND status <> 'cancelled'
    -- Don't double-count the row being updated
    AND (TG_OP = 'INSERT' OR id <> NEW.id);

  IF v_current >= v_capacity THEN
    RAISE EXCEPTION 'Class instance % is at capacity (%)',
      NEW.class_instance_id, v_capacity
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER class_bookings_enforce_capacity
  BEFORE INSERT OR UPDATE OF status ON class_bookings
  FOR EACH ROW EXECUTE FUNCTION enforce_class_capacity();

-- ----------------------------------------------------------
-- Class booking validity trigger.
--
-- The composite FKs prove the instance and member exist; this
-- trigger validates the full bookability contract at booking time.
-- Specifically:
--   1. instance is not cancelled
--   2. offering still active (could have been deactivated since
--      instance generation)
--   3. offering allows the booking's audience
--   4. resource still active
--   5. offering_resources link still active
--   6. for pending_payment: hold_expires_at <= instance.start_time
--      (mirrors the analogous check on bookings)
--
-- Same skip-on-no-change pattern as enforce_booking_validity, with
-- forced re-validation when transitioning out of cancelled.
CREATE OR REPLACE FUNCTION enforce_class_booking_validity() RETURNS trigger AS $$
DECLARE
  v_instance_cancelled  timestamptz;
  v_instance_offering   uuid;
  v_instance_resource   uuid;
  v_instance_start      timestamptz;
  v_offering_active     boolean;
  v_offering_member_ok  boolean;
  v_offering_public_ok  boolean;
  v_resource_active     boolean;
  v_link_active         boolean;
  v_is_member_booking   boolean;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.class_instance_id IS NOT DISTINCT FROM OLD.class_instance_id
     AND NEW.member_id         IS NOT DISTINCT FROM OLD.member_id
     AND NEW.hold_expires_at   IS NOT DISTINCT FROM OLD.hold_expires_at
     AND NOT (OLD.status = 'cancelled' AND NEW.status <> 'cancelled')
     -- Force re-validation when transitioning INTO pending_payment.
     -- Otherwise a row can flip back into pending_payment with a stale
     -- hold_expires_at that now outlasts the (possibly moved-earlier)
     -- instance start, and the cross-table hold-bound check below
     -- gets skipped.
     AND NOT (OLD.status <> 'pending_payment' AND NEW.status = 'pending_payment') THEN
    RETURN NEW;
  END IF;

  v_is_member_booking := (NEW.member_id IS NOT NULL);

  -- Instance: exists, not cancelled
  SELECT cancelled_at, offering_id, resource_id, start_time
    INTO v_instance_cancelled, v_instance_offering, v_instance_resource, v_instance_start
  FROM class_instances
  WHERE tenant_id = NEW.tenant_id AND id = NEW.class_instance_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Class instance % not found in tenant %',
      NEW.class_instance_id, NEW.tenant_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF v_instance_cancelled IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot book cancelled class instance %', NEW.class_instance_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- Offering: still active, audience allowed
  SELECT active, allow_member_booking, allow_public_booking
    INTO v_offering_active, v_offering_member_ok, v_offering_public_ok
  FROM offerings
  WHERE tenant_id = NEW.tenant_id AND id = v_instance_offering;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Offering % not found', v_instance_offering
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NOT v_offering_active THEN
    RAISE EXCEPTION 'Offering % has been deactivated', v_instance_offering
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_is_member_booking AND NOT v_offering_member_ok THEN
    RAISE EXCEPTION 'Offering % does not allow member bookings', v_instance_offering
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT v_is_member_booking AND NOT v_offering_public_ok THEN
    RAISE EXCEPTION 'Offering % does not allow public bookings', v_instance_offering
      USING ERRCODE = 'check_violation';
  END IF;

  -- Resource: still active
  SELECT active INTO v_resource_active
  FROM resources
  WHERE tenant_id = NEW.tenant_id AND id = v_instance_resource;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Resource % not found', v_instance_resource
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NOT v_resource_active THEN
    RAISE EXCEPTION 'Resource % has been deactivated', v_instance_resource
      USING ERRCODE = 'check_violation';
  END IF;

  -- offering_resources link: still active
  SELECT active INTO v_link_active
  FROM offering_resources
  WHERE tenant_id = NEW.tenant_id
    AND offering_id = v_instance_offering
    AND resource_id = v_instance_resource;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No offering_resources row for (offering=%, resource=%)',
      v_instance_offering, v_instance_resource
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NOT v_link_active THEN
    RAISE EXCEPTION 'Offering % is no longer offered on resource %',
      v_instance_offering, v_instance_resource
      USING ERRCODE = 'check_violation';
  END IF;

  -- pending_payment hold can't outlast the instance start
  IF NEW.status = 'pending_payment' AND NEW.hold_expires_at > v_instance_start THEN
    RAISE EXCEPTION 'Hold expires after class instance start time'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER class_bookings_enforce_validity
  BEFORE INSERT OR UPDATE OF class_instance_id, member_id, status, hold_expires_at ON class_bookings
  FOR EACH ROW EXECUTE FUNCTION enforce_class_booking_validity();

-- ----------------------------------------------------------
-- Prevent class_instance_id from changing after insert. Moving a
-- booking between class instances breaks too many invariants
-- (capacity, payment audit, refund tracking). If a tenant ever needs
-- "move this person to a different class," app code does
-- cancel-and-rebook — explicit, auditable.
CREATE OR REPLACE FUNCTION prevent_class_instance_id_change() RETURNS trigger AS $$
BEGIN
  IF NEW.class_instance_id IS DISTINCT FROM OLD.class_instance_id THEN
    RAISE EXCEPTION 'class_instance_id is immutable; cancel and rebook instead'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER class_bookings_immutable_instance
  BEFORE UPDATE OF class_instance_id ON class_bookings
  FOR EACH ROW EXECUTE FUNCTION prevent_class_instance_id_change();

-- ============================================================
-- LAYER 7: STRIPE CONNECT
-- ============================================================

-- One row per tenant. Stores the tenant's Stripe Connect account
-- (Standard) info and platform fee configuration.
--
-- A connection exists once a tenant clicks "Connect Stripe" — but
-- they may not have completed onboarding. The three booleans
-- (details_submitted, charges_enabled, payouts_enabled) track Stripe's
-- own readiness state. App code uses charges_enabled to gate "can
-- this tenant accept payments yet."
--
-- platform_fee_basis_points is the application_fee Connect skims on
-- behalf of the platform. Stored in basis points (10000 = 100%) to
-- avoid decimal money math entirely. Default 0 means the platform
-- doesn't take a cut; tenants pay only the flat SaaS fee.
CREATE TABLE stripe_connections (
  tenant_id                   uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  stripe_account_id           text NOT NULL UNIQUE,
  details_submitted           boolean NOT NULL DEFAULT false,
  charges_enabled             boolean NOT NULL DEFAULT false,
  payouts_enabled             boolean NOT NULL DEFAULT false,
  platform_fee_basis_points   integer NOT NULL DEFAULT 0
                              CHECK (platform_fee_basis_points BETWEEN 0 AND 10000),
  connected_at                timestamptz NOT NULL DEFAULT now(),
  fully_onboarded_at          timestamptz,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER stripe_connections_set_updated_at
  BEFORE UPDATE ON stripe_connections
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE stripe_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY stripe_connections_tenant_isolation ON stripe_connections
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- ----------------------------------------------------------
-- Stripe webhook tenant resolution (migration 015).
--
-- Stripe POSTs to /webhooks/stripe from api.stripe.com, NOT from a
-- tenant subdomain. The handler can't use the resolveTenant +
-- withTenantContext middleware sandwich; it has to bootstrap tenant
-- context from the event payload (event.account = the connected
-- Stripe account id).
--
-- stripe_connections has FORCE ROW LEVEL SECURITY, so the runtime
-- role can't read it without the GUC already set. This is the
-- chicken-and-egg the webhook has to break.
--
-- Pattern matches apply_credit_change: SECURITY DEFINER, owned by
-- the migration role (postgres / supabase admin) which bypasses
-- FORCE RLS. Returns ONLY the tenant_id — no other columns leak.
-- The webhook handler uses that tenant_id to set the GUC and then
-- proceeds normally with RLS in effect for the actual UPDATE.
CREATE OR REPLACE FUNCTION lookup_tenant_by_stripe_account(p_account_id text)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
  SELECT tenant_id
    FROM stripe_connections
   WHERE stripe_account_id = p_account_id
   LIMIT 1;
$$;

REVOKE ALL ON FUNCTION lookup_tenant_by_stripe_account(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lookup_tenant_by_stripe_account(text) TO app_runtime;

COMMENT ON FUNCTION lookup_tenant_by_stripe_account(text) IS
  'Stripe-webhook tenant resolution. Bypasses RLS via SECURITY DEFINER '
  'because the webhook has no GUC set yet. Returns only the tenant_id; '
  'caller sets app.current_tenant_id and proceeds with RLS in effect.';

-- ============================================================
-- LAYER 8: CLEANUP — credit_ledger_entries class_booking_id
-- ============================================================

-- Now that class_bookings exists, add the analogous FK to ledger
-- entries for class booking spend/refund tracking.
ALTER TABLE credit_ledger_entries ADD COLUMN class_booking_id uuid;

ALTER TABLE credit_ledger_entries
  ADD CONSTRAINT credit_ledger_entries_class_booking_id_fkey
  FOREIGN KEY (tenant_id, class_booking_id, member_id)
  REFERENCES class_bookings(tenant_id, id, member_id)
  ON DELETE RESTRICT;

-- Replace the named single-booking CHECK with one that requires
-- exactly one of booking_id or class_booking_id for booking_*
-- reasons. The original constraint was named explicitly
-- (credit_ledger_entries_booking_ref_check) so this drop is
-- deterministic, not a discovery query.
ALTER TABLE credit_ledger_entries
  DROP CONSTRAINT credit_ledger_entries_booking_ref_check;

ALTER TABLE credit_ledger_entries
  ADD CONSTRAINT credit_ledger_entries_booking_ref_check
  CHECK (
    (reason IN ('booking_spend', 'booking_refund'))
    = ((booking_id IS NOT NULL) OR (class_booking_id IS NOT NULL))
  );

ALTER TABLE credit_ledger_entries
  ADD CONSTRAINT credit_ledger_entries_no_double_booking_ref
  CHECK (NOT (booking_id IS NOT NULL AND class_booking_id IS NOT NULL));

-- ============================================================
-- TODO — NEXT STEPS (out of schema)
-- ============================================================
-- Schema is complete. All remaining work is application/operational:
--
-- Phase 0 implementation (privilege & view work):
-- - Grant runtime role SELECT on tenant_lookup (defined above).
-- - REVOKE all direct access to the tenants table from the runtime
--   role; only migration / super-admin role can read it.
-- - Smoke test: runtime role cannot read platform_stripe_*, status,
--   or trial_ends_at columns from tenants. If it can, the privilege
--   setup is broken.
-- - Runtime role configuration: not a superuser, no BYPASSRLS, not a
--   table owner. With FORCE ROW LEVEL SECURITY on every tenant-scoped
--   table, RLS applies regardless.
-- - Cross-tenant operations use one of:
--     1. SECURITY DEFINER functions owned by a privileged role with
--        explicit cross-tenant semantics (e.g. super_admin_*).
--     2. A separate connection as a privileged role (BYPASSRLS or
--        superuser) for migrations and ad-hoc maintenance. Supabase's
--        `postgres` role + SQL editor handles this for ops work.
--   `SET row_security = off` is NOT a bypass — for non-privileged
--   roles it makes queries error if RLS would filter, which is a
--   useful safety net but not what we use for intentional cross-tenant
--   work.
--
-- Phase 2 implementation:
-- - apply_credit_change(...) SECURITY DEFINER function that does the
--   SELECT FOR UPDATE on credit_balances, computes new balance,
--   inserts a credit_ledger_entries row, updates the balance row,
--   all atomically. Verifies p_tenant_id matches
--   current_setting('app.current_tenant_id').
-- - Revoke INSERT/UPDATE/DELETE on credit_balances and
--   credit_ledger_entries from runtime role (only the function owner
--   can write).
-- - More granular RLS policies (e.g. members can only read their own
--   row, admins can read all rows in their tenant). Current policies
--   are tenant-isolation only.
--
-- Phase 3 implementation:
-- - Hold-expiry janitor: sweep bookings AND class_bookings WHERE
--   status = 'pending_payment' AND hold_expires_at < now(), mark
--   them cancelled, free credits/payments. Indexes
--   bookings_hold_expires_idx and class_bookings_hold_expires_idx
--   support the sweep query.
--
-- Phase 4 implementation:
-- - Class instance horizon extender: for class_schedules with
--   end_date = NULL, periodically generate more class_instances when
--   the existing horizon (generated_through) is running out. Uses
--   class_instances_generation_unique to be idempotent.
--
-- Phase 5 implementation:
-- - Janitor sweeping `incomplete` subscriptions older than 24h
--   to mark them cancelled. Stripe normally fires
--   `incomplete_expired` automatically; this is the safety net for
--   missed webhooks.
