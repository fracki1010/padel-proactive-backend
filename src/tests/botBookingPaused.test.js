'use strict';

// WhatsApp bot gate for the per-company "pause bookings" switch: while the club
// has `bookingsPaused` on, `createNewBooking` must refuse with the PAUSED error
// (mapped to Spanish copy by the reply builder) and must not persist a booking.
// When not paused the normal confirmado flow is unchanged (triangulation).
// Data access and external services are replaced with fakes.

const { test } = require('node:test');
const assert = require('node:assert/strict');

// Capture the REAL pure helper before the appConfig.service module is stubbed.
const { isPhoneExempt } = require('../services/appConfig.service');

const COMPANY = '64b0000000000000000000a1';
const COURT_ID = '64b0000000000000000000c1';
const SLOT_ID = '64b0000000000000000000s1';
const BOOKING_ID = '64b0000000000000000000c3';
const FUTURE_DATE = '2099-01-01';

const state = {
  bookingsPaused: false,
  createdBooking: null,
  adminNotifications: [],
};

const resetState = () => {
  state.bookingsPaused = false;
  state.createdBooking = null;
  state.adminNotifications = [];
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

const makeFindResult = (items) => {
  items.select = () => items;
  items.lean = async () => items;
  return items;
};

stubModule('../models/booking.model', {
  countDocuments: async () => 0,
  find: () => makeFindResult([]),
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
  find: async () => [],
  findOne: async () => ({ _id: COURT_ID, name: 'Cancha 1', courtType: null }),
});
stubModule('../models/timeSlot.model', {
  findOne: async () => ({
    _id: SLOT_ID,
    startTime: '20:00',
    endTime: '21:00',
    price: 25000,
  }),
});
stubModule('../models/user.model', { findOne: async () => null });
stubModule('../models/fixedBooking.model', {
  find: () => makeFindResult([]),
  findOne: async () => null,
});
stubModule('../services/fixedBooking.service', {
  findConflictingFixedForBooking: async () => null,
  getWeekdayFromDate: (value) =>
    (value instanceof Date ? value : new Date(value)).getUTCDay(),
});
const realSlotLockService = require('../services/slotLock.service');
stubModule('../services/slotLock.service', {
  buildForeignLockedKeys: realSlotLockService.buildForeignLockedKeys,
  createMongooseSlotLockStore: () => ({
    findActiveLocksForDate: async () => [],
  }),
});
stubModule('../models/admin.model', {
  find: () => ({ select: () => ({ lean: async () => [] }) }),
});
stubModule('../services/appConfig.service', {
  getBookingsPaused: async () => state.bookingsPaused,
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
stubModule('../services/fixedTurnsMaterialization.service', {
  materializeFixedBookingsForDate: async () => {},
});
stubModule('../services/notificationService', {
  sendAdminNotification: async (...args) => {
    state.adminNotifications.push(args);
  },
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

const { createNewBooking } = require('../services/bookingService');
const { buildBookingReplyText } = require('../handlers/messageHandler');

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

// ── createNewBooking paused gate ─────────────────────────────────────────────

test('createNewBooking refuses with PAUSED while bookings are paused', async () => {
  resetState();
  state.bookingsPaused = true;

  const result = await createBotBooking();

  assert.equal(result.success, false);
  assert.equal(result.error, 'PAUSED');
  assert.equal(state.createdBooking, null, 'no booking may be persisted while paused');
  assert.equal(state.adminNotifications.length, 0, 'admins are not notified for a refused booking');
});

test('createNewBooking still books when not paused (triangulation)', async () => {
  resetState();
  state.bookingsPaused = false;

  const result = await createBotBooking();

  assert.equal(result.success, true);
  assert.equal(state.createdBooking.status, 'confirmado');
  assert.equal(state.adminNotifications.length, 1, 'the new booking is still announced');
  assert.equal(result.data.courtName, 'Cancha 1');
  assert.equal(result.data.startTime, '20:00');
});

// ── reply builder PAUSED mapping ─────────────────────────────────────────────

test('buildBookingReplyText maps PAUSED to the Spanish pause message', () => {
  const reply = buildBookingReplyText(FUTURE_DATE, 'Ana', {
    success: false,
    error: 'PAUSED',
  });

  assert.match(reply, /pausadas/i);
  assert.match(reply, /podés ver la disponibilidad/i);
  assert.doesNotMatch(reply, /Reserva Confirmada/);
});