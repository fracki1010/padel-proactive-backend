'use strict';

// Admin manual confirmation of a transfer seña (`POST /api/bookings/:id/
// deposit-received`): the handler must reuse the atomic approve transition,
// fire the same client-confirmation side effect as the webhook path, and reject
// non-pending bookings or cross-company access with Spanish errors. Persistence
// is replaced with an in-memory Booking model.

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'test-secret-deposit-manual-confirm';

const { createInMemoryBookingModel } = require('./helpers/inMemoryBookingModel');

// Neutralize the real notification side effects; depositNotification.service is
// lazy-required by deposit.service and reads these properties at call time.
const notificationService = require('../services/notificationService');
const whatsappQueue = require('../services/whatsappCommandQueue.service');
notificationService.sendAdminNotification = async () => ({ queuedCount: 0 });
whatsappQueue.enqueueWhatsappCommand = async () => ({ command: { _id: 'cmd-x' } });

const Booking = require('../models/booking.model');
const { confirmDepositReceived } = require('../controllers/booking.controller');

const COMPANY = '64b0000000000000000000a1';
const OTHER_COMPANY = '64b0000000000000000000b2';
const BOOKING_ID = '64b0000000000000000000c3';
const ADMIN_ID = '64b0000000000000000000d4';

const pendingTransferBooking = (overrides = {}) => ({
  _id: BOOKING_ID,
  companyId: COMPANY,
  clientName: 'Ana',
  clientPhone: '5491100000000',
  status: 'pendiente_seña',
  finalPrice: 25000,
  deposit: {
    required: true,
    amount: 5000,
    status: 'pendiente',
    method: 'transfer',
    preferenceId: null,
    paymentId: null,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    paidAt: null,
    refundable: false,
  },
  ...overrides,
});

const createResponse = () => {
  const captured = {};
  return {
    captured,
    status(code) {
      captured.statusCode = code;
      return this;
    },
    json(body) {
      captured.body = body;
      return this;
    },
  };
};

const createReq = (overrides = {}) => ({
  params: { id: BOOKING_ID },
  user: { _id: ADMIN_ID, role: 'admin', companyId: COMPANY },
  ...overrides,
});

const wireModel = (model) => {
  Booking.findOne = (filter) => model.findOne(filter);
  Booking.findOneAndUpdate = (filter, update, options) =>
    model.findOneAndUpdate(filter, update, options);
};

// ── Happy path ──────────────────────────────────────────────────────────────

test('confirmDepositReceived confirms a transfer hold and returns the booking', async () => {
  const model = createInMemoryBookingModel([pendingTransferBooking()]);
  wireModel(model);
  const res = createResponse();

  await confirmDepositReceived(createReq(), res);

  assert.equal(res.captured.statusCode, 200);
  assert.equal(res.captured.body.success, true);
  const booking = model.bookings[0];
  assert.equal(booking.status, 'reservado');
  assert.equal(booking.deposit.status, 'pagado');
  assert.ok(booking.deposit.paidAt instanceof Date, 'paidAt must be set');
  assert.ok(
    String(booking.deposit.paymentId).startsWith('manual:'),
    'a synthetic manual payment id must be recorded',
  );
  assert.ok(
    String(booking.deposit.paymentId).includes(ADMIN_ID),
    'the manual id must identify the confirming admin',
  );
  assert.equal(booking.finalPrice, 20000, 'the seña is deducted exactly once');
  assert.equal(res.captured.body.data._id, String(booking._id));
});

test('a second confirm after the transition is rejected with 409', async () => {
  const model = createInMemoryBookingModel([pendingTransferBooking()]);
  wireModel(model);
  const res = createResponse();

  await confirmDepositReceived(createReq(), res);
  assert.equal(res.captured.statusCode, 200);

  const second = createResponse();
  await confirmDepositReceived(createReq(), second);
  assert.equal(second.captured.statusCode, 409);
  assert.equal(second.captured.body.success, false);
  assert.equal(second.captured.body.error.length > 0, true);
  assert.equal(model.bookings[0].deposit.status, 'pagado', 'state must not regress');
});

// ── Guards ─────────────────────────────────────────────────────────────────

test('a booking from another company is not reachable (404)', async () => {
  const model = createInMemoryBookingModel([pendingTransferBooking()]);
  wireModel(model);
  const res = createResponse();

  await confirmDepositReceived(
    createReq({ user: { _id: ADMIN_ID, role: 'admin', companyId: OTHER_COMPANY } }),
    res,
  );

  assert.equal(res.captured.statusCode, 404);
  assert.equal(res.captured.body.success, false);
  assert.equal(model.bookings[0].status, 'pendiente_seña', 'no mutation on a miss');
});

test('a non-pending booking (already reserved) is rejected with 409', async () => {
  const model = createInMemoryBookingModel([
    pendingTransferBooking({ status: 'reservado' }),
  ]);
  wireModel(model);
  const res = createResponse();

  await confirmDepositReceived(createReq(), res);

  assert.equal(res.captured.statusCode, 409);
  assert.equal(res.captured.body.success, false);
  assert.equal(model.bookings[0].finalPrice, 25000, 'never deducts a non-pending hold');
});

test('a missing booking is rejected with 404', async () => {
  const model = createInMemoryBookingModel([]);
  wireModel(model);
  const res = createResponse();

  await confirmDepositReceived(createReq(), res);

  assert.equal(res.captured.statusCode, 404);
});

// ── Route contract ──────────────────────────────────────────────────────────

const getRoute = (router, path, method) => {
  const layer = router.stack.find(
    (entry) =>
      entry.route &&
      entry.route.path === path &&
      entry.route.methods[method.toLowerCase()],
  );
  return layer ? layer.route : null;
};

const runMiddleware = (middleware, req, res) => {
  let nextCalled = false;
  middleware(req, res, () => {
    nextCalled = true;
  });
  return nextCalled;
};

test('booking router exposes POST /:id/deposit-received behind admin authz', async () => {
  const bookingRouter = require('../routes/booking.routes');

  const route = getRoute(bookingRouter, '/:id/deposit-received', 'post');
  assert.ok(route, 'missing POST /:id/deposit-received');

  const handlers = route.stack.map((entry) => entry.handle);
  assert.ok(handlers.length >= 2, 'the route must be guarded by requireRole');

  const authz = handlers[0];
  const clientRes = createResponse();
  const clientAllowed = runMiddleware(
    authz,
    { user: { type: 'client', companyId: COMPANY } },
    clientRes,
  );
  assert.equal(clientAllowed, false, 'a client token must be rejected');
  assert.equal(clientRes.captured.statusCode, 403);

  const adminRes = createResponse();
  const adminAllowed = runMiddleware(
    authz,
    { user: { role: 'admin', companyId: COMPANY } },
    adminRes,
  );
  assert.equal(adminAllowed, true, 'an admin must pass the authz gate');
});