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

// A missing or null seed means "unseeded"; any other non-integer value is an
// input error instead of a silent downgrade.
const readSeed = (value) => {
  if (!value || typeof value !== 'object') return { seed: null, invalid: false };
  if (!Object.prototype.hasOwnProperty.call(value, 'seed')) return { seed: null, invalid: false };
  if (value.seed == null) return { seed: null, invalid: false };
  if (!isInteger(value.seed)) return { seed: null, invalid: true };
  return { seed: value.seed, invalid: false };
};

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
      matches.push({ round, position, teamA: null, teamB: null, winner: null, status: 'pending' });
    }
    matchesInRound /= 2;
  }
  return matches;
};

const emptyBracket = (errors) => ({ bracketSize: 0, totalRounds: 0, matches: [], byeCount: 0, errors });

function generateBracket({ teams, size, rng = Math.random } = {}) {
  if (!Array.isArray(teams)) return emptyBracket(['teams debe ser un arreglo.']);
  if (teams.length === 0) return emptyBracket(['Se requiere al menos un equipo para generar la llave.']);
  if (teams.some((entry) => entry == null || typeof entry !== 'object')) {
    return emptyBracket(['Cada equipo debe ser un objeto válido.']);
  }
  // A single team is resolved as champion before any sizing logic, so an
  // explicit larger size cannot create unplayable bye-only matches.
  if (teams.length === 1) {
    return { bracketSize: 1, totalRounds: 0, matches: [], byeCount: 0, champion: teams[0], errors: [] };
  }
  if (teams.length > MAX_TEAMS) {
    return emptyBracket([`La llave admite como máximo ${MAX_TEAMS} equipos.`]);
  }

  const bracketSize = size == null ? nextPowerOfTwo(teams.length) : size;
  if (
    !isPowerOfTwo(bracketSize) ||
    bracketSize < MIN_TEAMS ||
    bracketSize > MAX_BRACKET_SIZE ||
    bracketSize < teams.length
  ) {
    return emptyBracket([
      `El tamaño de la llave debe ser una potencia de dos entre ${MIN_TEAMS} y ${MAX_BRACKET_SIZE} y cubrir todos los equipos.`,
    ]);
  }
  // Every first-round pairing needs at least one team, so the bracket cannot
  // start with empty matches. This holds only when teams >= size / 2.
  if (teams.length < bracketSize / 2) {
    return emptyBracket([
      'El tamaño de la llave es demasiado grande para la cantidad de equipos: cada partido de la primera ronda necesita al menos un equipo.',
    ]);
  }

  const explicitSeeds = new Map();
  const unseeded = [];
  const seedErrors = [];
  for (const entry of teams) {
    const { seed, invalid } = readSeed(entry);
    if (invalid) {
      seedErrors.push('Las semillas deben ser números enteros positivos.');
    } else if (seed == null) {
      unseeded.push(entry);
    } else if (seed < 1 || seed > teams.length) {
      seedErrors.push(`La semilla ${seed} debe estar entre 1 y ${teams.length}.`);
    } else if (explicitSeeds.has(seed)) {
      seedErrors.push(`La semilla ${seed} está asignada más de una vez.`);
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
    if (hasA && hasB) {
      match.status = 'ready';
    } else if (hasA !== hasB) {
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
  if (!Array.isArray(matches)) return { matches: [], errors: ['matches debe ser un arreglo.'] };
  const index = matches.findIndex((match) => match.round === round && match.position === position);
  if (index === -1) return { matches, errors: ['Partido no encontrado.'] };

  const match = matches[index];
  if (match.status === 'played' || match.status === 'bye') {
    return { matches, errors: ['No se puede registrar un resultado en un partido jugado o con bye.'] };
  }
  if (winner == null) return { matches, errors: ['Se requiere un ganador.'] };
  if (!match.teamA || !match.teamB) {
    return { matches, errors: ['El partido debe tener ambos equipos definidos para registrar un ganador.'] };
  }
  const winnerKey = teamKey(winner);
  if (winnerKey !== teamKey(match.teamA) && winnerKey !== teamKey(match.teamB)) {
    return { matches, errors: ['El ganador debe ser uno de los dos equipos del partido.'] };
  }
  // Results only apply to a ready match; pending matches must first have both
  // participants confirmed by the engine or an earlier advancement.
  if (match.status !== 'ready') {
    return { matches, errors: ['El partido debe estar listo para registrar un resultado.'] };
  }

  const next = matches.map((item) => ({ ...item }));
  next[index] = { ...next[index], winner, status: 'played' };
  const target = nextRoundTarget({ round, position });
  const targetIndex = next.findIndex(
    (match) => match.round === target.round && match.position === target.position,
  );
  if (targetIndex !== -1) {
    const targetMatch = next[targetIndex];
    const occupied = targetMatch[target.slot];
    if (occupied != null && teamKey(occupied) !== teamKey(winner)) {
      return { matches, errors: ['El cupo de la siguiente ronda ya está ocupado por otro equipo.'] };
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
  if (!validA) errors.push('scoreA debe ser un entero no negativo.');
  if (!validB) errors.push('scoreB debe ser un entero no negativo.');

  let derived = null;
  if (validA && validB) {
    // A tie is never a valid result; an explicit winner does not override it.
    if (scoreA === scoreB) errors.push('Los puntajes no pueden estar empatados.');
    else derived = scoreA > scoreB ? 'A' : 'B';
  }
  if (winner != null) {
    if (winner !== 'A' && winner !== 'B') errors.push('winner debe ser "A" o "B".');
    else if (derived != null && winner !== derived) errors.push('winner debe coincidir con el puntaje mayor.');
  }

  return errors.length > 0 ? { winner: null, errors } : { winner: derived, errors: [] };
}

function resolveChampion({ bracketSize, matches, teams } = {}) {
  if (!Array.isArray(matches)) return { champion: null, errors: ['matches debe ser un arreglo.'] };
  if (!isInteger(bracketSize) || bracketSize < 1) {
    return { champion: null, errors: ['El tamaño de la llave es inválido.'] };
  }
  // A one-team category is resolved as champion with no matches, matching
  // generateBracket's single-team contract.
  if (bracketSize === 1) {
    const only = Array.isArray(teams) && teams.length === 1 ? teams[0] : null;
    if (!only) return { champion: null, errors: ['Se requiere el equipo único para resolver el campeón.'] };
    return { champion: only, errors: [] };
  }
  const round = Math.log2(bracketSize);
  const final = matches.find((match) => match.round === round && match.position === 0);
  if (!final) return { champion: null, errors: ['No se encontró el partido final.'] };
  if (final.status !== 'played' || final.winner == null) {
    return { champion: null, errors: ['El partido final no tiene resultado registrado.'] };
  }
  return { champion: final.winner, errors: [] };
}

const downstreamMatches = (matches, { round, position } = {}) => {
  const found = [];
  let current = { round, position };
  for (;;) {
    const target = nextRoundTarget(current);
    if (!target) break;
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
  if (!Array.isArray(matches)) return { allowed: false, reason: 'matches debe ser un arreglo.' };
  if (!isInteger(round) || round < 1 || !isInteger(position) || position < 0) {
    return { allowed: false, reason: 'Coordenadas de partido inválidas.' };
  }
  const played = downstreamMatches(matches, { round, position }).find(
    (match) => match.status === 'played',
  );
  if (played) return { allowed: false, reason: 'Un partido posterior ya tiene un resultado registrado.' };
  return { allowed: true, reason: null };
}

function canRegenerate({ matches } = {}) {
  if (!Array.isArray(matches)) return { allowed: false, reason: 'matches debe ser un arreglo.' };
  if (matches.some((match) => match.status === 'played')) {
    return { allowed: false, reason: 'La llave ya tiene resultados registrados.' };
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
