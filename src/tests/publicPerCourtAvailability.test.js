'use strict';

// Public availability must honour the per-court override rule: a court with
// its OWN active slots ignores the general slots, and a court without own slots
// falls back to the general set. The models and side-effecting services are
// replaced with fakes; the controller and the real lock helpers run.

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-per-court';
process.env.PAYMENT_SECRET_KEY =
  process.env.PAYMENT_SECRET_KEY || 'c'.repeat(64);

const COMPANY = '64b0000000000000000000a1';
const COURT_A = '64b0000000000000000000ca';
const COURT_B = '64b0000000000000000000cb';
const SLOT_G20 = 'slot-general-20';
const SLOT_A10 = 'slot-own-a-10';

const state = {
  courts: [],
  slots: [],
  bookings: [],
};

const resetState = () => {
  state.courts = [
    { _id: COURT_A, name: 'Cancha 1' },
    { _id: COURT_B, name: 'Cancha 2' },
  ];
  state.slots = [
    { _id: SLOT_G20, startTime: '20:00', endTime: '21:00', court: null },
    { _id: SLOT_A10, startTime: '10:00', endTime: '11:00', court: COURT_A },
  ];
  state.bookings = [];
};

// Patch service seams BEFORE requiring the controller.
const slotLockService = require('../services/slotLock.service');
const fixedTurnsService = require('../services/fixedTurnsMaterialization.service');
const bookingWhatsapp = require('../services/bookingWhatsappConfirmation.service');
const fixedBookingService = require('../services/fixedBooking.service');
const whatsappQueue = require('../services/whatsappCommandQueue.service');
const depositNotificationService = require('../services/depositNotification.service');
const whatsappRuntimeStateService = require('../services/whatsappRuntimeState.service');
const appConfigService = require('../services/appConfig.service');

slotLockService.createMongooseSlotLockStore = () => ({
  findActiveLocksForDate: async () => [],
});
fixedTurnsService.materializeFixedBookingsForDate = async () => {};
bookingWhatsapp.sendBookingWhatsappConfirmation = async () => ({ ok: true });
fixedBookingService.findConflictingFixedForBooking = async () => null;
whatsappQueue.enqueueWhatsappCommand = async () => ({ command: { _id: 'cmd-x' } });
depositNotificationService.notifyDepositPending = async () => {};
whatsappRuntimeStateService.getWhatsappRuntimeState = async () => ({ phone: '' });
appConfigService.getBookingsPaused = async () => false;
appConfigService.getCancellationLockHours = async () => 2;

const Company = require('../models/company.model');
const Court = require('../models/court.model');
const TimeSlot = require('../models/timeSlot.model');
const Booking = require('../models/booking.model');
const ClubClosure = require('../models/clubClosure.model');
const FixedBooking = require('../models/fixedBooking.model');

Company.findOne = async () => ({ _id: COMPANY, name: 'Club Demo' });
ClubClosure.findOne = async () => null;
Court.find = () => ({ sort: () => Promise.resolve(state.courts) });
TimeSlot.find = () => ({ sort: () => Promise.resolve(state.slots) });
Booking.find = () => ({ select: () => Promise.resolve(state.bookings) });
FixedBooking.find = () => ({ select: () => Promise.resolve([]) });

const { getAvailability } = require('../controllers/public.controller');

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

const runAvailability = async () => {
  const res = createResponse();
  await getAvailability(
    { params: { slug: 'club' }, query: { date: '2099-01-02' } },
    res,
  );
  return res.payload;
};

const pairKey = (item) => `${item.courtId}_${item.slotId}`;

test('a court with own slots ignores the general set (override rule)', async () => {
  resetState();
  const body = await runAvailability();

  const keys = body.data.availability.map(pairKey).sort();
  assert.deepEqual(keys, [`${COURT_A}_${SLOT_A10}`, `${COURT_B}_${SLOT_G20}`]);
});

test('the availability response only exposes effective slots', async () => {
  resetState();
  const body = await runAvailability();

  const ids = body.data.slots.map((slot) => slot._id).sort();
  assert.deepEqual(ids, [SLOT_A10, SLOT_G20].sort());
  assert.equal(body.data.closed, false);
});

test('a booking on an own slot marks only that court+slot unavailable', async () => {
  resetState();
  state.bookings = [{ court: COURT_A, timeSlot: SLOT_A10 }];
  const body = await runAvailability();

  const ownPair = body.data.availability.find(
    (item) => item.courtId === COURT_A && item.slotId === SLOT_A10,
  );
  const generalPair = body.data.availability.find(
    (item) => item.courtId === COURT_B && item.slotId === SLOT_G20,
  );
  assert.equal(ownPair.available, false);
  assert.equal(generalPair.available, true);
});

test('when no court owns slots the cartesian product is preserved', async () => {
  resetState();
  state.slots = [
    { _id: SLOT_G20, startTime: '20:00', endTime: '21:00', court: null },
  ];
  const body = await runAvailability();

  const keys = body.data.availability.map(pairKey).sort();
  assert.deepEqual(keys, [`${COURT_A}_${SLOT_G20}`, `${COURT_B}_${SLOT_G20}`]);
  assert.ok(body.data.availability.every((item) => item.available === true));
});
