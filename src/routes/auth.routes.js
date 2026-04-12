// src/routes/auth.routes.js
const express = require("express");
const router = express.Router();
const {
  login,
  me,
  updateProfile,
  updateMyCompany,
} = require("../controllers/auth.controller");
const { protect } = require("../middleware/auth.middleware");

router.post("/login", login);
router.get("/me", protect, me);
router.put("/profile", protect, updateProfile);
router.put("/company", protect, updateMyCompany);

module.exports = router;
