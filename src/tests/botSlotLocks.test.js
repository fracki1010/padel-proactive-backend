'use strict';

// WhatsApp bot must respect ACTIVE portal slot locks:
// - getAvailableSlots excludes a locked court+slot (and counts it toward the
//   slot capacity like a fixed turn)
// - createNewBooking with a specific court on a locked slot -> BUSY
// - createNewBooking with INDIFERENTE skips locked courts
// - expired locks block nothing (deterministic: locked docs carry far-future /
//   far-past expiresAt, so the real `buildForeignLockedKeys` filter decides)
//
// Data access is stubbed at the model boundary like the deposit tests; only the
// real slot-lock helpers (`buildForeignLockedKeys`) and the real booking
// service run. No database, queue or network call happens.

const { test } = require('node:test');
const assert = require('node:assert/strict');

// Capture the REAL pure helpers before the service module is stubbed.
const { isPhoneExempt } = require('../services/appConfig.service');
const realSlotLockService = require('../services/slotLock.service');

const COMPANY = '64b0000000000000000000a1';
const COURT_A = '64b0000000000000000000c1'; // Cancha 1
const COURT_B = '64b0000000000000000000c2'; // Cancha 2
const SLOT_20 = '64b0000000000000000000s1'; // 20:00
const SLOT_21 = '64b0000000000000000000s2'; // 21:00
const BOOKING_ID = '64b0000000000000000000c3';
const FUTURE_DATE = '2099-01-01';
const FAR_FUTURE = new Date('2099-12-31T23:59:59.000Z'); // always active
const FAR_PAST = new Date('2001-01-01T00:00:00.000Z'); // always expired

const state = {
  bookings: [],
  fixed: [],
  lockedSlots: [],
  courts: [],
  slotDocs: [],
  specificCourt: null,
  createdBooking: null,
};

const resetState = () => {
  state.bookings = [];
  state.fixed = [];
  state.lockedSlots = [];
  state.courts = [
    { _id: COURT_A, name: 'Cancha 1', courtType: null },
    { _id: COURT_B, name: 'Cancha 2', courtType: 'Techada' },
  ];
  state.slotDocs = [
    { _id: SLOT_20, startTime: '20:00', endTime: '21:00', price: 25000 },
    { _id: SLOT_21, startTime: '21:00', endTime: '22:00', price: 25000 },
  ];
  state.specificCourt = { _id: COURT_A, name: 'Cancha 1', courtType: null };
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

// Chainable fake: `.select()`, `.lean()` and `.sort()` all resolve to the same
// array so awaited model queries behave like the real Mongoose chain.
const makeFindResult = (items, methods = ['select', 'lean', 'sort']) => {
  for (const m of methods) items[m] = () => items;
  return items;
};

stubModule('../models/booking.model', {
  countDocuments: async () => 0,
  find: () => makeFindResult(state.bookings),
  findOne: async () => null,
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
    const list = filter.courtType
      ? state.courts.filter((c) => c.courtType === filter.courtType)
      : state.courts;
    return makeFindResult(list);
  },
  findOne: async () => state.specificCourt,
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
stubModule('../services/notificationService', {
  sendAdminNotification: async () => {},
});
stubModule('../services/depositNotification.service', {
  notifyDepositPending: async () => {},
});
stubModule('../services/whatsappCommandQueue.service', {
  COMMAND_TYPES: {
    SEND_MESSAGE: 'SEND_MESSAGE',
    NOTIFY_CANCELLATION_GROUP: 'NOTIFY_CANCELLATION_GROUP',
  },
  enqueueWhatsappCommand: async () => ({ command: { _id: 'cmd-x' } }),
});
// Deposits are disabled in every test here, so these are never called; they
// exist only so the destructured imports in bookingService resolve.
stubModule('../services/deposit.service', {
  buildDepositFields: () => ({}),
  buildDepositPaymentLink: async () => ({ initPoint: '' }),
  markRefundableOnCancel: () => ({ refundable: false, deposit: null }),
});

const { createNewBooking, getAvailableSlots } = require('../services/bookingService');

const createBotBooking = (overrides = {}) =>
  createNewBooking({
    companyId: COMPANY,
    courtName: 'Cancha 1',
    dateStr: FUTURE_DATE,
    timeStr: '20:00',
    clientName: 'Ana',
    clientPhone: '5491100000000',
    clientWhatsappId: '5491100000000@c.us',
    ...overrides,
  });

const lock = ({ courtId = COURT_A, slotId = SLOT_20, expiresAt = FAR_FUTURE } = {}) => ({
  courtId,
  slotId,
  holderId: 'portal-holder-1',
  expiresAt,
});

// ── getAvailableSlots ─────────────────────────────────────────────────────────

test('getAvailableSlots excludes a locked court+slot from the available courts', async () => {
  resetState();
  state.lockedSlots = [lock()]; // Cancha 1 @ 20:00 locked

  const result = await getAvailableSlots(FUTURE_DATE, { companyId: COMPANY });

  assert.equal(result.success, true);
  const slot20 = result.slots.find((s) => s.time === '20:00');
  assert.ok(slot20, '20:00 must still be offered (court B is free)');
  assert.equal(slot20.availableCourts, 1, 'the locked court is subtracted from available');
  assert.equal(slot20.totalCourts, 2);
});

test('getAvailableSlots drops the slot when every court is locked (capacity like fixed turns)', async () => {
  resetState();
  state.lockedSlots = [
    lock({ courtId: COURT_A }),
    lock({ courtId: COURT_B }),
  ];

  const result = await getAvailableSlots(FUTURE_DATE, { companyId: COMPANY });

  assert.equal(result.success, true);
  assert.equal(
    result.slots.some((s) => s.time === '20:00'),
    false,
    'a slot fully held by locks must not be offered',
  );
});

test('getAvailableSlots ignores expired locks', async () => {
  resetState();
  state.lockedSlots = [lock({ expiresAt: FAR_PAST })];

  const result = await getAvailableSlots(FUTURE_DATE, { companyId: COMPANY });

  assert.equal(result.success, true);
  const slot20 = result.slots.find((s) => s.time === '20:00');
  assert.ok(slot20);
  assert.equal(slot20.availableCourts, 2, 'an expired lock blocks nothing');
});

// ── createNewBooking ──────────────────────────────────────────────────────────

test('createNewBooking on a specific locked court+slot returns BUSY', async () => {
  resetState();
  state.lockedSlots = [lock({ courtId: COURT_A, slotId: SLOT_20 })];

  const result = await createBotBooking({ courtName: 'Cancha 1' });

  assert.deepEqual(result, { success: false, error: 'BUSY' });
  assert.equal(state.createdBooking, null, 'no booking is persisted');
});

test('createNewBooking with INDIFERENTE skips the locked court', async () => {
  resetState();
  state.lockedSlots = [lock({ courtId: COURT_A, slotId: SLOT_20 })];

  const result = await createBotBooking({ courtName: 'INDIFERENTE' });

  assert.equal(result.success, true);
  assert.equal(
    String(state.createdBooking.court),
    COURT_B,
    'the free court is picked instead of the locked one',
  );
});

test('createNewBooking with INDIFERENTE returns BUSY when every court is locked', async () => {
  resetState();
  state.lockedSlots = [
    lock({ courtId: COURT_A, slotId: SLOT_20 }),
    lock({ courtId: COURT_B, slotId: SLOT_20 }),
  ];

  const result = await createBotBooking({ courtName: 'INDIFERENTE' });

  assert.deepEqual(result, { success: false, error: 'BUSY' });
  assert.equal(state.createdBooking, null);
});

test('createNewBooking ignores an expired lock on the specific court', async () => {
  resetState();
  state.lockedSlots = [lock({ courtId: COURT_A, slotId: SLOT_20, expiresAt: FAR_PAST })];

  const result = await createBotBooking({ courtName: 'Cancha 1' });

  assert.equal(result.success, true);
  assert.equal(String(state.createdBooking.court), COURT_A);
});