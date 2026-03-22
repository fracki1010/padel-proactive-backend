const express = require("express");
const router = express.Router();
const Court = require("../models/court.model");
const TimeSlot = require("../models/timeSlot.model");
const { getWhatsappState } = require("../state/whatsapp.state");

// GET /api/config/courts
router.get("/courts", async (req, res) => {
  try {
    const { all } = req.query;
    const filter = all === "true" ? {} : { isActive: true };
    const courts = await Court.find(filter);
    res.status(200).json({ success: true, data: courts });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// PUT /api/config/courts/:id
router.put("/courts/:id", async (req, res) => {
  try {
    const updatedCourt = await Court.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true },
    );
    res.status(200).json({ success: true, data: updatedCourt });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/config/slots
router.get("/slots", async (req, res) => {
  try {
    const { all } = req.query;
    const filter = all === "true" ? {} : { isActive: true };
    const slots = await TimeSlot.find(filter).sort({ order: 1 });
    res.status(200).json({ success: true, data: slots });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// PUT /api/config/slots/base-price
router.put("/slots/base-price", async (req, res) => {
  try {
    const { price } = req.body;
    const parsedPrice = Number(price);

    if (!Number.isFinite(parsedPrice) || parsedPrice < 0) {
      return res.status(400).json({
        success: false,
        error: "El precio base debe ser un número válido mayor o igual a 0.",
      });
    }

    const result = await TimeSlot.updateMany({}, { $set: { price: parsedPrice } });
    const slots = await TimeSlot.find({}).sort({ order: 1 });

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
    const updatedSlot = await TimeSlot.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true },
    );
    res.status(200).json({ success: true, data: updatedSlot });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/config/whatsapp
router.get("/whatsapp", async (_req, res) => {
  try {
    const state = getWhatsappState();
    res.status(200).json({ success: true, data: state });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
