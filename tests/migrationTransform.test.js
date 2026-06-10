// Pure-function tests for scripts/migration/02_transform.js.
// No DB, no I/O — these run unconditionally in CI (no DATABASE_URL_
// PRIVILEGED gate).
//
// Rejection cases matter as much as happy paths here: every shape the
// destination CHECK constraints would refuse must be refused by the
// transformer FIRST, with a reviewable error — not discovered as a
// 23514 at 6:30am during cutover.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  transformMemberAndUser,
  transformSubscription,
  transformCreditBalance,
  transformBooking,
} from '../scripts/migration/02_transform.js';
import { migrationId } from '../scripts/migration/shared/ids.js';

const TENANT = '00000000-0000-0000-0000-000000000001';
const SOURCE_MEMBER = 'src-m-1';
const SOURCE_PLAN = 'src-p-1';
const SOURCE_OFFERING = 'src-o-1';
const SOURCE_RESOURCE = 'src-r-1';
const NOW = Date.parse('2026-01-01T00:00:00Z');

const UUID_V5_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// ============================================================
// migrationId
// ============================================================

test('migrationId is deterministic and well-formed', () => {
  const a = migrationId(TENANT, 'bookings', 'b-42');
  const b = migrationId(TENANT, 'bookings', 'b-42');
  assert.equal(a, b);
  assert.match(a, UUID_V5_RE);
});

test('migrationId differs by tenant, table, and source id', () => {
  const base = migrationId(TENANT, 'bookings', 'b-42');
  assert.notEqual(base, migrationId(TENANT, 'bookings', 'b-43'));
  assert.notEqual(base, migrationId(TENANT, 'subscriptions', 'b-42'));
  assert.notEqual(base, migrationId('00000000-0000-0000-0000-000000000002', 'bookings', 'b-42'));
});

test('migrationId rejects missing source id', () => {
  assert.throws(() => migrationId(TENANT, 'bookings', null), /source id required/);
  assert.throws(() => migrationId(TENANT, 'bookings', '  '), /source id required/);
});

// ============================================================
// transformMemberAndUser
// ============================================================

test('transformMemberAndUser normalizes email, drops password, stamps deterministic id', () => {
  const out = transformMemberAndUser(
    {
      id: SOURCE_MEMBER,
      email: '  Mixed.Case@Example.COM  ',
      first_name: 'Sam',
      last_name: 'Doe',
      phone: '+1-555-0100',
      created_at: '2024-01-01T00:00:00Z',
    },
    TENANT,
  );
  assert.equal(out.user.email, 'mixed.case@example.com');
  assert.equal(out.user.first_name, 'Sam');
  assert.equal(out.user.last_name, 'Doe');
  assert.ok(!('password_hash' in out.user), 'password should NOT migrate');
  assert.equal(out.member.email, 'mixed.case@example.com');
  assert.equal(out.member.phone, '+1-555-0100');
  assert.equal(out.member.source_id, SOURCE_MEMBER);
  assert.equal(out.member.id, migrationId(TENANT, 'members', SOURCE_MEMBER));
});

test('transformMemberAndUser rejects whitespace email', () => {
  assert.throws(
    () => transformMemberAndUser({ id: 'x', email: 'a b@x.com', first_name: 'A', last_name: 'B' }, TENANT),
    /bad email/,
  );
});

test('transformMemberAndUser rejects empty first/last', () => {
  assert.throws(
    () => transformMemberAndUser({ id: 'x', email: 'a@x.com', first_name: '', last_name: 'B' }, TENANT),
    /first\/last name/,
  );
});

test('transformMemberAndUser rejects missing source id', () => {
  assert.throws(
    () => transformMemberAndUser({ email: 'a@x.com', first_name: 'A', last_name: 'B' }, TENANT),
    /missing id/,
  );
});

// ============================================================
// transformSubscription
// ============================================================

const baseSub = {
  id: 'sub-src-1',
  member_id: SOURCE_MEMBER,
  plan_id: SOURCE_PLAN,
  stripe_subscription_id: 'sub_123',
  stripe_customer_id: 'cus_123',
  status: 'active',
  current_period_start: '2026-04-01T00:00:00Z',
  current_period_end: '2026-05-01T00:00:00Z',
  cancel_at_period_end: false,
  activated_at: '2024-09-15T00:00:00Z',
  created_at: '2024-09-15T00:00:00Z',
};

test('transformSubscription: active sub keeps an open plan period and carries source refs', () => {
  const out = transformSubscription(baseSub, TENANT);
  assert.equal(out.subscription.status, 'active');
  assert.equal(out.subscription.source_member_id, SOURCE_MEMBER);
  assert.equal(out.subscription.stripe_subscription_id, 'sub_123');
  assert.equal(out.subscription.ended_at, null);
  assert.equal(out.subscription.id, migrationId(TENANT, 'subscriptions', 'sub-src-1'));
  assert.equal(out.plan_period.source_plan_id, SOURCE_PLAN);
  assert.equal(out.plan_period.ended_at, null);
  assert.equal(out.plan_period.started_at, '2024-09-15T00:00:00Z');
});

test('transformSubscription: cancelled sub closes the plan period and sets ended_at', () => {
  const out = transformSubscription(
    { ...baseSub, status: 'canceled', cancelled_at: '2025-11-01T00:00:00Z' }, // Momentum spelling
    TENANT,
  );
  assert.equal(out.subscription.status, 'cancelled'); // our spelling
  assert.equal(out.subscription.ended_at, '2025-11-01T00:00:00Z');
  assert.equal(out.plan_period.ended_at, '2025-11-01T00:00:00Z');
});

test('transformSubscription: cancelled sub falls back to current_period_end for the close', () => {
  const out = transformSubscription({ ...baseSub, status: 'cancelled' }, TENANT);
  assert.equal(out.subscription.ended_at, '2026-05-01T00:00:00Z');
  assert.equal(out.plan_period.ended_at, '2026-05-01T00:00:00Z');
});

test('transformSubscription: cancelled sub with no usable close timestamp throws', () => {
  assert.throws(
    () =>
      transformSubscription(
        {
          ...baseSub,
          status: 'cancelled',
          current_period_start: null,
          current_period_end: null,
        },
        TENANT,
      ),
    /no cancelled_at\/ended_at\/current_period_end/,
  );
});

test('transformSubscription: cancellation at/before period start throws (CHECK ended_at > started_at)', () => {
  assert.throws(
    () =>
      transformSubscription(
        { ...baseSub, status: 'cancelled', cancelled_at: '2024-09-15T00:00:00Z' },
        TENANT,
      ),
    /cancellation timestamp <= start/,
  );
});

test('transformSubscription: inverted current period bounds throw', () => {
  assert.throws(
    () =>
      transformSubscription(
        {
          ...baseSub,
          current_period_start: '2026-05-01T00:00:00Z',
          current_period_end: '2026-04-01T00:00:00Z',
        },
        TENANT,
      ),
    /current_period_end <= current_period_start/,
  );
});

test('transformSubscription throws on unknown Momentum status (including trialing)', () => {
  assert.throws(
    () => transformSubscription({ ...baseSub, status: 'frozen' }, TENANT),
    /unknown Momentum sub status/,
  );
  // 'trialing' is deliberately unmapped until SOURCE_SCHEMA.md decides
  // whether trials import as active or stay out of scope.
  assert.throws(
    () => transformSubscription({ ...baseSub, status: 'trialing' }, TENANT),
    /unknown Momentum sub status/,
  );
});

test('transformSubscription throws on missing member/plan refs', () => {
  assert.throws(
    () => transformSubscription({ ...baseSub, member_id: null }, TENANT),
    /missing member_id/,
  );
  assert.throws(
    () => transformSubscription({ ...baseSub, plan_id: null }, TENANT),
    /missing plan_id/,
  );
});

// ============================================================
// transformCreditBalance
// ============================================================

test('transformCreditBalance builds matching ledger row with reason=migration', () => {
  const out = transformCreditBalance({ member_id: SOURCE_MEMBER, credits: 17 }, TENANT);
  assert.equal(out.balance.current_credits, 17);
  assert.equal(out.balance.source_member_id, SOURCE_MEMBER);
  assert.equal(out.ledger.amount, 17);
  assert.equal(out.ledger.balance_after, 17);
  assert.equal(out.ledger.reason, 'migration');
});

test('transformCreditBalance passes zero through (load.js owns the single skip-zero guard)', () => {
  const out = transformCreditBalance({ member_id: SOURCE_MEMBER, credits: 0 }, TENANT);
  assert.equal(out.balance.current_credits, 0);
  assert.equal(out.ledger.amount, 0);
  assert.equal(out.ledger.balance_after, 0);
});

test('transformCreditBalance rejects negative, fractional, and non-numeric balances', () => {
  assert.throws(
    () => transformCreditBalance({ member_id: SOURCE_MEMBER, credits: -5 }, TENANT),
    /bad credit balance/,
  );
  // credits are an integer column — silently rounding 2.5 is a wrong
  // member balance, not a convenience.
  assert.throws(
    () => transformCreditBalance({ member_id: SOURCE_MEMBER, credits: 2.5 }, TENANT),
    /bad credit balance/,
  );
  assert.throws(
    () => transformCreditBalance({ member_id: SOURCE_MEMBER, credits: 'lots' }, TENANT),
    /bad credit balance/,
  );
});

// ============================================================
// transformBooking — identity, status, dates
// ============================================================

const memberBooking = {
  id: 'b1',
  offering_id: SOURCE_OFFERING,
  resource_id: SOURCE_RESOURCE,
  member_id: SOURCE_MEMBER,
  start_time: '2025-01-01T15:00:00Z',
  end_time: '2025-01-01T16:00:00Z',
  credits_charged: 3,
  created_at: '2024-12-30T00:00:00Z',
};

const walkinBooking = {
  id: 'b2',
  offering_id: SOURCE_OFFERING,
  resource_id: SOURCE_RESOURCE,
  member_id: null,
  customer_first_name: 'Walk',
  customer_last_name: 'In',
  customer_email: 'walkin@example.com',
  start_time: '2025-06-01T15:00:00Z',
  end_time: '2025-06-01T16:00:00Z',
  amount_cents: 4500,
  amount_paid_cents: 4500,
};

test('transformBooking past date → completed; future → confirmed', () => {
  const past = transformBooking(memberBooking, TENANT, NOW);
  assert.equal(past.status, 'completed');
  assert.equal(past.source_member_id, SOURCE_MEMBER);
  assert.equal(past.source_offering_id, SOURCE_OFFERING);
  assert.equal(past.source_resource_id, SOURCE_RESOURCE);
  assert.equal(past.credit_cost_charged, 3);
  assert.equal(past.payment_status, 'not_required');
  assert.equal(past.amount_due_cents, 0);
  assert.equal(past.id, migrationId(TENANT, 'bookings', 'b1'));

  const future = transformBooking(
    { ...memberBooking, id: 'b1f', start_time: '2027-06-01T15:00:00Z', end_time: '2027-06-01T16:00:00Z' },
    TENANT,
    NOW,
  );
  assert.equal(future.status, 'confirmed');
});

test('transformBooking cancelled_at / no_show_marked_at win over date-derived status', () => {
  const cancelled = transformBooking(
    { ...memberBooking, cancelled_at: '2026-04-15T00:00:00Z' },
    TENANT,
    NOW,
  );
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.cancelled_at, '2026-04-15T00:00:00Z');

  const noShow = transformBooking(
    { ...memberBooking, no_show_marked_at: '2025-01-01T16:05:00Z' },
    TENANT,
    NOW,
  );
  assert.equal(noShow.status, 'no_show');
});

test('transformBooking rejects missing/garbage dates instead of silently confirming', () => {
  // NaN < now is false — without the guard a dateless booking would
  // silently become a FUTURE confirmed booking.
  assert.throws(
    () => transformBooking({ ...memberBooking, start_time: null }, TENANT, NOW),
    /start_time: missing/,
  );
  assert.throws(
    () => transformBooking({ ...memberBooking, start_time: 'TBD' }, TENANT, NOW),
    /unparseable timestamp/,
  );
  assert.throws(
    () =>
      transformBooking(
        { ...memberBooking, end_time: '2025-01-01T15:00:00Z' }, // equal to start
        TENANT,
        NOW,
      ),
    /end_time <= start_time/,
  );
});

test('transformBooking rejects missing source/booking refs', () => {
  assert.throws(
    () => transformBooking({ ...memberBooking, id: undefined }, TENANT, NOW),
    /missing id/,
  );
  assert.throws(
    () => transformBooking({ ...memberBooking, offering_id: null }, TENANT, NOW),
    /missing offering_id\/resource_id/,
  );
});

// ============================================================
// transformBooking — payment state machine (the 007 CASE CHECK)
// ============================================================

test('walk-in fully paid → paid (overpayment by a cent also legal)', () => {
  const out = transformBooking(walkinBooking, TENANT, NOW);
  assert.equal(out.member_id, undefined); // not part of output row; loader resolves
  assert.equal(out.source_member_id, null);
  assert.equal(out.customer_first_name, 'Walk');
  assert.equal(out.amount_due_cents, 4500);
  assert.equal(out.credit_cost_charged, 0);
  assert.equal(out.payment_status, 'paid');

  const over = transformBooking({ ...walkinBooking, amount_paid_cents: 4501 }, TENANT, NOW);
  assert.equal(over.payment_status, 'paid');
});

test('walk-in fully refunded → refunded', () => {
  const out = transformBooking(
    { ...walkinBooking, amount_paid_cents: 4500, amount_refunded_cents: 4500 },
    TENANT,
    NOW,
  );
  assert.equal(out.payment_status, 'refunded');
  assert.equal(out.amount_refunded_cents, 4500);
});

test('walk-in partially refunded → partial_refund', () => {
  const out = transformBooking(
    { ...walkinBooking, amount_paid_cents: 4500, amount_refunded_cents: 1500 },
    TENANT,
    NOW,
  );
  assert.equal(out.payment_status, 'partial_refund');
});

test('walk-in owing unpaid cash → pending (not not_required)', () => {
  const out = transformBooking(
    { ...walkinBooking, amount_paid_cents: 0 },
    TENANT,
    NOW,
  );
  assert.equal(out.amount_due_cents, 4500);
  assert.equal(out.payment_status, 'pending');
});

test('walk-in free booking (no money anywhere) → not_required', () => {
  const out = transformBooking(
    { ...walkinBooking, amount_cents: 0, amount_paid_cents: 0 },
    TENANT,
    NOW,
  );
  assert.equal(out.amount_due_cents, 0);
  assert.equal(out.payment_status, 'not_required');
});

test('walk-in deposit (0 < paid < due) has no legal state → throws for review', () => {
  assert.throws(
    () => transformBooking({ ...walkinBooking, amount_paid_cents: 1000 }, TENANT, NOW),
    /partial payment/,
  );
});

test('refund exceeding payment throws', () => {
  assert.throws(
    () =>
      transformBooking(
        { ...walkinBooking, amount_paid_cents: 1000, amount_refunded_cents: 2000 },
        TENANT,
        NOW,
      ),
    /exceeds paid/,
  );
});

test('payment on a zero-due booking throws', () => {
  assert.throws(
    () =>
      transformBooking(
        { ...walkinBooking, amount_cents: 0, amount_paid_cents: 500 },
        TENANT,
        NOW,
      ),
    /zero-due/,
  );
});

test('member booking carrying money amounts throws (members pay credits, not cash)', () => {
  assert.throws(
    () => transformBooking({ ...memberBooking, amount_paid_cents: 3000 }, TENANT, NOW),
    /member booking carries money/,
  );
});

test('fractional/negative money values throw', () => {
  assert.throws(
    () => transformBooking({ ...walkinBooking, amount_cents: 45.5 }, TENANT, NOW),
    /non-negative integer/,
  );
  assert.throws(
    () => transformBooking({ ...walkinBooking, amount_paid_cents: -100 }, TENANT, NOW),
    /non-negative integer/,
  );
});

// ============================================================
// transformBooking — customer contact hygiene (007 btrim CHECKs)
// ============================================================

test('walk-in contact fields are trimmed and email lowercased', () => {
  const out = transformBooking(
    {
      ...walkinBooking,
      customer_first_name: '  Walk ',
      customer_last_name: ' In ',
      customer_email: '  WALKIN@Example.COM ',
      customer_phone: '  ',
    },
    TENANT,
    NOW,
  );
  assert.equal(out.customer_first_name, 'Walk');
  assert.equal(out.customer_last_name, 'In');
  assert.equal(out.customer_email, 'walkin@example.com');
  assert.equal(out.customer_phone, null);
});

test('walk-in missing name or email throws for review (no fabricated contacts)', () => {
  assert.throws(
    () => transformBooking({ ...walkinBooking, customer_email: null }, TENANT, NOW),
    /walk-in missing customer name\/email/,
  );
  assert.throws(
    () => transformBooking({ ...walkinBooking, customer_email: '   ' }, TENANT, NOW),
    /walk-in missing customer name\/email/,
  );
  assert.throws(
    () => transformBooking({ ...walkinBooking, customer_first_name: '' }, TENANT, NOW),
    /walk-in missing customer name\/email/,
  );
});

test('walk-in email with interior whitespace throws', () => {
  assert.throws(
    () => transformBooking({ ...walkinBooking, customer_email: 'a b@x.com' }, TENANT, NOW),
    /bad customer email/,
  );
});
