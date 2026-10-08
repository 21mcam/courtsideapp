// Member-facing credit history labels (client/src/format.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { memberCreditLabel } from '../client/src/format.js';

const TZ = 'America/New_York';

test('booking rows name the offering and the tenant-local time', () => {
  assert.equal(
    memberCreditLabel(
      { reason: 'booking_spend', offering_name: '60-Minute Cage', booking_start: '2026-10-08T20:00:00Z' },
      TZ,
    ),
    'Booked 60-Minute Cage · Thu, Oct 8, 4:00 PM',
  );
  assert.equal(
    memberCreditLabel({ reason: 'booking_refund', offering_name: 'Hitting Clinic', booking_start: null }, TZ),
    'Refund · cancelled Hitting Clinic',
  );
});

test('non-booking reasons are plain words, never raw keys', () => {
  for (const reason of [
    'weekly_reset',
    'pack_purchase',
    'signup_bonus',
    'admin_adjustment',
    'manual',
    'plan_change',
    'migration',
    'something_new',
  ]) {
    const label = memberCreditLabel({ reason }, TZ);
    assert.doesNotMatch(label, /_/, `${reason} → ${label}`);
  }
  assert.equal(memberCreditLabel({ reason: 'admin_adjustment' }, TZ), 'Adjusted by staff');
});
