const express = require("express");
const router = express.Router();
const Court = require("../models/court.model");
const TimeSlot = require("../models/timeSlot.model");

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

module.exports = router;
