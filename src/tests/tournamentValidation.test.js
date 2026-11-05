'use strict';

// Pure validation and lifecycle-rule tests for the tournament module.
// The functions under test have no database access, so these run without a
// live MongoDB connection.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  ALLOWED_TRANSITIONS,
  canTransition,
  validateTournamentInput,
  validateCategoryInput,
  validateTeamInput,
  playerIdentityKeys,
  hasDuplicatePlayer,
} = require('../services/tournament.service');

// ── Dates and tournament payload ─────────────────────────────────────────────

test('validateTournamentInput accepts a complete payload and trims the name', () => {
  const { data, errors } = validateTournamentInput({
    name: '  Copa de Verano  ',
    startDate: '2026-11-10',
    endDate: '2026-11-12',
    courts: ['court-1'],
  });
  assert.deepEqual(errors, []);
  assert.equal(data.name, 'Copa de Verano');
  assert.equal(data.startDate, '2026-11-10');
  assert.deepEqual(data.courts, ['court-1']);
});

test('validateTournamentInput rejects malformed dates, an inverted range and empty courts', () => {
  const malformed = validateTournamentInput({
    name: 'Cup',
    startDate: '10/11/2026',
    endDate: '2026-11-12',
    courts: ['court-1'],
  });
  assert.ok(malformed.errors.some((error) => /YYYY-MM-DD/.test(error)));

  const inverted = validateTournamentInput({
    name: 'Cup',
    startDate: '2026-11-12',
    endDate: '2026-11-10',
    courts: ['court-1'],
  });
  assert.ok(inverted.errors.some((error) => /fecha de fin/i.test(error)));

  const noCourts = validateTournamentInput({
    name: 'Cup',
    startDate: '2026-11-10',
    endDate: '2026-11-12',
    courts: [],
  });
  assert.ok(noCourts.errors.some((error) => /cancha/i.test(error)));
});

test('validateTournamentInput ignores a client-supplied companyId', () => {
  const { data, errors } = validateTournamentInput({
    name: 'Cup',
    startDate: '2026-11-10',
    endDate: '2026-11-12',
    courts: ['court-1'],
    companyId: 'attacker-company',
  });
  assert.deepEqual(errors, []);
  assert.equal(data.companyId, undefined);
});

test('validateTournamentInput partial update only validates provided fields', () => {
  const { data, errors } = validateTournamentInput({ name: '  Nuevo  ' }, { partial: true });
  assert.deepEqual(errors, []);
  assert.equal(data.name, 'Nuevo');
  assert.equal(data.startDate, undefined);
});

// ── Lifecycle transition matrix ──────────────────────────────────────────────

test('canTransition only allows the spec transitions', () => {
  const allowed = [
    ['draft', 'in_progress'],
    ['draft', 'cancelled'],
    ['in_progress', 'finished'],
    ['in_progress', 'cancelled'],
  ];
  for (const [from, to] of allowed) assert.equal(canTransition(from, to), true, `${from}->${to}`);

  const rejected = [
    ['in_progress', 'draft'],
    ['finished', 'in_progress'],
    ['cancelled', 'draft'],
    ['draft', 'finished'],
    ['finished', 'cancelled'],
  ];
  for (const [from, to] of rejected) assert.equal(canTransition(from, to), false, `${from}->${to}`);
  assert.deepEqual(ALLOWED_TRANSITIONS.finished, []);
  assert.deepEqual(ALLOWED_TRANSITIONS.cancelled, []);
});

// ── Category payload ─────────────────────────────────────────────────────────

test('validateCategoryInput requires a name and an integer maxTeams >= 2', () => {
  const valid = validateCategoryInput({ name: '  Primera  ', maxTeams: 16, order: 2 });
  assert.deepEqual(valid.errors, []);
  assert.equal(valid.data.name, 'Primera');
  assert.equal(valid.data.maxTeams, 16);
  assert.equal(valid.data.order, 2);

  const invalid = validateCategoryInput({ name: '  ', maxTeams: 1, order: 1.5 });
  assert.ok(invalid.errors.length >= 3);
});

// ── Team payload ─────────────────────────────────────────────────────────────

test('validateTeamInput requires both player names and a positive integer seed', () => {
  const valid = validateTeamInput({
    player1Name: ' Ana ',
    player2Name: 'Beto',
    player1Phone: ' 123 ',
    seed: 2,
  });
  assert.deepEqual(valid.errors, []);
  assert.equal(valid.data.player1Name, 'Ana');
  assert.equal(valid.data.player1Phone, '123');
  assert.equal(valid.data.seed, 2);

  const missing = validateTeamInput({ player1Name: 'Ana' });
  assert.ok(missing.errors.some((error) => /jugador 2/i.test(error)));

  const badSeed = validateTeamInput({ player1Name: 'Ana', player2Name: 'Beto', seed: 0 });
  assert.ok(badSeed.errors.some((error) => /semilla/i.test(error)));
});

// ── Duplicate player identity ────────────────────────────────────────────────

test('playerIdentityKeys matches by userId when present, otherwise name + phone', () => {
  const byUser = playerIdentityKeys({ player1Name: 'Ana', player1Phone: '123', player1UserId: 'u1' });
  const sameUser = playerIdentityKeys({ player2Name: 'Ana María', player2Phone: '999', player2UserId: 'u1' });
  assert.ok(byUser.some((key) => sameUser.includes(key)));

  const byName = playerIdentityKeys({ player1Name: 'Ana', player1Phone: '123', player1UserId: null });
  const sameName = playerIdentityKeys({ player1Name: ' ana ', player1Phone: '123', player1UserId: null });
  assert.ok(byName.some((key) => sameName.includes(key)));

  const different = playerIdentityKeys({ player1Name: 'Ana', player1Phone: '123', player1UserId: null });
  assert.equal(hasDuplicatePlayer([{ name: 'X', player1Name: 'Beto', player1Phone: '123' }], different), false);
});

test('hasDuplicatePlayer scans both players of every registered team', () => {
  const existing = [
    { name: 'T1', status: 'registered', player1Name: 'Ana', player1Phone: '123' },
    { name: 'T2', status: 'registered', player2Name: 'Beto', player2Phone: '456' },
    { name: 'T3', status: 'withdrawn', player1Name: 'Carla', player1Phone: '789' },
  ];
  const candidate = playerIdentityKeys({ player1Name: 'Beto', player1Phone: '456' });
  assert.equal(hasDuplicatePlayer(existing, candidate), true);

  const withdrawn = playerIdentityKeys({ player1Name: 'Carla', player1Phone: '789' });
  assert.equal(hasDuplicatePlayer(existing, withdrawn), false);
});
