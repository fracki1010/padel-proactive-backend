'use strict';

// Per-company deposit exemption (seña exemption): storage + admin endpoint.
// - storage: canonicalPhoneKey funnel on write AND read (54/549 match),
//   atomic $addToSet/$pull semantics, per-company isolation, empty phone
//   rejection and missing-array tolerance on reads
// - endpoint: PUT /api/users/:id/deposit-exempt (admin/super_admin only,
//   company-scoped, idempotent) + depositExempt in the user detail payload
//
// The AppConfig model is replaced with an in-memory fake (options.model) so no
// database connection is needed.

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-deposit-exemption';

const {
  canonicalPhoneKey,
} = require('../services/clientVerification.service');
const {
  isPhoneExempt,
  isDepositExempt,
  getDepositExemptPhones,
  addDepositExemptPhone,
  removeDepositExemptPhone,
  getDepositSettings,
} = require('../services/appConfig.service');

const COMPANY_A = '64b0000000000000000000a1';
const COMPANY_B = '64b0000000000000000000b2';
const PHONE_549 = '5491100000000';
const PHONE_54 = '541100000000';
const PHONE_B = '5492200000000';
const USER_A_ID = '64b0000000000000000000f1';
const USER_B_ID = '64b0000000000000000000f2';
const MISSING_USER_ID = '64b0000000000000000000ff';

// In-memory AppConfig fake honouring the $addToSet/$pull semantics the service
// depends on (plus upsert for adds). Docs are keyed by companyId.
const makeFakeConfigModel = () => {
  const docs = new Map();

  const model = {
    calls: { findOne: [], findOneAndUpdate: [] },

    setDoc(companyId, doc) {
      docs.set(String(companyId), { key: 'main', depositExemptPhones: [], ...doc });
    },

    getDoc(companyId) {
      return docs.get(String(companyId)) || null;
    },

    async findOne(filter) {
      model.calls.findOne.push(filter);
      const doc = docs.get(String(filter.companyId)) || null;
      return doc ? { ...doc } : null;
    },

    async findOneAndUpdate(filter, update, options = {}) {
      model.calls.findOneAndUpdate.push({ filter, update, options });
      const key = String(filter.companyId);
      let doc = docs.get(key);
      if (!doc) {
        if (!options.upsert) return null;
        doc = { companyId: filter.companyId, key: 'main', depositExemptPhones: [] };
        docs.set(key, doc);
      }
      for (const [field, value] of Object.entries(update.$addToSet || {})) {
        if (!Array.isArray(doc[field])) doc[field] = [];
        if (!doc[field].includes(value)) doc[field].push(value);
      }
      for (const [field, value] of Object.entries(update.$pull || {})) {
        if (Array.isArray(doc[field])) {
          doc[field] = doc[field].filter((item) => item !== value);
        }
      }
      return { ...doc };
    },
  };

  return model;
};

// ── Canonical funnel on write (spec: deposit-exemption-storage) ──────────────

test('a 54-variant phone is canonicalized to its 549 key on write', async () => {
  const model = makeFakeConfigModel();

  const list = await addDepositExemptPhone(COMPANY_A, PHONE_54, { model });

  assert.deepEqual(list, [PHONE_549]);
  assert.deepEqual(model.getDoc(COMPANY_A).depositExemptPhones, [PHONE_549]);
  assert.equal(canonicalPhoneKey(PHONE_54), PHONE_549);
});

test('adding the same phone twice stores a single entry ($addToSet)', async () => {
  const model = makeFakeConfigModel();

  await addDepositExemptPhone(COMPANY_A, PHONE_549, { model });
  await addDepositExemptPhone(COMPANY_A, PHONE_549, { model });

  assert.deepEqual(model.getDoc(COMPANY_A).depositExemptPhones, [PHONE_549]);
});

test('adding both the 54 and 549 variants still stores a single canonical key', async () => {
  const model = makeFakeConfigModel();

  await addDepositExemptPhone(COMPANY_A, PHONE_54, { model });
  await addDepositExemptPhone(COMPANY_A, PHONE_549, { model });

  assert.deepEqual(model.getDoc(COMPANY_A).depositExemptPhones, [PHONE_549]);
});

// ── Canonical funnel on read (spec: deposit-exemption-edge-cases) ────────────

test('a 549 booking matches an exemption stored from the 54 variant', async () => {
  const model = makeFakeConfigModel();

  await addDepositExemptPhone(COMPANY_A, PHONE_54, { model });

  // Read funnel: the stored 54 variant is canonicalized on read, so a 549
  // booking is exempt. The pure helper canonicalizes both sides of the match.
  assert.equal(await isDepositExempt(COMPANY_A, PHONE_549, { model }), true);
  assert.equal(isPhoneExempt([PHONE_54], PHONE_549), true);
  assert.equal(isPhoneExempt([PHONE_549], PHONE_54), true);
  assert.equal(isPhoneExempt([PHONE_549], PHONE_549), true);
});

// ── Atomic remove (spec: deposit-exemption-storage) ──────────────────────────

test('removing a phone leaves the other exemptions untouched', async () => {
  const model = makeFakeConfigModel();
  model.setDoc(COMPANY_A, { depositExemptPhones: [PHONE_549, PHONE_B] });

  const list = await removeDepositExemptPhone(COMPANY_A, PHONE_549, { model });

  assert.deepEqual(list, [PHONE_B]);
  assert.equal(await isDepositExempt(COMPANY_A, PHONE_549, { model }), false);
  assert.equal(await isDepositExempt(COMPANY_A, PHONE_B, { model }), true);
});

test('removing a phone that is not exempt is a no-op', async () => {
  const model = makeFakeConfigModel();
  model.setDoc(COMPANY_A, { depositExemptPhones: [PHONE_B] });

  const list = await removeDepositExemptPhone(COMPANY_A, PHONE_549, { model });

  assert.deepEqual(list, [PHONE_B]);
  assert.equal(model.calls.findOneAndUpdate.length, 1);
});

// ── Per-company isolation (spec: deposit-exemption-storage/edge-cases) ───────

test('exemption is isolated per company for the same phone', async () => {
  const model = makeFakeConfigModel();
  await addDepositExemptPhone(COMPANY_A, PHONE_549, { model });

  assert.equal(await isDepositExempt(COMPANY_A, PHONE_549, { model }), true);
  assert.equal(await isDepositExempt(COMPANY_B, PHONE_549, { model }), false);
});

// ── Empty/unknown phone rejected (spec: deposit-exemption-storage) ───────────

test('an empty phone is rejected on add and the list is unchanged', async () => {
  const model = makeFakeConfigModel();
  model.setDoc(COMPANY_A, { depositExemptPhones: [PHONE_549] });

  await assert.rejects(
    addDepositExemptPhone(COMPANY_A, '', { model }),
    (error) => error.statusCode === 400,
  );
  await assert.rejects(
    removeDepositExemptPhone(COMPANY_A, '  ', { model }),
    (error) => error.statusCode === 400,
  );

  assert.deepEqual(model.getDoc(COMPANY_A).depositExemptPhones, [PHONE_549]);
});

test('a canonical key shorter than 7 digits is rejected on add', async () => {
  const model = makeFakeConfigModel();
  model.setDoc(COMPANY_A, { depositExemptPhones: [PHONE_549] });

  await assert.rejects(
    addDepositExemptPhone(COMPANY_A, '123456', { model }),
    (error) => error.statusCode === 400,
  );

  assert.deepEqual(model.getDoc(COMPANY_A).depositExemptPhones, [PHONE_549]);
  assert.equal(model.calls.findOneAndUpdate.length, 0);
});

// ── Missing-array tolerance (spec: read-set tolerance) ───────────────────────

test('isPhoneExempt returns false for a missing or non-array phone list', () => {
  assert.equal(isPhoneExempt(undefined, PHONE_549), false);
  assert.equal(isPhoneExempt(null, PHONE_549), false);
  assert.equal(isPhoneExempt(PHONE_549, PHONE_549), false);
  assert.equal(isPhoneExempt([], PHONE_549), false);
  assert.equal(isPhoneExempt(['5491100000000'], PHONE_549), true);
});

test('getDepositExemptPhones tolerates a missing field and unknown companies', async () => {
  const model = makeFakeConfigModel();
  model.setDoc(COMPANY_A, {});

  assert.deepEqual(await getDepositExemptPhones(COMPANY_A, { model }), []);
  assert.deepEqual(await getDepositExemptPhones(COMPANY_B, { model }), []);
});

test('getDepositSettings returns the canonicalized exempt phone list', async () => {
  const model = makeFakeConfigModel();
  model.setDoc(COMPANY_A, {
    depositEnabled: true,
    depositAmount: 5000,
    holdMinutes: 15,
    depositExemptPhones: [PHONE_54],
  });

  const settings = await getDepositSettings(COMPANY_A, { model });

  assert.equal(settings.depositEnabled, true);
  assert.equal(settings.depositAmount, 5000);
  assert.equal(settings.holdMinutes, 15);
  assert.deepEqual(settings.depositExemptPhones, [PHONE_549]);
});

test('getDepositSettings defaults the exempt list to empty when unset', async () => {
  const model = makeFakeConfigModel();

  const settings = await getDepositSettings(COMPANY_A, { model });

  assert.deepEqual(settings.depositExemptPhones, []);
});

// ── Admin endpoint (spec: deposit-exemption-admin-api) ───────────────────────

const userRouter = require('../routes/user.routes');
const {
  setDepositExemption,
  getUserById,
} = require('../controllers/user.controller');

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

const runMiddleware = (middleware, req, res) => {
  let nextCalled = false;
  middleware(req, res, () => {
    nextCalled = true;
  });
  return nextCalled;
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

const makeUser = (overrides = {}) => ({
  _id: USER_A_ID,
  companyId: COMPANY_A,
  phoneNumber: PHONE_549,
  name: 'Ana',
  ...overrides,
});

// Mongoose-query-like thenable: `findOne(...)` supports `.populate()` chains
// and can be awaited directly; a filter mismatch resolves to null (404 path).
const makeUserModel = (users) => {
  const store = new Map(users.map((user) => [String(user._id), user]));
  const emptyChain = () => {
    const chain = { populate: () => chain, then: (resolve) => resolve(null) };
    return chain;
  };
  return {
    findOne(filter) {
      writeState.userFindCalls.push(filter);
      const user = store.get(String(filter._id)) || null;
      const outOfCompany =
        user &&
        filter.companyId &&
        String(user.companyId) !== String(filter.companyId);
      if (!user || outOfCompany) return emptyChain();
      const resolved = { ...user, toObject: () => ({ ...user }) };
      const chain = {
        populate: () => chain,
        then: (resolve) => resolve(resolved),
      };
      return chain;
    },
  };
};

const fakeClientAccountModel = {
  findOne: () => ({ select: async () => null }),
};

const writeState = { addCalls: [], removeCalls: [], userFindCalls: [] };
const resetWrites = () => {
  writeState.addCalls = [];
  writeState.removeCalls = [];
  writeState.userFindCalls = [];
};
const makeDeps = (users) => ({
  UserModel: makeUserModel(users),
  addExemptPhone: async (companyId, phone) => {
    writeState.addCalls.push({ companyId, phone });
  },
  removeExemptPhone: async (companyId, phone) => {
    writeState.removeCalls.push({ companyId, phone });
  },
});

// -- Route contract + authorization --

test('PUT /users/:id/deposit-exempt exists behind an authz middleware', () => {
  const handlers = getHandlers(userRouter, '/:id/deposit-exempt', 'put');
  assert.ok(handlers.length >= 2, 'the route must carry an authz middleware');
});

test('the deposit-exempt route rejects a client token with 403', () => {
  const authz = getHandlers(userRouter, '/:id/deposit-exempt', 'put')[0];
  const res = createResponse();

  const allowed = runMiddleware(
    authz,
    { user: { type: 'client', companyId: COMPANY_A } },
    res,
  );

  assert.equal(allowed, false);
  assert.equal(res.captured.statusCode, 403);
});

test('admin and super_admin roles pass the deposit-exempt authz gate', () => {
  const authz = getHandlers(userRouter, '/:id/deposit-exempt', 'put')[0];

  assert.equal(
    runMiddleware(
      authz,
      { user: { role: 'admin', companyId: COMPANY_A } },
      createResponse(),
    ),
    true,
  );
  assert.equal(
    runMiddleware(authz, { user: { role: 'super_admin' } }, createResponse()),
    true,
  );
});

// -- Handler behavior --

test('an admin can enable the exemption for a user in their company', async () => {
  resetWrites();
  const res = createResponse();

  await setDepositExemption(
    {
      params: { id: USER_A_ID },
      body: { enabled: true },
      user: { role: 'admin', companyId: COMPANY_A },
    },
    res,
    makeDeps([makeUser()]),
  );

  assert.equal(res.captured.statusCode, 200);
  assert.deepEqual(res.captured.body, {
    success: true,
    data: { depositExempt: true },
  });
  assert.deepEqual(writeState.addCalls, [
    { companyId: COMPANY_A, phone: PHONE_549 },
  ]);
  assert.equal(writeState.removeCalls.length, 0);
});

test('an admin can disable the exemption (idempotent toggle)', async () => {
  resetWrites();
  const res = createResponse();

  await setDepositExemption(
    {
      params: { id: USER_A_ID },
      body: { enabled: false },
      user: { role: 'admin', companyId: COMPANY_A },
    },
    res,
    makeDeps([makeUser()]),
  );

  assert.equal(res.captured.statusCode, 200);
  assert.deepEqual(res.captured.body.data, { depositExempt: false });
  assert.deepEqual(writeState.removeCalls, [
    { companyId: COMPANY_A, phone: PHONE_549 },
  ]);
  assert.equal(writeState.addCalls.length, 0);
});

test('enabling twice returns 200 both times without diverging', async () => {
  resetWrites();
  const deps = makeDeps([makeUser()]);
  const req = {
    params: { id: USER_A_ID },
    body: { enabled: true },
    user: { role: 'admin', companyId: COMPANY_A },
  };

  const first = createResponse();
  await setDepositExemption(req, first, deps);
  const second = createResponse();
  await setDepositExemption(req, second, deps);

  assert.equal(first.captured.statusCode, 200);
  assert.equal(second.captured.statusCode, 200);
  assert.deepEqual(second.captured.body, first.captured.body);
});

test('a missing or non-boolean enabled is rejected with 400 and no write', async () => {
  for (const body of [{}, { enabled: 'yes' }, { enabled: 1 }, { enabled: null }]) {
    resetWrites();
    const res = createResponse();

    await setDepositExemption(
      {
        params: { id: USER_A_ID },
        body,
        user: { role: 'admin', companyId: COMPANY_A },
      },
      res,
      makeDeps([makeUser()]),
    );

    assert.equal(res.captured.statusCode, 400, `body ${JSON.stringify(body)}`);
    assert.equal(writeState.addCalls.length, 0);
    assert.equal(writeState.removeCalls.length, 0);
  }
});

test('a user without a canonical phone cannot be exempted (400)', async () => {
  resetWrites();
  const res = createResponse();

  await setDepositExemption(
    {
      params: { id: USER_A_ID },
      body: { enabled: true },
      user: { role: 'admin', companyId: COMPANY_A },
    },
    res,
    makeDeps([makeUser({ phoneNumber: '' })]),
  );

  assert.equal(res.captured.statusCode, 400);
  assert.equal(writeState.addCalls.length, 0);
});

test('an admin cannot exempt a user from another company (404)', async () => {
  resetWrites();
  const res = createResponse();

  await setDepositExemption(
    {
      params: { id: USER_B_ID },
      body: { enabled: true },
      user: { role: 'admin', companyId: COMPANY_A },
    },
    res,
    makeDeps([makeUser({ _id: USER_B_ID, companyId: COMPANY_B })]),
  );

  assert.equal(res.captured.statusCode, 404);
  assert.equal(writeState.addCalls.length, 0);
});

test('an unknown user returns 404 without writing', async () => {
  resetWrites();
  const res = createResponse();

  await setDepositExemption(
    {
      params: { id: MISSING_USER_ID },
      body: { enabled: true },
      user: { role: 'admin', companyId: COMPANY_A },
    },
    res,
    makeDeps([makeUser()]),
  );

  assert.equal(res.captured.statusCode, 404);
  assert.equal(writeState.addCalls.length, 0);
});

test('a malformed user id is rejected with 400 before any query', async () => {
  resetWrites();
  const res = createResponse();

  await setDepositExemption(
    {
      params: { id: 'not-an-id' },
      body: { enabled: true },
      user: { role: 'admin', companyId: COMPANY_A },
    },
    res,
    makeDeps([makeUser()]),
  );

  assert.equal(res.captured.statusCode, 400);
  assert.equal(writeState.userFindCalls.length, 0, 'must not query with an invalid id');
  assert.equal(writeState.addCalls.length, 0);
});

test('a too-short phone is rejected with 400 and nothing is persisted', async () => {
  resetWrites();
  const model = makeFakeConfigModel();
  const res = createResponse();

  await setDepositExemption(
    {
      params: { id: USER_A_ID },
      body: { enabled: true },
      user: { role: 'admin', companyId: COMPANY_A },
    },
    res,
    {
      UserModel: makeUserModel([makeUser({ phoneNumber: '123456' })]),
      addExemptPhone: (companyId, phone) =>
        addDepositExemptPhone(companyId, phone, { model }),
      removeExemptPhone: (companyId, phone) =>
        removeDepositExemptPhone(companyId, phone, { model }),
    },
  );

  assert.equal(res.captured.statusCode, 400);
  assert.equal(model.getDoc(COMPANY_A), null, 'no AppConfig may be created');
});

test('a super_admin writes the exemption to the target user company', async () => {
  resetWrites();
  const res = createResponse();

  await setDepositExemption(
    {
      params: { id: USER_B_ID },
      body: { enabled: true },
      query: {},
      user: { role: 'super_admin' },
    },
    res,
    makeDeps([makeUser({ _id: USER_B_ID, companyId: COMPANY_B })]),
  );

  assert.equal(res.captured.statusCode, 200);
  assert.deepEqual(writeState.addCalls, [
    { companyId: COMPANY_B, phone: PHONE_549 },
  ]);
});

// -- Detail payload --

test('GET /api/users/:id exposes depositExempt from the AppConfig', async () => {
  const res = createResponse();

  await getUserById(
    { params: { id: USER_A_ID }, user: { role: 'admin', companyId: COMPANY_A } },
    res,
    {
      UserModel: makeUserModel([makeUser()]),
      ClientAccountModel: fakeClientAccountModel,
      getTrustedConfirmationCount: async () => 3,
      isDepositExemptForCompany: async () => true,
    },
  );

  assert.equal(res.captured.statusCode, 200);
  assert.equal(res.captured.body.data.depositExempt, true);
  assert.equal(res.captured.body.data.isVerified, false);
});

test('GET /api/users/:id reports depositExempt false for a non-exempt phone', async () => {
  const res = createResponse();

  await getUserById(
    { params: { id: USER_A_ID }, user: { role: 'admin', companyId: COMPANY_A } },
    res,
    {
      UserModel: makeUserModel([makeUser()]),
      ClientAccountModel: fakeClientAccountModel,
      getTrustedConfirmationCount: async () => 3,
      isDepositExemptForCompany: async () => false,
    },
  );

  assert.equal(res.captured.statusCode, 200);
  assert.equal(res.captured.body.data.depositExempt, false);
});