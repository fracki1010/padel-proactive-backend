'use strict';

// WARNING 6: a paid seña cancelled through the bot or the admin panel must be
// flagged for refund (refund_pending + refundable) — not only the portal path.
// Service seams are patched before the modules under test are required.

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-cancel-refund';

const COMPANY = '64b0000000000000000000a1';
const COURT_ID = '64b0000000000000000000c1';
const SLOT_ID = '64b0000000000000000000s1';
const BOOKING_ID = '64b0000000000000000000c3';
const CLIENT_PHONE = '5491100000000';

// ── Patch seams before requiring the modules under test ──────────────────────

const appConfigService = require('../services/appConfig.service');
const notificationService = require('../services/notificationService');
const whatsappQueue = require('../services/whatsappCommandQueue.service');

appConfigService.getCancellationLockHours = async () => 0;
appConfigService.getPenaltyLimit = async () => 3;
appConfigService.getPenaltySystemEnabled = async () => false;
notificationService.sendAdminNotification = async () => ({ queuedCount: 0 });
whatsappQueue.enqueueWhatsappCommand = async () => ({ command: { _id: 'cmd-1' } });

const Booking = require('../models/booking.model');
const TimeSlot = require('../models/timeSlot.model');
const User = require('../models/user.model');
const Court = require('../models/court.model');

const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

const paidBooking = (overrides = {}) => ({
  _id: BOOKING_ID,
  companyId: COMPANY,
  clientName: 'Ana',
  clientPhone: CLIENT_PHONE,
  status: 'reservado',
  date: futureDate,
  timeSlot: SLOT_ID,
  court: COURT_ID,
  deposit: { status: 'pagado', amount: 5000, refundable: false },
  async save() {
    this.saved = true;
    return this;
  },
  ...overrides,
});

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

// ── Bot cancel (bookingService.cancelBooking) ────────────────────────────────

test('the bot cancel path flags a paid deposit as refund_pending', async () => {
  const bookingService = require('../services/bookingService');
  const booking = paidBooking();

  TimeSlot.findOne = async () => ({ _id: SLOT_ID, startTime: '20:00' });
  User.findOne = async () => null;
  Court.findById = () => ({ select: () => ({ lean: async () => ({ name: 'Cancha 1' }) }) });
  Booking.find = async () => [booking];

  const result = await bookingService.cancelBooking({
    companyId: COMPANY,
    clientPhone: CLIENT_PHONE,
    dateStr: '2026-10-20',
    timeStr: '20:00',
  });

  assert.equal(result.success, true);
  assert.equal(booking.status, 'cancelado');
  assert.equal(booking.deposit.status, 'refund_pending');
  assert.equal(booking.deposit.refundable, true);
  assert.equal(booking.saved, true);
});

// ── Admin update (booking.controller.updateBooking) ──────────────────────────

test('the admin cancel path flags a paid deposit as refund_pending', async () => {
  const controller = require('../controllers/booking.controller');
  const previousBooking = paidBooking({ deposit: { status: 'pagado', amount: 5000, refundable: false } });
  const updatedBooking = paidBooking({ status: 'cancelado' });
  const updateCalls = [];

  Booking.findOne = () => ({ populate: async () => previousBooking });
  Booking.findOneAndUpdate = () => ({ populate: async () => updatedBooking });
  Booking.updateOne = async (filter, update) => {
    updateCalls.push({ filter, update });
    return { matchedCount: 1, modifiedCount: 1 };
  };
  User.findOne = async () => null;

  const req = {
    params: { id: BOOKING_ID },
    body: { status: 'cancelado' },
    user: { role: 'admin', companyId: COMPANY, _id: 'admin-1' },
  };
  const res = createResponse();

  await controller.updateBooking(req, res);

  assert.equal(res.payload.success, true);
  assert.equal(updateCalls.length, 1, 'the refund flag must be persisted');
  assert.equal(updateCalls[0].update.$set.deposit.status, 'refund_pending');
  assert.equal(updateCalls[0].update.$set.deposit.refundable, true);
  assert.equal(updatedBooking.deposit.status, 'refund_pending');
});
