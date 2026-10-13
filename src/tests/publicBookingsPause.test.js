'use strict';

// Public portal gate for the per-company "pause bookings" switch:
// while `bookingsPaused` is true the portal must still resolve the club info and
// the availability grid, but client booking creation and slot-lock acquisition
// are refused with 409 + Spanish copy. The admin path is a separate controller
// and is intentionally NOT covered here (it must stay enabled).
// Persistence, slot locks and WhatsApp side effects are replaced with fakes.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const COMPANY = '64b0000000000000000000a1';
const COURT_ID = '64b0000000000000000000c1';
const SLOT_ID = '64b0000000000000000000s1';
const BOOKING_ID = '64b0000000000000000000c3';
const PAUSED_MESSAGE = 'Las reservas están pausadas por el momento.';

const state = {
  bookingsPaused: false,
  createdBookings: [],
  acquireLockCalls: 0,
};

const resetState = () => {
  state.bookingsPaused = false;
  state.createdBookings = [];
  state.acquireLockCalls = 0;
};

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

appConfigService.getBookingsPaused = async () => state.bookingsPaused;
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

slotLockService.createMongooseSlotLockStore = () => ({
  deleteLocksForSlot: async () => {},
});
slotLockService.acquireSlotLock = async () => {
  state.acquireLockCalls += 1;
  return {
    ok: true,
    lock: { _id: 'lock-1' },
    expiresAt: new Date(Date.now() + 60_000),
  };
};

fixedTurnsService.materializeFixedBookingsForDate = async () => {};
bookingWhatsapp.sendBookingWhatsappConfirmation = async () => ({ ok: true });
fixedBookingService.findConflictingFixedForBooking = async () => null;
whatsappQueue.enqueueWhatsappCommand = async () => ({ command: { _id: 'cmd-x' } });
depositNotificationService.notifyDepositPending = async () => {};
whatsappRuntimeStateService.getWhatsappRuntimeState = async () => ({ phone: '5492622345473' });

const Company = require('../models/company.model');
const ClientAccount = require('../models/clientAccount.model');
const Court = require('../models/court.model');
const TimeSlot = require('../models/timeSlot.model');
const Booking = require('../models/booking.model');
const ClubClosure = require('../models/clubClosure.model');
const User = require('../models/user.model');

Company.findOne = async () => ({ _id: COMPANY, name: 'Club Demo', address: 'Calle 1', coverImage: '' });
ClientAccount.findById = async () => ({ _id: 'client-1', phone: '5491100000000' });
ClubClosure.findOne = async () => null;
User.findOne = async () => null;

const leanCourt = { _id: COURT_ID, name: 'Cancha 1', lean() { return Promise.resolve(this); } };
const leanSlot = {
  _id: SLOT_ID,
  startTime: '20:00',
  endTime: '21:00',
  price: 25000,
  lean() {
    return Promise.resolve(this);
  },
};
// findOne is awaited AND chained with `.lean()` by the slot-lock handler, so it
// must return a plain object exposing a lean() method.
Court.findOne = () => leanCourt;
TimeSlot.findOne = () => leanSlot;
// find is chained with `.sort(...)` before being awaited by getClubInfo.
Court.find = () => ({ sort: () => Promise.resolve([{ _id: COURT_ID, name: 'Cancha 1' }]) });
TimeSlot.find = () => ({
  sort: () =>
    Promise.resolve([
      { _id: SLOT_ID, startTime: '20:00', endTime: '21:00', price: 25000 },
    ]),
});

Booking.findOne = async () => null;
Booking.create = async (doc) => {
  state.createdBookings.push(doc);
  const created = { _id: BOOKING_ID, ...doc };
  return created;
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

const {
  createClientBooking,
  acquireSlotLockHandler,
  getClubInfo,
} = require('../controllers/public.controller');

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

const createBookingReq = (overrides = {}) => ({
  params: { slug: 'club' },
  clientUser: { id: 'client-1', companyId: COMPANY },
  body: { courtId: COURT_ID, slotId: SLOT_ID, date: '2099-01-02' },
  ...overrides,
});

const createLockReq = () => ({
  params: { slug: 'club' },
  body: {
    courtId: COURT_ID,
    slotId: SLOT_ID,
    date: '2099-01-02',
    holderId: 'holder-1',
  },
});

// ── createClientBooking ──────────────────────────────────────────────────────

test('createClientBooking refuses with 409 while bookings are paused', async () => {
  resetState();
  state.bookingsPaused = true;
  const res = createResponse();

  await createClientBooking(createBookingReq(), res);

  assert.equal(res.statusCode, 409);
  assert.equal(res.payload.success, false);
  assert.equal(res.payload.error, PAUSED_MESSAGE);
  assert.equal(state.createdBookings.length, 0, 'no booking may be persisted while paused');
});

test('createClientBooking succeeds when bookings are not paused (triangulation)', async () => {
  resetState();
  state.bookingsPaused = false;
  const res = createResponse();

  await createClientBooking(createBookingReq(), res);

  assert.equal(res.statusCode, 201);
  assert.equal(res.payload.success, true);
  assert.equal(state.createdBookings.length, 1, 'the booking is persisted when not paused');
});

// ── acquireSlotLockHandler ───────────────────────────────────────────────────

test('acquireSlotLockHandler refuses with 409 while bookings are paused', async () => {
  resetState();
  state.bookingsPaused = true;
  const res = createResponse();

  await acquireSlotLockHandler(createLockReq(), res);

  assert.equal(res.statusCode, 409);
  assert.equal(res.payload.success, false);
  assert.equal(res.payload.error, PAUSED_MESSAGE);
  assert.equal(state.acquireLockCalls, 0, 'no slot lock may be acquired while paused');
});

test('acquireSlotLockHandler acquires the lock when not paused (triangulation)', async () => {
  resetState();
  state.bookingsPaused = false;
  const res = createResponse();

  await acquireSlotLockHandler(createLockReq(), res);

  assert.equal(res.payload.success, true);
  assert.equal(res.payload.data.lockId, 'lock-1');
  assert.equal(state.acquireLockCalls, 1);
});

// ── getClubInfo ──────────────────────────────────────────────────────────────

test('getClubInfo exposes the bookingsPaused flag to the portal', async () => {
  resetState();
  state.bookingsPaused = true;
  const res = createResponse();

  await getClubInfo({ params: { slug: 'club' } }, res);

  assert.equal(res.statusCode, undefined);
  assert.equal(res.payload.data.club.bookingsPaused, true);
  assert.equal(res.payload.data.club.name, 'Club Demo');
});

test('getClubInfo reports bookingsPaused false by default (triangulation)', async () => {
  resetState();
  state.bookingsPaused = false;
  const res = createResponse();

  await getClubInfo({ params: { slug: 'club' } }, res);

  assert.equal(res.payload.data.club.bookingsPaused, false);
});
