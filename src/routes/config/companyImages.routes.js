'use strict';

const express = require('express');
const router = express.Router();
const multer = require('multer');
const CompanyImage = require('../../models/companyImage.model');
const Company = require('../../models/company.model');
const { uploadBuffer, cloudinary, configured: cloudinaryConfigured } = require('../../lib/cloudinary');
const { resolveCompanyId } = require('./shared');

const MAX_BACKGROUNDS = 6;
const MAX_SIZE_BYTES = 10 * 1024 * 1024;
const ALLOWED_TYPES = ["portal_cover", "digest_background"];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SIZE_BYTES },
  fileFilter: (_req, file, cb) => {
    // Aceptar cualquier imagen — Cloudinary convierte HEIC/HEIF automáticamente
    if (file.mimetype.startsWith("image/")) return cb(null, true);
    cb(new Error("El archivo debe ser una imagen."));
  },
});

// Wrapper que captura errores de multer y los devuelve como JSON en vez de colgar
const uploadSingle = (fieldName) => (req, res, next) => {
  console.log(`[upload] ${req.method} ${req.path} — content-type: ${req.headers["content-type"]} content-length: ${req.headers["content-length"]}`);
  upload.single(fieldName)(req, res, (err) => {
    if (!err) {
      if (req.file) {
        console.log(`[upload] archivo recibido — name: ${req.file.originalname} mime: ${req.file.mimetype} size: ${req.file.size}`);
      } else {
        console.log(`[upload] sin archivo adjunto después de multer`);
      }
      return next();
    }
    console.error(`[upload] error multer — code: ${err.code} message: ${err.message}`);
    const msg = err.code === "LIMIT_FILE_SIZE"
      ? "El archivo supera los 10MB."
      : (err.message || "Error al procesar el archivo.");
    return res.status(400).json({ success: false, error: msg });
  });
};

// GET /api/config/company-images?type=digest_background
router.get("/company-images", async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    const typeFilter = ALLOWED_TYPES.includes(req.query.type) ? req.query.type : null;
    const filter = { companyId: companyId || null, ...(typeFilter ? { type: typeFilter } : {}) };
    const images = await CompanyImage.find(filter, { cloudinaryPublicId: 0 }).sort({ type: 1, order: 1 });
    return res.status(200).json({ success: true, data: images });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/config/company-images  (multipart: file, type, order?)
router.post("/company-images", uploadSingle("file"), async (req, res) => {
  try {
    console.log(`[company-images POST] body.type=${req.body.type} body.order=${req.body.order} cloudinaryConfigured=${cloudinaryConfigured}`);

    if (!cloudinaryConfigured) {
      return res.status(503).json({ success: false, error: "Cloudinary no está configurado." });
    }

    const companyId = resolveCompanyId(req);

    if (!req.file) {
      console.log(`[company-images POST] rechazado — no file`);
      return res.status(400).json({ success: false, error: "No se recibió ningún archivo." });
    }

    const type = req.body.type;
    if (!ALLOWED_TYPES.includes(type)) {
      console.log(`[company-images POST] rechazado — tipo inválido: ${type}`);
      return res.status(400).json({ success: false, error: "El tipo debe ser 'portal_cover' o 'digest_background'." });
    }

    const order = type === "digest_background" ? Number(req.body.order) : 1;
    if (type === "digest_background" && (!Number.isInteger(order) || order < 1 || order > MAX_BACKGROUNDS)) {
      console.log(`[company-images POST] rechazado — orden inválido: ${order}`);
      return res.status(400).json({ success: false, error: `El orden debe ser entre 1 y ${MAX_BACKGROUNDS}.` });
    }

    if (type === "digest_background") {
      const existing = await CompanyImage.countDocuments({ companyId: companyId || null, type: "digest_background" });
      const slot = await CompanyImage.findOne({ companyId: companyId || null, type: "digest_background", order });
      if (!slot && existing >= MAX_BACKGROUNDS) {
        console.log(`[company-images POST] rechazado — límite de fondos alcanzado`);
        return res.status(400).json({ success: false, error: `Máximo ${MAX_BACKGROUNDS} imágenes de fondo permitidas.` });
      }
    }

    // Delete previous Cloudinary asset for this slot if it exists
    const prevImage = await CompanyImage.findOne({ companyId: companyId || null, type, order });
    if (prevImage?.cloudinaryPublicId) {
      try { await cloudinary.uploader.destroy(prevImage.cloudinaryPublicId); } catch (_) {}
    }

    const folder = `padel-proactive/${companyId || "global"}/${type}`;
    console.log(`[company-images POST] iniciando upload a Cloudinary — folder: ${folder} buffer: ${req.file.buffer.length} bytes`);
    const uploadResult = await uploadBuffer(req.file.buffer, {
      folder,
      resource_type: "image",
      transformation: type === "digest_background"
        ? [{ width: 1200, crop: "limit" }]
        : [{ width: 1200, crop: "limit" }],
    });
    console.log(`[company-images POST] Cloudinary OK — public_id: ${uploadResult.public_id}`);

    const saved = await CompanyImage.findOneAndUpdate(
      { companyId: companyId || null, type, order },
      { companyId: companyId || null, type, order, cloudinaryPublicId: uploadResult.public_id, url: uploadResult.secure_url },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    // Keep company.coverImage in sync for portal_cover
    if (type === "portal_cover" && companyId) {
      await Company.findByIdAndUpdate(companyId, { coverImage: uploadResult.secure_url });
    }

    console.log(`[company-images POST] guardado OK — _id: ${saved._id}`);
    return res.status(200).json({
      success: true,
      data: { _id: saved._id, type: saved.type, order: saved.order, url: saved.url },
    });
  } catch (error) {
    console.error(`[company-images POST] error inesperado:`, error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE /api/config/company-images/:id
router.delete("/company-images/:id", async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    const image = await CompanyImage.findOneAndDelete({ _id: req.params.id, companyId: companyId || null });
    if (!image) return res.status(404).json({ success: false, error: "No encontrado." });

    if (image.cloudinaryPublicId) {
      try { await cloudinary.uploader.destroy(image.cloudinaryPublicId); } catch (_) {}
    }

    return res.status(200).json({ success: true, data: { _id: req.params.id } });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/config/client-log — recibe logs del frontend para debug remoto
router.post("/client-log", (req, res) => {
  const { level = "log", message = "", data } = req.body || {};
  const tag = `[client-log][${level.toUpperCase()}]`;
  if (data !== undefined) {
    console[level === "error" ? "error" : "log"](`${tag} ${message}`, JSON.stringify(data));
  } else {
    console[level === "error" ? "error" : "log"](`${tag} ${message}`);
  }
  return res.status(200).json({ ok: true });
});

module.exports = router;