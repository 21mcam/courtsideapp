# Momentum → Courtside migration runbook

Phase 6 deliverable. One-shot, fail-closed pipeline for moving
Momentum's existing data into Courtside without disrupting active
Stripe billing or losing audit history.

**Strategy: HARD CUTOVER.** One morning: freeze both old systems,
import everything — including future Setmore bookings — verify, flip.
This supersedes PLAN.md's former plan of running Setmore in parallel
for up to 60 days. That plan existed because Courtside couldn't take
walk-ins, so Setmore had to keep serving them; walk-in checkout v2
(PRs #53/#54) removed that reason. What parallel running would buy
now is nothing, and what it costs is two scheduling systems accepting
bookings for the same cages — double-booking by design. One source of
truth per booking; no dual-write scheduling, ever.

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
   a staging Postgres, run the full pipeline, run verify, then smoke
   test. Iterate until verify passes cleanly. *Then* schedule
   production cutover.

4. **One source of truth per booking.** From the freeze onward,
   Setmore never takes another booking. It survives only as a
   read-only reference, never a scheduling system.

## Prework (days-to-weeks BEFORE cutover day)

None of this belongs on cutover morning. The pipeline hard-fails if
any of it is missing — do it early, verify it on the staging dry run.

- [ ] **Admin-UI prework in Courtside**: tenant + admin created;
      offerings (matching the `services` map in `momentum.map.json`),
      plans (with Momentum's live `stripe_price_id`s), booking
      policies, resources, and operating hours all created by hand.
      The migration translates onto these rows — it never creates
      catalog.
- [ ] **`momentum.map.json` fully resolved** — no `TODO` strings, no
      null prices. Requires inspecting a real Setmore export for
      `setmore_columns`, `setmore_status_map`, and `staff_keys`.
      `02_transform.js` aborts with the complete gap list otherwise.
- [ ] **Setmore CSV export procedure** written down and rehearsed:
      who logs in, which report, which date range (all history
      through the furthest future booking), where the file lands
      (`out/source/setmore_bookings.csv`). Timestamps in the export
      parse under a strict contract — ISO-naive
      `YYYY-MM-DD HH:MM[:SS]`, US `M/D/YYYY H:MM AM/PM`, or an
      explicit UTC offset (passed through as-is); naive wall-clock
      times convert via `momentum.map.json`'s `timezone`, never the
      host zone. Exports that split date and time into separate
      columns map the optional `setmore_columns.date` entry. Full
      contract in SOURCE_SCHEMA.md.
- [ ] **Pending gifts resolved.** Every `credit_grants` row with
      `status='pending'` is paid-for, undelivered credits whose claim
      link dies at DNS flip. Chase claims, refund, or write the
      manual-grant plan into this runbook — BEFORE cutover day, not
      during it. (Blocker `pending_gifts` enforces this.)
- [ ] Momentum DB read access (snapshot endpoint or replica)
- [ ] Stripe restricted key with read+write to Momentum's connected
      account (for the backfill script)
- [ ] Stripe Connect onboarding for Momentum's account COMPLETE
      (`charges_enabled = true`)
- [ ] Email service ready to send the password-reset welcome email
- [ ] DNS access ready for cutover

## The fail-closed contract

Every stage writes a manifest (`shared/manifest.js`) recording each
artifact it produced — row count + sha256. Every downstream stage
REFUSES to run unless the upstream manifest exists, is the right
kind, and the bytes on disk still hash to what it recorded. A dataset
that goes missing or gets hand-edited between stages is a hard error,
never an empty import that "verifies" clean.

- `01_snapshot_source.js` → `out/source/manifest.json`
- `02_transform.js` → `out/transformed/manifest.json`, which also
  carries `expected` (reconciliation numbers 05 checks the live DB
  against) and `blockers`
- `03_load.js` → `out/load_report.json`

**Artifact lineage.** The artifacts also chain to each other by
content hash: the transformed manifest records
`source_manifest_sha256` (sha256 of the raw bytes of
`out/source/manifest.json`), and the load report records
`transformed_manifest_sha256` (sha256 of the raw bytes of
`out/transformed/manifest.json`). `05_verify.js` recomputes both
links and FAILs on any mismatch — so mixing artifacts from different
pipeline runs (yesterday's transform under today's load) can never
verify green.

**Blockers** are conditions that make the import unsafe. Load and
verify abort while any blocker is unacknowledged. The full inventory
(details per code in SOURCE_SCHEMA.md):

| Code | Meaning | Emitted by | Enforced by |
|------|---------|------------|-------------|
| `pending_gifts` | paid-but-undelivered gift credits whose claim links die at DNS flip | 02 | 02, 03, 05 |
| `duplicate_emails` | source emails colliding after lowercasing; once acked, the earliest-created member per set is kept and the rest are DROPPED — never merged | 02 | 02, 03, 05 |
| `active_without_stripe` | active members with no `stripe_subscription_id` — a paying member Stripe doesn't know about | 02 | 02, 03, 05 |
| `plan_credits_mismatch` | members sharing a plan key disagree on `credits_per_week`; once acked the plan carries the MODE value and the detail file lists every disagreeing member | 02 | 02, 03, 05 |
| `future_walkins_missing_contact` | future Setmore appointments missing name/email — people who will show up to a booking Courtside doesn't know about | 02 | 02, 03, 05 |
| `booking_conflicts` | synthetic: manufactured by 05 from the load report's `overlap_conflicts` (double-booked source slots the loader SAVEPOINT-skipped) | 05 | 05 only — it can't exist at transform time, so it is ackable only via `MIGRATION_ACK_BLOCKERS` at verify time |

The double opt-in: fix the problem at the source, or deliberately set
`MIGRATION_ACK_BLOCKERS=<code,...>` — and **every ack must be
recorded in this runbook** with the operational plan that justifies
it. An ack without a written plan is a bug in the operator.

An ack is not a blanket waiver — the pipeline resizes its own
arithmetic to hold the ack to exactly the recorded count:

- `duplicate_emails` acked → 05's source-row reconciliation expects
  `members.json` rows == imported members + exactly the dropped-row
  count the transformed manifest recorded
  (`exceptions.duplicate_emails`). One more missing row than the ack
  covers is still a FAIL.
- `active_without_stripe` acked → 05's "active subscriptions have a
  `stripe_subscription_id`" invariant tolerates exactly the
  blocker's recorded count; unacked, the tolerance is 0.

Anything intentionally not migrated (admin members, timeless
bookings, contact-less walk-ins, archive-only tables) is counted and
written to an exceptions report. Nothing is silently dropped.

## Phases

| Step | Script | What | When |
|------|--------|------|------|
| 1 | `01_snapshot_source.js` | Dumps the Diamond DB to JSON in `out/source/`, verifies + hashes the Setmore CSV, writes the source manifest | Cutover starting line |
| 2 | `02_transform.js` | Pure function: verified source files → Courtside-shaped JSON + exceptions + blockers in `out/transformed/` | Rerunnable; also the staging workhorse |
| 3 | `03_load.js` | Loads the live Courtside DB; idempotent via `bookings.external_source`/`external_id` (migration 031) and natural keys; refuses to run over unacked blockers | After transform |
| 4 | `04_stripe_backfill.js` | Adds `courtside_*` metadata to existing Stripe Customers + Subscriptions on Momentum's connected account | Idempotent; safe to rerun |
| 5 | `05_verify.js` | Fail-closed gate: compares live DB against the transform manifest's `expected` + `EXPECT_*` env; nonzero exit = no flip | Before webhook/DNS flip |

## Environment variables

| Var | Used by | Meaning |
|-----|---------|---------|
| `MOMENTUM_SOURCE_URL` | 01 | Read-only connection string to the Diamond DB (replica/snapshot) |
| `MIGRATION_DATABASE_URL` | 03, 04, 05 | Privileged Courtside DB connection (`shared/db.js`) |
| `MIGRATION_TENANT_ID` | 02, 03, 04, 05 | The Courtside tenant receiving the import |
| `MIGRATION_ACK_BLOCKERS` | 02, 03, 05 | Comma-separated blocker codes the operator explicitly accepts; each ack must have a written plan in this runbook. 02 gates the transform on it and records the acks in the manifest (`acknowledged_blockers`); 03 and 05 enforce again — transform-time acks carry forward, but the synthetic `booking_conflicts` blocker can only be acked here at verify time |
| `SETMORE_EXPORT_SKIP` | 01, 02 | Rehearsal-only double opt-in: 01 lets the snapshot complete without the Setmore CSV (skip recorded in the manifest); 02 then refuses to transform a skip-recorded snapshot unless the var is set AGAIN — the decision is re-affirmed, never inherited. NEVER set on cutover day — no CSV means no walk-ins |
| `EXPECT_MEMBERS`, `EXPECT_ACTIVE_SUBS`, `EXPECT_TOTAL_CREDITS`, `EXPECT_BOOKINGS_FUTURE` | 05 | Operator-supplied reconciliation counts from the source, recorded at snapshot time |

## Hard-cutover timeline (target Sunday 6am ET)

```
T-7d   Email members re: the switch (new URL, password reset ahead)
T-2h   Final dry run on staging using a fresh prod snapshot
T+0    FREEZE: Momentum old portal to read-only; Setmore booking
       intake disabled (staff instructed: no new appointments)
T+5m   Final Setmore CSV export → out/source/setmore_bookings.csv
T+10m  01_snapshot_source.js
T+15m  02_transform.js — resolve/ack any blockers it reports
T+20m  03_load.js (production Courtside DB)
T+30m  04_stripe_backfill.js (Stripe live API)
T+35m  05_verify.js — GATE. Nonzero exit = abort, do not flip.
T+40m  Update Stripe Connect webhook URL on Momentum's account:
         from: <Momentum old endpoint>
         to:   https://app.courtside.example/webhooks/stripe
T+45m  DNS / load balancer: switch member-facing domain to Courtside
T+50m  Members can log in (password-reset link from welcome email).
       Walk-ins book on the Courtside public page. Tail logs.
```

## Setmore retirement

Immediate — that's the point of the hard cutover:

- The keepalive / hard-delete workaround runs **until cutover day
  only**. Once verify passes and DNS flips, there is nothing left in
  Setmore that Courtside doesn't have (future bookings included).
- The Setmore account is kept **read-only for 30 days** alongside the
  Diamond DB (hard rule 2) as the reference copy, then cancelled.
- Then the code funeral: remove env vars, delete `setmore.js`,
  `setmoreWebUI.js`, `setmoreKeepalive.js`, and the cookie re-capture
  doc from the old repo. Celebrate.

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

-- Purchased-credit split sanity: purchased never exceeds balance
SELECT count(*) FROM credit_balances
  WHERE purchased_credits > current_credits;
-- expect: 0 (also enforced by CHECK)
```

## Rollback

If something breaks within the first hour:

1. Revert DNS to Momentum's old portal
2. Revert Stripe Connect webhook URL to old endpoint
3. Lift Momentum's read-only mode (writes resume)
4. Re-enable Setmore intake + keepalive
5. Investigate offline; do NOT keep Courtside live with broken state

After the first hour, rolling back gets messier — any new bookings on
Courtside would be lost. Better to fix forward.

## Files in this directory

```
README.md                    this file
SOURCE_SCHEMA.md             table-by-table source contract — read it first
momentum.map.json            hand-authored name/price/column translation table
01_snapshot_source.js        Diamond DB + Setmore CSV → out/source/ + manifest
02_transform.js              verified source → Courtside-shaped JSON + blockers
03_load.js                   transactional load; blocker-gated; provenance-keyed
04_stripe_backfill.js        courtside_* metadata onto existing Stripe objects
05_verify.js                 the gate: counts + invariants, nonzero exit on any miss
shared/                      manifest/csv/mapping/db/log helpers (the contract)
```

## Source schema inventory

See **`SOURCE_SCHEMA.md`** in this directory — the table-by-table
contract between Momentum and Courtside, now filled in from the live
Diamond schema. If you find an edge case mid-migration, capture it
there before fixing it in code. Doc is the source of truth.
