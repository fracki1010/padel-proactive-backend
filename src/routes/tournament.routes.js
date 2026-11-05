const express = require("express");
const controller = require("../controllers/tournament.controller");

const router = express.Router();

router.get("/", controller.listTournaments);
router.post("/", controller.createTournament);

// Declared BEFORE /:id so "blocked-courts" is not captured as a tournament id.
router.get("/blocked-courts", controller.getBlockedCourts);

router.post("/:id/activate", controller.activateTournament);
router.post("/:id/complete", controller.completeTournament);
router.post("/:id/cancel", controller.cancelTournament);

router.get("/:id/categories", controller.listCategories);
router.post("/:id/categories", controller.createCategory);
router.put("/:id/categories/:categoryId", controller.updateCategory);
router.delete("/:id/categories/:categoryId", controller.deleteCategory);

router.get("/:id/categories/:categoryId/teams", controller.listTeams);
router.post("/:id/categories/:categoryId/teams", controller.createTeam);
router.put("/:id/categories/:categoryId/teams/:teamId", controller.updateTeam);
router.delete("/:id/categories/:categoryId/teams/:teamId", controller.deleteTeam);

router.post("/:id/categories/:categoryId/bracket", controller.generateBracket);
router.get("/:id/categories/:categoryId/bracket", controller.getBracket);

router.post("/:id/categories/:categoryId/matches/:matchId/result", controller.recordResult);
router.delete("/:id/categories/:categoryId/matches/:matchId/result", controller.clearResult);
router.put("/:id/categories/:categoryId/matches/:matchId/schedule", controller.scheduleMatch);

router.get("/:id", controller.getTournament);
router.put("/:id", controller.updateTournament);
router.delete("/:id", controller.deleteTournament);

module.exports = router;
