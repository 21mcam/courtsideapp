# Beta checklist — from repo to a usable facility

The operator runbook for getting Courtside to the point where you can
use it as a real facility: create a tenant, configure a catalog, take
member and walk-in bookings, collect payments. Follow it top to
bottom once; each section says what breaks if you skip it.

Companion docs: [SUPABASE_SETUP.md](SUPABASE_SETUP.md) (database),
[RAILWAY_SETUP.md](RAILWAY_SETUP.md) (deploy + env vars),
[MIGRATIONS_APPLIED.md](MIGRATIONS_APPLIED.md) (what's live).

---

## 1. Database

- [ ] All migrations in `db/migrations/` applied to live Supabase, in
      order, by hand ([SUPABASE_SETUP.md](SUPABASE_SETUP.md) §2).
      **Nothing applies on deploy.** Check
      [MIGRATIONS_APPLIED.md](MIGRATIONS_APPLIED.md) for the current
      applied-through number and bump it when you apply more.
- [ ] `app_runtime` role password set (`ALTER ROLE app_runtime
      PASSWORD '...'`) and reflected in `DATABASE_URL`.
- [ ] pg_cron: not required. Leave the Node scheduler on (next
      section) — it owns weekly credit resets, expired-hold cleanup,
      auto-completing past bookings, and class-instance generation.

## 2. Railway env vars

Full table with per-variable failure modes in
[RAILWAY_SETUP.md](RAILWAY_SETUP.md) §2. The beta-critical calls:

- [ ] `APP_HOSTNAME` = your apex (e.g. `app.yourdomain.com`).
      Without it every emailed link — including the walk-in
      manage/reschedule link — points at `tenant.localhost:5173`.
- [ ] `JWT_SECRET` set (login 500s without it), `NODE_ENV=production`.
- [ ] `SUPER_ADMIN_TOKEN` set — required to create a tenant (§5).
- [ ] `RESEND_API_KEY` **and** `EMAIL_FROM` set together.
      `EMAIL_FROM` must be a sender on a domain verified in your
      Resend account; the built-in default (`noreply@courtside.app`)
      gets rejected by Resend and every email silently fails. The
      server logs a boot warning if you forget.
- [ ] `PLATFORM_TRIAL_DAYS=0` — unless you've fully configured
      platform billing (`PLATFORM_PRICE_ID` +
      `PLATFORM_STRIPE_WEBHOOK_SECRET` + the second webhook in §3),
      an API-created tenant hits a 402 billing hold 30 days after
      signup with no self-serve exit. (Escape hatch if it happens:
      `PATCH /api/platform/tenants/{subdomain}/billing` with
      `{"trial_ends_at": null}` and the super-admin header.)
- [ ] `SCHEDULER_ENABLED` left **unset**.
- [ ] `VITE_API_URL` left **unset**; `STRIPE_CONNECT_CLIENT_ID`
      skipped (dead config); `STRIPE_TEST_MODE` never set in prod.

## 3. Stripe (platform account)

- [ ] `STRIPE_SECRET_KEY` set on Railway.
- [ ] **Connect webhook** — the single most fragile manual step.
      Stripe dashboard → Developers → Webhooks → Add endpoint:
      - URL: `https://<apex>/webhooks/stripe`
      - **"Listen to events on Connected accounts"** — NOT the
        default own-account option. Miswired, every walk-in payment
        and member subscription succeeds on Stripe while the booking
        never confirms and credits never grant.
      - Events: `account.updated`, `checkout.session.completed`,
        `invoice.payment_succeeded`, `customer.subscription.updated`,
        `customer.subscription.deleted`
      - **Pin the endpoint's API version to 2024-11-20 (acacia)** —
        the handlers read payload fields that newer versions moved;
        an unpinned 2026-default endpoint silently breaks period
        reconciliation.
      - Signing secret → `STRIPE_WEBHOOK_SECRET` on Railway.
- [ ] (Only if charging tenants) **Platform webhook**: second
      endpoint at `https://<apex>/webhooks/stripe-platform`, this one
      on your own account, events per `.env.example`; secret →
      `PLATFORM_STRIPE_WEBHOOK_SECRET`.
- [ ] During beta keep the Stripe webhook-delivery log open when
      testing payments — "payment landed but nothing granted" states
      currently surface only there and in Railway logs (watch for
      `skipping` / `manual reconciliation` warnings).

## 4. Domains + first deploy

- [ ] Railway custom domains: `apex` **and** `*.apex` wildcard, with
      both CNAMEs at your DNS provider ([RAILWAY_SETUP.md](RAILWAY_SETUP.md) §3).
      Tenants are unreachable on the default `.up.railway.app` host.
- [ ] Healthcheck path `/health` set in Railway settings.
- [ ] Deploy log shows the client build ran (`vite build`); if the
      bundle is missing, Express boots API-only and the site shows
      `Cannot GET /` while `/health` stays green.
- [ ] `curl https://<apex>/health` → `{"ok":true,"db":"ok",...}`.

## 5. Create your tenant

Two ways — there is no signup UI:

**Option A — seed the demo facility** (fastest; full catalog, hours,
plans, members, sample bookings; trial-exempt):

Paste `db/seeds/sunset_park_demo.sql` into the Supabase SQL editor.
Login: `owner@sunsetparkbaseball.com` / `sunset2026` at
`https://sunsetpark.<apex>/login` (subdomain `sunsetpark`, no hyphen).

**Option B — a real tenant via the platform API:**

```bash
curl -X POST https://<apex>/api/platform/signup-tenant \
  -H "X-Super-Admin-Token: $SUPER_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "subdomain": "myfacility",
    "name": "My Facility",
    "timezone": "America/New_York",
    "owner_email": "you@yourdomain.com",
    "owner_password": "min 8 chars",
    "owner_first_name": "Mike",
    "owner_last_name": "Campbell"
  }'
```

Then log in at `https://myfacility.<apex>/login` and run the setup
wizard (`/wizard`): resources → offerings → plans.

## 6. Tenant configuration (in the admin UI)

- [ ] **Operating hours** — the wizard does NOT set them; resources
      are unbookable until you do (Settings → Hours).
- [ ] **Booking policies** row saved (Settings → Policies) —
      cancellation tiers, reschedule cutoff, booking window.
- [ ] **Stripe Connect onboarding** (Admin → Stripe) completed until
      `charges_enabled` — every member checkout and the public
      booking page's payment 409 before that.
- [ ] **Plans synced to Stripe** — Catalog → each plan → Sync.
      Unsynced plans are invisible on the member Plans page by
      design.
- [ ] **Reply-to email** set in Settings — every email template
      invites replies; without it they go to the platform noreply.
- [ ] (Live mode) Tenant's **Customer Portal settings** saved once in
      their own Stripe dashboard (Settings → Billing → Customer
      portal) or the member "Manage" button errors.
- [ ] Optional: GA4 measurement id + Google rating/review count in
      Settings for the public page; offering descriptions;
      category display labels.

## 7. First-hour smoke test

In order, as three people (admin / member / walk-in):

1. Booking page loads at the shared link (Admin home → Booking page).
2. Walk-in books + pays (Stripe test card) → booking flips confirmed
   on the calendar, confirmation email arrives **with a working
   manage link** (this proves webhook + `APP_HOSTNAME` + Resend in
   one shot). Try the reschedule link.
3. Member self-registers at `/register`, subscribes to a plan
   (webhook grants first-week credits), books with credits, cancels,
   sees the refund per policy.
4. Admin: add a member from Admin → Members → they get a set-password
   email → that link works and they can log in.
5. Front-desk booking from the calendar (member and walk-in cash).
6. Check Railway logs for `[email]` errors — that log line is
   currently the only email-failure signal.

## 8. Known gaps — don't file these as beta bugs

Deliberate scope cuts as of 2026-08, verified against the code.

- **No reminder emails** (biggest visible gap vs Setmore).
- **Classes send no emails at all** — including admin class
  cancellation (roster is refunded but nobody is notified; contact
  attendees manually). Members only enter classes self-serve: no
  public class sales, no admin add-to-roster.
- Class schedules can't be edited/deactivated once created;
  blackouts are not enforced for class instances.
- **No card refunds in-app** — cancelling a paid walk-in keeps the
  money; the UI now reminds you to refund in the Stripe dashboard.
- **Cash-on-arrival is never marked paid** — Reports deliberately
  excludes it from revenue; keep a separate cash record.
- No-show handling marks the booking only (fee/blocking options are
  intentionally hidden until built).
- No member contact-info editing (admin or self-serve) — a typo'd
  email needs SQL. No logged-in password change (use `/forgot`).
- Calendar is day-view only.
- Cancelled subscriptions don't cancel the member's future bookings
  or claw back credits.
