'use strict';

// Unit tests for fixed weekly turns. The DB is stubbed at the model boundary
// (same pattern as the deposit tests) so these cover weekday math and the
// conflict filters without a live Mongo instance.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const FixedBooking = require('../models/fixedBooking.model');
const {
  findConflictingFixedForBooking,
  getConflicts,
  getWeekdayFromDate,
} = require('../services/fixedBooking.service');
const fixedBookingController = require('../controllers/fixedBooking.controller');

// UTC dates: 2026-10-04 domingo, 2026-10-06 martes, 2026-10-10 sábado.
test('getWeekdayFromDate (model) maps a UTC date to the JS weekday (0=DOM .. 6=SÁB)', () => {
  assert.equal(FixedBooking.getWeekdayFromDate(new Date('2026-10-04T00:00:00.000Z')), 0);
  assert.equal(FixedBooking.getWeekdayFromDate(new Date('2026-10-06T00:00:00.000Z')), 2);
  assert.equal(FixedBooking.getWeekdayFromDate(new Date('2026-10-10T00:00:00.000Z')), 6);
});

test('getWeekdayFromDate (service) is UTC-based and rejects invalid dates with NaN', () => {
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

// ---------------------------------------------------------------------------
// clientName is REQUIRED end-to-end: the controller must reject empty names
// with a 400 BEFORE any DB write, and the model must validate it too.
// ---------------------------------------------------------------------------

const buildReq = (overrides = {}) => ({
  user: { companyId: 'company-1' },
  body: {},
  params: {},
  query: {},
  ...overrides,
});

const buildRes = () => {
  const res = {};
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.payload = payload;
    return res;
  };
  res.send = () => res;
  return res;
};

const CLIENT_REQUIRED = {
  success: false,
  error: 'El turno fijo debe tener un cliente',
};

test('createFixedBooking rejects a missing, empty or whitespace-only clientName with 400', async () => {
  const id = new mongoose.Types.ObjectId().toString();
  for (const clientName of [undefined, '', '   ']) {
    const res = buildRes();
    await fixedBookingController.createFixedBooking(
      buildReq({
        body: { court: id, timeSlot: id, weekday: 2, clientName },
      }),
      res,
    );
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.payload, CLIENT_REQUIRED);
  }
});

test('updateFixedBooking rejects clearing clientName to empty with 400', async () => {
  const originalFindOne = FixedBooking.findOne;
  FixedBooking.findOne = async () => ({
    _id: 'fixed-1',
    companyId: 'company-1',
    clientName: 'Juan',
  });

  try {
    const id = new mongoose.Types.ObjectId().toString();
    for (const clientName of ['', '   ']) {
      const res = buildRes();
      await fixedBookingController.updateFixedBooking(
        buildReq({ params: { id }, body: { clientName } }),
        res,
      );
      assert.equal(res.statusCode, 400);
      assert.deepEqual(res.payload, CLIENT_REQUIRED);
    }
  } finally {
    FixedBooking.findOne = originalFindOne;
  }
});

test('FixedBooking model validation rejects a turn without clientName', async () => {
  const id = new mongoose.Types.ObjectId();
  const doc = new FixedBooking({
    companyId: id,
    court: id,
    timeSlot: id,
    weekday: 2,
  });
  await assert.rejects(doc.validate(), (error) => {
    assert.equal(error.name, 'ValidationError');
    assert.ok(error.errors?.clientName, 'expected a clientName validation error');
    return true;
  });
});

test('FixedBooking model trims clientName on assignment', async () => {
  const id = new mongoose.Types.ObjectId();
  const doc = new FixedBooking({
    companyId: id,
    court: id,
    timeSlot: id,
    weekday: 2,
    clientName: '  Juan Pérez  ',
  });
  await doc.validate();
  assert.equal(doc.clientName, 'Juan Pérez');
});
