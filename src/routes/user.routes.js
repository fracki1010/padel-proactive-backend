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
  setDepositExemption,
} = require("../controllers/user.controller");
const { requireRole } = require("../middleware/auth.middleware");

router.get("/", getUsers);
router.get("/:id", getUserById);
router.post("/", createUser);
router.put("/:id", updateUser);
router.delete("/:id", deleteUser);
router.get("/:id/history", getUserHistory);
router.post("/:id/clear-penalties", clearPenalties);
router.post("/:id/attendance/adjust", adjustAttendanceConfirmedCount);
router.put(
  "/:id/deposit-exempt",
  requireRole("admin", "super_admin"),
  setDepositExemption,
);

module.exports = router;
