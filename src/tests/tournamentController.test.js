'use strict';

// Route-layer tests for the tournament API. Every tournament-related Mongoose
// model is replaced with an in-memory fake (same pattern as
// courtTenantScope.test.js) so tenant scoping, lifecycle rules, bracket
// persistence and result advancement run without a live MongoDB.

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-tournaments';

// 24-hex ids: the service rejects anything that is not a Mongo ObjectId before
// querying, so fixtures must look like real ids.
const hexId = (value) => value.toString(16).padStart(24, '0');
const COMPANY_A = 'company-a';
const COMPANY_B = 'company-b';
const TOURNAMENT_A = hexId(0xa1);
const TOURNAMENT_B = hexId(0xa2);
const CATEGORY_A = hexId(0xb1);
const CATEGORY_B = hexId(0xb2);
const CATEGORY_A2 = hexId(0xb3);
const COURT_A = hexId(0xc1);
const COURT_A2 = hexId(0xc3);
const COURT_B = hexId(0xc2);
const SLOT_A = hexId(0xd1);
const TEAM_1 = hexId(0xe1);

const state = {
  tournaments: [],
  categories: [],
  teams: [],
  matches: [],
  courts: [],
  bookings: [],
  fixedTurns: [],
  slotLocks: [],
  nextId: 1,
};

const resetState = () => {
  state.tournaments = [
    {
      _id: TOURNAMENT_A,
      companyId: COMPANY_A,
      name: 'Copa A',
      startDate: '2026-11-10',
      endDate: '2026-11-12',
      status: 'draft',
      courts: [COURT_A],
    },
    {
      _id: TOURNAMENT_B,
      companyId: COMPANY_B,
      name: 'Copa B',
      startDate: '2026-11-10',
      endDate: '2026-11-12',
      status: 'draft',
      courts: [COURT_B],
    },
  ];
  state.categories = [
    { _id: CATEGORY_A, companyId: COMPANY_A, tournament: TOURNAMENT_A, name: 'Primera', maxTeams: 8, order: 1 },
    { _id: CATEGORY_B, companyId: COMPANY_B, tournament: TOURNAMENT_B, name: 'Primera', maxTeams: 8, order: 1 },
  ];
  state.teams = [];
  state.matches = [];
  state.courts = [
    { _id: COURT_A, companyId: COMPANY_A, name: 'Cancha A', isActive: true },
    { _id: COURT_A2, companyId: COMPANY_A, name: 'Cancha A2', isActive: true },
    { _id: COURT_B, companyId: COMPANY_B, name: 'Cancha B', isActive: true },
  ];
  state.bookings = [];
  state.fixedTurns = [];
  state.slotLocks = [];
  state.nextId = 1;
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

// Interprets the operator subset used by the tournament service.
const matches = (doc, filter = {}) =>
  Object.entries(filter).every(([key, value]) => {
    if (key === '$or') return value.some((sub) => matches(doc, sub));
    if (key === '$and') return value.every((sub) => matches(doc, sub));
    const actual = doc[key];
    if (isOperator(value)) {
      if ('$in' in value) return value.$in.some((item) => norm(actual) === norm(item));
      if ('$ne' in value) return norm(actual) !== norm(value.$ne);
      if ('$gte' in value) return compare(actual, value.$gte) >= 0;
      if ('$lte' in value) return compare(actual, value.$lte) <= 0;
      if ('$gt' in value) return compare(actual, value.$gt) > 0;
    }
    return norm(actual) === norm(value);
  });

const makeQuery = (items) => ({
  sort: () => Promise.resolve(items),
  lean: () => Promise.resolve(items),
  then: (onFulfilled, onRejected) => Promise.resolve(items).then(onFulfilled, onRejected),
  catch: (onRejected) => Promise.resolve(items).catch(onRejected),
});

const createModel = (key) => ({
  find: (filter = {}) => makeQuery(state[key].filter((doc) => matches(doc, filter))),
  findOne: async (filter = {}) => state[key].find((doc) => matches(doc, filter)) || null,
  create: async (doc) => {
    const created = { _id: hexId(state.nextId++), ...doc };
    state[key].push(created);
    return created;
  },
  insertMany: async (docs) => {
    const created = docs.map((doc) => ({ _id: hexId(state.nextId++), ...doc }));
    state[key].push(...created);
    return created;
  },
  findOneAndUpdate: async (filter, update) => {
    const target = state[key].find((doc) => matches(doc, filter));
    if (!target) return null;
    Object.assign(target, update.$set || update);
    return target;
  },
  findOneAndDelete: async (filter = {}) => {
    const index = state[key].findIndex((doc) => matches(doc, filter));
    if (index === -1) return null;
    return state[key].splice(index, 1)[0];
  },
  deleteMany: async (filter = {}) => {
    const before = state[key].length;
    state[key] = state[key].filter((doc) => !matches(doc, filter));
    return { deletedCount: before - state[key].length };
  },
  countDocuments: async (filter = {}) => state[key].filter((doc) => matches(doc, filter)).length,
});

const stubModule = (requestPath, exportsObj) => {
  const resolved = require.resolve(requestPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
};

for (const [path, key] of [
  ['../models/tournament.model', 'tournaments'],
  ['../models/tournamentCategory.model', 'categories'],
  ['../models/tournamentTeam.model', 'teams'],
  ['../models/tournamentMatch.model', 'matches'],
  ['../models/court.model', 'courts'],
  ['../models/booking.model', 'bookings'],
  ['../models/fixedBooking.model', 'fixedTurns'],
  ['../models/slotLock.model', 'slotLocks'],
]) {
  stubModule(path, createModel(key));
}
stubModule('../models/timeSlot.model', {
  findOne: async (filter = {}) => ({ _id: SLOT_A, companyId: filter.companyId, ...filter }),
});

// Any Booking write is a bug: tournament scheduling MUST NOT create bookings.
const bookingModel = require.cache[require.resolve('../models/booking.model')].exports;
bookingModel.create = async () => {
  throw new Error('Booking.create must not be called by the tournament module');
};
bookingModel.insertMany = async () => {
  throw new Error('Booking.insertMany must not be called by the tournament module');
};

const controller = require('../controllers/tournament.controller');

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

const call = async (handler, req) => {
  const res = createResponse();
  await handler(req, res);
  return res;
};

// ── Tournament CRUD + tenant scoping ─────────────────────────────────────────

test('listTournaments only returns the requesting company rows', async () => {
  resetState();
  const res = await call(controller.listTournaments, adminReq(COMPANY_A));
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.data.length, 1);
  assert.equal(res.payload.data[0]._id, TOURNAMENT_A);
});

test('cross-tenant tournament ids return 404 for read and delete', async () => {
  resetState();
  const read = await call(controller.getTournament, adminReq(COMPANY_A, { params: { id: TOURNAMENT_B } }));
  assert.equal(read.statusCode, 404);

  const removed = await call(controller.deleteTournament, adminReq(COMPANY_A, { params: { id: TOURNAMENT_B } }));
  assert.equal(removed.statusCode, 404);
  assert.equal(state.tournaments.length, 2);
});

test('createTournament ignores a body companyId and rejects a foreign court', async () => {
  resetState();
  const body = {
    name: 'Nueva Copa',
    startDate: '2026-11-20',
    endDate: '2026-11-22',
    courts: [COURT_A],
    companyId: COMPANY_B,
  };
  const created = await call(controller.createTournament, adminReq(COMPANY_A, { body }));
  assert.equal(created.statusCode, 201);
  assert.equal(created.payload.data.companyId, COMPANY_A);

  const foreign = await call(
    controller.createTournament,
    adminReq(COMPANY_A, { body: { ...body, courts: [COURT_B] } }),
  );
  assert.equal(foreign.statusCode, 400);
  assert.equal(state.tournaments.length, 3);
});

test('a super_admin without a company cannot write', async () => {
  resetState();
  const res = await call(
    controller.createTournament,
    { params: {}, query: {}, body: { name: 'X', startDate: '2026-11-10', endDate: '2026-11-10', courts: [COURT_A] }, user: { role: 'super_admin' } },
  );
  assert.equal(res.statusCode, 403);
});

// ── Lifecycle + activation conflicts ────────────────────────────────────────

test('draft -> in_progress succeeds when there are no conflicts', async () => {
  resetState();
  const res = await call(controller.activateTournament, adminReq(COMPANY_A, { params: { id: TOURNAMENT_A } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.data.status, 'in_progress');
  assert.ok(res.payload.data.activatedAt instanceof Date);
});

test('activation reports conflicting bookings and stays draft without confirmation', async () => {
  resetState();
  state.bookings.push({
    _id: 'booking-1',
    companyId: COMPANY_A,
    court: COURT_A,
    date: new Date('2026-11-11T00:00:00.000Z'),
    status: 'confirmado',
    clientName: 'Cliente',
  });
  const res = await call(controller.activateTournament, adminReq(COMPANY_A, { params: { id: TOURNAMENT_A } }));
  assert.equal(res.statusCode, 409);
  assert.equal(res.payload.conflicts.length, 1);
  assert.equal(res.payload.conflicts[0].type, 'booking');
  assert.equal(state.tournaments[0].status, 'draft');
});

test('activation with confirmConflicts proceeds and never touches the booking', async () => {
  resetState();
  state.bookings.push({
    _id: 'booking-1',
    companyId: COMPANY_A,
    court: COURT_A,
    date: new Date('2026-11-11T00:00:00.000Z'),
    status: 'confirmado',
    clientName: 'Cliente',
  });
  const res = await call(
    controller.activateTournament,
    adminReq(COMPANY_A, { params: { id: TOURNAMENT_A }, body: { confirmConflicts: true } }),
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.data.status, 'in_progress');
  assert.equal(state.bookings[0].status, 'confirmado');
});

test('invalid transitions are rejected and status is unchanged', async () => {
  resetState();
  const completeDraft = await call(controller.completeTournament, adminReq(COMPANY_A, { params: { id: TOURNAMENT_A } }));
  assert.equal(completeDraft.statusCode, 400);
  assert.equal(state.tournaments[0].status, 'draft');

  state.tournaments[0].status = 'in_progress';
  const cancelled = await call(controller.cancelTournament, adminReq(COMPANY_A, { params: { id: TOURNAMENT_A } }));
  assert.equal(cancelled.statusCode, 200);
  assert.equal(cancelled.payload.data.status, 'cancelled');
});

test('deleting an in_progress tournament is refused', async () => {
  resetState();
  state.tournaments[0].status = 'in_progress';
  const res = await call(controller.deleteTournament, adminReq(COMPANY_A, { params: { id: TOURNAMENT_A } }));
  assert.equal(res.statusCode, 409);
  assert.equal(state.tournaments.length, 2);
});

test('deleting a finished tournament cascades children and keeps bookings', async () => {
  resetState();
  state.tournaments[0].status = 'finished';
  state.teams.push({ _id: 'team-x', companyId: COMPANY_A, tournament: TOURNAMENT_A, category: CATEGORY_A, name: 'T' });
  state.matches.push({ _id: 'match-x', companyId: COMPANY_A, tournament: TOURNAMENT_A, category: CATEGORY_A });
  state.bookings.push({ _id: 'booking-1', companyId: COMPANY_A, court: COURT_A, status: 'confirmado' });
  const res = await call(controller.deleteTournament, adminReq(COMPANY_A, { params: { id: TOURNAMENT_A } }));
  assert.equal(res.statusCode, 200);
  assert.equal(state.tournaments.length, 1);
  assert.equal(state.teams.length, 0);
  assert.equal(state.matches.length, 0);
  assert.equal(state.bookings.length, 1);
});

// ── Categories ──────────────────────────────────────────────────────────────

test('category create/update/delete are scoped through the parent tournament', async () => {
  resetState();
  const foreign = await call(
    controller.createCategory,
    adminReq(COMPANY_A, { params: { id: TOURNAMENT_B }, body: { name: 'Segunda' } }),
  );
  assert.equal(foreign.statusCode, 404);

  const created = await call(
    controller.createCategory,
    adminReq(COMPANY_A, { params: { id: TOURNAMENT_A }, body: { name: 'Segunda', maxTeams: 4 } }),
  );
  assert.equal(created.statusCode, 201);
  assert.equal(created.payload.data.companyId, COMPANY_A);

  const duplicate = await call(
    controller.createCategory,
    adminReq(COMPANY_A, { params: { id: TOURNAMENT_A }, body: { name: ' primera ' } }),
  );
  assert.equal(duplicate.statusCode, 400);

  const foreignCategory = await call(
    controller.updateCategory,
    adminReq(COMPANY_A, { params: { id: TOURNAMENT_A, categoryId: CATEGORY_B }, body: { name: 'Otra' } }),
  );
  assert.equal(foreignCategory.statusCode, 404);
});

test('category deletion is refused with registered teams or played matches', async () => {
  resetState();
  state.teams.push({ _id: 'team-1', companyId: COMPANY_A, tournament: TOURNAMENT_A, category: CATEGORY_A, status: 'registered' });
  const withTeams = await call(
    controller.deleteCategory,
    adminReq(COMPANY_A, { params: { id: TOURNAMENT_A, categoryId: CATEGORY_A } }),
  );
  assert.equal(withTeams.statusCode, 409);
  assert.equal(state.categories.length, 2);

  state.teams = [];
  state.matches.push({ _id: 'match-1', companyId: COMPANY_A, tournament: TOURNAMENT_A, category: CATEGORY_A, status: 'played' });
  const withMatches = await call(
    controller.deleteCategory,
    adminReq(COMPANY_A, { params: { id: TOURNAMENT_A, categoryId: CATEGORY_A } }),
  );
  assert.equal(withMatches.statusCode, 409);

  state.matches = [];
  const empty = await call(
    controller.deleteCategory,
    adminReq(COMPANY_A, { params: { id: TOURNAMENT_A, categoryId: CATEGORY_A } }),
  );
  assert.equal(empty.statusCode, 200);
  assert.equal(state.categories.length, 1);
});

// ── Teams ───────────────────────────────────────────────────────────────────

test('team registration enforces capacity and duplicate players per category', async () => {
  resetState();
  state.categories[0].maxTeams = 2;
  const base = { player1Name: 'Ana', player2Name: 'Beto', player1Phone: '111', player2Phone: '222' };
  const params = { id: TOURNAMENT_A, categoryId: CATEGORY_A };

  const first = await call(controller.createTeam, adminReq(COMPANY_A, { params, body: base }));
  assert.equal(first.statusCode, 201);

  const duplicateName = await call(
    controller.createTeam,
    adminReq(COMPANY_A, { params, body: { player1Name: ' Ana ', player2Name: 'Otro', player1Phone: '111', player2Phone: '999' } }),
  );
  assert.equal(duplicateName.statusCode, 400);

  const second = await call(
    controller.createTeam,
    adminReq(COMPANY_A, { params, body: { player1Name: 'Carla', player2Name: 'Dani', player1Phone: '333', player2Phone: '444' } }),
  );
  assert.equal(second.statusCode, 201);

  const third = await call(
    controller.createTeam,
    adminReq(COMPANY_A, { params, body: { player1Name: 'Eva', player2Name: 'Fede', player1Phone: '555', player2Phone: '666' } }),
  );
  assert.equal(third.statusCode, 409);
  assert.equal(state.teams.length, 2);
});

test('the same player may be registered in another category but not the same one', async () => {
  resetState();
  state.categories.push({
    _id: CATEGORY_A2,
    companyId: COMPANY_A,
    tournament: TOURNAMENT_A,
    name: 'Segunda',
    maxTeams: 8,
    order: 2,
  });
  const player = { player1Name: 'Ana', player2Name: 'Beto', player1Phone: '111', player2Phone: '222' };
  const first = await call(
    controller.createTeam,
    adminReq(COMPANY_A, { params: { id: TOURNAMENT_A, categoryId: CATEGORY_A }, body: player }),
  );
  assert.equal(first.statusCode, 201);

  const otherCategory = await call(
    controller.createTeam,
    adminReq(COMPANY_A, { params: { id: TOURNAMENT_A, categoryId: CATEGORY_A2 }, body: { ...player, player2Name: 'Otro' } }),
  );
  assert.equal(otherCategory.statusCode, 201);
});

test('withdrawal frees capacity and is refused after a recorded result', async () => {
  resetState();
  state.teams.push({
    _id: TEAM_1,
    companyId: COMPANY_A,
    tournament: TOURNAMENT_A,
    category: CATEGORY_A,
    name: 'Ana / Beto',
    player1Name: 'Ana',
    player2Name: 'Beto',
    status: 'registered',
  });
  const params = { id: TOURNAMENT_A, categoryId: CATEGORY_A, teamId: TEAM_1 };
  const withdrawn = await call(controller.updateTeam, adminReq(COMPANY_A, { params, body: { status: 'withdrawn' } }));
  assert.equal(withdrawn.statusCode, 200);
  assert.equal(state.teams[0].status, 'withdrawn');

  state.teams[0].status = 'registered';
  state.matches.push({ _id: hexId(0xf1), companyId: COMPANY_A, tournament: TOURNAMENT_A, category: CATEGORY_A, status: 'played', teamA: TEAM_1 });
  const refused = await call(controller.updateTeam, adminReq(COMPANY_A, { params, body: { status: 'withdrawn' } }));
  assert.equal(refused.statusCode, 409);
  assert.equal(state.teams[0].status, 'registered');
});

test('team writes under a foreign category return 404', async () => {
  resetState();
  const res = await call(
    controller.createTeam,
    adminReq(COMPANY_A, { params: { id: TOURNAMENT_A, categoryId: CATEGORY_B }, body: { player1Name: 'A', player2Name: 'B' } }),
  );
  assert.equal(res.statusCode, 404);
  assert.equal(state.teams.length, 0);
});

// ── Bracket generation and persistence ──────────────────────────────────────

const seedTeams = (count, categoryId = CATEGORY_A) => {
  for (let index = 1; index <= count; index += 1) {
    state.teams.push({
      _id: hexId(0xe000 + index),
      companyId: COMPANY_A,
      tournament: TOURNAMENT_A,
      category: categoryId,
      name: `Pareja ${index}`,
      player1Name: `Jugador ${index}A`,
      player2Name: `Jugador ${index}B`,
      status: 'registered',
      seed: index,
    });
  }
};

test('bracket generation requires an in_progress tournament', async () => {
  resetState();
  seedTeams(4);
  const res = await call(
    controller.generateBracket,
    adminReq(COMPANY_A, { params: { id: TOURNAMENT_A, categoryId: CATEGORY_A }, body: {} }),
  );
  assert.equal(res.statusCode, 400);
  assert.equal(state.matches.length, 0);
});

test('five teams persist an eight-slot bracket without re-advancing byes', async () => {
  resetState();
  state.tournaments[0].status = 'in_progress';
  seedTeams(5);
  const res = await call(
    controller.generateBracket,
    adminReq(COMPANY_A, { params: { id: TOURNAMENT_A, categoryId: CATEGORY_A }, body: { seed: 42 } }),
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.data.bracketSize, 8);
  assert.equal(state.matches.length, 7);

  const firstRound = state.matches.filter((match) => match.round === 1);
  const byes = firstRound.filter((match) => match.status === 'bye');
  assert.equal(byes.length, 3);
  for (const bye of byes) assert.ok(bye.winner);

  const round2 = state.matches.filter((match) => match.round === 2);
  assert.equal(round2.length, 2);
  // The generator pre-fills the bye winners; the service must persist them 1:1.
  assert.ok(round2[0].teamA || round2[0].teamB);
  assert.equal(state.categories[0].bracketSize, 8);
});

test('a single team is champion with no matches', async () => {
  resetState();
  state.tournaments[0].status = 'in_progress';
  seedTeams(1);
  const res = await call(
    controller.generateBracket,
    adminReq(COMPANY_A, { params: { id: TOURNAMENT_A, categoryId: CATEGORY_A }, body: {} }),
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.data.bracketSize, 1);
  assert.equal(state.matches.length, 0);
  assert.equal(res.payload.data.champion._id, hexId(0xe001));
  assert.equal(state.categories[0].status, 'completed');
});

// ── Results, advancement and guards ─────────────────────────────────────────

const setupFourTeamBracket = async () => {
  resetState();
  state.tournaments[0].status = 'in_progress';
  seedTeams(4);
  const generated = await call(
    controller.generateBracket,
    adminReq(COMPANY_A, { params: { id: TOURNAMENT_A, categoryId: CATEGORY_A }, body: { seed: 7 } }),
  );
  assert.equal(generated.statusCode, 200);
  return state.matches.find((match) => match.round === 1 && match.status === 'ready');
};

test('recording a result advances the winner and marks the match played', async () => {
  const firstMatch = await setupFourTeamBracket();
  const winner = firstMatch.teamA;
  const res = await call(
    controller.recordResult,
    adminReq(COMPANY_A, {
      params: { id: TOURNAMENT_A, categoryId: CATEGORY_A, matchId: firstMatch._id },
      body: { scoreA: 2, scoreB: 0 },
    }),
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.data.match.status, 'played');
  assert.equal(res.payload.data.match.winner, winner);

  const target = state.matches.find((match) => match.round === 2 && match.position === 0);
  assert.equal(target[firstMatch.position % 2 === 0 ? 'teamA' : 'teamB'], winner);
});

test('a non-ready match cannot receive a result', async () => {
  const firstMatch = await setupFourTeamBracket();
  const pending = state.matches.find((match) => match.round === 2);
  const res = await call(
    controller.recordResult,
    adminReq(COMPANY_A, {
      params: { id: TOURNAMENT_A, categoryId: CATEGORY_A, matchId: pending._id },
      body: { scoreA: 2, scoreB: 0 },
    }),
  );
  assert.equal(res.statusCode, 409);
  assert.notEqual(pending.status, 'played');
  assert.ok(firstMatch._id);
});

test('playing the final resolves the champion and completes the category', async () => {
  const firstMatch = await setupFourTeamBracket();
  const other = state.matches.find(
    (match) => match.round === 1 && match.status === 'ready' && match._id !== firstMatch._id,
  );
  for (const match of [firstMatch, other]) {
    await call(
      controller.recordResult,
      adminReq(COMPANY_A, {
        params: { id: TOURNAMENT_A, categoryId: CATEGORY_A, matchId: match._id },
        body: { scoreA: 2, scoreB: 0 },
      }),
    );
  }
  const final = state.matches.find((match) => match.round === 2 && match.status === 'ready');
  const res = await call(
    controller.recordResult,
    adminReq(COMPANY_A, {
      params: { id: TOURNAMENT_A, categoryId: CATEGORY_A, matchId: final._id },
      body: { scoreA: 2, scoreB: 0 },
    }),
  );
  assert.equal(res.statusCode, 200);
  assert.ok(res.payload.data.champion);
  assert.equal(state.categories[0].status, 'completed');
});

test('clearing a result is refused when a downstream match was played', async () => {
  const firstMatch = await setupFourTeamBracket();
  const other = state.matches.find(
    (match) => match.round === 1 && match.status === 'ready' && match._id !== firstMatch._id,
  );
  for (const match of [firstMatch, other]) {
    await call(
      controller.recordResult,
      adminReq(COMPANY_A, {
        params: { id: TOURNAMENT_A, categoryId: CATEGORY_A, matchId: match._id },
        body: { scoreA: 2, scoreB: 0 },
      }),
    );
  }
  const final = state.matches.find((match) => match.round === 2 && match.status === 'ready');
  await call(
    controller.recordResult,
    adminReq(COMPANY_A, {
      params: { id: TOURNAMENT_A, categoryId: CATEGORY_A, matchId: final._id },
      body: { scoreA: 2, scoreB: 0 },
    }),
  );

  const res = await call(
    controller.clearResult,
    adminReq(COMPANY_A, {
      params: { id: TOURNAMENT_A, categoryId: CATEGORY_A, matchId: firstMatch._id },
    }),
  );
  assert.equal(res.statusCode, 409);
  assert.equal(firstMatch.status, 'played');
});

test('clearing a result before downstream play releases the next-round slot', async () => {
  const firstMatch = await setupFourTeamBracket();
  const winner = firstMatch.teamA;
  await call(
    controller.recordResult,
    adminReq(COMPANY_A, {
      params: { id: TOURNAMENT_A, categoryId: CATEGORY_A, matchId: firstMatch._id },
      body: { scoreA: 2, scoreB: 0 },
    }),
  );

  const res = await call(
    controller.clearResult,
    adminReq(COMPANY_A, {
      params: { id: TOURNAMENT_A, categoryId: CATEGORY_A, matchId: firstMatch._id },
    }),
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.data.winner, null);
  const target = state.matches.find((match) => match.round === 2 && match.position === 0);
  assert.notEqual(target[firstMatch.position % 2 === 0 ? 'teamA' : 'teamB'], winner);
});

test('regeneration is refused with played results and allowed before play', async () => {
  resetState();
  state.tournaments[0].status = 'in_progress';
  seedTeams(4);
  const params = { id: TOURNAMENT_A, categoryId: CATEGORY_A };
  await call(controller.generateBracket, adminReq(COMPANY_A, { params, body: { seed: 3 } }));
  const original = state.matches.length;

  await call(
    controller.recordResult,
    adminReq(COMPANY_A, {
      params: { ...params, matchId: state.matches.find((match) => match.status === 'ready')._id },
      body: { scoreA: 2, scoreB: 0 },
    }),
  );
  const refused = await call(controller.generateBracket, adminReq(COMPANY_A, { params, body: { seed: 3 } }));
  assert.equal(refused.statusCode, 409);
  assert.equal(state.matches.length, original);

  resetState();
  state.tournaments[0].status = 'in_progress';
  seedTeams(4);
  await call(controller.generateBracket, adminReq(COMPANY_A, { params, body: { seed: 3 } }));
  const allowed = await call(controller.generateBracket, adminReq(COMPANY_A, { params, body: { seed: 9 } }));
  assert.equal(allowed.statusCode, 200);
  assert.equal(state.matches.length, original);
});

// ── Match scheduling (no Booking side effects) ──────────────────────────────

test('scheduling a match rejects an occupied slot without creating a booking', async () => {
  const firstMatch = await setupFourTeamBracket();
  const params = { id: TOURNAMENT_A, categoryId: CATEGORY_A, matchId: firstMatch._id };
  state.bookings.push({
    _id: 'booking-1',
    companyId: COMPANY_A,
    court: COURT_A,
    date: new Date('2026-11-11T00:00:00.000Z'),
    timeSlot: SLOT_A,
    status: 'confirmado',
  });

  const res = await call(
    controller.scheduleMatch,
    adminReq(COMPANY_A, { params, body: { court: COURT_A, date: '2026-11-11', timeSlot: SLOT_A } }),
  );
  assert.equal(res.statusCode, 409);
  assert.equal(firstMatch.court, undefined);
});

test('scheduling a free slot updates the match and never writes a booking', async () => {
  const firstMatch = await setupFourTeamBracket();
  const params = { id: TOURNAMENT_A, categoryId: CATEGORY_A, matchId: firstMatch._id };
  const res = await call(
    controller.scheduleMatch,
    adminReq(COMPANY_A, { params, body: { court: COURT_A, date: '2026-11-11', timeSlot: SLOT_A } }),
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.data.court, COURT_A);
  assert.equal(res.payload.data.date, '2026-11-11');
  assert.equal(state.bookings.length, 0);
});

// ── Review-fix regressions: identity, stale brackets, validation, safety ─────

test('player identity matches by userId alone when present', async () => {
  resetState();
  const params = { id: TOURNAMENT_A, categoryId: CATEGORY_A };
  const user1 = hexId(0xa11);
  const user2 = hexId(0xa12);
  const user3 = hexId(0xa13);
  const user4 = hexId(0xa14);
  const user5 = hexId(0xa15);

  const first = await call(
    controller.createTeam,
    adminReq(COMPANY_A, {
      params,
      body: {
        player1Name: 'Ana',
        player1UserId: user1,
        player1Phone: '111',
        player2Name: 'Beto',
        player2UserId: user2,
        player2Phone: '222',
      },
    }),
  );
  assert.equal(first.statusCode, 201);

  // Same human name and phone, but a different account: a different player.
  const differentUser = await call(
    controller.createTeam,
    adminReq(COMPANY_A, {
      params,
      body: {
        player1Name: 'Ana',
        player1UserId: user3,
        player1Phone: '111',
        player2Name: 'Carla',
        player2UserId: user4,
        player2Phone: '222',
      },
    }),
  );
  assert.equal(differentUser.statusCode, 201);

  // Same account id: duplicate, even with a different display name.
  const sameUser = await call(
    controller.createTeam,
    adminReq(COMPANY_A, {
      params,
      body: {
        player1Name: 'Ana Maria',
        player1UserId: user1,
        player2Name: 'Dora',
        player2UserId: user5,
      },
    }),
  );
  assert.equal(sameUser.statusCode, 400);
});

test('player identity falls back to name plus phone without userId', async () => {
  resetState();
  const params = { id: TOURNAMENT_A, categoryId: CATEGORY_A };
  const first = await call(
    controller.createTeam,
    adminReq(COMPANY_A, {
      params,
      body: { player1Name: 'Ana', player1Phone: '111', player2Name: 'Beto', player2Phone: '222' },
    }),
  );
  assert.equal(first.statusCode, 201);

  const duplicate = await call(
    controller.createTeam,
    adminReq(COMPANY_A, {
      params,
      body: { player1Name: ' ana ', player1Phone: '111', player2Name: 'Carla', player2Phone: '333' },
    }),
  );
  assert.equal(duplicate.statusCode, 400);
});

test('regeneration validates the new bracket before destroying the old one', async () => {
  resetState();
  state.tournaments[0].status = 'in_progress';
  seedTeams(4);
  const params = { id: TOURNAMENT_A, categoryId: CATEGORY_A };
  const first = await call(controller.generateBracket, adminReq(COMPANY_A, { params, body: { seed: 5 } }));
  assert.equal(first.statusCode, 200);
  const originalIds = state.matches.map((match) => match._id).sort();

  for (const team of [...state.teams]) {
    const withdrawn = await call(
      controller.updateTeam,
      adminReq(COMPANY_A, { params: { ...params, teamId: team._id }, body: { status: 'withdrawn' } }),
    );
    assert.equal(withdrawn.statusCode, 200);
  }

  const res = await call(controller.generateBracket, adminReq(COMPANY_A, { params, body: { seed: 5 } }));
  assert.equal(res.statusCode, 400);
  assert.deepEqual(state.matches.map((match) => match._id).sort(), originalIds);
});

test('team changes after generation stale the bracket until regeneration', async () => {
  const firstMatch = await setupFourTeamBracket();
  const params = { id: TOURNAMENT_A, categoryId: CATEGORY_A };
  const withdrawnTeam = firstMatch.teamA;

  const withdrawn = await call(
    controller.updateTeam,
    adminReq(COMPANY_A, { params: { ...params, teamId: withdrawnTeam }, body: { status: 'withdrawn' } }),
  );
  assert.equal(withdrawn.statusCode, 200);
  assert.equal(state.categories[0].bracketStale, true);

  const blocked = await call(
    controller.recordResult,
    adminReq(COMPANY_A, { params: { ...params, matchId: firstMatch._id }, body: { scoreA: 2, scoreB: 0 } }),
  );
  assert.equal(blocked.statusCode, 409);
  assert.equal(state.matches.find((match) => match._id === firstMatch._id).status, 'ready');

  const scheduled = await call(
    controller.scheduleMatch,
    adminReq(COMPANY_A, {
      params: { ...params, matchId: firstMatch._id },
      body: { court: COURT_A, date: '2026-11-11', timeSlot: SLOT_A },
    }),
  );
  assert.equal(scheduled.statusCode, 409);

  const regenerated = await call(controller.generateBracket, adminReq(COMPANY_A, { params, body: { seed: 13 } }));
  assert.equal(regenerated.statusCode, 200);
  assert.equal(state.categories[0].bracketStale, false);

  const ready = state.matches.find((match) => match.status === 'ready');
  const recorded = await call(
    controller.recordResult,
    adminReq(COMPANY_A, { params: { ...params, matchId: ready._id }, body: { scoreA: 2, scoreB: 0 } }),
  );
  assert.equal(recorded.statusCode, 200);
});

test('a stale bracket also blocks clearing an existing result', async () => {
  const firstMatch = await setupFourTeamBracket();
  const params = { id: TOURNAMENT_A, categoryId: CATEGORY_A };
  const recorded = await call(
    controller.recordResult,
    adminReq(COMPANY_A, { params: { ...params, matchId: firstMatch._id }, body: { scoreA: 2, scoreB: 0 } }),
  );
  assert.equal(recorded.statusCode, 200);

  const added = await call(
    controller.createTeam,
    adminReq(COMPANY_A, {
      params,
      body: { player1Name: 'Nueva', player2Name: 'Pareja', player1Phone: '900', player2Phone: '901' },
    }),
  );
  assert.equal(added.statusCode, 201);
  assert.equal(state.categories[0].bracketStale, true);

  const cleared = await call(
    controller.clearResult,
    adminReq(COMPANY_A, { params: { ...params, matchId: firstMatch._id } }),
  );
  assert.equal(cleared.statusCode, 409);
});

test('generation returns the draw seed and rejects invalid explicit seeds', async () => {
  resetState();
  state.tournaments[0].status = 'in_progress';
  seedTeams(4);
  const params = { id: TOURNAMENT_A, categoryId: CATEGORY_A };

  const random = await call(controller.generateBracket, adminReq(COMPANY_A, { params, body: {} }));
  assert.equal(random.statusCode, 200);
  assert.ok(Number.isInteger(random.payload.data.drawSeed));

  const explicit = await call(controller.generateBracket, adminReq(COMPANY_A, { params, body: { seed: 42 } }));
  assert.equal(explicit.statusCode, 200);
  assert.equal(explicit.payload.data.drawSeed, 42);

  const nonInteger = await call(controller.generateBracket, adminReq(COMPANY_A, { params, body: { seed: 'abc' } }));
  assert.equal(nonInteger.statusCode, 400);

  const outOfRange = await call(controller.generateBracket, adminReq(COMPANY_A, { params, body: { seed: -3 } }));
  assert.equal(outOfRange.statusCode, 400);
});

test('scheduling rejects non-object id operators without querying', async () => {
  const firstMatch = await setupFourTeamBracket();
  const params = { id: TOURNAMENT_A, categoryId: CATEGORY_A, matchId: firstMatch._id };
  const res = await call(
    controller.scheduleMatch,
    adminReq(COMPANY_A, {
      params,
      body: { court: { $ne: null }, date: '2026-11-11', timeSlot: SLOT_A },
    }),
  );
  assert.equal(res.statusCode, 400);
  assert.equal(firstMatch.court, undefined);
});

test('scheduling requires a ready match, in-progress tournament, window and selected court', async () => {
  const firstMatch = await setupFourTeamBracket();
  const params = { id: TOURNAMENT_A, categoryId: CATEGORY_A, matchId: firstMatch._id };

  const outOfWindow = await call(
    controller.scheduleMatch,
    adminReq(COMPANY_A, { params, body: { court: COURT_A, date: '2026-11-20', timeSlot: SLOT_A } }),
  );
  assert.equal(outOfWindow.statusCode, 400);

  const unselectedCourt = await call(
    controller.scheduleMatch,
    adminReq(COMPANY_A, { params, body: { court: COURT_A2, date: '2026-11-11', timeSlot: SLOT_A } }),
  );
  assert.equal(unselectedCourt.statusCode, 400);

  const pendingMatch = state.matches.find((match) => match.round === 2);
  const notReady = await call(
    controller.scheduleMatch,
    adminReq(COMPANY_A, {
      params: { ...params, matchId: pendingMatch._id },
      body: { court: COURT_A, date: '2026-11-11', timeSlot: SLOT_A },
    }),
  );
  assert.equal(notReady.statusCode, 409);

  state.tournaments[0].status = 'draft';
  const notRunning = await call(
    controller.scheduleMatch,
    adminReq(COMPANY_A, { params, body: { court: COURT_A, date: '2026-11-11', timeSlot: SLOT_A } }),
  );
  assert.equal(notRunning.statusCode, 409);
});

test('a non ObjectId path id returns 400 and unexpected errors do not leak messages', async () => {
  resetState();
  const badId = await call(controller.getTournament, adminReq(COMPANY_A, { params: { id: 'not-an-id' } }));
  assert.equal(badId.statusCode, 400);

  const tournamentModel = require.cache[require.resolve('../models/tournament.model')].exports;
  const originalFind = tournamentModel.find;
  const originalConsoleError = console.error;
  tournamentModel.find = () => {
    throw new Error('secret database detail');
  };
  console.error = () => {};
  try {
    const res = await call(controller.listTournaments, adminReq(COMPANY_A));
    assert.equal(res.statusCode, 500);
    assert.equal(res.payload.error, 'Error interno del servidor.');
  } finally {
    tournamentModel.find = originalFind;
    console.error = originalConsoleError;
  }
});

test('activation re-validates that selected courts still exist and are active', async () => {
  resetState();
  state.courts.find((court) => court._id === COURT_A).isActive = false;
  const res = await call(controller.activateTournament, adminReq(COMPANY_A, { params: { id: TOURNAMENT_A } }));
  assert.equal(res.statusCode, 400);
  assert.equal(state.tournaments[0].status, 'draft');
});

test('editing dates of an in-progress tournament reports conflicts unless confirmed', async () => {
  resetState();
  state.tournaments[0].status = 'in_progress';
  state.bookings.push({
    _id: 'booking-1',
    companyId: COMPANY_A,
    court: COURT_A,
    date: new Date('2026-11-14T00:00:00.000Z'),
    status: 'confirmado',
  });
  const params = { id: TOURNAMENT_A };

  const blocked = await call(
    controller.updateTournament,
    adminReq(COMPANY_A, { params, body: { endDate: '2026-11-15' } }),
  );
  assert.equal(blocked.statusCode, 409);
  assert.equal(blocked.payload.conflicts.length, 1);
  assert.equal(state.tournaments[0].endDate, '2026-11-12');

  const confirmed = await call(
    controller.updateTournament,
    adminReq(COMPANY_A, { params, body: { endDate: '2026-11-15', confirmConflicts: true } }),
  );
  assert.equal(confirmed.statusCode, 200);
  assert.equal(state.tournaments[0].endDate, '2026-11-15');
});

test('deleting a category cascades its withdrawn teams and unplayed matches', async () => {
  resetState();
  state.teams.push({
    _id: hexId(0xe9),
    companyId: COMPANY_A,
    tournament: TOURNAMENT_A,
    category: CATEGORY_A,
    status: 'withdrawn',
  });
  state.matches.push({
    _id: hexId(0xf9),
    companyId: COMPANY_A,
    tournament: TOURNAMENT_A,
    category: CATEGORY_A,
    status: 'pending',
  });
  const res = await call(
    controller.deleteCategory,
    adminReq(COMPANY_A, { params: { id: TOURNAMENT_A, categoryId: CATEGORY_A } }),
  );
  assert.equal(res.statusCode, 200);
  assert.equal(state.categories.length, 1);
  assert.equal(state.teams.length, 0);
  assert.equal(state.matches.length, 0);
});

test('deleting a team while a bracket exists is rejected to avoid dangling refs', async () => {
  const firstMatch = await setupFourTeamBracket();
  const params = { id: TOURNAMENT_A, categoryId: CATEGORY_A, teamId: firstMatch.teamA };
  const res = await call(controller.deleteTeam, adminReq(COMPANY_A, { params }));
  assert.equal(res.statusCode, 409);
  assert.ok(state.teams.some((team) => team._id === firstMatch.teamA));
});

test('a failed result write never leaves a played match without its advancement', async () => {
  const firstMatch = await setupFourTeamBracket();
  const matchModel = require.cache[require.resolve('../models/tournamentMatch.model')].exports;
  const originalUpdate = matchModel.findOneAndUpdate;
  matchModel.findOneAndUpdate = async (filter, update) => {
    if (update && update.status === 'played') throw new Error('write failed');
    return originalUpdate(filter, update);
  };
  try {
    const res = await call(
      controller.recordResult,
      adminReq(COMPANY_A, {
        params: { id: TOURNAMENT_A, categoryId: CATEGORY_A, matchId: firstMatch._id },
        body: { scoreA: 2, scoreB: 0 },
      }),
    );
    assert.equal(res.statusCode, 500);
  } finally {
    matchModel.findOneAndUpdate = originalUpdate;
  }
  assert.notEqual(firstMatch.status, 'played');
  const target = state.matches.find((match) => match.round === 2 && match.position === 0);
  assert.equal(target[firstMatch.position % 2 === 0 ? 'teamA' : 'teamB'], null);
});

test('restoring a withdrawn team re-checks category capacity', async () => {
  resetState();
  state.categories[0].maxTeams = 1;
  state.teams.push(
    {
      _id: TEAM_1,
      companyId: COMPANY_A,
      tournament: TOURNAMENT_A,
      category: CATEGORY_A,
      name: 'Ana / Beto',
      status: 'withdrawn',
    },
    {
      _id: hexId(0xe2),
      companyId: COMPANY_A,
      tournament: TOURNAMENT_A,
      category: CATEGORY_A,
      name: 'Carla / Dani',
      status: 'registered',
    },
  );
  const res = await call(
    controller.updateTeam,
    adminReq(COMPANY_A, {
      params: { id: TOURNAMENT_A, categoryId: CATEGORY_A, teamId: TEAM_1 },
      body: { status: 'registered' },
    }),
  );
  assert.equal(res.statusCode, 409);
  assert.equal(state.teams[0].status, 'withdrawn');
});

test('results are rejected once the tournament is finished', async () => {
  const firstMatch = await setupFourTeamBracket();
  state.tournaments[0].status = 'finished';
  const res = await call(
    controller.recordResult,
    adminReq(COMPANY_A, {
      params: { id: TOURNAMENT_A, categoryId: CATEGORY_A, matchId: firstMatch._id },
      body: { scoreA: 2, scoreB: 0 },
    }),
  );
  assert.equal(res.statusCode, 409);
  assert.equal(firstMatch.status, 'ready');
});

test('manual seeding fills missing seeds in registration order', async () => {
  resetState();
  state.tournaments[0].status = 'in_progress';
  state.categories[0].seeding = 'manual';
  seedTeams(4);
  for (const team of state.teams) team.seed = null;
  const params = { id: TOURNAMENT_A, categoryId: CATEGORY_A };
  const res = await call(controller.generateBracket, adminReq(COMPANY_A, { params, body: { seed: 77 } }));
  assert.equal(res.statusCode, 200);
  const firstRound = state.matches.filter((match) => match.round === 1);
  const pair = firstRound.find((match) => match.teamA === hexId(0xe001));
  assert.equal(pair.teamB, hexId(0xe004));
});
