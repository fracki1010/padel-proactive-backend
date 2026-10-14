'use strict';

// Admin createBooking must resolve the slot within the chosen court's effective
// schedule (the per-court override). A court with own slots may only use its own
// times; a court without own slots uses the general times. The slotId path is
// left untouched (covered by adminBookingWhilePaused.test.js).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const COMPANY = '64b0000000000000000000a1';
const COURT_A = '64b0000000000000000000ca';
const COURT_B = '64b0000000000000000000cb';
const SLOT_G20 = 'slot-general-20';
const SLOT_A10 = 'slot-own-a-10';

const state = {
  slots: [],
  created: null,
  rawSlotId: null,
};

const resetState = () => {
  state.slots = [
    { _id: SLOT_G20, startTime: '20:00', endTime: '21:00', price: 25000, court: null, isActive: true },
    { _id: SLOT_A10, startTime: '10:00', endTime: '11:00', price: 20000, court: COURT_A, isActive: true },
  ];
  state.created = null;
  state.rawSlotId = null;
};

const slotMatches = (slot, filter = {}) => {
  if (filter.startTime !== undefined && String(slot.startTime) !== String(filter.startTime)) {
    return false;
  }
  if (Object.prototype.hasOwnProperty.call(filter, 'court')) {
    const want = filter.court === null || filter.court === undefined ? '' : String(filter.court);
    const have = slot.court ? String(slot.court) : '';
    if (want !== have) return false;
  }
  if (filter.isActive === true && slot.isActive === false) return false;
  if (filter._id !== undefined && String(slot._id) !== String(filter._id)) return false;
  return true;
};

const makeFindResult = (items) => {
  items.select = () => items;
  items.lean = async () => items;
  return items;
};

// Patch service seams + models BEFORE requiring the controller.
const fixedTurnsService = require('../services/fixedTurnsMaterialization.service');
const fixedBookingService = require('../services/fixedBooking.service');
const notificationService = require('../services/notificationService');
const whatsappQueue = require('../services/whatsappCommandQueue.service');
const appConfigService = require('../services/appConfig.service');
const depositService = require('../services/deposit.service');

fixedTurnsService.materializeFixedBookingsForDate = async () => {};
fixedTurnsService.materializeFixedBookingsInRange = async () => {};
fixedBookingService.findConflictingFixedForBooking = async () => null;
notificationService.sendAdminNotification = async () => {};
whatsappQueue.enqueueWhatsappCommand = async () => ({ command: { _id: 'cmd-x' } });
appConfigService.getPenaltyLimit = async () => 2;
depositService.approveDepositManually = async () => ({});
depositService.handleDepositPaid = async () => ({});
depositService.markRefundableOnCancel = () => ({ refundable: false, deposit: null });

const Court = require('../models/court.model');
const TimeSlot = require('../models/timeSlot.model');
const Booking = require('../models/booking.model');

Court.exists = async () => true;
TimeSlot.find = (filter = {}) =>
  makeFindResult(state.slots.filter((slot) => slotMatches(slot, filter)));
TimeSlot.findOne = async (filter = {}) =>
  state.slots.find((slot) => slotMatches(slot, filter)) || null;
Booking.countDocuments = async () => 0;
Booking.findOne = async () => null;
Booking.create = async (doc) => {
  const raw = { _id: 'booking-admin-1', ...doc };
  state.created = raw;
  state.rawSlotId = doc.timeSlot;
  raw.populate = async () => {
    raw.court = { name: 'Cancha' };
    raw.timeSlot = state.slots.find((slot) => String(slot._id) === String(doc.timeSlot)) || {};
    return raw;
  };
  return raw;
};

const { createBooking } = require('../controllers/booking.controller');

const createResponse = () => ({
  statusCode: undefined,
  payload: undefined,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.payload = body;
    return this;
  },
});

const adminReq = (overrides = {}) => ({
  user: { role: 'admin', companyId: COMPANY, _id: 'admin-1' },
  body: {
    date: '2099-01-03',
    clientName: 'Admin client',
    clientPhone: '5491111111111',
    ...overrides,
  },
});

test('admin books a court own time', async () => {
  resetState();
  const res = createResponse();
  await createBooking(adminReq({ courtId: COURT_A, time: '10:00' }), res);

  assert.equal(res.statusCode, 201);
  assert.equal(String(state.rawSlotId), SLOT_A10);
});

test('admin cannot book a general time for a court that owns its own schedule', async () => {
  resetState();
  const res = createResponse();
  await createBooking(adminReq({ courtId: COURT_A, time: '20:00' }), res);

  assert.equal(res.statusCode, 400);
  assert.equal(state.created, null);
});

test('admin books the general time for a court without own slots', async () => {
  resetState();
  const res = createResponse();
  await createBooking(adminReq({ courtId: COURT_B, time: '20:00' }), res);

  assert.equal(res.statusCode, 201);
  assert.equal(String(state.rawSlotId), SLOT_G20);
});

test('admin cannot book another court own time', async () => {
  resetState();
  const res = createResponse();
  await createBooking(adminReq({ courtId: COURT_B, time: '10:00' }), res);

  assert.equal(res.statusCode, 400);
  assert.equal(state.created, null);
});
