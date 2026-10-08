// Public facility home page: hours merging (server) + display helpers
// (client). Pure functions — no DB.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mergeWeeklyHours } from '../src/lib/hours.js';
import {
  formatClock,
  formatIntervals,
  mondayFirst,
  openStatus,
} from '../client/src/lib/publicHome.js';

test('mergeWeeklyHours unions resources per day; gaps survive, touching windows join', () => {
  const week = mergeWeeklyHours([
    // Monday: Cage 1 9–17, Cage 2 12–21 → 9–21
    { day_of_week: 1, open_time: '09:00:00', close_time: '17:00:00' },
    { day_of_week: 1, open_time: '12:00:00', close_time: '21:00:00' },
    // Saturday: split shift 9–12 + 14–17, plus a touching 12–12:30 on another cage
    { day_of_week: 6, open_time: '14:00:00', close_time: '17:00:00' },
    { day_of_week: 6, open_time: '09:00:00', close_time: '12:00:00' },
    { day_of_week: 6, open_time: '12:00:00', close_time: '12:30:00' },
    // Wednesday: one window nested inside another
    { day_of_week: 3, open_time: '08:00:00', close_time: '22:00:00' },
    { day_of_week: 3, open_time: '10:00:00', close_time: '11:00:00' },
  ]);
  assert.equal(week.length, 7);
  assert.deepEqual(week[1].intervals, [{ open: '09:00', close: '21:00' }]);
  assert.deepEqual(week[6].intervals, [
    { open: '09:00', close: '12:30' },
    { open: '14:00', close: '17:00' },
  ]);
  assert.deepEqual(week[3].intervals, [{ open: '08:00', close: '22:00' }]);
  assert.deepEqual(week[0].intervals, []);
});

test('clock + interval formatting', () => {
  assert.equal(formatClock('09:00'), '9 AM');
  assert.equal(formatClock('13:30'), '1:30 PM');
  assert.equal(formatClock('00:00'), '12 AM');
  assert.equal(formatClock('12:00'), '12 PM');
  assert.equal(formatIntervals([]), 'Closed');
  assert.equal(
    formatIntervals([
      { open: '09:00', close: '12:00' },
      { open: '14:00', close: '21:30' },
    ]),
    '9 AM – 12 PM, 2 PM – 9:30 PM',
  );
});

test('mondayFirst orders the week Monday → Sunday', () => {
  const week = mergeWeeklyHours([]);
  assert.deepEqual(
    mondayFirst(week).map((d) => d.day_of_week),
    [1, 2, 3, 4, 5, 6, 0],
  );
});

test('openStatus uses the TENANT clock, not the viewer clock', () => {
  const hours = mergeWeeklyHours([
    { day_of_week: 4, open_time: '09:00:00', close_time: '21:00:00' }, // Thursday
    { day_of_week: 5, open_time: '10:00:00', close_time: '18:00:00' }, // Friday
  ]);
  const tz = 'America/New_York';
  // Thu 2026-10-08 14:00 EDT = 18:00Z
  assert.deepEqual(openStatus(hours, tz, new Date('2026-10-08T18:00:00Z')), {
    open: true,
    label: 'Open now · until 9 PM',
  });
  // Thu 08:00 EDT → opens later today
  assert.equal(
    openStatus(hours, tz, new Date('2026-10-08T12:00:00Z')).label,
    'Closed · opens 9 AM',
  );
  // Thu 22:00 EDT (Fri 02:00Z — already Friday in UTC) → tomorrow
  assert.equal(
    openStatus(hours, tz, new Date('2026-10-09T02:00:00Z')).label,
    'Closed · opens tomorrow 10 AM',
  );
  // Fri 19:00 EDT → next window is next Thursday
  assert.equal(
    openStatus(hours, tz, new Date('2026-10-09T23:00:00Z')).label,
    'Closed · opens Thursday 9 AM',
  );
  // Closing time itself is closed ([open, close) like the schema).
  assert.equal(openStatus(hours, tz, new Date('2026-10-09T01:00:00Z')).open, false);
});

test('openStatus is null when the facility has entered no hours', () => {
  assert.equal(openStatus(mergeWeeklyHours([]), 'America/New_York'), null);
});
