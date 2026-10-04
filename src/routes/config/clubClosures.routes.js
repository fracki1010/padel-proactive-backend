'use strict';

const express = require('express');
const router = express.Router();
const ClubClosure = require('../../models/clubClosure.model');
const {
  resolveCompanyId,
  companyScope,
  ISO_DATE_REGEX,
} = require('./shared');

// GET /api/config/club-closures
router.get("/club-closures", async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    const scope = companyScope(req, companyId);
    const closures = await ClubClosure.find(scope).sort({ startDate: 1 });
    return res.status(200).json({ success: true, data: closures });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/config/club-closures
router.post("/club-closures", async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    const scope = companyScope(req, companyId);
    const { startDate, endDate, reason } = req.body || {};

    if (!startDate || !ISO_DATE_REGEX.test(String(startDate))) {
      return res.status(400).json({ success: false, error: "startDate es obligatorio y debe tener formato YYYY-MM-DD." });
    }
    if (!endDate || !ISO_DATE_REGEX.test(String(endDate))) {
      return res.status(400).json({ success: false, error: "endDate es obligatorio y debe tener formato YYYY-MM-DD." });
    }
    if (startDate > endDate) {
      return res.status(400).json({ success: false, error: "La fecha de inicio no puede ser posterior a la fecha de fin." });
    }

    const closure = await ClubClosure.create({
      ...scope,
      startDate: String(startDate).trim(),
      endDate: String(endDate).trim(),
      reason: typeof reason === "string" ? reason.trim() : "",
    });

    return res.status(201).json({ success: true, data: closure });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// PUT /api/config/club-closures/:id
router.put("/club-closures/:id", async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    const scope = companyScope(req, companyId);
    const { startDate, endDate, reason } = req.body || {};
    const update = {};

    if (startDate !== undefined) {
      if (!ISO_DATE_REGEX.test(String(startDate))) {
        return res.status(400).json({ success: false, error: "startDate debe tener formato YYYY-MM-DD." });
      }
      update.startDate = String(startDate).trim();
    }
    if (endDate !== undefined) {
      if (!ISO_DATE_REGEX.test(String(endDate))) {
        return res.status(400).json({ success: false, error: "endDate debe tener formato YYYY-MM-DD." });
      }
      update.endDate = String(endDate).trim();
    }
    if (reason !== undefined) {
      update.reason = String(reason).trim();
    }

    const closure = await ClubClosure.findOneAndUpdate(
      { _id: req.params.id, ...scope },
      update,
      { returnDocument: "after" },
    );

    if (!closure) {
      return res.status(404).json({ success: false, error: "Cierre no encontrado." });
    }

    if (closure.startDate > closure.endDate) {
      return res.status(400).json({ success: false, error: "La fecha de inicio no puede ser posterior a la fecha de fin." });
    }

    return res.status(200).json({ success: true, data: closure });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE /api/config/club-closures/:id
router.delete("/club-closures/:id", async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    const scope = companyScope(req, companyId);
    const closure = await ClubClosure.findOneAndDelete({ _id: req.params.id, ...scope });

    if (!closure) {
      return res.status(404).json({ success: false, error: "Cierre no encontrado." });
    }

    return res.status(200).json({ success: true, data: { _id: req.params.id } });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;