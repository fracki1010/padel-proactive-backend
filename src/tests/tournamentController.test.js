'use strict';

// Route-layer tests for the tournament API. Every tournament-related Mongoose
// model is replaced with an in-memory fake (same pattern as
// courtTenantScope.test.js) so tenant scoping, lifecycle rules, bracket
// persistence and result advancement run without a live MongoDB.

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-tournaments';

const COMPANY_A = 'company-a';
const COMPANY_B = 'company-b';
const TOURNAMENT_A = 'tournament-a';
const TOURNAMENT_B = 'tournament-b';
const CATEGORY_A = 'category-a';
const CATEGORY_B = 'category-b';
const COURT_A = 'court-a';
const COURT_B = 'court-b';
const SLOT_A = 'slot-a';

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
    const created = { _id: `${key}-${state.nextId++}`, ...doc };
    state[key].push(created);
    return created;
  },
  insertMany: async (docs) => {
    const created = docs.map((doc) => ({ _id: `${key}-${state.nextId++}`, ...doc }));
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
    _id: 'category-a2',
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
    adminReq(COMPANY_A, { params: { id: TOURNAMENT_A, categoryId: 'category-a2' }, body: { ...player, player2Name: 'Otro' } }),
  );
  assert.equal(otherCategory.statusCode, 201);
});

test('withdrawal frees capacity and is refused after a recorded result', async () => {
  resetState();
  state.teams.push({
    _id: 'team-1',
    companyId: COMPANY_A,
    tournament: TOURNAMENT_A,
    category: CATEGORY_A,
    name: 'Ana / Beto',
    player1Name: 'Ana',
    player2Name: 'Beto',
    status: 'registered',
  });
  const params = { id: TOURNAMENT_A, categoryId: CATEGORY_A, teamId: 'team-1' };
  const withdrawn = await call(controller.updateTeam, adminReq(COMPANY_A, { params, body: { status: 'withdrawn' } }));
  assert.equal(withdrawn.statusCode, 200);
  assert.equal(state.teams[0].status, 'withdrawn');

  state.teams[0].status = 'registered';
  state.matches.push({ _id: 'match-1', companyId: COMPANY_A, tournament: TOURNAMENT_A, category: CATEGORY_A, status: 'played', teamA: 'team-1' });
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
      _id: `team-${index}`,
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
  assert.equal(res.payload.data.champion._id, 'team-1');
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
