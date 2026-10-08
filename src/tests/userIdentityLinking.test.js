'use strict';

// Unit tests for the WhatsApp identity resolution that links a Linked-Device id
// (@lid) to a verified client via the exact resolved phone number. Mongoose and
// the worker phone resolver are stubbed so the service runs without a live DB.

const test = require('node:test');
const assert = require('node:assert/strict');

const stubModule = (requestPath, exportsObj) => {
  const resolved = require.resolve(requestPath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsObj,
  };
  return resolved;
};

// ── In-memory User model ─────────────────────────────────────────────────────

const state = {
  users: [],
  calls: { findOne: [], findOneAndUpdate: [] },
};

const cloneUser = (user) =>
  user ? { ...user, whatsappAliases: [...(user.whatsappAliases || [])] } : user;

const matches = (user, query = {}) =>
  Object.entries(query).every(([key, value]) => {
    if (key === 'whatsappAliases') {
      return Array.isArray(user.whatsappAliases) && user.whatsappAliases.includes(value);
    }
    if (value && typeof value === 'object' && '$ne' in value) {
      return user[key] !== value.$ne;
    }
    return user[key] === value;
  });

const applyUpdate = (user, update = {}) => {
  if (update.$set) Object.assign(user, update.$set);
  if (update.$setOnInsert) Object.assign(user, update.$setOnInsert);
  if (update.$addToSet) {
    for (const [key, value] of Object.entries(update.$addToSet)) {
      const list = Array.isArray(user[key]) ? user[key] : [];
      if (!list.includes(value)) list.push(value);
      user[key] = list;
    }
  }
  return user;
};

let seq = 0;
const fakeUserModel = {
  async findOne(query) {
    state.calls.findOne.push(query);
    const found = state.users.find((user) => matches(user, query));
    return cloneUser(found) || null;
  },
  async findOneAndUpdate(query, update, options = {}) {
    state.calls.findOneAndUpdate.push({ query, update, options });
    let user = state.users.find((candidate) => matches(candidate, query));
    if (!user) {
      if (!options.upsert) return null;
      user = { _id: `u-new-${++seq}`, whatsappAliases: [] };
      state.users.push(user);
      applyUpdate(user, update);
      return cloneUser(user);
    }
    applyUpdate(user, update);
    return cloneUser(user);
  },
};

stubModule('../models/user.model', fakeUserModel);

let numberToReturn = '5492622345473';
stubModule('../utils/getNumberByUser', {
  getNumberByUser: async () => numberToReturn,
});

const { getUserByIdentity, saveOrUpdateUser } = require('../services/userService');

const reset = () => {
  state.users = [];
  state.calls.findOne = [];
  state.calls.findOneAndUpdate = [];
};

const seedVerifiedMatias = (overrides = {}) => ({
  _id: 'u1',
  companyId: null,
  whatsappId: '5492622345473@c.us',
  phoneNumber: '5492622345473',
  name: 'Matias perez',
  whatsappAliases: [],
  accountOrigin: 'sistema',
  ...overrides,
});

// ── getUserByIdentity ────────────────────────────────────────────────────────

test('getUserByIdentity resuelve por whatsappId exacto', async () => {
  reset();
  state.users.push(seedVerifiedMatias());

  const user = await getUserByIdentity({
    chatId: '5492622345473@c.us',
    resolvedPhone: '5492622345473',
    companyId: null,
  });

  assert.equal(user._id, 'u1');
  assert.equal(state.calls.findOneAndUpdate.length, 0, 'match exacto no persiste alias');
});

test('getUserByIdentity usa el alias como fallback cuando el teléfono no resuelve', async () => {
  reset();
  state.users.push(seedVerifiedMatias({ whatsappAliases: ['38552364683267@lid'] }));

  const user = await getUserByIdentity({
    chatId: '38552364683267@lid',
    resolvedPhone: '',
    companyId: null,
  });

  assert.equal(user._id, 'u1');
  assert.equal(state.calls.findOneAndUpdate.length, 0, 'alias ya vinculado no reescribe');
});

test('getUserByIdentity prefiere el teléfono autoritativo sobre un alias en conflicto', async () => {
  reset();
  // Usuario A posee el alias X (y un teléfono distinto P1).
  state.users.push(
    seedVerifiedMatias({
      _id: 'uA',
      whatsappId: '5492611111111@c.us',
      phoneNumber: '5492611111111',
      name: 'Usuario A',
      whatsappAliases: ['38552364683267@lid'],
    }),
  );
  // Usuario B posee el teléfono P2.
  state.users.push(
    seedVerifiedMatias({
      _id: 'uB',
      whatsappId: '5492622345473@c.us',
      phoneNumber: '5492622345473',
      name: 'Usuario B',
    }),
  );

  const user = await getUserByIdentity({
    chatId: '38552364683267@lid',
    resolvedPhone: '5492622345473',
    companyId: null,
  });

  assert.equal(user._id, 'uB', 'el teléfono autoritativo debe ganar al alias');
});

test('getUserByIdentity resuelve con teléfono normalizado (sin colapso 54/549)', async () => {
  reset();
  state.users.push(seedVerifiedMatias());

  const user = await getUserByIdentity({
    chatId: '38552364683267@lid',
    resolvedPhone: '+54 9 262 234 5473',
    companyId: null,
  });

  assert.equal(user._id, 'u1', 'normaliza a dígitos conservando el 9 móvil');
  assert.deepEqual(user.whatsappAliases, ['38552364683267@lid']);
});

test('getUserByIdentity no matchea un alias de otra company', async () => {
  reset();
  state.users.push(seedVerifiedMatias({ companyId: 'co-a', whatsappAliases: ['38552364683267@lid'] }));

  const user = await getUserByIdentity({
    chatId: '38552364683267@lid',
    resolvedPhone: '',
    companyId: 'co-b',
  });

  assert.equal(user, null);
});

test('getUserByIdentity NO roba un alias ya poseído por otro usuario de la company', async () => {
  reset();
  // A posee el alias X; B posee el teléfono P2 (al que resuelve el chatId X).
  state.users.push(
    seedVerifiedMatias({
      _id: 'uA',
      whatsappId: '5492611111111@c.us',
      phoneNumber: '5492611111111',
      name: 'Usuario A',
      whatsappAliases: ['38552364683267@lid'],
    }),
  );
  state.users.push(
    seedVerifiedMatias({
      _id: 'uB',
      whatsappId: '5492622345473@c.us',
      phoneNumber: '5492622345473',
      name: 'Usuario B',
    }),
  );

  const user = await getUserByIdentity({
    chatId: '38552364683267@lid',
    resolvedPhone: '5492622345473',
    companyId: null,
  });

  assert.equal(user._id, 'uB');
  const aliasUpdates = state.calls.findOneAndUpdate.filter(
    (call) => call.update?.$addToSet?.whatsappAliases === '38552364683267@lid',
  );
  assert.equal(aliasUpdates.length, 0, 'no debe agregar un alias ya poseído por otro');
  const userB = state.users.find((candidate) => candidate._id === 'uB');
  assert.deepEqual(userB.whatsappAliases, []);
});

test('getUserByIdentity resuelve por resolvedPhone → whatsappId "<phone>@c.us"', async () => {
  reset();
  state.users.push(seedVerifiedMatias());

  const user = await getUserByIdentity({
    chatId: '38552364683267@lid',
    resolvedPhone: '5492622345473',
    companyId: null,
  });

  assert.equal(user._id, 'u1');
  assert.equal(user.whatsappId, '5492622345473@c.us', 'no sobrescribe whatsappId');
  assert.deepEqual(user.whatsappAliases, ['38552364683267@lid']);
});

test('getUserByIdentity resuelve por resolvedPhone → phoneNumber exacto', async () => {
  reset();
  state.users.push(seedVerifiedMatias({ whatsappId: 'otro-id@c.us' }));

  const user = await getUserByIdentity({
    chatId: '38552364683267@lid',
    resolvedPhone: '5492622345473',
    companyId: null,
  });

  assert.equal(user._id, 'u1');
  assert.deepEqual(user.whatsappAliases, ['38552364683267@lid']);
});

test('getUserByIdentity persiste el alias con $addToSet (nunca $set whatsappId)', async () => {
  reset();
  state.users.push(seedVerifiedMatias());

  await getUserByIdentity({
    chatId: '38552364683267@lid',
    resolvedPhone: '5492622345473',
    companyId: null,
  });

  assert.equal(state.calls.findOneAndUpdate.length, 1);
  const { update } = state.calls.findOneAndUpdate[0];
  assert.deepEqual(update, { $addToSet: { whatsappAliases: '38552364683267@lid' } });
  assert.equal('$set' in update, false);
  assert.equal(state.users[0].whatsappId, '5492622345473@c.us');
});

test('getUserByIdentity devuelve null cuando nada coincide', async () => {
  reset();

  const user = await getUserByIdentity({
    chatId: '38552364683267@lid',
    resolvedPhone: '5492622345473',
    companyId: null,
  });

  assert.equal(user, null);
  assert.equal(state.calls.findOneAndUpdate.length, 0);
});

test('getUserByIdentity NO matchea un usuario distinto por colapso 54/549', async () => {
  reset();
  // Mismo número salvo el "9" móvil argentino: el match debe ser exacto.
  state.users.push(seedVerifiedMatias({ whatsappId: '542622345473@c.us', phoneNumber: '542622345473' }));

  const user = await getUserByIdentity({
    chatId: '38552364683267@lid',
    resolvedPhone: '5492622345473',
    companyId: null,
  });

  assert.equal(user, null);
  assert.equal(state.calls.findOneAndUpdate.length, 0);
});

test('getUserByIdentity respeta el scope de companyId', async () => {
  reset();
  state.users.push(seedVerifiedMatias({ companyId: 'co-a' }));

  const otherCompany = await getUserByIdentity({
    chatId: '38552364683267@lid',
    resolvedPhone: '5492622345473',
    companyId: 'co-b',
  });

  assert.equal(otherCompany, null);
});

// ── saveOrUpdateUser ─────────────────────────────────────────────────────────

test('saveOrUpdateUser con @lid que resuelve a teléfono verificado actualiza al existente', async () => {
  reset();
  numberToReturn = '5492622345473';
  state.users.push(seedVerifiedMatias());

  const user = await saveOrUpdateUser('38552364683267@lid', 'Acabo de Sacar Uno', {
    companyId: null,
  });

  assert.equal(state.users.length, 1, 'no debe crear un usuario nuevo');
  assert.equal(user.name, 'Matias perez', 'conserva el nombre registrado');
  assert.equal(user.phoneNumber, '5492622345473');
  assert.equal(user.whatsappId, '5492622345473@c.us');
  assert.deepEqual(user.whatsappAliases, ['38552364683267@lid']);
});

test('saveOrUpdateUser sin teléfono usable y sin usuario existente devuelve null', async () => {
  reset();
  // El worker no resuelve: getNumberByUser devuelve el propio local de un @lid.
  numberToReturn = '38552364683267';

  const user = await saveOrUpdateUser('38552364683267@lid', 'Acabo de Sacar Uno', {
    companyId: null,
  });

  assert.equal(user, null);
  assert.equal(state.users.length, 0, 'nunca crea un User sin teléfono');
  assert.equal(state.calls.findOneAndUpdate.length, 0);
});

test('saveOrUpdateUser crea un usuario nuevo cuando el teléfono es usable', async () => {
  reset();
  numberToReturn = '5492611111111';

  const user = await saveOrUpdateUser('5492611111111@c.us', 'Ana Gomez', { companyId: null });

  assert.equal(state.users.length, 1);
  assert.equal(user.name, 'Ana Gomez');
  assert.equal(user.phoneNumber, '5492611111111');
  assert.equal(user.whatsappId, '5492611111111@c.us');
});
