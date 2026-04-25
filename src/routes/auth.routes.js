// src/routes/auth.routes.js
const express = require("express");
const router = express.Router();
const multer = require("multer");
const {
  login,
  me,
  updateProfile,
  updateMyCompany,
  uploadCoverImage,
} = require("../controllers/auth.controller");
const { protect } = require("../middleware/auth.middleware");
const { createRateLimiter } = require("../middleware/rateLimit.middleware");

// 5 intentos de login por IP cada 15 minutos
const loginRateLimit = createRateLimiter({ windowMs: 15 * 60_000, maxRequests: 5 });

const coverUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    cb(null, allowed.includes(file.mimetype));
  },
});

router.post("/login", loginRateLimit, login);
router.get("/me", protect, me);
router.put("/profile", protect, updateProfile);
router.put("/company", protect, updateMyCompany);
router.post("/company/cover", protect, coverUpload.single("cover"), uploadCoverImage);

module.exports = router;
