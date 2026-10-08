'use strict';

// Contract + validation tests for the deposit admin routes mounted under
// `/api/config`. Validation paths return 400 before touching the database, so
// they can be exercised by invoking the route handler directly with fake
// req/res objects. Tenant scoping comes from the shared `resolveCompanyId`.

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-deposit-routes';

const configRouter = require('../routes/config.routes');

const COMPANY_A = '64b0000000000000000000a1';

const listRoutes = (router) =>
  router.stack
    .filter((layer) => layer.route)
    .map((layer) => ({
      path: layer.route.path,
      methods: Object.keys(layer.route.methods).map((method) => method.toUpperCase()),
    }));

const getHandler = (router, path, method) => {
  const layer = router.stack.find(
    (entry) =>
      entry.route &&
      entry.route.path === path &&
      entry.route.methods[method.toLowerCase()],
  );
  assert.ok(layer, `missing route ${method} ${path}`);
  return layer.route.stack[0].handle;
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

// ── Route contract ───────────────────────────────────────────────────────────

test('config router exposes the deposit + credential admin routes', () => {
  const routes = listRoutes(configRouter);
  const has = (path, method) =>
    routes.some((route) => route.path === path && route.methods.includes(method));

  assert.ok(has('/deposits', 'GET'), 'missing GET /deposits');
  assert.ok(has('/deposits', 'PUT'), 'missing PUT /deposits');
  assert.ok(
    has('/deposits/credentials', 'PUT'),
    'missing PUT /deposits/credentials',
  );
  assert.ok(
    has('/deposits/credentials', 'DELETE'),
    'missing DELETE /deposits/credentials',
  );
  assert.ok(
    !has('/deposits/credentials', 'GET'),
    'credentials must never be readable via GET',
  );
});

// ── Validation without persistence ───────────────────────────────────────────

test('PUT /deposits returns 400 for a zero amount', async () => {
  const handler = getHandler(configRouter, '/deposits', 'put');
  const req = {
    body: { depositEnabled: true, depositAmount: 0 },
    query: {},
    user: { companyId: COMPANY_A, role: 'admin' },
  };
  const res = createResponse();

  await handler(req, res);

  assert.equal(res.captured.statusCode, 400);
  assert.equal(res.captured.body.success, false);
});

test('PUT /deposits/credentials returns 400 without an access token', async () => {
  const handler = getHandler(configRouter, '/deposits/credentials', 'put');
  const req = {
    body: {},
    query: {},
    user: { companyId: COMPANY_A, role: 'admin' },
  };
  const res = createResponse();

  await handler(req, res);

  assert.equal(res.captured.statusCode, 400);
  assert.equal(res.captured.body.success, false);
});
