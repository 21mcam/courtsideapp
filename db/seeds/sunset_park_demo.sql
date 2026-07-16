-- ============================================================================
-- DEMO SEED — Sunset Park Baseball
-- ============================================================================
--
-- A complete, working demo tenant for sales demos: facility, admin login,
-- resources, offerings, operating hours, plans, members (with credits and
-- active subscriptions), and a handful of sample bookings so the admin
-- calendar looks alive.
--
-- HOW TO RUN
--   Paste this whole file into the Supabase SQL editor for the Courtside
--   project and run it, as the default (postgres) role. It is NOT a
--   migration — do not add it to db/migrations.
--
-- DEMO LOGIN (after seeding)
--   URL:      https://sunsetpark.<your-app-domain>/
--   Admin:    owner@sunsetparkbaseball.com   password: sunset2026   (role: admin)
--   Member:   marcus@example.com             password: sunset2026
--   Member:   priya@example.com              password: sunset2026
--   (Danny Kim and Sofia Martinez are members without a login — imported style.)
--
-- RE-RUNNING
--   create_tenant_with_owner() fails if subdomain 'sunsetpark' already
--   exists. To wipe and re-seed, uncomment the DELETE below (it cascades
--   to every child row via ON DELETE CASCADE) and run again.
--
-- DELETE FROM tenants WHERE subdomain = 'sunsetpark';
--
-- ============================================================================
-- PART A — facility, catalog, members, plans, subscriptions, credits (atomic)
-- ============================================================================

DO $seed$
DECLARE
  -- bcrypt hash of 'sunset2026' (bcryptjs, cost 10). Shared by all seeded
  -- logins — same password for every demo account, which is fine for a demo.
  v_pw text := '$2a$10$DyKyqbCD9KSq5SkupRg.pu2wDUPEnNnQG27y8bAClJICV4GwdBgXm';

  v_tenant_id      uuid;
  v_owner_user_id  uuid;
  v_owner_admin_id uuid;

  v_cage1   uuid;
  v_cage2   uuid;
  v_cage3   uuid;
  v_hittrax uuid;
  v_resources uuid[];
  v_rid uuid;
  v_dow int;

  v_off_30    uuid;
  v_off_60    uuid;
  v_off_ht    uuid;
  v_off_clinic uuid;

  v_plan_rookie   uuid;
  v_plan_allstar  uuid;
  v_plan_classpk  uuid;

  v_user_marcus uuid;
  v_user_priya  uuid;
  v_mem_marcus  uuid;
  v_mem_priya   uuid;
  v_mem_danny   uuid;
  v_mem_sofia   uuid;

  v_sub uuid;
BEGIN
  -- --- 1. Tenant + owner admin (also creates default booking_policies) -------
  SELECT tenant_id, user_id, admin_id
    INTO v_tenant_id, v_owner_user_id, v_owner_admin_id
  FROM create_tenant_with_owner(
    'sunsetpark',                    -- subdomain
    'Sunset Park Baseball',          -- name
    'America/New_York',              -- timezone
    'owner@sunsetparkbaseball.com',  -- owner email
    v_pw,                            -- owner password hash
    'Alex',                          -- owner first name
    'Torres'                         -- owner last name
  );

  -- create_tenant_with_owner sets the GUC transaction-locally; set it
  -- explicitly too so the rest of the block (and apply_credit_change) is safe.
  PERFORM set_config('app.current_tenant_id', v_tenant_id::text, true);

  -- Slightly friendlier default booking policy than the built-in defaults.
  UPDATE booking_policies
     SET free_cancel_hours_before   = 12,
         min_advance_booking_minutes = 60,
         max_advance_booking_days    = 30,
         no_show_action              = 'forfeit_credits'
   WHERE tenant_id = v_tenant_id;

  -- --- 2. Resources ----------------------------------------------------------
  INSERT INTO resources (tenant_id, name, display_order)
    VALUES (v_tenant_id, 'Cage 1', 1) RETURNING id INTO v_cage1;
  INSERT INTO resources (tenant_id, name, display_order)
    VALUES (v_tenant_id, 'Cage 2', 2) RETURNING id INTO v_cage2;
  INSERT INTO resources (tenant_id, name, display_order)
    VALUES (v_tenant_id, 'Cage 3', 3) RETURNING id INTO v_cage3;
  INSERT INTO resources (tenant_id, name, display_order)
    VALUES (v_tenant_id, 'HitTrax Bay', 4) RETURNING id INTO v_hittrax;

  -- --- 3. Offerings (dollar_price is CENTS; capacity 1 = rental, >1 = class) --
  INSERT INTO offerings
    (tenant_id, name, category, duration_minutes, credit_cost, dollar_price,
     capacity, allow_member_booking, allow_public_booking, display_order)
  VALUES
    (v_tenant_id, '30-Minute Cage', 'cage-time', 30, 3, 3000, 1, true, true, 1)
    RETURNING id INTO v_off_30;
  INSERT INTO offerings
    (tenant_id, name, category, duration_minutes, credit_cost, dollar_price,
     capacity, allow_member_booking, allow_public_booking, display_order)
  VALUES
    (v_tenant_id, '60-Minute Cage', 'cage-time', 60, 5, 5000, 1, true, true, 2)
    RETURNING id INTO v_off_60;
  INSERT INTO offerings
    (tenant_id, name, category, duration_minutes, credit_cost, dollar_price,
     capacity, allow_member_booking, allow_public_booking, display_order)
  VALUES
    (v_tenant_id, 'HitTrax Session', 'hittrax', 30, 4, 4000, 1, true, true, 3)
    RETURNING id INTO v_off_ht;
  INSERT INTO offerings
    (tenant_id, name, category, duration_minutes, credit_cost, dollar_price,
     capacity, allow_member_booking, allow_public_booking, display_order)
  VALUES
    (v_tenant_id, 'Saturday Hitting Clinic', 'classes', 60, 5, 4500, 8, true, true, 4)
    RETURNING id INTO v_off_clinic;

  -- --- 4. Offering ↔ resource links -----------------------------------------
  -- Cage offerings run on all three cages; HitTrax on its bay; clinic on Cage 1.
  INSERT INTO offering_resources (tenant_id, offering_id, resource_id) VALUES
    (v_tenant_id, v_off_30, v_cage1),
    (v_tenant_id, v_off_30, v_cage2),
    (v_tenant_id, v_off_30, v_cage3),
    (v_tenant_id, v_off_60, v_cage1),
    (v_tenant_id, v_off_60, v_cage2),
    (v_tenant_id, v_off_60, v_cage3),
    (v_tenant_id, v_off_ht, v_hittrax),
    (v_tenant_id, v_off_clinic, v_cage1);

  -- --- 5. Operating hours: every resource, every day, 9am–9pm ----------------
  v_resources := ARRAY[v_cage1, v_cage2, v_cage3, v_hittrax];
  FOREACH v_rid IN ARRAY v_resources LOOP
    FOR v_dow IN 0..6 LOOP   -- 0=Sun … 6=Sat
      INSERT INTO operating_hours
        (tenant_id, resource_id, day_of_week, open_time, close_time)
      VALUES
        (v_tenant_id, v_rid, v_dow, TIME '09:00', TIME '21:00');
    END LOOP;
  END LOOP;

  -- --- 6. Plans (monthly_price_cents; allowed_categories NULL = all) ----------
  INSERT INTO plans
    (tenant_id, name, description, monthly_price_cents, credits_per_week,
     allowed_categories, display_order)
  VALUES
    (v_tenant_id, 'Rookie', '8 credits per week. Great for weekly hitters.',
     9900, 8, NULL, 1)
    RETURNING id INTO v_plan_rookie;
  INSERT INTO plans
    (tenant_id, name, description, monthly_price_cents, credits_per_week,
     allowed_categories, display_order)
  VALUES
    (v_tenant_id, 'All-Star', '20 credits per week. Cages, HitTrax, and classes.',
     19900, 20, NULL, 2)
    RETURNING id INTO v_plan_allstar;
  INSERT INTO plans
    (tenant_id, name, description, monthly_price_cents, credits_per_week,
     allowed_categories, display_order)
  VALUES
    (v_tenant_id, 'Class Pack', '6 credits per week, classes only.',
     7900, 6, ARRAY['classes']::category_key[], 3)
    RETURNING id INTO v_plan_classpk;

  -- --- 7. Members ------------------------------------------------------------
  -- Two with logins (users row + member with matching email + user_id),
  -- two imported-style (no login, user_id NULL).

  -- Marcus (login) — All-Star
  INSERT INTO users (tenant_id, email, password_hash, first_name, last_name)
    VALUES (v_tenant_id, 'marcus@example.com', v_pw, 'Marcus', 'Rivera')
    RETURNING id INTO v_user_marcus;
  INSERT INTO members (tenant_id, user_id, email, first_name, last_name, phone)
    VALUES (v_tenant_id, v_user_marcus, 'marcus@example.com', 'Marcus', 'Rivera', '347-555-0142')
    RETURNING id INTO v_mem_marcus;

  -- Priya (login) — Rookie
  INSERT INTO users (tenant_id, email, password_hash, first_name, last_name)
    VALUES (v_tenant_id, 'priya@example.com', v_pw, 'Priya', 'Shah')
    RETURNING id INTO v_user_priya;
  INSERT INTO members (tenant_id, user_id, email, first_name, last_name, phone)
    VALUES (v_tenant_id, v_user_priya, 'priya@example.com', 'Priya', 'Shah', '718-555-0198')
    RETURNING id INTO v_mem_priya;

  -- Danny (no login) — Class Pack
  INSERT INTO members (tenant_id, email, first_name, last_name, phone)
    VALUES (v_tenant_id, 'danny@example.com', 'Danny', 'Kim', '917-555-0110')
    RETURNING id INTO v_mem_danny;

  -- Sofia (no login) — Rookie
  INSERT INTO members (tenant_id, email, first_name, last_name, phone)
    VALUES (v_tenant_id, 'sofia@example.com', 'Sofia', 'Martinez', '646-555-0176')
    RETURNING id INTO v_mem_sofia;

  -- --- 8. Subscriptions + plan periods (one active per member) ---------------
  -- Marcus → All-Star
  INSERT INTO subscriptions
    (tenant_id, member_id, status, current_period_start, current_period_end, activated_at)
    VALUES (v_tenant_id, v_mem_marcus, 'active', now(), now() + interval '30 days', now())
    RETURNING id INTO v_sub;
  INSERT INTO subscription_plan_periods (tenant_id, subscription_id, plan_id, started_at)
    VALUES (v_tenant_id, v_sub, v_plan_allstar, now());

  -- Priya → Rookie
  INSERT INTO subscriptions
    (tenant_id, member_id, status, current_period_start, current_period_end, activated_at)
    VALUES (v_tenant_id, v_mem_priya, 'active', now(), now() + interval '30 days', now())
    RETURNING id INTO v_sub;
  INSERT INTO subscription_plan_periods (tenant_id, subscription_id, plan_id, started_at)
    VALUES (v_tenant_id, v_sub, v_plan_rookie, now());

  -- Danny → Class Pack
  INSERT INTO subscriptions
    (tenant_id, member_id, status, current_period_start, current_period_end, activated_at)
    VALUES (v_tenant_id, v_mem_danny, 'active', now(), now() + interval '30 days', now())
    RETURNING id INTO v_sub;
  INSERT INTO subscription_plan_periods (tenant_id, subscription_id, plan_id, started_at)
    VALUES (v_tenant_id, v_sub, v_plan_classpk, now());

  -- Sofia → Rookie
  INSERT INTO subscriptions
    (tenant_id, member_id, status, current_period_start, current_period_end, activated_at)
    VALUES (v_tenant_id, v_mem_sofia, 'active', now(), now() + interval '30 days', now())
    RETURNING id INTO v_sub;
  INSERT INTO subscription_plan_periods (tenant_id, subscription_id, plan_id, started_at)
    VALUES (v_tenant_id, v_sub, v_plan_rookie, now());

  -- --- 9. Starting credit balances (via the ledger function) -----------------
  -- GUC already equals v_tenant_id, which apply_credit_change requires.
  PERFORM apply_credit_change(v_tenant_id, v_mem_marcus, 16, 'signup_bonus');
  PERFORM apply_credit_change(v_tenant_id, v_mem_priya,   8, 'signup_bonus');
  PERFORM apply_credit_change(v_tenant_id, v_mem_danny,   6, 'signup_bonus');
  PERFORM apply_credit_change(v_tenant_id, v_mem_sofia,   5, 'signup_bonus');

  RAISE NOTICE 'Seeded tenant % (subdomain sunsetpark): 4 resources, 4 offerings, 3 plans, 4 members.', v_tenant_id;
END
$seed$;

-- ============================================================================
-- PART B — sample bookings (separate transaction; re-resolves ids by name)
-- ============================================================================
-- Kept separate so if a booking ever trips a constraint, Part A still stands.

DO $bookings$
DECLARE
  v_tenant_id uuid;
  v_cage1 uuid; v_cage2 uuid; v_cage3 uuid; v_hittrax uuid;
  v_off_30 uuid; v_off_60 uuid; v_off_ht uuid;
  v_mem_marcus uuid; v_mem_priya uuid; v_mem_sofia uuid;
  -- midnight *today* in the tenant's timezone, as a timestamptz anchor
  v_base timestamptz := (date_trunc('day', now() AT TIME ZONE 'America/New_York'))
                        AT TIME ZONE 'America/New_York';
BEGIN
  SELECT id INTO v_tenant_id FROM tenants WHERE subdomain = 'sunsetpark';
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Tenant sunsetpark not found — run Part A first.';
  END IF;
  PERFORM set_config('app.current_tenant_id', v_tenant_id::text, true);

  SELECT id INTO v_cage1   FROM resources WHERE tenant_id = v_tenant_id AND name = 'Cage 1';
  SELECT id INTO v_cage2   FROM resources WHERE tenant_id = v_tenant_id AND name = 'Cage 2';
  SELECT id INTO v_cage3   FROM resources WHERE tenant_id = v_tenant_id AND name = 'Cage 3';
  SELECT id INTO v_hittrax FROM resources WHERE tenant_id = v_tenant_id AND name = 'HitTrax Bay';

  SELECT id INTO v_off_30 FROM offerings WHERE tenant_id = v_tenant_id AND name = '30-Minute Cage';
  SELECT id INTO v_off_60 FROM offerings WHERE tenant_id = v_tenant_id AND name = '60-Minute Cage';
  SELECT id INTO v_off_ht FROM offerings WHERE tenant_id = v_tenant_id AND name = 'HitTrax Session';

  SELECT id INTO v_mem_marcus FROM members WHERE tenant_id = v_tenant_id AND email = 'marcus@example.com';
  SELECT id INTO v_mem_priya  FROM members WHERE tenant_id = v_tenant_id AND email = 'priya@example.com';
  SELECT id INTO v_mem_sofia  FROM members WHERE tenant_id = v_tenant_id AND email = 'sofia@example.com';

  -- Member bookings: member_id set, no money (amount_due 0, not_required),
  -- credit_cost_charged snapshots the offering's credit cost.

  -- 1. Marcus, 30-min cage, Cage 1, YESTERDAY 10:00 — completed (history)
  INSERT INTO bookings
    (tenant_id, offering_id, resource_id, member_id,
     start_time, end_time, status, amount_due_cents, credit_cost_charged, payment_status)
  VALUES
    (v_tenant_id, v_off_30, v_cage1, v_mem_marcus,
     v_base - interval '1 day' + interval '10 hours',
     v_base - interval '1 day' + interval '10 hours 30 minutes',
     'completed', 0, 3, 'not_required');

  -- 2. Priya, 60-min cage, Cage 1, TODAY 16:00 — confirmed
  INSERT INTO bookings
    (tenant_id, offering_id, resource_id, member_id,
     start_time, end_time, status, amount_due_cents, credit_cost_charged, payment_status)
  VALUES
    (v_tenant_id, v_off_60, v_cage1, v_mem_priya,
     v_base + interval '16 hours',
     v_base + interval '17 hours',
     'confirmed', 0, 5, 'not_required');

  -- 3. Marcus, HitTrax, HitTrax Bay, TOMORROW 11:00 — confirmed
  INSERT INTO bookings
    (tenant_id, offering_id, resource_id, member_id,
     start_time, end_time, status, amount_due_cents, credit_cost_charged, payment_status)
  VALUES
    (v_tenant_id, v_off_ht, v_hittrax, v_mem_marcus,
     v_base + interval '1 day 11 hours',
     v_base + interval '1 day 11 hours 30 minutes',
     'confirmed', 0, 4, 'not_required');

  -- 4. Sofia, 30-min cage, Cage 2, TOMORROW 09:30 — confirmed
  INSERT INTO bookings
    (tenant_id, offering_id, resource_id, member_id,
     start_time, end_time, status, amount_due_cents, credit_cost_charged, payment_status)
  VALUES
    (v_tenant_id, v_off_30, v_cage2, v_mem_sofia,
     v_base + interval '1 day 9 hours 30 minutes',
     v_base + interval '1 day 10 hours',
     'confirmed', 0, 3, 'not_required');

  -- Walk-in (customer) bookings: member_id NULL, customer_* set,
  -- credit_cost_charged 0, paid the dollar price.

  -- 5. Jake Fields, 30-min cage, Cage 2, TODAY 14:00 — confirmed, paid $30
  INSERT INTO bookings
    (tenant_id, offering_id, resource_id,
     customer_first_name, customer_last_name, customer_email, customer_phone,
     start_time, end_time, status,
     amount_due_cents, amount_paid_cents, payment_status)
  VALUES
    (v_tenant_id, v_off_30, v_cage2,
     'Jake', 'Fields', 'jake.fields@example.com', '347-555-0233',
     v_base + interval '14 hours',
     v_base + interval '14 hours 30 minutes',
     'confirmed', 3000, 3000, 'paid');

  -- 6. Emma Ruiz, 30-min cage, Cage 3, TOMORROW 18:00 — confirmed, paid $30
  INSERT INTO bookings
    (tenant_id, offering_id, resource_id,
     customer_first_name, customer_last_name, customer_email, customer_phone,
     start_time, end_time, status,
     amount_due_cents, amount_paid_cents, payment_status)
  VALUES
    (v_tenant_id, v_off_30, v_cage3,
     'Emma', 'Ruiz', 'emma.ruiz@example.com', '718-555-0261',
     v_base + interval '1 day 18 hours',
     v_base + interval '1 day 18 hours 30 minutes',
     'confirmed', 3000, 3000, 'paid');

  RAISE NOTICE 'Seeded 6 sample bookings for tenant %.', v_tenant_id;
END
$bookings$;

-- ============================================================================
-- SUMMARY — what got created (safe to run repeatedly)
-- ============================================================================
SELECT
  (SELECT name FROM tenants WHERE subdomain = 'sunsetpark')                         AS facility,
  (SELECT count(*) FROM resources r  JOIN tenants t ON t.id = r.tenant_id  WHERE t.subdomain='sunsetpark') AS resources,
  (SELECT count(*) FROM offerings o  JOIN tenants t ON t.id = o.tenant_id  WHERE t.subdomain='sunsetpark') AS offerings,
  (SELECT count(*) FROM plans p      JOIN tenants t ON t.id = p.tenant_id  WHERE t.subdomain='sunsetpark') AS plans,
  (SELECT count(*) FROM members m    JOIN tenants t ON t.id = m.tenant_id  WHERE t.subdomain='sunsetpark') AS members,
  (SELECT count(*) FROM bookings b   JOIN tenants t ON t.id = b.tenant_id  WHERE t.subdomain='sunsetpark') AS bookings;

-- Member credit balances:
SELECT m.first_name, m.last_name, m.email, cb.current_credits
FROM credit_balances cb
JOIN members m ON m.tenant_id = cb.tenant_id AND m.id = cb.member_id
JOIN tenants t ON t.id = m.tenant_id
WHERE t.subdomain = 'sunsetpark'
ORDER BY m.last_name;
