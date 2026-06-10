# Momentum → Courtside migration runbook

Phase 6 deliverable. One-shot scripts for moving Momentum's existing
data into Courtside without disrupting active Stripe billing or
losing audit history.

## Hard rules

1. **Never cancel + recreate a Stripe subscription.** Loses billing
   history, requires re-entering cards, double-bills risk. We
   migrate Stripe in place — Momentum's existing connected account
   becomes Momentum's `stripe_connections` row in Courtside; the
   subscriptions and customers on Stripe keep running.

2. **Never delete the source.** Keep Momentum's old DB read-only
   for at least 30 days after cutover. If something's wrong, the
   original is the source of truth.

3. **Test on staging first.** Restore a recent Momentum snapshot to
   a staging Postgres, run the full ETL, run verify, then smoke
   test. Iterate until verify passes cleanly. *Then* schedule
   production cutover.

## Phases

| Step | Script | What | When |
|------|--------|------|------|
| 1 | `01_snapshot_source.js` | Dumps Momentum DB to JSON files in `out/source/` | Run at the cutover starting line |
| 2 | `02_transform.js` | Reads `out/source/*` and writes Courtside-shaped JSON to `out/transformed/`; rows it can't legally map go to `rejects.json` | Reads-only; can rerun |
| 3 | `03_load.js` | Inserts into the live Courtside DB inside one transaction per logical group, resolving `source_*_id` refs as it loads | Idempotent (deterministic ids + natural-key adoption); bad booking/hours rows skip into `out/load_report/` |
| 4 | `04_stripe_backfill.js` | Updates existing Stripe Customers + Subscriptions on Momentum's connected account with `courtside_*` metadata | Idempotent; safe to rerun; exits 1 if ANY row failed |
| 5 | `05_verify.js` | Compares row counts (`EXPECT_*` env, required) + invariants | Read-only; missing `EXPECT_*` is a FAIL, not a skip |

## ID strategy, idempotency, and review reports

Every row the migration creates gets a **deterministic UUIDv5** from
`(tenant_id, table, Momentum source id)` — see `shared/ids.js`. Same
source row → same Courtside UUID on every run. That's what makes
reruns safe for tables with no natural key (bookings, subscriptions
with NULL stripe ids, inactive plans).

Transformers never resolve cross-references; they carry Momentum ids
through as `source_*_id` fields. `03_load.js` builds source→Courtside
maps as it inserts (`RETURNING id`) and resolves later phases through
them. Where a row may already exist — wizard-created plans/resources/
offerings, a hand-created member — the loader **adopts** the existing
row by natural key (email / name) and updates it, rather than
inserting a duplicate. The transformed catalog JSON must carry
`source_id` on any plan/resource/offering that subscriptions or
bookings reference, or those rows can't resolve.

Per-row failure policy:

- **users/members, plans, catalog, subscriptions, credits** — small,
  must-be-complete datasets. Any unresolvable row fails the whole
  phase with a list (the transaction rolls back). Fix, rerun.
- **bookings, operating hours** — bulky, dirty (Setmore) datasets.
  Bad rows are skipped via per-row SAVEPOINT and written to
  `out/load_report/*.json`. The reports are part of the cutover gate:
  `bookings_skipped.json` must be empty or consciously accepted
  before DNS flips. An empty report file is always written, so "no
  file" can never be mistaken for "nothing skipped".
- **transform-level rejects** (unmappable money shapes, missing
  walk-in contact info, garbage dates, unknown subscription statuses)
  throw per row; the driver collects them into
  `out/transformed/rejects.json` for manual review. We do not
  fabricate emails or rewrite money to force a row in.

Rerunning after go-live: the credit phase refuses to overwrite any
member who already has operational (non-`migration`) ledger activity
— those members are listed in
`out/load_report/credit_balances_skipped_live.json` instead.

## Cutover timeline (target Sunday 6am ET)

```
T-7d   Email members re: scheduled migration window
T-2h   Final dry run on staging using prod snapshot
T+0    Set Momentum old portal to read-only mode
       Disable Setmore writes
T+5m   01_snapshot_source.js
T+10m  02_transform.js
T+15m  03_load.js (production Courtside DB)
T+20m  04_stripe_backfill.js (Stripe live API)
T+25m  05_verify.js — abort if it reports failures
       (export EXPECT_MEMBERS / EXPECT_ACTIVE_SUBS /
        EXPECT_TOTAL_CREDITS / EXPECT_BOOKINGS_FUTURE from the source
        counts FIRST — unset values fail the gate by design.
        Also review out/load_report/*.json and
        out/transformed/rejects.json.)
T+30m  Update Stripe Connect webhook URL on Momentum's account:
         from: <Momentum old endpoint>
         to:   https://app.courtside.example/webhooks/stripe
T+35m  DNS / load balancer: switch member-facing domain to Courtside
T+45m  Members can log in (with password-reset link from welcome
       email). Tail logs for the next several hours.
```

## Verification queries (the manual ones to run)

After `05_verify.js` reports clean, spot-check by hand:

```sql
-- 10 random migrated members: confirm credit balances match
SELECT id, email, current_credits FROM credit_balances cb
  JOIN members m ON m.id = cb.member_id
  ORDER BY random() LIMIT 10;

-- Active subscriptions count vs Stripe count
SELECT count(*) FROM subscriptions
  WHERE status IN ('active', 'past_due', 'incomplete');

-- Compare to: stripe subscriptions list --connect-account=acct_momentum
-- --status=active | length

-- Ledger invariant: balance = latest ledger row balance_after.
-- IS DISTINCT FROM, not <>: a member with a balance but NO ledger row
-- yields NULL from the subquery, and `x <> NULL` filters the row out
-- — the exact broken case would pass silently. Zero balances are the
-- one legal no-ledger-row case (the ledger CHECK rejects amount = 0).
SELECT count(*) AS bad_invariant FROM credit_balances cb
  WHERE cb.current_credits <> 0
    AND cb.current_credits IS DISTINCT FROM (
    SELECT balance_after FROM credit_ledger_entries
     WHERE tenant_id = cb.tenant_id AND member_id = cb.member_id
     ORDER BY entry_number DESC LIMIT 1
  );
-- expect: 0
```

## Rollback

If something breaks within the first hour:

1. Revert DNS to Momentum's old portal
2. Revert Stripe Connect webhook URL to old endpoint
3. Lift Momentum's read-only mode (writes resume)
4. Investigate offline; do NOT keep Courtside live with broken state

After the first hour, rolling back gets messier — any new bookings on
Courtside would be lost. Better to fix forward.

## Inventory checklist

Before running anything, confirm you have:

- [ ] Momentum DB read access (snapshot endpoint or replica)
- [ ] Setmore export (CSV / API access)
- [ ] Stripe restricted key with read+write to Momentum's connected
      account (for the backfill script)
- [ ] Email service ready to send the password-reset welcome email
- [ ] Tenant + admin already created in Courtside (manually via
      platform endpoint or psql) — this is the home for everything
      we're about to import
- [ ] Stripe Connect onboarding for Momentum's account COMPLETE
      (`charges_enabled = true`) — we don't want to discover a
      half-onboarded state mid-migration
- [ ] DNS access ready for cutover

## Files in this directory

```
README.md                    this file
01_snapshot_source.js        skeleton — fill in once Momentum's source schema is known
02_transform.js              pure transformers (driver still skeleton) — source row → Courtside row + source_*_id refs
03_load.js                   transactional load against Courtside DB via privileged pool; resolves refs, writes out/load_report/
04_stripe_backfill.js        adds courtside_* metadata to existing Stripe objects; exits 1 on any per-row failure
05_verify.js                 counts (EXPECT_* env, required) + invariants from Courtside DB
shared/                      common helpers (DB connection, logging, deterministic ids)
out/load_report/             skip/review reports written by 03_load (gitignored)
```

## Source schema inventory

See **`SOURCE_SCHEMA.md`** in this directory. That's the
table-by-table contract between Momentum and Courtside. **Fill it
in before writing any extraction code** — it's the artifact that
makes `01_snapshot_source.js` and the `mapMomentumSubStatus()`
switch in `02_transform.js` mechanical to write.

If you find an edge case mid-migration, capture it in
SOURCE_SCHEMA.md before fixing it in code. Doc is the source of
truth.
