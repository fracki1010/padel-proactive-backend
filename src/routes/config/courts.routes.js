'use strict';

const express = require('express');
const router = express.Router();
const Booking = require('../../models/booking.model');
const Court = require('../../models/court.model');
const User = require('../../models/user.model');
const {
  resolveCompanyId,
  escapeRegex,
  companyScope,
} = require('./shared');

// GET /api/config/courts
router.get("/courts", async (req, res) => {
  try {
    const { all } = req.query;
    const companyId = resolveCompanyId(req);
    const filter = {
      ...(all === "true" ? {} : { isActive: true }),
      ...companyScope(req, companyId),
    };
    const courts = await Court.find(filter);
    res.status(200).json({ success: true, data: courts });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/config/courts
router.post("/courts", async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    const { name, courtType, surface, isIndoor, isActive } = req.body || {};

    if (!name || !String(name).trim()) {
      return res.status(400).json({
        success: false,
        error: "El nombre de la cancha es obligatorio.",
      });
    }

    const normalizedName = String(name).trim();
    const escapedCourtName = escapeRegex(normalizedName);
    const scope = companyScope(req, companyId);
    const existingCourt = await Court.findOne({
      ...scope,
      name: { $regex: new RegExp(`^${escapedCourtName}$`, "i") },
    });

    if (existingCourt) {
      return res.status(400).json({
        success: false,
        error: "Ya existe una cancha con ese nombre.",
      });
    }

    const { COURT_TYPES } = require('../../models/court.model');
    const createdCourt = await Court.create({
      ...scope,
      name: normalizedName,
      ...(typeof courtType === "string" && COURT_TYPES.includes(courtType)
        ? { courtType }
        : {}),
      ...(typeof surface === "string" && surface.trim()
        ? { surface: surface.trim() }
        : {}),
      ...(typeof isIndoor === "boolean" ? { isIndoor } : {}),
      ...(typeof isActive === "boolean" ? { isActive } : {}),
    });

    return res.status(201).json({ success: true, data: createdCourt });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// PUT /api/config/courts/:id
router.put("/courts/:id", async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    const scope = companyScope(req, companyId);
    const payload = { ...req.body };

    if (Object.prototype.hasOwnProperty.call(payload, "name")) {
      const normalizedName = String(payload.name || "").trim();
      if (!normalizedName) {
        return res.status(400).json({
          success: false,
          error: "El nombre de la cancha es obligatorio.",
        });
      }

      const escapedCourtName = escapeRegex(normalizedName);
      const duplicatedCourt = await Court.findOne({
        ...scope,
        _id: { $ne: req.params.id },
        name: { $regex: new RegExp(`^${escapedCourtName}$`, "i") },
      });

      if (duplicatedCourt) {
        return res.status(400).json({
          success: false,
          error: "Ya existe una cancha con ese nombre.",
        });
      }

      payload.name = normalizedName;
    }

    const updatedCourt = await Court.findOneAndUpdate(
      { _id: req.params.id, ...scope },
      payload,
      { returnDocument: "after" },
    );

    if (!updatedCourt) {
      return res.status(404).json({
        success: false,
        error: "Cancha no encontrada.",
      });
    }

    res.status(200).json({ success: true, data: updatedCourt });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE /api/config/courts/:id
router.delete("/courts/:id", async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    const scope = companyScope(req, companyId);
    const courtId = req.params.id;

    const court = await Court.findOne({ _id: courtId, ...scope });
    if (!court) {
      return res.status(404).json({
        success: false,
        error: "Cancha no encontrada.",
      });
    }

    const [bookingsCount, fixedTurnsCount] = await Promise.all([
      Booking.countDocuments({
        ...scope,
        court: courtId,
      }),
      User.countDocuments({
        ...scope,
        "fixedTurns.court": courtId,
      }),
    ]);

    if (bookingsCount > 0 || fixedTurnsCount > 0) {
      return res.status(400).json({
        success: false,
        error:
          "No podés eliminar esta cancha porque tiene reservas o turnos fijos asociados. Podés desactivarla.",
      });
    }

    await court.deleteOne();
    return res.status(200).json({ success: true, data: { _id: courtId } });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;