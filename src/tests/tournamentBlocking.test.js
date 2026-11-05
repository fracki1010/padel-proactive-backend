'use strict';

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

// ── Model doubles ────────────────────────────────────────────────────────────

const state = {
  tournaments: [],
  courts: [],
  bookings: [],
  fixedTurns: [],
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
stubModule('../models/tournament.model', createModel('tournaments'));
stubModule('../models/court.model', createModel('courts'));
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
