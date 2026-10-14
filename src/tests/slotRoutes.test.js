'use strict';

// Route-layer tests for per-court slot creation on /api/config/slots.
// The TimeSlot and Court models are replaced with in-memory fakes so the route
// behavior (validation, derived endTime and tenant scoping) is exercised
// without a database. The handlers are pulled straight off the Express router,
// mirroring depositRoutes.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-slot-routes';
process.env.PAYMENT_SECRET_KEY =
  process.env.PAYMENT_SECRET_KEY || 'c'.repeat(64);

const COMPANY_A = '64b0000000000000000000a1';
const COMPANY_B = '64b0000000000000000000b2';
const COURT_A = '64b0000000000000000000ca';
const COURT_B = '64b0000000000000000000cb';

const state = {
  slots: [],
  courts: [],
  updatedMany: [],
  nextId: 1,
};

const resetState = () => {
  state.slots = [];
  state.courts = [{ _id: COURT_A, name: 'Cancha 1', companyId: COMPANY_A }];
  state.updatedMany = [];
  state.nextId = 1;
};

const norm = (value) => (value === undefined || value === null ? '' : String(value));

const isOperatorObject = (value) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).some((key) => key.startsWith('$'));

const matches = (doc, filter = {}) =>
  Object.entries(filter).every(([key, value]) => {
    if (isOperatorObject(value)) {
      // Query operators ($regex / $ne / ...) are irrelevant to these fixtures.
      return true;
    }
    if (key === '_id') return norm(doc._id) === norm(value);
    return norm(doc[key]) === norm(value);
  });

const sortByOrderDesc = (items) =>
  [...items].sort((a, b) => (b.order || 0) - (a.order || 0));

const makeFindOneQuery = (filter) => {
  const resolveOne = () => {
    const found = state.slots.filter((slot) => matches(slot, filter));
    if (!found.length) return null;
    if (filter._id !== undefined) return found[0];
    return sortByOrderDesc(found)[0];
  };

  const query = {
    sort: () => Promise.resolve(resolveOne()),
    lean: () => Promise.resolve(resolveOne()),
    then: (onFulfilled, onRejected) =>
      Promise.resolve(resolveOne()).then(onFulfilled, onRejected),
    catch: (onRejected) => Promise.resolve(resolveOne()).catch(onRejected),
  };
  return query;
};

const stubModule = (requestPath, exportsObj) => {
  const resolved = require.resolve(requestPath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsObj,
  };
};

stubModule('../models/timeSlot.model', {
  findOne: (filter = {}) => makeFindOneQuery(filter),
  find: (filter = {}) => ({
    sort: () => Promise.resolve(state.slots.filter((slot) => matches(slot, filter))),
  }),
  create: async (doc) => {
    const created = { _id: `slot-${state.nextId++}`, ...doc };
    state.slots.push(created);
    return created;
  },
  findOneAndUpdate: async (filter, update) => {
    const target = state.slots.find((slot) => matches(slot, filter));
    if (!target) return null;
    Object.assign(target, update.$set || update);
    return target;
  },
  updateMany: async (filter, update) => {
    state.updatedMany.push({ filter, update });
    let modifiedCount = 0;
    for (const slot of state.slots) {
      if (matches(slot, filter)) {
        Object.assign(slot, update.$set || update);
        modifiedCount += 1;
      }
    }
    return { modifiedCount };
  },
  findOneAndDelete: async (filter = {}) => {
    const index = state.slots.findIndex((slot) => matches(slot, filter));
    if (index === -1) return null;
    const [removed] = state.slots.splice(index, 1);
    return removed;
  },
});

stubModule('../models/court.model', {
  COURT_TYPES: ['Techada', 'VIP'],
  findOne: async (filter = {}) =>
    state.courts.find((court) => matches(court, filter)) || null,
  find: (filter = {}) => ({
    sort: () => Promise.resolve(state.courts.filter((court) => matches(court, filter))),
  }),
});

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
const getHandler = (router, path, method) => {
  const handlers = getRoute(router, path, method).stack.map((entry) => entry.handle);
  return handlers[handlers.length - 1];
};

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

const adminReq = (overrides = {}) => ({
  params: {},
  query: {},
  body: {},
  user: { role: 'admin', companyId: COMPANY_A },
  ...overrides,
});

// ── POST /slots ──────────────────────────────────────────────────────────────

test('POST /slots derives endTime from startTime + durationMinutes', async () => {
  resetState();
  const res = createResponse();
  await getHandler(configRouter, '/slots', 'post')(
    adminReq({ body: { startTime: '20:00', durationMinutes: 90, price: 25000 } }),
    res,
  );

  assert.equal(res.statusCode, 201);
  assert.equal(res.payload.data.endTime, '21:30');
  assert.equal(res.payload.data.durationMinutes, 90);
  assert.equal(state.slots.length, 1);
});

test('POST /slots wraps past-midnight duration into the clock day', async () => {
  resetState();
  const res = createResponse();
  await getHandler(configRouter, '/slots', 'post')(
    adminReq({ body: { startTime: '23:30', durationMinutes: 60, price: 25000 } }),
    res,
  );

  assert.equal(res.statusCode, 201);
  assert.equal(res.payload.data.endTime, '00:30');
});

test('POST /slots stores the owning court when it belongs to the company', async () => {
  resetState();
  const res = createResponse();
  await getHandler(configRouter, '/slots', 'post')(
    adminReq({
      body: { startTime: '10:00', durationMinutes: 15, price: 18000, court: COURT_A },
    }),
    res,
  );

  assert.equal(res.statusCode, 201);
  assert.equal(String(res.payload.data.court), COURT_A);
  assert.equal(res.payload.data.endTime, '10:15');
});

test('POST /slots rejects a malformed start time with 400', async () => {
  resetState();
  const res = createResponse();
  await getHandler(configRouter, '/slots', 'post')(
    adminReq({ body: { startTime: '24:00', durationMinutes: 60, price: 100 } }),
    res,
  );

  assert.equal(res.statusCode, 400);
  assert.equal(state.slots.length, 0);
});

test('POST /slots rejects a duration below the minimum with 400', async () => {
  resetState();
  const res = createResponse();
  await getHandler(configRouter, '/slots', 'post')(
    adminReq({ body: { startTime: '20:00', durationMinutes: 10, price: 100 } }),
    res,
  );

  assert.equal(res.statusCode, 400);
  assert.equal(state.slots.length, 0);
});

test('POST /slots rejects a duration above the maximum with 400', async () => {
  resetState();
  const res = createResponse();
  await getHandler(configRouter, '/slots', 'post')(
    adminReq({ body: { startTime: '20:00', durationMinutes: 500, price: 100 } }),
    res,
  );

  assert.equal(res.statusCode, 400);
});

test('POST /slots rejects a court that belongs to another company', async () => {
  resetState();
  const res = createResponse();
  await getHandler(configRouter, '/slots', 'post')(
    adminReq({
      body: { startTime: '20:00', durationMinutes: 60, price: 100, court: COURT_B },
    }),
    res,
  );

  assert.equal(res.statusCode, 400);
  assert.equal(state.slots.length, 0);
});

test('POST /slots rejects a duplicated slot for the same court with 400', async () => {
  resetState();
  state.slots.push({
    _id: 'existing',
    companyId: COMPANY_A,
    startTime: '20:00',
    endTime: '21:00',
    court: null,
  });
  const res = createResponse();
  await getHandler(configRouter, '/slots', 'post')(
    adminReq({ body: { startTime: '20:00', durationMinutes: 60, price: 100 } }),
    res,
  );

  assert.equal(res.statusCode, 400);
  assert.equal(state.slots.length, 1);
});

// ── PUT /slots/:id ───────────────────────────────────────────────────────────

test('PUT /slots/:id recomputes endTime when the duration changes', async () => {
  resetState();
  state.slots.push({
    _id: 'slot-edit',
    companyId: COMPANY_A,
    startTime: '20:00',
    endTime: '21:00',
    durationMinutes: 60,
    price: 25000,
    court: null,
  });
  const res = createResponse();
  await getHandler(configRouter, '/slots/:id', 'put')(
    adminReq({ params: { id: 'slot-edit' }, body: { durationMinutes: 120 } }),
    res,
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.data.endTime, '22:00');
  assert.equal(res.payload.data.durationMinutes, 120);
});

test('PUT /slots/:id rejects an out-of-range duration with 400', async () => {
  resetState();
  state.slots.push({
    _id: 'slot-edit',
    companyId: COMPANY_A,
    startTime: '20:00',
    endTime: '21:00',
    durationMinutes: 60,
    price: 25000,
  });
  const res = createResponse();
  await getHandler(configRouter, '/slots/:id', 'put')(
    adminReq({ params: { id: 'slot-edit' }, body: { durationMinutes: 5 } }),
    res,
  );

  assert.equal(res.statusCode, 400);
  assert.equal(state.slots[0].durationMinutes, 60);
});

test('PUT /slots/:id keeps a partial isActive toggle working', async () => {
  resetState();
  state.slots.push({
    _id: 'slot-edit',
    companyId: COMPANY_A,
    startTime: '20:00',
    endTime: '21:00',
    durationMinutes: 60,
    price: 25000,
    isActive: true,
  });
  const res = createResponse();
  await getHandler(configRouter, '/slots/:id', 'put')(
    adminReq({ params: { id: 'slot-edit' }, body: { isActive: false } }),
    res,
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.data.isActive, false);
  assert.equal(res.payload.data.endTime, '21:00');
});

// ── PUT /slots/base-price ────────────────────────────────────────────────────

test('PUT /slots/base-price bulk-updates every company slot by default', async () => {
  resetState();
  state.slots.push(
    { _id: 'g', companyId: COMPANY_A, price: 1, order: 1, court: null },
    { _id: 'c1', companyId: COMPANY_A, price: 1, order: 2, court: COURT_A },
    { _id: 'other', companyId: COMPANY_B, price: 1, order: 3, court: null },
  );
  const res = createResponse();
  await getHandler(configRouter, '/slots/base-price', 'put')(
    adminReq({ body: { price: 30000 } }),
    res,
  );

  assert.equal(res.statusCode, 200);
  assert.equal(state.slots.find((s) => s._id === 'g').price, 30000);
  assert.equal(state.slots.find((s) => s._id === 'c1').price, 30000);
  assert.equal(state.slots.find((s) => s._id === 'other').price, 1);
});

test('PUT /slots/base-price scopes the update to a single court when provided', async () => {
  resetState();
  state.slots.push(
    { _id: 'g', companyId: COMPANY_A, price: 1, order: 1, court: null },
    { _id: 'c1', companyId: COMPANY_A, price: 1, order: 2, court: COURT_A },
  );
  const res = createResponse();
  await getHandler(configRouter, '/slots/base-price', 'put')(
    adminReq({ body: { price: 42000, court: COURT_A } }),
    res,
  );

  assert.equal(res.statusCode, 200);
  assert.equal(state.slots.find((s) => s._id === 'c1').price, 42000);
  assert.equal(state.slots.find((s) => s._id === 'g').price, 1);
});

// ── GET /slots ───────────────────────────────────────────────────────────────
test('GET /slots returns general and per-court slots with their metadata', async () => {
  resetState();
  state.slots.push(
    { _id: 'g', companyId: COMPANY_A, startTime: '20:00', endTime: '21:00', court: null, durationMinutes: 60, price: 1, order: 1, isActive: true },
    { _id: 'c1', companyId: COMPANY_A, startTime: '10:00', endTime: '11:00', court: COURT_A, durationMinutes: 60, price: 2, order: 2, isActive: true },
  );
  const res = createResponse();
  await getHandler(configRouter, '/slots', 'get')(adminReq(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.data.length, 2);
  assert.equal(res.payload.data.find((s) => s._id === 'c1').durationMinutes, 60);
  assert.equal(String(res.payload.data.find((s) => s._id === 'c1').court), COURT_A);
});

// ── DELETE /slots/:id ────────────────────────────────────────────────────────

test('DELETE /slots/:id removes a company slot', async () => {
  resetState();
  state.slots.push({
    _id: 'slot-del',
    companyId: COMPANY_A,
    startTime: '20:00',
    endTime: '21:00',
  });
  const res = createResponse();
  await getHandler(configRouter, '/slots/:id', 'delete')(
    adminReq({ params: { id: 'slot-del' } }),
    res,
  );

  assert.equal(res.statusCode, 200);
  assert.equal(state.slots.length, 0);
});

test('DELETE /slots/:id refuses a slot that belongs to another company', async () => {
  resetState();
  state.slots.push({ _id: 'slot-other', companyId: COMPANY_B });
  const res = createResponse();
  await getHandler(configRouter, '/slots/:id', 'delete')(
    adminReq({ params: { id: 'slot-other' } }),
    res,
  );

  assert.equal(res.statusCode, 404);
  assert.equal(state.slots.length, 1);
});
