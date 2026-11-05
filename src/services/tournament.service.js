'use strict';

// Tournament domain orchestration: CRUD, lifecycle, categories, teams, bracket
// persistence and result advancement. Every query is tenant-scoped and child
// resources re-verify the parent tournament belongs to the requesting company.

const Tournament = require('../models/tournament.model');
const TournamentCategory = require('../models/tournamentCategory.model');
const TournamentTeam = require('../models/tournamentTeam.model');
const TournamentMatch = require('../models/tournamentMatch.model');
const Court = require('../models/court.model');
const TimeSlot = require('../models/timeSlot.model');
const Booking = require('../models/booking.model');
const FixedBooking = require('../models/fixedBooking.model');
const SlotLock = require('../models/slotLock.model');
const { normalizePhone } = require('../utils/identityNormalization');
const {
  findActivationConflicts,
  getBlockedCourtsForDate,
  toUtcDate,
} = require('./tournamentBlocking.service');
const {
  generateBracket: buildBracket,
  applyWinner,
  resolveResult,
  canClearResult,
  canRegenerate,
  nextRoundTarget,
  createSeededRng,
} = require('./bracket.service');

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const OBJECT_ID = /^[0-9a-fA-F]{24}$/;
const MAX_TOURNAMENT_DAYS = 120;
const MAX_DRAW_SEED = 2147483647;
const STATUSES = ['draft', 'in_progress', 'finished', 'cancelled'];
const ALLOWED_TRANSITIONS = {
  draft: ['in_progress', 'cancelled'],
  in_progress: ['finished', 'cancelled'],
  finished: [],
  cancelled: [],
};
const SEEDING = ['manual', 'shuffle'];
const TEAM_STATUSES = ['registered', 'withdrawn'];

const ok = (status, data, extra = {}) => ({ ok: true, status, data, ...extra });
const fail = (status, error, extra = {}) => ({ ok: false, status, error, ...extra });
const plain = (doc) => (doc && typeof doc.toObject === 'function' ? doc.toObject() : doc);
const isObjectId = (value) => typeof value === 'string' && OBJECT_ID.test(value);
const invalidId = () => fail(400, 'Identificador inválido.');
const isValidDate = (value) =>
  typeof value === 'string' && ISO_DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`));
const normalizeName = (value = '') =>
  String(value || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const canTransition = (from, to) => Boolean(ALLOWED_TRANSITIONS[from]?.includes(to));
const daySpan = (startDate, endDate) =>
  Math.round((toUtcDate(endDate).getTime() - toUtcDate(startDate).getTime()) / 86400000) + 1;

// ── Pure payload validation ─────────────────────────────────────────────────

const validateTournamentInput = (body = {}, { partial = false } = {}) => {
  const source = body && typeof body === 'object' ? body : {};
  const data = {};
  const errors = [];

  if (source.name !== undefined) {
    const name = String(source.name).trim();
    if (!name) errors.push('El nombre del torneo es obligatorio.');
    else data.name = name;
  } else if (!partial) errors.push('El nombre del torneo es obligatorio.');

  if (source.description !== undefined) data.description = String(source.description).trim();

  for (const field of ['startDate', 'endDate']) {
    if (source[field] !== undefined) {
      if (!isValidDate(source[field])) errors.push(`${field} debe usar el formato YYYY-MM-DD.`);
      else data[field] = source[field];
    } else if (!partial) {
      errors.push(`${field} es obligatorio.`);
    }
  }

  if (source.courts !== undefined) {
    if (!Array.isArray(source.courts) || source.courts.length === 0 || source.courts.some((id) => !id)) {
      errors.push('El torneo debe tener al menos una cancha.');
    } else {
      data.courts = [...new Set(source.courts.map(String))];
    }
  } else if (!partial) {
    errors.push('El torneo debe tener al menos una cancha.');
  }

  if (data.startDate && data.endDate) {
    if (data.endDate < data.startDate) {
      errors.push('La fecha de fin debe ser igual o posterior a la fecha de inicio.');
    } else if (daySpan(data.startDate, data.endDate) > MAX_TOURNAMENT_DAYS) {
      errors.push(`El torneo no puede abarcar más de ${MAX_TOURNAMENT_DAYS} días.`);
    }
  }
  return { data, errors };
};

const validateCategoryInput = (body = {}, { partial = false } = {}) => {
  const source = body && typeof body === 'object' ? body : {};
  const data = {};
  const errors = [];

  if (source.name !== undefined) {
    const name = String(source.name).trim();
    if (!name) errors.push('El nombre de la categoría es obligatorio.');
    else data.name = name;
  } else if (!partial) errors.push('El nombre de la categoría es obligatorio.');

  if (source.maxTeams !== undefined) {
    if (source.maxTeams === null) data.maxTeams = null;
    else if (!Number.isInteger(source.maxTeams) || source.maxTeams < 2 || source.maxTeams > 64) {
      errors.push('maxTeams debe ser un entero entre 2 y 64.');
    } else data.maxTeams = source.maxTeams;
  }

  if (source.order !== undefined) {
    if (!Number.isInteger(source.order)) errors.push('order debe ser un entero.');
    else data.order = source.order;
  }

  if (source.seeding !== undefined) {
    if (!SEEDING.includes(source.seeding)) errors.push(`seeding debe ser uno de: ${SEEDING.join(', ')}.`);
    else data.seeding = source.seeding;
  }
  return { data, errors };
};

const validateTeamInput = (body = {}, { partial = false } = {}) => {
  const source = body && typeof body === 'object' ? body : {};
  const data = {};
  const errors = [];

  for (const [field, label] of [['player1Name', 'jugador 1'], ['player2Name', 'jugador 2']]) {
    if (source[field] !== undefined) {
      const value = String(source[field]).trim();
      if (!value) errors.push(`El nombre del ${label} es obligatorio.`);
      else data[field] = value;
    } else if (!partial) {
      errors.push(`El nombre del ${label} es obligatorio.`);
    }
  }

  if (source.name !== undefined) {
    const name = String(source.name).trim();
    if (!name) errors.push('El nombre de la pareja no puede estar vacío.');
    else data.name = name;
  }

  for (const [field, label] of [['player1UserId', 'jugador 1'], ['player2UserId', 'jugador 2']]) {
    if (source[field] !== undefined) {
      const value = source[field] || null;
      if (value !== null && !isObjectId(String(value))) {
        errors.push(`El usuario del ${label} es inválido.`);
      } else {
        data[field] = value;
      }
    }
  }
  for (const field of ['player1Phone', 'player2Phone']) {
    if (source[field] !== undefined) data[field] = String(source[field] || '').trim();
  }

  if (source.seed !== undefined) {
    if (source.seed === null) data.seed = null;
    else if (!Number.isInteger(source.seed) || source.seed < 1) errors.push('La semilla debe ser un entero positivo.');
    else data.seed = source.seed;
  }

  if (source.status !== undefined) {
    if (!TEAM_STATUSES.includes(source.status)) errors.push(`status debe ser uno de: ${TEAM_STATUSES.join(', ')}.`);
    else data.status = source.status;
  }
  return { data, errors };
};

// A player is identified by `userId` when present, otherwise by normalized
// name plus phone. The userId is authoritative: two accounts sharing a name
// and phone are still different players.
const playerIdentityKeys = (source = {}) => {
  const keys = [];
  for (const slot of [1, 2]) {
    const userId = source[`player${slot}UserId`];
    if (userId) {
      keys.push(`uid:${String(userId)}`);
      continue;
    }
    const name = normalizeName(source[`player${slot}Name`]);
    if (name) keys.push(`name:${name}|phone:${normalizePhone(source[`player${slot}Phone`])}`);
  }
  return keys;
};

const hasDuplicatePlayer = (teams, candidateKeys) =>
  teams.some((team) => {
    if (team.status && team.status !== 'registered') return false;
    return playerIdentityKeys(team).some((key) => candidateKeys.includes(key));
  });

// ── Shared lookups (tenant scoped on every level) ───────────────────────────

const findTournament = (companyId, id) => Tournament.findOne({ _id: id, companyId });

const ensureTournament = async (companyId, id) => {
  if (!isObjectId(String(id))) return { error: invalidId() };
  const tournament = await findTournament(companyId, id);
  return tournament ? { tournament } : { error: fail(404, 'Torneo no encontrado.') };
};

const ensureCategory = async (companyId, tournamentId, categoryId) => {
  const parent = await ensureTournament(companyId, tournamentId);
  if (parent.error) return parent;
  if (!isObjectId(String(categoryId))) return { error: invalidId() };
  const category = await TournamentCategory.findOne({
    _id: categoryId,
    companyId,
    tournament: tournamentId,
  });
  if (!category) return { error: fail(404, 'Categoría no encontrada.') };
  return { tournament: parent.tournament, category };
};

const ensureTeam = async (companyId, tournamentId, categoryId, teamId) => {
  const parent = await ensureCategory(companyId, tournamentId, categoryId);
  if (parent.error) return parent;
  if (!isObjectId(String(teamId))) return { error: invalidId() };
  const team = await TournamentTeam.findOne({ _id: teamId, companyId, tournament: tournamentId, category: categoryId });
  if (!team) return { error: fail(404, 'Pareja no encontrada.') };
  return { ...parent, team };
};

const validateCourts = async (companyId, courtIds) => {
  const unique = [...new Set(courtIds.map(String))];
  if (!unique.every(isObjectId)) return fail(400, 'Identificador de cancha inválido.');
  const courts = await Court.find({ _id: { $in: unique }, companyId, isActive: true });
  return courts.length === unique.length ? null : fail(400, 'Alguna cancha no existe o no está activa en tu empresa.');
};

const STALE_BRACKET = 'La llave está desactualizada; regenerala antes de continuar.';
const FROZEN_BRACKET = 'No se puede modificar la lista de parejas: ya hay partidos jugados.';

// A category with an existing result is frozen: adding, withdrawing or deleting
// a team would invalidate results that are already part of the bracket, so those
// writes are rejected instead of silently corrupting the tournament history.
const categoryFrozen = async (companyId, categoryId) =>
  (await TournamentMatch.countDocuments({ companyId, category: categoryId, status: 'played' })) > 0;

// Team edits after generation invalidate the persisted bracket so stale teams
// cannot keep playing until the admin regenerates.
const markBracketStale = async (companyId, categoryId, category) => {
  if (!category || category.bracketSize == null) return;
  await TournamentCategory.findOneAndUpdate(
    { _id: categoryId, companyId },
    { bracketStale: true },
    { new: true },
  );
};

const ensureMatch = async (companyId, tournamentId, categoryId, matchId) => {
  if (!isObjectId(String(matchId))) return { error: invalidId() };
  const match = await TournamentMatch.findOne({
    _id: matchId,
    companyId,
    tournament: tournamentId,
    category: categoryId,
  });
  if (!match) return { error: fail(404, 'Partido no encontrado.') };
  return { match };
};

// Explicit draws must be integers; a random draw returns the seed it used so
// the admin can reproduce the bracket later.
const resolveDrawSeed = (seed) => {
  if (seed === undefined || seed === null) {
    return { seed: Math.floor(Math.random() * (MAX_DRAW_SEED + 1)) };
  }
  if (!Number.isInteger(seed) || seed < 0 || seed > MAX_DRAW_SEED) {
    return { error: `La semilla de sorteo debe ser un entero entre 0 y ${MAX_DRAW_SEED}.` };
  }
  return { seed };
};

// Withdrawn teams can leave a seed above the remaining team count; the engine
// only accepts seeds within the current set, so treat those as unseeded.
const normalizeTeamSeeds = (teams) =>
  teams.map((team) => (Number.isInteger(team.seed) && team.seed > teams.length ? { ...team, seed: null } : team));

// Manual seeding keeps registration order: missing seeds are filled in order
// so the pure engine does not shuffle them.
const withSequentialSeeds = (teams) => {
  const used = new Set(teams.map((team) => team.seed).filter((value) => Number.isInteger(value)));
  let cursor = 1;
  return teams.map((team) => {
    if (Number.isInteger(team.seed)) return team;
    while (used.has(cursor)) cursor += 1;
    used.add(cursor);
    return { ...team, seed: cursor };
  });
};

// ── Tournament CRUD + lifecycle ─────────────────────────────────────────────

async function listTournaments({ companyId, status }) {
  const filter = { companyId };
  if (status !== undefined && status !== '') {
    if (!STATUSES.includes(status)) return fail(400, 'Estado de torneo inválido.');
    filter.status = status;
  }
  const data = await Tournament.find(filter).sort({ startDate: 1, createdAt: -1 });
  return ok(200, data);
}

async function getTournament({ companyId, id }) {
  const parent = await ensureTournament(companyId, id);
  return parent.error ? parent.error : ok(200, parent.tournament);
}

async function getBlockedCourts({ companyId, date }) {
  if (!ISO_DATE.test(String(date || ''))) return fail(400, 'La fecha debe tener formato YYYY-MM-DD.');
  const blocks = await getBlockedCourtsForDate(companyId, date);
  return ok(200, {
    date: blocks.date,
    courtIds: blocks.courtIds,
    tournaments: blocks.tournaments,
  });
}

async function createTournament({ companyId, adminId, input }) {
  const { data, errors } = validateTournamentInput(input);
  if (errors.length) return fail(400, errors[0]);
  const courtError = await validateCourts(companyId, data.courts);
  if (courtError) return courtError;
  const tournament = await Tournament.create({ ...data, companyId, createdBy: adminId || null });
  return ok(201, tournament);
}

async function updateTournament({ companyId, id, input, confirmConflicts = false }) {
  const parent = await ensureTournament(companyId, id);
  if (parent.error) return parent.error;
  const { data, errors } = validateTournamentInput(input, { partial: true });
  if (errors.length) return fail(400, errors[0]);

  const startDate = data.startDate ?? parent.tournament.startDate;
  const endDate = data.endDate ?? parent.tournament.endDate;
  if (endDate < startDate) return fail(400, 'La fecha de fin debe ser igual o posterior a la fecha de inicio.');
  if (daySpan(startDate, endDate) > MAX_TOURNAMENT_DAYS) {
    return fail(400, `El torneo no puede abarcar más de ${MAX_TOURNAMENT_DAYS} días.`);
  }
  if (data.courts) {
    const courtError = await validateCourts(companyId, data.courts);
    if (courtError) return courtError;
  }

  // Date/court edits while in progress must go through the same conflict
  // acknowledgement as activation.
  let conflicts = [];
  const scheduleChanged =
    data.startDate !== undefined || data.endDate !== undefined || data.courts !== undefined;
  if (parent.tournament.status === 'in_progress' && scheduleChanged) {
    conflicts = await findActivationConflicts({
      companyId,
      courtIds: data.courts ?? parent.tournament.courts ?? [],
      startDate,
      endDate,
    });
    if (conflicts.length > 0 && confirmConflicts !== true) {
      return fail(409, 'Hay reservas existentes en las canchas y fechas del torneo.', { conflicts });
    }
  }

  const updated = await Tournament.findOneAndUpdate({ _id: id, companyId }, data, {
    new: true,
    runValidators: true,
  });
  return ok(200, updated, conflicts.length > 0 ? { conflicts } : {});
}

async function deleteTournament({ companyId, id }) {
  const parent = await ensureTournament(companyId, id);
  if (parent.error) return parent.error;
  if (parent.tournament.status === 'in_progress') {
    return fail(409, 'No se puede eliminar un torneo en curso.');
  }
  await TournamentCategory.deleteMany({ companyId, tournament: id });
  await TournamentTeam.deleteMany({ companyId, tournament: id });
  await TournamentMatch.deleteMany({ companyId, tournament: id });
  await Tournament.findOneAndDelete({ _id: id, companyId });
  return ok(200, { _id: id });
}

async function transition({ companyId, id, to }) {
  const parent = await ensureTournament(companyId, id);
  if (parent.error) return parent.error;
  if (!canTransition(parent.tournament.status, to)) {
    return fail(400, `No se puede pasar un torneo de ${parent.tournament.status} a ${to}.`);
  }
  const updated = await Tournament.findOneAndUpdate(
    { _id: id, companyId },
    { status: to },
    { new: true, runValidators: true },
  );
  return ok(200, updated);
}

async function activateTournament({ companyId, id, confirmConflicts = false }) {
  const parent = await ensureTournament(companyId, id);
  if (parent.error) return parent.error;
  if (!canTransition(parent.tournament.status, 'in_progress')) {
    return fail(400, `No se puede activar un torneo en estado ${parent.tournament.status}.`);
  }

  // Courts can be deactivated or removed between draft and activation.
  const courtError = await validateCourts(companyId, parent.tournament.courts || []);
  if (courtError) return courtError;

  const conflicts = await findActivationConflicts({
    companyId,
    courtIds: parent.tournament.courts || [],
    startDate: parent.tournament.startDate,
    endDate: parent.tournament.endDate,
  });
  if (conflicts.length > 0 && confirmConflicts !== true) {
    return fail(409, 'Hay reservas existentes en las canchas y fechas del torneo.', { conflicts });
  }

  const updated = await Tournament.findOneAndUpdate(
    { _id: id, companyId },
    { status: 'in_progress', activatedAt: new Date() },
    { new: true, runValidators: true },
  );
  return ok(200, updated, { conflicts });
}

const completeTournament = ({ companyId, id }) => transition({ companyId, id, to: 'finished' });
const cancelTournament = ({ companyId, id }) => transition({ companyId, id, to: 'cancelled' });

// ── Categories ──────────────────────────────────────────────────────────────

async function listCategories({ companyId, tournamentId }) {
  const parent = await ensureTournament(companyId, tournamentId);
  if (parent.error) return parent.error;
  const data = await TournamentCategory.find({ companyId, tournament: tournamentId }).sort({ order: 1, createdAt: 1 });
  return ok(200, data);
}

async function createCategory({ companyId, tournamentId, input }) {
  const parent = await ensureTournament(companyId, tournamentId);
  if (parent.error) return parent.error;
  const { data, errors } = validateCategoryInput(input);
  if (errors.length) return fail(400, errors[0]);

  const existing = await TournamentCategory.find({ companyId, tournament: tournamentId });
  if (existing.some((category) => normalizeName(category.name) === normalizeName(data.name))) {
    return fail(400, 'Ya existe una categoría con ese nombre en el torneo.');
  }
  const category = await TournamentCategory.create({ ...data, companyId, tournament: tournamentId });
  return ok(201, category);
}

async function updateCategory({ companyId, tournamentId, categoryId, input }) {
  const parent = await ensureCategory(companyId, tournamentId, categoryId);
  if (parent.error) return parent.error;
  const { data, errors } = validateCategoryInput(input, { partial: true });
  if (errors.length) return fail(400, errors[0]);

  if (data.name) {
    const existing = await TournamentCategory.find({ companyId, tournament: tournamentId });
    const duplicate = existing.some(
      (category) => String(category._id) !== String(categoryId) && normalizeName(category.name) === normalizeName(data.name),
    );
    if (duplicate) return fail(400, 'Ya existe una categoría con ese nombre en el torneo.');
  }
  const updated = await TournamentCategory.findOneAndUpdate(
    { _id: categoryId, companyId, tournament: tournamentId },
    data,
    { new: true, runValidators: true },
  );
  return ok(200, updated);
}

async function deleteCategory({ companyId, tournamentId, categoryId }) {
  const parent = await ensureCategory(companyId, tournamentId, categoryId);
  if (parent.error) return parent.error;

  const teams = await TournamentTeam.countDocuments({
    companyId,
    tournament: tournamentId,
    category: categoryId,
    status: 'registered',
  });
  if (teams > 0) return fail(409, 'No se puede eliminar una categoría con parejas registradas.');
  const played = await TournamentMatch.countDocuments({ companyId, category: categoryId, status: 'played' });
  if (played > 0) return fail(409, 'No se puede eliminar una categoría con partidos jugados.');

  // Cascade the remaining children so no orphan team/match rows survive.
  await TournamentTeam.deleteMany({ companyId, tournament: tournamentId, category: categoryId });
  await TournamentMatch.deleteMany({ companyId, tournament: tournamentId, category: categoryId });
  await TournamentCategory.findOneAndDelete({ _id: categoryId, companyId, tournament: tournamentId });
  return ok(200, { _id: categoryId });
}

// ── Teams ───────────────────────────────────────────────────────────────────

async function listTeams({ companyId, tournamentId, categoryId }) {
  const parent = await ensureCategory(companyId, tournamentId, categoryId);
  if (parent.error) return parent.error;
  const data = await TournamentTeam.find({ companyId, tournament: tournamentId, category: categoryId })
    .sort({ seed: 1, createdAt: 1 });
  return ok(200, data);
}

const registeredTeams = async (companyId, tournamentId, categoryId) => {
  const teams = await TournamentTeam.find({ companyId, tournament: tournamentId, category: categoryId });
  return teams.filter((team) => !team.status || team.status === 'registered');
};

async function createTeam({ companyId, tournamentId, categoryId, input }) {
  const parent = await ensureCategory(companyId, tournamentId, categoryId);
  if (parent.error) return parent.error;
  const { data, errors } = validateTeamInput(input);
  if (errors.length) return fail(400, errors[0]);
  if (await categoryFrozen(companyId, categoryId)) return fail(409, FROZEN_BRACKET);

  const teams = await TournamentTeam.find({ companyId, tournament: tournamentId, category: categoryId });
  const active = teams.filter((team) => !team.status || team.status === 'registered');

  const { maxTeams } = parent.category;
  if (Number.isInteger(maxTeams) && active.length >= maxTeams) {
    return fail(409, 'La categoría alcanzó el máximo de parejas.');
  }

  const name = data.name || `${data.player1Name} / ${data.player2Name}`;
  if (active.some((team) => normalizeName(team.name) === normalizeName(name))) {
    return fail(400, 'Ya existe una pareja con ese nombre en la categoría.');
  }
  if (hasDuplicatePlayer(active, playerIdentityKeys(data))) {
    return fail(400, 'Uno de los jugadores ya está registrado en esta categoría.');
  }
  if (data.seed != null && active.some((team) => team.seed === data.seed)) {
    return fail(400, 'La semilla ya está asignada en esta categoría.');
  }

  // Mark the bracket stale BEFORE persisting the roster change: a failed write
  // may leave a stale flag that regeneration clears, but a changed roster must
  // never be paired with a bracket that still looks valid.
  await markBracketStale(companyId, categoryId, parent.category);
  const team = await TournamentTeam.create({
    ...data,
    name,
    companyId,
    tournament: tournamentId,
    category: categoryId,
  });
  return ok(201, team);
}

async function updateTeam({ companyId, tournamentId, categoryId, teamId, input }) {
  const parent = await ensureTeam(companyId, tournamentId, categoryId, teamId);
  if (parent.error) return parent.error;
  const { data, errors } = validateTeamInput(input, { partial: true });
  if (errors.length) return fail(400, errors[0]);

  // Only an actual membership change (withdraw / restore) touches the bracket.
  // Player metadata edits stay valid after play and must not stale the bracket.
  const statusChanged = data.status !== undefined && data.status !== parent.team.status;
  if (statusChanged && (await categoryFrozen(companyId, categoryId))) return fail(409, FROZEN_BRACKET);

  const teams = await TournamentTeam.find({ companyId, tournament: tournamentId, category: categoryId });
  const others = teams.filter((team) => String(team._id) !== String(teamId) && (!team.status || team.status === 'registered'));

  if (data.status === 'registered' && parent.team.status === 'withdrawn') {
    const { maxTeams } = parent.category;
    if (Number.isInteger(maxTeams) && others.length >= maxTeams) {
      return fail(409, 'La categoría alcanzó el máximo de parejas.');
    }
  }

  if (data.name && others.some((team) => normalizeName(team.name) === normalizeName(data.name))) {
    return fail(400, 'Ya existe una pareja con ese nombre en la categoría.');
  }
  if (data.seed != null && others.some((team) => team.seed === data.seed)) {
    return fail(400, 'La semilla ya está asignada en esta categoría.');
  }
  const merged = { ...plain(parent.team), ...data };
  if (hasDuplicatePlayer(others, playerIdentityKeys(merged))) {
    return fail(400, 'Uno de los jugadores ya está registrado en esta categoría.');
  }

  // Stale is marked before the write so a failed update cannot leave an altered
  // roster on top of a bracket that still reports itself as fresh.
  if (statusChanged) await markBracketStale(companyId, categoryId, parent.category);
  const updated = await TournamentTeam.findOneAndUpdate(
    { _id: teamId, companyId, tournament: tournamentId, category: categoryId },
    data,
    { new: true, runValidators: true },
  );
  return ok(200, updated);
}

async function deleteTeam({ companyId, tournamentId, categoryId, teamId }) {
  const parent = await ensureTeam(companyId, tournamentId, categoryId, teamId);
  if (parent.error) return parent.error;
  if (await categoryFrozen(companyId, categoryId)) return fail(409, FROZEN_BRACKET);

  // A generated bracket stores hard team references; deleting the team would
  // leave dangling slots, so withdrawal is the only supported path.
  const bracketMatches = await TournamentMatch.countDocuments({
    companyId,
    tournament: tournamentId,
    category: categoryId,
  });
  if (parent.category.bracketSize != null || bracketMatches > 0) {
    return fail(409, 'No se puede eliminar una pareja con una llave generada; retírala en su lugar.');
  }

  await TournamentTeam.findOneAndDelete({ _id: teamId, companyId, tournament: tournamentId, category: categoryId });
  return ok(200, { _id: teamId });
}

// ── Bracket generation and results ──────────────────────────────────────────

const toBracketResponse = (matches, bracketSize) => {
  const rounds = new Map();
  for (const match of matches) {
    const round = Number(match.round);
    if (!rounds.has(round)) rounds.set(round, []);
    rounds.get(round).push({
      _id: match._id,
      round,
      position: match.position,
      teamA: match.teamA || null,
      teamB: match.teamB || null,
      winner: match.winner || null,
      scoreA: match.scoreA ?? null,
      scoreB: match.scoreB ?? null,
      status: match.status,
      court: match.court || null,
      date: match.date || null,
      timeSlot: match.timeSlot || null,
    });
  }
  return {
    bracketSize,
    rounds: [...rounds.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([round, entries]) => ({
        round,
        matches: entries.sort((left, right) => left.position - right.position),
      })),
  };
};

const teamId = (value) => (value && value._id ? value._id : value);

async function generateCategoryBracket({ companyId, tournamentId, categoryId, seed }) {
  const parent = await ensureCategory(companyId, tournamentId, categoryId);
  if (parent.error) return parent.error;
  if (parent.tournament.status !== 'in_progress') {
    return fail(400, 'El torneo debe estar en curso para generar la llave.');
  }

  const draw = resolveDrawSeed(seed);
  if (draw.error) return fail(400, draw.error);

  const existing = await TournamentMatch.find({ companyId, tournament: tournamentId, category: categoryId });
  if (existing.length > 0) {
    const guard = canRegenerate({ matches: existing });
    if (!guard.allowed) return fail(409, guard.reason);
  }

  // Build the new bracket BEFORE touching the persisted one: any sizing or
  // team-set error must leave the current bracket intact.
  const teams = await registeredTeams(companyId, tournamentId, categoryId);
  const inputTeams = normalizeTeamSeeds(teams.map(plain));
  const bracketTeams = parent.category.seeding === 'manual' ? withSequentialSeeds(inputTeams) : inputTeams;
  const result = buildBracket({ teams: bracketTeams, rng: createSeededRng(draw.seed) });
  if (result.errors.length) return fail(400, result.errors[0]);

  const drawSeed = draw.seed;
  const clearBracket = () =>
    TournamentMatch.deleteMany({ companyId, tournament: tournamentId, category: categoryId });

  if (result.bracketSize === 1) {
    if (existing.length > 0) await clearBracket();
    await TournamentCategory.findOneAndUpdate(
      { _id: categoryId, companyId },
      { bracketSize: 1, status: 'completed', bracketStale: false },
      { new: true },
    );
    return ok(200, { bracketSize: 1, rounds: [], champion: result.champion, drawSeed });
  }

  const documents = result.matches.map((match) => ({
    companyId,
    tournament: tournamentId,
    category: categoryId,
    round: match.round,
    position: match.position,
    teamA: teamId(match.teamA),
    teamB: teamId(match.teamB),
    winner: teamId(match.winner),
    status: match.status,
  }));
  // `(category, round, position)` is unique, so the new bracket cannot coexist
  // with the old one. Snapshot the previous rows, replace, and restore them if
  // the insert fails — a failed regeneration must never destroy the bracket.
  const previous = existing.map(plain);
  if (previous.length > 0) await clearBracket();
  let inserted;
  try {
    inserted = await TournamentMatch.insertMany(documents);
  } catch (error) {
    await clearBracket();
    if (previous.length > 0) await TournamentMatch.insertMany(previous);
    throw error;
  }
  await TournamentCategory.findOneAndUpdate(
    { _id: categoryId, companyId },
    { bracketSize: result.bracketSize, status: 'active', bracketStale: false },
    { new: true },
  );
  return ok(200, { ...toBracketResponse(inserted, result.bracketSize), champion: null, drawSeed });
}

async function getCategoryBracket({ companyId, tournamentId, categoryId }) {
  const parent = await ensureCategory(companyId, tournamentId, categoryId);
  if (parent.error) return parent.error;
  const matches = await TournamentMatch.find({ companyId, tournament: tournamentId, category: categoryId })
    .sort({ round: 1, position: 1 });
  return ok(200, toBracketResponse(matches, parent.category.bracketSize || null));
}

const RESULT_LOCKED = 'El torneo está finalizado o cancelado; no admite cambios de resultados.';

async function recordResult({ companyId, tournamentId, categoryId, matchId, scoreA, scoreB }) {
  const parent = await ensureCategory(companyId, tournamentId, categoryId);
  if (parent.error) return parent.error;
  if (parent.tournament.status === 'finished' || parent.tournament.status === 'cancelled') {
    return fail(409, RESULT_LOCKED);
  }
  if (parent.category.bracketStale === true) return fail(409, STALE_BRACKET);

  const found = await ensureMatch(companyId, tournamentId, categoryId, matchId);
  if (found.error) return found.error;
  const { match } = found;
  const resolved = resolveResult({ scoreA, scoreB });
  if (resolved.errors.length) return fail(400, resolved.errors[0]);
  if (match.status !== 'ready') return fail(409, 'El partido no está listo para registrar un resultado.');

  const winnerId = resolved.winner === 'A' ? match.teamA : match.teamB;
  const matches = await TournamentMatch.find({ companyId, tournament: tournamentId, category: categoryId });
  const applied = applyWinner({ matches, round: match.round, position: match.position, winner: winnerId });
  if (applied.errors.length) return fail(400, applied.errors[0]);

  const target = nextRoundTarget({ round: match.round, position: match.position });
  const targetMatch = matches.find((item) => item.round === target.round && item.position === target.position);
  // Advance first: if the source write then fails there is never a played
  // match whose winner failed to reach the next round.
  let targetSnapshot = null;
  if (targetMatch) {
    targetSnapshot = {
      slot: target.slot,
      value: targetMatch[target.slot] ?? null,
      status: targetMatch.status,
    };
    const next = applied.matches.find((item) => item.round === target.round && item.position === target.position);
    const advanced = await TournamentMatch.findOneAndUpdate(
      { _id: targetMatch._id, companyId },
      { [target.slot]: winnerId, status: next.status },
      { new: true, runValidators: true },
    );
    if (!advanced) return fail(500, 'No se pudo registrar el resultado.');
  }

  const rollbackTarget = async () => {
    if (!targetMatch) return;
    await TournamentMatch.findOneAndUpdate(
      { _id: targetMatch._id, companyId },
      { [targetSnapshot.slot]: targetSnapshot.value, status: targetSnapshot.status },
      { new: true },
    );
  };

  let updated;
  try {
    updated = await TournamentMatch.findOneAndUpdate(
      { _id: matchId, companyId },
      { winner: winnerId, scoreA, scoreB, status: 'played' },
      { new: true, runValidators: true },
    );
  } catch (error) {
    await rollbackTarget();
    throw error;
  }
  if (!updated) {
    await rollbackTarget();
    return fail(500, 'No se pudo registrar el resultado.');
  }

  let champion = null;
  if (!targetMatch) {
    champion = winnerId;
    await TournamentCategory.findOneAndUpdate({ _id: categoryId, companyId }, { status: 'completed' }, { new: true });
  }
  return ok(200, { match: updated, champion });
}

async function clearResult({ companyId, tournamentId, categoryId, matchId }) {
  const parent = await ensureCategory(companyId, tournamentId, categoryId);
  if (parent.error) return parent.error;
  if (parent.tournament.status === 'finished' || parent.tournament.status === 'cancelled') {
    return fail(409, RESULT_LOCKED);
  }
  if (parent.category.bracketStale === true) return fail(409, STALE_BRACKET);

  const found = await ensureMatch(companyId, tournamentId, categoryId, matchId);
  if (found.error) return found.error;
  const { match } = found;
  if (match.status !== 'played') return fail(400, 'El partido no tiene un resultado registrado.');

  const matches = await TournamentMatch.find({ companyId, tournament: tournamentId, category: categoryId });
  const guard = canClearResult({ matches, round: match.round, position: match.position });
  if (!guard.allowed) return fail(409, guard.reason);

  const updated = await TournamentMatch.findOneAndUpdate(
    { _id: matchId, companyId },
    { winner: null, scoreA: null, scoreB: null, status: 'ready' },
    { new: true, runValidators: true },
  );
  // Clearing a result reopens the category bracket.
  await TournamentCategory.findOneAndUpdate({ _id: categoryId, companyId }, { status: 'active' }, { new: true });

  let current = { round: match.round, position: match.position };
  for (;;) {
    const target = nextRoundTarget(current);
    if (!target) break;
    const downstream = matches.find((item) => item.round === target.round && item.position === target.position);
    if (!downstream) break;
    await TournamentMatch.findOneAndUpdate(
      { _id: downstream._id, companyId },
      { [target.slot]: null, status: 'pending' },
      { new: true },
    );
    current = target;
  }
  return ok(200, updated);
}

async function scheduleMatch({ companyId, tournamentId, categoryId, matchId, input = {} }) {
  const parent = await ensureCategory(companyId, tournamentId, categoryId);
  if (parent.error) return parent.error;
  if (parent.tournament.status !== 'in_progress') {
    return fail(409, 'El torneo debe estar en curso para programar partidos.');
  }
  if (parent.category.bracketStale === true) return fail(409, STALE_BRACKET);

  const found = await ensureMatch(companyId, tournamentId, categoryId, matchId);
  if (found.error) return found.error;
  const { match } = found;
  if (match.status !== 'ready') return fail(409, 'El partido no está listo para programarse.');

  const { court, date, timeSlot } = input;
  if (!isObjectId(String(court)) || !isObjectId(String(timeSlot))) {
    return fail(400, 'La cancha y el horario deben ser identificadores válidos.');
  }
  if (!isValidDate(date)) return fail(400, 'La fecha debe usar el formato YYYY-MM-DD.');
  if (date < parent.tournament.startDate || date > parent.tournament.endDate) {
    return fail(400, 'La fecha debe estar dentro del rango del torneo.');
  }
  if (!(parent.tournament.courts || []).map(String).includes(String(court))) {
    return fail(400, 'La cancha no pertenece al torneo.');
  }

  const ownedCourt = await Court.findOne({ _id: court, companyId, isActive: true });
  if (!ownedCourt) return fail(400, 'La cancha no existe o no está activa en tu empresa.');
  const ownedSlot = await TimeSlot.findOne({ _id: timeSlot, companyId });
  if (!ownedSlot) return fail(400, 'El horario no existe en tu empresa.');

  const utc = toUtcDate(date);
  const weekday = utc.getUTCDay();
  const [booking, fixedTurn, lock, otherMatch] = await Promise.all([
    Booking.findOne({ companyId, court, date: utc, timeSlot, status: { $ne: 'cancelado' } }),
    FixedBooking.findOne({ companyId, court, timeSlot, weekday, status: 'active' }),
    SlotLock.findOne({ companyId, courtId: court, slotId: timeSlot, date: utc, expiresAt: { $gt: new Date() } }),
    TournamentMatch.findOne({ companyId, court, date, timeSlot, _id: { $ne: matchId } }),
  ]);
  if (booking || fixedTurn || lock || otherMatch) return fail(409, 'El horario ya está ocupado.');

  const updated = await TournamentMatch.findOneAndUpdate(
    { _id: matchId, companyId },
    { court, date, timeSlot },
    { new: true, runValidators: true },
  );
  return ok(200, updated);
}

module.exports = {
  STATUSES,
  ALLOWED_TRANSITIONS,
  canTransition,
  validateTournamentInput,
  validateCategoryInput,
  validateTeamInput,
  playerIdentityKeys,
  hasDuplicatePlayer,
  listTournaments,
  getTournament,
  getBlockedCourts,
  createTournament,
  updateTournament,
  deleteTournament,
  activateTournament,
  completeTournament,
  cancelTournament,
  listCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  listTeams,
  createTeam,
  updateTeam,
  deleteTeam,
  generateCategoryBracket,
  getCategoryBracket,
  recordResult,
  clearResult,
  scheduleMatch,
};
