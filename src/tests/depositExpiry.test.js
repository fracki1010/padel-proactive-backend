'use strict';

// Expiry sweeper tests: past-deadline unpaid deposits are cancelled (court
// freed) for ANY company — including clubs that have since disabled deposits —
// idempotently, in bounded batches, with the client/admin notified. A hung
// notification must not stall the sweeper forever. Persistence is replaced with
// an in-memory Booking model.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  createInMemoryBookingModel,
  matches,
} = require('./helpers/inMemoryBookingModel');

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

const runSweep = (options) =>
  require('../services/depositExpiry.service').runDepositExpirySweep(options);

test('a sweep cancels past-deadline pending deposits and notifies once', async () => {
  const model = createInMemoryBookingModel([expiredPending()]);
  const notified = [];

  const result = await runSweep({
    bookingModel: model,
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

test('the sweeper expires outstanding holds regardless of a company disabling deposits (WARNING 5)', async () => {
  // The booking belongs to a company whose config no longer has deposits
  // enabled; a global sweep must still free the held court.
  const model = createInMemoryBookingModel([expiredPending({ companyId: OTHER_COMPANY })]);

  const result = await runSweep({
    bookingModel: model,
    isMongoConnected: () => true,
    notifyExpired: async () => {},
  });

  assert.equal(result.expiredCount, 1);
  assert.equal(model.bookings[0].status, 'cancelado');
});

test('the sweeper bounds each scan with a batch limit (SUGGESTION 10)', async () => {
  const base = createInMemoryBookingModel([expiredPending()]);
  const limits = [];
  base.find = (filter = {}) => {
    const candidates = base.bookings
      .filter((booking) => matches(booking, filter))
      .map((booking) => ({ ...booking }));
    const chain = {
      limit(value) {
        limits.push(value);
        return chain;
      },
      then: (resolve) => resolve(candidates),
    };
    return chain;
  };

  const result = await runSweep({
    bookingModel: base,
    limit: 25,
    isMongoConnected: () => true,
    notifyExpired: async () => {},
  });

  assert.equal(result.expiredCount, 1);
  assert.deepEqual(limits, [25], 'the DB query must be bounded');
});

test('the sweeper is skipped when MongoDB is not connected', async () => {
  const model = createInMemoryBookingModel([expiredPending()]);

  const result = await runSweep({
    bookingModel: model,
    isMongoConnected: () => false,
    notifyExpired: async () => {},
  });

  assert.equal(result.skipped, true);
  assert.equal(model.bookings[0].status, 'pendiente_seña');
});

test('a hung notification cannot stall the sweeper forever (WARNING 8)', async () => {
  const model = createInMemoryBookingModel([expiredPending()]);

  const first = await runSweep({
    bookingModel: model,
    isMongoConnected: () => true,
    notifyExpired: () => new Promise(() => {}),
    notifyTimeoutMs: 20,
  });

  assert.equal(first.expiredCount, 1);

  // The running flag must have been released: a second sweep must actually run.
  const second = await runSweep({
    bookingModel: createInMemoryBookingModel([]),
    isMongoConnected: () => true,
    notifyExpired: async () => {},
    notifyTimeoutMs: 20,
  });
  assert.notEqual(second.reason, 'already_running', 'sweeper must not be stuck');
});

test('the check interval rejects invalid values (SUGGESTION 10)', () => {
  const { resolveCheckInterval, DEFAULT_CHECK_INTERVAL_MS } = require('../services/depositExpiry.service');

  assert.equal(resolveCheckInterval('abc'), DEFAULT_CHECK_INTERVAL_MS);
  assert.equal(resolveCheckInterval('-5'), DEFAULT_CHECK_INTERVAL_MS);
  assert.equal(resolveCheckInterval('0'), DEFAULT_CHECK_INTERVAL_MS);
  assert.equal(resolveCheckInterval('5000'), 5000);
});

test('apiServer wires the deposit expiry monitor at startup', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'apiServer.js'),
    'utf8',
  );
  assert.match(source, /startDepositExpiryMonitor/, 'apiServer must start the deposit monitor');
});
