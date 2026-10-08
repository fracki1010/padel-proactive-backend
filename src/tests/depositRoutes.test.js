'use strict';

// Route-layer security tests for the deposit admin routes: authorization
// (admin/super_admin only, client tokens rejected), tenant scoping and secret
// masking. Service modules are replaced with in-process stubs so the route
// behavior is exercised without a database or new dependencies.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-deposit-routes';
process.env.PAYMENT_SECRET_KEY =
  process.env.PAYMENT_SECRET_KEY || 'c'.repeat(64);

const { CryptoConfigError } = require('../lib/crypto');
const appConfigService = require('../services/appConfig.service');
const credentialService = require('../services/paymentCredential.service');
const { resolveDepositUpdate } = appConfigService;

const COMPANY_A = '64b0000000000000000000a1';
const COMPANY_B = '64b0000000000000000000b2';

const state = {
  current: { depositEnabled: false, depositAmount: 0, holdMinutes: 15 },
  masked: { configured: true, provider: 'mercadopago', masked: '••••', mpUserId: 'mp-1' },
  maskedError: null,
  credentialError: null,
  calls: {
    getDepositSettings: [],
    setDepositSettings: [],
    getMaskedCredential: [],
    setCredential: [],
    deleteCredential: [],
  },
};

const resetState = () => {
  state.current = { depositEnabled: false, depositAmount: 0, holdMinutes: 15 };
  state.masked = { configured: true, provider: 'mercadopago', masked: '••••', mpUserId: 'mp-1' };
  state.maskedError = null;
  state.credentialError = null;
  for (const key of Object.keys(state.calls)) state.calls[key] = [];
};

appConfigService.getDepositSettings = async (companyId) => {
  state.calls.getDepositSettings.push(companyId);
  return { ...state.current };
};
appConfigService.setDepositSettings = async (settings, companyId) => {
  const { valid, error } = resolveDepositUpdate(settings, state.current);
  if (!valid) {
    throw Object.assign(new Error(error), { statusCode: 400 });
  }
  state.calls.setDepositSettings.push({ settings, companyId });
  return { ...state.current, ...settings };
};
credentialService.getMaskedCredential = async (companyId) => {
  state.calls.getMaskedCredential.push(companyId);
  if (state.maskedError) throw state.maskedError;
  return { ...state.masked };
};
credentialService.setCredential = async (companyId, payload) => {
  state.calls.setCredential.push({ companyId, payload });
  if (state.credentialError) throw state.credentialError;
  return {};
};
credentialService.deleteCredential = async (companyId) => {
  state.calls.deleteCredential.push(companyId);
  return { deleted: true };
};

const configRouter = require('../routes/config.routes');

// ── Harness ──────────────────────────────────────────────────────────────────

const getRoute = (router, path, method) => {
  const layer = router.stack.find(
    (entry) =>
      entry.route &&
      entry.route.path === path &&
      entry.route.methods[method.toLowerCase()],
  );
  assert.ok(layer, `missing route ${method} ${path}`);
  return layer.route;
};
const getHandlers = (router, path, method) =>
  getRoute(router, path, method).stack.map((entry) => entry.handle);
const getAuthz = (router, path, method) => getHandlers(router, path, method)[0];
const getHandler = (router, path, method) => {
  const handlers = getHandlers(router, path, method);
  return handlers[handlers.length - 1];
};

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

const runMiddleware = (middleware, req, res) => {
  let nextCalled = false;
  middleware(req, res, () => {
    nextCalled = true;
  });
  return nextCalled;
};

const DEPOSIT_ROUTES = [
  ['/deposits', 'get'],
  ['/deposits', 'put'],
  ['/deposits/credentials', 'put'],
  ['/deposits/credentials', 'delete'],
];

// ── Route contract ───────────────────────────────────────────────────────────

test('config router exposes the deposit + credential admin routes', () => {
  const has = (path, method) => Boolean(getRoute(configRouter, path, method));
  assert.ok(has('/deposits', 'get'), 'missing GET /deposits');
  assert.ok(has('/deposits', 'put'), 'missing PUT /deposits');
  assert.ok(has('/deposits/credentials', 'put'), 'missing PUT /deposits/credentials');
  assert.ok(has('/deposits/credentials', 'delete'), 'missing DELETE /deposits/credentials');

  const exposedGet = configRouter.stack.some(
    (entry) =>
      entry.route &&
      entry.route.path === '/deposits/credentials' &&
      entry.route.methods.get,
  );
  assert.equal(exposedGet, false, 'credentials must never be readable via GET');
});

// ── Authorization (BLOCKER) ──────────────────────────────────────────────────

test('every deposit admin route rejects a client token with 403', () => {
  for (const [path, method] of DEPOSIT_ROUTES) {
    const authz = getAuthz(configRouter, path, method);
    const res = createResponse();
    const allowed = runMiddleware(
      authz,
      { user: { type: 'client', companyId: COMPANY_A } },
      res,
    );
    assert.equal(allowed, false, `${method} ${path} allowed a client token`);
    assert.equal(res.captured.statusCode, 403, `${method} ${path} must be 403`);
  }
});

test('an admin role passes the authz gate on every deposit route', () => {
  for (const [path, method] of DEPOSIT_ROUTES) {
    const authz = getAuthz(configRouter, path, method);
    const allowed = runMiddleware(
      authz,
      { user: { role: 'admin', companyId: COMPANY_A } },
      createResponse(),
    );
    assert.equal(allowed, true, `${method} ${path} rejected an admin`);
  }
});

test('a super_admin role passes the authz gate on every deposit route', () => {
  for (const [path, method] of DEPOSIT_ROUTES) {
    const authz = getAuthz(configRouter, path, method);
    const allowed = runMiddleware(
      authz,
      { user: { role: 'super_admin' } },
      createResponse(),
    );
    assert.equal(allowed, true, `${method} ${path} rejected a super_admin`);
  }
});

test('an authz middleware guards every deposit route before its handler', () => {
  for (const [path, method] of DEPOSIT_ROUTES) {
    const handlers = getHandlers(configRouter, path, method);
    assert.ok(
      handlers.length >= 2,
      `${method} ${path} is missing an authorization middleware`,
    );
  }
});

// ── Tenant scoping ───────────────────────────────────────────────────────────

test('GET /deposits only queries the caller company', async () => {
  resetState();
  const handler = getHandler(configRouter, '/deposits', 'get');
  await handler(
    { query: {}, user: { role: 'admin', companyId: COMPANY_B } },
    createResponse(),
  );

  assert.deepEqual(state.calls.getDepositSettings, [COMPANY_B]);
  assert.deepEqual(state.calls.getMaskedCredential, [COMPANY_B]);
});

test('super_admin companyId is cast to an ObjectId before use', async () => {
  resetState();
  const handler = getHandler(configRouter, '/deposits', 'get');
  await handler(
    { query: { companyId: COMPANY_A }, user: { role: 'super_admin' } },
    createResponse(),
  );

  const passed = state.calls.getDepositSettings.at(-1);
  assert.ok(
    passed instanceof mongoose.Types.ObjectId,
    'companyId was not validated as an ObjectId',
  );
  assert.equal(String(passed), COMPANY_A);
});

// ── Secret masking in responses ──────────────────────────────────────────────

test('GET /deposits response contains no token, ciphertext or last4', async () => {
  resetState();
  const handler = getHandler(configRouter, '/deposits', 'get');
  const res = createResponse();

  await handler({ query: {}, user: { role: 'admin', companyId: COMPANY_A } }, res);

  assert.equal(res.captured.statusCode, 200);
  const serialized = JSON.stringify(res.captured.body);
  for (const forbidden of ['tokenCiphertext', 'APP_USR', 'authTag', 'last4']) {
    assert.ok(!serialized.includes(forbidden), `GET /deposits leaked ${forbidden}`);
  }
  assert.equal(res.captured.body.data.credentials.configured, true);
});

// ── Error mapping ────────────────────────────────────────────────────────────

test('PUT /deposits/credentials maps a crypto config error to 503', async () => {
  resetState();
  state.credentialError = new CryptoConfigError(
    'PAYMENT_SECRET_KEY is not configured.',
  );
  const handler = getHandler(configRouter, '/deposits/credentials', 'put');
  const res = createResponse();

  await handler(
    { body: { accessToken: 'APP_USR-x' }, query: {}, user: { role: 'admin', companyId: COMPANY_A } },
    res,
  );

  assert.equal(res.captured.statusCode, 503);
});

test('PUT /deposits returns 400 for a zero amount when enabled', async () => {
  resetState();
  const handler = getHandler(configRouter, '/deposits', 'put');
  const res = createResponse();

  await handler(
    { body: { depositEnabled: true, depositAmount: 0 }, query: {}, user: { role: 'admin', companyId: COMPANY_A } },
    res,
  );

  assert.equal(res.captured.statusCode, 400);
  assert.equal(state.calls.setDepositSettings.length, 0);
});

test('PUT /deposits/credentials returns 400 without an access token', async () => {
  resetState();
  const handler = getHandler(configRouter, '/deposits/credentials', 'put');
  const res = createResponse();

  await handler(
    { body: {}, query: {}, user: { role: 'admin', companyId: COMPANY_A } },
    res,
  );

  assert.equal(res.captured.statusCode, 400);
  assert.equal(state.calls.setCredential.length, 0);
});
