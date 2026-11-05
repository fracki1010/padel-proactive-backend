'use strict';

// ClubClosure is stored as an inclusive YYYY-MM-DD range (startDate/endDate).
// The public availability and booking-creation paths used to query a
// nonexistent `date` field, so closures never matched and the club stayed open.
// These regression tests exercise the real controller against hand-rolled model
// doubles whose ClubClosure.findOne honours the operator semantics the handler
// sends: a legacy `{ date }` filter matches nothing, while the inclusive range
// filter matches the stored strings.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const COMPANY = '64b0000000000000000000a1';
const COURT_ID = '64b0000000000000000000c1';
const SLOT_ID = '64b0000000000000000000d1';
const BOOKING_ID = '64b0000000000000000000b1';
const CLOSURE_ID = '64b0000000000000000000e1';

const state = {
  closures: [],
  createdBookings: [],
  materializeCalls: 0,
};

const resetState = () => {
  state.closures = [
    {
      _id: CLOSURE_ID,
      companyId: COMPANY,
      startDate: '2099-01-10',
      endDate: '2099-01-12',
      reason: 'Mantenimiento',
    },
  ];
  state.createdBookings = [];
  state.materializeCalls = 0;
};

const toDateOnly = (value) => {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString().slice(0, 10);
  }
  return String(value);
};

const matchesFilter = (doc, filter = {}) =>
  Object.entries(filter).every(([key, value]) => {
    if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
      if (Object.prototype.hasOwnProperty.call(value, '$lte')) {
        return toDateOnly(doc[key]) <= toDateOnly(value.$lte);
      }
      if (Object.prototype.hasOwnProperty.call(value, '$gte')) {
        return toDateOnly(doc[key]) >= toDateOnly(value.$gte);
      }
      return true;
    }
    return toDateOnly(doc[key]) === toDateOnly(value);
  });

// Patch service seams BEFORE requiring the controller so its destructured
// references capture the fakes.
const appConfigService = require('../services/appConfig.service');
const slotLockService = require('../services/slotLock.service');
const fixedTurnsService = require('../services/fixedTurnsMaterialization.service');
const bookingWhatsapp = require('../services/bookingWhatsappConfirmation.service');
const fixedBookingService = require('../services/fixedBooking.service');
const whatsappQueue = require('../services/whatsappCommandQueue.service');
const depositNotificationService = require('../services/depositNotification.service');
const whatsappRuntimeStateService = require('../services/whatsappRuntimeState.service');

appConfigService.getBookingsPaused = async () => false;
appConfigService.getDepositSettings = async () => ({
  depositEnabled: false,
  depositAmount: 0,
  holdMinutes: 15,
  depositExemptPhones: [],
  depositMethod: 'transfer',
  depositAlias: '',
  depositCbu: '',
  depositHolder: '',
});
appConfigService.getCancellationLockHours = async () => 2;
appConfigService.isPhoneExempt = () => false;

slotLockService.createMongooseSlotLockStore = () => ({
  findActiveLocksForDate: async () => [],
  deleteLocksForSlot: async () => {},
});
fixedTurnsService.materializeFixedBookingsForDate = async () => {
  state.materializeCalls += 1;
};
bookingWhatsapp.sendBookingWhatsappConfirmation = async () => ({ ok: true });
fixedBookingService.findConflictingFixedForBooking = async () => null;
whatsappQueue.enqueueWhatsappCommand = async () => ({ command: { _id: 'cmd-x' } });
depositNotificationService.notifyDepositPending = async () => {};
whatsappRuntimeStateService.getWhatsappRuntimeState = async () => ({ phone: '' });

const Company = require('../models/company.model');
const Court = require('../models/court.model');
const TimeSlot = require('../models/timeSlot.model');
const Booking = require('../models/booking.model');
const ClubClosure = require('../models/clubClosure.model');
const FixedBooking = require('../models/fixedBooking.model');
const ClientAccount = require('../models/clientAccount.model');
const User = require('../models/user.model');

Company.findOne = async () => ({ _id: COMPANY, name: 'Club Demo' });
ClientAccount.findById = async () => ({
  _id: 'client-1',
  name: 'Ana',
  phone: '5491100000000',
});
User.findOne = async () => null;

Court.findOne = async () => ({ _id: COURT_ID, name: 'Cancha 1' });
TimeSlot.findOne = async () => ({
  _id: SLOT_ID,
  startTime: '20:00',
  endTime: '21:00',
  price: 25000,
});
Court.find = () => ({ sort: () => Promise.resolve([{ _id: COURT_ID, name: 'Cancha 1' }]) });
TimeSlot.find = () => ({
  sort: () =>
    Promise.resolve([
      { _id: SLOT_ID, startTime: '20:00', endTime: '21:00', price: 25000 },
    ]),
});
Booking.find = () => ({ select: () => Promise.resolve([]) });
FixedBooking.find = () => ({ select: () => Promise.resolve([]) });

Booking.findOne = async () => null;
Booking.create = async (doc) => {
  state.createdBookings.push(doc);
  return { _id: BOOKING_ID, ...doc };
};
Booking.findById = () => {
  const populated = {
    ...(state.createdBookings[state.createdBookings.length - 1] || {}),
    _id: BOOKING_ID,
    court: { _id: COURT_ID, name: 'Cancha 1' },
    timeSlot: { _id: SLOT_ID, startTime: '20:00', endTime: '21:00' },
    toObject() {
      return { ...this };
    },
  };
  const chain = { populate: () => chain, then: (resolve) => resolve(populated) };
  return chain;
};

// The regression lives here: `date` is not a stored field, so the legacy
// filter must match nothing. `$lte`/`$gte` compare the stored date strings.
ClubClosure.findOne = async (filter = {}) =>
  state.closures.find((doc) => matchesFilter(doc, filter)) || null;

const { getAvailability, createClientBooking } = require('../controllers/public.controller');

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

const runAvailability = async (date) => {
  const res = createResponse();
  await getAvailability({ params: { slug: 'club' }, query: { date } }, res);
  return res;
};

const createBookingReq = (date) => ({
  params: { slug: 'club' },
  clientUser: { id: 'client-1', companyId: COMPANY },
  body: { courtId: COURT_ID, slotId: SLOT_ID, date },
});

const runBooking = async (date) => {
  const res = createResponse();
  await createClientBooking(createBookingReq(date), res);
  return res;
};

// ── getAvailability ──────────────────────────────────────────────────────────

test('availability blocks a closure on its startDate (inclusive)', async () => {
  resetState();
  const res = await runAvailability('2099-01-10');

  assert.equal(res.statusCode, undefined);
  assert.equal(res.payload.success, true);
  assert.equal(res.payload.data.closed, true);
  assert.equal(res.payload.data.closureReason, 'Mantenimiento');
  assert.deepEqual(res.payload.data.courts, []);
  assert.deepEqual(res.payload.data.slots, []);
  assert.deepEqual(res.payload.data.availability, []);
});

test('availability blocks a closure on its endDate (inclusive)', async () => {
  resetState();
  const res = await runAvailability('2099-01-12');

  assert.equal(res.payload.data.closed, true);
  assert.equal(res.payload.data.closureReason, 'Mantenimiento');
});

test('availability stays open on a date outside the closure range', async () => {
  resetState();
  const res = await runAvailability('2099-01-13');

  assert.equal(res.payload.success, true);
  assert.equal(res.payload.data.closed, false);
  assert.equal(res.payload.data.availability.length, 1);
});

// ── createClientBooking ──────────────────────────────────────────────────────

test('booking creation returns 409 inside the closure and writes no Booking', async () => {
  resetState();
  const res = await runBooking('2099-01-11');

  assert.equal(res.statusCode, 409);
  assert.equal(res.payload.success, false);
  assert.equal(res.payload.error, 'El club está cerrado ese día');
  assert.equal(state.createdBookings.length, 0, 'no booking may be persisted on a closed day');
  assert.equal(
    state.materializeCalls,
    0,
    'fixed bookings must not be materialized on a closed day',
  );
});

test('booking creation succeeds outside the closure (triangulation)', async () => {
  resetState();
  const res = await runBooking('2099-01-13');

  assert.equal(res.statusCode, 201);
  assert.equal(res.payload.success, true);
  assert.equal(state.createdBookings.length, 1);
});
