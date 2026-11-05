'use strict';

// Unit tests for the pure single-elimination bracket engine.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  nextPowerOfTwo,
  seedOrder,
  createSeededRng,
  generateBracket,
  nextRoundTarget,
  applyWinner,
  resolveResult,
  resolveChampion,
  canClearResult,
  canRegenerate,
} = require('../services/bracket.service');

const team = (id, seed) => (seed == null ? { id } : { id, seed });
const ids = (matches) =>
  matches.map((m) => ({
    round: m.round,
    position: m.position,
    teamA: m.teamA ? m.teamA.id : null,
    teamB: m.teamB ? m.teamB.id : null,
  }));
const fourTeams = () => [team('a', 1), team('b', 2), team('c', 3), team('d', 4)];
const played = (bracket, round, position, slot = 'teamA') => {
  const match = bracket.matches.find((m) => m.round === round && m.position === position);
  return applyWinner({ matches: bracket.matches, round, position, winner: match[slot] });
};

test('nextPowerOfTwo returns the smallest power of two for 2..64 teams', () => {
  for (const [count, size] of [[2, 2], [3, 4], [4, 4], [5, 8], [8, 8], [9, 16], [33, 64], [64, 64]]) {
    assert.equal(nextPowerOfTwo(count), size, `count ${count}`);
  }
});

test('nextPowerOfTwo rejects counts outside 2..64 and non-integers', () => {
  for (const count of [0, 1, 65, 2.5]) assert.equal(nextPowerOfTwo(count), null);
});

test('seedOrder follows the classic bracket interleave', () => {
  assert.deepEqual(seedOrder(2), [1, 2]);
  assert.deepEqual(seedOrder(4), [1, 4, 3, 2]);
  assert.deepEqual(seedOrder(8), [1, 8, 5, 4, 3, 6, 7, 2]);
});

test('seedOrder keeps every seed once and pairs sum to size + 1', () => {
  const order = seedOrder(16);
  assert.equal(order.length, 16);
  assert.deepEqual([...order].sort((a, b) => a - b), Array.from({ length: 16 }, (_, i) => i + 1));
  for (let i = 0; i < order.length; i += 2) assert.equal(order[i] + order[i + 1], 17);
});

test('generateBracket rejects zero teams', () => {
  const result = generateBracket({ teams: [] });
  assert.equal(result.matches.length, 0);
  assert.match(result.errors[0], /equipo/i);
});

test('generateBracket resolves a single team as champion with no matches', () => {
  const only = team('solo');
  for (const size of [undefined, 1, 2, 4, 8]) {
    const input = size == null ? { teams: [only] } : { teams: [only], size };
    const result = generateBracket(input);
    assert.deepEqual(result.errors, [], `size ${size}`);
    assert.equal(result.bracketSize, 1, `size ${size}`);
    assert.equal(result.matches.length, 0, `size ${size}`);
    assert.equal(result.champion, only, `size ${size}`);
  }
});

test('generateBracket rejects null and non-object team entries', () => {
  const cases = [
    [null],
    [undefined],
    ['team'],
    [42],
    [{ id: 'a' }, null],
    [null, null, { id: 'a' }, { id: 'b' }],
  ];
  for (const teams of cases) {
    const result = generateBracket({ teams });
    assert.equal(result.matches.length, 0, JSON.stringify(teams));
    assert.ok(result.errors.length > 0, JSON.stringify(teams));
    assert.match(result.errors[0], /equipo|objeto/i);
  }
});

test('generateBracket rejects more than 64 teams', () => {
  const teams = Array.from({ length: 65 }, (_, i) => team(`t${i}`));
  const result = generateBracket({ teams });
  assert.equal(result.matches.length, 0);
  assert.match(result.errors[0], /64/);
});

test('generateBracket rejects an explicit size with an unplayable first round', () => {
  for (const teams of [[team('a'), team('b')], [team('a'), team('b'), team('c')]]) {
    const result = generateBracket({ teams, size: 8 });
    assert.equal(result.matches.length, 0, `${teams.length} teams in 8 slots`);
    assert.match(result.errors[0], /primera ronda|al menos un equipo/i);
  }
});

test('generateBracket accepts an explicit size equal to twice the team count', () => {
  const result = generateBracket({ teams: fourTeams(), size: 8 });
  assert.deepEqual(result.errors, []);
  assert.equal(result.bracketSize, 8);
  assert.equal(result.byeCount, 4);
  for (const match of result.matches.filter((item) => item.round === 1)) {
    assert.ok(match.teamA || match.teamB, 'every first-round match needs at least one team');
  }
});

test('generateBracket builds an exact power-of-two bracket without byes', () => {
  const result = generateBracket({ teams: fourTeams() });
  assert.deepEqual(result.errors, []);
  assert.equal(result.bracketSize, 4);
  assert.equal(result.totalRounds, 2);
  assert.equal(result.byeCount, 0);
  assert.equal(result.matches.length, 3);
  assert.deepEqual(ids(result.matches), [
    { round: 1, position: 0, teamA: 'a', teamB: 'd' },
    { round: 1, position: 1, teamA: 'c', teamB: 'b' },
    { round: 2, position: 0, teamA: null, teamB: null },
  ]);
  assert.ok(result.matches.every((match) => match.status !== 'bye'));
  assert.ok(result.matches.every((match) => !Object.prototype.hasOwnProperty.call(match, 'isBye')));
});

test('generateBracket gives an eight-slot bracket with three byes to five teams', () => {
  const teams = [team('t1', 1), team('t2', 2), team('t3', 3), team('t4', 4), team('t5', 5)];
  const result = generateBracket({ teams });
  assert.deepEqual(result.errors, []);
  assert.equal(result.bracketSize, 8);
  assert.equal(result.byeCount, 3);

  const firstRound = result.matches.filter((match) => match.round === 1);
  assert.equal(firstRound.length, 4);
  for (const match of firstRound) {
    const filled = Number(Boolean(match.teamA)) + Number(Boolean(match.teamB));
    assert.ok(filled >= 1, 'no first-round match may start empty');
    assert.equal(match.status === 'bye', filled === 1);
  }
  const topSeed = firstRound.find((m) => m.teamA?.id === 't1' || m.teamB?.id === 't1');
  assert.equal(topSeed.status, 'bye');

  const advanced = result.matches
    .filter((match) => match.round === 2)
    .flatMap((match) => [match.teamA?.id, match.teamB?.id])
    .filter(Boolean)
    .sort();
  assert.deepEqual(advanced, ['t1', 't2', 't3']);
  assert.ok(result.matches.every((match) => !Object.prototype.hasOwnProperty.call(match, 'isBye')));
});

test('generateBracket handles seven teams with one bye', () => {
  const teams = Array.from({ length: 7 }, (_, i) => team(`t${i + 1}`, i + 1));
  const result = generateBracket({ teams });
  assert.deepEqual(result.errors, []);
  assert.equal(result.bracketSize, 8);
  assert.equal(result.byeCount, 1);

  const byes = result.matches.filter((match) => match.status === 'bye');
  assert.equal(byes.length, 1);
  assert.equal(byes[0].round, 1);
  assert.ok([byes[0].teamA?.id, byes[0].teamB?.id].includes('t1'));

  const roundTwo = result.matches
    .filter((match) => match.round === 2)
    .flatMap((match) => [match.teamA?.id, match.teamB?.id])
    .filter(Boolean);
  assert.deepEqual(roundTwo, ['t1']);
});

test('generateBracket reproduces the same draw with the same RNG seed', () => {
  const teams = Array.from({ length: 8 }, (_, i) => team(`u${i}`));
  const first = generateBracket({ teams, rng: createSeededRng(42) });
  const second = generateBracket({ teams, rng: createSeededRng(42) });
  const other = generateBracket({ teams, rng: createSeededRng(43) });
  assert.deepEqual(ids(first.matches), ids(second.matches));
  assert.notDeepEqual(ids(first.matches), ids(other.matches));
});

test('generateBracket honors explicit seeds before the random draw', () => {
  const teams = [team('a', 3), team('b', 1), team('c', 4), team('d', 2)];
  const result = generateBracket({ teams, rng: createSeededRng(7) });
  assert.deepEqual(ids(result.matches), [
    { round: 1, position: 0, teamA: 'b', teamB: 'c' },
    { round: 1, position: 1, teamA: 'a', teamB: 'd' },
    { round: 2, position: 0, teamA: null, teamB: null },
  ]);
});

test('generateBracket rejects duplicate or out-of-range explicit seeds', () => {
  const duplicated = generateBracket({ teams: [team('a', 1), team('b', 1), team('c', 2), team('d', 3)] });
  assert.match(duplicated.errors[0], /semilla 1/i);

  const outOfRange = generateBracket({ teams: [team('a', 1), team('b', 2), team('c', 3), team('d', 9)] });
  assert.match(outOfRange.errors[0], /entre 1 y 4/i);
});

test('generateBracket rejects present but non-integer explicit seeds', () => {
  for (const seed of ['1', 1.5, NaN]) {
    const result = generateBracket({ teams: [team('a'), team('b'), { id: 'c', seed }] });
    assert.equal(result.matches.length, 0, `seed ${String(seed)}`);
    assert.match(result.errors[0], /semilla|entero/i);
  }
});

test('nextRoundTarget computes the derived parent slot', () => {
  assert.deepEqual(nextRoundTarget({ round: 1, position: 0 }), { round: 2, position: 0, slot: 'teamA' });
  assert.deepEqual(nextRoundTarget({ round: 1, position: 1 }), { round: 2, position: 0, slot: 'teamB' });
  assert.deepEqual(nextRoundTarget({ round: 2, position: 3 }), { round: 3, position: 1, slot: 'teamB' });
});

test('applyWinner advances the winner and marks the next match ready', () => {
  const bracket = generateBracket({ teams: fourTeams() });
  const afterFirst = played(bracket, 1, 0);
  assert.deepEqual(afterFirst.errors, []);
  const semi = afterFirst.matches.find((match) => match.round === 2);
  assert.equal(semi.teamA.id, 'a');
  assert.equal(semi.status, 'pending');

  const afterSecond = played({ matches: afterFirst.matches }, 1, 1);
  const readySemi = afterSecond.matches.find((match) => match.round === 2);
  assert.equal(readySemi.teamA.id, 'a');
  assert.equal(readySemi.teamB.id, 'c');
  assert.equal(readySemi.status, 'ready');
});

test('applyWinner rejects a winner that is not one of the two teams', () => {
  const bracket = generateBracket({ teams: fourTeams() });
  const result = applyWinner({ matches: bracket.matches, round: 1, position: 0, winner: team('z') });
  assert.equal(result.matches, bracket.matches);
  assert.match(result.errors[0], /ganador|equipo/i);
});

test('applyWinner rejects a match that does not have both teams', () => {
  const bracket = generateBracket({ teams: [team('a', 1), team('b', 2), team('c', 3)] });
  const pending = bracket.matches.find((match) => match.round === 2 && match.position === 0);
  assert.equal(pending.status, 'pending');
  const result = applyWinner({ matches: bracket.matches, round: 2, position: 0, winner: pending.teamA });
  assert.equal(result.matches, bracket.matches);
  assert.match(result.errors[0], /ambos equipos/i);
});

test('applyWinner refuses a pending match even when both teams are set', () => {
  const pending = [
    { round: 1, position: 0, teamA: team('a'), teamB: team('b'), winner: null, status: 'pending' },
  ];
  const result = applyWinner({ matches: pending, round: 1, position: 0, winner: team('a') });
  assert.equal(result.matches, pending);
  assert.match(result.errors[0], /listo|pendiente/i);
});

test('applyWinner rejects a match already played or decided by a bye', () => {
  const bracket = generateBracket({ teams: fourTeams() });
  const replayed = played(bracket, 1, 0);
  const replay = applyWinner({ matches: replayed.matches, round: 1, position: 0, winner: replayed.matches[0].teamA });
  assert.equal(replay.matches, replayed.matches);
  assert.match(replay.errors[0], /jugado|bye/i);

  const withBye = generateBracket({ teams: [team('a', 1), team('b', 2), team('c', 3)] });
  const byeMatch = withBye.matches.find((match) => match.status === 'bye');
  const onBye = applyWinner({ matches: withBye.matches, round: byeMatch.round, position: byeMatch.position, winner: byeMatch.winner });
  assert.equal(onBye.matches, withBye.matches);
  assert.match(onBye.errors[0], /bye/i);
});

test('the final match resolves the category champion', () => {
  const bracket = generateBracket({ teams: [team('a', 1), team('b', 2)] });
  const pending = resolveChampion({ bracketSize: bracket.bracketSize, matches: bracket.matches });
  assert.equal(pending.champion, null);
  assert.equal(pending.errors.length, 1);

  const done = played(bracket, 1, 0);
  const resolved = resolveChampion({ bracketSize: bracket.bracketSize, matches: done.matches });
  assert.deepEqual(resolved.errors, []);
  assert.equal(resolved.champion.id, 'a');
});

test('resolveChampion returns the single team of a one-team bracket', () => {
  const only = team('solo');
  const result = resolveChampion({ bracketSize: 1, matches: [], teams: [only] });
  assert.deepEqual(result.errors, []);
  assert.equal(result.champion, only);

  const missing = resolveChampion({ bracketSize: 1, matches: [] });
  assert.equal(missing.champion, null);
  assert.equal(missing.errors.length, 1);
});

test('resolveResult derives the winner from a valid score', () => {
  assert.deepEqual(resolveResult({ scoreA: 2, scoreB: 1 }), { winner: 'A', errors: [] });
  assert.deepEqual(resolveResult({ scoreA: 1, scoreB: 2 }), { winner: 'B', errors: [] });
  assert.deepEqual(resolveResult({ scoreA: 2, scoreB: 1, winner: 'A' }), { winner: 'A', errors: [] });
});

test('resolveResult rejects ties, incomplete scores and a contradictory winner', () => {
  const tied = resolveResult({ scoreA: 2, scoreB: 2 });
  assert.equal(tied.winner, null);
  assert.match(tied.errors[0], /empat/i);

  const tiedWithWinner = resolveResult({ scoreA: 2, scoreB: 2, winner: 'A' });
  assert.equal(tiedWithWinner.winner, null);
  assert.match(tiedWithWinner.errors[0], /empat/i);

  const incomplete = resolveResult({ scoreA: 2 });
  assert.equal(incomplete.winner, null);
  assert.match(incomplete.errors[0], /scoreB/i);

  const negative = resolveResult({ scoreA: -1, scoreB: 2 });
  assert.match(negative.errors[0], /scoreA/i);

  const contradictory = resolveResult({ scoreA: 2, scoreB: 1, winner: 'B' });
  assert.match(contradictory.errors[0], /winner/i);

  const unknown = resolveResult({ scoreA: 2, scoreB: 1, winner: 'X' });
  assert.match(unknown.errors[0], /winner/i);
});

test('canRegenerate is refused once any match has a recorded result', () => {
  const bracket = generateBracket({ teams: fourTeams() });
  assert.equal(canRegenerate({ matches: bracket.matches }).allowed, true);

  const guard = canRegenerate({ matches: played(bracket, 1, 0).matches });
  assert.equal(guard.allowed, false);
  assert.match(guard.reason, /result/i);
});

test('canClearResult is refused when a downstream match already played', () => {
  const bracket = generateBracket({ teams: fourTeams() });
  assert.equal(canClearResult({ matches: bracket.matches, round: 1, position: 0 }).allowed, true);

  const first = played(bracket, 1, 0).matches;
  const second = applyWinner({ matches: first, round: 1, position: 1, winner: first[1].teamA }).matches;
  const final = second.find((match) => match.round === 2 && match.position === 0);
  const done = applyWinner({ matches: second, round: 2, position: 0, winner: final.teamA }).matches;

  const guard = canClearResult({ matches: done, round: 1, position: 0 });
  assert.equal(guard.allowed, false);
  assert.match(guard.reason, /posterior/i);
});

test('canClearResult rejects invalid coordinates instead of throwing', () => {
  const bracket = generateBracket({ teams: fourTeams() });
  const invalid = [
    {},
    { round: 1 },
    { round: '1', position: 0 },
    { round: 1, position: '0' },
    { round: 1.5, position: 0 },
    { round: 1, position: -1 },
    { round: 0, position: 0 },
  ];
  for (const coords of invalid) {
    const guard = canClearResult({ matches: bracket.matches, ...coords });
    assert.equal(guard.allowed, false, JSON.stringify(coords));
    assert.match(guard.reason, /inválid/i);
  }
});
