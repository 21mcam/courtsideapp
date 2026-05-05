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
| 2 | `02_transform.js` | Reads `out/source/*` and writes Courtside-shaped JSON to `out/transformed/` | Reads-only; can rerun |
| 3 | `03_load.js` | Inserts into the live Courtside DB inside one transaction per logical group | Idempotent via UPSERT keys; rerun-safe until verify passes |
| 4 | `04_stripe_backfill.js` | Updates existing Stripe Customers + Subscriptions on Momentum's connected account with `courtside_*` metadata | Idempotent; safe to rerun |
| 5 | `05_verify.js` | Compares row counts + invariants between source and target | Read-only |

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

-- Ledger invariant: balance = latest ledger row balance_after
SELECT count(*) AS bad_invariant FROM credit_balances cb
  WHERE cb.current_credits <> (
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
02_transform.js              skeleton — pure functions, source row → Courtside row
03_load.js                   transactional load against Courtside DB via privileged pool
04_stripe_backfill.js        adds courtside_* metadata to existing Stripe objects
05_verify.js                 reads counts + invariants from Courtside DB (and Momentum source for compare)
shared/                      common helpers (DB connection, logging, error)
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
