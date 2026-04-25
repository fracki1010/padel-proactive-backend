// src/routes/auth.routes.js
const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const {
  login,
  me,
  updateProfile,
  updateMyCompany,
  uploadCoverImage,
} = require("../controllers/auth.controller");
const { protect } = require("../middleware/auth.middleware");

const uploadsDir = path.join(__dirname, "../../../uploads/cover-images");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const coverStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});

const coverUpload = multer({
  storage: coverStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    cb(null, allowed.includes(file.mimetype));
  },
});

router.post("/login", login);
router.get("/me", protect, me);
router.put("/profile", protect, updateProfile);
router.put("/company", protect, updateMyCompany);
router.post("/company/cover", protect, coverUpload.single("cover"), uploadCoverImage);

module.exports = router;
