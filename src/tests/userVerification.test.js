'use strict';

// Integration-ish unit tests for the user controller's verification behavior.
// Mongoose models and the app-config threshold getter are injected through the
// optional `deps` argument so the controller can be exercised without a live
// MongoDB connection.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getUsers,
  updateUser,
  getUserById,
} = require('../controllers/user.controller');

// ── Fakes ───────────────────────────────────────────────────────────────────

const makeRes = () => {
  const res = { statusCode: 200 };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.payload = payload;
    return res;
  };
  return res;
};

const makeUserModel = ({ users = [], currentUser = null, updatedUser = null } = {}) => {
  const findOneDoc = currentUser
    ? { ...currentUser, populate: async () => currentUser }
    : null;
  return {
    find: () => ({ sort: async () => users }),
    findOne: () => findOneDoc,
    findOneAndUpdate: async () => updatedUser || currentUser,
  };
};

const makeClientAccountModel = ({ unlinked = [], linked = [], linkedQueries = { count: 0 } } = {}) => ({
  find: (filter = {}) => {
    if (filter.linkedUserId && filter.linkedUserId.$in) {
      linkedQueries.count += 1;
      return { select: async () => linked };
    }
    return Promise.resolve(unlinked);
  },
  findOne: () => ({
    select: async () => linked[0] || null,
  }),
});

const adminReq = (overrides = {}) => ({
  user: { role: 'admin', companyId: 'co1' },
  query: {},
  body: {},
  params: {},
  ...overrides,
});

// ── getUsers: isVerified ────────────────────────────────────────────────────

test('getUsers expone isVerified=true solo para socios con ClientAccount vinculada', async () => {
  const users = [
    { _id: 'u-1', name: 'Ana', phoneNumber: '5492622517447' },
    { _id: 'u-2', name: 'Bruno', phoneNumber: '5491111222333' },
  ];
  const linkedQueries = { count: 0 };
  const res = makeRes();

  await getUsers(adminReq(), res, {
    UserModel: makeUserModel({ users }),
    ClientAccountModel: makeClientAccountModel({
      linked: [{ linkedUserId: 'u-1' }],
      linkedQueries,
    }),
    getTrustedConfirmationCount: async () => 3,
  });

  const byId = Object.fromEntries(res.payload.data.map((u) => [u._id, u]));
  assert.equal(byId['u-1'].isVerified, true);
  assert.equal(byId['u-2'].isVerified, false);
  assert.equal(linkedQueries.count, 1, 'debe consultar ClientAccount una sola vez');
});

test('getUsers marca isVerified=false cuando no hay cuentas vinculadas', async () => {
  const users = [{ _id: 'u-5', name: 'Carla', phoneNumber: '5492622517447' }];
  const res = makeRes();

  await getUsers(adminReq(), res, {
    UserModel: makeUserModel({ users }),
    ClientAccountModel: makeClientAccountModel({ linked: [] }),
    getTrustedConfirmationCount: async () => 3,
  });

  assert.equal(res.payload.data[0].isVerified, false);
});

test('getUsers marca isVerified=false para ClientAccounts desvinculadas mostradas como socios', async () => {
  const unlinked = [{ _id: 'acc-1', name: 'Google User', phone: '', email: 'g@x.com' }];
  const res = makeRes();

  await getUsers(adminReq(), res, {
    UserModel: makeUserModel({ users: [] }),
    ClientAccountModel: makeClientAccountModel({ unlinked }),
    getTrustedConfirmationCount: async () => 3,
  });

  assert.equal(res.payload.data.length, 1);
  assert.equal(res.payload.data[0].isVerified, false);
  assert.equal(res.payload.data[0].isClientAccount, true);
});

// ── getUserById: isVerified ─────────────────────────────────────────────────

test('getUserById expone isVerified=true cuando existe ClientAccount vinculada', async () => {
  const res = makeRes();

  await getUserById(adminReq({ params: { id: 'u-1' } }), res, {
    UserModel: makeUserModel({ currentUser: { _id: 'u-1', name: 'Ana', phoneNumber: '5492622517447' } }),
    ClientAccountModel: makeClientAccountModel({ linked: [{ linkedUserId: 'u-1' }] }),
    getTrustedConfirmationCount: async () => 3,
    isDepositExemptForCompany: async () => false,
  });

  assert.equal(res.payload.data.isVerified, true);
  assert.equal(res.payload.data.depositExempt, false);
});

// ── updateUser: phone lock ──────────────────────────────────────────────────

test('updateUser rechaza cambiar el teléfono de un socio verificado', async () => {
  const res = makeRes();
  let updateCalled = false;

  await updateUser(
    adminReq({ params: { id: 'u-1' }, body: { phoneNumber: '5491111222333' } }),
    res,
    {
      UserModel: {
        findOne: async () => ({ _id: 'u-1', name: 'Ana', phoneNumber: '5492622517447' }),
        findOneAndUpdate: async () => {
          updateCalled = true;
          return { _id: 'u-1' };
        },
      },
      ClientAccountModel: makeClientAccountModel({ linked: [{ linkedUserId: 'u-1' }] }),
    },
  );

  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.success, false);
  assert.match(res.payload.error, /verificado/i);
  assert.equal(updateCalled, false);
});

test('updateUser permite cambiar el nombre de un socio verificado', async () => {
  const res = makeRes();
  let updateCalled = false;

  await updateUser(
    adminReq({ params: { id: 'u-1' }, body: { name: 'Ana Actualizada' } }),
    res,
    {
      UserModel: {
        findOne: async () => ({ _id: 'u-1', name: 'Ana', phoneNumber: '5492622517447' }),
        findOneAndUpdate: async () => {
          updateCalled = true;
          return { _id: 'u-1', name: 'Ana Actualizada', phoneNumber: '5492622517447' };
        },
      },
      ClientAccountModel: makeClientAccountModel({ linked: [{ linkedUserId: 'u-1' }] }),
    },
  );

  assert.equal(res.statusCode, 200);
  assert.equal(updateCalled, true);
  assert.equal(res.payload.data.name, 'Ana Actualizada');
});

test('updateUser permite reenviar el mismo teléfono verificado en otro formato', async () => {
  const res = makeRes();
  let updateCalled = false;

  await updateUser(
    adminReq({ params: { id: 'u-1' }, body: { phoneNumber: '542622517447' } }),
    res,
    {
      UserModel: {
        findOne: async () => ({ _id: 'u-1', name: 'Ana', phoneNumber: '5492622517447' }),
        findOneAndUpdate: async () => {
          updateCalled = true;
          return { _id: 'u-1', name: 'Ana', phoneNumber: '5492622517447' };
        },
      },
      ClientAccountModel: makeClientAccountModel({ linked: [{ linkedUserId: 'u-1' }] }),
    },
  );

  assert.equal(res.statusCode, 200);
  assert.equal(updateCalled, true);
});

test('updateUser permite cambiar el teléfono de un socio no verificado', async () => {
  const res = makeRes();
  let updateCalled = false;

  await updateUser(
    adminReq({ params: { id: 'u-2' }, body: { phoneNumber: '5491111222333' } }),
    res,
    {
      UserModel: {
        findOne: async () => ({ _id: 'u-2', name: 'Bruno', phoneNumber: '5492622517447' }),
        findOneAndUpdate: async () => {
          updateCalled = true;
          return { _id: 'u-2', name: 'Bruno', phoneNumber: '5491111222333' };
        },
      },
      ClientAccountModel: makeClientAccountModel({ linked: [] }),
    },
  );

  assert.equal(res.statusCode, 200);
  assert.equal(updateCalled, true);
});

test('updateUser devuelve 404 si el socio no existe', async () => {
  const res = makeRes();

  await updateUser(adminReq({ params: { id: 'missing' }, body: { name: 'X' } }), res, {
    UserModel: {
      findOne: async () => null,
      findOneAndUpdate: async () => null,
    },
    ClientAccountModel: makeClientAccountModel({}),
  });

  assert.equal(res.statusCode, 404);
});
