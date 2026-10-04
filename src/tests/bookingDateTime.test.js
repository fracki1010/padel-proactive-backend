'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  isValidIsoDate,
  addDaysToIsoDate,
  formatIsoDateAsDayMonthYear,
  toMinutes,
  timeToMinutes,
  extractDayPeriodFromMessage,
  getDayPeriodLabel,
  filterSlotsByPeriod,
  findNearbySlots,
} = require('../whatsapp/domain/bookingDateTime');

test('isValidIsoDate accepts YYYY-MM-DD and rejects other formats', () => {
  assert.strictEqual(isValidIsoDate('2026-04-07'), true);
  assert.strictEqual(isValidIsoDate('07-04-2026'), false);
  assert.strictEqual(isValidIsoDate(''), false);
});

test('addDaysToIsoDate rolls over month boundaries', () => {
  assert.strictEqual(addDaysToIsoDate('2026-04-07', 2), '2026-04-09');
  assert.strictEqual(addDaysToIsoDate('2026-04-30', 1), '2026-05-01');
});

test('formatIsoDateAsDayMonthYear converts to DD/MM/YYYY', () => {
  assert.strictEqual(formatIsoDateAsDayMonthYear('2026-04-07'), '07/04/2026');
});

test('toMinutes and timeToMinutes convert HH:MM', () => {
  assert.strictEqual(toMinutes('20:30'), 1230);
  assert.strictEqual(toMinutes('abc'), null);
  assert.strictEqual(timeToMinutes('09:15'), 555);
  assert.strictEqual(timeToMinutes('x'), null);
});

test('extractDayPeriodFromMessage detects morning/afternoon/night', () => {
  assert.strictEqual(extractDayPeriodFromMessage('a la tarde'), 'AFTERNOON');
  assert.strictEqual(extractDayPeriodFromMessage('por la noche'), 'NIGHT');
  assert.strictEqual(extractDayPeriodFromMessage('hola'), null);
});

test('getDayPeriodLabel maps period codes to Spanish labels', () => {
  assert.strictEqual(getDayPeriodLabel('MORNING'), 'mañana');
  assert.strictEqual(getDayPeriodLabel('NIGHT'), 'noche');
  assert.strictEqual(getDayPeriodLabel(null), null);
});

test('filterSlotsByPeriod keeps only slots inside the requested window', () => {
  const slots = [{ time: '08:00' }, { time: '15:00' }, { time: '21:00' }];
  assert.deepStrictEqual(filterSlotsByPeriod(slots, 'MORNING'), [{ time: '08:00' }]);
  assert.deepStrictEqual(filterSlotsByPeriod(slots, null), slots);
});

test('findNearbySlots returns slots within the window, excluding the exact match', () => {
  const slots = [{ time: '19:30' }, { time: '21:00' }, { time: '08:00' }];
  assert.deepStrictEqual(findNearbySlots('20:00', slots, 90), [
    { time: '19:30' },
    { time: '21:00' },
  ]);
  assert.deepStrictEqual(findNearbySlots('nope', slots, 90), []);
});