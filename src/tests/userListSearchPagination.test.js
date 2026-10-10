'use strict';

// Unit tests for the optional search + pagination added to GET /api/users.
//
// The pure helpers in ../utils/userListQuery are tested directly (param
// parsing, regex escaping, digits normalization, slice math). The controller
// is exercised with in-memory fakes that apply the same $or/$regex semantics
// `buildSearchCondition` produces, so the combined search path is verified
// without a live MongoDB connection.

const test = require('node:test');
const assert = require('node:assert/strict');

const { getUsers } = require('../controllers/user.controller');
const {
  escapeRegExp,
  parseUserListParams,
  buildSearchCondition,
  paginateUserList,
} = require('../utils/userListQuery');

// ── In-memory matcher (subset of Mongo $or/$regex semantics) ───────────────

const matchesOneField = (value, condition) => {
  if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
    if (condition.$regex !== undefined) {
      return new RegExp(condition.$regex, condition.$options || '').test(
        String(value ?? ''),
      );
    }
    if (condition.$in !== undefined) {
      return condition.$in.some((item) => String(item) === String(value));
    }
  }
  return String(value) === String(condition);
};

const applySearchFilter = (entries, filter = {}) => {
  const { $or } = filter;
  if (!$or) return entries;
  return entries.filter((entry) =>
    $or.some((cond) =>
      Object.entries(cond).every(([key, condition]) =>
        matchesOneField(entry[key], condition),
      ),
    ),
  );
};

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

const makeUserModel = ({ users = [] } = {}) => ({
  find: (filter = {}) => ({
    sort: async () => applySearchFilter(users, filter),
  }),
});

const makeClientAccountModel = ({
  unlinked = [],
  linked = [],
  linkedQueries = { count: 0 },
} = {}) => ({
  find: (filter = {}) => {
    if (filter.linkedUserId && filter.linkedUserId.$in) {
      linkedQueries.count += 1;
      return { select: async () => linked };
    }
    return Promise.resolve(applySearchFilter(unlinked, filter));
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

// ── parseUserListParams ─────────────────────────────────────────────────────

test('parseUserListParams: sin params -> no paginado, defaults', () => {
  const parsed = parseUserListParams({});
  assert.equal(parsed.isPaginated, false);
  assert.equal(parsed.search, '');
  assert.equal(parsed.page, 1);
  assert.equal(parsed.limit, 10);
});

test('parseUserListParams: search activa el modo paginado', () => {
  const parsed = parseUserListParams({ search: '  ana ' });
  assert.equal(parsed.isPaginated, true);
  assert.equal(parsed.search, 'ana');
  assert.equal(parsed.page, 1);
  assert.equal(parsed.limit, 10);
});

test('parseUserListParams: page y limit explícitos', () => {
  const parsed = parseUserListParams({ page: '2', limit: '5' });
  assert.equal(parsed.isPaginated, true);
  assert.equal(parsed.page, 2);
  assert.equal(parsed.limit, 5);
});

test('parseUserListParams: limit fuera de rango cae al default 10', () => {
  const parsed = parseUserListParams({ limit: '999' });
  assert.equal(parsed.isPaginated, true);
  assert.equal(parsed.limit, 10);
});

test('parseUserListParams: page 0 / inválida cae a 1', () => {
  const parsed = parseUserListParams({ page: '0' });
  assert.equal(parsed.isPaginated, true);
  assert.equal(parsed.page, 1);
});

test('parseUserListParams: solo espacios en search no pagina', () => {
  const parsed = parseUserListParams({ search: '   ' });
  assert.equal(parsed.isPaginated, false);
});

// ── buildSearchCondition / escapeRegExp ─────────────────────────────────────

test('buildSearchCondition: sin término devuelve null', () => {
  assert.equal(buildSearchCondition(''), null);
  assert.equal(buildSearchCondition('   '), null);
});

test('buildSearchCondition: nombre por substring case-insensitive', () => {
  const condition = buildSearchCondition('Ana');
  assert.equal(condition.$or.length, 1);
  assert.equal(condition.$or[0].name.$regex, 'Ana');
  assert.equal(condition.$or[0].name.$options, 'i');
});

test('buildSearchCondition: escapa caracteres especiales del nombre', () => {
  const condition = buildSearchCondition('a+b*c');
  assert.equal(condition.$or[0].name.$regex, 'a\\+b\\*c');
});

test('buildSearchCondition: teléfono normalizado a dígitos para User y ClientAccount', () => {
  const condition = buildSearchCondition('2622 517-447');
  assert.equal(condition.$or.length, 3);
  assert.equal(
    condition.$or[1].phoneNumber.$regex,
    '2\\D*6\\D*2\\D*2\\D*5\\D*1\\D*7\\D*4\\D*4\\D*7',
  );
  assert.equal(condition.$or[2].phone.$regex, condition.$or[1].phoneNumber.$regex);
});

test('escapeRegExp neutraliza meta-caracteres', () => {
  assert.equal(escapeRegExp('a.b(c)'), 'a\\.b\\(c\\)');
  assert.equal(escapeRegExp('.*+?^${}()|[]\\'), '\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\');
});

// ── paginateUserList ────────────────────────────────────────────────────────

test('paginateUserList: página 2 de 10 con 25 ítems', () => {
  const combined = Array.from({ length: 25 }, (_, i) => ({ name: `u${i}` }));
  const { items, total } = paginateUserList(combined, 2, 10);
  assert.equal(total, 25);
  assert.equal(items.length, 10);
  assert.equal(items[0].name, 'u10');
  assert.equal(items[9].name, 'u19');
});

test('paginateUserList: última página parcial', () => {
  const combined = Array.from({ length: 25 }, (_, i) => ({ name: `u${i}` }));
  const { items } = paginateUserList(combined, 3, 10);
  assert.equal(items.length, 5);
});

test('paginateUserList: página más allá del final devuelve vacío', () => {
  const combined = [{ name: 'solo' }];
  const { items, total } = paginateUserList(combined, 5, 10);
  assert.equal(total, 1);
  assert.deepEqual(items, []);
});

// ── getUsers: legacy full list (sin params) ─────────────────────────────────

test('getUsers sin params devuelve la lista completa con count, sin total', async () => {
  const res = makeRes();
  const linkedQueries = { count: 0 };

  await getUsers(adminReq(), res, {
    UserModel: makeUserModel({
      users: [
        { _id: 'u-1', name: 'Bruno', phoneNumber: '5492622517447' },
        { _id: 'u-2', name: 'Ana', phoneNumber: '5491111222333' },
      ],
    }),
    ClientAccountModel: makeClientAccountModel({
      unlinked: [{ _id: 'acc-1', name: 'Zoe Google', phone: '', email: 'z@x.com' }],
      linkedQueries,
    }),
    getTrustedConfirmationCount: async () => 3,
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.success, true);
  assert.equal(res.payload.count, 3);
  assert.equal(res.payload.total, undefined);
  assert.deepEqual(
    res.payload.data.map((u) => u.name),
    ['Ana', 'Bruno', 'Zoe Google'],
  );
  assert.equal(res.payload.data[0].isClientAccount, undefined);
  assert.equal(res.payload.data[2].isClientAccount, true);
  assert.equal(linkedQueries.count, 1, 'la consulta de cuentas vinculadas se ejecuta una vez');
});

// ── getUsers: paginación ────────────────────────────────────────────────────

test('getUsers pagina y expone el total de coincidencias', async () => {
  const users = Array.from({ length: 12 }, (_, i) => ({
    _id: `u-${i + 1}`,
    name: `Cliente ${String(i + 1).padStart(2, '0')}`,
    phoneNumber: `5492622${String(i + 1).padStart(2, '0')}000`,
  }));
  const res = makeRes();

  await getUsers(adminReq({ query: { page: '2', limit: '10' } }), res, {
    UserModel: makeUserModel({ users }),
    ClientAccountModel: makeClientAccountModel({}),
    getTrustedConfirmationCount: async () => 3,
  });

  assert.equal(res.payload.success, true);
  assert.equal(res.payload.total, 12);
  assert.equal(res.payload.data.length, 2);
  assert.equal(res.payload.data[0].name, 'Cliente 11');
  assert.equal(res.payload.data[1].name, 'Cliente 12');
});

test('getUsers enrriquece solo el slice devuelto', async () => {
  const users = Array.from({ length: 12 }, (_, i) => ({
    _id: `u-${i + 1}`,
    name: `Cliente ${String(i + 1).padStart(2, '0')}`,
    phoneNumber: `5492622${String(i + 1).padStart(2, '0')}000`,
  }));
  const linkedQueries = { count: 0 };
  const res = makeRes();

  await getUsers(adminReq({ query: { page: '2', limit: '10' } }), res, {
    UserModel: makeUserModel({ users }),
    ClientAccountModel: makeClientAccountModel({
      linked: [{ linkedUserId: 'u-11' }],
      linkedQueries,
    }),
    getTrustedConfirmationCount: async () => 3,
  });

  assert.equal(linkedQueries.count, 1);
  const byId = Object.fromEntries(res.payload.data.map((u) => [u._id, u]));
  assert.equal(byId['u-11'].isVerified, true);
  assert.equal(byId['u-12'].isVerified, false);
});

// ── getUsers: búsqueda ──────────────────────────────────────────────────────

test('getUsers filtra por nombre case-insensitive sobre ambas fuentes', async () => {
  const res = makeRes();

  await getUsers(adminReq({ query: { search: 'ana' } }), res, {
    UserModel: makeUserModel({
      users: [
        { _id: 'u-1', name: 'Ana', phoneNumber: '5491111222333' },
        { _id: 'u-2', name: 'Bruna', phoneNumber: '5492622517447' },
      ],
    }),
    ClientAccountModel: makeClientAccountModel({
      unlinked: [{ _id: 'acc-1', name: 'Anabel Google', phone: '', email: 'a@x.com' }],
    }),
    getTrustedConfirmationCount: async () => 3,
  });

  assert.equal(res.payload.success, true);
  assert.deepEqual(
    res.payload.data.map((u) => u.name),
    ['Ana', 'Anabel Google'],
  );
  assert.equal(res.payload.total, 2);
});

test('getUsers filtra por dígitos de teléfono tolerando separadores en el almacenado', async () => {
  const res = makeRes();

  await getUsers(adminReq({ query: { search: '2622 51-7447' } }), res, {
    UserModel: makeUserModel({
      users: [
        { _id: 'u-1', name: 'Carlos', phoneNumber: '5492622517447' },
        { _id: 'u-2', name: 'Dora', phoneNumber: '5491111222333' },
      ],
    }),
    ClientAccountModel: makeClientAccountModel({
      unlinked: [{ _id: 'acc-1', name: 'Elena Google', phone: '+54 9 2622 517-447', email: 'e@x.com' }],
    }),
    getTrustedConfirmationCount: async () => 3,
  });

  assert.deepEqual(
    res.payload.data.map((u) => u.name),
    ['Carlos', 'Elena Google'],
  );
  assert.equal(res.payload.total, 2);
});

test('getUsers escapa meta-caracteres del término de búsqueda', async () => {
  const res = makeRes();

  await getUsers(adminReq({ query: { search: 'ana.' } }), res, {
    UserModel: makeUserModel({
      users: [
        { _id: 'u-1', name: 'Ana.', phoneNumber: '5491111222333' },
        { _id: 'u-2', name: 'AnaX', phoneNumber: '5492622517447' },
      ],
    }),
    ClientAccountModel: makeClientAccountModel({}),
    getTrustedConfirmationCount: async () => 3,
  });

  assert.equal(res.payload.total, 1);
  assert.equal(res.payload.data[0].name, 'Ana.');
});