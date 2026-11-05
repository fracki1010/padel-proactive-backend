'use strict';

// ClubClosure enforcement on EVERY booking surface, not just the public portal.
// A closure is stored as an inclusive YYYY-MM-DD range (startDate/endDate), so a
// date is closed when startDate <= date <= endDate. These tests exercise the
// shared helper and each surface (admin create/update, bot create/availability,
// fixed-turn materialization, public slot lock) against hand-rolled model
// doubles. No MongoDB is opened; the resolver reads from `state.closures`.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const hexId = (value) => value.toString(16).padStart(24, '0');
const COMPANY = hexId(0xaa);
const COMPANY_B = hexId(0xab);
const COURT_ID = hexId(0xc1);
const COURT_ID2 = hexId(0xc2);
const SLOT_ID = hexId(0xd1);
const CLIENT_ID = hexId(0xe1);

const CLOSED_START = '2099-02-10';
const CLOSED_END = '2099-02-12';
const OPEN_DATE = '2099-02-13';

const state = {
  closures: [],
  bookings: [],
  courts: [],
  timeSlots: [],
  users: [],
  fixedTurns: [],
  tournaments: [],
  companies: [],
  materializeCalls: 0,
  userFindCalls: 0,
  lockAcquires: 0,
  adminNotifications: 0,
  updateTarget: null,
  updateCalls: 0,
  mongoConnected: true,
};

const resetState = () => {
  state.closures = [
    {
      _id: hexId(0xe2),
      companyId: COMPANY,
      startDate: CLOSED_START,
      endDate: CLOSED_END,
      reason: 'Mantenimiento',
    },
  ];
  state.bookings = [];
  state.courts = [
    { _id: COURT_ID, companyId: COMPANY, name: 'Cancha 1', courtType: null, isActive: true },
    { _id: COURT_ID2, companyId: COMPANY, name: 'Cancha 2', courtType: null, isActive: true },
  ];
  state.timeSlots = [
    {
      _id: SLOT_ID,
      companyId: COMPANY,
      court: null,
      startTime: '20:00',
      endTime: '21:00',
      price: 25000,
      isActive: true,
    },
  ];
  state.users = [];
  state.fixedTurns = [];
  state.tournaments = [];
  state.companies = [{ _id: COMPANY, slug: 'club', isActive: true, name: 'Club Demo' }];
  state.materializeCalls = 0;
  state.userFindCalls = 0;
  state.lockAcquires = 0;
  state.adminNotifications = 0;
  state.updateTarget = null;
  state.updateCalls = 0;
  state.mongoConnected = true;
};

// ── Model double helpers ─────────────────────────────────────────────────────

const norm = (value) => {
  if (value === undefined || value === null) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
};

const compare = (left, right) => {
  const a = norm(left);
  const b = norm(right);
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
};

const isOperator = (value) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  !(value instanceof Date) &&
  Object.keys(value).some((key) => key.startsWith('$'));

const matches = (doc, filter = {}) =>
  Object.entries(filter).every(([key, value]) => {
    const actual = doc[key];
    if (isOperator(value)) {
      if ('$regex' in value) return value.$regex.test(String(actual));
      if ('$in' in value) return value.$in.some((item) => norm(actual) === norm(item));
      if ('$ne' in value) return norm(actual) !== norm(value.$ne);
      if ('$gte' in value) return compare(actual, value.$gte) >= 0;
      if ('$lte' in value) return compare(actual, value.$lte) <= 0;
      if ('$gt' in value) return compare(actual, value.$gt) > 0;
      if ('$lt' in value) return compare(actual, value.$lt) < 0;
    }
    return norm(actual) === norm(value);
  });

const makeQuery = (items) => {
  const query = {
    select: () => query,
    sort: () => query,
    populate: () => query,
    lean: () => items,
    then: (onFulfilled, onRejected) => Promise.resolve(items).then(onFulfilled, onRejected),
    catch: (onRejected) => Promise.resolve(items).catch(onRejected),
  };
  return query;
};

const resolveChain = (doc) => {
  const chain = {
    populate: () => chain,
    then: (onFulfilled, onRejected) => Promise.resolve(doc).then(onFulfilled, onRejected),
    catch: (onRejected) => Promise.resolve(doc).catch(onRejected),
  };
  return chain;
};

// Awaitable single-document query: supports `await findOne()` and `.lean()`.
const resolveOneQuery = (doc) => ({
  lean: async () => doc,
  then: (onFulfilled, onRejected) => Promise.resolve(doc).then(onFulfilled, onRejected),
  catch: (onRejected) => Promise.resolve(doc).catch(onRejected),
});

const createModel = (key, { onCreate } = {}) => ({
  find: (filter = {}) => makeQuery(state[key].filter((doc) => matches(doc, filter))),
  findOne: (filter = {}) =>
    resolveOneQuery(state[key].find((doc) => matches(doc, filter)) || null),
  exists: async (filter = {}) => Boolean(state[key].find((doc) => matches(doc, filter))),
  countDocuments: async (filter = {}) => state[key].filter((doc) => matches(doc, filter)).length,
  create: async (doc) => {
    const created = { _id: hexId(0x1000 + state[key].length), ...doc };
    created.populate = async () => created;
    state[key].push(created);
    if (onCreate) onCreate(created);
    return created;
  },
});

const stubModule = (requestPath, exportsObj) => {
  const resolved = require.resolve(requestPath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsObj,
  };
};

beforeEach(resetState);
resetState();

stubModule('../config/database', {
  isMongoConnected: () => state.mongoConnected,
});
stubModule('../models/tournament.model', createModel('tournaments'));
stubModule('../models/court.model', {
  ...createModel('courts'),
  COURT_TYPES: ['Techada', 'VIP'],
});
stubModule('../models/fixedBooking.model', createModel('fixedTurns'));
stubModule('../models/company.model', {
  findOne: async (filter = {}) =>
    state.companies.find((company) => matches(company, filter)) || null,
});
stubModule('../models/clientAccount.model', {
  findById: async () => ({
    _id: CLIENT_ID,
    companyId: COMPANY,
    name: 'Ana',
    phone: '5491100000000',
    isActive: true,
  }),
});
stubModule('../models/admin.model', {
  find: () => ({ select: () => ({ lean: async () => [] }) }),
});
stubModule('../models/clubClosure.model', {
  findOne: async (filter = {}) =>
    state.closures.find((closure) => matches(closure, filter)) || null,
});

const bookingModel = createModel('bookings');
bookingModel.findOne = () =>
  state.updateTarget ? resolveChain({ ...state.updateTarget }) : null;
bookingModel.findById = () => {
  const created = state.bookings[state.bookings.length - 1] || {};
  const populated = {
    ...created,
    court: state.courts[0],
    timeSlot: state.timeSlots[0],
    toObject() {
      return { ...this };
    },
  };
  return resolveChain(populated);
};
bookingModel.findOneAndUpdate = () => {
  state.updateCalls += 1;
  return resolveChain({ ...(state.updateTarget || {}) });
};
stubModule('../models/booking.model', bookingModel);

const userModel = createModel('users');
userModel.find = () => {
  state.userFindCalls += 1;
  return makeQuery(state.users);
};
userModel.findOne = async () => null;
stubModule('../models/user.model', userModel);
stubModule('../models/timeSlot.model', createModel('timeSlots'));

// ── Service doubles ──────────────────────────────────────────────────────────

const realSlotLockService = require('../services/slotLock.service');

stubModule('../services/slotLock.service', {
  ...realSlotLockService,
  createMongooseSlotLockStore: () => ({
    findActiveLocksForDate: async () => [],
    deleteLocksForSlot: async () => ({ deletedCount: 0 }),
  }),
  acquireSlotLock: async () => {
    state.lockAcquires += 1;
    return {
      ok: true,
      lock: { _id: 'lock-1' },
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    };
  },
});
stubModule('../services/fixedBooking.service', {
  findConflictingFixedForBooking: async () => null,
  getWeekdayFromDate: (value) =>
    (value instanceof Date ? value : new Date(value)).getUTCDay(),
});
stubModule('../services/appConfig.service', {
  getBookingsPaused: async () => false,
  getDepositSettings: async () => ({
    depositEnabled: false,
    depositAmount: 0,
    holdMinutes: 15,
    depositExemptPhones: [],
    depositMethod: 'transfer',
    depositAlias: '',
    depositCbu: '',
    depositHolder: '',
  }),
  getCancellationLockHours: async () => 0,
  getPenaltyLimit: async () => 2,
  getPenaltySystemEnabled: async () => false,
  isPhoneExempt: () => false,
});
stubModule('../services/notificationService', {
  sendAdminNotification: async () => {
    state.adminNotifications += 1;
  },
});
stubModule('../services/deposit.service', {
  buildDepositFields: () => ({}),
  buildDepositPaymentLink: async () => ({ initPoint: '' }),
  approveDepositManually: async () => ({}),
  handleDepositPaid: async () => ({}),
  markRefundableOnCancel: () => ({ refundable: false, deposit: null }),
});
stubModule('../services/depositNotification.service', {
  notifyDepositPending: async () => {},
});
stubModule('../services/bookingWhatsappConfirmation.service', {
  sendBookingWhatsappConfirmation: async () => ({ ok: true }),
});
stubModule('../services/whatsappCommandQueue.service', {
  COMMAND_TYPES: {
    SEND_MESSAGE: 'SEND_MESSAGE',
    NOTIFY_CANCELLATION_GROUP: 'NOTIFY_CANCELLATION_GROUP',
  },
  enqueueWhatsappCommand: async () => ({ command: { _id: 'cmd-x' } }),
});
stubModule('../services/whatsappRuntimeState.service', {
  getWhatsappRuntimeState: async () => ({ phone: '' }),
});

// ── Modules under test ───────────────────────────────────────────────────────

const { isClubClosedForDate } = require('../services/clubClosure.service');
const bookingService = require('../services/bookingService');
const {
  createBooking,
  updateBooking,
  getBookings,
  rematerializeFixedTurns,
} = require('../controllers/booking.controller');
const publicController = require('../controllers/public.controller');
const {
  materializeFixedBookingsForDate,
  materializeFixedBookingsInRange,
} = require('../services/fixedTurnsMaterialization.service');
const {
  buildBookingReplyText,
  buildAvailabilityResponse,
} = require('../handlers/messageHandler');
const { toIsoDateString } = require('../utils/isoDate');
const ClubClosure = require('../models/clubClosure.model');

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

const call = async (handler, req) => {
  const res = createResponse();
  await handler(req, res);
  return res;
};

const closedWeekday = () => new Date(`${CLOSED_START}T00:00:00.000Z`).getUTCDay();
const openWeekday = () => new Date(`${OPEN_DATE}T00:00:00.000Z`).getUTCDay();

const seedFixedTurnUser = (dayOfWeek) => {
  state.users = [
    {
      _id: hexId(0xaa1),
      companyId: COMPANY,
      name: 'Fija',
      phoneNumber: '5491100000000',
      whatsappId: '5491100000000@c.us',
      fixedTurns: [
        {
          dayOfWeek,
          court: { _id: COURT_ID, name: 'Cancha 1' },
          timeSlot: { _id: SLOT_ID, startTime: '20:00', endTime: '21:00', price: 25000 },
        },
      ],
    },
  ];
};

// ── Shared helper: inclusive range semantics ─────────────────────────────────

test('isClubClosedForDate blocks the startDate and endDate inclusively', async () => {
  const start = await isClubClosedForDate(COMPANY, CLOSED_START);
  assert.deepEqual(start, { closed: true, reason: 'Mantenimiento' });

  const end = await isClubClosedForDate(COMPANY, CLOSED_END);
  assert.deepEqual(end, { closed: true, reason: 'Mantenimiento' });

  const middle = await isClubClosedForDate(COMPANY, '2099-02-11');
  assert.equal(middle.closed, true);
});

test('isClubClosedForDate keeps adjacent days open and accepts Date or string', async () => {
  assert.equal((await isClubClosedForDate(COMPANY, '2099-02-09')).closed, false);
  assert.equal((await isClubClosedForDate(COMPANY, '2099-02-13')).closed, false);
  assert.equal(
    (await isClubClosedForDate(COMPANY, new Date('2099-02-11T00:00:00.000Z'))).closed,
    true,
  );
});

test('isClubClosedForDate never closes without a company or date', async () => {
  assert.equal((await isClubClosedForDate(null, CLOSED_START)).closed, false);
  assert.equal((await isClubClosedForDate(COMPANY, '')).closed, false);
});

test('isClubClosedForDate falls back to a neutral reason when none is stored', async () => {
  state.closures[0].reason = '';
  const result = await isClubClosedForDate(COMPANY, CLOSED_START);
  assert.equal(result.closed, true);
  assert.match(result.reason, /cerrado/i);
});

// ── Public surfaces: refactored to the shared helper ────────────────────────

test('public availability reports the closure through the shared helper', async () => {
  const res = await call(publicController.getAvailability, {
    params: { slug: 'club' },
    query: { date: '2099-02-11' },
  });

  assert.equal(res.statusCode, undefined);
  assert.equal(res.payload.data.closed, true);
  assert.equal(res.payload.data.closureReason, 'Mantenimiento');
  assert.deepEqual(res.payload.data.slots, []);
});

test('public booking creation refuses a closed date with zero writes', async () => {
  const res = await call(publicController.createClientBooking, {
    params: { slug: 'club' },
    clientUser: { id: CLIENT_ID, companyId: COMPANY },
    body: { courtId: COURT_ID, slotId: SLOT_ID, date: '2099-02-11' },
  });

  assert.equal(res.statusCode, 409);
  assert.equal(res.payload.error, 'El club está cerrado ese día');
  assert.equal(state.bookings.length, 0);
  assert.equal(state.userFindCalls, 0, 'fixed turns must not be materialized on a closed day');
});

test('public booking creation still books an open date', async () => {
  const res = await call(publicController.createClientBooking, {
    params: { slug: 'club' },
    clientUser: { id: CLIENT_ID, companyId: COMPANY },
    body: { courtId: COURT_ID, slotId: SLOT_ID, date: OPEN_DATE },
  });

  assert.equal(res.statusCode, 201);
  assert.equal(state.bookings.length, 1);
});

// ── Admin booking creation ──────────────────────────────────────────────────

const adminCreateReq = (overrides = {}) => ({
  user: { role: 'admin', companyId: COMPANY, _id: 'admin-1' },
  body: {
    courtId: COURT_ID,
    slotId: SLOT_ID,
    date: '2099-02-11',
    clientName: 'Admin client',
    clientPhone: '5491111111111',
    ...overrides,
  },
});

test('admin booking creation refuses a closed date before any write or materialization', async () => {
  const res = await call(createBooking, adminCreateReq());

  assert.equal(res.statusCode, 409);
  assert.match(res.payload.error, /cerrado/i);
  assert.equal(state.bookings.length, 0);
  assert.equal(state.userFindCalls, 0, 'no fixed-turn materialization on a closed day');
});

test('admin booking creation refuses both inclusive closure boundaries', async () => {
  for (const date of [CLOSED_START, CLOSED_END]) {
    resetState();
    const res = await call(createBooking, adminCreateReq({ date }));
    assert.equal(res.statusCode, 409, `${date} must be closed`);
    assert.equal(state.bookings.length, 0);
  }
});

test('admin booking creation still writes an open date', async () => {
  const res = await call(createBooking, adminCreateReq({ date: OPEN_DATE }));

  assert.equal(res.statusCode, 201);
  assert.equal(state.bookings.length, 1);
});

// ── Admin booking update ────────────────────────────────────────────────────

const seedUpdateTarget = (date) => {
  state.updateTarget = {
    _id: hexId(0xb1),
    companyId: COMPANY,
    court: COURT_ID,
    timeSlot: SLOT_ID,
    date: new Date(`${date}T00:00:00.000Z`),
    status: 'confirmado',
    clientName: 'Ana',
    clientPhone: '5491100000000',
  };
};

test('admin update refuses moving a booking onto a closed date', async () => {
  seedUpdateTarget(OPEN_DATE);

  const res = await call(updateBooking, {
    params: { id: hexId(0xb1) },
    user: { role: 'admin', companyId: COMPANY, _id: 'admin-1' },
    body: { date: '2099-02-11' },
  });

  assert.equal(res.statusCode, 409);
  assert.match(res.payload.error, /cerrado/i);
  assert.equal(state.updateCalls, 0, 'no Booking update may be persisted');
});

test('admin update keeps metadata-only edits working on an unchanged date', async () => {
  seedUpdateTarget('2099-02-11');

  const res = await call(updateBooking, {
    params: { id: hexId(0xb1) },
    user: { role: 'admin', companyId: COMPANY, _id: 'admin-1' },
    body: { clientName: 'Ana Gómez' },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(state.updateCalls, 1);
});

// ── Bot booking creation ────────────────────────────────────────────────────

const botBooking = (overrides = {}) =>
  bookingService.createNewBooking({
    companyId: COMPANY,
    courtName: 'Cancha 1',
    dateStr: '2099-02-11',
    timeStr: '20:00',
    clientName: 'Ana',
    clientPhone: '5491100000000',
    clientWhatsappId: '5491100000000@c.us',
    ...overrides,
  });

test('bot booking creation refuses a closed date with zero writes', async () => {
  const result = await botBooking();

  assert.equal(result.success, false);
  assert.equal(result.error, 'CLUB_CLOSED');
  assert.equal(state.bookings.length, 0);
  assert.equal(state.userFindCalls, 0, 'no fixed-turn materialization on a closed day');
});

test('bot booking creation still books an open date', async () => {
  const result = await botBooking({ dateStr: OPEN_DATE });

  assert.equal(result.success, true);
  assert.equal(state.bookings.length, 1);
});

// The webhook companyId can be null. The target court is authoritative, so the
// closure must be evaluated for the court tenant; when the court has no tenant
// either, the write is refused instead of defaulting to "open".
test('bot booking creation refuses when the selected court has no resolvable tenant', async () => {
  state.courts = [
    { _id: COURT_ID, name: 'Cancha 1', courtType: null, isActive: true },
  ];
  state.timeSlots = [
    {
      _id: SLOT_ID,
      court: null,
      startTime: '20:00',
      endTime: '21:00',
      price: 25000,
      isActive: true,
    },
  ];

  const result = await bookingService.createNewBooking({
    courtName: 'Cancha 1',
    dateStr: OPEN_DATE,
    timeStr: '20:00',
    clientName: 'Ana',
    clientPhone: '5491100000000',
  });

  assert.equal(result.success, false);
  assert.equal(result.error, 'CLOSURE_UNAVAILABLE');
  assert.equal(state.bookings.length, 0);
});

test('buildBookingReplyText maps CLUB_CLOSED to a neutral Spanish message', () => {
  const reply = buildBookingReplyText('2099-02-11', 'Ana', {
    success: false,
    error: 'CLUB_CLOSED',
  });

  assert.match(reply, /cerrado/i);
  assert.doesNotMatch(reply, /Confirmada/);
});

// ── Bot availability ────────────────────────────────────────────────────────

test('bot availability returns an empty slot list with a closed indicator', async () => {
  const result = await bookingService.getAvailableSlots('2099-02-11', {
    companyId: COMPANY,
  });

  assert.equal(result.success, true);
  assert.equal(result.closed, true);
  assert.equal(result.closureReason, 'Mantenimiento');
  assert.deepEqual(result.slots, []);
});

test('bot availability stays unchanged on an open date', async () => {
  const result = await bookingService.getAvailableSlots(OPEN_DATE, {
    companyId: COMPANY,
  });

  assert.equal(result.success, true);
  assert.equal(result.closed, false);
  assert.equal(result.slots.length, 1);
});

// Availability spans every court in its scope, so a null companyId has no
// tenant to derive. Refuse instead of offering a day whose closure was never
// evaluated (and never trigger materialization).
test('bot availability refuses when the tenant is unknown', async () => {
  const result = await bookingService.getAvailableSlots(OPEN_DATE, {});

  assert.equal(result.success, false);
  assert.equal(result.error, 'CLOSURE_UNAVAILABLE');
  assert.equal(state.userFindCalls, 0);
});

// ── Fixed-turn materialization ──────────────────────────────────────────────

test('materialization skips a closed date without writing fixed bookings', async () => {
  state.closures.push({
    _id: hexId(0xe3),
    companyId: COMPANY,
    startDate: CLOSED_START,
    endDate: CLOSED_END,
    reason: 'Feriado',
  });
  seedFixedTurnUser(closedWeekday());

  const result = await materializeFixedBookingsForDate({
    companyId: COMPANY,
    searchDate: new Date(`${CLOSED_START}T00:00:00.000Z`),
  });

  assert.equal(result.closed, true);
  assert.equal(result.createdCount, 0);
  assert.equal(state.bookings.length, 0);
});

test('materialization still creates fixed bookings on an open date', async () => {
  seedFixedTurnUser(openWeekday());

  const result = await materializeFixedBookingsForDate({
    companyId: COMPANY,
    searchDate: new Date(`${OPEN_DATE}T00:00:00.000Z`),
  });

  assert.equal(result.closed, undefined);
  assert.equal(result.createdCount, 1);
  assert.equal(state.bookings.length, 1);
});

test('in-range materialization skips closed dates and keeps open ones', async () => {
  state.users = [
    {
      _id: hexId(0xaa2),
      companyId: COMPANY,
      name: 'Fija',
      phoneNumber: '5491100000000',
      fixedTurns: Array.from({ length: 7 }, (_, dayOfWeek) => ({
        dayOfWeek,
        court: { _id: COURT_ID, name: 'Cancha 1' },
        timeSlot: { _id: SLOT_ID, startTime: '20:00', endTime: '21:00', price: 25000 },
      })),
    },
  ];

  const result = await materializeFixedBookingsInRange({
    companyId: COMPANY,
    fromDate: new Date(`${CLOSED_START}T00:00:00.000Z`),
    daysAhead: 3,
  });

  assert.equal(result.datesProcessed, 4);
  assert.equal(state.bookings.length, 1, 'only the one open date creates a booking');
  assert.equal(state.bookings[0].date.toISOString().slice(0, 10), OPEN_DATE);
});

// ── Public slot lock ────────────────────────────────────────────────────────

const slotLockReq = (date) => ({
  params: { slug: 'club' },
  body: { courtId: COURT_ID, slotId: SLOT_ID, date, holderId: 'holder-1' },
});

test('slot lock acquisition refuses a closed date before creating a lock', async () => {
  const res = await call(publicController.acquireSlotLockHandler, slotLockReq('2099-02-11'));

  assert.equal(res.statusCode, 409);
  assert.match(res.payload.error, /cerrado/i);
  assert.equal(state.lockAcquires, 0);
});

test('slot lock acquisition still succeeds on an open date', async () => {
  const res = await call(publicController.acquireSlotLockHandler, slotLockReq(OPEN_DATE));

  assert.equal(res.statusCode, undefined);
  assert.equal(res.payload.success, true);
  assert.equal(state.lockAcquires, 1);
});

// ── Cross-tenant isolation ──────────────────────────────────────────────────

test('a closure in company A does not close company B', async () => {
  assert.equal((await isClubClosedForDate(COMPANY, CLOSED_START)).closed, true);
  assert.equal((await isClubClosedForDate(COMPANY_B, CLOSED_START)).closed, false);
});

// ── Super admin without companyId must still resolve the court tenant ───────

test('super_admin without companyId cannot create a booking on a closed date', async () => {
  const res = await call(createBooking, {
    user: { role: 'super_admin', _id: hexId(0xf2) },
    query: {},
    body: {
      courtId: COURT_ID,
      slotId: SLOT_ID,
      date: '2099-02-11',
      clientName: 'Super client',
      clientPhone: '5491111111111',
    },
  });

  assert.equal(res.statusCode, 409);
  assert.match(res.payload.error, /cerrado/i);
  assert.equal(state.bookings.length, 0);
  assert.equal(state.userFindCalls, 0);
});

test('super_admin without companyId cannot move a booking onto a closed date', async () => {
  seedUpdateTarget(OPEN_DATE);

  const res = await call(updateBooking, {
    params: { id: hexId(0xb1) },
    user: { role: 'super_admin', _id: hexId(0xf2) },
    query: {},
    body: { date: '2099-02-11' },
  });

  assert.equal(res.statusCode, 409);
  assert.match(res.payload.error, /cerrado/i);
  assert.equal(state.updateCalls, 0);
});

test('rematerialize requires an explicit companyId for a caller without one', async () => {
  const res = await call(rematerializeFixedTurns, {
    user: { role: 'super_admin', _id: hexId(0xf2) },
    query: {},
    body: { fromDate: CLOSED_START, daysAhead: 1 },
  });

  assert.equal(res.statusCode, 400);
  assert.equal(state.userFindCalls, 0);
  assert.equal(state.bookings.length, 0);
});

// A read must never trigger materialization without a tenant: with an unknown
// companyId there is no closure to evaluate, so the write side-effect is
// skipped and the stored bookings are returned as-is.
test('super_admin getBookings with a date but no companyId materializes nothing', async () => {
  seedFixedTurnUser(closedWeekday());

  const res = await call(getBookings, {
    user: { role: 'super_admin', _id: hexId(0xf2) },
    query: { date: CLOSED_START },
    body: {},
  });

  assert.equal(res.statusCode, 200);
  assert.equal(state.userFindCalls, 0, 'an unknown tenant must not materialize');
  assert.equal(state.bookings.length, 0);
});

test('super_admin getBookings with an explicit companyId still materializes an open date', async () => {
  seedFixedTurnUser(openWeekday());

  const res = await call(getBookings, {
    user: { role: 'super_admin', _id: hexId(0xf2) },
    query: { date: OPEN_DATE, companyId: COMPANY },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(state.userFindCalls, 1);
  assert.equal(res.payload.data.length, 1);
});

// ── Fail-closed writes while closure resolvability is unknown ───────────────

// The suites above replace ClubClosure.findOne with a double, which the
// capability check treats as safe without a live DB. Restoring the native
// findOne (and reporting the DB as disconnected) simulates production.
const withClosuresUnavailable = async (work) => {
  const savedFindOne = ClubClosure.findOne;
  const savedConnected = state.mongoConnected;
  const savedContext = process.env.NODE_TEST_CONTEXT;
  const savedEnv = process.env.NODE_ENV;
  ClubClosure.findOne = mongoose.Model.findOne;
  state.mongoConnected = false;
  delete process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_ENV;
  try {
    return await work();
  } finally {
    ClubClosure.findOne = savedFindOne;
    state.mongoConnected = savedConnected;
    if (savedContext !== undefined) process.env.NODE_TEST_CONTEXT = savedContext;
    if (savedEnv !== undefined) process.env.NODE_ENV = savedEnv;
  }
};

test('admin booking creation returns 503 and writes nothing when closures cannot be resolved', async () => {
  const res = await withClosuresUnavailable(() => call(createBooking, adminCreateReq()));

  assert.equal(res.statusCode, 503);
  assert.match(res.payload.error, /disponibilidad/i);
  assert.equal(state.bookings.length, 0);
  assert.equal(state.userFindCalls, 0);
});

test('public booking creation returns 503 and writes nothing when closures cannot be resolved', async () => {
  const res = await withClosuresUnavailable(() =>
    call(publicController.createClientBooking, {
      params: { slug: 'club' },
      clientUser: { id: CLIENT_ID, companyId: COMPANY },
      body: { courtId: COURT_ID, slotId: SLOT_ID, date: OPEN_DATE },
    }),
  );

  assert.equal(res.statusCode, 503);
  assert.match(res.payload.error, /disponibilidad/i);
  assert.equal(state.bookings.length, 0);
});

test('public slot lock returns 503 and acquires no lock when closures cannot be resolved', async () => {
  const res = await withClosuresUnavailable(() =>
    call(publicController.acquireSlotLockHandler, slotLockReq(OPEN_DATE)),
  );

  assert.equal(res.statusCode, 503);
  assert.equal(state.lockAcquires, 0);
});

test('public availability returns 503 instead of claiming the club is open', async () => {
  const res = await withClosuresUnavailable(() =>
    call(publicController.getAvailability, {
      params: { slug: 'club' },
      query: { date: OPEN_DATE },
    }),
  );

  assert.equal(res.statusCode, 503);
});

test('admin getBookings returns 503 and materializes nothing when closures cannot be resolved', async () => {
  const res = await withClosuresUnavailable(() =>
    call(getBookings, {
      query: { date: OPEN_DATE },
      user: { role: 'admin', companyId: COMPANY, _id: 'admin-1' },
    }),
  );

  assert.equal(res.statusCode, 503);
  assert.equal(state.userFindCalls, 0);
});

test('bot booking returns CLOSURE_UNAVAILABLE when closures cannot be resolved', async () => {
  const result = await withClosuresUnavailable(() => botBooking({ dateStr: OPEN_DATE }));

  assert.equal(result.success, false);
  assert.equal(result.error, 'CLOSURE_UNAVAILABLE');
  assert.equal(state.bookings.length, 0);
});

test('bot availability refuses when closures cannot be resolved', async () => {
  const result = await withClosuresUnavailable(() =>
    bookingService.getAvailableSlots(OPEN_DATE, { companyId: COMPANY }),
  );

  assert.equal(result.success, false);
  assert.equal(result.error, 'CLOSURE_UNAVAILABLE');
});

test('fixed-turn materialization refuses when closures cannot be resolved', async () => {
  seedFixedTurnUser(openWeekday());

  const result = await withClosuresUnavailable(() =>
    materializeFixedBookingsForDate({
      companyId: COMPANY,
      searchDate: new Date(`${OPEN_DATE}T00:00:00.000Z`),
    }),
  );

  assert.equal(result.createdCount, 0);
  assert.equal(state.bookings.length, 0);
});

test('rematerialize returns 503 and writes nothing when closures cannot be resolved', async () => {
  const res = await withClosuresUnavailable(() =>
    call(rematerializeFixedTurns, {
      user: { role: 'admin', companyId: COMPANY, _id: 'admin-1' },
      query: {},
      body: { fromDate: OPEN_DATE, daysAhead: 1 },
    }),
  );

  assert.equal(res.statusCode, 503);
  assert.equal(state.bookings.length, 0);
});

test('date-moving update returns 503 when closures cannot be resolved', async () => {
  seedUpdateTarget(OPEN_DATE);

  const res = await withClosuresUnavailable(() =>
    call(updateBooking, {
      params: { id: hexId(0xb1) },
      user: { role: 'admin', companyId: COMPANY, _id: 'admin-1' },
      body: { date: '2099-02-20' },
    }),
  );

  assert.equal(res.statusCode, 503);
  assert.equal(state.updateCalls, 0);
});



// ── Bot copy for closures and outages ───────────────────────────────────────

test('buildBookingReplyText maps CLOSURE_UNAVAILABLE to a neutral technical message', () => {
  const reply = buildBookingReplyText(OPEN_DATE, 'Ana', {
    success: false,
    error: 'CLOSURE_UNAVAILABLE',
  });

  assert.match(reply, /disponibilidad/i);
  assert.doesNotMatch(reply, /Confirmada/);
});

test('buildAvailabilityResponse surfaces the closure reason instead of an empty grid', async () => {
  const result = await buildAvailabilityResponse({
    companyId: COMPANY,
    requestedDate: OPEN_DATE,
    availability: {
      success: true,
      date: OPEN_DATE,
      slots: [],
      closed: true,
      closureReason: 'Mantenimiento',
    },
  });

  assert.match(result.replyText, /cerrad/i);
  assert.match(result.replyText, /Mantenimiento/);
});

// ── Date helper ─────────────────────────────────────────────────────────────

test('toIsoDateString treats null and undefined as "no date"', () => {
  assert.equal(toIsoDateString(null), '');
  assert.equal(toIsoDateString(undefined), '');
  assert.equal(toIsoDateString('2099-02-11'), '2099-02-11');
  assert.equal(toIsoDateString(new Date('2099-02-11T00:00:00.000Z')), '2099-02-11');
});
