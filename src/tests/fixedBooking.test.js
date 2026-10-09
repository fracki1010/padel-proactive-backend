'use strict';

// Unit tests for fixed weekly turns. The DB is stubbed at the model boundary
// (same pattern as the deposit tests) so these cover weekday math and the
// conflict filters without a live Mongo instance.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const FixedBooking = require('../models/fixedBooking.model');
const {
  findConflictingFixedForBooking,
  getConflicts,
  getWeekdayFromDate,
} = require('../services/fixedBooking.service');

// UTC dates: 2026-10-04 domingo, 2026-10-06 martes, 2026-10-10 sábado.
test('currentWeekday maps a UTC date to the JS weekday (0=DOM .. 6=SÁB)', () => {
  assert.equal(FixedBooking.currentWeekday(new Date('2026-10-04T00:00:00.000Z')), 0);
  assert.equal(FixedBooking.currentWeekday(new Date('2026-10-06T00:00:00.000Z')), 2);
  assert.equal(FixedBooking.currentWeekday(new Date('2026-10-10T00:00:00.000Z')), 6);
});

test('getWeekdayFromDate is UTC-based and rejects invalid dates with NaN', () => {
  assert.equal(getWeekdayFromDate(new Date('2026-10-06T00:00:00.000Z')), 2);
  // A booking date normalized to UTC midnight must not shift the weekday.
  const normalized = new Date('2026-10-06');
  normalized.setUTCHours(0, 0, 0, 0);
  assert.equal(getWeekdayFromDate(normalized), 2);
  assert.ok(Number.isNaN(getWeekdayFromDate(new Date('not-a-date'))));
});

test('findConflictingFixedForBooking queries by the date weekday, court, slot and active status', async () => {
  const originalFindOne = FixedBooking.findOne;
  let capturedFilter = null;
  FixedBooking.findOne = async (filter) => {
    capturedFilter = filter;
    return { _id: 'fixed-1', ...filter };
  };

  try {
    const result = await findConflictingFixedForBooking({
      companyId: 'company-1',
      date: new Date('2026-10-06T00:00:00.000Z'), // martes
      courtId: 'court-1',
      timeSlotId: 'slot-1',
    });

    assert.equal(capturedFilter.weekday, 2);
    assert.equal(String(capturedFilter.court), 'court-1');
    assert.equal(String(capturedFilter.timeSlot), 'slot-1');
    assert.equal(capturedFilter.status, 'active');
    assert.equal(String(capturedFilter.companyId), 'company-1');
    assert.ok(result);
  } finally {
    FixedBooking.findOne = originalFindOne;
  }
});

test('findConflictingFixedForBooking returns null when there is no match', async () => {
  const originalFindOne = FixedBooking.findOne;
  FixedBooking.findOne = async () => null;

  try {
    const result = await findConflictingFixedForBooking({
      companyId: 'company-1',
      date: new Date('2026-10-05T00:00:00.000Z'), // lunes
      courtId: 'court-1',
      timeSlotId: 'slot-1',
    });
    assert.equal(result, null);
  } finally {
    FixedBooking.findOne = originalFindOne;
  }
});

test('findConflictingFixedForBooking returns null for an invalid date without querying', async () => {
  const originalFindOne = FixedBooking.findOne;
  let called = false;
  FixedBooking.findOne = async () => {
    called = true;
    return { _id: 'should-not-happen' };
  };

  try {
    const result = await findConflictingFixedForBooking({
      companyId: 'company-1',
      date: new Date('not-a-date'),
      courtId: 'court-1',
      timeSlotId: 'slot-1',
    });
    assert.equal(result, null);
    assert.equal(called, false);
  } finally {
    FixedBooking.findOne = originalFindOne;
  }
});

test('getConflicts scopes by company+weekday+court+slot, only active, and excludes self on update', async () => {
  const originalFind = FixedBooking.find;
  let capturedFilter = null;
  FixedBooking.find = async (filter) => {
    capturedFilter = filter;
    return [{ _id: 'conflict-1' }];
  };

  try {
    const conflicts = await getConflicts({
      companyId: 'company-1',
      weekday: '3',
      court: 'court-1',
      timeSlot: 'slot-1',
    });

    assert.equal(capturedFilter.weekday, 3);
    assert.equal(String(capturedFilter.court), 'court-1');
    assert.equal(String(capturedFilter.timeSlot), 'slot-1');
    assert.equal(capturedFilter.status, 'active');
    assert.equal(capturedFilter._id, undefined);
    assert.equal(conflicts.length, 1);

    await getConflicts({
      companyId: 'company-1',
      weekday: 3,
      court: 'court-1',
      timeSlot: 'slot-1',
      excludeId: 'fixed-1',
    });
    assert.deepEqual(capturedFilter._id, { $ne: 'fixed-1' });
  } finally {
    FixedBooking.find = originalFind;
  }
});
