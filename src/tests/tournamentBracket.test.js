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
  assert.match(result.errors[0], /team/i);
});

test('generateBracket resolves a single team as champion with no matches', () => {
  const only = team('solo');
  const result = generateBracket({ teams: [only] });
  assert.deepEqual(result.errors, []);
  assert.equal(result.bracketSize, 1);
  assert.equal(result.matches.length, 0);
  assert.equal(result.champion, only);
});

test('generateBracket rejects more than 64 teams', () => {
  const teams = Array.from({ length: 65 }, (_, i) => team(`t${i}`));
  const result = generateBracket({ teams });
  assert.equal(result.matches.length, 0);
  assert.match(result.errors[0], /64/);
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
  assert.ok(result.matches.every((match) => match.isBye === false));
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
    assert.equal(match.isBye, filled === 1);
  }
  const topSeed = firstRound.find((m) => m.teamA?.id === 't1' || m.teamB?.id === 't1');
  assert.equal(topSeed.isBye, true);

  const advanced = result.matches
    .filter((match) => match.round === 2)
    .flatMap((match) => [match.teamA?.id, match.teamB?.id])
    .filter(Boolean)
    .sort();
  assert.deepEqual(advanced, ['t1', 't2', 't3']);
});

test('generateBracket handles seven teams with one bye', () => {
  const teams = Array.from({ length: 7 }, (_, i) => team(`t${i + 1}`, i + 1));
  const result = generateBracket({ teams });
  assert.deepEqual(result.errors, []);
  assert.equal(result.bracketSize, 8);
  assert.equal(result.byeCount, 1);

  const byes = result.matches.filter((match) => match.isBye);
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
  assert.match(duplicated.errors[0], /seed 1/i);

  const outOfRange = generateBracket({ teams: [team('a', 1), team('b', 2), team('c', 3), team('d', 9)] });
  assert.match(outOfRange.errors[0], /between 1 and 4/i);
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

test('resolveResult derives the winner from a valid score', () => {
  assert.deepEqual(resolveResult({ scoreA: 2, scoreB: 1 }), { winner: 'A', errors: [] });
  assert.deepEqual(resolveResult({ scoreA: 1, scoreB: 2 }), { winner: 'B', errors: [] });
  assert.deepEqual(resolveResult({ scoreA: 2, scoreB: 1, winner: 'A' }), { winner: 'A', errors: [] });
});

test('resolveResult rejects ties, incomplete scores and a contradictory winner', () => {
  const tied = resolveResult({ scoreA: 2, scoreB: 2 });
  assert.equal(tied.winner, null);
  assert.match(tied.errors[0], /tie/i);

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
  assert.match(guard.reason, /downstream/i);
});
