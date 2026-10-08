'use strict';

// WhatsApp bot booking creation + deposit (seña) plumbing:
// - deposits enabled -> booking is created as `pendiente_seña` with the fixed
//   server-side deposit amount and paymentStatus `pendiente`, a Checkout Pro
//   link is derived (the REAL `buildDepositPaymentLink`) and the pending deposit
//   is notified ADMIN-only (the bot chat reply carries the link, so no duplicate
//   client WhatsApp message)
// - deposits disabled -> unchanged `confirmado` flow (regression)
// - MercadoPago failure -> booking still created, link is best-effort
//
// Data access and external services are replaced with fakes so no database,
// queue or MercadoPago network call happens. Only the MercadoPago HTTP boundary
// is faked; the deposit link builder under test is the real one.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const COMPANY = '64b0000000000000000000a1';
const COURT_ID = '64b0000000000000000000c1';
const SLOT_ID = '64b0000000000000000000s1';
const BOOKING_ID = '64b0000000000000000000c3';
const FUTURE_DATE = '2099-01-01';

const state = {
  settings: { depositEnabled: true, depositAmount: 5000, holdMinutes: 15 },
  createdBooking: null,
  preferenceCalls: [],
  linkShouldThrow: false,
  pendingNotifications: [],
  adminNotifications: [],
};

const resetState = () => {
  state.settings = { depositEnabled: true, depositAmount: 5000, holdMinutes: 15 };
  state.createdBooking = null;
  state.preferenceCalls = [];
  state.linkShouldThrow = false;
  state.pendingNotifications = [];
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

// `Booking.find` is used both awaited (busy bookings) and chained with
// `.select().lean()` (same-client slot probe); the array satisfies both.
const makeFindResult = (items) => {
  items.select = () => items;
  items.lean = async () => items;
  return items;
};

// Inject the model seams BEFORE requiring the real deposit.service so its
// module-level `Booking` binding and the stubbed MercadoPago client are used.
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
stubModule('../models/admin.model', {
  find: () => ({ select: () => ({ lean: async () => [] }) }),
});

// Fake ONLY the MercadoPago HTTP boundary; the real `buildDepositPaymentLink`
// runs and is exercised below.
stubModule('../services/mercadopago.service', {
  createDepositPreference: async (payload) => {
    state.preferenceCalls.push(payload);
    if (state.linkShouldThrow) throw new Error('MercadoPago unavailable');
    return {
      preferenceId: 'pref-x',
      initPoint: 'https://mp/checkout/pref-x',
      sandboxInitPoint: '',
    };
  },
});

stubModule('../services/appConfig.service', {
  getDepositSettings: async () => ({ ...state.settings }),
  getCancellationLockHours: async () => 0,
  getPenaltyLimit: async () => 2,
  getPenaltySystemEnabled: async () => false,
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
  notifyDepositPending: async (payload) => {
    state.pendingNotifications.push(payload);
  },
});
stubModule('../services/whatsappCommandQueue.service', {
  COMMAND_TYPES: {
    SEND_MESSAGE: 'SEND_MESSAGE',
    NOTIFY_CANCELLATION_GROUP: 'NOTIFY_CANCELLATION_GROUP',
  },
  enqueueWhatsappCommand: async () => ({ command: { _id: 'cmd-x' } }),
});

// Real `buildDepositFields` and `buildDepositPaymentLink`; only the cancel
// refund helper is stubbed (unused here).
const realDepositService = require('../services/deposit.service');
stubModule('../services/deposit.service', {
  buildDepositFields: realDepositService.buildDepositFields,
  buildDepositPaymentLink: realDepositService.buildDepositPaymentLink,
  markRefundableOnCancel: () => ({ refundable: false, deposit: null }),
});

const { createNewBooking } = require('../services/bookingService');

const createBotBooking = () =>
  createNewBooking({
    companyId: COMPANY,
    courtName: 'Cancha 1',
    dateStr: FUTURE_DATE,
    timeStr: '20:00',
    clientName: 'Ana',
    clientPhone: '5491100000000',
    clientWhatsappId: '5491100000000@c.us',
  });

test('bot booking with deposits enabled is pendiente_seña with a payment link', async () => {
  resetState();

  const result = await createBotBooking();

  assert.equal(result.success, true);
  assert.equal(state.createdBooking.status, 'pendiente_seña');
  assert.equal(state.createdBooking.paymentStatus, 'pendiente');
  assert.equal(state.createdBooking.deposit.status, 'pendiente');
  assert.equal(state.createdBooking.deposit.amount, 5000);
  assert.equal(state.createdBooking.deposit.required, true);
  assert.ok(
    state.createdBooking.deposit.expiresAt instanceof Date,
    'the deposit must carry an expiry for the hold',
  );

  assert.equal(result.data.deposit.amount, 5000);
  assert.equal(result.data.deposit.initPoint, 'https://mp/checkout/pref-x');
  assert.ok(result.data.deposit.expiresAt instanceof Date);

  // SUGGESTION 6: the REAL `buildDepositPaymentLink` ran end-to-end against the
  // in-memory booking and handed the right shape to the MercadoPago boundary.
  assert.equal(state.preferenceCalls.length, 1, 'the Checkout Pro preference must be built once');
  const preferencePayload = state.preferenceCalls[0];
  assert.equal(String(preferencePayload.booking._id), BOOKING_ID);
  assert.equal(preferencePayload.booking.status, 'pendiente_seña');
  assert.equal(preferencePayload.depositAmount, 5000);
  assert.equal(preferencePayload.companyId, COMPANY);
  assert.ok(
    preferencePayload.expiresAt instanceof Date,
    'the hold expiry must ride to the MercadoPago preference',
  );
  assert.equal(
    preferencePayload.expiresAt.getTime(),
    state.createdBooking.deposit.expiresAt.getTime(),
  );

  assert.equal(state.pendingNotifications.length, 1, 'the pending deposit must be notified');
  assert.equal(state.pendingNotifications[0].initPoint, 'https://mp/checkout/pref-x');
  assert.equal(
    state.pendingNotifications[0].notifyClient,
    false,
    'the bot chat reply carries the link, so the client message is skipped',
  );
});

test('bot booking with deposits disabled keeps the confirmado flow', async () => {
  resetState();
  state.settings = { depositEnabled: false, depositAmount: 0, holdMinutes: 15 };

  const result = await createBotBooking();

  assert.equal(result.success, true);
  assert.equal(state.createdBooking.status, 'confirmado');
  assert.equal(state.createdBooking.paymentStatus, undefined);
  assert.equal(state.createdBooking.deposit, undefined);
  assert.equal(result.data.deposit, undefined);
  assert.equal(state.preferenceCalls.length, 0);
  assert.equal(state.pendingNotifications.length, 0);
  assert.equal(state.adminNotifications.length, 1, 'the new booking is still announced to admins');
});

test('MercadoPago failure still creates the pending booking (best-effort link)', async () => {
  resetState();
  state.linkShouldThrow = true;

  const result = await createBotBooking();

  assert.equal(result.success, true);
  assert.equal(state.createdBooking.status, 'pendiente_seña');
  assert.equal(state.createdBooking.paymentStatus, 'pendiente');
  assert.equal(state.createdBooking.deposit.amount, 5000);
  assert.equal(result.data.deposit.initPoint, '');
  assert.equal(
    state.pendingNotifications.length,
    1,
    'the pending deposit is still notified (without a link)',
  );
  assert.equal(state.pendingNotifications[0].initPoint, '');
  assert.equal(state.pendingNotifications[0].notifyClient, false);
});
