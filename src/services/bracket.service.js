'use strict';

// Pure single-elimination bracket engine: no database access. Sizing, seeding,
// bye placement, draws, result validation and advancement are deterministic;
// the RNG is injectable so a draw can be reproduced from an integer seed.

const MIN_TEAMS = 2;
const MAX_TEAMS = 64;
const MAX_BRACKET_SIZE = 64;

const isInteger = Number.isInteger;
const isPowerOfTwo = (value) => isInteger(value) && value > 0 && (value & (value - 1)) === 0;

function nextPowerOfTwo(count) {
  if (!isInteger(count) || count < MIN_TEAMS || count > MAX_TEAMS) return null;
  let size = 2;
  while (size < count) size *= 2;
  return size;
}

// Classic interleaved seed order. Slot pairs (0,1), (2,3)... are first-round
// matches and each pair sums to size + 1.
function seedOrder(size) {
  if (!isPowerOfTwo(size) || size < 2) return [];
  let order = [1, 2];
  while (order.length < size) {
    const sum = order.length * 2 + 1;
    const next = [];
    for (let index = 0; index < order.length; index += 1) {
      const seed = order[index];
      if (index % 2 === 0) next.push(seed, sum - seed);
      else next.push(sum - seed, seed);
    }
    order = next;
  }
  return order;
}

// mulberry32: small, fast, deterministic PRNG.
function createSeededRng(seed) {
  let state = (isInteger(seed) ? seed : 0) >>> 0;
  return function rng() {
    state = (state + 0x6d2b79f5) | 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const shuffle = (items, rng) => {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rng() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
};

const readSeed = (value) =>
  value && typeof value === 'object' && isInteger(value.seed) ? value.seed : null;

const teamKey = (value) => {
  if (value == null) return null;
  if (typeof value !== 'object') return String(value);
  return String(value._id || value.id || value.name || JSON.stringify(value));
};

const nextRoundTarget = ({ round, position } = {}) => {
  if (!isInteger(round) || round < 1 || !isInteger(position) || position < 0) return null;
  return {
    round: round + 1,
    position: Math.floor(position / 2),
    slot: position % 2 === 0 ? 'teamA' : 'teamB',
  };
};

const buildSkeleton = (bracketSize) => {
  const totalRounds = Math.log2(bracketSize);
  const matches = [];
  let matchesInRound = bracketSize / 2;
  for (let round = 1; round <= totalRounds; round += 1) {
    for (let position = 0; position < matchesInRound; position += 1) {
      matches.push({ round, position, teamA: null, teamB: null, winner: null, status: 'pending', isBye: false });
    }
    matchesInRound /= 2;
  }
  return matches;
};

const emptyBracket = (errors) => ({ bracketSize: 0, totalRounds: 0, matches: [], byeCount: 0, errors });

function generateBracket({ teams, size, rng = Math.random } = {}) {
  if (!Array.isArray(teams)) return emptyBracket(['teams must be an array.']);
  if (teams.length === 0) return emptyBracket(['At least one team is required to generate a bracket.']);
  if (teams.length === 1) {
    return { bracketSize: 1, totalRounds: 0, matches: [], byeCount: 0, champion: teams[0], errors: [] };
  }
  if (teams.length > MAX_TEAMS) return emptyBracket([`A bracket supports at most ${MAX_TEAMS} teams.`]);

  const bracketSize = size == null ? nextPowerOfTwo(teams.length) : size;
  if (
    !isPowerOfTwo(bracketSize) ||
    bracketSize < MIN_TEAMS ||
    bracketSize > MAX_BRACKET_SIZE ||
    bracketSize < teams.length
  ) {
    return emptyBracket([
      `Bracket size must be a power of two between ${MIN_TEAMS} and ${MAX_BRACKET_SIZE} and cover every team.`,
    ]);
  }

  const explicitSeeds = new Map();
  const unseeded = [];
  const seedErrors = [];
  for (const entry of teams) {
    const seed = readSeed(entry);
    if (seed == null) {
      unseeded.push(entry);
    } else if (seed < 1 || seed > teams.length) {
      seedErrors.push(`Seed ${seed} must be between 1 and ${teams.length}.`);
    } else if (explicitSeeds.has(seed)) {
      seedErrors.push(`Seed ${seed} is assigned more than once.`);
    } else {
      explicitSeeds.set(seed, entry);
    }
  }
  if (seedErrors.length > 0) return emptyBracket(seedErrors);

  // Explicit seeds keep their slot; the rest fill free seed numbers in a
  // shuffled order so an injected RNG reproduces the draw.
  const seedToTeam = new Map(explicitSeeds);
  const freeSeeds = [];
  for (let seed = 1; seed <= teams.length; seed += 1) {
    if (!explicitSeeds.has(seed)) freeSeeds.push(seed);
  }
  const shuffled = shuffle(unseeded, rng);
  freeSeeds.forEach((seed, index) => seedToTeam.set(seed, shuffled[index]));

  const order = seedOrder(bracketSize);
  const matches = buildSkeleton(bracketSize);
  const matchesBySlot = new Map(matches.map((match) => [`${match.round}:${match.position}`, match]));

  let byeCount = 0;
  const firstRound = matches.filter((match) => match.round === 1);
  firstRound.forEach((match, index) => {
    const seedA = order[index * 2];
    const seedB = order[index * 2 + 1];
    match.teamA = seedA <= teams.length ? seedToTeam.get(seedA) : null;
    match.teamB = seedB <= teams.length ? seedToTeam.get(seedB) : null;
    const hasA = Boolean(match.teamA);
    const hasB = Boolean(match.teamB);
    match.isBye = hasA !== hasB;
    if (hasA && hasB) {
      match.status = 'ready';
    } else if (match.isBye) {
      // A bye advances its opponent automatically into the derived next slot.
      match.status = 'bye';
      match.winner = match.teamA || match.teamB;
      byeCount += 1;
      const target = nextRoundTarget(match);
      const next = matchesBySlot.get(`${target.round}:${target.position}`);
      if (next) next[target.slot] = match.winner;
    }
  });
  for (const match of matches) {
    if (match.round > 1 && match.teamA && match.teamB && match.status === 'pending') {
      match.status = 'ready';
    }
  }

  return { bracketSize, totalRounds: Math.log2(bracketSize), matches, byeCount, errors: [] };
}

function applyWinner({ matches, round, position, winner } = {}) {
  if (!Array.isArray(matches)) return { matches: [], errors: ['matches must be an array.'] };
  if (winner == null) return { matches, errors: ['A winner is required.'] };
  const index = matches.findIndex((match) => match.round === round && match.position === position);
  if (index === -1) return { matches, errors: ['Match not found.'] };

  const next = matches.map((match) => ({ ...match }));
  next[index] = { ...next[index], winner, status: 'played' };
  const target = nextRoundTarget({ round, position });
  const targetIndex = next.findIndex(
    (match) => match.round === target.round && match.position === target.position,
  );
  if (targetIndex !== -1) {
    const targetMatch = next[targetIndex];
    const occupied = targetMatch[target.slot];
    if (occupied != null && teamKey(occupied) !== teamKey(winner)) {
      return { matches, errors: ['The next-round slot is already occupied by another team.'] };
    }
    targetMatch[target.slot] = winner;
    if (targetMatch.teamA && targetMatch.teamB) targetMatch.status = 'ready';
  }
  return { matches: next, errors: [] };
}

// Score validation derives the winner instead of trusting the client. A
// supplied winner is accepted only when it agrees with the higher score.
function resolveResult({ scoreA, scoreB, winner } = {}) {
  const errors = [];
  const validA = isInteger(scoreA) && scoreA >= 0;
  const validB = isInteger(scoreB) && scoreB >= 0;
  if (!validA) errors.push('scoreA must be a non-negative integer.');
  if (!validB) errors.push('scoreB must be a non-negative integer.');

  let derived = null;
  if (validA && validB) {
    if (scoreA === scoreB) errors.push('Scores cannot be tied; a winner is required.');
    else derived = scoreA > scoreB ? 'A' : 'B';
  }
  if (winner != null) {
    if (winner !== 'A' && winner !== 'B') errors.push('winner must be "A" or "B".');
    else if (derived != null && winner !== derived) errors.push('winner must match the higher score.');
  }

  return errors.length > 0 ? { winner: null, errors } : { winner: derived, errors: [] };
}

function resolveChampion({ bracketSize, matches } = {}) {
  if (!Array.isArray(matches)) return { champion: null, errors: ['matches must be an array.'] };
  if (!isInteger(bracketSize) || bracketSize < MIN_TEAMS) {
    return { champion: null, errors: ['A bracket needs at least two teams to have a champion.'] };
  }
  const round = Math.log2(bracketSize);
  const final = matches.find((match) => match.round === round && match.position === 0);
  if (!final) return { champion: null, errors: ['Final match not found.'] };
  if (final.status !== 'played' || final.winner == null) {
    return { champion: null, errors: ['The final match has no recorded result.'] };
  }
  return { champion: final.winner, errors: [] };
}

const downstreamMatches = (matches, { round, position }) => {
  const found = [];
  let current = { round, position };
  for (;;) {
    const target = nextRoundTarget(current);
    const match = matches.find(
      (item) => item.round === target.round && item.position === target.position,
    );
    if (!match) break;
    found.push(match);
    current = target;
  }
  return found;
};

function canClearResult({ matches, round, position } = {}) {
  if (!Array.isArray(matches)) return { allowed: false, reason: 'matches must be an array.' };
  const played = downstreamMatches(matches, { round, position }).find(
    (match) => match.status === 'played',
  );
  if (played) return { allowed: false, reason: 'A downstream match already has a recorded result.' };
  return { allowed: true, reason: null };
}

function canRegenerate({ matches } = {}) {
  if (!Array.isArray(matches)) return { allowed: false, reason: 'matches must be an array.' };
  if (matches.some((match) => match.status === 'played')) {
    return { allowed: false, reason: 'The bracket already has recorded results.' };
  }
  return { allowed: true, reason: null };
}

module.exports = {
  MIN_TEAMS,
  MAX_TEAMS,
  MAX_BRACKET_SIZE,
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
};
