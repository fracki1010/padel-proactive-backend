'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { planPerCourtConversion } = require('../utils/slotConversionPlan');

const slot = (startTime, extra = {}) => ({ _id: `s-${startTime}`, startTime, ...extra });
const court = (id, name = id) => ({ _id: id, name });

test('copies every general slot into every active court', () => {
  const plan = planPerCourtConversion({
    generalSlots: [slot('14:00'), slot('15:30')],
    courts: [court('c1'), court('c2')],
    ownedSlots: [],
  });

  assert.equal(plan.toCreate.length, 4);
  assert.equal(plan.skipped, 0);
  assert.equal(plan.toDeleteIds.length, 2);
  const combos = plan.toCreate.map((x) => `${x.court}:${x.source.startTime}`).sort();
  assert.deepEqual(combos, ['c1:14:00', 'c1:15:30', 'c2:14:00', 'c2:15:30']);
});

test('skips a court that already owns that startTime', () => {
  const plan = planPerCourtConversion({
    generalSlots: [slot('14:00'), slot('15:30')],
    courts: [court('c1'), court('c2')],
    ownedSlots: [{ court: 'c2', startTime: '14:00' }],
  });

  const combos = plan.toCreate.map((x) => `${x.court}:${x.source.startTime}`).sort();
  assert.deepEqual(combos, ['c1:14:00', 'c1:15:30', 'c2:15:30']);
  assert.equal(plan.skipped, 1);
});

test('no general slots produces an empty plan', () => {
  const plan = planPerCourtConversion({ generalSlots: [], courts: [court('c1')] });
  assert.deepEqual(plan.toCreate, []);
  assert.deepEqual(plan.toDeleteIds, []);
});

test('dedupes repeated general startTimes per court', () => {
  const plan = planPerCourtConversion({
    generalSlots: [slot('23:00'), slot('23:00', { _id: 'dup' })],
    courts: [court('c1')],
    ownedSlots: [],
  });

  assert.equal(plan.toCreate.length, 1);
  assert.equal(plan.skipped, 1);
  // both duplicates are still deleted
  assert.equal(plan.toDeleteIds.length, 2);
});
