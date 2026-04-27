# Courtside — Build Plan

*Working name; replace when you pick a real one.*

A credit-based membership and booking platform for facilities that rent
time on resources — batting cages, ice rinks, golf simulator bays, court
time, practice rooms, co-working spaces. Members buy a monthly
subscription that grants weekly credits; they spend credits on
bookings. Tenants can also accept public walk-in bookings at a separate
cash price. Fixed-capacity and recurring classes supported.

Momentum Sports (the existing Diamond Club Portal) is the first
real-world tenant. Migration is Phase 6.

---

## Product thesis

Subscription → credits → resource bookings. Members pay monthly, get N
weekly credits, spend them on different booking types at
tenant-defined credit costs. Walk-ins pay tenant-defined cash prices
for the same slots when the tenant enables public booking. Classes
(fixed-cap or recurring) use the same credit/cash model with an added
capacity layer.

This is tighter and broader than Momentum's current shape. Tighter
because it commits to one booking model (resource-per-timeslot + class
capacity) rather than trying to also do lesson-booking (staff
availability) or general appointment booking. Broader because it
generalizes Momentum's cages into any resource rental across
verticals.

### ICP

Newly launching facilities without an established workflow, across:
batting cages, hockey skills, golf simulators, boutique gyms, and
similar niche spaces. Explicitly not targeting facilities happy with
their current tool — switching costs are too high and that's a
cold-email grind. New facilities are easier to land and don't require
us to unseat an incumbent.

### Differentiation

Flexibility through tenant configuration, at a lower price point than
Mindbody / Gymdesk / Zen Planner. Radical configurability is the
product — every pricing, policy, visibility, and payment decision is
tenant-owned. Competing on feature count with Mindbody is a losing
game; competing on "configure it your way, cheap, good defaults" is
winnable.

---

## Scope — what's in v1, what's out

### In

- Multi-tenant from day one (tenant_id on every row, RLS isolation,
  subdomain routing)
- Tenant onboarding wizard (7 steps, ~20 min to working booking page)
- Resources (cages, bays, rinks, rooms — whatever the tenant rents)
- Bookable types with credit cost AND dollar price (admin-defined)
- Subscription plans with weekly credit allotments and optional
  category restrictions ("Class Pack plan can only spend on classes")
- Weekly credit reset (pg_cron, tenant-aware)
- Member booking flow (credits, lock-based concurrency, refund on
  cancel)
- Public walk-in booking flow (contact form, no account required)
- Booking state machine: pending_payment → confirmed →
  completed/no_show/cancelled
- Stripe Connect Standard for tenant-owned payments (walk-in payments
  + member subscriptions both route to tenant's Stripe)
- Cash-on-arrival option for walk-ins (tenant-configurable per
  bookable type)
- Fixed-capacity classes (8-spot hitting clinic, etc.)
- Recurring class series (every Tuesday 6pm for 10 weeks)
- Tenant-configurable cancellation and no-show policies (simple 3-field
  version, not a rules engine)
- Confirmation and reminder emails via Resend, per-tenant reply-to
- Customer self-service cancel link (magic token, no login)
- Admin calendar view (desktop + mobile, for staff day-to-day use)
- Staff "book on behalf of walk-in" flow (mobile-first, since current
  Momentum workflow is iPhone-at-the-counter)
- Scheduled deactivation, billing period handling,
  booking-period-end logic (port from current Momentum code)

### Out — deferred to v1.1 or later

- Lessons (staff-per-timeslot booking, where a booking requires both a
  resource AND a specific instructor)
- Member priority booking windows (default parity with walk-ins; add
  later if tenants ask)
- POS: catalog, tax, surcharge, refunds, receipts. Tenants use Square
  or Stripe Terminal separately. Integration with these is a v2
  conversation.
- Advanced cancellation rules engines (tiered refund percentages
  beyond the 3-field default)
- Waitlists
- Attendance tracking, reporting dashboards
- Mobile native apps (PWA is enough)
- Public-facing booking page SEO features
- Multi-language / i18n

---

## Timeline

Approximately 17 weeks at 15–20 hrs/week. Phase 4 (classes) lands
around early August, hitting the Momentum fall/winter deadline.

Blackout weeks: CJ's wedding is a hard stop. Put it on the calendar
now, do not schedule phase-critical work through it.

| Phase | Weeks | Focus |
|-------|-------|-------|
| 0 | 1–2 | Foundation |
| 1 | 3–4 | Tenant + member basics |
| 2 | 5–7 | Resources, plans, credits, onboarding wizard |
| 3 | 8–11 | Calendar engine + member + walk-in booking |
| 4 | 12–13 | Classes |
| 5 | 14–15 | Stripe Connect subscriptions |
| 6 | 16–17 | Momentum migration |

Phase 3 is explicitly budgeted 4 weeks and may stretch to 5. It is the
product — do not rush it. If it slips, everything downstream slips by
the same amount, and that's fine. Momentum fall/winter has some
flexibility; correctness does not.

---

## Phase plans

### Phase 0 — Foundation (weeks 1–2)

**Goal:** a multi-tenant skeleton with no user-facing features, ready
to build on.

- New repo, new Supabase project, new Railway service.
- Multi-tenant schema: `tenant_id` on every application table.
- Supabase Row-Level Security policies enforcing tenant isolation on
  every query.
- Subdomain routing: `{tenant}.app.com` resolves to a tenant context
  loaded into every request.
- Auth (JWT or Supabase Auth) that knows which tenant a user belongs
  to.
- Glossary pass: pick the core nouns and never rename them. Current
  draft list: `tenant`, `admin_user` (tenant staff), `member`
  (paying member), `customer` (walk-in), `resource`, `bookable_type`,
  `plan`, `credit_grant`, `booking`, `class_instance`, `policy`. Write
  these into a CLAUDE.md in the new repo so they stay fixed.
- Basic CI, deploy pipeline, health check.

**Resist:** porting Momentum code. Copy patterns, not files. The
schema will diverge enough that copy-paste creates more debt than it
saves. Phase 0 is boring and feels like no progress. It is progress.

### Phase 1 — Tenant + member basics (weeks 3–4)

**Goal:** tenants can sign up and create member accounts. No bookings
yet.

- Tenant signup (facility name, subdomain, timezone, primary contact).
- Super-admin view (yours only) for managing all tenants.
- Per-tenant admin accounts with email/password auth.
- Member signup/login, scoped to a tenant by subdomain.
- Basic admin panel skeleton with tenant-scoped navigation.
- Password reset flow (port from current Momentum, tenant-aware).

### Phase 2 — Resources, plans, credits, onboarding wizard (weeks 5–7)

**Goal:** tenants can configure their offering and have it "work" as a
catalog, even before bookings are live.

- Admin CRUD for resources (Cage 1, Rink 2, Sim Bay 3).
- Admin CRUD for bookable types with credit cost + dollar price +
  duration + resource assignment + category.
- Admin CRUD for plans with weekly credit allotment and optional
  category whitelist/blacklist.
- Credit balances per member, pg_cron weekly reset (port from current,
  tenant-aware).
- **Onboarding wizard**: guided 7-step flow that takes a brand-new
  tenant from signup to a working booking page in ~20 minutes. This
  is load-bearing for sales. Do not treat it as UI polish to do at
  the end — it's a core Phase 2 deliverable.
- Admin member management (create, adjust credits, change plan, all
  tenant-aware).

### Phase 3 — Calendar engine + member + walk-in booking (weeks 8–11)

**Goal:** the product works end to end for one tenant. This is the
phase where the system becomes sellable.

- Availability engine (port and generalize current interval-overlap
  logic): operating hours per resource, blackout dates, DST-safe
  timezone handling per tenant.
- Member booking flow: credits, FOR UPDATE lock, refund on cancel.
- Public walk-in booking flow: contact form (name, email, phone),
  pays via Stripe Connect OR marks as cash-on-arrival depending on
  tenant setting.
- Booking state machine: `pending_payment → confirmed →
  completed/no_show/cancelled`.
- Cancellation policy: simple 3 fields — `free_cancel_hours_before`,
  `partial_refund_hours_before`, `partial_refund_percent`.
- No-show policy: tenant decides whether no-shows get blocked,
  charged, or nothing.
- Confirmation and reminder emails via Resend, per-tenant reply-to
  address.
- Customer self-service cancel via magic token link (no account
  required).
- Admin booking calendar view (day/week, all resources, all
  bookings, member vs walk-in color-coded). Desktop + mobile both
  matter — staff will use this on a phone.
- Staff "book on behalf of walk-in" flow — mobile-first, replicates
  the current Setmore-on-an-iPhone workflow at Momentum. Benchmark:
  same number of taps or fewer than Setmore. This is a usability
  gate, not a nice-to-have.
- Per-bookable-type "allow public booking" toggle.
- Stripe Connect Standard onboarding for tenants.

**Resist:** member priority windows, multi-tier cancellation rules,
booking modification (vs cancel-and-rebook), waitlists. Write them in
a v1.1 file; ignore them until Phase 3 ships.

### Phase 4 — Classes (weeks 12–13)

**Goal:** Momentum can run fall/winter training memberships with class
capacity on this platform.

- Fixed-capacity classes: bookable type with a capacity field and a
  roster table per class instance.
- Recurring class series: "every Tuesday 6pm for 10 weeks, 8 spots
  each." Generates class instances on save.
- Member booking into classes (credits debit, capacity decrement,
  cancel refunds both).
- Walk-in booking into classes (payment or cash, same dual flow as
  resource bookings).
- Class roster view for admin (who's coming Saturday?).
- No-show marking hooks into Phase 3's no-show policy.

### Phase 5 — Stripe Connect subscriptions (weeks 14–15)

**Goal:** tenants can collect recurring subscription revenue from
members through their own Stripe account.

- Member subscribes to a plan via Stripe Connect Checkout Session.
- Webhook handlers (port from current Momentum, tenant-aware):
  `checkout.session.completed`, `invoice.payment_succeeded`,
  `customer.subscription.updated`, `customer.subscription.deleted`.
- Stripe Customer Portal integration so members can self-manage
  subscriptions.
- Scheduled deactivation + period-end booking cancellation logic (port
  from current).
- Optional Stripe `application_fee` on subscription payments if you
  want platform revenue share. Decide later; default to flat SaaS fee
  only.

### Phase 6 — Momentum migration (weeks 16–17)

**Goal:** Momentum runs on Courtside. Old portal and Setmore are
archived.

- Data migration script: members, credit balances, plans, upcoming
  bookings. Tested against a Supabase snapshot before touching live.
- Forward cutover: pick a date (e.g. Sept 1). From that date, all new
  bookings go through Courtside. Setmore continues to hold pre-existing
  bookings scheduled after that date, and the current keepalive /
  hard-delete workaround keeps running until those bookings complete.
- Run both systems concurrently for up to 60 days until the last
  Setmore booking completes.
- Member communication: email blast about the switch, FAQ page, login
  links to new URL.
- Final Setmore shutdown: cancel account, remove env vars, delete
  `setmore.js`, `setmoreWebUI.js`, `setmoreKeepalive.js`, and the
  cookie re-capture doc. Celebrate.
- Full archive of old Momentum Diamond Club Portal repo.

**Do not** migrate Momentum's WooCommerce camp/lesson-package sales.
That's a separate integration or a manual workflow for now. Scope it
post-v1.

---

## Payments architecture

Stripe Connect Standard. Each tenant has their own Stripe account; the
platform routes payments to them. Courtside never stores tenants'
Stripe API keys and never handles their members' money directly.

- Tenant clicks "Connect Stripe" in admin → OAuth to Stripe → platform
  receives account ID → stored on tenant record.
- Walk-in payments: create PaymentIntent `on_behalf_of` and
  `transfer_data.destination` = tenant's Connect account.
- Subscription payments: create Checkout Session with
  `subscription_data.application_fee_percent` if platform fee is on.
- Courtside's own SaaS fee (what tenants pay to use the platform) is
  billed separately via the platform's own Stripe account, totally
  independent from tenant Connect.

Phase 3 requires this working for walk-in payments. Phase 5 extends it
to subscriptions.

---

## Risks, called out by name

1. **Phase 3 wants to grow.** Every line has an attached "while we're
   here, let's also…". Member priority, booking modifications,
   waitlists. Keep a `v1.1.md` file in the repo. Write it down, move
   on. If Phase 3 stretches past 5 weeks, the fall/winter deadline is
   actually at risk; cut scope, don't extend.

2. **The onboarding wizard is load-bearing.** It's the thing that
   makes the product sellable. Treating it as polish-at-the-end is a
   classic trap. Budget real time in Phase 2.

3. **CJ's wedding.** Put the blackout week on the calendar before
   starting Phase 0. Adding it in advance is free; adjusting around it
   mid-phase costs double.

4. **The "I'll just port Momentum code" temptation.** Momentum's code
   is single-tenant, Setmore-coupled, and has cruft (POS, hard-delete
   workaround). Copy *patterns* — the credit-reset logic, the booking
   transaction shape, the webhook handler structure. Don't copy
   *files*. Retrofitting multi-tenancy onto ported code is worse than
   writing new tenant-aware code from the start.

5. **Selling before v1 is ready.** Warm leads: yes. Paying customers:
   no, until late Phase 5. A paying tenant on a half-built product
   drags you into support before the product is stable. Keep
   conversations going without committing to onboarding anyone until
   the product is ready to hold up.

6. **Replacing Setmore is all-or-nothing for Momentum.** There's no
   soft launch because Setmore handles 100% of Momentum's walk-ins
   today. The day you migrate Momentum, the new platform becomes
   load-bearing for walk-in revenue. This raises the stakes on Phase
   3's public booking flow. Don't cut corners there.

7. **Staff adoption fails migrations.** The iPhone-at-the-counter
   workflow at Momentum must be at least as fast in the new system as
   in Setmore. Before Phase 3 starts, time the current workflow at
   Momentum — count taps, count seconds. That's your benchmark.

---

## Pre-Phase-0 checklist

Before writing any code:

- [ ] Terminology glossary written (10–15 core nouns, picked once).
- [ ] Schema sketch on paper for the main tables.
- [ ] New Supabase project created.
- [ ] New Railway service created.
- [ ] New repo initialized, `CLAUDE.md` with glossary committed,
      placeholder name chosen.
- [ ] CJ's wedding week marked as a blackout on the build calendar.
- [ ] Current Momentum walk-in workflow timed for the benchmark.
- [ ] Warm-lead spreadsheet started: 5 facility-owner names, no emails
      yet.

Total pre-code time: one evening, maybe two.

---

## What success looks like by phase

- **End of Phase 0**: You can sign up a fake tenant, log in as its
  admin, see an empty admin panel. No bookings, no features. But RLS
  is enforced and subdomain routing works.
- **End of Phase 2**: A new tenant can complete the wizard and have a
  catalog visible to members. Still no bookings.
- **End of Phase 3**: One tenant — seeded manually or via the wizard —
  can accept both member and walk-in bookings. This is the
  demoable-to-prospects milestone.
- **End of Phase 4**: Momentum could in theory run its fall/winter
  class offering on Courtside (if it were the active tenant).
- **End of Phase 5**: End-to-end member lifecycle works: sign up, pay
  via Stripe, book sessions, cancel, resubscribe.
- **End of Phase 6**: Momentum is on Courtside. Setmore is gone. The
  old portal is archived. You have a working multi-tenant SaaS with
  one paying tenant (Momentum, paying yourself).

From there, v1.1: lessons, member priority, waitlists, and the first
outside design partners.

---

## Post-v1 backlog (v1.1 and beyond)

Write these somewhere and ignore them until Phase 6 ships:

- Lessons (staff-per-timeslot booking)
- Member priority booking windows
- Waitlists
- Advanced cancellation rules engines
- Attendance tracking + reporting
- Booking modification (reschedule in place, not cancel-and-rebook)
- Public booking page SEO / indexable pages
- Per-tenant custom domains (vs subdomain only)
- Integration with Square / Stripe Terminal for tenants who want POS
- Multi-location tenants (a single tenant with multiple facilities)
- Email/SMS reminders via tenant's own SendGrid/Twilio
- Member referral tracking
- Gift memberships, prepaid gift cards

These are good ideas. They all wait.

---

*Last updated: Phase 0, pre-launch.*
