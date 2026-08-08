// Pure-function tests for scripts/migration/02_transform.js plus the
// shared CSV/manifest helpers it depends on. No DB — these run
// unconditionally in CI (no DATABASE_URL_PRIVILEGED gate). The only
// I/O is a throwaway temp dir for the manifest checksum tests.
//
// The mapping fixture below is deliberately tiny and concrete — tests
// must not read momentum.map.json, whose whole job is to be filled in
// by the operator right before cutover.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  transformMemberAndUser,
  deriveSubscription,
  derivePlanRows,
  computePurchasedCredits,
  transformCreditBalance,
  mergeBookings,
  deriveCreditGrantExceptions,
  validateSetmoreHeader,
} from '../scripts/migration/02_transform.js';
import { parseCsv } from '../scripts/migration/shared/csv.js';
import { parseSourceTimestamp } from '../scripts/migration/shared/tz.js';
import {
  writeJsonWithHash,
  readVerified,
  requireFiles,
} from '../scripts/migration/shared/manifest.js';

// Snapshot moment every past/future judgment is measured against.
const REF = Date.parse('2026-07-01T00:00:00Z');

const MAPPING = {
  timezone: 'America/New_York',
  plans: {
    basic: { name: 'Starter', monthly_price_cents: 9900, stripe_price_id: 'price_basic' },
    pro: { name: 'Pro', monthly_price_cents: 26900, stripe_price_id: 'price_pro' },
  },
  services: {
    'Cage 30': 'Cage Rental (30 min)',
    'Cage 60': 'Cage Rental (60 min)',
  },
  staff_keys: { cage1: 'Cage 1', cage2: 'Cage 2' },
  setmore_columns: {
    appointment_id: 'Appointment ID',
    service_name: 'Service',
    staff_key: 'Staff',
    customer_name: 'Customer Name',
    customer_email: 'Customer Email',
    customer_phone: 'Customer Phone',
    start_time: 'Start',
    end_time: 'End',
    status: 'Status',
  },
  setmore_status_map: {
    Confirmed: 'confirmed',
    Cancelled: 'cancelled',
    'No Show': 'no_show',
  },
};

function member(over = {}) {
  return {
    id: 'm-1',
    email: 'member@example.com',
    name: null,
    first_name: 'Sam',
    last_name: 'Doe',
    plan: 'basic',
    credits_per_week: 4,
    is_admin: false,
    stripe_customer_id: 'cus_1',
    stripe_subscription_id: 'sub_1',
    subscription_status: 'active',
    deactivated_at: null,
    subscription_period_end: null,
    scheduled_deactivation_at: null,
    created_at: '2024-01-01T00:00:00Z',
    ...over,
  };
}

const SERVICES = new Map([
  ['svc-30', { id: 'svc-30', name: 'Cage 30', credits_cost: 3 }],
  ['svc-60', { id: 'svc-60', name: 'Cage 60', credits_cost: 6 }],
]);

function setmoreRec(over = {}) {
  return {
    'Appointment ID': 'appt-1',
    Service: 'Cage 30',
    Staff: 'cage1',
    'Customer Name': 'Walk In',
    'Customer Email': 'walkin@example.com',
    'Customer Phone': '555-0100',
    Start: '2026-06-01T15:00:00Z',
    End: '2026-06-01T15:30:00Z',
    Status: 'Confirmed',
    ...over,
  };
}

function diamondBooking(over = {}) {
  return {
    id: 'db-1',
    member_id: 'm-1',
    service_id: 'svc-30',
    setmore_appointment_id: null,
    booked_at: '2026-05-20T12:00:00Z',
    status: 'confirmed',
    start_time: '2026-06-02T15:00:00Z',
    end_time: '2026-06-02T15:30:00Z',
    staff_key: 'cage1',
    ...over,
  };
}

function merge(over = {}) {
  return mergeBookings({
    diamondBookings: [],
    servicesById: SERVICES,
    memberById: new Map([['m-1', member()]]),
    setmoreRecords: [],
    mapping: MAPPING,
    referenceTimeMs: REF,
    ...over,
  });
}

// ============================================================
// transformMemberAndUser
// ============================================================

describe('transformMemberAndUser', () => {
  test('normalizes email, drops password, phone is null', () => {
    const out = transformMemberAndUser(
      member({ email: '  Mixed.Case@Example.COM  ', password_hash: '$2a$hash' }),
    );
    assert.equal(out.source_member_id, 'm-1');
    assert.equal(out.is_admin, false);
    assert.equal(out.user.email, 'mixed.case@example.com');
    assert.equal(out.user.first_name, 'Sam');
    assert.equal(out.user.last_name, 'Doe');
    assert.ok(!('password_hash' in out.user), 'password must NOT migrate');
    assert.equal(out.member.email, 'mixed.case@example.com');
    assert.equal(out.member.phone, null, 'Diamond has no phone column');
    assert.equal(out.member.created_at, '2024-01-01T00:00:00Z');
  });

  test('falls back to splitting legacy name on the first space', () => {
    const out = transformMemberAndUser(
      member({ first_name: '', last_name: '', name: 'Sam Q Doe' }),
    );
    assert.equal(out.user.first_name, 'Sam');
    assert.equal(out.user.last_name, 'Q Doe');
  });

  test('single-token legacy name duplicates into first AND last', () => {
    const out = transformMemberAndUser(member({ first_name: '', last_name: '', name: 'Cher' }));
    assert.equal(out.user.first_name, 'Cher');
    assert.equal(out.user.last_name, 'Cher');
  });

  test('lone first_name duplicates when the legacy name is empty too', () => {
    const out = transformMemberAndUser(member({ first_name: 'Sam', last_name: '', name: '' }));
    assert.equal(out.user.first_name, 'Sam');
    assert.equal(out.user.last_name, 'Sam');
  });

  test('member with no usable name throws', () => {
    assert.throws(
      () => transformMemberAndUser(member({ first_name: '', last_name: '', name: '  ' })),
      /no usable name/,
    );
  });

  test('email with embedded whitespace throws', () => {
    assert.throws(() => transformMemberAndUser(member({ email: 'a b@x.com' })), /bad email/);
  });

  test('empty email throws', () => {
    assert.throws(() => transformMemberAndUser(member({ email: '   ' })), /bad email/);
  });
});

// ============================================================
// deriveSubscription — all five source-status paths
// ============================================================

describe('deriveSubscription', () => {
  test('active → active, no ended_at, activated_at = member created_at', () => {
    const row = deriveSubscription(member({ subscription_period_end: '2026-08-01T00:00:00Z' }));
    assert.equal(row.status, 'active');
    assert.equal(row.member_email, 'member@example.com');
    assert.equal(row.stripe_subscription_id, 'sub_1');
    assert.equal(row.stripe_customer_id, 'cus_1');
    assert.equal(row.current_period_start, null, 'Diamond only stores the period END');
    assert.equal(row.current_period_end, '2026-08-01T00:00:00Z');
    assert.equal(row.cancel_at_period_end, false);
    assert.equal(row.activated_at, '2024-01-01T00:00:00Z');
    assert.equal(row.ended_at, null);
  });

  test('active + scheduled_deactivation_at → cancel_at_period_end', () => {
    const row = deriveSubscription(
      member({ scheduled_deactivation_at: '2026-08-01T00:00:00Z' }),
    );
    assert.equal(row.status, 'active');
    assert.equal(row.cancel_at_period_end, true);
    assert.equal(row.scheduled_deactivation_at, '2026-08-01T00:00:00Z');
  });

  test('cancelled → ended_at prefers deactivated_at', () => {
    const row = deriveSubscription(
      member({
        subscription_status: 'cancelled',
        deactivated_at: '2026-05-01T00:00:00Z',
        subscription_period_end: '2026-06-01T00:00:00Z',
      }),
    );
    assert.equal(row.status, 'cancelled');
    assert.equal(row.ended_at, '2026-05-01T00:00:00Z');
  });

  test('cancelled without deactivated_at falls back to the period end', () => {
    const row = deriveSubscription(
      member({ subscription_status: 'cancelled', subscription_period_end: '2026-06-01T00:00:00Z' }),
    );
    assert.equal(row.ended_at, '2026-06-01T00:00:00Z');
  });

  test('inactive WITH a stripe subscription id → historical cancelled', () => {
    const row = deriveSubscription(member({ subscription_status: 'inactive' }));
    assert.equal(row.status, 'cancelled');
    assert.equal(row.stripe_subscription_id, 'sub_1');
  });

  test('inactive without stripe → null (never subscribed, no row)', () => {
    const row = deriveSubscription(
      member({ subscription_status: 'inactive', stripe_subscription_id: null }),
    );
    assert.equal(row, null);
  });

  test('active with null stripe id still emits a row (blocker, not a drop)', () => {
    const row = deriveSubscription(member({ stripe_subscription_id: null }));
    assert.equal(row.status, 'active');
    assert.equal(row.stripe_subscription_id, null);
  });

  test('unknown source status throws — no guessing', () => {
    assert.throws(
      () => deriveSubscription(member({ subscription_status: 'frozen' })),
      /unknown subscription_status/,
    );
  });

  // Diamond's webhook writes RAW Stripe statuses verbatim when not
  // 'active' — the full Stripe vocabulary must map, not crash.
  test("raw Stripe 'trialing' → active", () => {
    const row = deriveSubscription(
      member({ subscription_status: 'trialing', scheduled_deactivation_at: '2026-08-01T00:00:00Z' }),
    );
    assert.equal(row.status, 'active');
    assert.equal(row.cancel_at_period_end, true, 'same cancel-at-period-end rule as active');
  });

  test("raw Stripe 'past_due' and 'unpaid' → past_due", () => {
    for (const status of ['past_due', 'unpaid']) {
      const row = deriveSubscription(member({ subscription_status: status }));
      assert.equal(row.status, 'past_due', status);
      assert.equal(row.ended_at, null, status);
    }
  });

  test("raw Stripe 'incomplete' → incomplete", () => {
    const row = deriveSubscription(member({ subscription_status: 'incomplete' }));
    assert.equal(row.status, 'incomplete');
    assert.equal(row.ended_at, null);
  });

  test("raw Stripe 'canceled' (one l) → cancelled with ended_at", () => {
    const row = deriveSubscription(
      member({
        subscription_status: 'canceled',
        deactivated_at: '2026-05-01T00:00:00Z',
      }),
    );
    assert.equal(row.status, 'cancelled');
    assert.equal(row.ended_at, '2026-05-01T00:00:00Z');
  });

  test("raw Stripe 'incomplete_expired' → cancelled", () => {
    const row = deriveSubscription(
      member({
        subscription_status: 'incomplete_expired',
        subscription_period_end: '2026-06-01T00:00:00Z',
      }),
    );
    assert.equal(row.status, 'cancelled');
    assert.equal(row.ended_at, '2026-06-01T00:00:00Z');
  });
});

// ============================================================
// computePurchasedCredits — the P0 bucket split
// ============================================================

function grant(over = {}) {
  return {
    id: 'g-1',
    status: 'claimed',
    credits_amount: 5,
    claimed_at: '2026-06-30T12:00:00Z',
    ...over,
  };
}

describe('computePurchasedCredits', () => {
  test('non-active member: the ENTIRE balance is purchased', () => {
    const purchased = computePurchasedCredits(
      member({ subscription_status: 'inactive' }),
      { current_credits: 7, last_reset: '2026-06-29T00:00:00Z' },
      [], // even with zero grants — no weekly allotment exists to reset
      REF,
    );
    assert.equal(purchased, 7);
  });

  test('active member: claims since last_reset count', () => {
    const purchased = computePurchasedCredits(
      member(),
      { current_credits: 10, last_reset: '2026-06-29T00:00:00Z' },
      [grant({ credits_amount: 5, claimed_at: '2026-06-30T12:00:00Z' })],
      REF,
    );
    assert.equal(purchased, 5);
  });

  test('claims BEFORE last_reset were already clawed back — ignored', () => {
    const purchased = computePurchasedCredits(
      member(),
      { current_credits: 10, last_reset: '2026-06-29T00:00:00Z' },
      [grant({ claimed_at: '2026-06-20T12:00:00Z' })],
      REF,
    );
    assert.equal(purchased, 0);
  });

  test('clamped to current_credits (spends drain the weekly bucket first)', () => {
    const purchased = computePurchasedCredits(
      member(),
      { current_credits: 4, last_reset: '2026-06-29T00:00:00Z' },
      [grant({ credits_amount: 5 })],
      REF,
    );
    assert.equal(purchased, 4);
  });

  test('pending and refunded grants never count', () => {
    const purchased = computePurchasedCredits(
      member(),
      { current_credits: 10, last_reset: '2026-06-29T00:00:00Z' },
      [grant({ status: 'pending' }), grant({ id: 'g-2', status: 'refunded' })],
      REF,
    );
    assert.equal(purchased, 0);
  });

  test('null last_reset means nothing was ever clawed back', () => {
    const purchased = computePurchasedCredits(
      member(),
      { current_credits: 10, last_reset: null },
      [grant({ claimed_at: '2025-01-15T00:00:00Z' })],
      REF,
    );
    assert.equal(purchased, 5);
  });
});

// ============================================================
// transformCreditBalance
// ============================================================

describe('transformCreditBalance', () => {
  test('balance + single migration ledger row with the split in the note', () => {
    const out = transformCreditBalance(
      { member_id: 'm-1', current_credits: 10, last_reset: '2026-06-29T00:00:00Z' },
      member(),
      [grant({ credits_amount: 3 })],
      REF,
    );
    assert.equal(out.balance.member_email, 'member@example.com');
    assert.equal(out.balance.current_credits, 10);
    assert.equal(out.balance.purchased_credits, 3);
    assert.equal(out.balance.last_reset_at, '2026-06-29T00:00:00Z');
    assert.equal(out.ledger.amount, 10);
    assert.equal(out.ledger.balance_after, 10);
    assert.equal(out.ledger.reason, 'migration');
    assert.equal(out.ledger.note, 'migrated from Momentum at cutover (3 of 10 purchased)');
  });

  test('zero balance → amount null (loader skips the ledger insert)', () => {
    const out = transformCreditBalance(
      { member_id: 'm-1', current_credits: 0, last_reset: null },
      member(),
      [],
      REF,
    );
    assert.equal(out.ledger.amount, null);
    assert.equal(out.ledger.balance_after, 0);
    assert.equal(out.balance.purchased_credits, 0);
  });

  test('negative balance throws', () => {
    assert.throws(
      () =>
        transformCreditBalance(
          { member_id: 'm-1', current_credits: -5, last_reset: null },
          member(),
          [],
          REF,
        ),
      /bad credit balance/,
    );
  });

  test('non-numeric balance throws', () => {
    assert.throws(
      () =>
        transformCreditBalance(
          { member_id: 'm-1', current_credits: 'seventeen', last_reset: null },
          member(),
          [],
          REF,
        ),
      /bad credit balance/,
    );
  });
});

// ============================================================
// mergeBookings
// ============================================================

describe('mergeBookings', () => {
  test('setmore + diamond twin dedupes to ONE setmore-sourced member booking', () => {
    const { rows, exceptions } = merge({
      diamondBookings: [diamondBooking({ setmore_appointment_id: 'appt-1' })],
      setmoreRecords: [setmoreRec()],
    });
    assert.equal(rows.length, 1, 'one merged row, not two');
    const row = rows[0];
    assert.equal(row.external_source, 'setmore');
    assert.equal(row.external_id, 'appt-1');
    assert.equal(row.member_email, 'member@example.com');
    assert.equal(row.customer_first_name, null);
    assert.equal(row.customer_email, null);
    assert.equal(row.credit_cost_charged, 3, "the Diamond service's credits_cost");
    assert.equal(row.created_at, '2026-05-20T12:00:00Z', "Diamond's booked_at");
    assert.equal(row.offering_name, 'Cage Rental (30 min)');
    assert.equal(row.resource_name, 'Cage 1');
    assert.equal(exceptions.timeless_bookings.length, 0);
  });

  test('diamond-only row with times imports as external_source diamond', () => {
    const { rows } = merge({ diamondBookings: [diamondBooking()] });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].external_source, 'diamond');
    assert.equal(rows[0].external_id, 'db-1');
    assert.equal(rows[0].member_email, 'member@example.com');
    assert.equal(rows[0].status, 'completed', 'past confirmed becomes completed');
  });

  test('future diamond confirmed row stays confirmed', () => {
    const { rows } = merge({
      diamondBookings: [
        diamondBooking({
          start_time: '2026-07-15T15:00:00Z',
          end_time: '2026-07-15T15:30:00Z',
        }),
      ],
    });
    assert.equal(rows[0].status, 'confirmed');
  });

  test('timeless diamond row (pre-004) → exceptions, never a row', () => {
    const { rows, exceptions } = merge({
      diamondBookings: [diamondBooking({ start_time: null, end_time: null })],
    });
    assert.equal(rows.length, 0);
    assert.equal(exceptions.timeless_bookings.length, 1);
    assert.equal(exceptions.timeless_bookings[0].id, 'db-1');
  });

  test('setmore row matching a member email becomes a member booking', () => {
    const { rows } = merge({
      setmoreRecords: [
        setmoreRec({ 'Customer Name': 'Sam Doe', 'Customer Email': 'Member@Example.COM' }),
      ],
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].member_email, 'member@example.com');
    assert.equal(rows[0].customer_first_name, null, 'member bookings carry no contact');
    assert.equal(rows[0].credit_cost_charged, 3, 'from the name-matched Diamond service');
  });

  test('walk-in keeps contact, splits the name, charges zero credits', () => {
    const { rows } = merge({ setmoreRecords: [setmoreRec()] });
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.member_email, null);
    assert.equal(row.customer_first_name, 'Walk');
    assert.equal(row.customer_last_name, 'In');
    assert.equal(row.customer_email, 'walkin@example.com');
    assert.equal(row.customer_phone, '555-0100');
    assert.equal(row.credit_cost_charged, 0);
    assert.equal(row.amount_due_cents, 0);
    assert.equal(row.payment_status, 'not_required');
    assert.equal(row.status, 'completed', 'June 1 is past the July 1 snapshot');
  });

  test('single-token walk-in name duplicates into both columns', () => {
    const { rows } = merge({ setmoreRecords: [setmoreRec({ 'Customer Name': 'Cher' })] });
    assert.equal(rows[0].customer_first_name, 'Cher');
    assert.equal(rows[0].customer_last_name, 'Cher');
  });

  test('past walk-in missing email → exception only, no blocker', () => {
    const { rows, exceptions, blockers } = merge({
      setmoreRecords: [setmoreRec({ 'Customer Email': '' })],
    });
    assert.equal(rows.length, 0);
    assert.equal(exceptions.walkins_missing_contact.length, 1);
    assert.equal(blockers.length, 0);
  });

  test('FUTURE confirmed walk-in missing contact → exception AND blocker', () => {
    const { rows, exceptions, blockers } = merge({
      setmoreRecords: [
        setmoreRec({
          'Customer Name': '',
          Start: '2026-07-15T15:00:00Z',
          End: '2026-07-15T15:30:00Z',
        }),
      ],
    });
    assert.equal(rows.length, 0);
    assert.equal(exceptions.walkins_missing_contact.length, 1);
    assert.equal(blockers.length, 1);
    assert.equal(blockers[0].code, 'future_walkins_missing_contact');
    assert.equal(blockers[0].count, 1);
    assert.equal(blockers[0].details[0]['Appointment ID'], 'appt-1');
  });

  test('cancelled gets an approximated cancelled_at + reason', () => {
    const { rows } = merge({ setmoreRecords: [setmoreRec({ Status: 'Cancelled' })] });
    assert.equal(rows[0].status, 'cancelled');
    // No booked_at on a Setmore-only row — start_time is the stand-in.
    assert.equal(rows[0].cancelled_at, '2026-06-01T15:00:00.000Z');
    assert.match(rows[0].cancellation_reason, /original cancellation time not recorded/);
  });

  test('no_show marks no_show_marked_at = end_time', () => {
    const { rows } = merge({ setmoreRecords: [setmoreRec({ Status: 'No Show' })] });
    assert.equal(rows[0].status, 'no_show');
    assert.equal(rows[0].no_show_marked_at, '2026-06-01T15:30:00.000Z');
  });

  test('future confirmed walk-in stays confirmed', () => {
    const { rows } = merge({
      setmoreRecords: [
        setmoreRec({ Start: '2026-07-15T15:00:00Z', End: '2026-07-15T15:30:00Z' }),
      ],
    });
    assert.equal(rows[0].status, 'confirmed');
  });

  test('duplicate external id throws — corrupt export', () => {
    assert.throws(
      () => merge({ setmoreRecords: [setmoreRec(), setmoreRec()] }),
      /duplicate external id/,
    );
  });

  test('unmapped staff key throws with the key named', () => {
    assert.throws(
      () => merge({ setmoreRecords: [setmoreRec({ Staff: 'cage9' })] }),
      /unmapped staff key: "cage9"/,
    );
  });

  test('diamond row with null staff_key throws (fail closed, not guess)', () => {
    assert.throws(
      () => merge({ diamondBookings: [diamondBooking({ staff_key: null })] }),
      /staff_key is null/,
    );
  });

  test('naive Setmore times parse in the MAPPING timezone, not the host zone', () => {
    const { rows } = merge({
      setmoreRecords: [setmoreRec({ Start: '2026-06-01 15:00', End: '2026-06-01 15:30' })],
    });
    // 3:00 PM wall clock in New York on June 1 is EDT (UTC-4).
    assert.equal(rows[0].start_time, '2026-06-01T19:00:00.000Z');
    assert.equal(rows[0].end_time, '2026-06-01T19:30:00.000Z');
  });

  test('split date/time export joins the mapped date column onto both times', () => {
    const splitMapping = {
      ...MAPPING,
      setmore_columns: {
        ...MAPPING.setmore_columns,
        date: 'Date',
        start_time: 'Start Time',
        end_time: 'End Time',
      },
    };
    const { rows } = mergeBookings({
      diamondBookings: [],
      servicesById: SERVICES,
      memberById: new Map([['m-1', member()]]),
      setmoreRecords: [
        {
          'Appointment ID': 'appt-split',
          Service: 'Cage 30',
          Staff: 'cage1',
          'Customer Name': 'Walk In',
          'Customer Email': 'walkin@example.com',
          'Customer Phone': '555-0100',
          Date: '6/1/2026',
          'Start Time': '3:00 PM',
          'End Time': '3:30 PM',
          Status: 'Confirmed',
        },
      ],
      mapping: splitMapping,
      referenceTimeMs: REF,
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].start_time, '2026-06-01T19:00:00.000Z');
    assert.equal(rows[0].end_time, '2026-06-01T19:30:00.000Z');
  });

  test('unparseable naive time collects a problem naming the raw value', () => {
    assert.throws(
      () => merge({ setmoreRecords: [setmoreRec({ Start: 'June-ish', End: '2026-06-01 15:30' })] }),
      (err) => /appt-1/.test(err.message) && /"June-ish"/.test(err.message),
    );
  });

  test('timeless diamond rows carry reason missing_times', () => {
    const { exceptions } = merge({
      diamondBookings: [diamondBooking({ start_time: null, end_time: null })],
    });
    assert.equal(exceptions.timeless_bookings[0].reason, 'missing_times');
  });

  test('past setmore row with end <= start → exception with reason invalid_times', () => {
    const { rows, exceptions } = merge({
      setmoreRecords: [
        setmoreRec({ Start: '2026-06-01T15:30:00Z', End: '2026-06-01T15:00:00Z' }),
      ],
    });
    assert.equal(rows.length, 0);
    assert.equal(exceptions.timeless_bookings.length, 1);
    assert.equal(exceptions.timeless_bookings[0].reason, 'invalid_times');
    assert.equal(exceptions.timeless_bookings[0]['Appointment ID'], 'appt-1');
  });

  test('diamond row with zero-length window → exception with reason invalid_times', () => {
    const { rows, exceptions } = merge({
      diamondBookings: [
        diamondBooking({ start_time: '2026-06-02T15:00:00Z', end_time: '2026-06-02T15:00:00Z' }),
      ],
    });
    assert.equal(rows.length, 0);
    assert.equal(exceptions.timeless_bookings[0].reason, 'invalid_times');
    assert.equal(exceptions.timeless_bookings[0].id, 'db-1');
  });

  test('FUTURE confirmed setmore row with end <= start is a hard fail', () => {
    assert.throws(
      () =>
        merge({
          setmoreRecords: [
            setmoreRec({ Start: '2026-07-15T15:30:00Z', End: '2026-07-15T15:00:00Z' }),
          ],
        }),
      /end <= start on a future confirmed/,
    );
  });

  test('FUTURE confirmed diamond row with end <= start is a hard fail', () => {
    assert.throws(
      () =>
        merge({
          diamondBookings: [
            diamondBooking({
              start_time: '2026-07-15T15:30:00Z',
              end_time: '2026-07-15T15:00:00Z',
            }),
          ],
        }),
      /end <= start on a future confirmed/,
    );
  });
});

// ============================================================
// validateSetmoreHeader
// ============================================================

describe('validateSetmoreHeader', () => {
  const FULL_HEADER = [
    'Appointment ID', 'Service', 'Staff', 'Customer Name',
    'Customer Email', 'Customer Phone', 'Start', 'End', 'Status',
  ];

  test('passes when every mapped column exists (extra columns are fine)', () => {
    const cols = validateSetmoreHeader([...FULL_HEADER, 'Label'], MAPPING);
    assert.equal(cols.appointment_id, 'Appointment ID');
    assert.equal(cols.date, undefined, 'no optional date column mapped');
  });

  test('fails listing the missing mapped names AND the header verbatim', () => {
    assert.throws(
      () => validateSetmoreHeader(['Appointment ID', 'Service'], MAPPING),
      (err) =>
        /missing mapped column/.test(err.message) &&
        /"Staff"/.test(err.message) &&
        /"Customer Email"/.test(err.message) &&
        err.message.includes('["Appointment ID","Service"]'),
    );
  });

  test('the optional date column, when mapped, is required in the header too', () => {
    const splitMapping = {
      ...MAPPING,
      setmore_columns: { ...MAPPING.setmore_columns, date: 'Date' },
    };
    assert.throws(
      () => validateSetmoreHeader(FULL_HEADER, splitMapping),
      /"Date"/,
    );
    const cols = validateSetmoreHeader([...FULL_HEADER, 'Date'], splitMapping);
    assert.equal(cols.date, 'Date');
  });
});

// ============================================================
// shared/tz.js — parseSourceTimestamp
// ============================================================

describe('parseSourceTimestamp', () => {
  const NY = 'America/New_York';

  test('ISO-naive summer wall clock converts as EDT (UTC-4)', () => {
    assert.equal(
      parseSourceTimestamp('2026-07-15 15:00:00', NY),
      Date.parse('2026-07-15T19:00:00Z'),
    );
  });

  test('ISO-naive winter wall clock converts as EST (UTC-5), T separator ok', () => {
    assert.equal(
      parseSourceTimestamp('2026-01-15T15:00', NY),
      Date.parse('2026-01-15T20:00:00Z'),
    );
  });

  test('explicit offsets pass through untouched by the zone', () => {
    assert.equal(
      parseSourceTimestamp('2026-07-15T15:00:00Z', NY),
      Date.parse('2026-07-15T15:00:00Z'),
    );
    assert.equal(
      parseSourceTimestamp('2026-07-15T15:00:00-07:00', NY),
      Date.parse('2026-07-15T15:00:00-07:00'),
    );
  });

  test('AM/PM format, case-insensitive, optional space, 12 AM/PM edges', () => {
    assert.equal(parseSourceTimestamp('7/15/2026 3:05 PM', NY), Date.parse('2026-07-15T19:05:00Z'));
    assert.equal(
      parseSourceTimestamp('7/15/2026 3:05:30pm', NY),
      Date.parse('2026-07-15T19:05:30Z'),
    );
    assert.equal(
      parseSourceTimestamp('7/15/2026 12:30 AM', NY),
      Date.parse('2026-07-15T04:30:00Z'),
    );
    assert.equal(
      parseSourceTimestamp('7/15/2026 12:30 pm', NY),
      Date.parse('2026-07-15T16:30:00Z'),
    );
  });

  test('garbage throws naming the raw value', () => {
    assert.throws(() => parseSourceTimestamp('yesterday-ish', NY), /"yesterday-ish"/);
  });

  test('a bare date (no time) throws — never silently midnight', () => {
    assert.throws(() => parseSourceTimestamp('2026-06-01', NY), /"2026-06-01"/);
  });

  test('impossible calendar dates throw instead of rolling over', () => {
    assert.throws(() => parseSourceTimestamp('2026-02-30 10:00', NY), /out of range/);
  });

  test('DST spring-forward nonexistent time resolves deterministically', () => {
    // 2026-03-08 02:30 does not exist in New York (clocks jump
    // 02:00→03:00). The two-pass conversion reads it with the
    // post-jump EDT offset: 06:30Z.
    assert.equal(
      parseSourceTimestamp('2026-03-08 02:30', NY),
      Date.parse('2026-03-08T06:30:00Z'),
    );
  });

  test('DST fall-back ambiguous time resolves to the FIRST occurrence', () => {
    // 2026-11-01 01:30 happens twice in New York; the EDT (first) one
    // wins: 05:30Z, not 06:30Z.
    assert.equal(
      parseSourceTimestamp('2026-11-01 01:30', NY),
      Date.parse('2026-11-01T05:30:00Z'),
    );
  });
});

// ============================================================
// derivePlanRows
// ============================================================

describe('derivePlanRows', () => {
  test('credits_per_week mismatch → blocker, mode value used', () => {
    const members = [
      member({ id: 'm-1', email: 'a@x.com', credits_per_week: 4 }),
      member({ id: 'm-2', email: 'b@x.com', credits_per_week: 4 }),
      member({ id: 'm-3', email: 'c@x.com', credits_per_week: 8 }),
    ];
    const { plans, blockers } = derivePlanRows(members, MAPPING);
    assert.equal(plans.length, 1);
    assert.equal(plans[0].source_plan_key, 'basic');
    assert.equal(plans[0].name, 'Starter');
    assert.equal(plans[0].monthly_price_cents, 9900);
    assert.equal(plans[0].stripe_price_id, 'price_basic');
    assert.equal(plans[0].credits_per_week, 4, 'the MODE across members');
    assert.equal(blockers.length, 1);
    assert.equal(blockers[0].code, 'plan_credits_mismatch');
    assert.equal(blockers[0].count, 1);
    const detail = blockers[0].details[0];
    assert.equal(detail.used_credits_per_week, 4);
    assert.equal(detail.members.length, 3);
  });

  test('unmapped plan key throws naming the key', () => {
    assert.throws(() => derivePlanRows([member({ plan: 'gold' })], MAPPING), /"gold"/);
  });

  test('members that get no subscription row never force a plan', () => {
    const ghost = member({
      plan: 'gold', // unmapped — but this member never subscribed
      subscription_status: 'inactive',
      stripe_subscription_id: null,
    });
    const { plans, blockers } = derivePlanRows([ghost], MAPPING);
    assert.deepEqual(plans, []);
    assert.deepEqual(blockers, []);
  });
});

// ============================================================
// deriveCreditGrantExceptions
// ============================================================

describe('deriveCreditGrantExceptions', () => {
  test('pending → exceptions + blocker; refunded → archive only', () => {
    const grants = [
      grant({ id: 'g-claimed' }),
      grant({
        id: 'g-pending',
        status: 'pending',
        claimed_at: null,
        claim_token_expires_at: '2026-06-01T00:00:00Z', // lapsed pre-snapshot
      }),
      grant({ id: 'g-refunded', status: 'refunded' }),
    ];
    const { pending, refunded, blockers } = deriveCreditGrantExceptions(grants, REF);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].id, 'g-pending');
    assert.equal(pending[0].expired_at_snapshot, true, 'expired gifts are still liabilities');
    assert.equal(refunded.length, 1);
    assert.equal(refunded[0].id, 'g-refunded');
    assert.equal(blockers.length, 1);
    assert.equal(blockers[0].code, 'pending_gifts');
    assert.equal(blockers[0].count, 1);
  });

  test('unknown grant status throws', () => {
    assert.throws(
      () => deriveCreditGrantExceptions([grant({ status: 'limbo' })], REF),
      /unknown status/,
    );
  });
});

// ============================================================
// shared/csv.js — parseCsv
// ============================================================

describe('parseCsv', () => {
  test('quoted fields, embedded commas, escaped quotes', () => {
    const { header, records } = parseCsv('a,b\n"x, y","he said ""hi"""\n');
    assert.deepEqual(header, ['a', 'b']);
    assert.equal(records.length, 1);
    assert.equal(records[0].a, 'x, y');
    assert.equal(records[0].b, 'he said "hi"');
  });

  test('CRLF endings and embedded newlines inside quotes', () => {
    const { records } = parseCsv('a,b\r\n"line1\nline2",z\r\n');
    assert.equal(records.length, 1);
    assert.equal(records[0].a, 'line1\nline2');
    assert.equal(records[0].b, 'z');
  });

  test('ragged row throws instead of padding', () => {
    assert.throws(() => parseCsv('a,b,c\n1,2,3\n4,5\n'), /row 3 has 2 fields/);
  });

  test('leading UTF-8 BOM is stripped before the header is read', () => {
    const { header, records } = parseCsv('\uFEFFa,b\n1,2\n');
    assert.deepEqual(header, ['a', 'b'], 'first header name must not keep the BOM');
    assert.equal(records[0].a, '1');
  });

  test('unterminated quote throws', () => {
    assert.throws(() => parseCsv('a,b\n"oops,1\n'), /unterminated quoted field/);
  });
});

// ============================================================
// shared/manifest.js — readVerified + requireFiles
// ============================================================

describe('manifest helpers', () => {
  test('readVerified returns the payload while bytes match, throws on drift', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'migration-manifest-test-'));
    const entry = await writeJsonWithHash(dir, 'data.json', [{ a: 1 }]);
    const manifest = { files: { 'data.json': entry } };

    assert.deepEqual(await readVerified(dir, manifest, 'data.json'), [{ a: 1 }]);

    // Tamper with the bytes after the manifest was written — the exact
    // failure mode checksums exist to catch.
    await writeFile(join(dir, 'data.json'), JSON.stringify([{ a: 2 }]));
    await assert.rejects(() => readVerified(dir, manifest, 'data.json'), /checksum mismatch/);
  });

  test('readVerified refuses a file the manifest does not list', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'migration-manifest-test-'));
    await assert.rejects(
      () => readVerified(dir, { files: {} }, 'ghost.json'),
      /not listed in the manifest/,
    );
  });

  test('requireFiles lists EVERY missing dataset at once', () => {
    assert.throws(
      () => requireFiles({ files: { 'a.json': { rows: 0, sha256: 'x' } } }, ['a.json', 'b.json', 'c.json']),
      (err) => /b\.json/.test(err.message) && /c\.json/.test(err.message),
    );
  });
});
