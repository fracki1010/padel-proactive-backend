'use strict';

// Expiry sweeper tests: past-deadline unpaid deposits are cancelled (court
// freed) per enabled company, idempotently, with the client/admin notified.
// Persistence is replaced with an in-memory Booking model.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createInMemoryBookingModel } = require('./helpers/inMemoryBookingModel');

const COMPANY = '64b0000000000000000000a1';
const OTHER_COMPANY = '64b0000000000000000000b2';
const BOOKING_ID = '64b0000000000000000000c3';
const OTHER_BOOKING_ID = '64b0000000000000000000d4';

const expiredPending = (overrides = {}) => ({
  _id: BOOKING_ID,
  companyId: COMPANY,
  status: 'pendiente_seña',
  finalPrice: 25000,
  deposit: {
    required: true,
    amount: 5000,
    status: 'pendiente',
    expiresAt: new Date(Date.now() - 60 * 1000),
  },
  ...overrides,
});

const makeConfigModel = (companyIds) => ({
  find() {
    return {
      async select() {
        return companyIds.map((companyId) => ({ companyId }));
      },
    };
  },
});

const runSweep = (options) =>
  require('../services/depositExpiry.service').runDepositExpirySweep(options);

test('a sweep cancels past-deadline pending deposits and notifies once', async () => {
  const model = createInMemoryBookingModel([expiredPending()]);
  const notified = [];

  const result = await runSweep({
    bookingModel: model,
    configModel: makeConfigModel([COMPANY]),
    isMongoConnected: () => true,
    notifyExpired: async (payload) => notified.push(payload),
  });

  assert.equal(result.expiredCount, 1);
  assert.equal(model.bookings[0].status, 'cancelado');
  assert.equal(model.bookings[0].deposit.status, 'expirado');
  assert.equal(notified.length, 1);
  assert.equal(String(notified[0].booking._id), BOOKING_ID);
  assert.equal(String(notified[0].companyId), COMPANY);
});

test('the sweeper is idempotent and skips unexpired or paid holds', async () => {
  const model = createInMemoryBookingModel([
    expiredPending(),
    expiredPending({
      _id: OTHER_BOOKING_ID,
      status: 'reservado',
      deposit: {
        required: true,
        amount: 5000,
        status: 'pagado',
        expiresAt: new Date(Date.now() - 60 * 1000),
      },
    }),
  ]);

  const options = {
    bookingModel: model,
    configModel: makeConfigModel([COMPANY]),
    isMongoConnected: () => true,
    notifyExpired: async () => {},
  };

  const first = await runSweep(options);
  const second = await runSweep(options);

  assert.equal(first.expiredCount, 1);
  assert.equal(second.expiredCount, 0, 'a second sweep must not expire anything');
  assert.equal(model.bookings[0].status, 'cancelado');
  assert.equal(model.bookings[1].status, 'reservado', 'a paid booking must be untouched');
});

test('the sweeper only scans companies with deposits enabled', async () => {
  const model = createInMemoryBookingModel([
    expiredPending(),
    expiredPending({ _id: OTHER_BOOKING_ID, companyId: OTHER_COMPANY }),
  ]);

  const result = await runSweep({
    bookingModel: model,
    configModel: makeConfigModel([OTHER_COMPANY]),
    isMongoConnected: () => true,
    notifyExpired: async () => {},
  });

  assert.equal(result.expiredCount, 1);
  assert.equal(
    model.bookings[0].status,
    'pendiente_seña',
    'a booking of a non-enabled company must not be expired',
  );
  assert.equal(model.bookings[1].status, 'cancelado');
});

test('the sweeper is skipped when MongoDB is not connected', async () => {
  const model = createInMemoryBookingModel([expiredPending()]);

  const result = await runSweep({
    bookingModel: model,
    configModel: makeConfigModel([COMPANY]),
    isMongoConnected: () => false,
    notifyExpired: async () => {},
  });

  assert.equal(result.skipped, true);
  assert.equal(model.bookings[0].status, 'pendiente_seña');
});

test('apiServer wires the deposit expiry monitor at startup', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'apiServer.js'),
    'utf8',
  );
  assert.match(source, /startDepositExpiryMonitor/, 'apiServer must start the deposit monitor');
});
