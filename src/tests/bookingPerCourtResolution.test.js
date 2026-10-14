'use strict';

// Booking creation must resolve the slot WITHIN the chosen court's effective
// schedule (the same per-court override used by availability): a court with its
// own slots may only book its own times; a court without own slots books the
// general times; and INDIFERENTE only considers courts that actually offer the
// requested start time. Data access is stubbed at the model boundary.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { isPhoneExempt } = require('../services/appConfig.service');
const realSlotLockService = require('../services/slotLock.service');

const COMPANY = '64b0000000000000000000a1';
const COURT_A = '64b0000000000000000000ca'; // owns a 10:00 slot
const COURT_B = '64b0000000000000000000cb'; // no own slots -> general
const SLOT_G20 = 'slot-general-20';
const SLOT_A10 = 'slot-own-a-10';
const BOOKING_ID = '64b0000000000000000000c9';
const FUTURE_DATE = '2099-01-01';

const state = {
  bookings: [],
  fixed: [],
  lockedSlots: [],
  courts: [],
  slotDocs: [],
  createdBooking: null,
};

const resetState = () => {
  state.bookings = [];
  state.fixed = [];
  state.lockedSlots = [];
  state.courts = [
    { _id: COURT_A, name: 'Cancha 1', courtType: null, isActive: true },
    { _id: COURT_B, name: 'Cancha 2', courtType: null, isActive: true },
  ];
  state.slotDocs = [
    { _id: SLOT_G20, startTime: '20:00', endTime: '21:00', price: 25000, court: null, isActive: true },
    { _id: SLOT_A10, startTime: '10:00', endTime: '11:00', price: 20000, court: COURT_A, isActive: true },
  ];
  state.createdBooking = null;
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
  return true;
};

stubModule('../models/booking.model', {
  countDocuments: async () => 0,
  find: () => makeFindResult(state.bookings),
  findOne: async (filter = {}) =>
    state.bookings.find((booking) => {
      if (filter.court && String(booking.court) !== String(filter.court)) return false;
      if (filter.timeSlot && String(booking.timeSlot) !== String(filter.timeSlot)) return false;
      return true;
    }) || null,
  updateOne: async () => ({ matchedCount: 1 }),
  create: async (doc) => {
    const created = { _id: BOOKING_ID, ...doc };
    state.createdBooking = created;
    return created;
  },
});
stubModule('../models/court.model', {
  COURT_TYPES: ['Techada', 'VIP'],
  find: (filter = {}) => {
    let list = state.courts;
    if (filter.courtType) list = list.filter((c) => c.courtType === filter.courtType);
    return makeFindResult(list);
  },
  findOne: async (filter = {}) => {
    const nameFilter = filter.name;
    if (nameFilter && typeof nameFilter === 'object' && nameFilter.$regex) {
      const re = nameFilter.$regex;
      return state.courts.find((c) => re.test(c.name)) || null;
    }
    return state.courts[0] || null;
  },
});
stubModule('../models/timeSlot.model', {
  find: (filter = {}) => makeFindResult(state.slotDocs.filter((s) => slotMatches(s, filter))),
  findOne: async (filter = {}) => state.slotDocs.find((s) => slotMatches(s, filter)) || null,
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

const { createNewBooking } = require('../services/bookingService');

const book = (courtName, timeStr) =>
  createNewBooking({
    companyId: COMPANY,
    courtName,
    dateStr: FUTURE_DATE,
    timeStr,
    clientName: 'Ana',
    clientPhone: '5491100000000',
    clientWhatsappId: '5491100000000@c.us',
  });

// ── specific court ───────────────────────────────────────────────────────────

test('a court with own slots books its own time', async () => {
  resetState();

  const result = await book('Cancha 1', '10:00');

  assert.equal(result.success, true);
  assert.equal(String(state.createdBooking.timeSlot), SLOT_A10);
  assert.equal(String(state.createdBooking.court), COURT_A);
});

test('a court with own slots cannot book a general time it does not own', async () => {
  resetState();

  const result = await book('Cancha 1', '20:00');

  assert.equal(result.success, false);
  assert.equal(result.error, 'INVALID_TIME');
  assert.equal(state.createdBooking, null);
});

test('a court without own slots books the general slot', async () => {
  resetState();

  const result = await book('Cancha 2', '20:00');

  assert.equal(result.success, true);
  assert.equal(String(state.createdBooking.timeSlot), SLOT_G20);
  assert.equal(String(state.createdBooking.court), COURT_B);
});

test('a court without own slots cannot book another court own time', async () => {
  resetState();

  const result = await book('Cancha 2', '10:00');

  assert.equal(result.success, false);
  assert.equal(result.error, 'INVALID_TIME');
});

// ── INDIFERENTE ──────────────────────────────────────────────────────────────

test('INDIFERENTE only considers courts that offer the requested time', async () => {
  resetState();

  const result = await book('INDIFERENTE', '10:00');

  assert.equal(result.success, true);
  assert.equal(String(state.createdBooking.court), COURT_A);
  assert.equal(String(state.createdBooking.timeSlot), SLOT_A10);
});

test('INDIFERENTE picks the general-owning court for a general time', async () => {
  resetState();

  const result = await book('INDIFERENTE', '20:00');

  assert.equal(result.success, true);
  assert.equal(String(state.createdBooking.court), COURT_B);
  assert.equal(String(state.createdBooking.timeSlot), SLOT_G20);
});

test('INDIFERENTE returns BUSY when the only offering court is busy', async () => {
  resetState();
  state.bookings = [
    { court: COURT_A, timeSlot: SLOT_A10, date: new Date(`${FUTURE_DATE}T00:00:00Z`), status: 'confirmado' },
  ];

  const result = await book('INDIFERENTE', '10:00');

  assert.equal(result.success, false);
  assert.equal(result.error, 'BUSY');
  assert.equal(state.createdBooking, null);
});

test('INDIFERENTE returns INVALID_TIME when no court offers the time', async () => {
  resetState();
  state.slotDocs = state.slotDocs.filter((slot) => slot._id !== SLOT_A10);

  const result = await book('INDIFERENTE', '10:00');

  assert.equal(result.success, false);
  assert.equal(result.error, 'INVALID_TIME');
});

// ── regression: no per-court slots ───────────────────────────────────────────

test('without per-court slots a specific court still books the general slot', async () => {
  resetState();
  state.slotDocs = [state.slotDocs[0]]; // only the general 20:00

  const result = await book('Cancha 1', '20:00');

  assert.equal(result.success, true);
  assert.equal(String(state.createdBooking.timeSlot), SLOT_G20);
});
