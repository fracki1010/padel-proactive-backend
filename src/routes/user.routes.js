const express = require("express");
const router = express.Router();
const {
  getUsers,
  createUser,
  updateUser,
  deleteUser,
  getUserHistory,
  clearPenalties,
} = require("../controllers/user.controller");

router.get("/", getUsers);
router.post("/", createUser);
router.put("/:id", updateUser);
router.delete("/:id", deleteUser);
router.get("/:id/history", getUserHistory);
router.post("/:id/clear-penalties", clearPenalties);

module.exports = router;
