'use strict';

// Route-layer tests for per-company scoping of WRITE endpoints in config.routes.
// Court / TimeSlot / ClubClosure models are replaced with in-memory fakes so the
// behavior (tenant scoping, duplicate-name checks and cross-company validation)
// runs without a database. Handlers are pulled straight off the Express router,
// mirroring slotRoutes.test.js.
//
// Regression guarded here: a super_admin with no companyId used to resolve an
// EMPTY scope, so the duplicate-name check scanned courts of EVERY company and
// new docs were persisted with companyId: null (orphans).

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-court-scope';
process.env.PAYMENT_SECRET_KEY =
  process.env.PAYMENT_SECRET_KEY || 'c'.repeat(64);

const COMPANY_A = '64b0000000000000000000a1';
const COMPANY_B = '64b0000000000000000000b2';
const COURT_A1 = '64b0000000000000000000ca';
const COURT_A2 = '64b0000000000000000000cc';
const COURT_B1 = '64b0000000000000000000cb';
const COURT_B2 = '64b0000000000000000000cd';

const state = {
  courts: [],
  slots: [],
  closures: [],
  nextId: 1,
};

const resetState = () => {
  state.courts = [
    // Company A has its own courts; "Cancha 1" exists ONLY in company B.
    { _id: COURT_A1, name: 'Cancha A1', companyId: COMPANY_A },
    { _id: COURT_B1, name: 'Cancha 1', companyId: COMPANY_B },
    { _id: COURT_B2, name: 'Cancha 2', companyId: COMPANY_B },
  ];
  state.slots = [];
  state.closures = [];
  state.nextId = 1;
};

const norm = (value) => (value === undefined || value === null ? '' : String(value));

const isOperatorObject = (value) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).some((key) => key.startsWith('$'));

// Filter matcher that understands the operators used by config.routes:
// { $regex } for case-insensitive name lookups and { $ne } for id exclusion.
const matches = (doc, filter = {}) =>
  Object.entries(filter).every(([key, value]) => {
    if (isOperatorObject(value)) {
      if (value.$regex instanceof RegExp) return value.$regex.test(norm(doc[key]));
      if (Object.prototype.hasOwnProperty.call(value, '$ne')) {
        return norm(doc[key]) !== norm(value.$ne);
      }
      return true;
    }
    return norm(doc[key]) === norm(value);
  });

const makeFindOneQuery = (collection, filter) => {
  const resolveOne = () => collection.find((doc) => matches(doc, filter)) || null;
  return {
    sort: () => Promise.resolve(resolveOne()),
    lean: () => Promise.resolve(resolveOne()),
    then: (onFulfilled, onRejected) =>
      Promise.resolve(resolveOne()).then(onFulfilled, onRejected),
    catch: (onRejected) => Promise.resolve(resolveOne()).catch(onRejected),
  };
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

stubModule('../models/court.model', {
  COURT_TYPES: ['Techada', 'Descubierta', 'VIP'],
  findOne: async (filter = {}) =>
    state.courts.find((court) => matches(court, filter)) || null,
  find: (filter = {}) => ({
    sort: () => Promise.resolve(state.courts.filter((court) => matches(court, filter))),
  }),
  create: async (doc) => {
    const created = { _id: `court-${state.nextId++}`, ...doc };
    state.courts.push(created);
    return created;
  },
  findOneAndUpdate: async (filter, update) => {
    const target = state.courts.find((court) => matches(court, filter));
    if (!target) return null;
    Object.assign(target, update.$set || update);
    return target;
  },
});

stubModule('../models/timeSlot.model', {
  findOne: (filter = {}) => makeFindOneQuery(state.slots, filter),
  find: (filter = {}) => ({
    sort: () => Promise.resolve(state.slots.filter((slot) => matches(slot, filter))),
  }),
  create: async (doc) => {
    const created = { _id: `slot-${state.nextId++}`, ...doc };
    state.slots.push(created);
    return created;
  },
  findOneAndUpdate: async () => null,
  updateMany: async () => ({ modifiedCount: 0 }),
  findOneAndDelete: async () => null,
});

stubModule('../models/clubClosure.model', {
  find: (filter = {}) => ({
    sort: () =>
      Promise.resolve(state.closures.filter((closure) => matches(closure, filter))),
  }),
  create: async (doc) => {
    const created = { _id: `closure-${state.nextId++}`, ...doc };
    state.closures.push(created);
    return created;
  },
  findOneAndUpdate: async () => null,
  findOneAndDelete: async () => null,
});

const configRouter = require('../routes/config.routes');

// ── Harness ──────────────────────────────────────────────────────────────────

const getHandler = (path, method) => {
  const layer = configRouter.stack.find(
    (entry) =>
      entry.route &&
      entry.route.path === path &&
      entry.route.methods[method.toLowerCase()],
  );
  assert.ok(layer, `missing route ${method} ${path}`);
  const handlers = layer.route.stack.map((entry) => entry.handle);
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

const adminReq = (companyId, overrides = {}) => ({
  params: {},
  query: {},
  body: {},
  user: { role: 'admin', companyId },
  ...overrides,
});

const superReq = (overrides = {}) => ({
  params: {},
  query: {},
  body: {},
  user: { role: 'super_admin' },
  ...overrides,
});

const postCourts = getHandler('/courts', 'post');
const putCourt = getHandler('/courts/:id', 'put');
const postSlots = getHandler('/slots', 'post');
const postClosures = getHandler('/club-closures', 'post');

// ── POST /courts ─────────────────────────────────────────────────────────────

test('POST /courts lets an admin reuse a name that only exists in another company', async () => {
  resetState();
  const res = createResponse();
  await postCourts(
    adminReq(COMPANY_A, { body: { name: 'Cancha 1', courtType: 'Techada' } }),
    res,
  );

  assert.equal(res.statusCode, 201);
  assert.equal(norm(res.payload.data.companyId), COMPANY_A);
  assert.equal(res.payload.data.name, 'Cancha 1');
  assert.equal(state.courts.length, 4);
});

test('POST /courts rejects a duplicate name inside the same company with the Spanish message', async () => {
  resetState();
  const res = createResponse();
  // "cancha a1" matches "Cancha A1" case-insensitively, within company A.
  await postCourts(
    adminReq(COMPANY_A, { body: { name: 'cancha a1' } }),
    res,
  );

  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.error, 'Ya existe una cancha con ese nombre.');
  assert.equal(state.courts.length, 3);
});

test('POST /courts as super_admin without companyId returns 400', async () => {
  resetState();
  const res = createResponse();
  await postCourts(superReq({ body: { name: 'Cancha 9' } }), res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.error, 'Especificá la empresa (companyId).');
  assert.equal(state.courts.length, 3);
});

test('POST /courts as super_admin with companyId in the body scopes the create', async () => {
  resetState();
  const res = createResponse();
  await postCourts(
    superReq({ body: { name: 'Cancha 1', companyId: COMPANY_A } }),
    res,
  );

  assert.equal(res.statusCode, 201);
  assert.equal(norm(res.payload.data.companyId), COMPANY_A);
});

test('POST /courts as super_admin with companyId in the query scopes the create', async () => {
  resetState();
  const res = createResponse();
  await postCourts(
    superReq({ query: { companyId: COMPANY_A }, body: { name: 'Cancha Query' } }),
    res,
  );

  assert.equal(res.statusCode, 201);
  assert.equal(norm(res.payload.data.companyId), COMPANY_A);
});

test('POST /courts as an admin without a company returns 400', async () => {
  resetState();
  const res = createResponse();
  await postCourts(adminReq(null, { body: { name: 'Cancha 9' } }), res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.error, 'No tenés una empresa asignada.');
  assert.equal(state.courts.length, 3);
});

// ── PUT /courts/:id ──────────────────────────────────────────────────────────

test('PUT /courts/:id resolves the company from the court and avoids cross-company collisions', async () => {
  resetState();
  const res = createResponse();
  // "Cancha 2" exists only in company B; renaming company A's court must succeed.
  await putCourt(
    superReq({ params: { id: COURT_A1 }, body: { name: 'Cancha 2' } }),
    res,
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.data.name, 'Cancha 2');
  assert.equal(norm(res.payload.data.companyId), COMPANY_A);
});

test('PUT /courts/:id still rejects a duplicate inside the same company', async () => {
  resetState();
  state.courts.push({ _id: COURT_A2, name: 'Cancha A2', companyId: COMPANY_A });
  const res = createResponse();
  await putCourt(
    superReq({ params: { id: COURT_A1 }, body: { name: 'Cancha A2' } }),
    res,
  );

  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.error, 'Ya existe una cancha con ese nombre.');
  assert.equal(
    state.courts.find((court) => court._id === COURT_A1).name,
    'Cancha A1',
  );
});

test('PUT /courts/:id returns 404 for an unknown court', async () => {
  resetState();
  const res = createResponse();
  await putCourt(
    superReq({ params: { id: '64b0000000000000000000ff' }, body: { name: 'X' } }),
    res,
  );

  assert.equal(res.statusCode, 404);
});

test('PUT /courts/:id forbids an admin from editing another company court', async () => {
  resetState();
  const res = createResponse();
  await putCourt(
    adminReq(COMPANY_A, { params: { id: COURT_B1 }, body: { name: 'Hijacked' } }),
    res,
  );

  assert.equal(res.statusCode, 404);
  assert.equal(
    state.courts.find((court) => court._id === COURT_B1).name,
    'Cancha 1',
  );
});

// ── POST /slots ──────────────────────────────────────────────────────────────

test('POST /slots as super_admin without companyId returns 400', async () => {
  resetState();
  const res = createResponse();
  await postSlots(
    superReq({ body: { startTime: '10:00', durationMinutes: 60, price: 100 } }),
    res,
  );

  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.error, 'Especificá la empresa (companyId).');
  assert.equal(state.slots.length, 0);
});

test('POST /slots as super_admin rejects a court from another company', async () => {
  resetState();
  const res = createResponse();
  await postSlots(
    superReq({
      body: {
        startTime: '10:00',
        durationMinutes: 60,
        price: 100,
        companyId: COMPANY_A,
        court: COURT_B1,
      },
    }),
    res,
  );

  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.error, 'La cancha no pertenece a tu club.');
  assert.equal(state.slots.length, 0);
});

test('POST /slots as super_admin scopes the created slot to the resolved company', async () => {
  resetState();
  const res = createResponse();
  await postSlots(
    superReq({
      body: {
        startTime: '10:00',
        durationMinutes: 60,
        price: 18000,
        companyId: COMPANY_A,
        court: COURT_A1,
      },
    }),
    res,
  );

  assert.equal(res.statusCode, 201);
  assert.equal(norm(res.payload.data.companyId), COMPANY_A);
  assert.equal(norm(res.payload.data.court), COURT_A1);
});

// ── POST /club-closures ──────────────────────────────────────────────────────

test('POST /club-closures as super_admin without companyId returns 400', async () => {
  resetState();
  const res = createResponse();
  await postClosures(
    superReq({ body: { startDate: '2026-01-01', endDate: '2026-01-02' } }),
    res,
  );

  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.error, 'Especificá la empresa (companyId).');
  assert.equal(state.closures.length, 0);
});

test('POST /club-closures as super_admin scopes the closure to the resolved company', async () => {
  resetState();
  const res = createResponse();
  await postClosures(
    superReq({
      body: {
        startDate: '2026-01-01',
        endDate: '2026-01-02',
        companyId: COMPANY_B,
      },
    }),
    res,
  );

  assert.equal(res.statusCode, 201);
  assert.equal(norm(res.payload.data.companyId), COMPANY_B);
  assert.equal(state.closures.length, 1);
});
