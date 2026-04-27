# Courtside — Claude context

*Working name; replace when you pick a real one.*

A multi-tenant credit-based membership and booking platform for
facilities that rent time on resources — batting cages, ice rinks,
golf simulator bays, court time, practice rooms, co-working spaces.

This file is the canonical reference for terminology, conventions, and
architecture decisions. Read it before writing code. Update it when
decisions change.

## Stack

- **Backend:** Node.js + Express (entry: `src/server.js`)
- **Frontend:** Vite + React + Tailwind v3 at `client/`
- **DB:** Supabase (Postgres) with Row-Level Security for tenant isolation
- **Deploy:** Railway, auto-deploys from `main`
- **Payments:** Stripe Connect (Standard) — tenants own their payments
- **Email:** Resend
- **Calendar/scheduling:** Built in-house. No Setmore, no third-party
  scheduling integrations.

Both frontend and backend are served by one Express process. Railway
builds the frontend on every deploy.

## Multi-tenancy is the foundation

Every application table below `tenants` has a `tenant_id` column.
Every query is scoped by tenant_id. Supabase RLS policies enforce
isolation at the database layer; application code is the second line
of defense, not the first.

The `tenants` table itself has no `tenant_id` (it's the root). Every
table below it follows the convention:
- `tenant_id` column with FK to `tenants(id) ON DELETE CASCADE`
- `UNIQUE (tenant_id, id)` if it has its own `id` column
- Composite FKs to other tenant-scoped tables use
  `(tenant_id, foreign_id) REFERENCES other(tenant_id, id)` so
  cross-tenant references are impossible at the schema level.

When in doubt about whether a new table needs `tenant_id`: it does.

Tenants are routed by subdomain: `{tenant_subdomain}.app.com` resolves
to a tenant context loaded into every request. Auth tokens carry a
tenant_id; cross-tenant access is impossible by design.

## Multi-tenant query discipline

Every tenant-scoped request — including login and register, not just
authenticated requests — must run inside a transaction with the tenant
context set as a Postgres session variable. The pattern:

```js
await client.query(
  "SELECT set_config('app.current_tenant_id', $1, true)",
  [tenantId]
);
// ...handler runs queries on this client...
```

The `true` argument makes it transaction-local, so it's gone after
COMMIT.

RLS policies on every tenant-scoped table reference this variable:

```sql
CREATE POLICY tenant_isolation ON some_table
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
```

The application's runtime DB role does NOT have BYPASSRLS. Routes that
need to operate cross-tenant (Stripe webhooks, super-admin) use
explicit, audited escape hatches — never raw queries from a privileged
role. The Stripe webhook route resolves the tenant from the Stripe
customer ID and then sets the GUC explicitly before running queries.

**Raw `pool.query` in tenant-scoped code is a bug.** Routes use
`req.db` (a transaction-bound client with tenant context already set)
or a tenant-aware helper. If you find yourself reaching for the raw
pool in a tenant-scoped handler, stop and use the helper.

### What NOT to do during a tenant transaction

Don't hold a DB transaction open across external network calls
(Stripe, Resend, etc.). The pattern is: do DB work in the transaction,
commit, THEN call external services. For flows where reliability
matters (booking confirmation emails, payment webhook follow-ups), use
an outbox pattern — record the intent inside the transaction, and a
separate worker drains the outbox and calls the external service.

The outbox isn't built yet. For Phase 0–2, fire-and-forget after
commit + log on failure is acceptable. Mark places where the outbox
will eventually be needed with a TODO comment.

## Glossary

**These are the only words. Do not use synonyms in code or schema.**

UI copy can use natural-language alternatives ("Your Facility" instead
of "Your Tenant") but database columns, API routes, variable names,
and TypeScript types use the canonical word.

### Org-level

- **`tenant`** — a facility using the platform. Database table
  `tenants`, foreign key `tenant_id`. UI copy may say "Facility" or
  whatever the tenant calls themselves.
- **`tenant_admin`** — a staff member at a tenant who can configure
  the system and manage members. There can be multiple per tenant.

### People

- **`user`** — the auth identity. Email + password. A row in `users`.
  May be linked to a `member` record, a `tenant_admin` record, or
  both. The user table is the only place login credentials live.
  **Same tenant + same email = one user identity with multiple roles.**
- **`member`** — a person with an active subscription to one of a
  tenant's plans. Has a credit balance. Linked to a `user` for login,
  but `user_id` is nullable because manual/imported members may exist
  before they set up a login.
- **`customer`** — a walk-in. Captured at booking time via contact
  form (name, email, phone). May or may not have a user account; most
  won't. In v1, customers are stored inline on `bookings` rows
  (`customer_first_name`, `customer_email`, etc.) — no dedicated
  customers table.

### The catalog

- **`offering`** — the admin's template for a bookable thing. "30-min
  cage, 3 credits, $30." Has a credit cost, dollar price, duration,
  category, capacity, and resource association(s). Both rentals
  (capacity = 1) and classes (capacity > 1) live in this table.
- **`category`** — a normalized lowercase key on offerings used for
  plan restrictions. Free-text per tenant, validated by the
  `category_key` domain (lowercase, hyphenated, no whitespace).
  Display labels are a UI concern. Examples: `cage-time`, `hittrax`,
  `classes`. Renaming categories is not yet supported as a
  first-class operation; expect tenant pain if they rename a category
  that has plan restrictions referencing it.
- **`resource`** — the physical thing being rented. "Cage 1," "Rink
  2," "Sim Bay 3." Offerings are associated with one or more
  resources via `offering_resources`.

### Subscriptions and credits

- **`plan`** — a subscription tier. "Pro: $269/mo, 20 credits/week,
  all categories." Tenants define their own plans.
  `allowed_categories` is NULL for "all categories" or a non-empty
  array for a whitelist (e.g. `['classes']` for a Class Pack plan).
- **`subscription`** — a row per Stripe subscription, history
  preserved. A member upgrading basic → pro → unlimited → cancelled
  has 4 rows. Only one non-terminal subscription per member at a
  time (enforced by partial unique index). Statuses are internal,
  Stripe-mapped: `pending`, `active`, `past_due`, `cancelled`,
  `incomplete`. Translation happens at the webhook boundary —
  Stripe's "canceled" becomes our "cancelled."
- **`credit_balance`** — singleton current count for a member. PK is
  `(tenant_id, member_id)`.
- **`credit_ledger_entries`** — append-only ledger. Every balance
  mutation writes a row. Invariant: `credit_balances.current_credits`
  equals the most recent ledger row's `balance_after` for that
  member. Reasons: `weekly_reset`, `admin_adjustment`,
  `signup_bonus`, `booking_spend`, `booking_refund`, `plan_change`,
  `manual`.

### Bookings

- **`booking`** — a reservation. Has a state, a resource, a time
  window, a tenant, and either a member (who spent credits) or a
  customer (who paid cash or owes cash). State machine and full
  schema TBD next session.
- **`class_instance`** — a single occurrence of a class offering.
  TBD next session.
- **`class_booking`** — a person's spot in a class_instance. TBD.
- **`class_schedule`** — recurrence rule for a class offering. TBD.

### Policies and rules

- **`booking_policies`** — singleton row per tenant. Cancellation
  rules, no-show rules, advance booking window. No per-offering
  overrides in v1.
- **`operating_hours`** — when a resource is bookable. Per resource,
  per day-of-week. Multiple rows per (resource, day) allowed for
  split shifts. No tenant-default layer; the wizard duplicates hours
  across resources at setup.
- **`blackout`** — a time range when something is NOT bookable.
  Targets either a resource (resource_id set), an offering
  (offering_id set), or the whole facility (both null). Used as the
  storage for both "Cage 3 out of service" and "Pause this offering
  until X" admin actions.

### Payments

- **`stripe_connection`** — the tenant's connected Stripe account ID
  (Stripe Connect Standard). One per tenant. Schema TBD next session.
- **`payment_intent`** — Stripe's term, used as-is. Linked to a
  booking when a customer pays.
- **`platform_fee`** — the platform's `application_fee` on top of
  tenant payments. Optional, configurable, off by default.

## Data conventions

### Domains and shared functions

- **`category_key` domain** — text constrained to lowercase,
  hyphenated, alphanumeric. Used by `offerings.category` and
  `plans.allowed_categories`.
- **`set_updated_at()` trigger function** — applied to every mutable
  table. Sets `updated_at = now()` on UPDATE. Don't update
  `updated_at` manually in app code.

### Names and text fields

- All `name`, `first_name`, `last_name`, `email`, `category` fields
  have `CHECK (btrim(value) <> '')` to reject empty or
  whitespace-only inputs at the DB layer.
- All email fields have `CHECK (email = lower(email))` —
  normalize-on-write convention. We picked normalized text over
  citext to avoid surprises with regex case-insensitivity.
- Subdomain has additional CHECK for format and reserved-name
  exclusion. App-level validation layers more abuse prevention on top.

### Capacity and offerings

- Rental offerings: `capacity = 1`. UI hides or shows read-only.
- Class offerings: `capacity > 1`. UI surfaces "X spots left" to
  customers.
- One field, one meaning. No separate `kind` column.

### Member vs customer pricing display

Same offering row, two views. Logged-in member sees credit cost
("3 credits"). Public/walk-in sees dollar price ("$30").

### Booking state machine

`pending_payment → confirmed → completed | no_show | cancelled`

- `pending_payment` only used when payment is required and not yet
  received. Skipped for cash-on-arrival bookings (those go straight
  to `confirmed`).
- `confirmed` — booking is locked in. Slot is held.
- `completed` — booking time has passed and the booking happened.
- `no_show` — booking time passed, person didn't show. Triggers
  no-show policy.
- `cancelled` — explicitly cancelled before the booking time.

### Email addresses (sender)

- System emails use Resend with per-tenant reply-to address.
- "From" is platform-owned (`noreply@app.com`) until per-tenant
  custom domains are built (post-v1).

### Tenant resolution

Subdomain-based. Middleware extracts tenant from request hostname,
loads the tenant record, attaches to `req.tenant`. Every route handler
can assume `req.tenant` is populated.

API routes are tenant-scoped implicitly via the subdomain — no
`/api/tenants/:id/...` URL pattern. Super-admin routes live on a
reserved subdomain.

## Credit ledger enforcement

Credits are a real ledger. Every mutation writes a row in
`credit_ledger_entries` with the resulting `balance_after`. The
invariant `credit_balances.current_credits = latest ledger
balance_after` is enforced by:

1. A `apply_credit_change(...)` Postgres function (Phase 2 deliverable)
   that does the SELECT FOR UPDATE, the balance compute, the rejection
   on negative, the balance UPDATE, and the ledger INSERT in one
   transaction.
2. The function is `SECURITY DEFINER` with explicit `SET search_path`.
3. The function verifies `p_tenant_id =
   current_setting('app.current_tenant_id', true)::uuid` so even a
   privileged caller can't cross tenants.
4. The runtime DB role has SELECT on `credit_balances` and
   `credit_ledger_entries` but NOT INSERT/UPDATE/DELETE. The function
   (running as the DDL/migration role) has the writes.

This is the only place direct table writes are forbidden by
privilege. Other tables rely on RLS + app discipline. The ledger
matters more — incomplete audit history is forever.

## Critical gotchas

These will bite you if you don't know them. Update this list as new
ones emerge.

1. **DB migrations are manual.** They live in `db/migrations/` but are
   applied to live Supabase by hand via the SQL editor. They do NOT
   run automatically on deploy. Never assume a schema change is live
   just because the migration file is committed.

2. **RLS policies are easy to forget.** Every new tenant-scoped table
   needs an isolation policy. Application-layer filtering is the first
   line of defense; RLS is the defense-in-depth. Check the policy
   exists before merging a migration.

3. **Composite FK gotcha:** `ON DELETE SET NULL` on a multi-column FK
   tries to null all columns, which conflicts with `tenant_id NOT
   NULL`. Use `ON DELETE RESTRICT` and unlink in app code instead.

4. **Empty-array CHECKs and NULL passthrough:**
   `array_length('{}', 1)` returns `NULL`, not 0, and CHECK treats
   NULL as passing. Use `cardinality(arr) > 0` instead.

5. **Stripe webhook raw body.** `app.post('/webhooks/stripe', ...)`
   must come BEFORE `app.use(express.json())` in `server.js`, using
   `express.raw({ type: 'application/json' })`. Reversing the order
   breaks signature verification silently.

6. **Server timezone and tenant timezone are different.** Every
   tenant stores their own timezone (IANA format). All booking times
   use the tenant's timezone, not the server's. Operating hours use
   `time` (local, DST-stable); blackouts use `timestamptz` (absolute
   moments). DST is real.

7. **Frontend env vars live on Railway, not in committed files.** The
   Vite build runs on Railway, so any `VITE_*` env var the bundle
   needs has to be set in Railway's variables. `VITE_API_URL` should
   be empty/unset on Railway so the client uses same-origin relative
   URLs.

8. **`DATABASE_URL` uses Supabase's connection pooler, not the direct
   connection host.** The direct host (`db.{project_ref}.supabase.co`)
   requires Supabase's paid IPv4 add-on; the pooler
   (`aws-0-{region}.pooler.supabase.com`) is on free tier. Pooler user
   format is `app_runtime.{project_ref}` (the project_ref suffix tells
   Supavisor which project to route to). Use port `6543` (transaction
   mode) — works fine with our `set_config('app.current_tenant_id',
   $1, true)` pattern since the GUC is transaction-local.

9. **Don't hold transactions across external API calls.** DB
   transaction → commit → external call. Use the outbox pattern
   (TBD) for reliability-critical flows.

## Layout

```
src/                     Backend
  server.js              Express entry, mounts routes, serves client/dist
  routes/                Route definitions
  controllers/           Business logic
  middleware/            tenant resolution, auth, requireAdmin
  db/                    pg pool singleton, withTenantContext helper
  services/              External integrations (Stripe Connect, Resend)
client/
  src/                   React app
  dist/                  Built output — gitignored, built by Railway
db/
  schema.sql             Canonical destination state (this is the file
                         we're authoring during pre-Phase-0 sessions)
  migrations/            Applied manually to live Supabase
docs/                    Operator runbooks
PLAN.md                  Build plan (phases, scope, decisions)
CLAUDE.md                This file
```

## Git / PR conventions

- **Commit style:** `type: short description`
  (`feat:`, `fix:`, `docs:`, `refactor:`)
- **No force-push, no destructive git ops on main.**
- **Never merge to `main` without explicit confirmation.** Railway
  auto-deploys from `main` straight to production.
- **PR workflow:** feature branch → push → `gh pr create` → review →
  `gh pr merge --merge` (merge commit, NOT squash — preserves
  feature history).

## Common commands

```bash
npm run dev                  # backend dev mode (nodemon)
npm start                    # backend prod mode
cd client && npm run dev     # frontend dev mode (hot reload)
cd client && npm run build   # local test build
```

## Where to look

- `PLAN.md` — phase plan, scope decisions, v1.1 backlog
- `db/schema.sql` — canonical destination schema (in-progress draft)
- `db/migrations/` — applied schema history
- `docs/` — operator runbooks (added as needed)

## Safety

This will eventually be a live service handling real member bookings,
subscriptions, and card payments for multiple tenants. When uncertain,
ask before touching `main`, running destructive DB queries, or making
live API calls to Stripe.

---

*Last updated: end of pre-Phase-0 schema session 2 (foundation +
catalog + subscription/credit + operational layers locked).*
