// Pure-function tests for scripts/migration/02_transform.js.
// No DB, no I/O — these run unconditionally in CI (no DATABASE_URL_
// PRIVILEGED gate).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  transformMemberAndUser,
  transformSubscription,
  transformCreditBalance,
  transformBooking,
} from '../scripts/migration/02_transform.js';

const TENANT = '00000000-0000-0000-0000-000000000001';
const COURTSIDE_MEMBER = '11111111-1111-1111-1111-111111111111';
const COURTSIDE_PLAN = '22222222-2222-2222-2222-222222222222';
const COURTSIDE_OFFERING = '33333333-3333-3333-3333-333333333333';
const COURTSIDE_RESOURCE = '44444444-4444-4444-4444-444444444444';
const SOURCE_MEMBER = 'src-m-1';
const SOURCE_PLAN = 'src-p-1';
const SOURCE_OFFERING = 'src-o-1';
const SOURCE_RESOURCE = 'src-r-1';

const idMaps = {
  member: new Map([[SOURCE_MEMBER, COURTSIDE_MEMBER]]),
  plan: new Map([[SOURCE_PLAN, COURTSIDE_PLAN]]),
  offering: new Map([[SOURCE_OFFERING, COURTSIDE_OFFERING]]),
  resource: new Map([[SOURCE_RESOURCE, COURTSIDE_RESOURCE]]),
};

// ============================================================
// transformMemberAndUser
// ============================================================

test('transformMemberAndUser normalizes email + drops password', () => {
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

// ============================================================
// transformSubscription
// ============================================================

test('transformSubscription maps Momentum status enum to internal', () => {
  const out = transformSubscription(
    {
      id: 'sub-src-1',
      member_id: SOURCE_MEMBER,
      plan_id: SOURCE_PLAN,
      stripe_subscription_id: 'sub_123',
      stripe_customer_id: 'cus_123',
      status: 'canceled', // Momentum spelling
      current_period_start: '2026-04-01T00:00:00Z',
      current_period_end: '2026-05-01T00:00:00Z',
      cancel_at_period_end: false,
      activated_at: '2024-09-15T00:00:00Z',
      created_at: '2024-09-15T00:00:00Z',
    },
    TENANT,
    idMaps,
  );
  assert.equal(out.subscription.status, 'cancelled'); // our spelling
  assert.equal(out.subscription.member_id, COURTSIDE_MEMBER);
  assert.equal(out.subscription.stripe_subscription_id, 'sub_123');
  assert.equal(out.plan_period.plan_id, COURTSIDE_PLAN);
  assert.equal(out.plan_period.ended_at, null);
});

test('transformSubscription throws on unmapped source member', () => {
  assert.throws(
    () =>
      transformSubscription(
        { id: 's', member_id: 'unknown', plan_id: SOURCE_PLAN },
        TENANT,
        idMaps,
      ),
    /no Courtside member/,
  );
});

test('transformSubscription throws on unknown Momentum status', () => {
  assert.throws(
    () =>
      transformSubscription(
        {
          id: 's',
          member_id: SOURCE_MEMBER,
          plan_id: SOURCE_PLAN,
          status: 'frozen',
        },
        TENANT,
        idMaps,
      ),
    /unknown Momentum sub status/,
  );
});

// ============================================================
// transformCreditBalance
// ============================================================

test('transformCreditBalance builds matching ledger row with reason=migration', () => {
  const out = transformCreditBalance(
    { member_id: SOURCE_MEMBER, credits: 17 },
    TENANT,
    idMaps,
  );
  assert.equal(out.balance.current_credits, 17);
  assert.equal(out.balance.member_id, COURTSIDE_MEMBER);
  assert.equal(out.ledger.amount, 17);
  assert.equal(out.ledger.balance_after, 17);
  assert.equal(out.ledger.reason, 'migration');
});

test('transformCreditBalance handles zero balance (skip-amount sentinel)', () => {
  const out = transformCreditBalance(
    { member_id: SOURCE_MEMBER, credits: 0 },
    TENANT,
    idMaps,
  );
  assert.equal(out.balance.current_credits, 0);
  // amount is null → load.js skips the ledger insert (apply_credit_change
  // would also reject amount=0)
  assert.equal(out.ledger.amount, null);
  assert.equal(out.ledger.balance_after, 0);
});

test('transformCreditBalance rejects negative balance', () => {
  assert.throws(
    () =>
      transformCreditBalance(
        { member_id: SOURCE_MEMBER, credits: -5 },
        TENANT,
        idMaps,
      ),
    /bad credit balance/,
  );
});

// ============================================================
// transformBooking
// ============================================================

test('transformBooking past date → completed; future → confirmed', () => {
  const past = transformBooking(
    {
      id: 'b1',
      offering_id: SOURCE_OFFERING,
      resource_id: SOURCE_RESOURCE,
      member_id: SOURCE_MEMBER,
      start_time: '2025-01-01T15:00:00Z',
      end_time: '2025-01-01T16:00:00Z',
      credits_charged: 3,
      created_at: '2024-12-30T00:00:00Z',
    },
    TENANT,
    idMaps,
    Date.parse('2026-01-01T00:00:00Z'),
  );
  assert.equal(past.status, 'completed');
  assert.equal(past.member_id, COURTSIDE_MEMBER);
  assert.equal(past.credit_cost_charged, 3);
  assert.equal(past.payment_status, 'not_required');

  const future = transformBooking(
    {
      id: 'b2',
      offering_id: SOURCE_OFFERING,
      resource_id: SOURCE_RESOURCE,
      member_id: SOURCE_MEMBER,
      start_time: '2027-06-01T15:00:00Z',
      end_time: '2027-06-01T16:00:00Z',
      credits_charged: 3,
    },
    TENANT,
    idMaps,
    Date.parse('2026-01-01T00:00:00Z'),
  );
  assert.equal(future.status, 'confirmed');
});

test('transformBooking cancelled_at flag → status=cancelled regardless of date', () => {
  const out = transformBooking(
    {
      offering_id: SOURCE_OFFERING,
      resource_id: SOURCE_RESOURCE,
      member_id: SOURCE_MEMBER,
      start_time: '2027-06-01T15:00:00Z',
      end_time: '2027-06-01T16:00:00Z',
      cancelled_at: '2026-04-15T00:00:00Z',
    },
    TENANT,
    idMaps,
  );
  assert.equal(out.status, 'cancelled');
  assert.equal(out.cancelled_at, '2026-04-15T00:00:00Z');
});

test('transformBooking customer booking sets dollar amounts not credits', () => {
  const out = transformBooking(
    {
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
    },
    TENANT,
    idMaps,
    Date.parse('2026-01-01T00:00:00Z'),
  );
  assert.equal(out.member_id, null);
  assert.equal(out.customer_first_name, 'Walk');
  assert.equal(out.amount_due_cents, 4500);
  assert.equal(out.credit_cost_charged, 0);
  assert.equal(out.payment_status, 'paid');
});
