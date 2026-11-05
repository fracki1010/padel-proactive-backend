const { tenantFilter } = require("../middleware/auth.middleware");
const service = require("../services/tournament.service");

// Every tournament read/write is scoped to the admin's club. A user without a
// company (super_admin) cannot use the tenant module, mirroring announcements.
const resolveCompanyScope = (req, res) => {
  const scope = tenantFilter(req);
  if (!scope.companyId) {
    res.status(403).json({ success: false, error: "El usuario no tiene una empresa asignada" });
    return null;
  }
  return scope.companyId;
};

const send = (res, result) => {
  const body = result.ok
    ? { success: true, data: result.data }
    : { success: false, error: result.error };
  if (result.conflicts) body.conflicts = result.conflicts;
  return res.status(result.status).json(body);
};

const run = async (res, work) => {
  try {
    return send(res, await work());
  } catch (error) {
    if (error?.name === 'CastError' || error?.name === 'ValidationError') {
      return res.status(400).json({ success: false, error: 'Datos inválidos.' });
    }
    if (error?.name === 'DocumentNotFoundError') {
      return res.status(404).json({ success: false, error: 'Recurso no encontrado.' });
    }
    console.error('[tournaments] unexpected error', error);
    return res.status(500).json({ success: false, error: 'Error interno del servidor.' });
  }
};

const withCompany = (handler) => async (req, res) => {
  const companyId = resolveCompanyScope(req, res);
  if (!companyId) return undefined;
  return run(res, () => handler(req, companyId));
};

// ── Tournaments ─────────────────────────────────────────────────────────────

const listTournaments = withCompany((req, companyId) =>
  service.listTournaments({ companyId, status: req.query.status }),
);

const getTournament = withCompany((req, companyId) =>
  service.getTournament({ companyId, id: req.params.id }),
);

const getBlockedCourts = withCompany((req, companyId) =>
  service.getBlockedCourts({ companyId, date: req.query.date }),
);

const createTournament = withCompany((req, companyId) =>
  service.createTournament({ companyId, adminId: req.user?.id, input: req.body || {} }),
);

const updateTournament = withCompany((req, companyId) =>
  service.updateTournament({
    companyId,
    id: req.params.id,
    input: req.body || {},
    confirmConflicts: req.body?.confirmConflicts === true,
  }),
);

const deleteTournament = withCompany((req, companyId) =>
  service.deleteTournament({ companyId, id: req.params.id }),
);

const activateTournament = withCompany((req, companyId) =>
  service.activateTournament({
    companyId,
    id: req.params.id,
    confirmConflicts: req.body?.confirmConflicts === true,
  }),
);

const completeTournament = withCompany((req, companyId) =>
  service.completeTournament({ companyId, id: req.params.id }),
);

const cancelTournament = withCompany((req, companyId) =>
  service.cancelTournament({ companyId, id: req.params.id }),
);

// ── Categories ──────────────────────────────────────────────────────────────

const listCategories = withCompany((req, companyId) =>
  service.listCategories({ companyId, tournamentId: req.params.id }),
);

const createCategory = withCompany((req, companyId) =>
  service.createCategory({ companyId, tournamentId: req.params.id, input: req.body || {} }),
);

const updateCategory = withCompany((req, companyId) =>
  service.updateCategory({
    companyId,
    tournamentId: req.params.id,
    categoryId: req.params.categoryId,
    input: req.body || {},
  }),
);

const deleteCategory = withCompany((req, companyId) =>
  service.deleteCategory({
    companyId,
    tournamentId: req.params.id,
    categoryId: req.params.categoryId,
  }),
);

// ── Teams ───────────────────────────────────────────────────────────────────

const listTeams = withCompany((req, companyId) =>
  service.listTeams({
    companyId,
    tournamentId: req.params.id,
    categoryId: req.params.categoryId,
  }),
);

const createTeam = withCompany((req, companyId) =>
  service.createTeam({
    companyId,
    tournamentId: req.params.id,
    categoryId: req.params.categoryId,
    input: req.body || {},
  }),
);

const updateTeam = withCompany((req, companyId) =>
  service.updateTeam({
    companyId,
    tournamentId: req.params.id,
    categoryId: req.params.categoryId,
    teamId: req.params.teamId,
    input: req.body || {},
  }),
);

const deleteTeam = withCompany((req, companyId) =>
  service.deleteTeam({
    companyId,
    tournamentId: req.params.id,
    categoryId: req.params.categoryId,
    teamId: req.params.teamId,
  }),
);

// ── Bracket, results and scheduling ─────────────────────────────────────────

const generateBracket = withCompany((req, companyId) =>
  service.generateCategoryBracket({
    companyId,
    tournamentId: req.params.id,
    categoryId: req.params.categoryId,
    seed: req.body?.seed,
  }),
);

const getBracket = withCompany((req, companyId) =>
  service.getCategoryBracket({
    companyId,
    tournamentId: req.params.id,
    categoryId: req.params.categoryId,
  }),
);

const recordResult = withCompany((req, companyId) =>
  service.recordResult({
    companyId,
    tournamentId: req.params.id,
    categoryId: req.params.categoryId,
    matchId: req.params.matchId,
    scoreA: req.body?.scoreA,
    scoreB: req.body?.scoreB,
  }),
);

const clearResult = withCompany((req, companyId) =>
  service.clearResult({
    companyId,
    tournamentId: req.params.id,
    categoryId: req.params.categoryId,
    matchId: req.params.matchId,
  }),
);

// The edit endpoint lives outside the category path: the match itself carries
// the category, so the service derives it when categoryId is absent.
const editResult = withCompany((req, companyId) =>
  service.editResult({
    companyId,
    tournamentId: req.params.id,
    categoryId: req.params.categoryId,
    matchId: req.params.matchId,
    scoreA: req.body?.scoreA,
    scoreB: req.body?.scoreB,
  }),
);

const scheduleMatch = withCompany((req, companyId) =>
  service.scheduleMatch({
    companyId,
    tournamentId: req.params.id,
    categoryId: req.params.categoryId,
    matchId: req.params.matchId,
    input: req.body || {},
  }),
);

module.exports = {
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
  generateBracket,
  getBracket,
  recordResult,
  editResult,
  clearResult,
  scheduleMatch,
};
