'use strict';

// Schema-level tests for the tournament models. Mongoose documents validate in
// memory (`doc.validate()`), so these run without a database connection.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const Tournament = require('../models/tournament.model');
const TournamentCategory = require('../models/tournamentCategory.model');
const TournamentTeam = require('../models/tournamentTeam.model');
const TournamentMatch = require('../models/tournamentMatch.model');

const oid = () => new mongoose.Types.ObjectId();
const hasIndex = (Model, expected, unique = false) =>
  Model.schema.indexes().some(([keys, options]) => {
    const sameKeys =
      Object.keys(keys).length === Object.keys(expected).length &&
      Object.keys(expected).every((key) => keys[key] === expected[key]);
    return sameKeys && Boolean(options.unique) === unique;
  });
const assertRejectsField = async (document, field) => {
  await assert.rejects(document.validate(), (error) => {
    assert.equal(error.name, 'ValidationError');
    assert.ok(error.errors?.[field], `expected a ${field} validation error`);
    return true;
  });
};

test('Tournament validates a complete document and trims name', async () => {
  const document = new Tournament({
    companyId: oid(),
    name: '  Copa de Verano  ',
    startDate: '2026-11-10',
    endDate: '2026-11-12',
    status: 'finished',
    courts: [oid()],
  });
  await document.validate();
  assert.equal(document.name, 'Copa de Verano');
  assert.equal(document.startDate, '2026-11-10');
  assert.equal(document.endDate, '2026-11-12');
  assert.equal(document.description, '');
  assert.equal(document.status, 'finished');
});

test('Tournament rejects malformed dates and an inverted range', async () => {
  await assertRejectsField(
    new Tournament({ companyId: oid(), name: 'Cup', startDate: '10/11/2026', endDate: '2026-11-12' }),
    'startDate',
  );
  await assertRejectsField(
    new Tournament({ companyId: oid(), name: 'Cup', startDate: '2026-11-12', endDate: '2026-11-10' }),
    'endDate',
  );
});

test('Tournament status uses finished (not completed) and declares tenant indexes', async () => {
  await assertRejectsField(
    new Tournament({
      companyId: oid(),
      name: 'Cup',
      startDate: '2026-11-10',
      endDate: '2026-11-12',
      status: 'completed',
    }),
    'status',
  );
  assert.ok(hasIndex(Tournament, { companyId: 1, status: 1, startDate: 1, endDate: 1 }));
  assert.ok(hasIndex(Tournament, { companyId: 1, createdAt: -1 }));
});

test('TournamentCategory enforces name, integer maxTeams and tenant uniqueness', async () => {
  const base = { companyId: oid(), tournament: oid(), name: 'Primera' };
  await new TournamentCategory({ ...base, maxTeams: 2 }).validate();
  await assertRejectsField(new TournamentCategory({ companyId: oid(), tournament: oid() }), 'name');
  await assertRejectsField(new TournamentCategory({ ...base, maxTeams: 1 }), 'maxTeams');
  await assertRejectsField(new TournamentCategory({ ...base, maxTeams: 2.5 }), 'maxTeams');
  assert.ok(hasIndex(TournamentCategory, { tournament: 1, name: 1 }, true));
  assert.ok(hasIndex(TournamentCategory, { companyId: 1, tournament: 1 }));
});

test('TournamentTeam defaults to registered and rejects design-only statuses', async () => {
  const base = { companyId: oid(), tournament: oid(), category: oid(), name: 'Pareja 1' };
  const registered = new TournamentTeam(base);
  await registered.validate();
  assert.equal(registered.status, 'registered');
  assert.equal(registered.player1Name, '');
  await assertRejectsField(new TournamentTeam({ ...base, status: 'active' }), 'status');
  await assertRejectsField(new TournamentTeam({ ...base, seed: 0 }), 'seed');
  await assertRejectsField(new TournamentTeam({ ...base, seed: 1.5 }), 'seed');
  assert.ok(hasIndex(TournamentTeam, { category: 1, name: 1 }, true));
  assert.ok(hasIndex(TournamentTeam, { companyId: 1, category: 1 }));
});

test('status enums match the spec values', async () => {
  const tournamentBase = { companyId: oid(), name: 'Cup', startDate: '2026-11-10', endDate: '2026-11-12' };
  for (const status of ['draft', 'in_progress', 'finished', 'cancelled']) {
    await new Tournament({ ...tournamentBase, status }).validate();
  }
  await assertRejectsField(new Tournament({ ...tournamentBase, status: 'completed' }), 'status');

  const teamBase = { companyId: oid(), tournament: oid(), category: oid(), name: 'Pareja' };
  for (const status of ['registered', 'withdrawn']) {
    await new TournamentTeam({ ...teamBase, status }).validate();
  }
  await assertRejectsField(new TournamentTeam({ ...teamBase, status: 'active' }), 'status');

  // The spec is silent on category status; the design defines these values.
  const categoryBase = { companyId: oid(), tournament: oid(), name: 'Primera' };
  for (const status of ['draft', 'active', 'completed']) {
    await new TournamentCategory({ ...categoryBase, status }).validate();
  }
});

test('TournamentMatch validates a ready match and rejects bad slots', async () => {
  const base = {
    companyId: oid(),
    tournament: oid(),
    category: oid(),
    round: 1,
    position: 0,
    teamA: oid(),
    teamB: oid(),
  };
  const ready = new TournamentMatch({ ...base, status: 'ready' });
  await ready.validate();
  assert.equal(ready.status, 'ready');
  assert.equal(ready.date, null);
  await assertRejectsField(new TournamentMatch({ ...base, round: 0 }), 'round');
  await assertRejectsField(new TournamentMatch({ ...base, position: -1 }), 'position');
  await assertRejectsField(new TournamentMatch({ ...base, date: '2026/11/10' }), 'date');
  await assertRejectsField(new TournamentMatch({ ...base, status: 'completed' }), 'status');
});

test('TournamentMatch declares the unique bracket slot and tenant indexes', () => {
  assert.ok(hasIndex(TournamentMatch, { category: 1, round: 1, position: 1 }, true));
  assert.ok(hasIndex(TournamentMatch, { companyId: 1, tournament: 1 }));
  assert.ok(hasIndex(TournamentMatch, { companyId: 1, court: 1, date: 1 }));
});

test('TournamentTeam stores optional per-player identity for duplicate detection', async () => {
  const base = {
    companyId: oid(),
    tournament: oid(),
    category: oid(),
    name: 'Ana / Beto',
    player1Name: 'Ana',
    player2Name: 'Beto',
  };
  const team = new TournamentTeam(base);
  await team.validate();
  assert.equal(team.player1UserId, null);
  assert.equal(team.player1Phone, '');
  assert.equal(team.player2UserId, null);
  assert.equal(team.player2Phone, '');

  const user1 = oid();
  const identified = new TournamentTeam({
    ...base,
    player1UserId: user1,
    player1Phone: ' 123456 ',
    player2Phone: ' 999 ',
  });
  await identified.validate();
  assert.equal(String(identified.player1UserId), String(user1));
  assert.equal(identified.player1Phone, '123456');
  assert.equal(identified.player2Phone, '999');
});

test('TournamentCategory tracks bracket staleness as an explicit flag', async () => {
  const base = { companyId: oid(), tournament: oid(), name: 'Primera' };
  const fresh = new TournamentCategory(base);
  await fresh.validate();
  assert.equal(fresh.bracketStale, false);

  const stale = new TournamentCategory({ ...base, bracketStale: true });
  await stale.validate();
  assert.equal(stale.bracketStale, true);
});
