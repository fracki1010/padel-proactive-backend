const express = require("express");
const router = express.Router();
const Court = require("../models/court.model");
const TimeSlot = require("../models/timeSlot.model");
const { getWhatsappState } = require("../state/whatsapp.state");
const { setWhatsappEnabled } = require("../services/whatsappControl.service");
const {
  DEFAULT_PENALTY_LIMIT,
  getPenaltyLimit,
  setPenaltyLimit,
} = require("../services/appConfig.service");

const resolveCompanyId = (req) => {
  if (req.user?.role === "super_admin") {
    return req.query.companyId || req.body.companyId || null;
  }
  return req.user?.companyId || null;
};

const companyScope = (req, companyId) => {
  if (req.user?.role === "super_admin") {
    return companyId ? { companyId } : {};
  }
  return { companyId: req.user?.companyId || null };
};

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
    const { name, surface, isIndoor, isActive } = req.body || {};

    if (!name || !String(name).trim()) {
      return res.status(400).json({
        success: false,
        error: "El nombre de la cancha es obligatorio.",
      });
    }

    const normalizedName = String(name).trim();
    const scope = companyScope(req, companyId);
    const existingCourt = await Court.findOne({
      ...scope,
      name: { $regex: new RegExp(`^${normalizedName}$`, "i") },
    });

    if (existingCourt) {
      return res.status(400).json({
        success: false,
        error: "Ya existe una cancha con ese nombre.",
      });
    }

    const createdCourt = await Court.create({
      ...scope,
      name: normalizedName,
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
    const updatedCourt = await Court.findOneAndUpdate(
      { _id: req.params.id, ...companyScope(req, companyId) },
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
    const companyId = resolveCompanyId(_req);
    const state = getWhatsappState(companyId);
    res.status(200).json({ success: true, data: state });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// PUT /api/config/whatsapp
router.put("/whatsapp", async (req, res) => {
  try {
    const { enabled } = req.body;
    const companyId = resolveCompanyId(req);

    if (typeof enabled !== "boolean") {
      return res.status(400).json({
        success: false,
        error: "El campo 'enabled' debe ser booleano.",
      });
    }

    const state = await setWhatsappEnabled(enabled, companyId);
    return res.status(200).json({ success: true, data: state });
  } catch (error) {
    const message = String(error?.message || "");
    if (message.includes("ya está abierta en otro proceso")) {
      return res.status(409).json({
        success: false,
        error: message,
      });
    }
    return res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/config/penalties
router.get("/penalties", async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    const penaltyLimit = await getPenaltyLimit(companyId);
    return res.status(200).json({
      success: true,
      data: { penaltyLimit },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// PUT /api/config/penalties
router.put("/penalties", async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    const rawPenaltyLimit = req.body?.penaltyLimit;
    const parsed = Number(rawPenaltyLimit);

    if (!Number.isInteger(parsed) || parsed < 1) {
      return res.status(400).json({
        success: false,
        error: `El campo 'penaltyLimit' debe ser un entero mayor o igual a 1. Valor recomendado por defecto: ${DEFAULT_PENALTY_LIMIT}.`,
      });
    }

    const config = await setPenaltyLimit(parsed, companyId);
    return res.status(200).json({
      success: true,
      data: { penaltyLimit: config.penaltyLimit },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
