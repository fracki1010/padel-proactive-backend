'use strict';

const express = require('express');
const router = express.Router();
const TimeSlot = require('../../models/timeSlot.model');
const {
  resolveCompanyId,
  companyScope,
} = require('./shared');

// GET /api/config/slots
router.get("/slots", async (req, res) => {
  try {
    const { all } = req.query;
    const companyId = resolveCompanyId(req);
    const filter = {
      ...(all === "true" ? {} : { isActive: true }),
      ...companyScope(req, companyId),
    };
    const slots = await TimeSlot.find(filter).sort({ order: 1 });
    res.status(200).json({ success: true, data: slots });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/config/slots
router.post("/slots", async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    const { startTime, endTime, label, price, isActive } = req.body || {};
    const scope = companyScope(req, companyId);

    if (!startTime || !endTime) {
      return res.status(400).json({
        success: false,
        error: "startTime y endTime son obligatorios.",
      });
    }

    const parsedPrice = Number(price);
    if (!Number.isFinite(parsedPrice) || parsedPrice < 0) {
      return res.status(400).json({
        success: false,
        error: "El precio debe ser un número válido mayor o igual a 0.",
      });
    }

    const normalizedStart = String(startTime).trim();
    const normalizedEnd = String(endTime).trim();

    const duplicated = await TimeSlot.findOne({
      ...scope,
      startTime: normalizedStart,
      endTime: normalizedEnd,
    });

    if (duplicated) {
      return res.status(400).json({
        success: false,
        error: "Ya existe un turno con ese horario.",
      });
    }

    const lastSlot = await TimeSlot.findOne(scope).sort({ order: -1 });
    const nextOrder = (lastSlot?.order || 0) + 1;

    const createdSlot = await TimeSlot.create({
      ...scope,
      startTime: normalizedStart,
      endTime: normalizedEnd,
      ...(typeof label === "string" && label.trim() ? { label: label.trim() } : {}),
      price: parsedPrice,
      ...(typeof isActive === "boolean" ? { isActive } : {}),
      order: nextOrder,
    });

    return res.status(201).json({ success: true, data: createdSlot });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// PUT /api/config/slots/base-price
router.put("/slots/base-price", async (req, res) => {
  try {
    const { price } = req.body;
    const companyId = resolveCompanyId(req);
    const parsedPrice = Number(price);

    if (!Number.isFinite(parsedPrice) || parsedPrice < 0) {
      return res.status(400).json({
        success: false,
        error: "El precio base debe ser un número válido mayor o igual a 0.",
      });
    }

    const baseFilter = companyScope(req, companyId);
    const result = await TimeSlot.updateMany(baseFilter, { $set: { price: parsedPrice } });
    const slots = await TimeSlot.find(baseFilter).sort({ order: 1 });

    res.status(200).json({
      success: true,
      data: {
        price: parsedPrice,
        updatedCount: result.modifiedCount || 0,
        slots,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// PUT /api/config/slots/:id
router.put("/slots/:id", async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    const updatedSlot = await TimeSlot.findOneAndUpdate(
      { _id: req.params.id, ...companyScope(req, companyId) },
      req.body,
      { returnDocument: "after" },
    );
    res.status(200).json({ success: true, data: updatedSlot });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;