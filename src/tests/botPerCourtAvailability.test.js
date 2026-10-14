'use strict';

// The bot availability (`getAvailableSlots`, also used by the admin grid) must
// honour the per-court override rule: a court with own active slots ignores the
// general set, and a court without own slots falls back to the general set.
// Data access is stubbed at the model boundary; the real booking service runs.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { isPhoneExempt } = require('../services/appConfig.service');
const realSlotLockService = require('../services/slotLock.service');

const COMPANY = '64b0000000000000000000a1';
const COURT_A = '64b0000000000000000000ca';
const COURT_B = '64b0000000000000000000cb';
const SLOT_G20 = 'slot-general-20';
const SLOT_A10 = 'slot-own-a-10';
const FUTURE_DATE = '2099-01-01';

const state = {
  bookings: [],
  fixed: [],
  lockedSlots: [],
  courts: [],
  slotDocs: [],
};

const resetState = () => {
  state.bookings = [];
  state.fixed = [];
  state.lockedSlots = [];
  state.courts = [
    { _id: COURT_A, name: 'Cancha 1', courtType: null },
    { _id: COURT_B, name: 'Cancha 2', courtType: null },
  ];
  state.slotDocs = [
    { _id: SLOT_G20, startTime: '20:00', endTime: '21:00', price: 25000, court: null },
  ];
};

const stubModule = (requestPath, exportsObj) => {
  const resolved = require.resolve(requestPath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsObj,
  };
  return resolved;
};

const makeFindResult = (items, methods = ['select', 'lean', 'sort']) => {
  for (const method of methods) items[method] = () => items;
  return items;
};

stubModule('../models/booking.model', {
  countDocuments: async () => 0,
  find: () => makeFindResult(state.bookings),
  findOne: async () => null,
  updateOne: async () => ({ matchedCount: 1 }),
  create: async (doc) => ({ _id: 'booking-1', ...doc }),
});
stubModule('../models/court.model', {
  COURT_TYPES: ['Techada', 'VIP'],
  find: (filter = {}) => {
    const list = filter.courtType
      ? state.courts.filter((court) => court.courtType === filter.courtType)
      : state.courts;
    return makeFindResult(list);
  },
  findOne: async () => state.courts[0] || null,
});
stubModule('../models/timeSlot.model', {
  find: () => makeFindResult(state.slotDocs),
  findOne: async () => state.slotDocs[0] || null,
});
stubModule('../models/user.model', { findOne: async () => null });
stubModule('../models/fixedBooking.model', {
  find: () => makeFindResult(state.fixed),
  findOne: async () => null,
  getWeekdayFromDate: (value) =>
    (value instanceof Date ? value : new Date(value)).getUTCDay(),
});
stubModule('../models/admin.model', {
  find: () => ({ select: () => ({ lean: async () => [] }) }),
});
stubModule('../services/fixedBooking.service', {
  findConflictingFixedForBooking: async () => null,
  getWeekdayFromDate: (value) =>
    (value instanceof Date ? value : new Date(value)).getUTCDay(),
});
stubModule('../services/slotLock.service', {
  buildForeignLockedKeys: realSlotLockService.buildForeignLockedKeys,
  createMongooseSlotLockStore: () => ({
    findActiveLocksForDate: async () => state.lockedSlots,
  }),
});
stubModule('../services/fixedTurnsMaterialization.service', {
  materializeFixedBookingsForDate: async () => {},
});
stubModule('../services/appConfig.service', {
  getBookingsPaused: async () => false,
  getDepositSettings: async () => ({
    depositEnabled: false,
    depositAmount: 0,
    holdMinutes: 15,
    depositExemptPhones: [],
  }),
  getCancellationLockHours: async () => 0,
  getPenaltyLimit: async () => 2,
  getPenaltySystemEnabled: async () => false,
  isPhoneExempt,
});
stubModule('../services/notificationService', { sendAdminNotification: async () => {} });
stubModule('../services/depositNotification.service', { notifyDepositPending: async () => {} });
stubModule('../services/whatsappCommandQueue.service', {
  COMMAND_TYPES: {
    SEND_MESSAGE: 'SEND_MESSAGE',
    NOTIFY_CANCELLATION_GROUP: 'NOTIFY_CANCELLATION_GROUP',
  },
  enqueueWhatsappCommand: async () => ({ command: { _id: 'cmd-x' } }),
});
stubModule('../services/deposit.service', {
  buildDepositFields: () => ({}),
  buildDepositPaymentLink: async () => ({ initPoint: '' }),
  markRefundableOnCancel: () => ({ refundable: false, deposit: null }),
});

const { getAvailableSlots } = require('../services/bookingService');

test('a court with own slots ignores the general set for the bot', async () => {
  resetState();
  state.slotDocs = [
    { _id: SLOT_G20, startTime: '20:00', endTime: '21:00', price: 25000, court: null },
    { _id: SLOT_A10, startTime: '10:00', endTime: '11:00', price: 25000, court: COURT_A },
  ];

  const result = await getAvailableSlots(FUTURE_DATE, { companyId: COMPANY });

  assert.equal(result.success, true);
  const ten = result.slots.find((s) => s.time === '10:00');
  const twenty = result.slots.find((s) => s.time === '20:00');

  // 10:00 is only offered by court A; 20:00 only by court B.
  assert.ok(ten, 'the own 10:00 slot must be offered');
  assert.equal(ten.availableCourts, 1);
  assert.equal(ten.totalCourts, 1);

  assert.ok(twenty, 'the general 20:00 slot must be offered');
  assert.equal(twenty.availableCourts, 1);
  assert.equal(twenty.totalCourts, 1);
});

test('without per-court slots the general capacity is preserved', async () => {
  resetState();

  const result = await getAvailableSlots(FUTURE_DATE, { companyId: COMPANY });

  const twenty = result.slots.find((s) => s.time === '20:00');
  assert.ok(twenty);
  assert.equal(twenty.availableCourts, 2);
  assert.equal(twenty.totalCourts, 2);
});

test('an occupied own slot removes it from the bot offer', async () => {
  resetState();
  state.slotDocs = [
    { _id: SLOT_G20, startTime: '20:00', endTime: '21:00', price: 25000, court: null },
    { _id: SLOT_A10, startTime: '10:00', endTime: '11:00', price: 25000, court: COURT_A },
  ];
  state.bookings = [{ timeSlot: SLOT_A10, court: COURT_A, isFixed: false }];

  const result = await getAvailableSlots(FUTURE_DATE, { companyId: COMPANY });

  assert.equal(
    result.slots.some((s) => s.time === '10:00'),
    false,
    'the fully booked own slot must not be offered',
  );
  assert.ok(result.slots.some((s) => s.time === '20:00'));
});
