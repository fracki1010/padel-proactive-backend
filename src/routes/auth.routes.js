// src/routes/auth.routes.js
const express = require("express");
const router = express.Router();
const {
  login,
  register,
  me,
  updateProfile,
} = require("../controllers/auth.controller");
const { protect } = require("../middleware/auth.middleware");

router.post("/login", login);
router.post("/register", register);
router.get("/me", protect, me);
router.put("/profile", protect, updateProfile);

module.exports = router;
