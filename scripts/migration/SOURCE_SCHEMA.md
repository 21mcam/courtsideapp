# Momentum source schema inventory

Fill in this file BEFORE writing any extraction code. It's the
contract between Momentum's old system and Courtside.

For each source table, list:
1. **Source columns** — name, type, nullability
2. **Sample row count** — order-of-magnitude (10s, 1000s, etc.)
3. **Mapping to Courtside** — which Courtside table(s) each column lands in, and any transformation
4. **Edge cases** — nulls, dupes, weird historical rows, soft-deletes
5. **Sample row(s)** — paste a few real rows (with PII redacted) so transformers can be tested against them

When this doc is done you should be able to:
- Run a query against Momentum's DB and predict what gets imported
- Hand-author `out/source/*.json` fixtures for transformer unit tests
- Implement `01_snapshot_source.js` mechanically — no judgment calls

If you discover an edge case mid-migration, come back here and add
it. The doc is the source of truth.

---

## How to inventory

```bash
# Connect to Momentum's DB (read-only replica or snapshot)
psql $MOMENTUM_DATABASE_URL

# List every table
\dt

# For each table, dump the schema
\d+ <table_name>

# Approximate row count
SELECT count(*) FROM <table_name>;

# Eyeball 5 random rows
SELECT * FROM <table_name> ORDER BY random() LIMIT 5;
```

Paste the relevant output into the sections below.

---

## Stripe Connect account

Before any DB work, confirm:

- [ ] Momentum's existing Stripe **Connect account ID** (`acct_...`):
- [ ] Number of **active subscriptions** on it (run `stripe subscriptions list --connect-account=acct_... --status=active --limit=100` and count):
- [ ] Number of **customers** total:
- [ ] Number of **products + prices** (these become Courtside `plans.stripe_price_id`):

This is the heart of the migration's "don't double-charge" rule. Everything else is just data; this is the live billing relationship we must preserve.

---

## Source tables

> Replace each `TODO` block with a real description. Add or remove tables as needed.

### `momentum_users` (or whatever it's called)

**Schema (paste \\d+ output):**
```
TODO
```

**Approx row count:** TODO

**Maps to Courtside:**
- `users` (1:1 — the login identity)
- `members` (1:1 if user has an active sub or credits; skip if not — see the "ghost users" edge case below)

**Column mapping:**

| Source column        | Courtside column           | Notes                                                |
|----------------------|----------------------------|------------------------------------------------------|
| `id`                 | (kept in idMap)            | source ID; not stored in Courtside                   |
| `email`              | `users.email`, `members.email` | lowercase + trim before write                    |
| `password_hash`      | (skipped)                  | every member gets a reset link in welcome email      |
| `first_name`         | `users.first_name`, `members.first_name` |                                          |
| `last_name`          | `users.last_name`, `members.last_name`   |                                          |
| `phone`              | `members.phone`            |                                                      |
| `created_at`         | `users.created_at`, `members.created_at` |                                          |
| TODO any others      |                            |                                                      |

**Edge cases:**
- TODO ghost users (rows with no sub, no credits, no bookings — skip or import?)
- TODO duplicate emails (case-only, whitespace, etc.)
- TODO any soft-delete column

**Sample row (PII redacted):**
```json
TODO
```

---

### `momentum_subscriptions` (TODO actual name)

**Schema:**
```
TODO
```

**Approx row count:** TODO (active + cancelled)

**Maps to:**
- `subscriptions` (one row per Momentum subscription, history preserved)
- `subscription_plan_periods` (one open period per active subscription)

**Column mapping:**

| Source column                | Courtside column                       | Notes |
|------------------------------|----------------------------------------|-------|
| `id`                         | (idMap)                                |       |
| `member_id`                  | `subscriptions.member_id`              | translated via member idMap |
| `stripe_subscription_id`     | `subscriptions.stripe_subscription_id` | KEPT AS-IS — Stripe-side ID stays the same after migration |
| `stripe_customer_id`         | `subscriptions.stripe_customer_id`     | same |
| `status`                     | `subscriptions.status`                 | mapped: `'canceled'` → `'cancelled'`, etc. (see `mapMomentumSubStatus` in `02_transform.js`) |
| `current_period_start`       | `subscriptions.current_period_start`   |       |
| `current_period_end`         | `subscriptions.current_period_end`     |       |
| `cancel_at_period_end`       | `subscriptions.cancel_at_period_end`   |       |
| `plan_id` (Momentum-side)    | (translated to courtside_plan_id, then stored on `subscription_plan_periods.plan_id`) |  |
| `activated_at`               | `subscriptions.activated_at`           |       |
| TODO any others              |                                        |       |

**Source `status` enum values seen in the wild (REQUIRED — drives `mapMomentumSubStatus`):**

Run this query and paste the result here:
```sql
SELECT DISTINCT status, count(*) AS n
  FROM momentum_subscriptions
 GROUP BY status
 ORDER BY n DESC;
```

```
TODO
```

**Edge cases:**
- TODO subscriptions where status='past_due' but current_period_end is in the past (Stripe grace exhausted)
- TODO subscriptions with stripe_subscription_id NULL (manual entries?)
- TODO duplicate active subscriptions for one member (would violate `subscriptions_one_active_per_member`)

**Sample row:**
```json
TODO
```

---

### `momentum_credit_balances` (TODO actual name)

**Schema:**
```
TODO
```

**Approx row count:** TODO

**Maps to:**
- `credit_balances` (one row per member, current state)
- `credit_ledger_entries` (one row per member with `reason='migration'` capturing the seed)

**Column mapping:**

| Source column     | Courtside column                | Notes |
|-------------------|---------------------------------|-------|
| `member_id`       | `credit_balances.member_id`     | translated |
| `credits` / `balance` | `credit_balances.current_credits` | must be >= 0 |
| `last_reset_at`   | `credit_balances.last_reset_at` | nullable |

**Edge cases:**
- TODO negative balances in source (does Momentum allow them? Schema says no for Courtside)
- TODO members with balance but no active subscription (cancelled but unspent credits — preserve)

**Sample row:**
```json
TODO
```

---

### `momentum_plans` (TODO actual name)

**Schema:**
```
TODO
```

**Approx row count:** ~5 plans probably

**Maps to:**
- `plans`

**Column mapping:**

| Source column            | Courtside column                | Notes |
|--------------------------|---------------------------------|-------|
| `id`                     | (idMap)                         |       |
| `name`                   | `plans.name`                    |       |
| `description`            | `plans.description`             |       |
| `monthly_price_cents`    | `plans.monthly_price_cents`     | confirm units (cents vs dollars) in source |
| `credits_per_week`       | `plans.credits_per_week`        |       |
| `allowed_categories`     | `plans.allowed_categories`      | NULL = all; non-empty array = whitelist |
| `stripe_price_id`        | `plans.stripe_price_id`         | KEPT AS-IS from Momentum's connected account |
| TODO others              |                                 |       |

**Sample row:**
```json
TODO
```

---

### `momentum_resources` + `momentum_offerings`

**Schema:**
```
TODO
```

**Mapping notes:**
- TODO Setmore had its own concept of "service" or "appointment type" — does it map 1:1 to a Courtside offering, or do we collapse?
- TODO are there offerings that are class-shaped (capacity > 1) on the Momentum side?

---

### Setmore bookings

**Source:** Setmore export (CSV / API). Setmore's data model is different from Momentum's own DB.

**Approx row count:** TODO (split historical vs future)

**Maps to:**
- `bookings` (status='completed' for past, 'confirmed' for future)
- (or `class_bookings` if the offering is class-shaped)

**Column mapping (Setmore CSV → Courtside):**

| Setmore column      | Courtside column             | Notes |
|---------------------|------------------------------|-------|
| `appointment_id`    | (idMap)                      |       |
| `customer_email`    | `bookings.member_id` lookup OR `bookings.customer_email` | If we recognize the email as a Momentum member, attach as member booking. Otherwise treat as walk-in. |
| `service_id`        | `bookings.offering_id`       | translated |
| `staff_id` / `resource_id` | `bookings.resource_id` | TODO: Setmore staff vs Courtside resource — direct mapping? |
| `start_time`        | `bookings.start_time`        | TIMEZONE: Setmore export is in local tenant TZ; convert to UTC |
| `duration`          | (computed end_time)          |       |
| `status`            | `bookings.status`            | Setmore: scheduled/cancelled/no-show; map accordingly |

**Edge cases:**
- TODO Setmore appointments with no recognizable customer email (treat as walk-ins with placeholder email?)
- TODO recurring Setmore appointments (do they show up as one row or many?)
- TODO appointments outside our operating_hours fixture (likely from old hours; import anyway since we mark them 'completed')

---

### Other tables (add as discovered)

- TODO `momentum_admins` — staff accounts? Map to `tenant_admins`
- TODO `momentum_blackouts` or holiday lists
- TODO `momentum_payment_history` — we don't migrate this; Stripe is the source of truth for billing history

---

## Summary table

Once the above is complete, fill in:

| Source table             | Courtside target(s)                                        | Approx rows | Owner of mapping      |
|--------------------------|------------------------------------------------------------|-------------|-----------------------|
| `momentum_users`         | `users` + `members`                                        | TODO        |                       |
| `momentum_subscriptions` | `subscriptions` + `subscription_plan_periods`              | TODO        |                       |
| `momentum_credit_balances` | `credit_balances` + `credit_ledger_entries(migration)`   | TODO        |                       |
| `momentum_plans`         | `plans`                                                    | TODO        |                       |
| Setmore bookings         | `bookings`                                                 | TODO        |                       |
| ...                      |                                                            |             |                       |
