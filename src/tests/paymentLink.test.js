'use strict';

// Route + controller tests for the public "payment link" endpoint:
// POST /api/public/:slug/bookings/:id/payment-link
// Owner-scoped, resolved from the credential company, 409 when the club has no
// MercadoPago credential or deposits are disabled, and 502 on MP failure.
// Persistence is replaced with injected fakes; the MercadoPago call is stubbed.

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-payment-link';

const COMPANY = '64b0000000000000000000a1';
const OTHER_COMPANY = '64b0000000000000000000b2';
const BOOKING_ID = '64b0000000000000000000c3';

const state = {
  company: { _id: COMPANY },
  client: { _id: 'client-1', phone: '5491100000000' },
  booking: { _id: BOOKING_ID, companyId: COMPANY, status: 'reservado' },
  credential: { _id: 'cred-1' },
  settings: { depositEnabled: true, depositAmount: 5000, holdMinutes: 15 },
  mpError: null,
  mpCalls: [],
  credentialCalls: [],
  bookingCalls: [],
};

const resetState = () => {
  state.company = { _id: COMPANY };
  state.client = { _id: 'client-1', phone: '5491100000000' };
  state.booking = { _id: BOOKING_ID, companyId: COMPANY, status: 'reservado' };
  state.credential = { _id: 'cred-1' };
  state.settings = { depositEnabled: true, depositAmount: 5000, holdMinutes: 15 };
  state.mpError = null;
  state.mpCalls = [];
  state.credentialCalls = [];
  state.bookingCalls = [];
};

// Patch service seams BEFORE requiring the controller so its destructured
// references capture the fakes.
const credentialService = require('../services/paymentCredential.service');
const appConfigService = require('../services/appConfig.service');
const mpService = require('../services/mercadopago.service');

credentialService.getActiveCredential = async (companyId) => {
  state.credentialCalls.push(companyId);
  return state.credential;
};
appConfigService.getDepositSettings = async () => ({ ...state.settings });
mpService.createDepositPreference = async (args, options) => {
  state.mpCalls.push({ args, options });
  if (state.mpError) throw state.mpError;
  return { initPoint: 'https://mp/checkout/pref-x', preferenceId: 'pref-x' };
};

const Company = require('../models/company.model');
const ClientAccount = require('../models/clientAccount.model');
const Booking = require('../models/booking.model');

Company.findOne = async () => state.company;
ClientAccount.findById = async () => state.client;
Booking.findOne = async (filter) => {
  state.bookingCalls.push(filter);
  return state.booking;
};

const { createPaymentLink } = require('../controllers/public.controller');
const publicRouter = require('../routes/public.routes');

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

const baseReq = (overrides = {}) => ({
  params: { slug: 'club', id: BOOKING_ID },
  clientUser: { id: 'client-1', companyId: COMPANY },
  body: {},
  ...overrides,
});

// ── Route contract ───────────────────────────────────────────────────────────

test('public router exposes POST /bookings/:id/payment-link with a rate limiter and protectClient', () => {
  const layer = publicRouter.stack.find(
    (entry) =>
      entry.route &&
      entry.route.path === '/bookings/:id/payment-link' &&
      entry.route.methods.post,
  );
  assert.ok(layer, 'missing POST /bookings/:id/payment-link route');

  const handlers = layer.route.stack.map((entry) => entry.handle);
  assert.equal(
    handlers[0],
    publicRouter.paymentLinkRateLimiter,
    'route must be rate limited',
  );
  assert.ok(
    handlers.some((handler) => handler.name === 'protectClient'),
    'route must be client-protected',
  );
});

test('the payment-link rate limiter returns 429 after the configured burst', () => {
  const max = publicRouter.PAYMENT_LINK_RATE_LIMIT_MAX;
  assert.ok(Number.isInteger(max) && max > 0);
  const limiter = publicRouter.paymentLinkRateLimiter;
  const ip = '203.0.113.77';
  const req = { ip };
  for (let i = 0; i < max; i += 1) {
    limiter(req, createResponse(), () => {});
  }
  const blocked = createResponse();
  limiter(req, blocked, () => {});
  assert.equal(blocked.statusCode, 429);
});

// ── Controller ───────────────────────────────────────────────────────────────

test('createPaymentLink returns the init point for the owner booking', async () => {
  resetState();
  const res = createResponse();

  await createPaymentLink(baseReq(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.data.initPoint, 'https://mp/checkout/pref-x');
  assert.equal(res.payload.data.amount, 5000);
  assert.equal(state.mpCalls.length, 1);
  assert.equal(String(state.mpCalls[0].args.companyId), COMPANY);
  assert.equal(state.mpCalls[0].args.depositAmount, 5000);
  assert.equal(state.mpCalls[0].options.credential, state.credential);
});

test('createPaymentLink rejects a token for a different club with 403', async () => {
  resetState();
  const res = createResponse();

  await createPaymentLink(
    baseReq({ clientUser: { id: 'client-1', companyId: OTHER_COMPANY } }),
    res,
  );

  assert.equal(res.statusCode, 403);
  assert.equal(state.mpCalls.length, 0);
});

test('createPaymentLink returns 409 when the club has no MercadoPago credential', async () => {
  resetState();
  state.credential = null;
  const res = createResponse();

  await createPaymentLink(baseReq(), res);

  assert.equal(res.statusCode, 409);
  assert.equal(state.mpCalls.length, 0);
});

test('createPaymentLink returns 409 when deposits are disabled for the club', async () => {
  resetState();
  state.settings = { depositEnabled: false, depositAmount: 0, holdMinutes: 15 };
  const res = createResponse();

  await createPaymentLink(baseReq(), res);

  assert.equal(res.statusCode, 409);
  assert.equal(state.mpCalls.length, 0);
});

test('createPaymentLink maps a MercadoPago failure to 502', async () => {
  resetState();
  state.mpError = Object.assign(new Error('MP 5xx'), {
    code: 'MERCADOPAGO_ERROR',
    statusCode: 502,
  });
  const res = createResponse();

  await createPaymentLink(baseReq(), res);

  assert.equal(res.statusCode, 502);
});

test('createPaymentLink maps a missing encryption key to 503', async () => {
  resetState();
  state.mpError = Object.assign(new Error('PAYMENT_SECRET_KEY is not configured.'), {
    name: 'CryptoConfigError',
    code: 'CRYPTO_CONFIG_ERROR',
  });
  const res = createResponse();

  await createPaymentLink(baseReq(), res);

  assert.equal(res.statusCode, 503);
});

// ── Booking state + id validation (review findings) ─────────────────────────

test('createPaymentLink rejects a non-ObjectId booking id with 400', async () => {
  resetState();
  const res = createResponse();

  await createPaymentLink(baseReq({ params: { slug: 'club', id: 'not-an-id' } }), res);

  assert.equal(res.statusCode, 400);
  assert.equal(state.bookingCalls.length, 0, 'must not query with an invalid id');
  assert.equal(state.mpCalls.length, 0);
});

test('createPaymentLink refuses to mint a link for a confirmed booking', async () => {
  resetState();
  state.booking = { _id: BOOKING_ID, companyId: COMPANY, status: 'confirmado' };
  const res = createResponse();

  await createPaymentLink(baseReq(), res);

  assert.equal(res.statusCode, 409);
  assert.equal(state.mpCalls.length, 0);
});

test('createPaymentLink refuses a booking whose deposit is already paid', async () => {
  resetState();
  state.booking = {
    _id: BOOKING_ID,
    companyId: COMPANY,
    status: 'reservado',
    deposit: { status: 'pagado' },
  };
  const res = createResponse();

  await createPaymentLink(baseReq(), res);

  assert.equal(res.statusCode, 409);
  assert.equal(state.mpCalls.length, 0);
});
