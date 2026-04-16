const express = require("express");
const router = express.Router();
const {
  getUsers,
  getUserById,
  createUser,
  updateUser,
  deleteUser,
  getUserHistory,
  clearPenalties,
  adjustAttendanceConfirmedCount,
} = require("../controllers/user.controller");

router.get("/", getUsers);
router.get("/:id", getUserById);
router.post("/", createUser);
router.put("/:id", updateUser);
router.delete("/:id", deleteUser);
router.get("/:id/history", getUserHistory);
router.post("/:id/clear-penalties", clearPenalties);
router.post("/:id/attendance/adjust", adjustAttendanceConfirmedCount);

module.exports = router;
