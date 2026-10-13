'use strict';

// Admin booking flow must stay fully enabled while the club has
// `bookingsPaused` on: the pause gate lives ONLY in the client-facing paths
// (public portal controller + WhatsApp bot service). This test proves the admin
// create path persists a booking even when getBookingsPaused() reports true.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const COMPANY = '64b0000000000000000000a1';
const COURT_ID = '64b0000000000000000000c1';
const SLOT_ID = '64b0000000000000000000s1';

const state = {
  created: null,
  adminNotifications: [],
};

const resetState = () => {
  state.created = null;
  state.adminNotifications = [];
};

// Patch service seams BEFORE requiring the controller so its destructured
// references capture the fakes.
const appConfigService = require('../services/appConfig.service');
appConfigService.getBookingsPaused = async () => true;

const fixedTurnsService = require('../services/fixedTurnsMaterialization.service');
const fixedBookingService = require('../services/fixedBooking.service');
const notificationService = require('../services/notificationService');
const whatsappQueue = require('../services/whatsappCommandQueue.service');

fixedTurnsService.materializeFixedBookingsForDate = async () => {};
fixedBookingService.findConflictingFixedForBooking = async () => null;
notificationService.sendAdminNotification = async (...args) => {
  state.adminNotifications.push(args);
};
whatsappQueue.enqueueWhatsappCommand = async () => ({ command: { _id: 'cmd-x' } });

const Court = require('../models/court.model');
const TimeSlot = require('../models/timeSlot.model');
const Booking = require('../models/booking.model');

Court.exists = async () => true;
TimeSlot.findOne = async () => ({ _id: SLOT_ID, startTime: '20:00', price: 25000 });
Booking.countDocuments = async () => 0;
Booking.findOne = async () => null;
Booking.create = async (doc) => {
  const raw = { _id: 'booking-admin-1', ...doc };
  state.created = raw;
  state.rawCourtId = doc.court;
  state.rawSlotId = doc.timeSlot;
  raw.populate = async () => {
    raw.court = { name: 'Cancha 1' };
    raw.timeSlot = { startTime: '20:00' };
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

const createReq = () => ({
  user: { role: 'admin', companyId: COMPANY, _id: 'admin-1' },
  body: {
    courtId: COURT_ID,
    slotId: SLOT_ID,
    date: '2099-01-03',
    clientName: 'Admin client',
    clientPhone: '5491111111111',
  },
});

test('admin createBooking persists a booking while bookings are paused', async () => {
  resetState();
  const res = createResponse();

  await createBooking(createReq(), res);

  assert.equal(res.statusCode, 201);
  assert.equal(res.payload.success, true);
  assert.ok(state.created, 'the admin booking must be persisted');
  assert.equal(state.rawCourtId, COURT_ID);
  assert.equal(state.rawSlotId, SLOT_ID);
  assert.equal(
    state.adminNotifications.length,
    1,
    'the admin is still notified about the new booking',
  );
});