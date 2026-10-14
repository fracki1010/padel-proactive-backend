'use strict';

// Pure math for the slot-duration backfill migration. The script itself is
// only executed manually (npm run migrate:slot-duration); importing it here
// must not open a database connection.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  computeDurationMinutes,
  planSlotDurationUpdates,
} = require('../../scripts/backfillSlotDuration');

test('computeDurationMinutes derives the duration from start and end times', () => {
  assert.equal(computeDurationMinutes('20:00', '21:30'), 90);
  assert.equal(computeDurationMinutes('10:00', '10:15'), 15);
  assert.equal(computeDurationMinutes('09:05', '11:05'), 120);
});

test('computeDurationMinutes wraps a past-midnight end time', () => {
  assert.equal(computeDurationMinutes('23:30', '00:30'), 60);
  assert.equal(computeDurationMinutes('23:00', '02:00'), 180);
});

test('computeDurationMinutes returns null for invalid times', () => {
  assert.equal(computeDurationMinutes('24:00', '01:00'), null);
  assert.equal(computeDurationMinutes('20:00', 'nope'), null);
});

test('planSlotDurationUpdates only targets slots missing a duration', () => {
  const updates = planSlotDurationUpdates([
    { _id: 'legacy', startTime: '20:00', endTime: '21:30' },
    { _id: 'done', startTime: '20:00', endTime: '21:00', durationMinutes: 60 },
    { _id: 'broken', startTime: 'bad', endTime: 'worse' },
  ]);

  assert.deepEqual(updates, [{ id: 'legacy', durationMinutes: 90 }]);
});

test('planSlotDurationUpdates is idempotent across repeated runs', () => {
  const slots = [{ _id: 'legacy', startTime: '20:00', endTime: '21:00' }];
  const first = planSlotDurationUpdates(slots);
  assert.deepEqual(first, [{ id: 'legacy', durationMinutes: 60 }]);

  slots[0].durationMinutes = 60;
  assert.deepEqual(planSlotDurationUpdates(slots), []);
});
