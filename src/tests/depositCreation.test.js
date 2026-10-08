'use strict';

// Portal booking creation + cancellation deposit tests:
// - create with deposits enabled -> `pendiente_seña` + deposit subdoc
// - create with deposits disabled -> unchanged `reservado`
// - cancel within policy -> a paid deposit is marked refundable (reembolsado)
// Persistence, slot locks, MP and notifications are replaced with fakes.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const COMPANY = '64b0000000000000000000a1';
const COURT_ID = '64b0000000000000000000c1';
const SLOT_ID = '64b0000000000000000000s1';
const BOOKING_ID = '64b0000000000000000000c3';

const state = {
  settings: { depositEnabled: true, depositAmount: 5000, holdMinutes: 15 },
  createdBooking: null,
  bookingCalls: [],
  pendingNotifications: [],
  confirmations: 0,
};

const resetState = () => {
  state.settings = { depositEnabled: true, depositAmount: 5000, holdMinutes: 15 };
  state.createdBooking = null;
  state.bookingCalls = [];
  state.pendingNotifications = [];
  state.confirmations = 0;
};

// Patch service seams BEFORE requiring the controller so its destructured
// references capture the fakes.
const appConfigService = require('../services/appConfig.service');
const slotLockService = require('../services/slotLock.service');
const fixedTurnsService = require('../services/fixedTurnsMaterialization.service');
const bookingWhatsapp = require('../services/bookingWhatsappConfirmation.service');
const bookingService = require('../services/bookingService');
const whatsappQueue = require('../services/whatsappCommandQueue.service');
const depositService = require('../services/deposit.service');
const depositNotificationService = require('../services/depositNotification.service');

appConfigService.getDepositSettings = async () => ({ ...state.settings });
appConfigService.getCancellationLockHours = async () => 2;
slotLockService.createMongooseSlotLockStore = () => ({
  deleteLocksForSlot: async () => {},
});
fixedTurnsService.materializeFixedBookingsForDate = async () => {};
bookingWhatsapp.sendBookingWhatsappConfirmation = async () => {
  state.confirmations += 1;
  return { ok: true };
};
bookingService.getCancellationContactPhone = async () => '';
whatsappQueue.enqueueWhatsappCommand = async () => ({ command: { _id: 'cmd-x' } });
depositService.buildDepositPaymentLink = async () => ({
  initPoint: 'https://mp/checkout/pref-x',
  preferenceId: 'pref-x',
  amount: 5000,
});
depositNotificationService.notifyDepositPending = async (payload) => {
  state.pendingNotifications.push(payload);
};

const Company = require('../models/company.model');
const ClientAccount = require('../models/clientAccount.model');
const Court = require('../models/court.model');
const TimeSlot = require('../models/timeSlot.model');
const Booking = require('../models/booking.model');
const ClubClosure = require('../models/clubClosure.model');
const User = require('../models/user.model');

const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

Company.findOne = async () => ({ _id: COMPANY });
ClientAccount.findById = async () => ({ _id: 'client-1', phone: '5491100000000' });
ClubClosure.findOne = async () => null;
User.findOne = async () => null;
Court.findOne = async () => ({ _id: COURT_ID, name: 'Cancha 1' });
Court.findById = () => ({ lean: async () => ({ _id: COURT_ID, name: 'Cancha 1' }) });
TimeSlot.findOne = async () => ({
  _id: SLOT_ID,
  startTime: '20:00',
  endTime: '21:00',
  price: 25000,
});
TimeSlot.findById = () => ({
  lean: async () => ({ _id: SLOT_ID, startTime: '20:00', endTime: '21:00', price: 25000 }),
});

Booking.findOne = async () => null;
Booking.create = async (doc) => {
  state.bookingCalls.push(doc);
  const created = { _id: BOOKING_ID, ...doc };
  state.createdBooking = created;
  return created;
};
Booking.findById = () => {
  const populated = {
    ...state.createdBooking,
    court: { _id: COURT_ID, name: 'Cancha 1' },
    timeSlot: { _id: SLOT_ID, startTime: '20:00', endTime: '21:00' },
    toObject() {
      return { ...this };
    },
  };
  const chain = {
    populate: () => chain,
    then: (resolve) => resolve(populated),
  };
  return chain;
};

const { createClientBooking, cancelMyBooking } = require('../controllers/public.controller');

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

const createReq = (overrides = {}) => ({
  params: { slug: 'club' },
  clientUser: { id: 'client-1', companyId: COMPANY },
  body: { courtId: COURT_ID, slotId: SLOT_ID, date: '2026-10-20' },
  ...overrides,
});

// ── create ───────────────────────────────────────────────────────────────────

test('a booking created with deposits enabled is pendiente_seña with deposit fields', async () => {
  resetState();
  const res = createResponse();

  await createClientBooking(createReq(), res);

  assert.equal(res.statusCode, 201);
  assert.equal(state.createdBooking.status, 'pendiente_seña');
  assert.equal(state.createdBooking.deposit.status, 'pendiente');
  assert.equal(state.createdBooking.deposit.amount, 5000);
  assert.equal(state.createdBooking.deposit.required, true);
  assert.ok(state.createdBooking.deposit.expiresAt instanceof Date);
  assert.equal(res.payload.data.deposit.amount, 5000);
  assert.equal(res.payload.data.payment.initPoint, 'https://mp/checkout/pref-x');
  assert.equal(state.pendingNotifications.length, 1, 'the pending deposit must be notified');
});

test('a booking created with deposits disabled keeps the reservado flow', async () => {
  resetState();
  state.settings = { depositEnabled: false, depositAmount: 0, holdMinutes: 15 };
  const res = createResponse();

  await createClientBooking(createReq(), res);

  assert.equal(res.statusCode, 201);
  assert.equal(state.createdBooking.status, 'reservado');
  assert.equal(state.createdBooking.deposit, undefined);
  assert.equal(state.confirmations, 1, 'the classic confirmation is still sent');
  assert.equal(state.pendingNotifications.length, 0);
});

// ── cancel ───────────────────────────────────────────────────────────────────

test('cancelling a booking with a paid deposit marks it refundable', async () => {
  resetState();
  const booking = {
    _id: BOOKING_ID,
    companyId: COMPANY,
    status: 'reservado',
    date: futureDate,
    timeSlot: SLOT_ID,
    court: COURT_ID,
    clientName: 'Ana',
    deposit: { status: 'pagado', amount: 5000, refundable: false },
    async save() {
      this.saved = true;
      return this;
    },
  };
  Booking.findOne = async () => booking;

  const res = createResponse();
  await cancelMyBooking({ params: { slug: 'club', id: BOOKING_ID }, clientUser: { id: 'client-1' } }, res);

  assert.equal(res.payload.success, true);
  assert.equal(booking.status, 'cancelado');
  assert.equal(booking.deposit.status, 'refund_pending');
  assert.equal(booking.deposit.refundable, true);
  assert.equal(booking.saved, true);
});
