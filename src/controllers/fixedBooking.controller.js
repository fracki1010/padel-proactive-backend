const mongoose = require("mongoose");
const FixedBooking = require("../models/fixedBooking.model");
const Court = require("../models/court.model");
const TimeSlot = require("../models/timeSlot.model");
const {
  listFixedBookings,
  getConflicts,
} = require("../services/fixedBooking.service");

const CONFLICT_MESSAGE = "Ya existe un turno fijo en ese horario";
const VALID_STATUSES = ["active", "paused"];

// Fixed turns are always scoped to the caller's club. The body's companyId is
// never trusted; super admins (no companyId) cannot manage club fixed turns.
const resolveCompanyId = (req, res) => {
  const companyId = req.user?.companyId;
  if (!companyId) {
    res.status(403).json({
      success: false,
      error: "El usuario no tiene una empresa asignada",
    });
    return null;
  }
  return companyId;
};

const isValidId = (value) => mongoose.Types.ObjectId.isValid(String(value || ""));

const validateWeekday = (value) => {
  const weekday = Number(value);
  return Number.isInteger(weekday) && weekday >= 0 && weekday <= 6 ? weekday : null;
};

// GET /api/fixed-bookings?weekday=&status=
const listFixedBookingsHandler = async (req, res) => {
  try {
    const companyId = resolveCompanyId(req, res);
    if (!companyId) return undefined;

    const { weekday, status } = req.query;
    const data = await listFixedBookings(companyId, { weekday, status });
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("Error en listFixedBookings:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

// POST /api/fixed-bookings
const createFixedBooking = async (req, res) => {
  try {
    const companyId = resolveCompanyId(req, res);
    if (!companyId) return undefined;

    const { court, timeSlot, clientName, notes, status } = req.body || {};
    const weekday = validateWeekday(req.body?.weekday);

    if (weekday === null || !court || !timeSlot) {
      return res.status(400).json({
        success: false,
        error: "Faltan datos: court, timeSlot y weekday (0-6)",
      });
    }
    if (!isValidId(court) || !isValidId(timeSlot)) {
      return res
        .status(400)
        .json({ success: false, error: "Cancha o turno inválidos" });
    }
    const normalizedStatus = status ?? "active";
    if (!VALID_STATUSES.includes(normalizedStatus)) {
      return res
        .status(400)
        .json({ success: false, error: "status inválido (active o paused)" });
    }
    const normalizedClientName =
      typeof clientName === "string" ? clientName.trim() : "";
    if (!normalizedClientName) {
      return res
        .status(400)
        .json({ success: false, error: "El turno fijo debe tener un cliente" });
    }

    const [courtExists, slotExists] = await Promise.all([
      Court.exists({ _id: court, companyId }),
      TimeSlot.exists({ _id: timeSlot, companyId }),
    ]);
    if (!courtExists) {
      return res.status(404).json({ success: false, error: "Cancha no encontrada" });
    }
    if (!slotExists) {
      return res.status(404).json({ success: false, error: "Turno no encontrado" });
    }

    const conflicts = await getConflicts({ companyId, weekday, court, timeSlot });
    if (conflicts.length) {
      return res.status(409).json({ success: false, error: CONFLICT_MESSAGE });
    }

    const fixedBooking = await FixedBooking.create({
      companyId,
      court,
      timeSlot,
      weekday,
      clientName: normalizedClientName,
      notes: (notes || "").trim(),
      status: normalizedStatus,
    });

    const populated = await FixedBooking.findById(fixedBooking._id)
      .populate("court", "name")
      .populate("timeSlot", "startTime endTime order label");

    return res.status(201).json({ success: true, data: populated });
  } catch (error) {
    console.error("Error en createFixedBooking:", error);
    if (error.code === 11000) {
      return res.status(409).json({ success: false, error: CONFLICT_MESSAGE });
    }
    return res.status(500).json({ success: false, error: error.message });
  }
};

// PUT /api/fixed-bookings/:id
const updateFixedBooking = async (req, res) => {
  try {
    const companyId = resolveCompanyId(req, res);
    if (!companyId) return undefined;

    const { id } = req.params;
    if (!isValidId(id)) {
      return res.status(404).json({ success: false, error: "Turno fijo no encontrado" });
    }

    const existing = await FixedBooking.findOne({ _id: id, companyId });
    if (!existing) {
      return res.status(404).json({ success: false, error: "Turno fijo no encontrado" });
    }

    const updates = {};
    const { court, timeSlot, clientName, notes, status } = req.body || {};

    if (req.body?.weekday !== undefined) {
      const weekday = validateWeekday(req.body.weekday);
      if (weekday === null) {
        return res.status(400).json({ success: false, error: "weekday inválido (0-6)" });
      }
      updates.weekday = weekday;
    }
    if (court !== undefined) {
      if (!isValidId(court) || !(await Court.exists({ _id: court, companyId }))) {
        return res.status(404).json({ success: false, error: "Cancha no encontrada" });
      }
      updates.court = court;
    }
    if (timeSlot !== undefined) {
      if (!isValidId(timeSlot) || !(await TimeSlot.exists({ _id: timeSlot, companyId }))) {
        return res.status(404).json({ success: false, error: "Turno no encontrado" });
      }
      updates.timeSlot = timeSlot;
    }
    if (clientName !== undefined) {
      const normalizedClientName =
        typeof clientName === "string" ? clientName.trim() : "";
      if (!normalizedClientName) {
        return res
          .status(400)
          .json({ success: false, error: "El turno fijo debe tener un cliente" });
      }
      updates.clientName = normalizedClientName;
    }
    if (notes !== undefined) updates.notes = (notes || "").trim();
    if (status !== undefined) {
      if (!VALID_STATUSES.includes(status)) {
        return res
          .status(400)
          .json({ success: false, error: "status inválido (active o paused)" });
      }
      updates.status = status;
    }

    const conflicts = await getConflicts({
      companyId,
      weekday: updates.weekday ?? existing.weekday,
      court: updates.court ?? existing.court,
      timeSlot: updates.timeSlot ?? existing.timeSlot,
      excludeId: existing._id,
    });
    if (conflicts.length) {
      return res.status(409).json({ success: false, error: CONFLICT_MESSAGE });
    }

    const updated = await FixedBooking.findOneAndUpdate(
      { _id: id, companyId },
      { $set: updates },
      { returnDocument: "after", runValidators: true },
    )
      .populate("court", "name")
      .populate("timeSlot", "startTime endTime order label");

    return res.status(200).json({ success: true, data: updated });
  } catch (error) {
    console.error("Error en updateFixedBooking:", error);
    if (error.code === 11000) {
      return res.status(409).json({ success: false, error: CONFLICT_MESSAGE });
    }
    return res.status(500).json({ success: false, error: error.message });
  }
};

// DELETE /api/fixed-bookings/:id
const deleteFixedBooking = async (req, res) => {
  try {
    const companyId = resolveCompanyId(req, res);
    if (!companyId) return undefined;

    const { id } = req.params;
    if (!isValidId(id)) {
      return res.status(404).json({ success: false, error: "Turno fijo no encontrado" });
    }

    const deleted = await FixedBooking.findOneAndDelete({ _id: id, companyId });
    if (!deleted) {
      return res.status(404).json({ success: false, error: "Turno fijo no encontrado" });
    }

    return res.status(204).send();
  } catch (error) {
    console.error("Error en deleteFixedBooking:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

module.exports = {
  listFixedBookingsHandler,
  createFixedBooking,
  updateFixedBooking,
  deleteFixedBooking,
};
