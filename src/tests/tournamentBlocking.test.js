'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-blocking';

// Tournament court blocking. The resolver is the single source of truth used by
// public availability, public/admin booking creation and the bot availability
// helper; everything here runs against in-memory model doubles (no MongoDB).

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const hexId = (value) => value.toString(16).padStart(24, '0');
const COMPANY_A = hexId(0xaa);
const COMPANY_B = hexId(0xab);
const TOURNAMENT_A = hexId(0xa1);
const TOURNAMENT_B = hexId(0xa2);
const COURT_A = hexId(0xc1);
const COURT_B = hexId(0xc2);
const COURT_A2 = hexId(0xc5);
const COURT_INACTIVE = hexId(0xc3);
const COURT_MISSING = hexId(0xc4);
const SLOT_ID = hexId(0xd1);
const CLIENT_ID = hexId(0xe1);

// ── Model doubles ────────────────────────────────────────────────────────────

const state = {
  tournaments: [],
  courts: [],
  bookings: [],
  fixedTurns: [],
  timeSlots: [],
  users: [],
  companies: [],
  materializeCalls: 0,
  mongoConnected: true,
  updateTarget: null,
};

const resetState = () => {
  state.tournaments = [
    {
      _id: TOURNAMENT_A,
      companyId: COMPANY_A,
      name: 'Copa A',
      startDate: '2026-11-10',
      endDate: '2026-11-12',
      status: 'in_progress',
      courts: [COURT_A],
    },
    {
      _id: TOURNAMENT_B,
      companyId: COMPANY_B,
      name: 'Copa B',
      startDate: '2026-11-10',
      endDate: '2026-11-12',
      status: 'in_progress',
      courts: [COURT_B],
    },
  ];
  state.courts = [
    { _id: COURT_A, companyId: COMPANY_A, name: 'Cancha A', isActive: true },
    { _id: COURT_A2, companyId: COMPANY_A, name: 'Cancha A2', isActive: true },
    { _id: COURT_B, companyId: COMPANY_B, name: 'Cancha B', isActive: true },
    { _id: COURT_INACTIVE, companyId: COMPANY_A, name: 'Vieja', isActive: false },
  ];
  state.bookings = [];
  state.fixedTurns = [];
  state.timeSlots = [
    {
      _id: SLOT_ID,
      companyId: COMPANY_A,
      court: null,
      startTime: '20:00',
      endTime: '21:00',
      price: 10000,
      isActive: true,
    },
  ];
  state.users = [];
  state.companies = [{ _id: COMPANY_A, slug: 'club-a', isActive: true }];
  state.materializeCalls = 0;
  state.mongoConnected = true;
  state.updateTarget = null;
};

// Bot dates must stay in the future or bookingService short-circuits with
// PAST_TIME and the assertions become vacuous. Derive them from the clock.
const futureDate = (daysFromToday) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + daysFromToday);
  return date.toISOString().slice(0, 10);
};
const BOT_TOURNAMENT_START = futureDate(20);
const BOT_TOURNAMENT_END = futureDate(40);
const BOT_DATE = futureDate(30);

const setBotTournamentWindow = () => {
  state.tournaments[0].startDate = BOT_TOURNAMENT_START;
  state.tournaments[0].endDate = BOT_TOURNAMENT_END;
};

const norm = (value) => {
  if (value === undefined || value === null) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value);
};
const compare = (left, right) => {
  const a = left instanceof Date ? left.getTime() : norm(left);
  const b = right instanceof Date ? right.getTime() : norm(right);
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
};
const isOperator = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date) &&
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

// Chainable fake: `.select()`, `.sort()` and `.lean()` all resolve to `items`.
const makeQuery = (items) => {
  const query = {
    select: () => query,
    sort: () => query,
    lean: () => items,
    then: (onFulfilled, onRejected) => Promise.resolve(items).then(onFulfilled, onRejected),
    catch: (onRejected) => Promise.resolve(items).catch(onRejected),
  };
  return query;
};

const createModel = (key) => ({
  find: (filter = {}) => makeQuery(state[key].filter((doc) => matches(doc, filter))),
  findOne: async (filter = {}) => state[key].find((doc) => matches(doc, filter)) || null,
  exists: async (filter = {}) => Boolean(state[key].find((doc) => matches(doc, filter))),
  countDocuments: async (filter = {}) => state[key].filter((doc) => matches(doc, filter)).length,
  create: async (doc) => {
    const created = { _id: hexId(0x1000 + state[key].length), ...doc };
    created.populate = async () => created;
    state[key].push(created);
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
stubModule('../models/booking.model', createModel('bookings'));
stubModule('../models/fixedBooking.model', createModel('fixedTurns'));

const {
  BLOCKING_STATUS,
  isDateInInclusiveRange,
  getBlockedCourtsForDate,
  getBlockedCourtIdsForDate,
  isCourtBlockedByTournament,
} = require('../services/tournamentBlocking.service');
const { buildAvailabilityPairs } = require('../utils/slotSchedule');

const blockedFor = (companyId, date) => getBlockedCourtsForDate(companyId, date);

// ── Pure date semantics ──────────────────────────────────────────────────────

test('isDateInInclusiveRange treats start and end as blocked and adjacent days as free', () => {
  assert.equal(isDateInInclusiveRange('2026-11-10', '2026-11-10', '2026-11-12'), true);
  assert.equal(isDateInInclusiveRange('2026-11-11', '2026-11-10', '2026-11-12'), true);
  assert.equal(isDateInInclusiveRange('2026-11-12', '2026-11-10', '2026-11-12'), true);
  assert.equal(isDateInInclusiveRange('2026-11-09', '2026-11-10', '2026-11-12'), false);
  assert.equal(isDateInInclusiveRange('2026-11-13', '2026-11-10', '2026-11-12'), false);
  assert.equal(isDateInInclusiveRange('2026-11-11', '2026-11-10', '2026-11-12'), true);
  assert.equal(isDateInInclusiveRange('', '2026-11-10', '2026-11-12'), false);
});

test('BLOCKING_STATUS is the only status that blocks', () => {
  assert.equal(BLOCKING_STATUS, 'in_progress');
});

// ── Availability pair marking ────────────────────────────────────────────────

const SLOT_1 = hexId(0xd1);
const SLOT_2 = hexId(0xd2);

const availability = (blockedCourtIds) =>
  buildAvailabilityPairs({
    courts: [{ _id: COURT_A }, { _id: COURT_B }],
    slots: [
      { _id: SLOT_1, startTime: '20:00' },
      { _id: SLOT_2, startTime: '21:00' },
    ],
    occupiedSet: new Set(),
    blockedCourtIds,
  });

test('buildAvailabilityPairs marks every slot of a blocked court unavailable with a tournament reason', () => {
  const pairs = availability(new Set([COURT_A]));
  const courtA = pairs.filter((pair) => pair.courtId === COURT_A);
  const courtB = pairs.filter((pair) => pair.courtId === COURT_B);

  assert.equal(courtA.length, 2);
  for (const pair of courtA) {
    assert.equal(pair.available, false);
    assert.equal(pair.reason, 'tournament');
  }
  assert.equal(courtB.length, 2);
  for (const pair of courtB) {
    assert.equal(pair.available, true);
    assert.equal(pair.reason, undefined);
  }
});

test('buildAvailabilityPairs keeps booking occupancy and adds no reason without tournament blocks', () => {
  const pairs = buildAvailabilityPairs({
    courts: [{ _id: COURT_A }],
    slots: [{ _id: SLOT_1, startTime: '20:00' }],
    occupiedSet: new Set([`${COURT_A}_${SLOT_1}`]),
    blockedCourtIds: new Set(),
  });
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].available, false);
  assert.equal(pairs[0].reason, undefined);
});

test('buildAvailabilityPairs accepts a plain array of blocked id strings', () => {
  const pairs = availability([COURT_A]);
  assert.equal(pairs.find((pair) => pair.courtId === COURT_A).reason, 'tournament');
  assert.equal(pairs.find((pair) => pair.courtId === COURT_B).available, true);
});

// ── Resolver: blocking scope ─────────────────────────────────────────────────

test('getBlockedCourtsForDate returns the selected courts of an in_progress tournament', async () => {
  const blocks = await blockedFor(COMPANY_A, '2026-11-11');
  assert.equal(blocks.date, '2026-11-11');
  assert.deepEqual(blocks.courtIds, [COURT_A]);
  assert.equal(blocks.tournaments.length, 1);
  assert.equal(blocks.tournaments[0]._id, TOURNAMENT_A);
  assert.equal(blocks.tournaments[0].name, 'Copa A');
});

test('only the selected courts are blocked, not every club court', async () => {
  const blocks = await blockedFor(COMPANY_A, '2026-11-11');
  assert.deepEqual(blocks.courtIds, [COURT_A]);
  assert.ok(!blocks.courtIds.includes(COURT_A2));
  assert.ok(!blocks.courtIds.includes(COURT_B));
});

test('draft, finished and cancelled tournaments do not block', async () => {
  for (const status of ['draft', 'finished', 'cancelled']) {
    state.tournaments[0].status = status;
    assert.deepEqual((await blockedFor(COMPANY_A, '2026-11-11')).courtIds, []);
  }
});

test('finishing an in_progress tournament releases its courts immediately', async () => {
  assert.deepEqual((await blockedFor(COMPANY_A, '2026-11-11')).courtIds, [COURT_A]);
  state.tournaments[0].status = 'finished';
  assert.deepEqual((await blockedFor(COMPANY_A, '2026-11-11')).courtIds, []);
});

test('start and end dates are inclusive while adjacent days are free', async () => {
  assert.deepEqual((await blockedFor(COMPANY_A, '2026-11-10')).courtIds, [COURT_A]);
  assert.deepEqual((await blockedFor(COMPANY_A, '2026-11-12')).courtIds, [COURT_A]);
  assert.deepEqual((await blockedFor(COMPANY_A, '2026-11-09')).courtIds, []);
  assert.deepEqual((await blockedFor(COMPANY_A, '2026-11-13')).courtIds, []);
});

test('extending and shortening the range takes effect on the queried dates', async () => {
  state.tournaments[0].endDate = '2026-11-14';
  assert.deepEqual((await blockedFor(COMPANY_A, '2026-11-13')).courtIds, [COURT_A]);
  assert.deepEqual((await blockedFor(COMPANY_A, '2026-11-14')).courtIds, [COURT_A]);

  state.tournaments[0].endDate = '2026-11-11';
  assert.deepEqual((await blockedFor(COMPANY_A, '2026-11-12')).courtIds, []);
  assert.deepEqual((await blockedFor(COMPANY_A, '2026-11-11')).courtIds, [COURT_A]);
});

test('another company tournament never blocks this company', async () => {
  const blocks = await blockedFor(COMPANY_A, '2026-11-11');
  assert.deepEqual(blocks.courtIds, [COURT_A]);
  assert.ok(!blocks.tournaments.some((tournament) => tournament._id === TOURNAMENT_B));

  const other = await blockedFor(COMPANY_B, '2026-11-11');
  assert.deepEqual(other.courtIds, [COURT_B]);
});

test('inactive or missing court ids are ignored without failing', async () => {
  state.tournaments[0].courts = [COURT_A, COURT_INACTIVE, COURT_MISSING];
  const blocks = await blockedFor(COMPANY_A, '2026-11-11');
  assert.deepEqual(blocks.courtIds, [COURT_A]);
});

test('no in_progress tournament yields an empty block list', async () => {
  state.tournaments = [];
  const blocks = await blockedFor(COMPANY_A, '2026-11-11');
  assert.deepEqual(blocks.courtIds, []);
  assert.deepEqual(blocks.tournaments, []);
});

test('getBlockedCourtIdsForDate is the batched id variant and matches getBlockedCourtsForDate', async () => {
  state.tournaments[0].courts = [COURT_A, COURT_A2];
  const ids = await getBlockedCourtIdsForDate(COMPANY_A, '2026-11-11');
  const blocks = await blockedFor(COMPANY_A, '2026-11-11');
  assert.deepEqual(ids, blocks.courtIds);
  assert.deepEqual(ids, [COURT_A, COURT_A2]);
});

test('isCourtBlockedByTournament matches only blocked court/date pairs', async () => {
  assert.equal(await isCourtBlockedByTournament(COMPANY_A, COURT_A, '2026-11-11'), true);
  assert.equal(await isCourtBlockedByTournament(COMPANY_A, COURT_B, '2026-11-11'), false);
  assert.equal(await isCourtBlockedByTournament(COMPANY_A, COURT_A, '2026-11-13'), false);
  assert.equal(await isCourtBlockedByTournament(COMPANY_B, COURT_A, '2026-11-11'), false);
});

// ── Surface parity: public availability and public booking creation ─────────

const realSlotLockService = require('../services/slotLock.service');

stubModule('../models/timeSlot.model', createModel('timeSlots'));
stubModule('../models/user.model', createModel('users'));
stubModule('../models/company.model', {
  findOne: async (filter = {}) => state.companies.find((company) => matches(company, filter)) || null,
});
stubModule('../models/clubClosure.model', { findOne: async () => null });
stubModule('../models/clientAccount.model', {
  findById: async () => ({
    _id: CLIENT_ID,
    companyId: COMPANY_A,
    name: 'Ana',
    phone: '5491100000000',
  }),
});
stubModule('../services/fixedTurnsMaterialization.service', {
  materializeFixedBookingsForDate: async () => {
    state.materializeCalls += 1;
  },
});
stubModule('../services/slotLock.service', {
  ...realSlotLockService,
  createMongooseSlotLockStore: () => ({
    findActiveLocksForDate: async () => [],
    deleteLocksForSlot: async () => ({ deletedCount: 0 }),
  }),
});
stubModule('../services/fixedBooking.service', {
  getWeekdayFromDate: (value) =>
    (value instanceof Date ? value : new Date(value)).getUTCDay(),
  findConflictingFixedForBooking: async () => null,
});
stubModule('../services/appConfig.service', {
  getBookingsPaused: async () => false,
  getDepositSettings: async () => ({
    depositEnabled: false,
    depositAmount: 0,
    depositExemptPhones: [],
  }),
  getCancellationLockHours: async () => 0,
  getPenaltyLimit: async () => 2,
  getPenaltySystemEnabled: async () => false,
  isPhoneExempt: () => false,
});
stubModule('../services/notificationService', {
  sendAdminNotification: async () => {},
});
stubModule('../services/depositNotification.service', {
  notifyDepositPending: async () => {},
});
stubModule('../services/bookingWhatsappConfirmation.service', {
  sendBookingWhatsappConfirmation: async () => {},
});
stubModule('../services/whatsappCommandQueue.service', {
  COMMAND_TYPES: { SEND_MESSAGE: 'SEND_MESSAGE', NOTIFY_CANCELLATION_GROUP: 'NOTIFY_CANCELLATION_GROUP' },
  enqueueWhatsappCommand: async () => ({ command: { _id: 'cmd-x' } }),
});
stubModule('../services/deposit.service', {
  buildDepositFields: () => ({}),
  buildDepositPaymentLink: async () => ({ initPoint: '' }),
  markRefundableOnCancel: () => ({ refundable: false, deposit: null }),
});

const bookingStub = require.cache[require.resolve('../models/booking.model')].exports;
bookingStub.findById = () => {
  const created = state.bookings[state.bookings.length - 1];
  const populated = { ...created, toObject: () => created };
  const chain = {
    populate: () => chain,
    then: (resolve, reject) => Promise.resolve(populated).then(resolve, reject),
    catch: (reject) => Promise.resolve(populated).catch(reject),
  };
  return chain;
};

// updateBooking needs a chainable findOne + findOneAndUpdate. Only an explicitly
// seeded `updateTarget` opts into the update shape; every create path keeps
// seeing `null` for its duplicate check.
const populateChain = (doc) => {
  const chain = {
    populate: () => chain,
    then: (resolve, reject) => Promise.resolve(doc).then(resolve, reject),
    catch: (reject) => Promise.resolve(doc).catch(reject),
  };
  return chain;
};
bookingStub.findOne = () => (state.updateTarget ? populateChain(state.updateTarget) : null);
bookingStub.findOneAndUpdate = () => {
  const base = state.updateTarget || {};
  const updated = {
    ...base,
    _id: base._id,
    status: base.status,
    clientName: base.clientName,
    clientPhone: base.clientPhone,
    date: base.date,
    court: base.court,
    timeSlot: base.timeSlot,
  };
  return populateChain(updated);
};

const publicController = require('../controllers/public.controller');

const call = async (handler, req) => {
  const result = { statusCode: 200, body: null };
  const res = {
    status(code) {
      result.statusCode = code;
      return res;
    },
    json(payload) {
      result.body = payload;
      return res;
    },
    setHeader() {},
  };
  await handler(req, res);
  return result;
};

const publicAvailability = (date) =>
  call(publicController.getAvailability, {
    params: { slug: 'club-a' },
    query: { date },
  });

test('public availability marks blocked courts with a tournament reason and leaves the club open', async () => {
  const response = await publicAvailability('2026-11-11');
  assert.equal(response.statusCode, 200);

  const data = response.body.data;
  assert.equal(data.closed, false);
  assert.deepEqual(data.blockedCourts, [COURT_A]);
  assert.equal(data.tournamentBlocks.length, 1);
  assert.equal(data.tournamentBlocks[0]._id, TOURNAMENT_A);

  const blockedPairs = data.availability.filter((pair) => pair.courtId === COURT_A);
  assert.ok(blockedPairs.length > 0);
  for (const pair of blockedPairs) {
    assert.equal(pair.available, false);
    assert.equal(pair.reason, 'tournament');
  }

  const freePairs = data.availability.filter((pair) => pair.courtId === COURT_A2);
  assert.ok(freePairs.length > 0);
  for (const pair of freePairs) {
    assert.equal(pair.available, true);
    assert.equal(pair.reason, undefined);
  }
});

test('public availability on an unblocked date reports no tournament blocks', async () => {
  const response = await publicAvailability('2026-11-13');
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.data.blockedCourts, []);
  assert.deepEqual(response.body.data.tournamentBlocks, []);
  assert.ok(response.body.data.availability.every((pair) => pair.available !== false));
});

const publicBooking = (body) =>
  call(publicController.createClientBooking, {
    params: { slug: 'club-a' },
    body,
    clientUser: { id: CLIENT_ID, companyId: COMPANY_A },
  });

test('public booking creation rejects a tournament-blocked court with 409 before any write', async () => {
  const response = await publicBooking({
    courtId: COURT_A,
    slotId: SLOT_ID,
    date: '2026-11-11',
  });
  assert.equal(response.statusCode, 409);
  assert.match(response.body.error, /torneo/i);
  assert.equal(state.bookings.length, 0);
  assert.equal(state.materializeCalls, 0);
});

test('public booking creation still proceeds for a free court on a blocked date', async () => {
  const response = await publicBooking({
    courtId: COURT_A2,
    slotId: SLOT_ID,
    date: '2026-11-11',
  });
  assert.equal(response.statusCode, 201);
  assert.equal(response.body.success, true);
  assert.equal(state.bookings.length, 1);
  assert.equal(state.materializeCalls, 1);
});

const bookingController = require('../controllers/booking.controller');
const bookingService = require('../services/bookingService');
const tournamentController = require('../controllers/tournament.controller');

const adminBooking = (body) =>
  call(bookingController.createBooking, {
    user: { role: 'admin', companyId: COMPANY_A, _id: hexId(0xf1) }, body,
  });
const blockingBody = {
  courtId: COURT_A,
  slotId: SLOT_ID,
  date: '2026-11-11',
  clientName: 'Ana',
  clientPhone: '5491100000000',
};

test('admin booking creation rejects a tournament-blocked court without writing', async () => {
  const response = await adminBooking(blockingBody);
  assert.equal(response.statusCode, 409);
  assert.match(response.body.error, /torneo/i);
  assert.equal(state.bookings.length, 0);
  assert.equal(state.materializeCalls, 0);
});

test('admin booking creation still writes a free court on the same blocked date', async () => {
  const response = await adminBooking({ ...blockingBody, courtId: COURT_A2 });
  assert.equal(response.statusCode, 201);
  assert.equal(state.bookings.length, 1);
  assert.equal(String(state.bookings[0].court), COURT_A2);
});

test('bot availability drops blocked courts from the slot capacity', async () => {
  setBotTournamentWindow();
  const result = await bookingService.getAvailableSlots(BOT_DATE, { companyId: COMPANY_A });
  assert.equal(result.success, true);
  assert.equal(result.slots.length, 1);
  assert.equal(result.slots[0].totalCourts, 2);
  assert.equal(result.slots[0].availableCourts, 1);
});
test('bot availability omits a slot when every applicable court is tournament-blocked', async () => {
  setBotTournamentWindow();
  state.tournaments[0].courts = [COURT_A, COURT_A2];
  const result = await bookingService.getAvailableSlots(BOT_DATE, { companyId: COMPANY_A });
  assert.equal(result.success, true);
  assert.equal(result.slots.length, 0);
});

const botBooking = (overrides = {}) => {
  setBotTournamentWindow();
  return bookingService.createNewBooking({
    companyId: COMPANY_A, courtName: 'Cancha A', dateStr: BOT_DATE,
    timeStr: '20:00', clientName: 'Ana', clientPhone: '5491100000000', ...overrides,
  });
};

test('bot booking creation refuses a tournament-blocked specific court without writing', async () => {
  const result = await botBooking();
  assert.equal(result.success, false);
  assert.equal(result.error, 'BUSY');
  assert.equal(state.bookings.length, 0);
});
test('bot booking with INDIFERENTE skips the tournament-blocked court and books a free one', async () => {
  const result = await botBooking({ courtName: 'INDIFERENTE' });
  assert.equal(result.success, true);
  assert.equal(state.bookings.length, 1);
  assert.equal(String(state.bookings[0].court), COURT_A2);
});
test('GET blocked-courts exposes the same blocked ids as every other surface', async () => {
  const response = await call(tournamentController.getBlockedCourts, {
    user: { role: 'admin', companyId: COMPANY_A }, query: { date: '2026-11-11' },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.data.courtIds, [COURT_A]);
  assert.equal(response.body.data.date, '2026-11-11');
});

// ── Fail-closed writes when blocking cannot be resolved ─────────────────────

// The Node test runner sets NODE_TEST_CONTEXT, which the capability check uses
// to keep model-double suites (no live Mongo) working. Removing it for one call
// simulates production with the DB disconnected.
const withBlockingUnavailable = async (work) => {
  const savedContext = process.env.NODE_TEST_CONTEXT;
  const savedEnv = process.env.NODE_ENV;
  delete process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_ENV;
  state.mongoConnected = false;
  try {
    return await work();
  } finally {
    state.mongoConnected = true;
    if (savedContext !== undefined) process.env.NODE_TEST_CONTEXT = savedContext;
    if (savedEnv !== undefined) process.env.NODE_ENV = savedEnv;
  }
};

test('admin booking creation returns 503 and writes nothing when blocking cannot be resolved', async () => {
  const response = await withBlockingUnavailable(() => adminBooking(blockingBody));
  assert.equal(response.statusCode, 503);
  assert.match(response.body.error, /disponibilidad/i);
  assert.equal(state.bookings.length, 0);
  assert.equal(state.materializeCalls, 0);
});

test('public booking creation returns 503 and writes nothing when blocking cannot be resolved', async () => {
  const response = await withBlockingUnavailable(() => publicBooking({
    courtId: COURT_A,
    slotId: SLOT_ID,
    date: '2026-11-11',
  }));
  assert.equal(response.statusCode, 503);
  assert.equal(state.bookings.length, 0);
  assert.equal(state.materializeCalls, 0);
});

test('bot booking creation refuses when blocking cannot be resolved', async () => {
  setBotTournamentWindow();
  const result = await withBlockingUnavailable(() => bookingService.createNewBooking({
    companyId: COMPANY_A, courtName: 'Cancha A', dateStr: BOT_DATE,
    timeStr: '20:00', clientName: 'Ana', clientPhone: '5491100000000',
  }));
  assert.equal(result.success, false);
  assert.equal(result.error, 'BLOCKING_UNAVAILABLE');
  assert.equal(state.bookings.length, 0);
});

// ── Super admin without companyId must still resolve the court tenant ────────

test('super_admin without companyId cannot book a tournament-blocked court', async () => {
  const response = await call(bookingController.createBooking, {
    user: { role: 'super_admin', _id: hexId(0xf2) },
    query: {},
    body: blockingBody,
  });
  assert.equal(response.statusCode, 409);
  assert.match(response.body.error, /torneo/i);
  assert.equal(state.bookings.length, 0);
  assert.equal(state.materializeCalls, 0);
});

// ── updateBooking only blocks when the court/date/slot actually changes ─────

const seedUpdateTarget = (overrides = {}) => {
  state.updateTarget = {
    _id: hexId(0xb1),
    companyId: COMPANY_A,
    status: 'confirmado',
    clientName: 'Ana',
    clientPhone: '5491100000000',
    date: new Date('2026-11-13T00:00:00.000Z'),
    court: { _id: COURT_A2, name: 'Cancha A2' },
    timeSlot: { _id: SLOT_ID, startTime: '20:00' },
    ...overrides,
  };
  return state.updateTarget;
};

const updateAdminBooking = (body) =>
  call(bookingController.updateBooking, {
    user: { role: 'admin', companyId: COMPANY_A, _id: hexId(0xf1) },
    params: { id: state.updateTarget?._id },
    body,
  });

test('resending identical court, date and slot with a status edit is allowed', async () => {
  seedUpdateTarget({
    date: new Date('2026-11-11T00:00:00.000Z'),
    court: { _id: COURT_A, name: 'Cancha A' },
  });
  const response = await updateAdminBooking({
    status: 'confirmado',
    clientName: 'Ana Editada',
    court: COURT_A,
    date: '2026-11-11',
    timeSlot: SLOT_ID,
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.success, true);
});

test('moving a booking onto a tournament-blocked court is refused with 409', async () => {
  // Same blocked date, but currently on the free court; the court change is the
  // only thing that introduces the conflict.
  seedUpdateTarget({
    date: new Date('2026-11-11T00:00:00.000Z'),
    court: { _id: COURT_A2, name: 'Cancha A2' },
  });
  const response = await updateAdminBooking({ court: COURT_A });
  assert.equal(response.statusCode, 409);
  assert.match(response.body.error, /torneo/i);
});

test('moving a booking onto a tournament-blocked date is refused with 409', async () => {
  seedUpdateTarget({
    date: new Date('2026-11-13T00:00:00.000Z'),
    court: { _id: COURT_A, name: 'Cancha A' },
  });
  const response = await updateAdminBooking({ date: '2026-11-11' });
  assert.equal(response.statusCode, 409);
  assert.match(response.body.error, /torneo/i);
});

// ── Availability normalizes the date exactly like booking creation ──────────

test('availability normalizes a timezone-qualified date before resolving blocks', async () => {
  // Tournament ends on 2026-11-11; 23:00-03:00 is 2026-11-12 in UTC, so the
  // normalized day is NOT blocked (raw-string parsing used to say otherwise).
  state.tournaments[0].endDate = '2026-11-11';
  const response = await publicAvailability('2026-11-11T23:00:00-03:00');
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.data.blockedCourts, []);
  assert.ok(
    response.body.data.availability
      .filter((pair) => pair.courtId === COURT_A)
      .every((pair) => pair.available === true),
  );
});

test('availability normalizes a slash date before resolving blocks', async () => {
  const response = await publicAvailability('11/11/2026');
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.data.blockedCourts, [COURT_A]);
  assert.ok(
    response.body.data.availability
      .filter((pair) => pair.courtId === COURT_A)
      .every((pair) => pair.available === false && pair.reason === 'tournament'),
  );
});

// ── Router contract for /blocked-courts ────────────────────────────────────

test('blocked-courts route is declared before /:id so it is not captured as an id', () => {
  const router = require('../routes/tournament.routes');
  const paths = router.stack
    .filter((layer) => layer.route)
    .map((layer) => layer.route.path);
  const blockedIndex = paths.indexOf('/blocked-courts');
  const idIndex = paths.indexOf('/:id');
  assert.ok(blockedIndex >= 0, 'blocked-courts route must exist');
  assert.ok(idIndex >= 0, '/:id route must exist');
  assert.ok(blockedIndex < idIndex, 'blocked-courts must be matched before /:id');
});

test('blocked-courts rejects an invalid date with 400', async () => {
  const response = await call(tournamentController.getBlockedCourts, {
    user: { role: 'admin', companyId: COMPANY_A }, query: { date: '11/11/2026' },
  });
  assert.equal(response.statusCode, 400);
  assert.match(response.body.error, /YYYY-MM-DD/);
});
