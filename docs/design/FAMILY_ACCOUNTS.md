# Family accounts — design (draft for review)

*Status: APPROVED 2026-10-08 (open questions answered below). Customer-side slice 5.*

## The problem

Youth baseball facilities sell to **parents**. Today one login = one
`member` = one person: a parent with two kids either books everything
under their own name (the roster says "Dana Rivera" three times) or
makes fake accounts per kid with fake emails (members.email is unique
per tenant). Every competitor reviewed in July (Upper Hand, Bond, Rec,
CourtReserve, …) supports a parent booking for their kids.

## Decisions already made

| Question | Decision |
|---|---|
| Subscriptions | **One per household** (Mike, 2026-10-08). The parent's plan covers the family. |
| Credits | **Shared** — one balance, the parent's. Follows from one subscription. |
| Waivers | **Optional per facility** (already: `booking_policies.waiver_required`, off by default). When a facility turns them on, it's **per kid, signed by the parent**. Mike notes NY waivers carry little legal weight (GOL §5-326) — another reason they stay opt-in. |
| "Me" option | Always shown in "Who's this for?" |
| Birth year | Collected, optional (enables age-gated classes later) |
| Kids per household | Max 10 |
| Canonical word | `dependent` in code/schema; "family" / "kids" in UI copy |

## Proposed model: dependents under the account holder

The **account holder** stays exactly what a member is today: a login,
a subscription, a credit balance, a ledger. Kids become **dependents**
of that member — people who can be *booked for*, but who own nothing.

```
member (Dana, login, Pro plan, 20 credits/week)
 ├─ dependent: Leo, born 2014
 └─ dependent: Ava, born 2016
```

Every booking keeps `member_id` = **who pays** (credits come off Dana's
balance, exactly as now) and gains `dependent_id` = **who attends**
(NULL = the member themself).

### Why this shape (and not "a household of members")

- **Zero change to the money path.** Subscriptions, `credit_balances`,
  `apply_credit_change`, the ledger, the weekly reset and plan category
  restrictions all key on `member_id` and keep working untouched. The
  ledger is the part of this system we least want to touch.
- **No fake emails.** Dependents have no email and no login, so the
  `members.email` uniqueness and the users↔members composite FK are
  irrelevant to them.
- **Rejected: households of full members** (each kid a `member` row
  with its own balance, grouped by a `households` table). It needs
  per-kid emails, a shared-balance concept the ledger doesn't have, and
  rewrites the credit invariant. Wrong trade for "one subscription per
  household."

## Schema (one migration)

```sql
CREATE TABLE dependents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  member_id   uuid NOT NULL,                 -- the account holder
  first_name  text NOT NULL CHECK (btrim(first_name) <> '' AND first_name = btrim(first_name)),
  last_name   text NOT NULL CHECK (btrim(last_name)  <> '' AND last_name  = btrim(last_name)),
  birth_year  integer CHECK (birth_year BETWEEN 1900 AND 2100),  -- optional; age-gated classes later
  active      boolean NOT NULL DEFAULT true, -- "remove" = deactivate; history keeps the name
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, id, member_id),         -- target for the booking FKs below
  FOREIGN KEY (tenant_id, member_id) REFERENCES members(tenant_id, id) ON DELETE RESTRICT
);
-- + RLS tenant_isolation policy, set_updated_at trigger

ALTER TABLE bookings       ADD COLUMN dependent_id uuid;
ALTER TABLE class_bookings ADD COLUMN dependent_id uuid;
-- A dependent can only be booked by THEIR account holder — enforced by
-- the schema, not just app code (CLAUDE.md composite-FK convention):
ALTER TABLE bookings ADD FOREIGN KEY (tenant_id, dependent_id, member_id)
  REFERENCES dependents(tenant_id, id, member_id) ON DELETE RESTRICT;
ALTER TABLE class_bookings ADD FOREIGN KEY (tenant_id, dependent_id, member_id)
  REFERENCES dependents(tenant_id, id, member_id) ON DELETE RESTRICT;
-- (composite FK with a NULL column doesn't enforce → member's own
--  bookings and walk-ins are unaffected)

-- Siblings in the same class: today's index allows ONE spot per member
-- per class instance. Replace it with one spot per PARTICIPANT:
DROP INDEX class_bookings_member_per_instance_unique;
CREATE UNIQUE INDEX class_bookings_participant_per_instance_unique
  ON class_bookings (tenant_id, class_instance_id, member_id,
                     COALESCE(dependent_id, '00000000-0000-0000-0000-000000000000'))
  WHERE member_id IS NOT NULL AND status <> 'cancelled';

ALTER TABLE waiver_signatures ADD COLUMN dependent_id uuid;  -- + same composite FK
```

Rentals need no new constraint: nothing stops a member holding two
cages at the same time today, so "Leo in Cage 1, Ava in Cage 2 at 4pm"
already works.

## Waivers

- Only when the facility requires waivers (`waiver_required`; off by
  default — nothing below applies otherwise).
- Booking for a dependent requires a current-version signature **for
  that dependent** (`waiver_signatures.dependent_id`), signed by the
  account holder: `signer_name` = parent, `is_minor = true`,
  `guardian_name` = parent. Same version-echo and re-prompt-on-edit
  rules as today.
- The member's own bookings keep requiring the member's own signature.
- Walk-ins are unchanged (the inline "signing on behalf of a minor"
  box already exists).

## What people see

**Parent (member)**
- **Account → Family**: add a kid (first, last, birth year optional),
  edit, remove (deactivate). Cap of 10 per household.
- **Booking (rentals and classes)**: a "Who's this for?" picker —
  *Me / Leo / Ava* — shown **only** when the household has dependents,
  so single members see no change. Waiver modal names the kid when
  needed.
- **Home**: each booking shows who it's for ("60-Minute Cage · Leo").
- Emails go to the parent and say who the booking is for.

**Staff (admin)**
- Member detail: a **Family** card (kids, active bookings per kid).
- Calendar, bookings list and class rosters show the **participant**:
  "Leo Rivera (Dana's family)". Rosters are what coaches read — this is
  the main payoff.
- Front-desk booking (calendar create): pick the member, then who it's
  for.
- Reports: member counts stay households; CSV exports gain a
  "participant" column.

**Platform console**: nothing.

## Edge cases

| Case | Behaviour |
|---|---|
| Parent cancels subscription | Same as today for the member; dependents can't book (they never could on their own). |
| Remove a kid with future bookings | Blocked with "cancel Leo's upcoming bookings first" (FK is RESTRICT; we deactivate, never delete). |
| Two kids, same class, one spot left | First booking wins; second gets the normal "class full". |
| Plan category restrictions | Apply to the household's plan, whoever attends. |
| Weekly reset / credit packs | Unchanged — one balance. |
| Teen wants their own login | Not v1. Later: promote a dependent to a member (own email, own login) — the bookings already name them. |

## Delivery (3 PRs)

1. **Schema + family management** — migration, `/api/me/dependents`
   CRUD, Account → Family, admin Family card. No booking changes yet;
   safe to ship alone.
2. **Booking for a kid** — "Who's this for?" in member rental + class
   booking, participant shown on Home/calendar/bookings/rosters/emails,
   front-desk picker, class uniqueness index swap.
3. **Per-kid waivers** — `dependent_id` on signatures, enforcement, the
   waiver modal naming the kid, CSV participant column.

Rough size: comparable to the walk-in class slice per PR; the migration
is the only by-hand step (applied before PR 1 deploys).

## Open questions

All five answered 2026-10-08 — see "Decisions already made".
