# Momentum source schema inventory

The table-by-table contract between Momentum's old system (the
Diamond Club Portal) and Courtside. `01_snapshot_source.js` dumps
exactly the tables below; `02_transform.js` implements exactly the
mappings and edge cases below. If code and this doc disagree, one of
them is wrong — fix the doc first, then the code.

**Source of authority:** the live Diamond DB, whose shape is
`db/schema.sql` + migrations 001–016 in the Diamond repo
(`/Users/mike/diamond-club-portal`). Two sources feed the migration:

1. **The Diamond Postgres DB** — members, services, credit balances,
   member bookings, credit grants, audit tables.
2. **A Setmore CSV export** — manually exported from the Setmore
   admin UI and dropped at `out/source/setmore_bookings.csv`. This is
   the ONLY source for walk-in appointments; Diamond's own `bookings`
   table holds member bookings only.

Row counts marked *fill at cutover* are live numbers — record them in
the runbook when the snapshot runs, and feed them to `05_verify.js`
via the `EXPECT_*` env vars.

The pipeline's artifacts chain by content hash: the transformed
manifest records `source_manifest_sha256` (sha256 of the raw bytes
of `out/source/manifest.json`), the load report records
`transformed_manifest_sha256` (same, of
`out/transformed/manifest.json`), and `05_verify.js` recomputes both
links — so a stale artifact from a different pipeline run can never
verify green against this inventory's numbers.

If you discover an edge case mid-migration, come back here and add
it. The doc is the source of truth.

---

## Stripe Connect account

Before any DB work, inventory the live billing relationship:

- [ ] Momentum's existing Stripe **Connect account ID** (`acct_...`):
- [ ] **Active subscriptions** on it
      (`stripe subscriptions list --connect-account=acct_... --status=active --limit=100`,
      count them): *fill at cutover* → feeds `EXPECT_ACTIVE_SUBS`
- [ ] **Customers** total: *fill at cutover*
- [ ] **Prices** in use by live subscriptions — one per Diamond plan
      key (`basic`, `pro`, `unlimited`). Each `price_...` id goes
      into `momentum.map.json` → `plans.<key>.stripe_price_id`, and
      the admin-created Courtside plan must carry the SAME price id.
      `02_transform.js` refuses to run while any of these are TODO.

This is the heart of the "don't double-charge" rule: the connected
account, its customers, and its subscriptions are migrated **in
place** — Courtside points at them, it never recreates them.

---

## Source tables

### `members`

**Columns** (schema.sql + migrations 001, 008, 011, 012, 014):

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `email` | text NOT NULL UNIQUE | **case-sensitive** unique — see edge cases |
| `password_hash` | text NOT NULL | bcrypt; NOT migrated |
| `name` | text NOT NULL | legacy display name, pre-012 |
| `first_name` / `last_name` | text NOT NULL DEFAULT `''` | 012 backfilled from `name`; blanks remain |
| `plan` | text DEFAULT `'basic'` | keys seen: `basic`, `pro`, `unlimited` |
| `credits_per_week` | int DEFAULT 4 | **999 = "unlimited" magic** |
| `is_admin` | bool | staff flag on the member row |
| `stripe_customer_id` | text UNIQUE NULL | |
| `stripe_subscription_id` | text UNIQUE NULL | |
| `subscription_status` | text NOT NULL DEFAULT `'inactive'` | NOT a closed enum — Diamond's Stripe webhook writes RAW Stripe statuses verbatim when not `'active'`; see the status map below |
| `deactivated_at` | timestamptz NULL | offboarding (011) |
| `subscription_period_end` | timestamptz NULL | offboarding (011) |
| `scheduled_deactivation_at` | timestamptz NULL | cancel-at-period-end machinery (014) |
| `created_at` | timestamptz | |

**Approx row count:** *fill at cutover* → feeds `EXPECT_MEMBERS`

**Maps to:**
- `users` — the login identity (password NULL; everyone gets a reset
  link in the welcome email — migration 021 made that legal)
- `members` — 1:1, linked to the user
- `subscriptions` + `subscription_plan_periods` — Diamond has NO
  subscriptions table; subscription state lives **inline on the
  member row**, so there is at most one subscription per member to
  reconstruct. And `subscription_status` is NOT the three-value
  field it looks like: Diamond's webhook (`handleSubscriptionUpdated`
  in the Diamond repo's `src/controllers/stripeController.js`)
  writes the RAW Stripe status verbatim whenever it isn't
  `'active'`, so any Stripe subscription status can appear in a
  snapshot. The transform maps fail-closed:

  | Diamond value | Courtside status |
  |---|---|
  | `active` | `active` |
  | `trialing` | `active` |
  | `past_due` | `past_due` |
  | `unpaid` | `past_due` |
  | `canceled` / `cancelled` | `cancelled` |
  | `incomplete` | `incomplete` |
  | `incomplete_expired` | `cancelled` |
  | `inactive` WITH a `stripe_subscription_id` | `cancelled` — historical churn, billing-history link preserved |
  | `inactive` without one (never subscribed, or manual member) | no subscription row at all |
  | anything else | **throw** — refusing to guess a mapping |

  Active rows keep `stripe_subscription_id`/`stripe_customer_id`
  AS-IS with `current_period_end` from `subscription_period_end`,
  plus one open `subscription_plan_periods` row pointing at the
  mapped plan. Cancelled rows preserve history; a cancelled
  subscription with NO recorded end (`deactivated_at` and
  `subscription_period_end` both NULL) closes its plan period at
  the migration moment — the transformed manifest's `created_at` —
  read as "ended by migration; exact end unknown". The transformed
  manifest's `expected.subscriptions` carries all four statuses
  (`{ active, past_due, incomplete, cancelled }`), and `05_verify`
  reconciles each against the live DB.
- `plans` are NOT created by the migration — admin-UI prework. The
  Diamond `plan` key resolves through `momentum.map.json` →
  `resolvePlan`, which fails closed on any TODO.

**Edge cases:**
- **Case-duplicate emails.** Diamond's UNIQUE is case-sensitive, so
  `Bob@x.com` and `bob@x.com` can both exist; Courtside normalizes
  to lowercase (`CHECK (email = lower(email))`). Emails that
  collide after `lower(trim(...))` → blocker **`duplicate_emails`**
  with the colliding sets in the exceptions report. Hard stop: the
  operator merges or corrects them at the source. The ack path is a
  deliberate, sized concession: the transform keeps the
  earliest-created member per colliding set (a stable, explainable
  choice) and DROPS the rest, recording the dropped-row count as
  `exceptions.duplicate_emails` in the manifest — and 05's
  source-row reconciliation then expects `members.json` rows ==
  imported members + exactly that count, so the ack can't hide any
  other missing row.
- **`credits_per_week = 999` = "unlimited".** Diamond's magic
  number, not a real allotment. Carried over AS-IS at cutover (the
  mapped Courtside plan gets `credits_per_week = 999`) and tracked
  here as a known wart — replace when Courtside grows a first-class
  unlimited concept. Do not build that concept speculatively.
- **`is_admin` members** → written to `exceptions/admins.json` and
  imported as ordinary members. The importer never creates
  `tenant_admin` rows — admin access is granted manually
  post-cutover, from that file, by a human.
- **Ghost members** (no subscription, no credits, no bookings) ARE
  imported — a member row with nothing attached costs nothing, and
  silent drops are forbidden. They land as members with no
  subscription and a zero balance.
- **Blank `first_name`/`last_name`.** Diamond's `''` defaults
  violate Courtside's `btrim(...) <> ''` CHECKs. The transform falls
  back to splitting legacy `name` (same convention as the walk-in
  checkout's `splitFullName`: single-token names duplicate into both
  columns). A member blank in ALL of first/last/name HARD-FAILS the
  transform with the member identified — a nameless member is
  corrupt source data that needs a human decision at the source, not
  an exceptions-report entry the import quietly proceeds past. Never
  invent a placeholder name.
- `password_hash` is never migrated (different auth stack, and the
  welcome email issues reset links anyway).
- `deactivated_at` / `scheduled_deactivation_at` live only in the
  snapshot archive; post-cutover, Stripe webhooks re-drive any
  pending cancellation on the migrated subscription.

---

### `services`

**Columns:** `id` uuid PK, `name` text, `credits_cost` int,
`duration_minutes` int, `active` bool, `setmore_service_key` text.

**Approx row count:** ~16 (see the `services` map in
`momentum.map.json`)

**Maps to:** nothing directly — **offerings are admin-UI prework**,
created by hand before the dry run. The snapshot dumps `services`
because the transform needs it for:
- name → Courtside offering resolution (`momentum.map.json`
  `services` map → `resolveOffering`, fail-closed on unmapped names);
- `credits_cost` as the booking-spend approximation (see `bookings`);
- the service NAME to tie Setmore CSV rows back to services: the
  transform matches the CSV's service column to Diamond
  `services.name` by EXACT string, then resolves that name through
  the `services` map (the alias layer onto the Courtside offering).
  `setmore_service_key` rides along in the snapshot archive but the
  matcher never reads it — keep Setmore and Diamond service names in
  exact lockstep, and put any renames in the map, not in the data.

**Edge cases:**
- Inactive services can still be referenced by historical bookings —
  the map must cover every service name that appears in bookings,
  active or not. The transform aborts listing every unmapped name.

---

### `credit_balances`

**Columns:** `member_id` uuid PK FK members, `current_credits` int,
`last_reset` timestamptz.

**Approx row count:** one per member with credit activity —
*fill at cutover*; total credits feeds `EXPECT_TOTAL_CREDITS`

**Maps to:**
- `credit_balances` — `current_credits` copied; `purchased_credits`
  computed by THE PURCHASED-CREDIT RULE below
- `credit_ledger_entries` — exactly one seed row per member, reason
  `'migration'`, `balance_after = current_credits`. The ledger
  invariant starts true and stays true.

**THE PURCHASED-CREDIT RULE** (drives `02_transform.js`; do not
"simplify" it):

- **Non-active members** (`subscription_status <> 'active'`): the
  ENTIRE balance imports as `purchased_credits`.
- **Active members**: `purchased_credits` = credit-grant credits
  **claimed since the member's `last_reset`**, clamped to
  `current_credits`.

Rationale, in both directions:
- Diamond's Monday reset (their migration 013) SETs
  `current_credits = credits_per_week` for **active members only**.
  So for an active member, anything surviving from before
  `last_reset` was already clawed back — only grants claimed since
  then can still be sitting on top of the weekly allotment. The
  clamp covers grants partially spent since claiming.
- Non-active members are **never touched** by Diamond's reset —
  whatever balance they hold (typically claimed gift credits) is
  effectively durable, purchased value.
- On the Courtside side, migration 024 gives `purchased_credits`
  exactly the matching semantics: the weekly reset SETs the balance
  to `credits_per_week + purchased_credits`, so credits imported
  into the purchased bucket survive resets — and credits imported
  into the subscription bucket are correctly overwritten at the
  next Monday reset, same as Diamond would have done.

Get this split wrong in either direction and you either expire
credits people paid cash for, or grant immortal credits that were
due to expire Monday.

**Edge cases:**
- Members with a balance but NO `credit_balances` row: possible for
  never-booked members — import as zero, no ledger row needed
  (Courtside creates balances lazily via `apply_credit_change`).
- Negative balances: Diamond's app logic prevents them, but the
  transform still validates `current_credits >= 0` and hard-fails on
  violation — Courtside's schema rejects them anyway.

---

### `credit_grants` (gift cards / purchased sessions)

**Columns** (Diamond migration 016): `id`, `stripe_session_id`
UNIQUE, `stripe_payment_intent_id`, `buyer_email`, `buyer_name`,
`buyer_member_id` uuid NULL, `recipient_email`, `recipient_name`,
`recipient_member_id` uuid NULL, `credits_amount` int > 0,
`amount_paid_cents`, `is_gift` bool, `gift_message`, `claim_token`,
`claim_token_expires_at`, `status`
(`pending` | `claimed` | `refunded`), `created_at`, `claimed_at`,
`refunded_at`. Self-purchases are inserted already `claimed`; gifts
sit `pending` until the emailed claim link is used.

**Approx row count:** *fill at cutover*

**Maps to:** no Courtside table — Courtside sells `credit_packs`
going forward. Grants exist in the pipeline for exactly two jobs:

1. **Input to THE PURCHASED-CREDIT RULE** above: `claimed` grants
   with `claimed_at > last_reset` are what puts an active member's
   credits into the purchased bucket.
2. **The snapshot archive** — full table, purchase history for the
   record.

**Edge cases:**
- **`status = 'pending'` gifts → HARD BLOCKER `pending_gifts`.**
  These are paid-but-undelivered credits, and their claim links
  point at the OLD domain — they die the moment DNS flips. Every
  pending gift must be resolved BEFORE cutover day: claimed (chase
  the recipient), refunded, or explicitly acknowledged via
  `MIGRATION_ACK_BLOCKERS=pending_gifts` with the operational plan
  (who contacts whom, how the credits get granted manually) recorded
  in the runbook. The pipeline will not load past an unacked
  pending gift.
- **`status = 'refunded'`** → archive only. The money went back; the
  credits (if ever granted) were Diamond's problem to claw back, not
  ours to import.
- Grants claimed by a member who was later deactivated are exactly
  the "non-active member with a balance" case — the whole-balance
  purchased import covers them.

---

### `bookings` (Diamond DB — member bookings ONLY)

**Columns:** `id` uuid PK, `member_id` uuid NOT NULL FK,
`service_id` uuid NOT NULL FK, `setmore_appointment_id` text NULL,
`booked_at` timestamptz, `status` text
(`confirmed` | `cancelled` | `completed`), `start_time` timestamptz
NULL, `end_time` timestamptz NULL, `staff_key` text NULL (all three
added by Diamond migration 004 — older rows are NULL).

**Approx row count:** *fill at cutover*; future confirmed rows feed
`EXPECT_BOOKINGS_FUTURE`

**Maps to:** `bookings` (member identity: `member_id` set, all
`customer_*` NULL).

| Source | Courtside | Notes |
|---|---|---|
| `id` | `external_id` (with `external_source`) | loader idempotency key — see migration 031 |
| `member_id` | `member_id` | via member idMap |
| `service_id` → name | `offering_id` | `resolveOffering` via the map |
| `staff_key` | `resource_id` | `resolveResource` via `staff_keys` map |
| `booked_at` | `created_at` | |
| `start_time`/`end_time` | `start_time`/`end_time` | Setmore wins when both sources have the row |
| `status` | `status` | `confirmed` + past start → `completed`; else 1:1 |

**Edge cases:**
- **Walk-ins do NOT exist here.** Diamond's DB never saw them; the
  Setmore export is their only record. Do not expect customer
  bookings in this table.
- **Dedupe against the Setmore CSV** by `setmore_appointment_id`:
  most member bookings appear in BOTH sources. When they do,
  **Setmore wins on times and status** (it was the operational
  system — staff rescheduled and cancelled there), **Diamond wins on
  member identity** (Setmore only has a free-text customer; Diamond
  knows which member spent the credits). One Courtside row per
  appointment, never two.
- **Pre-004 rows with NULL `start_time`** cannot become Courtside
  bookings (`start_time`/`end_time` NOT NULL). They are counted and
  written to `exceptions/timeless_bookings.json` — archived, not
  imported, never silently dropped.
- **Cancelled rows have no cancellation timestamp.** Courtside
  requires `cancelled_at` on cancelled bookings; the transform
  approximates it (`booked_at`, else `start_time`) and says so in
  `cancellation_reason` — the exact string written is
  `'migrated from Momentum; original cancellation time not
  recorded'`.
- **Per-booking credit cost was never snapshotted.** Courtside's
  `credit_cost_charged` is filled from the service's CURRENT
  `credits_cost` — an approximation for historical rows if prices
  ever changed. Acceptable: no refund logic will ever run against
  completed history.
- **No payment data in either source** → every imported booking is
  `payment_status = 'not_required'`, `amount_due_cents = 0`. Cash
  taken at the counter was never recorded per-booking anywhere.

---

### Setmore export (`out/source/setmore_bookings.csv`)

**Source:** manual CSV export from the Setmore admin UI, dropped in
place before `01_snapshot_source.js` runs (the snapshot verifies its
presence and hashes it into the manifest; `SETMORE_EXPORT_SKIP=1` is
a rehearsal-only escape hatch, recorded in the manifest — and
`02_transform` requires it set AGAIN before consuming a
skip-recorded snapshot (double opt-in). Never valid on cutover day).

**Approx row count:** *fill at cutover* (note the historical/future
split in the runbook)

**Maps to:** `bookings` — two populations:
- Rows whose id matches a Diamond `setmore_appointment_id` → the
  member-booking dedupe above (Setmore times/status + Diamond
  member).
- Everything else → **walk-in bookings**: `member_id` NULL,
  `customer_first_name`/`customer_last_name`/`customer_email` (+
  phone when present) from the CSV contact fields,
  `payment_status = 'not_required'`, `external_source`/`external_id`
  from the appointment id.

**Column mapping is deliberately unresolved.** The CSV header names
are unknown until a real export is inspected — the
`setmore_columns` and `setmore_status_map` sections of
`momentum.map.json` are TODO on purpose, and
`resolveSetmoreColumns`/`resolveSetmoreStatus` refuse to parse until
an operator fills them in from an actual file. Same for
`staff_keys` (Setmore staff → Courtside resource). No guessing.

**Edge cases:**
- **Timestamps: strict parsing contract.** Three shapes are
  accepted: ISO-naive `YYYY-MM-DD HH:MM[:SS]`, US
  `M/D/YYYY H:MM AM/PM`, and timestamps carrying an explicit UTC
  offset (passed through as-is). Naive wall-clock forms convert
  through `momentum.map.json` `timezone` (America/New_York) — never
  the host zone. DST is real. Exports that split date and time into
  separate columns map the optional `setmore_columns.date` entry
  (the time columns then hold time-of-day only). The
  `setmore_columns` mapping is validated against the actual CSV
  header before any row parses — a mapped column name missing from
  the header is a hard error, not a silent NULL. Anything
  unparseable is a hard error too.
- **`end <= start` rows** join the `timeless_bookings` exceptions
  file with a `reason` field naming the broken invariant — archived,
  not imported. A FUTURE-dated `end <= start` row hard-fails
  instead: a future commitment we can't represent is not archivable.
- **Walk-ins missing a name or email** cannot satisfy Courtside's
  customer CHECKs (first, last, email all NOT NULL and non-blank
  for walk-ins). Past ones → counted into the exceptions report
  (archive, not imported — history we can't represent). **Future**
  ones → HARD BLOCKER **`future_walkins_missing_contact`**: a
  future appointment we can't import is a person who shows up to a
  booking Courtside doesn't know about. Resolve by getting contact
  info into Setmore before the final export, or ack with a manual
  plan for each one.
- **Recurring appointments:** whether Setmore exports them as one
  row or many is unknown until inspected — record the answer here
  when the first real export lands.
- Appointments outside current `operating_hours` (booked under old
  hours): import anyway; past rows become `completed` and future
  rows were honored commitments. Note the `enforce_booking_validity`
  trigger DOES fire on the loader's INSERTs — operating hours just
  aren't among its gates. What it does gate (offering active,
  capacity = 1, the audience flag for member vs walk-in, resource
  active, `offering_resources` link active) the loader preflight
  pre-checks against the admin catalog for every booking, and it
  refuses to write anything when a row would be rejected — the fix
  is catalog prework, never skipped rows.

---

### `member_status_changes`

**Columns:** `id`, `member_id`, `changed_by`, `old_status`,
`new_status`, `note`, `created_at` (Diamond migration 011).

**Maps to:** snapshot archive only. Courtside has no member-status
audit table yet; when it grows one, this snapshot is the backfill
source — that's the future-port note, not a v1 deliverable.

---

### Archive-only tables

Snapshotted for the record, **never loaded**: `pos_catalog`,
`transactions`, `terminal_readers`, `facility_settings` (the POS /
front-desk stack — becomes a Courtside module later, and this
snapshot is the continuity guarantee for sales history until then),
`checkout_handoffs` (30-minute auto-login tokens, dead on arrival),
`password_reset_tokens` (dead at cutover; Courtside issues its own
resets). Counting them in the snapshot manifest is what makes "we
didn't lose it, we chose not to load it" provable.

---

## Summary table

| Source | Courtside target(s) | Approx rows | Notes |
|---|---|---|---|
| `members` | `users` + `members` + `subscriptions` + `subscription_plan_periods` | *fill at cutover* | inline sub state reconstructed; admins → `exceptions/admins.json`; case-dupe emails → blocker |
| `services` | (map input only — offerings are admin prework) | ~16 | also the credit-cost approximation source |
| `credit_balances` | `credit_balances` + `credit_ledger_entries` (`reason='migration'`) | *fill at cutover* | purchased split per THE PURCHASED-CREDIT RULE |
| `credit_grants` | purchased-credit input + archive | *fill at cutover* | pending → blocker `pending_gifts`; refunded → archive |
| `bookings` | `bookings` (member) | *fill at cutover* | NULL-time rows → `exceptions/timeless_bookings.json` |
| `setmore_bookings.csv` | `bookings` (walk-in + dedupe authority on times/status) | *fill at cutover* | missing contact → exceptions + blocker `future_walkins_missing_contact` |
| `member_status_changes` | archive (future audit backfill) | *fill at cutover* | |
| POS tables, `checkout_handoffs`, `password_reset_tokens` | archive only | *fill at cutover* | POS becomes a Courtside module later |
